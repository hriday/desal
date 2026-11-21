import { describe, expect, it } from 'vitest';
import {
  BLOWDOWN_MAX_M3H,
  BOTTOM_APPROACH_C,
  BOTTOM_VACUUM_PENALTY_C,
  CF_MAX,
  CF_MIN,
  HEATER_DT0_C,
  RECOVERY_STAGES,
  SOFT_TO_HARD_PER_S,
  STAGE_COUNT,
  TUBE_PLUG_DERATE,
} from '../../src/constants.js';
import { applyTrip } from '../../src/safety/interlocks.js';
import { createInitialState, NOMINAL, type PlantState, type Stage } from '../../src/state.js';
import { bottomTempC, cfTarget, recoveredTempC, scalingRates, stageEffectiveness, stepStages } from '../../src/units/stages.js';
import { allFinite } from '../helpers.js';
import { runUntil } from '../safety/harness.js';
import { GAME_ID } from '../envelope.js';

const DT = 40;

/** Nominal plant: nominal TBT and recirc, seawater 30 C, vacuum 0.95, clean tubes. */
function nominal(): PlantState {
  const s = createInitialState(1, 0, GAME_ID);
  return {
    ...s,
    seawater: { ...s.seawater, tempC: 30 },
    heater: { ...s.heater, tbtC: NOMINAL.tbtC },
    vacuum: { quality: 0.95 },
    brine: { ...s.brine, recircM3h: NOMINAL.recircM3h },
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
    expect(t[0]).toBeLessThan(NOMINAL.tbtC);
  });

  it('holds the nominal plant at equilibrium for a shift with no PID action', () => {
    const r = run(nominal(), 720);
    expect(r.state.brine.recircM3h).toBeCloseTo(NOMINAL.recircM3h, 0);
    expect(r.state.vacuum.quality).toBeCloseTo(0.95, 3);
    expect(r.state.brine.concentrationFactor).toBeCloseTo(1.45, 3);
    for (const st of r.state.stages) expect(st.levelM).toBeCloseTo(0.3, 3);
    expect(r.carryover).toBe(0);
    expect(allFinite(r.state)).toBe(true);
  });
});

