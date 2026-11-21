import { describe, expect, it } from 'vitest';
import {
  BASE_SALINITY_PPM,
  EJECTOR_MIN_LOAD_FACTOR,
  EJECTOR_RATE_BASE_PER_MIN,
  EJECTOR_RATE_MAX_PER_MIN,
  POWER_DIP_MAX_MINUTES,
  PUMP_TRIP_WEAR,
  RECIRC_PUMP_MAX_M3H,
  RECOVERY_STAGES,
  SENSOR_NOISE_AMPLITUDE,
  STORM_FOULING_PER_TICK,
  TICK_PLANT_S,
  TUBE_LEAK_GROWTH_PPM_PER_MIN,
  TUBE_PLUG_DERATE,
  VACUUM_TRIP,
} from '../../src/constants.js';
import type { FiredEvent } from '../../src/scenario/chaosTypes.js';
import { isCleared } from '../../src/scenario/director.js';
import { applyEffect } from '../../src/scenario/effects.js';
import { applyCommand } from '../../src/commands.js';
import { drawEvent } from '../../src/scenario/library.js';
import { ejectorLoadFactor } from '../../src/units/stages.js';
import { startShift } from '../../src/shift.js';
import { createInitialState, NOMINAL, type PlantState } from '../../src/state.js';
import { tick } from '../../src/tick.js';
import { GAME_ID } from '../envelope.js';

/** A shift running at nominal with the director's plan emptied, so only what a test applies happens. */
function quiet(): PlantState {
  const s = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
  return { ...s, chaos: { ...s.chaos, active: null } };
}
function run(s: PlantState, n: number, each?: (s: PlantState) => void): PlantState {
  for (let i = 0; i < n; i++) {
    s = tick(s, []).state;
    each?.(s);
  }
  return s;
}
const settle = (): PlantState => run(quiet(), 30);

describe('pumpTrip', () => {
  it('stops the pump, costs wear, halves intake and does not trip the plant', () => {
    const s0 = settle();
    const before = s0.intake.flowM3h;
    const hit = applyEffect(s0, 'pumpTrip', { pumpId: 'P-101' });
    expect(hit.intake.pumps['P-101'].running).toBe(false);
    expect(hit.intake.pumps['P-101'].wear).toBeCloseTo(s0.intake.pumps['P-101'].wear + PUMP_TRIP_WEAR);
    expect(run(hit, 3).intake.flowM3h).toBeLessThanOrEqual(0.6 * before);
    let tripped = false;
    const after20 = run(hit, 20, (x) => {
      if (x.status === 'tripped') tripped = true;
    });
    expect(tripped).toBe(false);
    expect(after20.status).toBe('online');
  });

  it('starting P-103 restores the flow within 10 ticks', () => {
    const s0 = settle();
    const before = s0.intake.flowM3h;
    const hit = applyEffect(s0, 'pumpTrip', { pumpId: 'P-101' });
    const started: PlantState = {
      ...hit,
      intake: { ...hit.intake, pumps: { ...hit.intake.pumps, 'P-103': { ...hit.intake.pumps['P-103'], running: true } } },
    };
    expect(run(started, 10).intake.flowM3h).toBeGreaterThanOrEqual(0.95 * before);
  });

  it('Auto never starts the standby: P-103 stays stopped for 60 ticks', () => {
    const hit = applyEffect(settle(), 'pumpTrip', { pumpId: 'P-101' });
    run(hit, 60, (x) => {
      expect(x.intake.pumps['P-103'].running).toBe(false);
    });
  });
});

describe('powerDip', () => {
  it('stops the pump without wear, caps recirculation, and expires', () => {
    const s0 = settle();
    const hit = applyEffect(s0, 'powerDip', { pumpId: 'P-102', recircFactor: 0.6, minutes: 20 });
    expect(hit.intake.pumps['P-102'].running).toBe(false);
    expect(hit.intake.pumps['P-102'].wear).toBe(s0.intake.pumps['P-102'].wear);
    expect(hit.faults.powerDipRemainingTicks).toBe(30);
    const during = run(hit, 20);
    expect(during.brine.recircM3h).toBeLessThanOrEqual(0.6 * RECIRC_PUMP_MAX_M3H + 0.1);
    expect(during.faults.powerDipRemainingTicks).toBe(10);
    const after = run(hit, 30);
    expect(after.faults.powerDipRemainingTicks).toBe(0);
    expect(run(after, 5).faults.powerDipRemainingTicks).toBe(0);
  });

  it('draw caps the duration at the named maximum at a high shift number', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const [e] = drawEvent('powerDip', 60, seed, 400);
      expect(Number(e.params.minutes)).toBeLessThanOrEqual(POWER_DIP_MAX_MINUTES);
    }
    const [e] = drawEvent('powerDip', 60, 1, 400);
    expect(e.params.minutes).toBe(POWER_DIP_MAX_MINUTES);
  });
});

