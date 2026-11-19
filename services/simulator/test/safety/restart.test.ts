import type { RestartStep } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { RESTART_STEP_TIMEOUT_TICKS } from '../../src/constants.js';
import { applyTrip } from '../../src/safety/interlocks.js';
import { beginAcidClean, beginRestart, restartStep, stepAcidClean, stepRestart, type Result } from '../../src/safety/restart.js';
import { createInitialState, NOMINAL, type PlantState, type SimEvent } from '../../src/state.js';
import { allFinite } from '../helpers.js';
import { runUntil, tickOnce } from './harness.js';
import { GAME_ID } from '../envelope.js';

function ok(r: Result): { state: PlantState; events: SimEvent[] } {
  if ('rejected' in r) throw new Error(`unexpected rejection: ${r.rejected}`);
  return r;
}

function rejected(r: Result): string {
  if (!('rejected' in r)) throw new Error('expected a rejection');
  return r.rejected;
}

/** Nominal plant tripped, then left to cool for `coolTicks`. */
function tripped(mode: 'auto' | 'manual' = 'auto', coolTicks = 20): PlantState {
  const s0 = createInitialState(1, 0, GAME_ID);
  const s = applyTrip({ ...s0, controlMode: mode }, 'manual').state;
  return runUntil(s, coolTicks).state;
}

/** Deep copy for unchanged-state checks (PlantState is plain JSON data). */
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const isOnline = (s: PlantState): boolean => s.status === 'online';
const progressSteps = (events: SimEvent[]): RestartStep[] =>
  events.flatMap((e) => (e.type === 'restartProgress' && e.ok ? [e.step] : []));

/** The operator's setOutput on the firing (tbt) loop, which is manual in Manual mode. */
function setFiring(s: PlantState, output: number): PlantState {
  return { ...s, loops: { ...s.loops, tbt: { ...s.loops.tbt, mode: 'manual', output } } };
}

/** A manual restart at the ramp step whose firing was `prevFiringPct` last tick and is `firingPct` now. */
function manualRamp(prevFiringPct: number, firingPct: number): PlantState {
  const s = tripped('manual', 0);
  return setFiring(
    {
      ...s,
      status: 'restarting',
      restart: { step: 'ramp', stepStartedTick: s.tick, auto: false, prevFiringPct, progressTick: s.tick, bestTbtC: NOMINAL.tbtC - 13 },
      heater: { ...s.heater, tbtC: NOMINAL.tbtC - 13 }, // well short of online
    },
    firingPct,
  );
}

/** Walk a tripped Manual plant through vacuum, recirc, ignition (burner lit), and ramp. */
function manualAtRamp(): { state: PlantState; events: SimEvent[] } {
  let s = tripped('manual');
  const events: SimEvent[] = [];
  for (const step of ['vacuum', 'recirc', 'ignition'] as const) {
    const r = ok(restartStep(s, step));
    s = r.state;
    events.push(...r.events);
  }
  const lit = tickOnce(s);
  events.push(...lit.events);
  const r = ok(restartStep(lit.state, 'ramp'));
  events.push(...r.events);
  return { state: r.state, events };
}

const damageEvents = (events: SimEvent[]) => events.filter((e) => e.type === 'damage');

describe('a tripped plant left idle', () => {
  it('cools toward the bottom-stage temperature, never below seawater, over 500 ticks', () => {
    const s0 = applyTrip(createInitialState(1, 0, GAME_ID), 'manual').state;
    let s = s0;
    let minTbt = Infinity;
    for (let i = 0; i < 500; i++) {
      s = tickOnce(s).state;
      minTbt = Math.min(minTbt, s.heater.tbtC);
    }
    expect(s.status).toBe('tripped');
    expect(s.loops.tbt.output).toBe(0);
    expect(minTbt).toBeGreaterThanOrEqual(s.seawater.tempC);
    expect(s.heater.tbtC).toBeLessThan(60); // it did cool well down
    expect(allFinite(s)).toBe(true);
  });
});

