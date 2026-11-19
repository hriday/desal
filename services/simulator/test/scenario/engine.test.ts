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
      acc: { productM3: 0, offSpecTicks: 0, fuelCostUsd: 0, trips: 0, revenueUsd: 0, finesUsd: 0 },
    },
  };
}

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

  it('fires the shift 2 bloom at tick 135 exactly once', () => {
    const fired: number[] = [];
    run(running(2), 400, (st, n) => {
      if (n) fired.push(st.tick);
    });
    expect(fired).toEqual([135]);
  });

  it('ramps chlorophyll to 8 by tick 315 and not before', () => {
    let at314 = 0;
    const { s } = run(running(2), 315, (st) => {
      if (st.tick === 314) at314 = st.seawater.chlorophyllUgL;
    });
    expect(at314).toBeLessThan(8);
    expect(s.seawater.chlorophyllUgL).toBeCloseTo(8, 9);
    expect(run(s, 400).s.seawater.chlorophyllUgL).toBeCloseTo(8, 9);
  });

  it('shift 3: offgrade at start, notice at minute 60, price spike at 240', () => {
    const { s, all } = run(running(3), 600);
    expect(all.map((e) => (e.type === 'scenario' ? e.kind : ''))).toEqual([
      'offgradeOnly',
      'gasCurtailNotice',
      'gasPriceSpike',
    ]);
    expect(s.scenario.effects.offgradeOnly).toBe(true);
    expect(s.fuel.gas.priceUsdPerGJ).toBeCloseTo(8 * 1.8, 9);
    expect(run(running(3), 91).s.fuel.gas.curtailmentNotice).toEqual({ atTick: 270, capMW: 25 });
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

  it('random events use state.seed and store the advanced seed', () => {
    const base = running(1, 42);
    const def = { ...base.scenario.definition!, randomPerHour: [{ kind: 'gasPriceSpike' as const, p: 3600 / 40 }] };
    const s0 = { ...base, scenario: { ...base.scenario, definition: def } };
    const r = stepScenario(s0);
    expect(r.state.seed).not.toBe(s0.seed);
    expect(r.events).toHaveLength(1);
    expect(r.state.fuel.gas.priceUsdPerGJ).toBeGreaterThan(8);
    expect(stepScenario(s0)).toEqual(r);
    const never = { ...s0, scenario: { ...s0.scenario, definition: { ...def, randomPerHour: [{ kind: 'gasPriceSpike' as const, p: 0 }] } } };
    const rn = stepScenario(never);
    expect(rn.events).toHaveLength(0);
    expect(rn.state.seed).not.toBe(never.seed);
  });
});

describe('scenarioForShift', () => {
  it('matches the fixed shifts', () => {
    expect(scenarioForShift(1, 0).target).toEqual({ productM3: 3900, maxSalinityPpm: 25, fuelBudgetUsd: 12000 });
    expect(scenarioForShift(3, 0).target.productM3).toBe(3700);
    expect(scenarioForShift(3, 0).target.fuelBudgetUsd).toBe(16000);
  });
  it('shift 7 is deterministic per seed and differs across seeds', () => {
    expect(scenarioForShift(7, 5)).toEqual(scenarioForShift(7, 5));
    const seen = new Set([1, 2, 3, 4, 5].map((k) => JSON.stringify(scenarioForShift(7, k))));
    expect(seen.size).toBeGreaterThan(1);
    const n = scenarioForShift(7, 5).events.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(4);
    expect(allFinite(scenarioForShift(7, 5))).toBe(true);
  });
  it('scales the target, capped at 1.15', () => {
    expect(scenarioForShift(4, 1).target.productM3).toBe(Math.round(3900 * 1.02));
    expect(scenarioForShift(30, 1).target.productM3).toBe(Math.round(3900 * 1.15));
  });
});