describe('storm', () => {
  it('adds fouling and cooling at once, grows it while active, and stops after', () => {
    const s0 = settle();
    const hit = applyEffect(s0, 'storm', { fouling: 0.1, deltaC: 2, minutes: 10 });
    expect(hit.seawater.tempC).toBeCloseTo(s0.seawater.tempC - 2);
    expect(hit.intake.screenFouling).toBeCloseTo(s0.intake.screenFouling + 0.1);
    expect(hit.faults.stormFouling).toBeCloseTo(0.1);
    expect(hit.faults.stormRemainingTicks).toBe(15);
    expect(run(hit, 5).faults.stormFouling).toBeCloseTo(0.1 + 5 * STORM_FOULING_PER_TICK);
    const over = run(hit, 15);
    expect(over.faults.stormRemainingTicks).toBe(0);
    const grown = over.faults.stormFouling;
    expect(grown).toBeCloseTo(0.1 + 15 * STORM_FOULING_PER_TICK);
    const later = run(over, 20);
    expect(later.faults.stormFouling).toBe(grown);
    // The fouling stays (it is not relaxed away) until the crew cleans the screens.
    expect(later.intake.screenFouling).toBeGreaterThanOrEqual(s0.intake.screenFouling + grown - 0.01);
  });
});

describe('storm clearing', () => {
  const ev = { eventId: 1, kind: 'storm', atMinute: 0, params: {}, cleared: false, how: null } as unknown as FiredEvent;

  it('a storm at full screen fouling is not cleared by the crew; it expires', () => {
    const s0 = settle();
    const full: PlantState = { ...s0, intake: { ...s0.intake, screenFouling: 1 } };
    const hit = applyEffect(full, 'storm', { fouling: 0.1, deltaC: 1, minutes: 10 });
    expect(hit.faults.stormFouling).toBe(0);
    expect(isCleared(hit, ev)).toBeNull();
    expect(isCleared(run(hit, 1), ev)).toBeNull();
    expect(isCleared(run(hit, 14), ev)).toBeNull();
    expect(isCleared(run(hit, 15), ev)).toBe('expired');
  });

  it('with the crew flag set it clears as crew', () => {
    const hit = applyEffect(settle(), 'storm', { fouling: 0.1, deltaC: 1, minutes: 10 });
    expect(isCleared({ ...hit, faults: { ...hit.faults, stormCleanedByCrew: true } }, ev)).toBe('crew');
  });
});

describe('interlock', () => {
  it('a single-pump loss with the other duty pump running does not trip noIntakeFlow, even in a heavy storm', () => {
    let s = applyEffect(settle(), 'storm', { fouling: 0.4, deltaC: 0, minutes: 120 });
    s = applyEffect(s, 'pumpTrip', { pumpId: 'P-101' });
    run(s, 60, (x) => expect(x.status).not.toBe('tripped'));
  });
});

describe('tubeLeak', () => {
  it('adds the ppm to salinity at once, then grows while unplugged', () => {
    const s0 = settle();
    expect(s0.product.salinityPpm).toBeCloseTo(BASE_SALINITY_PPM, 0);
    const hit = applyEffect(s0, 'tubeLeak', { stage: 2, ppm: 15 });
    expect(hit.faults.tubeLeak).toEqual({ stage: 2, ppm: 15 });
    const next = run(hit, 1);
    expect(next.product.salinityPpm).toBeGreaterThanOrEqual(s0.product.salinityPpm + 15);
    const later = run(hit, 30);
    expect(later.faults.tubeLeak!.ppm).toBeCloseTo(15 + 30 * TUBE_LEAK_GROWTH_PPM_PER_MIN * (TICK_PLANT_S / 60));
    expect(later.product.salinityPpm).toBeGreaterThan(next.product.salinityPpm);
  });

  it('a stage derate scales distillate', () => {
    const s0 = settle();
    const derated: PlantState = { ...s0, faults: { ...s0.faults, stageDerate: s0.faults.stageDerate.map((d, i) => (i === 1 ? TUBE_PLUG_DERATE : d)) } };
    expect(tick(derated, []).state.product.flowM3h).toBeLessThan(tick(s0, []).state.product.flowM3h);
  });

  it('the draw lands leaks in the recovery stages only (0-based 0-20), reaching stage 21', () => {
    const stages = Array.from({ length: 500 }, (_, i) => Number(drawEvent('tubeLeak', 0, i + 1, 3)[0].params.stage));
    for (const st of stages) {
      expect(Number.isInteger(st)).toBe(true);
      expect(st).toBeGreaterThanOrEqual(0);
      expect(st).toBeLessThanOrEqual(RECOVERY_STAGES - 1);
    }
    expect(stages).toContain(RECOVERY_STAGES - 1);
  });
});

