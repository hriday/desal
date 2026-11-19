import { describe, expect, it } from 'vitest';
import { FrameAssembler } from '../src/frames.js';
import { GAME_A as A, GAME_B as B, reading } from './fixtures.js';

describe('FrameAssembler', () => {
  it('emits the open frame when a reading with a newer tick arrives', () => {
    const fa = new FrameAssembler();
    expect(fa.add(reading(A, 1, 'TBT', 90))).toBeNull();
    expect(fa.add(reading(A, 1, 'FLOW', 5))).toBeNull();
    expect(fa.add(reading(A, 2, 'TBT', 91))).toEqual({ t: 'frame', tick: 1, plantTime: 40, readings: { TBT: 90, FLOW: 5 } });
    expect(fa.flush(A)).toEqual({ t: 'frame', tick: 2, plantTime: 80, readings: { TBT: 91 } });
  });

  it('flush emits the open frame once, and only up to the given tick', () => {
    const fa = new FrameAssembler();
    fa.add(reading(A, 3, 'TBT'));
    expect(fa.flush(A, 2)).toBeNull(); // a status for tick 2 must not flush tick 3
    expect(fa.flush(A, 3)).toEqual({ t: 'frame', tick: 3, plantTime: 120, readings: { TBT: 3 } });
    expect(fa.flush(A, 3)).toBeNull();
    expect(fa.flush(B)).toBeNull();
  });

  it('never mixes games', () => {
    const fa = new FrameAssembler();
    fa.add(reading(A, 1, 'TBT', 1));
    expect(fa.add(reading(B, 7, 'TBT', 2))).toBeNull(); // B's newer tick does not close A's frame
    fa.add(reading(B, 7, 'FLOW', 3));
    expect(fa.flush(A)?.readings).toEqual({ TBT: 1 });
    expect(fa.flush(B)).toEqual({ t: 'frame', tick: 7, plantTime: 280, readings: { TBT: 2, FLOW: 3 } });
  });

  it('drops readings for a tick that was already emitted (one frame per tick, ticks increase)', () => {
    const fa = new FrameAssembler();
    fa.add(reading(A, 5, 'TBT'));
    fa.flush(A, 5);
    expect(fa.add(reading(A, 5, 'FLOW'))).toBeNull();
    expect(fa.add(reading(A, 4, 'FLOW'))).toBeNull();
    expect(fa.openTicks(A)).toBe(0);
    expect(fa.flush(A)).toBeNull();
  });

  it('a new epoch (the game was restored from a snapshot, its tick rewound) resets the emitted mark', () => {
    const fa = new FrameAssembler();
    fa.add(reading(A, 5, 'TBT'));
    expect(fa.flush(A, 5)?.tick).toBe(5);
    // Restored at tick 3: without the epoch these readings would look late and be dropped forever.
    expect(fa.add(reading(A, 3, 'TBT', 30, 1))).toBeNull();
    expect(fa.flush(A, 3, 1)).toEqual({ t: 'frame', tick: 3, plantTime: 120, readings: { TBT: 30 } });
    // A straggler from the old epoch is dropped.
    expect(fa.add(reading(A, 6, 'TBT', 60, 0))).toBeNull();
    expect(fa.openTicks(A)).toBe(0);
  });

  it('is bounded: at most 2 open ticks per game, and drop() forgets a game', () => {
    const fa = new FrameAssembler();
    const frames = [];
    for (let tick = 0; tick < 1000; tick++) {
      for (const s of ['a', 'b', 'c']) {
        const f = fa.add(reading(A, tick, s));
        if (f) frames.push(f);
      }
      expect(fa.openTicks(A)).toBeLessThanOrEqual(2);
    }
    expect(frames).toHaveLength(999);
    expect(fa.games()).toBe(1);
    fa.drop(A);
    expect(fa.games()).toBe(0);
    expect(fa.flush(A)).toBeNull();
  });
});
