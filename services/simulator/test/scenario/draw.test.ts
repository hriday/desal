import { createHash } from 'node:crypto';
import { DISASTER_KINDS, SHARP_KINDS } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { createInitialState, type PlantState } from '../../src/state.js';
import { DISASTER_MINUTE } from '../../src/scenario/difficulty.js';
import { drawDisaster } from '../../src/scenario/disaster/draw.js';
import { drawChaosPlan, hellChance } from '../../src/scenario/draw.js';
import { shiftTargetM3 } from '../../src/scenario/library.js';

const state = createInitialState(1, 0, '00000000-0000-4000-8000-000000000000');
const seedOf = (i: number): number => (i * 2654435761) >>> 0;
const plans = (count: number, n: number, lastWasHell = false, st = state, mode: 'normal' | 'hard' = 'normal') =>
  Array.from({ length: count }, (_, i) => drawChaosPlan({ shiftNumber: n, seed: seedOf(i), lastWasHell, state: st, mode })[0]);
const SHIFT_ONE = ['pumpTrip', 'sensorFailure', 'storm'];
const withP103Overhaul = (st: PlantState): PlantState => ({
  ...st,
  intake: { ...st.intake, pumps: { ...st.intake.pumps, 'P-103': { ...st.intake.pumps['P-103'], overhaulRemainingTicks: 30 } } },
});

describe('hellChance', () => {
  it('ramps 4% per shift from 10% and caps at 45%', () => {
    expect(hellChance(2)).toBe(0.1);
    expect(hellChance(4)).toBeCloseTo(0.18, 10);
    expect(hellChance(50)).toBe(0.45);
  });
});

