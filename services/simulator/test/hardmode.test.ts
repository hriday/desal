import { DISASTER_KINDS, type ScenarioKind } from '@desal/schema';
import { SHIFT_TICKS, TICK_PLANT_S } from '../src/constants.js';
import { DISASTER_MINUTE } from '../src/scenario/difficulty.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { drawEvent } from '../src/scenario/library.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { median, playFrom, engagedRun, type RunResult } from './bot.js';
import { GAME_ID } from './envelope.js';

// Spec §4.8 and §4.9.1: the balance of Hard mode and the disasters, on 20 fixed seeds.
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const DISASTER_AT_MINUTE = 60;

/** Ended, or missed a shift's target, by the end of shift 3. */
const brokeBy3 = (r: RunResult): boolean =>
  (r.reason !== null && r.shifts <= 3) || r.shiftEnds.slice(0, 3).some((e) => e.productM3 < e.targetM3);

/** Put a `kind` disaster at the head of shift 2's pending plan, due at minute 60. */
function forceIntoShift2(kind: ScenarioKind) {
  return (s: PlantState): PlantState => {
    const plan = s.chaos.pending;
    if (s.run.shiftNumber !== 1 || !plan || plan.queue.some((e) => e.kind === kind)) return s;
    const [e] = drawEvent(kind, DISASTER_AT_MINUTE, s.seed, 2, undefined, s.fuel.active);
    const others = plan.queue.filter((q) => !q.disaster).map((q, i) => ({ ...q, eventId: i + 2 }));
    const disaster = { eventId: 1, kind, params: e.params, earliestMinute: DISASTER_AT_MINUTE, cascade: false, disaster: true };
    return { ...s, chaos: { ...s.chaos, pending: { ...plan, queue: [disaster, ...others] } } };
  };
}

/** Play shift 1 and a shift 2 with `kind` forced into it. */
const forced = (seed: number, kind: ScenarioKind, passive: boolean): RunResult =>
  playFrom(createInitialState(seed, 0, GAME_ID), 2, { passive }, forceIntoShift2(kind));

const fired = (r: RunResult, kind: ScenarioKind): boolean =>
  r.shiftEnds[1]?.events.some((e) => e.kind === kind) ?? r.state.chaos.active?.fired.some((e) => e.kind === kind) ?? false;

describe('passive play (startShift in Auto, nothing else)', () => {
  let hard: RunResult[] = [];
  let normal: RunResult[] = [];
  beforeAll(() => {
    hard = SEEDS.map((seed) => engagedRun(seed, 3, { mode: 'hard', passive: true }));
    normal = SEEDS.map((seed) => engagedRun(seed, 1, { mode: 'normal', passive: true }));
  }, 120_000);

  it('Hard: at least 14 of 20 runs end or miss a target by the end of shift 3', () => {
    const broke = hard.filter(brokeBy3).length;
    console.log(`passive Hard broken by shift 3: ${broke}/20`);
    expect(broke).toBe(20); // Plan 7 baseline: 20/20 (test/plan7balance.test.ts)
  });

  // Ruling R5: an ignored shift-1 pump trip should cost a little water, so the bar is 95 % of the
  // target with the run still alive (a pump trip left alone lands 1-2 % short).
  it('Normal: all 20 runs survive shift 1 with at least 95% of its target', () => {
    for (const [i, r] of normal.entries()) {
      expect(r.reason, `seed ${SEEDS[i]}`).toBeNull();
      expect(r.shiftEnds[0]!.productM3, `seed ${SEEDS[i]}`).toBeGreaterThanOrEqual(0.95 * r.shiftEnds[0]!.targetM3);
    }
  });

  // Ruling R6. Passive play leaves events uncleared (so the 180-minute override spaces them); the
  // engaged bot clears them, which leaves only the gap rule.
  it('Normal: the two shift-1 events fire at least 90 plant minutes apart, passive or engaged', () => {
    let pairs = 0;
    const engaged = SEEDS.map((seed) => engagedRun(seed, 1, { mode: 'normal' }));
    for (const [i, r] of [...normal, ...engaged].entries()) {
      const fired = r.shiftEnds[0]!.events;
      if (fired.length < 2) continue;
      pairs++;
      expect(fired[1]!.atMinute - fired[0]!.atMinute, `run ${i}`).toBeGreaterThanOrEqual(90);
    }
    expect(pairs).toBeGreaterThan(0);
  });
});