describe('vacuumLoss', () => {
  const RATE = 0.012;
  const tripTick = (s: PlantState, n: number): number | null => {
    for (let i = 1; i <= n; i++) {
      s = tick(s, []).state;
      if (s.status === 'tripped') return i;
    }
    return null;
  };

  it('sets the ejector failure and trips lossOfVacuum in 20-30 plant minutes at nominal load', () => {
    const hit = applyEffect(settle(), 'vacuumLoss', { ratePerMin: RATE });
    expect(hit.faults.ejectorFailed).toBe(true);
    const t = tripTick(hit, 60);
    expect(t).not.toBeNull();
    const expected = ((hit.vacuum.quality - VACUUM_TRIP) / RATE) * (60 / TICK_PLANT_S);
    expect(Math.abs(t! - expected)).toBeLessThanOrEqual(2);
    expect(t!).toBeGreaterThanOrEqual(30);
    expect(t!).toBeLessThanOrEqual(45);
  });

  it('the shift 1 draw with no action trips lossOfVacuum in 30-45 ticks', () => {
    const [e] = drawEvent('vacuumLoss', 0, 1, 1);
    expect(e.params.ratePerMin).toBe(EJECTOR_RATE_BASE_PER_MIN);
    const t = tripTick(applyEffect(settle(), 'vacuumLoss', e.params), 60);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(30);
    expect(t!).toBeLessThanOrEqual(45);
  });

  it('the draw rate rises with the shift number up to the cap', () => {
    expect(drawEvent('vacuumLoss', 0, 1, 400)[0].params.ratePerMin).toBe(EJECTOR_RATE_MAX_PER_MIN);
  });

  it('cutting firing by 25 % at the fault stops the trip within 45 ticks', () => {
    const hit = applyEffect(settle(), 'vacuumLoss', { ratePerMin: RATE });
    const manual = { ...hit.loops.tbt, mode: 'manual' as const, output: hit.loops.tbt.output * 0.75 };
    expect(tripTick({ ...hit, loops: { ...hit.loops, tbt: manual } }, 45)).toBeNull();
  });

  it('load factor: 1 at nominal, about a half for 5 degC or 20 % less firing, bounded below', () => {
    const f = NOMINAL.firingPct;
    expect(ejectorLoadFactor(NOMINAL.tbtC, f)).toBe(1);
    expect(ejectorLoadFactor(NOMINAL.tbtC + 3, f * 1.1)).toBe(1);
    expect(ejectorLoadFactor(NOMINAL.tbtC - 5, f)).toBeCloseTo(0.5);
    expect(ejectorLoadFactor(NOMINAL.tbtC, f * 0.8)).toBeCloseTo(0.5);
    expect(ejectorLoadFactor(NOMINAL.tbtC - 2.5, f)).toBeCloseTo(0.75);
    expect(ejectorLoadFactor(NOMINAL.tbtC - 50, 0)).toBe(EJECTOR_MIN_LOAD_FACTOR);
  });

  it('is cleared when the ejector is repaired', () => {
    const ev = { eventId: 1, kind: 'vacuumLoss', atMinute: 0, params: {}, cleared: false, how: null } as unknown as FiredEvent;
    const hit = applyEffect(settle(), 'vacuumLoss', { ratePerMin: RATE });
    expect(isCleared(hit, ev)).toBeNull();
    expect(isCleared({ ...hit, faults: { ...hit.faults, ejectorFailed: false } }, ev)).toBe('crew');
  });
});

