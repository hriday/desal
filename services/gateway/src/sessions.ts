import { randomUUID } from 'node:crypto';
import {
  PlantEventSchema,
  PlantStatusSchema,
  TelemetryReadingSchema,
  TOPICS,
  type Command,
  type CommandEnvelope,
  type Leaderboard,
  type PublicLeaderboard,
  type RunRank,
  type ServerErrorReason,
  type ServerMsg,
  type ShiftReport,
} from '@desal/schema';
import { TokenBucket } from './bucket.js';
import { FrameAssembler } from './frames.js';
import type { GatewayTopic, SeenStatus } from './kafka.js';
import { ClientLimits, type PerClientLimits } from './limits.js';
import { stripRunId, toPublic } from './publicBoard.js';
import {
  CLOSE_POLICY_VIOLATION,
  CLOSE_TOO_LARGE,
  MAX_MSG_BYTES,
  parseClientMsg,
  RATE_ABUSE_MS,
  RATE_BURST,
  RATE_REFILL_PER_S,
  RESUME_WAIT_MS,
  RESUME_WINDOW_MS,
  START_WAIT_MS,
} from './protocol.js';

/** How Sessions reaches one client socket. */
export interface SocketSink {
  send(msg: ServerMsg): void;
  close(code: number, reason: string): void;
}

export interface SessionsDeps {
  /** Produce a command envelope to plant.commands. */
  send(env: CommandEnvelope): void | Promise<void>;
  latestStatus(gameId: string): SeenStatus | undefined;
  /** True if a gameEnd for this game was consumed (recently). */
  gameEnded?(gameId: string): boolean;
  /** Per-client game caps (defaults: 3 live games, one newGame per 10 s). */
  limits?: Pick<PerClientLimits, 'maxGames' | 'newGameIntervalMs'>;
  /** Run fn after ms; returns a cancel function. Injected so tests control time. */
  schedule?(fn: () => void, ms: number): () => void;
  /** Wall clock, ms. */
  now?: () => number;
  /** UUID v4 source (game ids and command ids). */
  newId?: () => string;
  /** Readings in a complete telemetry frame (default TELEMETRY_SENSOR_COUNT). */
  frameReadings?: number;
  log?: (msg: string) => void;
}

interface Socket {
  sink: SocketSink;
  gameId: string | null;
  /** Sent newGame; the 'game' reply waits for the simulator's gameStart. */
  awaitingStart: boolean;
  /** Cancels the START_WAIT_MS timeout of a newGame still awaiting its gameStart. */
  cancelStartWait: (() => void) | null;
  /** Message rate limit (protocol.ts, RATE_*). */
  bucket: TokenBucket;
  /** Who this socket belongs to (an IP address, see server.ts), for the per-client limits. */
  clientId: string;
  /** A resume waiting for the game's first status (none known yet). */
  resuming: { gameId: string; cancel: () => void } | null;
  /**
   * The private runId of the game this socket saw end (from its gameEnd), kept after the unbind so
   * the run's rank can still reach the Final report. Never sent to the client.
   */
  runId: string | null;
}

/** Ranks kept for runs no socket here has ended yet (run.ranks holds every run ever; oldest go first). */
const MAX_RANKS = 10_000;

