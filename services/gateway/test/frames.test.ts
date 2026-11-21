import { TELEMETRY_SENSOR_COUNT } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { FrameAssembler } from '../src/frames.js';
import { GAME_A as A, GAME_B as B, reading } from './fixtures.js';

describe('FrameAssembler', () => {
  it('expects a full tick of telemetry by default', () => {
    expect(TELEMETRY_SENSOR_COUNT).toBe(127);
    const fa = new FrameAssembler();
    for (let i = 0; i < TELEMETRY_SENSOR_COUNT - 1; i++) fa.add(reading(A, 1, `s${i}`));
    expect(fa.flush(A, 1)).toBeNull(); // 126 of 127: held
    expect(fa.add(reading(A, 1, 'last'))?.tick).toBe(1); // the status came first: complete now, so out it goes
  });

  it('flushes on a status only when the frame is complete', () => {
    const fa = new FrameAssembler(2);
    expect(fa.add(reading(A, 1, 'TBT', 90))).toBeNull();
    expect(fa.add(reading(A, 1, 'FLOW', 5))).toBeNull(); // complete, but frame N waits for status N
    expect(fa.flush(A, 1)).toEqual({ t: 'frame', tick: 1, plantTime: 40, readings: { TBT: 90, FLOW: 5 } });
    expect(fa.flush(A, 1)).toBeNull();
  });

  it('status and telemetry interleaved across partitions: an incomplete frame is held until it completes', () => {
    const fa = new FrameAssembler(3);
    fa.add(reading(A, 4, 'a'));
    // status 4 overtook the rest of tick 4's readings (another topic-partition)
    expect(fa.flush(A, 4)).toBeNull();
    expect(fa.add(reading(A, 4, 'b'))).toBeNull();
    expect(fa.add(reading(A, 4, 'c'))).toEqual({ t: 'frame', tick: 4, plantTime: 160, readings: { a: 4, b: 4, c: 4 } });
    // ... or until the next tick's readings arrive, whichever is first
    fa.add(reading(A, 5, 'a'));
    expect(fa.flush(A, 5)).toBeNull();
    expect(fa.add(reading(A, 6, 'a'))).toEqual({ t: 'frame', tick: 5, plantTime: 200, readings: { a: 5 } });
    // a status for a later tick releases an older incomplete frame too
    expect(fa.flush(A, 7)).toEqual({ t: 'frame', tick: 6, plantTime: 240, readings: { a: 6 } });
  });

  it('a newer tick closes the open frame, complete or not', () => {
    const fa = new FrameAssembler(2);
    fa.add(reading(A, 1, 'TBT', 90));
    expect(fa.add(reading(A, 2, 'TBT', 91))).toEqual({ t: 'frame', tick: 1, plantTime: 40, readings: { TBT: 90 } });
  });

  it('a status for an earlier tick never flushes a newer frame', () => {
    const fa = new FrameAssembler(1);
    fa.add(reading(A, 3, 'TBT'));
    expect(fa.flush(A, 2)).toBeNull();
    expect(fa.flush(A, 3)).toEqual({ t: 'frame', tick: 3, plantTime: 120, readings: { TBT: 3 } });
    expect(fa.flush(B)).toBeNull();
  });

  it('never mixes games', () => {
    const fa = new FrameAssembler(2);
    fa.add(reading(A, 1, 'TBT', 1));
    expect(fa.add(reading(B, 7, 'TBT', 2))).toBeNull(); // B's newer tick does not close A's frame
    fa.add(reading(B, 7, 'FLOW', 3));
    expect(fa.flush(B, 7)).toEqual({ t: 'frame', tick: 7, plantTime: 280, readings: { TBT: 2, FLOW: 3 } });
    expect(fa.flush(A, 1)).toBeNull(); // A's is incomplete
  });

  it('drops readings for a tick that was already emitted (one frame per tick, ticks increase)', () => {
    const fa = new FrameAssembler(1);
    fa.add(reading(A, 5, 'TBT'));
    fa.flush(A, 5);
    expect(fa.add(reading(A, 5, 'FLOW'))).toBeNull();
    expect(fa.add(reading(A, 4, 'FLOW'))).toBeNull();
    expect(fa.openTicks(A)).toBe(0);
    expect(fa.flush(A)).toBeNull();
  });

  it('a late reading for an emitted partial frame is dropped, not re-emitted', () => {
    const fa = new FrameAssembler(2);
    fa.add(reading(A, 5, 'a'));
    expect(fa.add(reading(A, 6, 'a'))?.tick).toBe(5);
    expect(fa.add(reading(A, 5, 'b'))).toBeNull();
    expect(fa.openTicks(A)).toBe(1); // only tick 6
  });

  it('a new epoch (the game was restored from a snapshot, its tick rewound) resets the emitted mark', () => {
    const fa = new FrameAssembler(1);
    fa.add(reading(A, 5, 'TBT'));
    expect(fa.flush(A, 5)?.tick).toBe(5);
    // Restored at tick 3: without the epoch these readings would look late and be dropped forever.
    expect(fa.add(reading(A, 3, 'TBT', 30, 1))).toBeNull();
    expect(fa.flush(A, 3, 1)).toEqual({ t: 'frame', tick: 3, plantTime: 120, readings: { TBT: 30 } });
    // A straggler from the old epoch is dropped.
    expect(fa.add(reading(A, 6, 'TBT', 60, 0))).toBeNull();
    expect(fa.openTicks(A)).toBe(0);
  });

  it('is bounded: at most 1 open tick per game, and drop() forgets a game', () => {
    const fa = new FrameAssembler(3);
    const frames = [];
    for (let tick = 0; tick < 1000; tick++) {
      for (const s of ['a', 'b', 'c']) {
        const f = fa.add(reading(A, tick, s));
        if (f) frames.push(f);
      }
      expect(fa.openTicks(A)).toBeLessThanOrEqual(1);
    }
    expect(frames).toHaveLength(999);
    expect(fa.games()).toBe(1);
    fa.drop(A);
    expect(fa.games()).toBe(0);
    expect(fa.flush(A)).toBeNull();
  });
});