describe('sensorFailure', () => {
  it('freeze stores the true value at failure; noise stores the amplitude', () => {
    const s0 = settle();
    const f = applyEffect(s0, 'sensorFailure', { loop: 'tbt', mode: 'freeze' });
    expect(f.faults.sensors.tbt).toEqual({ kind: 'freeze', value: s0.heater.tbtC });
    const n = applyEffect(s0, 'sensorFailure', { loop: 'vacuum', mode: 'noise' });
    expect(n.faults.sensors.vacuum).toEqual({ kind: 'noise', amplitude: SENSOR_NOISE_AMPLITUDE });
  });

  /** The player raises the setpoint 3 degC; the loop reads the frozen value forever and keeps heating. */
  const frozenRun = (): PlantState => {
    const s0 = settle();
    const hit = applyEffect(s0, 'sensorFailure', { loop: 'tbt', mode: 'freeze' });
    return { ...hit, loops: { ...hit.loops, tbt: { ...hit.loops.tbt, setpoint: s0.heater.tbtC + 3 } } };
  };

  const overshoot = (s: PlantState, sp: number): number => s.heater.tbtC - sp;

  it('a frozen tbt sensor holds the telemetry reading while the Auto loop drives the true TBT past setpoint', () => {
    const s0 = frozenRun();
    const sp = s0.loops.tbt.setpoint;
    const frozen = s0.faults.sensors.tbt as { value: number };
    let s = s0;
    let worst = -Infinity;
    for (let i = 0; i < 60; i++) {
      const r = tick(s, []);
      s = r.state;
      expect(r.telemetry.find((t) => t.sensorId === 'heater.tbtC')!.value).toBe(frozen.value);
      worst = Math.max(worst, overshoot(s, sp));
      if (s.status !== 'online') break;
    }
    expect(worst).toBeGreaterThan(2);
  });

  it('the same run with a healthy sensor settles within 2 degC of setpoint', () => {
    const s0 = frozenRun();
    const healthy: PlantState = { ...s0, faults: { ...s0.faults, sensors: {} } };
    const sp = s0.loops.tbt.setpoint;
    let s = healthy;
    for (let i = 0; i < 60; i++) {
      s = tick(s, []).state;
      if (i >= 30) expect(Math.abs(overshoot(s, sp))).toBeLessThanOrEqual(2);
    }
    expect(s.status).toBe('online');
  });

  it('switching the loop to Manual at a balanced output stops a real drift', () => {
    const s0 = frozenRun();
    const sp = s0.loops.tbt.setpoint;
    let s = s0;
    for (let i = 0; i < 60 && overshoot(s, sp) <= 2; i++) s = tick(s, []).state;
    expect(overshoot(s, sp)).toBeGreaterThan(2);
    s = { ...s, loops: { ...s.loops, tbt: { ...s.loops.tbt, mode: 'manual', output: NOMINAL.firingPct } } };
    s = run(s, 40);
    const a = s.heater.tbtC;
    expect(s.status).toBe('online');
    expect(Math.abs(run(s, 5).heater.tbtC - a)).toBeLessThan(0.1);
  });
});

describe('crew jobs', () => {
  const cmd = (s: PlantState, command: Record<string, unknown>) =>
    applyCommand(s, {
      commandId: '123e4567-e89b-42d3-a456-426614174000',
      issuedAt: 0,
      gameId: GAME_ID,
      shiftId: s.shift?.id ?? null,
      command,
    });
  const dispatchJob = (s: PlantState, job: 'repairEjector' | 'cleanScreens'): PlantState => {
    const r = cmd(s, { type: 'dispatchCrew', job });
    expect(r.events.map((e) => e.type)).toEqual(['accountChange']);
    return r.state;
  };

  it('after vacuumLoss trips the plant, repairEjector lets a restart reach online', () => {
    let s = applyEffect(settle(), 'vacuumLoss', { ratePerMin: 0.012 });
    s = run(s, 60);
    expect(s.status).toBe('tripped');
    s = run(dispatchJob(s, 'repairEjector'), 68); // 45 min = 67.5 ticks
    expect(s.crew).toBeNull();
    expect(s.faults.ejectorFailed).toBe(false);
    expect(s.faults.ejectorRatePerMin).toBe(0);
    s = run(s, 60);
    s = cmd(s, { type: 'restart' }).state;
    expect(s.status).toBe('restarting');
    s = run(s, 400);
    expect(s.status).toBe('online');
  });

  it('cleanScreens during a storm clears as crew and fouling ends near its pre-storm level', () => {
    const s0 = settle();
    const pre = s0.intake.screenFouling;
    const storm = applyEffect(s0, 'storm', { fouling: 0.2, deltaC: 2, minutes: 40 });
    const ev = { eventId: 1, kind: 'storm', atMinute: 0, params: {}, cleared: false, how: null } as unknown as FiredEvent;
    let s = run(storm, 30);
    expect(s.faults.stormRemainingTicks).toBeGreaterThan(0);
    expect(s.intake.screenFouling).toBeGreaterThan(pre + 0.1);
    expect(isCleared(s, ev)).toBeNull();
    s = run(dispatchJob(s, 'cleanScreens'), 45);
    expect(s.crew).toBeNull();
    expect(s.faults.stormFouling).toBe(0);
    expect(s.faults.stormCleanedByCrew).toBe(true);
    expect(isCleared(s, ev)).toBe('crew');
    s = run(s, 100);
    expect(s.faults.stormRemainingTicks).toBe(0);
    expect(Math.abs(s.intake.screenFouling - pre)).toBeLessThan(0.02);
  });

  it('a crew job cannot carry into the next shift', () => {
    const s = dispatchJob(applyEffect(settle(), 'vacuumLoss', { ratePerMin: 0.012 }), 'repairEjector');
    expect(s.crew).not.toBeNull();
    expect(startShift({ ...s, phase: 'handover' }, 'auto').state.crew).toBeNull();
  });
});