describe('scaling', () => {
  const rate = (s: PlantState): number => stage(stepStages(s, DT).state, 0).softScaleMm - stage(s, 0).softScaleMm;

  it('grows >= 3x faster in stage 1 at TBT 108 than at 102', () => {
    const lo = { ...nominal(), heater: { ...nominal().heater, tbtC: 102 } };
    const hi = { ...lo, heater: { ...lo.heater, tbtC: 108 } };
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

describe('scaling temperature curve', () => {
  const total = (tempC: number): number => {
    const r = scalingRates(tempC, 2, 1.45);
    return r.softMmPerS + r.hardMmPerS;
  };
  /** Clean stages held at a TBT for an hour (90 ticks), with nominal chemistry. */
  const hourAt = (tbtC: number): Stage => {
    const s = withStages({ ...nominal(), heater: { ...nominal().heater, tbtC } }, (st) => ({ ...st, softScaleMm: 0, hardScaleMm: 0 }));
    return stage(run(s, 90).state, 0);
  };

  it('is low at the 93.5 C nominal: at most a quarter of the rate at 100 C', () => {
    expect(total(93.5)).toBeGreaterThan(0);
    expect(total(93.5)).toBeLessThanOrEqual(0.25 * total(100));
  });

  it('is severe above 105 C: at least 3x the rate at 100 C', () => {
    expect(total(105)).toBeGreaterThanOrEqual(3 * total(100));
  });

  it('deposits hard scale directly above 105 C, more the hotter it runs', () => {
    expect(scalingRates(105, 2, 1.45).hardMmPerS).toBe(0);
    expect(scalingRates(108, 2, 1.45).hardMmPerS).toBeGreaterThan(0);
    expect(scalingRates(110, 2, 1.45).hardMmPerS).toBeGreaterThan(scalingRates(108, 2, 1.45).hardMmPerS);
  });

  it('an hour at TBT 108 grows hard scale beyond what soft scale hardening alone can give', () => {
    const st = hourAt(108);
    // Hardening alone gives at most (final soft scale) x SOFT_TO_HARD_PER_S x 3600 s in an hour.
    expect(st.hardScaleMm).toBeGreaterThan(st.softScaleMm * SOFT_TO_HARD_PER_S * 3600);
  });

  it('an hour at 95 C grows hard scale only by soft scale hardening (no direct term)', () => {
    expect(scalingRates(95, 2, 1.45).hardMmPerS).toBe(0);
    const st = hourAt(95);
    expect(st.hardScaleMm).toBeGreaterThan(0);
    expect(st.hardScaleMm).toBeLessThanOrEqual(st.softScaleMm * SOFT_TO_HARD_PER_S * 3600);
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
    expect(r.state.brine.recircM3h).toBeGreaterThan(NOMINAL.recircM3h);
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

describe('heat-transfer sections (recovery 1-21, reject 22-24)', () => {
  /** 0.5 mm of hard scale on the stages i where pick(i). */
  const scaleWhere = (s: PlantState, pick: (i: number) => boolean): PlantState => ({
    ...s,
    stages: s.stages.map((st, i) => (pick(i) ? { ...st, hardScaleMm: 0.5 } : st)),
  });
  const reject = (i: number): boolean => i >= RECOVERY_STAGES;
  const recovery = (i: number): boolean => i < RECOVERY_STAGES;

  it('a clean plant gives the pre-sectioning bottom and recovered temperatures exactly', () => {
    const s = nominal();
    const bottom = s.seawater.tempC + BOTTOM_APPROACH_C + (1 - s.vacuum.quality) * BOTTOM_VACUUM_PENALTY_C;
    expect(bottomTempC(s)).toBe(bottom);
    expect(recoveredTempC(s)).toBe(Math.max(bottom, s.heater.tbtC - HEATER_DT0_C));
  });

  it('scale on stages 22-24 only leaves heat recovery alone and widens the bottom approach by approach x (1/eff - 1)', () => {
    const clean = nominal();
    const scaled = scaleWhere(clean, reject);
    const eff = stageEffectiveness(stage(scaled, STAGE_COUNT - 1));
    const approach = bottomTempC(clean) - clean.seawater.tempC;
    expect(recoveredTempC(scaled)).toBe(recoveredTempC(clean));
    expect(bottomTempC(scaled) - bottomTempC(clean)).toBeCloseTo(approach * (1 / eff - 1), 9);
  });

  it('scale on stages 1-21 only cuts heat recovery and leaves the bottom temperature alone', () => {
    const clean = nominal();
    const scaled = scaleWhere(clean, recovery);
    expect(recoveredTempC(scaled)).toBeLessThan(recoveredTempC(clean));
    expect(bottomTempC(scaled)).toBe(bottomTempC(clean));
  });
});

describe('a plugged stage', () => {
  it('plugging one stage of a clean nominal plant cuts raw distillate by 2 %', () => {
    const s = nominal();
    const plugged = { ...s, faults: { ...s.faults, stageDerate: s.faults.stageDerate.map((d, i) => (i === 3 ? TUBE_PLUG_DERATE : d)) } };
    const cut = 1 - stepStages(plugged, DT).distillateM3h / stepStages(s, DT).distillateM3h;
    expect(Math.abs(cut - 0.02)).toBeLessThanOrEqual(0.0005);
  });
});

describe('concentration factor from the salt balance', () => {
  const B = (s: PlantState): number => (BLOWDOWN_MAX_M3H * s.loops.blowdown.output) / 100;

  it('the nominal state targets CF 1.45', () => {
    const s = nominal();
    expect(Math.abs(cfTarget(s, B(s)) - 1.45)).toBeLessThanOrEqual(0.002);
  });

  it('closed blowdown targets CF_MAX', () => {
    expect(cfTarget(nominal(), 0)).toBe(CF_MAX);
  });

  it('halving the blowdown raises CF toward (D + B) / B', () => {
    const s0 = nominal();
    const half = { ...s0, loops: { ...s0.loops, blowdown: { ...s0.loops.blowdown, output: s0.loops.blowdown.output / 2 } } };
    const b = B(half);
    const d = s0.brine.distillateM3h;
    const want = Math.min(CF_MAX, Math.max(CF_MIN, (d + b) / b));
    expect(cfTarget(half, b)).toBeCloseTo(want, 9);
    expect(want).toBeGreaterThan(1.6);
    const r = run(half, 720); // 8 plant hours, 8 x CF_TAU_S
    expect(Math.abs(r.state.brine.concentrationFactor - want)).toBeLessThan(0.01);
    expect(r.state.brine.cfTargetHeld).toBeCloseTo(want, 3);
  });

  it('holds CF while the plant is tripped: 90 ticks later it is within 0.005 of its value at the trip', () => {
    const trippedAt = applyTrip(createInitialState(1, 0, GAME_ID), 'manual').state;
    expect(cfTarget(trippedAt, 0)).toBe(trippedAt.brine.cfTargetHeld);
    const after = runUntil(trippedAt, 90).state;
    expect(after.status).toBe('tripped');
    expect(after.brine.distillateM3h).toBeLessThan(0.5 * NOMINAL.productM3h);
    expect(Math.abs(after.brine.concentrationFactor - trippedAt.brine.concentrationFactor)).toBeLessThan(0.005);
  });
});