function defaultSchedule(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
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
  /** gameId -> sockets whose resume waits for that game's first status. */
  private readonly resuming = new Map<string, Set<string>>();
  /** runId -> its latest rank (from run.ranks). */
  private readonly ranks = new Map<string, RunRank>();
  /** runId -> the sockets that saw that run end and wait for its rank. */
  private readonly runs = new Map<string, Set<string>>();
  /** The latest leaderboard, already without runIds. */
  private board: PublicLeaderboard | undefined;
  private readonly frames: FrameAssembler;
  private readonly limits: ClientLimits;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: SessionsDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.log = deps.log ?? ((m) => console.warn(`[gateway] ${m}`));
    this.schedule = deps.schedule ?? defaultSchedule;
    this.limits = new ClientLimits(this.now, deps.limits);
    this.frames = new FrameAssembler(deps.frameReadings);
  }

  clientSocketCount(clientId: string): number {
    let n = 0;
    for (const s of this.sockets.values()) if (s.clientId === clientId) n++;
    return n;
  }

  socketCount(): number {
    return this.sockets.size;
  }

  /** clientId defaults to the socket itself (no per-client grouping). */
  open(socketId: string, sink: SocketSink, clientId: string = socketId): void {
    const bucket = new TokenBucket({ burst: RATE_BURST, refillPerS: RATE_REFILL_PER_S, abuseMs: RATE_ABUSE_MS }, this.now());
    this.sockets.set(socketId, { sink, gameId: null, awaitingStart: false, cancelStartWait: null, bucket, clientId, resuming: null, runId: null });
  }

  /**
   * Unbind the socket. When it was the game's last socket, one heartbeat goes out now and then
   * they stop: the simulator abandons the game 90 s from now unless a socket resumes it.
   */
  close(socketId: string): void {
    const s = this.sockets.get(socketId);
    if (!s) return;
    this.stopResuming(socketId, s);
    this.forgetRun(socketId, s);
    const gameId = s.gameId;
    this.unbind(socketId, s);
    if (gameId && !this.games.has(gameId)) this.dispatch(this.envelope(gameId, { type: 'heartbeat' }));
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
    // Over the rate: dropped without an answer (an error per message would itself be a flood).
    const take = s.bucket.take(now);
    if (take === 'abusive') return s.sink.close(CLOSE_POLICY_VIOLATION, 'rate limited');
    if (take === 'dropped') return;

    const parsed = parseClientMsg(raw);
    if (!parsed.ok) return this.error(s, parsed.reason);
    const msg = parsed.msg;
    switch (msg.t) {
      case 'ping':
        s.sink.send({ t: 'pong' });
        return;
      case 'newGame': {
        if (s.gameId || s.resuming) return this.error(s, 'already in a game');
        if (!this.limits.canStart(s.clientId, (id, at) => this.isLive(id, at))) return this.error(s, 'capacity');
        const gameId = this.newId();
        this.limits.started(s.clientId, gameId);
        this.bind(socketId, s, gameId);
        s.awaitingStart = true;
        // No gameStart in time (the simulator is down, or lost the command): free the socket.
        s.cancelStartWait = this.schedule(() => {
          s.cancelStartWait = null;
          if (!s.awaitingStart || s.gameId !== gameId) return;
          this.error(s, 'capacity');
          this.unbind(socketId, s);
        }, START_WAIT_MS);
        this.dispatch(this.envelope(gameId, { type: 'startGame', mode: msg.mode }), () => this.startFailed(gameId));
        return;
      }
      case 'resume': {
        if (s.gameId) {
          if (s.gameId === msg.gameId) s.sink.send({ t: 'game', gameId: msg.gameId });
          else this.error(s, 'already in a game');
          return;
        }
        if (s.resuming) return this.error(s, 'already in a game');
        if (this.deps.gameEnded?.(msg.gameId)) return this.error(s, 'game ended');
        const seen = this.deps.latestStatus(msg.gameId);
        if (seen) {
          if (now - seen.seenAt > RESUME_WINDOW_MS) return this.error(s, 'game ended');
          this.bind(socketId, s, msg.gameId);
          s.sink.send({ t: 'game', gameId: msg.gameId });
          return;
        }
        // No status known: right after a gateway (re)start the consumer may not have caught up
        // yet, so wait up to RESUME_WAIT_MS for one before answering 'game ended'.
        this.waitForStatus(socketId, s, msg.gameId);
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
    this.limits.prune();
  }

  /** Route one consumed record to its game's sockets. Records for games nobody here plays are ignored. */
  onRecord(topic: GatewayTopic, gameId: string, value: unknown): void {
    if (topic === TOPICS.telemetry) {
      if (!this.games.has(gameId)) return;
      const r = TelemetryReadingSchema.safeParse(value);
      if (!r.success) return;
      const frame = this.frames.add(r.data);
      if (frame) this.broadcast(gameId, frame);
    } else if (topic === TOPICS.status) {
      if (!this.games.has(gameId) && !this.resuming.has(gameId)) return;
      const r = PlantStatusSchema.safeParse(value);
      if (!r.success) return;
      this.endWait(gameId, true);
      // Frame N before status N: the status closes its tick's frame if complete (else it follows).
      const frame = this.frames.flush(gameId, r.data.tick, r.data.epoch);
      if (frame) this.broadcast(gameId, frame);
      this.broadcast(gameId, { t: 'status', status: r.data });
    } else {
      const r = PlantEventSchema.safeParse(value);
      if (!r.success) return;
      const event = r.data;
      if (event.type === 'gameEnd' || event.type === 'gameRejected') {
        this.limits.ended(gameId);
        this.endWait(gameId, false);
      }
      const noSuchGame = event.host === true && event.type === 'commandRejected' && event.reason === 'no such game';
      if (noSuchGame) this.limits.ended(gameId);
      if (!this.games.has(gameId)) return;
      if (noSuchGame) {
        // The simulator has no such game (it ended, or was lost): the player's game is over.
        this.broadcast(gameId, { t: 'error', reason: 'game ended' });
        return this.unbindGame(gameId);
      }
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
          s.cancelStartWait?.();
          s.cancelStartWait = null;
          s.sink.send({ t: 'game', gameId });
        }
      }
      // The only place events reach sockets. gameEnd and shiftEnd carry the run's private runId.
      this.broadcast(gameId, { t: 'event', event: stripRunId(event) });
      if (event.type === 'gameEnd') {
        if (event.runId) this.rememberRun(gameId, event.runId);
        this.unbindGame(gameId);
      }
    }
  }

  /** A shift report card from Flink, for its game's sockets only. */
  onReport(gameId: string, report: ShiftReport): void {
    this.broadcast(gameId, { t: 'shiftReport', report });
  }

  /** The latest leaderboard; kept without runIds for GET /api/leaderboard. */
  onBoard(board: Leaderboard): void {
    try {
      this.board = toPublic(board);
    } catch (e) {
      this.log(`leaderboard not public-safe, keeping the previous one: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  publicBoard(): PublicLeaderboard | undefined {
    return this.board;
  }

  /** A run's rank: cached, and sent to the sockets that saw the run end whenever it changes. */
  onRank(rank: RunRank): void {
    const prev = this.ranks.get(rank.runId);
    this.ranks.delete(rank.runId); // re-insert: Map order is the eviction order, latest last
    this.ranks.set(rank.runId, rank);
    if (this.ranks.size > MAX_RANKS) this.ranks.delete(this.ranks.keys().next().value!);
    if (prev && prev.allTime === rank.allTime && prev.today === rank.today) return;
    for (const id of this.runs.get(rank.runId) ?? []) this.sendRank(this.sockets.get(id), rank);
  }

  /** A run.ranks tombstone: the run has no rank any more. */
  forgetRank(runId: string): void {
    this.ranks.delete(runId);
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

  /** Is a game this client started still live? Not ended, and a status (or its start) within 90 s. */
  private isLive(gameId: string, startedAt: number): boolean {
    if (this.deps.gameEnded?.(gameId)) return false;
    const last = Math.max(this.deps.latestStatus(gameId)?.seenAt ?? 0, startedAt);
    return this.now() - last <= RESUME_WINDOW_MS;
  }

  /** Produce in the background; a failure is logged, and onError (if any) runs. */
  private dispatch(env: CommandEnvelope, onError?: () => void): void {
    void (async () => {
      try {
        await this.deps.send(env);
      } catch (e) {
        this.log(`sending ${env.command.type} for game ${env.gameId} failed: ${e instanceof Error ? e.message : String(e)}`);
        onError?.();
      }
    })();
  }

  /** The startGame never reached Kafka: free the socket. The UI treats 'capacity' as "try again". */
  private startFailed(gameId: string): void {
    this.limits.ended(gameId);
    this.broadcast(gameId, { t: 'error', reason: 'capacity' });
    this.unbindGame(gameId);
  }

  private waitForStatus(socketId: string, s: Socket, gameId: string): void {
    const cancel = this.schedule(() => {
      this.stopResuming(socketId, s);
      this.error(s, 'game ended');
    }, RESUME_WAIT_MS);
    s.resuming = { gameId, cancel };
    let set = this.resuming.get(gameId);
    if (!set) this.resuming.set(gameId, (set = new Set()));
    set.add(socketId);
  }

  /** For resumes waiting on this game: a status arrived (bind, answer 'game') or it ended ('game ended'). */
  private endWait(gameId: string, alive: boolean): void {
    for (const id of [...(this.resuming.get(gameId) ?? [])]) {
      const s = this.sockets.get(id);
      if (!s) continue;
      this.stopResuming(id, s);
      if (alive) {
        this.bind(id, s, gameId);
        s.sink.send({ t: 'game', gameId });
      } else {
        this.error(s, 'game ended');
      }
    }
  }

  private stopResuming(socketId: string, s: Socket): void {
    if (!s.resuming) return;
    s.resuming.cancel();
    const set = this.resuming.get(s.resuming.gameId);
    set?.delete(socketId);
    if (set?.size === 0) this.resuming.delete(s.resuming.gameId);
    s.resuming = null;
  }

  private error(s: Socket, reason: ServerErrorReason): void {
    s.sink.send({ t: 'error', reason });
  }

  private broadcast(gameId: string, msg: ServerMsg): void {
    for (const id of this.games.get(gameId) ?? []) this.sockets.get(id)?.sink.send(msg);
  }

  /** The game's sockets saw its run end: they get its rank now if known, and on every change. */
  private rememberRun(gameId: string, runId: string): void {
    for (const id of this.games.get(gameId) ?? []) {
      const s = this.sockets.get(id);
      if (!s) continue;
      this.forgetRun(id, s);
      s.runId = runId;
      let set = this.runs.get(runId);
      if (!set) this.runs.set(runId, (set = new Set()));
      set.add(id);
      const rank = this.ranks.get(runId);
      if (rank) this.sendRank(s, rank);
    }
  }

  private forgetRun(socketId: string, s: Socket): void {
    if (!s.runId) return;
    const set = this.runs.get(s.runId);
    set?.delete(socketId);
    if (set?.size === 0) this.runs.delete(s.runId);
    s.runId = null;
  }

  /** Only the two numbers: the runId stays in the gateway. */
  private sendRank(s: Socket | undefined, rank: RunRank): void {
    s?.sink.send({ t: 'rank', allTime: rank.allTime, today: rank.today });
  }

  private bind(socketId: string, s: Socket, gameId: string): void {
    // A new game: ranks of the run this socket saw end earlier are no longer for it.
    this.forgetRun(socketId, s);
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
    s.cancelStartWait?.();
    s.cancelStartWait = null;
  }

  private unbindGame(gameId: string): void {
    for (const id of [...(this.games.get(gameId) ?? [])]) {
      const s = this.sockets.get(id);
      if (s) this.unbind(id, s);
    }
  }
}
