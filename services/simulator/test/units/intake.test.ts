import { describe, expect, it } from 'vitest';
import { TICK_PLANT_S } from '../../src/constants.js';
import { createInitialState, type PlantState } from '../../src/state.js';
import { stepIntake } from '../../src/units/intake.js';
import { allFinite } from '../helpers.js';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function run(s: PlantState, ticks: number, each?: (s: PlantState, i: number) => PlantState): PlantState {
  for (let i = 0; i < ticks; i++) {
    if (each) s = each(s, i);
    s = stepIntake(s, TICK_PLANT_S);
  }
  return s;
}
function bloom(s: PlantState, i: number): PlantState {
  const chl = Math.min(8, 1 + (7 * i) / 60);
  return { ...s, seawater: { ...s.seawater, chlorophyllUgL: chl } };
}
const withChlorine = (s: PlantState, c: number): PlantState => ({ ...s, pretreat: { ...s.pretreat, chlorineMgL: c } });

describe('stepIntake', () => {
  it('holds required flow at nominal over a shift', () => {
    let s = createInitialState(1, 0);
    for (let i = 0; i < 720; i++) {
      s = stepIntake(s, TICK_PLANT_S);
      expect(s.intake.flowM3h).toBeGreaterThanOrEqual(s.intake.requiredM3h);
    }
    expect(allFinite(s)).toBe(true);
  });

  it('a bloom without extra chlorine fouls the screen and starves flow', () => {
    const s = run(createInitialState(1, 0), 360, bloom);
    expect(s.intake.screenFouling).toBeGreaterThan(0.4);
    expect(s.intake.flowM3h).toBeLessThan(s.intake.requiredM3h);
  });

  it('extra chlorine keeps the screen clean through a bloom', () => {
    const s = run(withChlorine(createInitialState(1, 0), 3), 360, bloom);
    expect(s.intake.screenFouling).toBeLessThan(0.25);
  });

  it('cavitating pumps wear at least 5x faster', () => {
    const base = createInitialState(1, 0);
    const cav = clone(base);
    cav.intake.pumps['P-101'].cavitation = 0.6;
    const a = run(base, 5).intake.pumps['P-101'].wear;
    const b = run(cav, 5).intake.pumps['P-101'].wear;
    expect(b).toBeGreaterThanOrEqual(5 * a);
  });

  it('screen fouling drives cavitation at high speed', () => {
    const s0 = createInitialState(1, 0);
    s0.intake.screenFouling = 0.8;
    s0.pretreat.biofouling = 0.8;
    s0.seawater.chlorophyllUgL = 8;
    expect(run(s0, 20).intake.pumps['P-101'].cavitation).toBeGreaterThan(0);
  });

  it('required flow rises with seawater temperature', () => {
    const s = createInitialState(1, 0);
    s.seawater.tempC = 35;
    expect(stepIntake(s, TICK_PLANT_S).intake.requiredM3h).toBeCloseTo(5500 * 1.15);
  });

  it('stopping all pumps gives exactly zero flow, no NaN, and does not mutate input', () => {
    const s = createInitialState(1, 0);
    for (const p of Object.values(s.intake.pumps)) p.running = false;
    const before = clone(s);
    const n = stepIntake(s, TICK_PLANT_S);
    expect(n.intake.flowM3h).toBe(0);
    expect(allFinite(n)).toBe(true);
    expect(s).toEqual(before);
  });
});
