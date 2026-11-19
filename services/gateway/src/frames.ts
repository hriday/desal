import type { TelemetryReading } from '@desal/schema';

/** One tick of one game's telemetry, as sent to clients (ServerMsg 'frame'). */
export interface Frame {
  t: 'frame';
  tick: number;
  plantTime: number;
  readings: Record<string, number>;
}

interface GameFrames {
  /** The tick being collected, if any. */
  open: Frame | null;
  /** Newest tick already emitted; readings for it or older ticks are late and dropped. */
  emitted: number;
}

/**
 * Turns the simulator's one-record-per-sensor telemetry into one frame per (game, tick).
 *
 * One game's readings share a key (gameId), so they sit on one partition and arrive in tick order;
 * a reading with a newer tick therefore means the open tick is complete. A status for the tick
 * also closes it (flush), so a client gets frame N before status N whenever frame N's readings
 * have arrived. Per game at most one tick is open (well within the 2-tick bound), and clients get
 * at most one frame per tick, in increasing tick order.
 */
export class FrameAssembler {
  private readonly byGame = new Map<string, GameFrames>();

  add(r: TelemetryReading): Frame | null {
    let g = this.byGame.get(r.gameId);
    if (!g) {
      g = { open: null, emitted: -Infinity };
      this.byGame.set(r.gameId, g);
    }
    if (r.tick <= g.emitted) return null;
    if (g.open && r.tick < g.open.tick) return null;
    if (g.open && r.tick === g.open.tick) {
      g.open.readings[r.sensorId] = r.value;
      return null;
    }
    const done = g.open ? this.close(g) : null;
    g.open = { t: 'frame', tick: r.tick, plantTime: r.plantTime, readings: { [r.sensorId]: r.value } };
    return done;
  }

  /** Emit the game's open frame if its tick is <= upToTick (a status for that tick arrived). */
  flush(gameId: string, upToTick = Infinity): Frame | null {
    const g = this.byGame.get(gameId);
    if (!g?.open || g.open.tick > upToTick) return null;
    return this.close(g);
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

  private close(g: GameFrames): Frame {
    const f = g.open!;
    g.open = null;
    g.emitted = f.tick;
    return f;
  }
}
