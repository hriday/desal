import { randomUUID } from 'node:crypto';
import {
  PlantEventSchema,
  PlantStatusSchema,
  TelemetryReadingSchema,
  TOPICS,
  type Command,
  type CommandEnvelope,
  type ServerErrorReason,
  type ServerMsg,
} from '@desal/schema';
import { FrameAssembler } from './frames.js';
import type { GatewayTopic, SeenStatus } from './kafka.js';
import { CLOSE_TOO_LARGE, MAX_MSG_BYTES, MAX_MSGS_PER_S, parseClientMsg, RESUME_WINDOW_MS } from './protocol.js';

/** How Sessions reaches one client socket. */
export interface SocketSink {
  send(msg: ServerMsg): void;
  close(code: number, reason: string): void;
}

export interface SessionsDeps {
  /** Produce a command envelope to plant.commands. */
  send(env: CommandEnvelope): void | Promise<void>;
  latestStatus(gameId: string): SeenStatus | undefined;
  /** Wall clock, ms. */
  now?: () => number;
  /** UUID v4 source (game ids and command ids). */
  newId?: () => string;
  log?: (msg: string) => void;
}

interface Socket {
  sink: SocketSink;
  gameId: string | null;
  /** Sent newGame; the 'game' reply waits for the simulator's gameStart. */
  awaitingStart: boolean;
  /** When each message accepted in the last second arrived (oldest first; at most MAX_MSGS_PER_S). */
  recent: number[];
}

/** Commands only the gateway may issue: startGame (via newGame) and heartbeat (its own timer). */
const GATEWAY_ONLY = new Set<Command['type']>(['startGame', 'heartbeat']);

/**
 * Client sessions: which socket plays which game, client message handling and limits, and
 * routing each game's Kafka records to its sockets. No I/O of its own: commands go out through
 * deps.send and messages through each socket's sink, so it is unit-tested with fakes.
 */
