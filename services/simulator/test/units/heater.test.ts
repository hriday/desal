import { describe, expect, it } from 'vitest';
import { BURNER_MAX_MW } from '../../src/constants.js';
import { createInitialState, type PlantState } from '../../src/state.js';
import { heaterDemandMW, stepHeater } from '../../src/units/heater.js';
import { allFinite } from '../helpers.js';

const DT = 40;

function base(): PlantState {
  const s = createInitialState(1, 0);
  return { ...s, brine: { ...s.brine, recircM3h: 4180 }, heater: { ...s.heater, tbtC: 100, burnerCondition: 1 } };
}

function run(s: PlantState, mw: number, recovered: number, ticks: number): PlantState {
  let cur = s;
  for (let i = 0; i < ticks; i++) cur = stepHeater(cur, mw, recovered, DT);
  return cur;
}

function onBackup(s: PlantState, grade: 'standard' | 'offgrade'): PlantState {
  return { ...s, fuel: { ...s.fuel, active: 'backup', backup: { ...s.fuel.backup, grade } } };
}

describe('heaterDemandMW', () => {
  it('scales with tbt loop output and burner condition', () => {
    const s = base();
    const s2: PlantState = {
      ...s,
      loops: { ...s.loops, tbt: { ...s.loops.tbt, output: 50 } },
      heater: { ...s.heater, burnerCondition: 0.8 },
    };
    expect(heaterDemandMW(s2)).toBeCloseTo(BURNER_MAX_MW * 0.5 * 0.8, 9);
  });
});

describe('stepHeater', () => {
  it('converges TBT to recovered + Q/(m cp)', () => {
    const r = run(base(), 38, 100, 200);
    expect(Math.abs(r.heater.tbtC - 108)).toBeLessThan(1);
    expect(r.heater.heatMW).toBe(38);
  });

  it('halving delivered heat lowers steady TBT', () => {
    const full = run(base(), 38, 100, 200).heater.tbtC;
    const half = run(base(), 19, 100, 200).heater.tbtC;
    expect(half).toBeLessThan(full);
  });

  it('approaches gradually (first-order lag)', () => {
    const r = stepHeater(base(), 38, 100, DT);
    expect(r.heater.tbtC).toBeGreaterThan(100);
    expect(r.heater.tbtC).toBeLessThan(104);
  });

  it('wears off-grade 6x and standard 3x gas over 100 ticks', () => {
    const wGas = 1 - run(base(), 30, 100, 100).heater.burnerCondition;
    const wOff = 1 - run(onBackup(base(), 'offgrade'), 30, 100, 100).heater.burnerCondition;
    const wStd = 1 - run(onBackup(base(), 'standard'), 30, 100, 100).heater.burnerCondition;
    expect(wGas).toBeGreaterThan(0);
    expect(wOff / wGas).toBeCloseTo(6, 6);
    expect(wStd / wGas).toBeCloseTo(3, 6);
  });

  it('clamps burner condition at 0 and stays finite with zero recirc', () => {
    const s = base();
    const z = stepHeater(
      { ...s, brine: { ...s.brine, recircM3h: 0 }, heater: { ...s.heater, burnerCondition: 0 } },
      38,
      100,
      DT,
    );
    expect(allFinite(z)).toBe(true);
    expect(z.heater.burnerCondition).toBe(0);
  });

  it('does not mutate input and records firingPct', () => {
    const s = base();
    const before = JSON.stringify(s);
    const r = stepHeater(s, 38, 100, DT);
    expect(JSON.stringify(s)).toBe(before);
    expect(r.heater.firingPct).toBe(s.loops.tbt.output);
  });
});