describe('beginRestart (Auto)', () => {
  it('brings a tripped nominal plant online within 120 ticks, reporting each step in order', () => {
    const s = tripped('auto');
    expect(s.heater.tbtC).toBeLessThan(NOMINAL.tbtC - 8); // it really cooled
    const start = ok(beginRestart(s));
    expect(start.state.status).toBe('restarting');
    const run = runUntil(start.state, 120, isOnline);
    expect(run.state.status).toBe('online');
    expect(run.ticks).toBeLessThanOrEqual(120);
    const events = [...start.events, ...run.events];
    expect(progressSteps(events)).toEqual(['vacuum', 'recirc', 'ignition', 'ramp']);
    expect(events.filter((e) => e.type === 'online')).toHaveLength(1);
    expect(events.some((e) => e.type === 'trip' || (e.type === 'restartProgress' && !e.ok))).toBe(false);
    expect(run.state.restart).toBeNull();
    expect(run.state.heater.tbtC).toBeGreaterThanOrEqual(run.state.loops.tbt.setpoint - 2);
    expect(damageEvents(run.events)).toEqual([]); // the auto ramp stays below the warning rate
    expect(allFinite(run.state)).toBe(true);

    // The TBT PID takes over and holds the plant online; levels stay in band throughout.
    const after = runUntil(run.state, 300);
    expect(after.events.some((e) => e.type === 'trip')).toBe(false);
    expect(after.state.status).toBe('online');
    expect(Math.abs(after.state.heater.tbtC - after.state.loops.tbt.setpoint)).toBeLessThan(2);
  });

  it('level loops keep every stage in band when the restart pushes recirc back to balance', () => {
    // Tripped while recirc was held in manual at 65 % (~3250 m3/h): the recirc step's jump back to
    // balance disturbs every level, and the (reverse-acting) level loops must hold them.
    let s = tripped('auto');
    s = {
      ...s,
      loops: { ...s.loops, recirc: { ...s.loops.recirc, mode: 'manual', output: 65 } },
      brine: { ...s.brine, recircM3h: 3250 },
    };
    s = runUntil(s, 30).state;
    s = ok(beginRestart(s)).state;
    let maxLevel = 0;
    let minLevel = Infinity;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 500; i++) {
      s = tickOnce(s).state;
      for (const st of s.stages) {
        maxLevel = Math.max(maxLevel, st.levelM);
        minLevel = Math.min(minLevel, st.levelM);
        sum += st.levelM;
        n++;
      }
    }
    expect(s.status).toBe('online');
    expect(maxLevel).toBeGreaterThan(0.35); // the recirc jump really did disturb the levels
    expect(maxLevel).toBeLessThan(0.6); // no carryover, far from the 0.8 m flood trip
    expect(minLevel).toBeGreaterThan(0.05);
    // Centred on the 0.3 m setpoint, and settled there by the end.
    expect(Math.abs(sum / n - 0.3)).toBeLessThan(0.05);
    for (const st of s.stages) expect(Math.abs(st.levelM - 0.3)).toBeLessThan(0.01);
  });

  it('is rejected unless tripped', () => {
    expect(rejected(beginRestart(createInitialState(1, 0, GAME_ID)))).toMatch(/tripped/);
    const cleaning = ok(beginAcidClean(tripped())).state;
    expect(rejected(beginRestart(cleaning))).toMatch(/acid/);
  });
});