export class Sessions {
  private readonly sockets = new Map<string, Socket>();
  /** gameId -> the sockets bound to it. A game is here only while at least one socket is bound. */
  private readonly games = new Map<string, Set<string>>();
  private readonly frames = new FrameAssembler();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: SessionsDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.log = deps.log ?? ((m) => console.warn(`[gateway] ${m}`));
  }

  socketCount(): number {
    return this.sockets.size;
  }

  open(socketId: string, sink: SocketSink): void {
    this.sockets.set(socketId, { sink, gameId: null, awaitingStart: false, recent: [] });
  }

  /** Unbind the socket. Its game's heartbeats stop with the last socket, so the simulator abandons it after 90 s unless someone resumes. */
  close(socketId: string): void {
    const s = this.sockets.get(socketId);
    if (!s) return;
    this.unbind(socketId, s);
    this.sockets.delete(socketId);
  }

  onClient(socketId: string, raw: string): void {
    const s = this.sockets.get(socketId);
    if (!s) return;
    if (Buffer.byteLength(raw) > MAX_MSG_BYTES) {
      s.sink.send({ t: 'error', reason: 'too large' });
      s.sink.close(CLOSE_TOO_LARGE, 'message too large');
      return;
    }
    const now = this.now();
    // Sliding window: forget arrivals a second or more old, then count what is left.
    while (s.recent.length > 0 && now - s.recent[0]! >= 1000) s.recent.shift();
    if (s.recent.length >= MAX_MSGS_PER_S) return this.error(s, 'rate limited');
    s.recent.push(now);

    const parsed = parseClientMsg(raw);
    if (!parsed.ok) return this.error(s, parsed.reason);
    const msg = parsed.msg;
    switch (msg.t) {
      case 'ping':
        s.sink.send({ t: 'pong' });
        return;
      case 'newGame': {
        if (s.gameId) return this.error(s, 'already in a game');
        const gameId = this.newId();
        this.bind(socketId, s, gameId);
        s.awaitingStart = true;
        this.dispatch(this.envelope(gameId, { type: 'startGame' }));
        return;
      }
      case 'resume': {
        if (s.gameId) {
          if (s.gameId === msg.gameId) s.sink.send({ t: 'game', gameId: msg.gameId });
          else this.error(s, 'already in a game');
          return;
        }
        const seen = this.deps.latestStatus(msg.gameId);
        if (!seen || now - seen.seenAt > RESUME_WINDOW_MS) return this.error(s, 'game ended');
        this.bind(socketId, s, msg.gameId);
        s.sink.send({ t: 'game', gameId: msg.gameId });
        return;
      }
      case 'cmd': {
        if (!s.gameId) return this.error(s, 'no game');
        if (GATEWAY_ONLY.has(msg.command.type)) return this.error(s, 'invalid message');
        this.dispatch(this.envelope(s.gameId, msg.command, msg.commandId));
        return;
      }
    }
  }

  /** One heartbeat per game with at least one bound socket (server.ts runs this every 15 s). */
  everyHeartbeat(): void {
    for (const gameId of this.games.keys()) this.dispatch(this.envelope(gameId, { type: 'heartbeat' }));
  }

  /** Route one consumed record to its game's sockets. Records for games nobody here plays are ignored. */
  onRecord(topic: GatewayTopic, gameId: string, value: unknown): void {
    if (!this.games.has(gameId)) return;
    if (topic === TOPICS.telemetry) {
      const r = TelemetryReadingSchema.safeParse(value);
      if (!r.success) return;
      const frame = this.frames.add(r.data);
      if (frame) this.broadcast(gameId, frame);
    } else if (topic === TOPICS.status) {
      const r = PlantStatusSchema.safeParse(value);
      if (!r.success) return;
      // Frame N before status N: the status closes its tick's frame.
      const frame = this.frames.flush(gameId, r.data.tick);
      if (frame) this.broadcast(gameId, frame);
      this.broadcast(gameId, { t: 'status', status: r.data });
    } else {
      const r = PlantEventSchema.safeParse(value);
      if (!r.success) return;
      const event = r.data;
      if (event.type === 'gameRejected') {
        // 'duplicate' cannot happen with a fresh random gameId; either way the socket has no game.
        this.broadcast(gameId, { t: 'error', reason: 'capacity' });
        return this.unbindGame(gameId);
      }
      if (event.type === 'gameStart') {
        for (const id of this.games.get(gameId)!) {
          const s = this.sockets.get(id)!;
          if (!s.awaitingStart) continue;
          s.awaitingStart = false;
          s.sink.send({ t: 'game', gameId });
        }
      }
      this.broadcast(gameId, { t: 'event', event });
      if (event.type === 'gameEnd') this.unbindGame(gameId);
    }
  }

  private envelope(gameId: string, command: Command, commandId?: string): CommandEnvelope {
    return {
      // R4: a client-supplied commandId is kept, so the client can match a commandRejected to its send.
      commandId: commandId ?? this.newId(),
      issuedAt: this.now(),
      gameId,
      shiftId: this.deps.latestStatus(gameId)?.status.shiftId ?? null,
      command,
    };
  }

  private dispatch(env: CommandEnvelope): void {
    void (async () => {
      try {
        await this.deps.send(env);
      } catch (e) {
        this.log(`sending ${env.command.type} for game ${env.gameId} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  private error(s: Socket, reason: ServerErrorReason): void {
    s.sink.send({ t: 'error', reason });
  }

  private broadcast(gameId: string, msg: ServerMsg): void {
    for (const id of this.games.get(gameId) ?? []) this.sockets.get(id)?.sink.send(msg);
  }

  private bind(socketId: string, s: Socket, gameId: string): void {
    s.gameId = gameId;
    let set = this.games.get(gameId);
    if (!set) this.games.set(gameId, (set = new Set()));
    set.add(socketId);
  }

  private unbind(socketId: string, s: Socket): void {
    if (!s.gameId) return;
    const set = this.games.get(s.gameId);
    set?.delete(socketId);
    if (set?.size === 0) {
      this.games.delete(s.gameId);
      this.frames.drop(s.gameId);
    }
    s.gameId = null;
    s.awaitingStart = false;
  }

  private unbindGame(gameId: string): void {
    for (const id of [...(this.games.get(gameId) ?? [])]) {
      const s = this.sockets.get(id);
      if (s) this.unbind(id, s);
    }
  }
}
