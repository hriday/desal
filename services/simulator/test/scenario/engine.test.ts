import type { ScenarioKind } from '@desal/schema';
import { applyEffect } from '../../src/scenario/effects.js';
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

/** Chlorophyll starts at 1 ug/L so the 120-minute ramp lands on a whole tick. */
const atOneUgL = (s: PlantState): PlantState => ({ ...s, seawater: { ...s.seawater, chlorophyllUgL: 1 } });

function run(s: PlantState, toTick: number, onTick?: (s: PlantState) => void) {
  while (s.tick <= toTick) {
    s = stepScenario(s).state;
    onTick?.(s);
    s = { ...s, tick: s.tick + 1 };
  }
  return s;
}

describe('scenario engine', () => {
  it('does nothing unless running with a loaded scenario', () => {
    const s = createInitialState(1, 0, GAME_ID);
    expect(stepScenario(s)).toEqual({ state: s, events: [] });
    const idle = { ...running(2), phase: 'handover' as const };
    expect(stepScenario(idle).state).toBe(idle);
  });

  it('a bloom ramps chlorophyll to 8 over 120 minutes (180 ticks) and holds it', () => {
    const s0 = applyEffect(atOneUgL(running(2)), 'bloom', { peakUgL: 8, rampMinutes: 120 });
    let at178 = 0;
    const s = run(s0, 179, (st) => {
      if (st.tick === 178) at178 = st.seawater.chlorophyllUgL;
    });
    expect(at178).toBeLessThan(8);
    expect(s.seawater.chlorophyllUgL).toBeCloseTo(8, 9);
    expect(run(s, 400).seawater.chlorophyllUgL).toBeCloseTo(8, 9);
  });
});

describe('applyEffect', () => {
  it('applies each slow kind', () => {
    const base = running(1);
    const mk = (kind: string, params: Record<string, number | string>) => applyEffect(base, kind as ScenarioKind, params);
    expect(mk('seawaterTemp', { deltaC: 3 }).seawater.tempC).toBe(33);
    expect(mk('pumpBearing', { pumpId: 'P-102', mult: 4 }).intake.pumps['P-102'].bearingWearMult).toBe(4);
    expect(mk('deliveryDelay', { ticks: 90 }).scenario.effects.deliveryDelayTicks).toBe(90);
    expect(mk('demandChange', { deltaM3: -200 }).shift!.target.productM3).toBe(3700);
    expect(mk('offgradeOnly', {}).scenario.effects.offgradeOnly).toBe(true);
    expect(mk('gasPriceSpike', { mult: 1.8 }).fuel.gas.priceUsdPerGJ).toBeCloseTo(8 * 1.8, 9);
    expect(mk('gasCurtailNotice', { capMW: 25, effectiveMinute: 180 }).fuel.gas.curtailmentNotice).toEqual({ atTick: 270, capMW: 25 });
    expect(mk('controllerFault', { loop: 'recirc', kind: 'drift' }).loops.recirc.fault).toEqual({
      kind: 'drift',
      bias: 0,
    });
    expect(mk('controllerFault', { loop: 'level3', kind: 'stuck' }).loops.levels[2]!.fault).toEqual({
      kind: 'stuck',
      bias: 0,
    });
  });

  it('does nothing outside a shift', () => {
    const s = createInitialState(1, 0, GAME_ID);
    expect(applyEffect(s, 'seawaterTemp', { deltaC: 3 })).toBe(s);
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