describe('restartStep (Manual)', () => {
  it('rejects ignition before recirc and leaves state unchanged', () => {
    const s = tripped('manual');
    const before = clone(s);
    expect(rejected(restartStep(s, 'ignition'))).toBe('step ignition requires recirc');
    expect(s).toEqual(before);

    const afterVacuum = ok(restartStep(s, 'vacuum')).state;
    expect(afterVacuum.status).toBe('restarting');
    const snap = clone(afterVacuum);
    expect(rejected(restartStep(afterVacuum, 'ignition'))).toBe('step ignition requires recirc');
    expect(afterVacuum).toEqual(snap);
  });

  it('rejects a step whose precondition is not met', () => {
    const s = ok(restartStep(tripped('manual'), 'vacuum')).state;
    const poorVacuum = { ...s, vacuum: { quality: 0.7 } };
    expect(rejected(restartStep(poorVacuum, 'recirc'))).toBe('step recirc requires vacuum ≥ 0.85');
  });

  it('lets the operator walk the sequence and raise firing gently to online without damage', () => {
    const at = manualAtRamp();
    const events = [...at.events];
    let s = at.state;
    for (let i = 0; i < 200 && s.status === 'restarting'; i++) {
      s = setFiring(s, Math.min(100, s.loops.tbt.output + 8)); // 8 %/tick: under the 10 % warning
      const r = tickOnce(s);
      s = r.state;
      events.push(...r.events);
    }
    expect(s.status).toBe('online');
    expect(progressSteps(events)).toEqual(['vacuum', 'recirc', 'ignition', 'ramp']);
    expect(events.some((e) => e.type === 'online')).toBe(true);
    expect(damageEvents(events)).toEqual([]);
  });

  it('re-trips with flameOut when the operator slams the burner open', () => {
    const at = manualAtRamp();
    const r = tickOnce(setFiring(at.state, 100)); // 15 -> 100 % in one tick
    expect(r.state.status).toBe('tripped');
    expect(r.state.trip?.cause).toBe('flameOut');
    expect(r.state.loops.tbt.output).toBe(0);
    expect(r.events.some((e) => e.type === 'trip' && e.cause === 'flameOut')).toBe(true);
  });

  it('re-trips on a firing rise above 25 %/tick', () => {
    expect(stepRestart(manualRamp(40, 66)).state.trip?.cause).toBe('flameOut');
    expect(stepRestart(manualRamp(40, 65)).state.status).toBe('restarting');
  });

  it('wears the burner and scales the hot stages on a firing rise above 10 %/tick', () => {
    const s = manualRamp(40, 55);
    const { state, events } = stepRestart(s);
    expect(state.status).toBe('restarting');
    expect(state.heater.burnerCondition).toBeLessThan(s.heater.burnerCondition);
    expect(state.stages[0]!.hardScaleMm).toBeGreaterThan(s.stages[0]!.hardScaleMm);
    expect(state.stages[10]!.hardScaleMm).toBe(s.stages[10]!.hardScaleMm);
    expect(damageEvents(events).map((e) => e.type === 'damage' && e.component)).toEqual(['burner', 'stageScale']);
  });

  it('takes no penalty at or below 10 %/tick', () => {
    const s = manualRamp(40, 50);
    const { state, events } = stepRestart(s);
    expect(state.heater.burnerCondition).toBe(s.heater.burnerCondition);
    expect(events).toEqual([]);
    expect(state.restart?.prevFiringPct).toBe(50);
  });

  it('catches a firing jump issued together with the ramp command', () => {
    let s = tripped('manual');
    for (const step of ['vacuum', 'recirc', 'ignition'] as const) s = ok(restartStep(s, step)).state;
    s = tickOnce(s).state;
    s = ok(restartStep(setFiring(s, 50), 'ramp')).state; // +35 % then ramp, same tick
    expect(stepRestart(s).state.trip?.cause).toBe('flameOut');
  });
});