describe('drawChaosPlan', () => {
  it('Normal shift 1 is never hell and has two distinct gentle events, 90 minutes apart', () => {
    for (const st of [state, withP103Overhaul(state)]) {
      for (const p of plans(500, 1, false, st)) {
        expect(p.hell).toBe(false);
        expect(p.queue).toHaveLength(2);
        const [a, b] = p.queue;
        expect(SHIFT_ONE).toContain(a!.kind);
        expect(SHIFT_ONE).toContain(b!.kind);
        expect(a!.kind).not.toBe(b!.kind);
        expect(a!.earliestMinute).toBe(0);
        expect(b!.earliestMinute).toBe(90);
        expect(p.queue.every((e) => !e.disaster && !e.cascade)).toBe(true);
        expect(p.queue.map((e) => e.eventId)).toEqual([1, 2]);
      }
    }
  });

  // Rule R2: Normal shifts 2+ are byte-identical to the draw before Hard mode and the two-event
  // shift 1 (pinned from the pre-change drawChaosPlan for seeds 1-50, whole output and next seed).
  // Re-pinned for the 24-stage plant (Plan 7 Task 1): against the 20-stage draw, the only
  // differences (262 over these cases) are tubeLeak params.stage values; nothing else moved.
  it('Normal shifts 2+ match the pre-change draw exactly', () => {
    const PINNED: Record<string, string> = {
      'nominal/2/false': '6bffb6561ba941fc',
      'nominal/2/true': '1057277cdb5f72f3',
      'nominal/3/false': 'c6964393008a236f',
      'nominal/3/true': 'e971adc1142a355c',
      'nominal/6/false': 'f0ab2078592ce49d',
      'nominal/6/true': '295a7978090a8705',
      'nominal/20/false': 'b417e033f9e46770',
      'nominal/20/true': '39fe3136b3426cfc',
      'nominal/50/false': '802b55c396dc11a0',
      'nominal/50/true': 'bdcc0738bf536afb',
      'overhaul/2/false': '245b0f40ec8246c6',
      'overhaul/2/true': 'b5cd0ff4e2c812de',
      'overhaul/3/false': 'a9af2bd94ccf1fe5',
      'overhaul/3/true': '410a2ffd613ebd3c',
      'overhaul/6/false': '509ab91cb349eaec',
      'overhaul/6/true': '4f01a07d5a5df830',
      'overhaul/20/false': 'd166c67da9cabbbe',
      'overhaul/20/true': 'a3be75110c77dce7',
      'overhaul/50/false': '76379f9df17ff1c6',
      'overhaul/50/true': 'e307526ccf2d7003',
    };
    const states = { nominal: state, overhaul: withP103Overhaul(state) };
    for (const [name, st] of Object.entries(states)) {
      for (const n of [2, 3, 6, 20, 50]) {
        for (const lastWasHell of [false, true]) {
          const all = Array.from({ length: 50 }, (_, i) =>
            drawChaosPlan({ shiftNumber: n, seed: i + 1, lastWasHell, state: st, mode: 'normal' }),
          );
          const digest = createHash('sha256').update(JSON.stringify(all)).digest('hex').slice(0, 16);
          expect(digest, `${name}/${n}/${lastWasHell}`).toBe(PINNED[`${name}/${n}/${lastWasHell}`]);
        }
      }
    }
  });

  it('Hard: every shift is hell, shift 1 and back to back, with hell event counts and target', () => {
    for (const n of [1, 2, 7]) {
      for (const lastWasHell of [false, true]) {
        for (const p of plans(300, n, lastWasHell, state, 'hard')) {
          expect(p.hell).toBe(true);
          expect(p.queue.length).toBeGreaterThanOrEqual(4);
          expect(p.queue.length).toBeLessThanOrEqual(6);
          expect(p.targetM3).toBe(Math.round(shiftTargetM3(n) * 0.85));
          // The controller-fault gate stays.
          if (n < 5) expect(p.queue.some((e) => e.kind === 'controllerFault')).toBe(false);
        }
      }
    }
  });

  it('Hard shift 1 draws from the full sharp pool, not the gentle one, and warns about 70%', () => {
    const all = plans(2000, 1, false, state, 'hard');
    const kinds = new Set(all.flatMap((p) => p.queue.map((e) => e.kind)));
    expect([...kinds].some((k) => SHARP_KINDS.includes(k) && !SHIFT_ONE.includes(k))).toBe(true);
    const rate = all.filter((p) => p.warned).length / all.length;
    expect(Math.abs(rate - 0.7)).toBeLessThan(0.05);
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

describe('drawDisaster', () => {
  const at = (seed: number, mode: 'normal' | 'hard', lastHadDisaster = false): PlantState => {
    const s = createInitialState(seed, 0, '00000000-0000-4000-8000-000000000000', mode);
    return { ...s, chaos: { ...s.chaos, lastHadDisaster } };
  };
  const seeds = Array.from({ length: 500 }, (_, i) => i + 1);

  it('never strikes on Hard shift 1 or Normal shift 2', () => {
    for (const seed of seeds) {
      expect(drawDisaster(at(seed, 'hard'), 1)).toBeNull();
      expect(drawDisaster(at(seed, 'normal'), 2)).toBeNull();
    }
  });

  it('never strikes two shifts running', () => {
    for (const seed of seeds) {
      expect(drawDisaster(at(seed, 'hard', true), 2)).toBeNull();
      expect(drawDisaster(at(seed, 'normal', true), 9)).toBeNull();
    }
  });

  it('strikes Hard shift 2 at about 40%, Normal shift 3+ at about 8%', () => {
    const rate = (mode: 'normal' | 'hard', n: number) => seeds.filter((seed) => drawDisaster(at(seed, mode), n) !== null).length / seeds.length;
    expect(seeds.some((seed) => drawDisaster(at(seed, 'hard'), 2) !== null)).toBe(true);
    for (const n of [2, 3, 8]) {
      const r = rate('hard', n);
      expect(r, `hard shift ${n}`).toBeGreaterThanOrEqual(0.35);
      expect(r, `hard shift ${n}`).toBeLessThanOrEqual(0.45);
    }
    for (const n of [3, 4, 12]) {
      const r = rate('normal', n);
      expect(r, `normal shift ${n}`).toBeGreaterThanOrEqual(0.05);
      expect(r, `normal shift ${n}`).toBeLessThanOrEqual(0.11);
    }
  });

  it('queues a disaster kind mid-shift, flagged, with all three kinds drawn', () => {
    const drawn = seeds.map((seed) => drawDisaster(at(seed, 'hard'), 4)).filter((e) => e !== null);
    for (const e of drawn) {
      expect(DISASTER_KINDS).toContain(e.kind);
      expect(e.disaster).toBe(true);
      expect(e.cascade).toBe(false);
      expect(e.earliestMinute).toBeGreaterThanOrEqual(DISASTER_MINUTE[0]);
      expect(e.earliestMinute).toBeLessThanOrEqual(DISASTER_MINUTE[1]);
      if (e.kind === 'fuelContamination') expect(e.params.fuel).toBe('gas');
    }
    expect(new Set(drawn.map((e) => e.kind)).size).toBe(3);
  });

  it('leaves out kinds that are not viable', () => {
    const empty = (s: PlantState): PlantState => ({ ...s, fuel: { ...s.fuel, backup: { ...s.fuel.backup, tonnes: 0 } } });
    const ruined = (s: PlantState): PlantState => ({
      ...s,
      intake: {
        ...s.intake,
        pumps: Object.fromEntries(Object.entries(s.intake.pumps).map(([id, p]) => [id, { ...p, wear: 1 }])) as PlantState['intake']['pumps'],
      },
    });
    const kinds = seeds.map((seed) => drawDisaster(ruined(empty(at(seed, 'hard'))), 4)?.kind).filter((k) => k !== undefined);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((k) => k === 'earthquake')).toBe(true);
  });

  it('is pure: it does not consume the game seed', () => {
    const s = at(42, 'hard');
    const before = JSON.stringify(s);
    expect(drawDisaster(s, 3)).toEqual(drawDisaster(s, 3));
    expect(s.seed).toBe(42);
    expect(JSON.stringify(s)).toBe(before);
  });
});