describe('makeup loop faults (the stage-24 brine pool)', () => {
  const POOL = 'stages.s24.levelM';
  const cmd = (s: PlantState, command: Record<string, unknown>) =>
    applyCommand(s, {
      commandId: '123e4567-e89b-42d3-a456-426614174000',
      issuedAt: 0,
      gameId: GAME_ID,
      shiftId: s.shift?.id ?? null,
      command,
    });
  const fired = (kind: string, params: Record<string, string>) =>
    ({ eventId: 1, kind, atMinute: 0, params, cleared: false, how: null }) as unknown as FiredEvent;
  const poolM = (s: PlantState): number => s.stages[s.stages.length - 1]!.levelM;
  /** Blowdown wide open in Manual: the pool drains faster than the makeup it is set for. */
  const openBlowdown = (s: PlantState): PlantState => ({
    ...s,
    loops: { ...s.loops, blowdown: { ...s.loops.blowdown, mode: 'manual', output: 100 } },
  });

  it('a frozen makeup sensor holds the pool reading in telemetry while the true level moves', () => {
    const s0 = settle();
    const hit = applyEffect(s0, 'sensorFailure', { loop: 'makeup', mode: 'freeze' });
    const frozen = hit.faults.sensors.makeup as { kind: string; value: number };
    expect(frozen).toEqual({ kind: 'freeze', value: poolM(s0) });
    let s = openBlowdown(hit);
    for (let i = 0; i < 30; i++) {
      const r = tick(s, []);
      s = r.state;
      expect(r.telemetry.find((t) => t.sensorId === POOL)!.value).toBe(frozen.value);
    }
    expect(Math.abs(poolM(s) - frozen.value)).toBeGreaterThan(0.05);
  });

  it('replaceSensor is accepted for a failed makeup sensor and clears the event as crew', () => {
    const ev = fired('sensorFailure', { loop: 'makeup', mode: 'noise' });
    const hit = applyEffect(settle(), 'sensorFailure', { loop: 'makeup', mode: 'noise' });
    expect(isCleared(hit, ev)).toBeNull();
    const r = cmd(hit, { type: 'dispatchCrew', job: 'replaceSensor' });
    expect(r.events.map((e) => e.type)).toEqual(['accountChange']);
    const done = run(r.state, 46); // 30 min = 45 ticks
    expect(done.crew).toBeNull();
    expect(done.faults.sensors.makeup).toBeUndefined();
    expect(isCleared(done, ev)).toBe('crew');
    const t = tick(done, []);
    expect(t.telemetry.find((x) => x.sensorId === POOL)!.value).toBe(poolM(t.state));
  });

  it('a makeup controller fault clears as player once the loop is put in Manual', () => {
    const ev = fired('controllerFault', { loop: 'makeup', kind: 'stuck' });
    const hit = applyEffect(settle(), 'controllerFault', { loop: 'makeup', kind: 'stuck' });
    expect(hit.loops.makeup.fault).not.toBeNull();
    expect(isCleared(hit, ev)).toBeNull();
    const r = cmd(hit, { type: 'setLoopMode', loop: 'makeup', mode: 'manual' });
    expect(r.events.some((e) => e.type === 'commandRejected')).toBe(false);
    expect(r.state.loops.makeup.mode).toBe('manual');
    expect(isCleared(r.state, ev)).toBe('player');
  });
});