describe('Auto restart: stall timeout and manual takeover', () => {
  /** An Auto restart run until it reaches the ramp step. */
  function autoAtRamp(s0: PlantState = tripped('auto')): PlantState {
    const run = runUntil(ok(beginRestart(s0)).state, 120, (s) => s.restart?.step === 'ramp');
    expect(run.state.restart?.step).toBe('ramp');
    return run.state;
  }

  it('a stuck TBT controller stalls the ramp; it gives up with ok:false within the timeout and drops to tripped without damage', () => {
    const s0 = tripped('auto');
    const stuck: PlantState = { ...s0, loops: { ...s0.loops, tbt: { ...s0.loops.tbt, fault: { kind: 'stuck', bias: 0 } } } };
    const start = ok(beginRestart(stuck));
    const run = runUntil(start.state, 4 * RESTART_STEP_TIMEOUT_TICKS, (s) => s.status !== 'restarting');
    const failed = run.events.find((e) => e.type === 'restartProgress' && !e.ok);
    expect(failed).toMatchObject({ type: 'restartProgress', step: 'ramp', ok: false });
    expect(failed && 'reason' in failed && failed.reason).toMatch(/timed out/);
    expect(run.state.status).toBe('tripped');
    expect(run.state.restart).toBeNull();
    expect(run.state.loops.tbt.output).toBe(0);
    // Gave up within one step timeout of entering the ramp.
    const rampAt = run.events.find((e) => e.type === 'restartProgress' && e.ok && e.step === 'ramp')!;
    expect(failed!.tick - rampAt.tick).toBeLessThanOrEqual(RESTART_STEP_TIMEOUT_TICKS);
    // No trip and no trip damage (applyTrip never ran: the original trip record is untouched),
    // so the operator can fix the cause and retry.
    expect(run.events.some((e) => e.type === 'trip' || e.type === 'damage')).toBe(false);
    expect(run.state.trip).toEqual(stuck.trip);
    expect('rejected' in beginRestart(run.state)).toBe(false);
  });

  it('times out a step whose precondition never comes (vacuum never pulls)', () => {
    const t = tripped('auto');
    let s = ok(beginRestart({ ...t, vacuum: { quality: 0.4 } })).state;
    const events: SimEvent[] = [];
    for (let i = 0; i <= RESTART_STEP_TIMEOUT_TICKS && s.status === 'restarting'; i++) {
      // Something keeps the ejector closed (e.g. a field fault the operator has to find).
      s = { ...s, loops: { ...s.loops, vacuum: { ...s.loops.vacuum, output: 0 } } };
      const r = tickOnce(s);
      s = r.state;
      events.push(...r.events);
    }
    expect(events.find((e) => e.type === 'restartProgress' && !e.ok)).toMatchObject({ step: 'vacuum', ok: false });
    expect(s.status).toBe('tripped');
  });

  it('does not time out a healthy cold ramp that keeps gaining TBT (it takes ~300 ticks)', () => {
    const cold = tripped('auto', 500);
    expect(cold.heater.tbtC).toBeLessThan(40);
    const run = runUntil(ok(beginRestart(cold)).state, 600, isOnline);
    expect(run.state.status).toBe('online');
    expect(run.ticks).toBeGreaterThan(3 * RESTART_STEP_TIMEOUT_TICKS);
    expect(run.events.some((e) => e.type === 'restartProgress' && !e.ok)).toBe(false);
  });

  it('switching tbt to manual during the Auto ramp lets the operator firing through, policed by the ramp limits', () => {
    const at = autoAtRamp();
    const prev = at.restart!.prevFiringPct;
    // A gentle manual rise (8 %/tick) differs from what the PID-capped Auto ramp would give.
    const gentle = stepRestart(setFiring(at, prev + 8));
    expect(gentle.state.status).toBe('restarting');
    expect(gentle.state.loops.tbt.output).toBe(prev + 8);
    expect(gentle.state.loops.tbt.mode).toBe('manual');
    expect(damageEvents(gentle.events)).toEqual([]);

    // Over the warning rate: penalised like a Manual-mode ramp.
    const fast = stepRestart(setFiring(at, prev + 15));
    expect(fast.state.loops.tbt.output).toBe(prev + 15);
    expect(damageEvents(fast.events).length).toBeGreaterThan(0);

    // Over the trip rate: flames out.
    expect(stepRestart(setFiring(at, prev + 30)).state.trip?.cause).toBe('flameOut');
  });
});

