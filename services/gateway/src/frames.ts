import { TELEMETRY_SENSOR_COUNT, type TelemetryReading } from '@desal/schema';

/** One tick of one game's telemetry, as sent to clients (ServerMsg 'frame'). */
export interface Frame {
  t: 'frame';
  tick: number;
  plantTime: number;
  readings: Record<string, number>;
}

interface OpenFrame {
  frame: Frame;
  count: number;
  /** A status for this tick (or a later one) arrived while the frame was incomplete. */
  statusSeen: boolean;
}

interface GameFrames {
  /** The game's epoch (restores so far); a newer one starts the game's frames afresh. */
  epoch: number;
  /** The tick being collected, if any. */
  open: OpenFrame | null;
  /** Newest tick already emitted; readings for it or older ticks are late and dropped. */
  emitted: number;
}

/**
 * Turns the simulator's one-record-per-sensor telemetry into one frame per (game, tick).
 *
 * One game's readings share a key (gameId), so they sit on one partition and arrive in tick order;
 * a reading with a newer tick therefore closes the open tick, complete or not. A status for the
 * tick (plant.status is another topic-partition, so it can overtake the readings) closes it only
 * if it is complete, i.e. has `expected` readings; otherwise the frame is held and goes out as soon
 * as it completes, or when the next tick's readings arrive, whichever is first. So a client gets
 * frame N before status N whenever frame N's readings have all arrived first.
 *
 * Per game at most one tick is open, and clients get at most one frame per tick, in increasing
 * tick order within an epoch. A restore from a snapshot rewinds a game's tick and raises its epoch:
 * readings from a newer epoch reset the game's emitted mark (otherwise they would all look late),
 * and older-epoch ones are dropped.
 */
export class FrameAssembler {
  private readonly byGame = new Map<string, GameFrames>();

  /** `expected`: readings in a complete frame (the simulator's sensor count). */
  constructor(private readonly expected: number = TELEMETRY_SENSOR_COUNT) {}

  add(r: TelemetryReading): Frame | null {
    const g = this.at(r.gameId, r.epoch);
    if (!g) return null;
    if (r.tick <= g.emitted) return null;
    if (g.open && r.tick < g.open.frame.tick) return null;
    if (g.open && r.tick === g.open.frame.tick) {
      const o = g.open;
      if (!(r.sensorId in o.frame.readings)) o.count++;
      o.frame.readings[r.sensorId] = r.value;
      return o.statusSeen && o.count >= this.expected ? this.close(g) : null;
    }
    const done = g.open ? this.close(g) : null;
    g.open = { frame: { t: 'frame', tick: r.tick, plantTime: r.plantTime, readings: { [r.sensorId]: r.value } }, count: 1, statusSeen: false };
    return done;
  }

  /**
   * A status for `upToTick` (of `epoch`) arrived: emit the open frame if it is complete, or if it is
   * for an earlier tick (its tick is over). Otherwise hold it until it completes.
   */
  flush(gameId: string, upToTick = Infinity, epoch?: number): Frame | null {
    const g = epoch === undefined ? this.byGame.get(gameId) : this.at(gameId, epoch);
    const o = g?.open;
    if (!g || !o || o.frame.tick > upToTick) return null;
    if (o.count >= this.expected || o.frame.tick < upToTick) return this.close(g);
    o.statusSeen = true;
    return null;
  }

  /** Forget a game (it ended, or nobody is watching it). */
  drop(gameId: string): void {
    this.byGame.delete(gameId);
  }

  openTicks(gameId: string): number {
    return this.byGame.get(gameId)?.open ? 1 : 0;
  }

  games(): number {
    return this.byGame.size;
  }

  /** The game's frames for `epoch`: created or reset when it is newer, null when it is older (stale). */
  private at(gameId: string, epoch: number): GameFrames | null {
    const g = this.byGame.get(gameId);
    if (g && epoch < g.epoch) return null;
    if (g && epoch === g.epoch) return g;
    const fresh: GameFrames = { epoch, open: null, emitted: -Infinity };
    this.byGame.set(gameId, fresh);
    return fresh;
  }

  private close(g: GameFrames): Frame {
    const f = g.open!.frame;
    g.open = null;
    g.emitted = f.tick;
    return f;
  }
}
