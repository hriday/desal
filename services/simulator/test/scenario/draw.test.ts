import { SHARP_KINDS } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../src/state.js';
import { drawChaosPlan, hellChance } from '../../src/scenario/draw.js';
import { shiftTargetM3 } from '../../src/scenario/library.js';

const state = createInitialState(1, 0, '00000000-0000-4000-8000-000000000000');
const seedOf = (i: number): number => (i * 2654435761) >>> 0;
const plans = (count: number, n: number, lastWasHell = false, st = state) =>
  Array.from({ length: count }, (_, i) => drawChaosPlan({ shiftNumber: n, seed: seedOf(i), lastWasHell, state: st })[0]);

describe('hellChance', () => {
  it('ramps 4% per shift from 10% and caps at 45%', () => {
    expect(hellChance(2)).toBe(0.1);
    expect(hellChance(4)).toBeCloseTo(0.18, 10);
    expect(hellChance(50)).toBe(0.45);
  });
});

describe('drawChaosPlan', () => {
  it('shift 1 is never hell and has exactly one gentle event', () => {
    for (const p of plans(500, 1)) {
      expect(p.hell).toBe(false);
      expect(p.queue).toHaveLength(1);
      expect(['pumpTrip', 'sensorFailure', 'storm']).toContain(p.queue[0]!.kind);
    }
  });

  it('hell rate at shift 6 tracks hellChance(6)', () => {
    const rate = plans(5000, 6).filter((p) => p.hell).length / 5000;
    expect(Math.abs(rate - hellChance(6))).toBeLessThan(0.03);
  });

  it('is never hell straight after a hell shift', () => {
    expect(plans(500, 50, true).some((p) => p.hell)).toBe(false);
  });

  it('normal plans hold 1-2 events with a sharp one; hell plans hold 4-6', () => {
    const all = plans(2000, 50);
    expect(all.some((p) => p.hell)).toBe(true);
    for (const p of all) {
      if (p.hell) {
        expect(p.queue.length).toBeGreaterThanOrEqual(4);
        expect(p.queue.length).toBeLessThanOrEqual(6);
      } else {
        expect(p.queue.length).toBeGreaterThanOrEqual(1);
        expect(p.queue.length).toBeLessThanOrEqual(2);
        expect(p.queue.some((e) => SHARP_KINDS.includes(e.kind))).toBe(true);
      }
      p.queue.forEach((e, i) => {
        expect(e.eventId).toBe(i + 1);
        expect(e.earliestMinute).toBe(0);
        expect(e.cascade).toBe(false);
      });
    }
  });

  it('hell plans cut the target to 85%, normal plans keep it', () => {
    for (const p of plans(500, 20)) {
      expect(p.targetM3).toBe(p.hell ? Math.round(shiftTargetM3(20) * 0.85) : shiftTargetM3(20));
      expect(p.orders.targetM3).toBe(p.targetM3);
    }
  });

  it('warns about 70% of hell shifts', () => {
    const hells = plans(6000, 50).filter((p) => p.hell);
    expect(hells.length).toBeGreaterThanOrEqual(2000);
    const rate = hells.slice(0, 2000).filter((p) => p.warned).length / 2000;
    expect(Math.abs(rate - 0.7)).toBeLessThan(0.05);
    expect(plans(500, 50).filter((p) => !p.hell).every((p) => !p.warned)).toBe(true);
  });

  it('never draws a pump trip or power dip when P-103 is under overhaul', () => {
    const p103 = state.intake.pumps['P-103'];
    const overhaul = {
      ...state,
      intake: { ...state.intake, pumps: { ...state.intake.pumps, 'P-103': { ...p103, overhaulRemainingTicks: 30 } } },
    };
    for (const n of [1, 6, 50]) {
      for (const p of plans(500, n, false, overhaul)) {
        expect(p.queue.some((e) => e.kind === 'pumpTrip' || e.kind === 'powerDip')).toBe(false);
        expect(p.queue.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('hits only a running pump', () => {
    for (const p of plans(500, 50)) {
      for (const e of p.queue) {
        if (e.kind === 'pumpTrip' || e.kind === 'powerDip') expect(['P-101', 'P-102']).toContain(e.params.pumpId);
      }
    }
  });

  it('is deterministic and returns an advanced seed', () => {
    const input = { shiftNumber: 9, seed: 1234, lastWasHell: false, state };
    const a = drawChaosPlan(input);
    expect(drawChaosPlan(input)).toEqual(a);
    expect(a[1]).not.toBe(1234);
  });
});