describe('control-mode gating', () => {
  it('rejects the one-button restart in Manual mode', () => {
    const s = tripped('manual');
    expect(rejected(beginRestart(s))).toBe('one-button restart is Auto-mode only');
  });

  it('rejects manual restart steps in Auto mode', () => {
    const s = tripped('auto');
    expect(rejected(restartStep(s, 'vacuum'))).toBe('manual restart steps are Manual-mode only');
  });
});

describe('burner lock-out before ignition', () => {
  /** Run `ticks` with the operator holding firing at 100 %; returns heatMW and TBT per tick. */
  function holdFiring(s0: PlantState, ticks: number): { s: PlantState; heat: number[]; tbt: number[] } {
    let s = s0;
    const heat: number[] = [];
    const tbt: number[] = [s.heater.tbtC];
    for (let i = 0; i < ticks; i++) {
      s = tickOnce(setFiring(s, 100)).state;
      heat.push(s.heater.heatMW);
      tbt.push(s.heater.tbtC);
    }
    return { s, heat, tbt };
  }
  const nonRising = (xs: number[]): boolean => xs.every((x, i) => i === 0 || x <= xs[i - 1]! + 1e-9);

  it('does not heat a tripped plant whose firing output is at 100 %', () => {
    const { s, heat, tbt } = holdFiring(tripped('manual', 0), 50);
    expect(s.status).toBe('tripped');
    expect(heat.every((h) => h === 0)).toBe(true);
    expect(nonRising(tbt)).toBe(true);
  });

  it('does not heat during the vacuum step, and holds firing at 0', () => {
    const start = ok(restartStep(tripped('manual', 0), 'vacuum')).state;
    const { s, heat, tbt } = holdFiring(start, 50);
    expect(s.status).toBe('restarting');
    expect(s.restart?.step).toBe('vacuum');
    expect(s.loops.tbt.output).toBe(0);
    expect(heat.every((h) => h === 0)).toBe(true);
    expect(nonRising(tbt)).toBe(true);
  });
});

describe('restart from a loss-of-vacuum trip', () => {
  it('comes back online without re-tripping while vacuum is pulled down', () => {
    const s0 = createInitialState(1, 0, GAME_ID);
    const poor: PlantState = {
      ...s0,
      vacuum: { quality: 0.4 },
      loops: { ...s0.loops, vacuum: { ...s0.loops.vacuum, output: 10 } },
    };
    const trip = applyTrip(poor, 'lossOfVacuum').state;
    expect(trip.heater.heatMW).toBe(0);
    const start = ok(beginRestart(trip));
    const run = runUntil(start.state, 200, isOnline);
    expect(run.events.some((e) => e.type === 'trip')).toBe(false);
    expect(run.state.status).toBe('online');
    expect(progressSteps([...start.events, ...run.events])).toEqual(['vacuum', 'recirc', 'ignition', 'ramp']);
  });
});

describe('acid clean', () => {
  it('is rejected while online', () => {
    expect(rejected(beginAcidClean(createInitialState(1, 0, GAME_ID)))).toMatch(/tripped/);
  });

  it('zeroes hard scale after 180 ticks and leaves the plant tripped', () => {
    const s = tripped();
    expect(s.stages[0]!.hardScaleMm).toBeGreaterThan(0);
    const cleaning = ok(beginAcidClean(s)).state;
    expect(cleaning.status).toBe('acidCleaning');
    expect(cleaning.acidCleanRemainingTicks).toBe(180);

    let cur = cleaning;
    for (let i = 0; i < 179; i++) cur = stepAcidClean(cur);
    expect(cur.status).toBe('acidCleaning');
    expect(cur.stages[0]!.hardScaleMm).toBeGreaterThan(0);

    cur = stepAcidClean(cur);
    expect(cur.status).toBe('tripped');
    expect(cur.acidCleanRemainingTicks).toBe(0);
    expect(cur.stages.every((st) => st.hardScaleMm === 0)).toBe(true);
  });
});