describe('engaged play on Hard', () => {
  it('lasts a median of at least 3 shifts', () => {
    const lengths = SEEDS.map((seed) => engagedRun(seed, 10, { mode: 'hard' }).shifts);
    console.log(`engaged Hard runs (shift reached): ${[...lengths].sort((a, b) => a - b).join(',')}, median ${median(lengths)}`);
    expect(median(lengths)).toBeGreaterThanOrEqual(3);
    // Plan 7 guard: the 24-stage plant keeps the baseline median of 6 within one shift.
    expect(median(lengths)).toBeGreaterThanOrEqual(5);
    expect(median(lengths)).toBeLessThanOrEqual(7);
  }, 120_000);
});

describe('each disaster forced into shift 2', () => {
  for (const kind of ['fuelContamination', 'earthquake', 'tsunami'] as const) {
    it(`${kind}: the engaged bot ends the shift with the run alive`, () => {
      for (const seed of SEEDS) {
        const r = forced(seed, kind, false);
        expect(fired(r, kind), `seed ${seed} fired`).toBe(true);
        expect(r.reason, `seed ${seed}`).toBeNull();
        expect(r.shiftEnds, `seed ${seed}`).toHaveLength(2);
      }
    }, 60_000);
  }

  it('fuelContamination drawn for the other fuel: it still hits the fuel active at fire time and the bot survives', () => {
    const stale = (s: PlantState): PlantState => {
      const next = forceIntoShift2('fuelContamination')(s);
      const plan = next.chaos.pending;
      if (!plan) return next;
      const other = s.fuel.active === 'gas' ? 'backup' : 'gas';
      const queue = plan.queue.map((q) => (q.kind === 'fuelContamination' ? { ...q, params: { fuel: other } } : q));
      return { ...next, chaos: { ...next.chaos, pending: { ...plan, queue } } };
    };
    for (const seed of SEEDS) {
      const r = playFrom(createInitialState(seed, 0, GAME_ID), 2, {}, stale);
      expect(fired(r, 'fuelContamination'), `seed ${seed} fired`).toBe(true);
      expect(r.reason, `seed ${seed}`).toBeNull();
      expect(r.shiftEnds, `seed ${seed}`).toHaveLength(2);
    }
  }, 60_000);

  it('fuelContamination ignored: the run ends with the burner failed', () => {
    for (const seed of SEEDS) {
      const r = forced(seed, 'fuelContamination', true);
      expect(r.reason, `seed ${seed}`).toBe('burnerFailed');
    }
  }, 60_000);

  it('tsunami ignored: a pump running through the surge takes 0.6 wear or more', () => {
    for (const seed of SEEDS) {
      let atStart: Record<string, number> = {};
      const r = playFrom(createInitialState(seed, 0, GAME_ID), 2, { passive: true }, (s) => {
        const next = forceIntoShift2('tsunami')(s);
        if (s.run.shiftNumber === 1) atStart = Object.fromEntries(Object.entries(s.intake.pumps).map(([id, p]) => [id, p.wear]));
        return next;
      });
      expect(fired(r, 'tsunami'), `seed ${seed} fired`).toBe(true);
      const rise = Math.max(...Object.entries(r.state.intake.pumps).map(([id, p]) => p.wear - atStart[id]!));
      expect(rise, `seed ${seed}`).toBeGreaterThanOrEqual(0.6);
    }
  }, 60_000);
});

