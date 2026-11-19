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
const DEFAULT_IDLE_HANDOVER_MS = 10 * 60_000;
const DEFAULT_IDLE_RUNNING_MS = 30 * 60_000;
const DEFAULT_HOST_SEED = 0x5eed1234;

export interface GameTickOut {
  telemetry: TelemetryReading[];
  /** Null only when the plant state was too broken to render a status (error/abandoned fallback). */
  status: PlantStatus | null;
  events: PlantEvent[];
  snapshotDue: boolean;
}

export interface HostTick {
  perGame: Map<string, GameTickOut>;
  /** Games that ended this step (their final records are in perGame); already removed from the host. */
  ended: string[];
  /** Events with no plant to stamp from (rejections for unknown or unparseable games). */
  hostEvents: PlantEvent[];
  /** Why games ended with reason 'error' (for the runner to log). */
  errors: { gameId: string; message: string }[];
}

export interface GameHostOptions {
  maxGames?: number;
  /** No command at all (heartbeats included) for this long: the client is gone, the game is abandoned. */
  idleMs?: number;
  /**
   * No player action (any command but a heartbeat) for this long while in handover or paused: the
   * game is abandoned. Heartbeats only prove a tab is open; a forgotten tab must not hold a slot.
   */
  idleHandoverMs?: number;
  /** The same, while a shift runs (the plant needs no input to keep going, so this is longer). */
  idleRunningMs?: number;
  /** Seed of the RNG that picks each new game's plant seed. Tests use the default; the runner passes a random one. */
  seed?: number;
}

interface Entry {
  state: PlantState;
  /** Last command of any kind (liveness). */
  lastSeenMs: number;
  /** Last command other than a heartbeat (the player is still playing). */
  lastPlayerActionMs: number;
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
  private readonly idleHandoverMs: number;
  private readonly idleRunningMs: number;
  private rngSeed: number;

  constructor(opts: GameHostOptions = {}) {
    this.maxGames = opts.maxGames ?? MAX_GAMES;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.idleHandoverMs = opts.idleHandoverMs ?? DEFAULT_IDLE_HANDOVER_MS;
    this.idleRunningMs = opts.idleRunningMs ?? DEFAULT_IDLE_RUNNING_MS;
    this.rngSeed = (opts.seed ?? DEFAULT_HOST_SEED) >>> 0;
  }

  games(): ReadonlyMap<string, { state: PlantState; lastSeenMs: number; lastPlayerActionMs: number }> {
    return this.entries;
  }

  /** Resume games from snapshots after a restart; their liveness and player-action clocks start now. */
  restore(states: PlantState[], nowMs: number): void {
    for (const state of states) this.entries.set(state.run.gameId, { state, lastSeenMs: nowMs, lastPlayerActionMs: nowMs });
  }

  /** Has the game gone too long without a command, or without a player action for its phase? */
  private idle(entry: Entry, nowMs: number): boolean {
    if (nowMs - entry.lastSeenMs > this.idleMs) return true;
    const limit = entry.state.phase === 'running' ? this.idleRunningMs : this.idleHandoverMs;
    return nowMs - entry.lastPlayerActionMs > limit;
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
          this.entries.set(gameId, { state: start.state, lastSeenMs: nowMs, lastPlayerActionMs: nowMs });
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
      existing.lastPlayerActionMs = nowMs;
      const list = pending.get(gameId) ?? [];
      list.push(raw);
      pending.set(gameId, list);
    }

    const perGame = new Map<string, GameTickOut>();
    const ended: string[] = [];
    const errors: { gameId: string; message: string }[] = [];

    for (const [gameId, entry] of [...this.entries]) {
      const first = lead.get(gameId) ?? [];
      let out: GameTickOut;
      try {
        if (this.idle(entry, nowMs)) {
          out = this.finish(entry, 'abandoned', first);
        } else {
          const r = tick(entry.state, pending.get(gameId) ?? []);
          entry.state = r.state;
          // A game created this step is saved at once: until its first shift runs, no periodic
          // snapshot would come, and a crash would lose it.
          const created = lead.has(gameId);
          out = { telemetry: r.telemetry, status: r.status, events: [...first, ...r.events], snapshotDue: created || r.snapshotDue };
        }
      } catch (e) {
        // Failure isolation: end this game from its last good state; the others carry on.
        errors.push({ gameId, message: e instanceof Error ? e.message : String(e) });
        out = this.finish(entry, 'error', first);
      }
      perGame.set(gameId, out);
      if (entry.state.phase === 'over') {
        ended.push(gameId);
        this.entries.delete(gameId);
      }
    }
    return { perGame, ended, hostEvents, errors };
  }

  /**
   * End a game outside tick() (abandoned or error) through the same endGame path as quitGame. This
   * runs on a state that may be the very thing that broke, so it must never throw: the status is
   * best-effort (null if it cannot be rendered), and if even the gameEnd cannot be built the game
   * is dropped with its lead events only. snapshotDue is false: the runner tombstones ended games.
   */
  private finish(entry: Entry, reason: 'abandoned' | 'error', first: PlantEvent[]): GameTickOut {
    const events = [...first];
    let status: PlantStatus | null = null;
    try {
      const over = endGame(entry.state, reason);
      const out = stamped(over.events, over.state);
      entry.state = out.state;
      events.push(...out.events);
      status = toStatus(out.state);
    } catch {
      // Mark over so the host still drops the game even if nothing could be rendered.
      entry.state = { ...entry.state, phase: 'over' };
    }
    return { telemetry: [], status, events, snapshotDue: false };
  }
}
