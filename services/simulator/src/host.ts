import { CommandEnvelopeSchema, type PlantEvent, type PlantStatus, type TelemetryReading } from '@desal/schema';
import { z } from 'zod';
import { MAX_GAMES } from './constants.js';
import { toStatus } from './emit.js';
import { endGame } from './gameover.js';
import { nextRandom } from './rng.js';
import { createInitialState, type PlantState } from './state.js';
import { stamped, tick } from './tick.js';

const NIL_GAME_ID = '00000000-0000-0000-0000-000000000000';
const COMMAND_ID_ECHO_MAX = 64;
const DEFAULT_IDLE_MS = 90_000;
const DEFAULT_HOST_SEED = 0x5eed1234;

export interface GameTickOut {
  telemetry: TelemetryReading[];
  status: PlantStatus;
  events: PlantEvent[];
  snapshotDue: boolean;
}

export interface HostTick {
  perGame: Map<string, GameTickOut>;
  /** Games that ended this step (their final records are in perGame); already removed from the host. */
  ended: string[];
  /** Events with no plant to stamp from (rejections for unknown or unparseable games). */
  hostEvents: PlantEvent[];
}

export interface GameHostOptions {
  maxGames?: number;
  idleMs?: number;
  /** Seed of the RNG that picks each new game's plant seed. Tests use the default; the runner passes a random one. */
  seed?: number;
}

interface Entry {
  state: PlantState;
  lastSeenMs: number;
}

type HostEventBody =
  | { type: 'commandRejected'; commandId: string; reason: string }
  | { type: 'gameRejected'; reason: 'capacity' | 'duplicate' };

const uuid = z.string().uuid();

/**
 * Many plants, pure: holds one PlantState per gameId, routes command envelopes, enforces the game cap,
 * ends abandoned games and isolates a failing game from the rest. The only wall-clock input is the
 * `nowMs` passed to step() (liveness); tick() itself never sees it.
 */
export class GameHost {
  private readonly entries = new Map<string, Entry>();
  private readonly maxGames: number;
  private readonly idleMs: number;
  private rngSeed: number;

  constructor(opts: GameHostOptions = {}) {
    this.maxGames = opts.maxGames ?? MAX_GAMES;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.rngSeed = (opts.seed ?? DEFAULT_HOST_SEED) >>> 0;
  }

  games(): ReadonlyMap<string, { state: PlantState; lastSeenMs: number }> {
    return this.entries;
  }

  /** Resume games from snapshots after a restart; their liveness clock starts now. */
  restore(states: PlantState[], nowMs: number): void {
    for (const state of states) this.entries.set(state.run.gameId, { state, lastSeenMs: nowMs });
  }

  private newSeed(): number {
    const [v, next] = nextRandom(this.rngSeed);
    this.rngSeed = next;
    return Math.floor(v * 4294967296) >>> 0;
  }

  step(envelopes: unknown[], nowMs: number): HostTick {
    const hostEvents: PlantEvent[] = [];
    const pending = new Map<string, unknown[]>();
    const lead = new Map<string, PlantEvent[]>();

    // Host-level events have no plant to stamp from: seq 0, tick 0, wall-clock plantTime, no shift.
    const hostEvent = (gameId: string, e: HostEventBody): void => {
      hostEvents.push({ gameId, seq: 0, tick: 0, plantTime: nowMs, shiftId: null, ...e } as PlantEvent);
    };

    for (const raw of envelopes) {
      const parsed = CommandEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        const o = (raw ?? {}) as { commandId?: unknown; gameId?: unknown };
        const gid = uuid.safeParse(o.gameId);
        hostEvent(gid.success ? gid.data : NIL_GAME_ID, {
          type: 'commandRejected',
          commandId: (typeof o.commandId === 'string' ? o.commandId : 'unknown').slice(0, COMMAND_ID_ECHO_MAX),
          reason: `invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        });
        continue;
      }
      const { gameId, commandId, command } = parsed.data;
      const existing = this.entries.get(gameId);

      if (command.type === 'startGame') {
        if (existing) {
          existing.lastSeenMs = nowMs;
          hostEvent(gameId, { type: 'gameRejected', reason: 'duplicate' });
        } else if (this.entries.size >= this.maxGames) {
          hostEvent(gameId, { type: 'gameRejected', reason: 'capacity' });
        } else {
          const initial = createInitialState(this.newSeed(), nowMs, gameId);
          // gameStart is seq 0 of the new game, stamped from its own state.
          const start = stamped([{ type: 'gameStart', tick: 0, plantTime: nowMs, shiftId: null }], initial);
          this.entries.set(gameId, { state: start.state, lastSeenMs: nowMs });
          lead.set(gameId, start.events);
        }
        continue;
      }
      if (!existing) {
        hostEvent(gameId, {
          type: 'commandRejected',
          commandId: commandId.slice(0, COMMAND_ID_ECHO_MAX),
          reason: 'no such game',
        });
        continue;
      }
      existing.lastSeenMs = nowMs;
      if (command.type === 'heartbeat') continue;
      const list = pending.get(gameId) ?? [];
      list.push(raw);
      pending.set(gameId, list);
    }

    const perGame = new Map<string, GameTickOut>();
    const ended: string[] = [];

    for (const [gameId, entry] of [...this.entries]) {
      const first = lead.get(gameId) ?? [];
      let out: GameTickOut;
      try {
        if (nowMs - entry.lastSeenMs > this.idleMs) {
          out = this.finish(entry, 'abandoned', first);
        } else {
          const r = tick(entry.state, pending.get(gameId) ?? []);
          entry.state = r.state;
          out = { telemetry: r.telemetry, status: r.status, events: [...first, ...r.events], snapshotDue: r.snapshotDue };
        }
      } catch {
        // Failure isolation: end this game from its last good state; the others carry on.
        out = this.finish(entry, 'error', first);
      }
      perGame.set(gameId, out);
      if (entry.state.phase === 'over') {
        ended.push(gameId);
        this.entries.delete(gameId);
      }
    }
    return { perGame, ended, hostEvents };
  }

  /** End a game outside tick() (abandoned or error) through the same endGame path as quitGame. */
  private finish(entry: Entry, reason: 'abandoned' | 'error', first: PlantEvent[]): GameTickOut {
    const over = endGame(entry.state, reason);
    const out = stamped(over.events, over.state);
    entry.state = out.state;
    return { telemetry: [], status: toStatus(out.state), events: [...first, ...out.events], snapshotDue: true };
  }
}
