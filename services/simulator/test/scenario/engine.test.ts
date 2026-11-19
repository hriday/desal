import { loadScenario, stepScenario } from '../../src/scenario/engine.js';
import { scenarioForShift } from '../../src/scenario/library.js';
import { createInitialState, type PlantState } from '../../src/state.js';
import { allFinite } from '../helpers.js';
import { GAME_ID } from '../envelope.js';

function running(shift: number, seed = 1): PlantState {
  let s = createInitialState(seed, 0, GAME_ID);
  const sc = scenarioForShift(shift, seed);
  s = loadScenario(s, sc);
  return {
    ...s,
    phase: 'running',
    shift: {
      id: shift,
      startTick: 0,
      mode: 'auto',
      target: sc.target,
      acc: { productM3: 0, offSpecM3: 0, offSpecTicks: 0, fuelCostUsd: 0, trips: 0, spentUsd: 0 },
    },
  };
}

type Ev = { atMinute: number; kind: string; params: Record<string, number | string> };

/** A running shift whose scenario holds exactly these events. */
function withEvents(s: PlantState, events: Ev[]): PlantState {
  const def = { ...s.scenario.definition!, events: events.map((e) => ({ ...e, kind: e.kind as never, message: e.kind })) };
  return { ...s, scenario: { ...s.scenario, definition: def } };
}

/** Chlorophyll starts at 1 ug/L so the 120-minute ramp lands on a whole tick. */
const atOneUgL = (s: PlantState): PlantState => ({ ...s, seawater: { ...s.seawater, chlorophyllUgL: 1 } });
const BLOOM: Ev = { atMinute: 90, kind: 'bloom', params: { peakUgL: 8, rampMinutes: 120 } };
const PIPELINE: Ev[] = [
  { atMinute: 0, kind: 'offgradeOnly', params: {} },
  { atMinute: 60, kind: 'gasCurtailNotice', params: { capMW: 25, effectiveMinute: 180 } },
  { atMinute: 240, kind: 'gasPriceSpike', params: { mult: 1.8 } },
];

function run(s: PlantState, toTick: number, onTick?: (s: PlantState, firedCount: number) => void) {
  const all: ReturnType<typeof stepScenario>['events'] = [];
  while (s.tick <= toTick) {
    const r = stepScenario(s);
    s = r.state;
    all.push(...r.events);
    onTick?.(s, r.events.length);
    s = { ...s, tick: s.tick + 1 };
  }
  return { s, all };
}

describe('scenario engine', () => {
  it('does nothing unless running with a loaded scenario', () => {
    const s = createInitialState(1, 0, GAME_ID);
    expect(stepScenario(s)).toEqual({ state: s, events: [] });
    const idle = { ...running(2), phase: 'handover' as const };
    expect(stepScenario(idle).state).toBe(idle);
  });

  it('fires a scheduled bloom at tick 135 exactly once', () => {
    const fired: number[] = [];
    run(withEvents(atOneUgL(running(2)), [BLOOM]), 400, (st, n) => {
      if (n) fired.push(st.tick);
    });
    expect(fired).toEqual([135]);
  });

  it('ramps chlorophyll to 8 by tick 315 and not before', () => {
    let at314 = 0;
    const { s } = run(withEvents(atOneUgL(running(2)), [BLOOM]), 315, (st) => {
      if (st.tick === 314) at314 = st.seawater.chlorophyllUgL;
    });
    expect(at314).toBeLessThan(8);
    expect(s.seawater.chlorophyllUgL).toBeCloseTo(8, 9);
    expect(run(s, 400).s.seawater.chlorophyllUgL).toBeCloseTo(8, 9);
  });

  it('scheduled events: offgrade at start, notice at minute 60, price spike at 240', () => {
    const { s, all } = run(withEvents(running(3), PIPELINE), 600);
    expect(all.map((e) => (e.type === 'scenario' ? e.kind : ''))).toEqual([
      'offgradeOnly',
      'gasCurtailNotice',
      'gasPriceSpike',
    ]);
    expect(s.scenario.effects.offgradeOnly).toBe(true);
    expect(s.fuel.gas.priceUsdPerGJ).toBeCloseTo(8 * 1.8, 9);
    expect(run(withEvents(running(3), PIPELINE), 91).s.fuel.gas.curtailmentNotice).toEqual({ atTick: 270, capMW: 25 });
  });

  it('applies the other effects', () => {
    const base = running(1);
    const mk = (kind: string, params: Record<string, number | string>) => {
      const sc = { ...base.scenario.definition!, events: [{ atMinute: 0, kind: kind as never, params, message: 'm' }] };
      return stepScenario({ ...base, scenario: { ...base.scenario, definition: sc } }).state;
    };
    expect(mk('seawaterTemp', { deltaC: 3 }).seawater.tempC).toBe(33);
    expect(mk('pumpBearing', { pumpId: 'P-102', mult: 4 }).intake.pumps['P-102'].bearingWearMult).toBe(4);
    expect(mk('deliveryDelay', { ticks: 90 }).scenario.effects.deliveryDelayTicks).toBe(90);
    expect(mk('demandChange', { deltaM3: -200 }).shift!.target.productM3).toBe(3700);
    expect(mk('controllerFault', { loop: 'recirc', kind: 'drift' }).loops.recirc.fault).toEqual({
      kind: 'drift',
      bias: 0,
    });
    expect(mk('controllerFault', { loop: 'level3', kind: 'stuck' }).loops.levels[2]!.fault).toEqual({
      kind: 'stuck',
      bias: 0,
    });
  });
});

describe('scenarioForShift', () => {
  it('supplies the base target and no events', () => {
    expect(scenarioForShift(1, 0).target).toEqual({ productM3: 3900, maxSalinityPpm: 25, fuelBudgetUsd: 12000 });
    expect(scenarioForShift(3, 0).target.productM3).toBe(Math.round(3900 * 1.08));
    expect(scenarioForShift(7, 5).events).toEqual([]);
    expect(allFinite(scenarioForShift(7, 5))).toBe(true);
  });
  it('shift conditions are deterministic per seed and differ across seeds', () => {
    expect(scenarioForShift(7, 5)).toEqual(scenarioForShift(7, 5));
    const seen = new Set([1, 2, 3, 4, 5].map((k) => JSON.stringify(scenarioForShift(7, k).initial)));
    expect(seen.size).toBeGreaterThan(1);
  });
  it('scales the target 4% per shift, uncapped (see difficulty.test.ts)', () => {
    expect(scenarioForShift(4, 1).target.productM3).toBe(Math.round(3900 * 1.12));
    expect(scenarioForShift(30, 1).target.productM3).toBe(Math.round(3900 * 2.16));
  });
});
