import { describe, expect, it } from 'vitest';
import { STAGE_COUNT } from '../../src/constants.js';
import { createInitialState, type PlantState, type Stage } from '../../src/state.js';
import { bottomTempC, recoveredTempC, stageEffectiveness, stepStages } from '../../src/units/stages.js';
import { allFinite } from '../helpers.js';

const DT = 40;

/** Nominal plant: TBT 108, seawater 30 C, vacuum 0.95, recirc 4180 m3/h, clean tubes. */
function nominal(): PlantState {
  const s = createInitialState(1, 0);
  return {
    ...s,
    seawater: { ...s.seawater, tempC: 30 },
    heater: { ...s.heater, tbtC: 108 },
    vacuum: { quality: 0.95 },
    brine: { ...s.brine, recircM3h: 4180 },
    intake: { ...s.intake, flowM3h: 5500, requiredM3h: 5500 },
  };
}

function stage(s: PlantState, i: number): Stage {
  const st = s.stages[i];
  if (!st) throw new Error(`no stage ${i}`);
  return st;
}

function withStages(s: PlantState, f: (st: Stage) => Stage): PlantState {
  return { ...s, stages: s.stages.map(f) };
}

function run(s: PlantState, ticks: number): { state: PlantState; distillateM3h: number; carryover: number } {
  let r = stepStages(s, DT);
  for (let i = 1; i < ticks; i++) r = stepStages(r.state, DT);
  return r;
}

describe('stageEffectiveness', () => {
  it('is 1 for clean tubes and falls with total scale', () => {
    expect(stageEffectiveness({ tempC: 100, levelM: 0.3, softScaleMm: 0, hardScaleMm: 0 })).toBe(1);
    expect(stageEffectiveness({ tempC: 100, levelM: 0.3, softScaleMm: 0.25, hardScaleMm: 0.25 })).toBeCloseTo(1 / 1.5, 12);
  });
});

describe('stepStages at nominal', () => {
  it('produces 480-540 m3/h with a 35-40 C bottom stage', () => {
    const r = stepStages(nominal(), DT);
    expect(r.distillateM3h).toBeGreaterThanOrEqual(480);
    expect(r.distillateM3h).toBeLessThanOrEqual(540);
    const bottom = stage(r.state, STAGE_COUNT - 1).tempC;
    expect(bottom).toBeGreaterThanOrEqual(35);
    expect(bottom).toBeLessThanOrEqual(40);
    expect(bottomTempC(r.state)).toBeGreaterThanOrEqual(35);
    expect(bottomTempC(r.state)).toBeLessThanOrEqual(40);
  });

  it('cascades stage temperatures down from TBT', () => {
    const r = stepStages(nominal(), DT);
    const t = r.state.stages.map((st) => st.tempC);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeLessThan(t[i - 1] ?? Number.NaN);
    expect(t[0]).toBeLessThan(108);
  });

  it('holds the nominal plant at equilibrium for a shift with no PID action', () => {
    const r = run(nominal(), 720);
    expect(r.state.brine.recircM3h).toBeCloseTo(4180, 0);
    expect(r.state.vacuum.quality).toBeCloseTo(0.95, 3);
    expect(r.state.brine.concentrationFactor).toBeCloseTo(1.45, 3);
    for (const st of r.state.stages) expect(st.levelM).toBeCloseTo(0.3, 3);
    expect(r.carryover).toBe(0);
    expect(allFinite(r.state)).toBe(true);
  });
});