// Plan 7 Review Focus 2: a failed or stuck makeup loop (the stage-24 pool) is a loop fault like any other.
describe('makeup loop faults forced into shift 2', () => {
  /** Put `kind` with exactly `params` at the head of shift 2's plan (due at minute 60), replacing any of that kind. */
  const forceExact =
    (kind: ScenarioKind, params: Record<string, string>) =>
    (s: PlantState): PlantState => {
      const plan = s.chaos.pending;
      if (s.run.shiftNumber !== 1 || !plan) return s;
      const others = plan.queue.filter((q) => q.kind !== kind).map((q, i) => ({ ...q, eventId: i + 2 }));
      const head = { eventId: 1, kind, params, earliestMinute: DISASTER_AT_MINUTE, cascade: false, disaster: false };
      return { ...s, chaos: { ...s.chaos, pending: { ...plan, queue: [head, ...others] } } };
    };
  const cases: [ScenarioKind, Record<string, string>][] = [
    ['sensorFailure', { loop: 'makeup', mode: 'freeze' }],
    ['sensorFailure', { loop: 'makeup', mode: 'noise' }],
    ['controllerFault', { loop: 'makeup', kind: 'stuck' }],
  ];
  for (const [kind, params] of cases) {
    it(`${kind} ${JSON.stringify(params)}: the engaged bot ends shift 2 alive`, () => {
      for (const seed of SEEDS) {
        const r = playFrom(createInitialState(seed, 0, GAME_ID), 2, {}, forceExact(kind, params));
        // The forced event is the plan's eventId 1 (the shift summary carries no params).
        const hit = r.shiftEnds[1]?.events.find((e) => e.eventId === 1 && e.kind === kind);
        expect(hit, `seed ${seed} fired`).toBeDefined();
        expect(r.reason, `seed ${seed}`).toBeNull();
        expect(r.shiftEnds, `seed ${seed}`).toHaveLength(2);
      }
    }, 60_000);
  }
});

// Ruling R7 (spec §4.2): a drawn disaster lands in plant minutes 90-300 of its shift, whatever the
// other events are doing, unless the run ends first.
describe('disaster timing', () => {
  for (const mode of ['hard', 'normal'] as const) {
    it(`${mode}: every drawn disaster fires within minutes 90-300`, () => {
      let drawn = 0;
      for (const seed of SEEDS) {
        const planned = new Map<number, ScenarioKind>();
        const r = playFrom(createInitialState(seed, 0, GAME_ID, mode), mode === 'hard' ? 10 : 20, { mode }, (s) => {
          const d = s.chaos.pending?.queue.find((e) => e.disaster);
          if (d) planned.set(s.chaos.pending!.shiftNumber, d.kind);
          return s;
        });
        for (const [shift, kind] of planned) {
          if (shift > r.state.run.shiftNumber) continue; // never started
          drawn++;
          const end = r.shiftEnds[shift - 1];
          const fired = end ? end.events : (r.state.chaos.active?.fired ?? []);
          const hit = fired.find((e) => e.kind === kind);
          if (!hit) {
            // Only a run that ended before minute 300 may miss it.
            expect(end, `seed ${seed} shift ${shift} ${kind}`).toBeUndefined();
            const endedAt = ((r.state.tick - r.state.shift!.startTick) * TICK_PLANT_S) / 60;
            expect(endedAt, `seed ${seed} shift ${shift}`).toBeLessThan(DISASTER_MINUTE[1]);
            continue;
          }
          expect(DISASTER_KINDS).toContain(hit.kind);
          expect(hit.atMinute, `seed ${seed} shift ${shift} ${kind}`).toBeGreaterThanOrEqual(DISASTER_MINUTE[0]);
          expect(hit.atMinute, `seed ${seed} shift ${shift} ${kind}`).toBeLessThanOrEqual(DISASTER_MINUTE[1]);
        }
      }
      console.log(`${mode}: ${drawn} disasters drawn in shifts played`);
      expect(drawn).toBeGreaterThan(0);
    }, 120_000);
  }
});