describe('scaling', () => {
  const rate = (s: PlantState): number => stage(stepStages(s, DT).state, 0).softScaleMm - stage(s, 0).softScaleMm;

  it('grows >= 3x faster in stage 1 at TBT 114 than at 108', () => {
    const lo = nominal();
    const hi = { ...lo, heater: { ...lo.heater, tbtC: 114 } };
    expect(rate(hi)).toBeGreaterThanOrEqual(3 * rate(lo));
    expect(rate(lo)).toBeGreaterThan(0);
  });

  it('antiscalant at 4 mg/L cuts the scaling rate by >= 80 %', () => {
    const s = nominal();
    const none = { ...s, pretreat: { ...s.pretreat, antiscalantMgL: 0 } };
    const full = { ...s, pretreat: { ...s.pretreat, antiscalantMgL: 4 } };
    expect(rate(full)).toBeLessThanOrEqual(0.2 * rate(none));
  });

  it('a high concentration factor (too little blowdown) raises the scaling rate', () => {
    const s = nominal();
    const high = { ...s, brine: { ...s.brine, concentrationFactor: 1.8 } };
    expect(rate(high)).toBeGreaterThan(rate(s));
  });

  it('0.5 mm hard scale everywhere lowers distillate and recoveredTempC', () => {
    const clean = nominal();
    const scaled = withStages(clean, (st) => ({ ...st, hardScaleMm: 0.5 }));
    expect(stepStages(scaled, DT).distillateM3h).toBeLessThan(stepStages(clean, DT).distillateM3h);
    expect(recoveredTempC(scaled)).toBeLessThan(recoveredTempC(clean));
  });

  it('ball cleaning reduces soft scale but not hard scale', () => {
    const s = withStages({ ...nominal(), ballCleaning: true }, (st) => ({ ...st, softScaleMm: 0.3, hardScaleMm: 0.3 }));
    const r = run(s, 30);
    for (const st of r.state.stages) {
      expect(st.softScaleMm).toBeLessThan(0.3);
      expect(st.hardScaleMm).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('ball cleaning cuts distillate by 5 %', () => {
    const off = stepStages(nominal(), DT).distillateM3h;
    const on = stepStages({ ...nominal(), ballCleaning: true }, DT).distillateM3h;
    expect(on).toBeCloseTo(off * 0.95, 6);
  });
});

describe('levels', () => {
  it('level1 manual with valve closed floods stage 1 above 0.6 m within 30 ticks with carryover', () => {
    const s = nominal();
    const levels = s.loops.levels.map((l, i) => (i === 0 ? { ...l, mode: 'manual' as const, output: 0 } : l));
    let cur = { ...s, loops: { ...s.loops, levels } };
    let flooded = false;
    let carryover = 0;
    for (let i = 0; i < 30 && !flooded; i++) {
      const r = stepStages(cur, DT);
      cur = r.state;
      carryover = r.carryover;
      flooded = stage(cur, 0).levelM > 0.6;
    }
    expect(flooded).toBe(true);
    expect(carryover).toBeGreaterThan(0);
    expect(stage(cur, 0).levelM).toBeLessThanOrEqual(1.0);
  });

  it('a fast recirc increase disturbs the levels upward', () => {
    const s = nominal();
    const r = stepStages({ ...s, loops: { ...s.loops, recirc: { ...s.loops.recirc, output: 100 } } }, DT);
    expect(r.state.brine.recircM3h).toBeGreaterThan(4180);
    expect(stage(r.state, 5).levelM).toBeGreaterThan(0.3);
  });
});

describe('vacuum and brine', () => {
  it('vacuum steam at 0 drops quality below 0.6 within 60 ticks and collapses the cascade', () => {
    const s = nominal();
    let cur = { ...s, loops: { ...s.loops, vacuum: { ...s.loops.vacuum, output: 0 } } };
    let ticks = 0;
    while (cur.vacuum.quality >= 0.6 && ticks < 60) {
      cur = stepStages(cur, DT).state;
      ticks++;
    }
    expect(cur.vacuum.quality).toBeLessThan(0.6);
    expect(stepStages(cur, DT).distillateM3h).toBeLessThan(stepStages(nominal(), DT).distillateM3h);
  });

  it('CF rises toward 1.8 with blowdown closed and falls toward 1.2 with it open', () => {
    const s = nominal();
    const closed = run({ ...s, loops: { ...s.loops, blowdown: { ...s.loops.blowdown, output: 0 } } }, 720);
    const open = run({ ...s, loops: { ...s.loops, blowdown: { ...s.loops.blowdown, output: 100 } } }, 720);
    expect(closed.state.brine.concentrationFactor).toBeGreaterThan(1.7);
    expect(closed.state.brine.concentrationFactor).toBeLessThanOrEqual(1.8);
    expect(open.state.brine.concentrationFactor).toBeLessThan(1.3);
    expect(open.state.brine.concentrationFactor).toBeGreaterThanOrEqual(1.2);
    expect(open.state.brine.blowdownM3h).toBeGreaterThan(closed.state.brine.blowdownM3h);
  });

  it('stays finite with zero recirc and an extreme TBT', () => {
    const s = nominal();
    const r = run(
      { ...s, heater: { ...s.heater, tbtC: 30 }, loops: { ...s.loops, recirc: { ...s.loops.recirc, output: 0 } } },
      50,
    );
    expect(allFinite(r.state)).toBe(true);
    expect(r.distillateM3h).toBeGreaterThanOrEqual(0);
  });
});
