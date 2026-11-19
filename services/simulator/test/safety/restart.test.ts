import type { PlantEvent, RestartStep } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { applyTrip } from '../../src/safety/interlocks.js';
import { beginAcidClean, beginRestart, restartStep, stepAcidClean, stepRestart, type Result } from '../../src/safety/restart.js';
import { createInitialState, type PlantState } from '../../src/state.js';
import { allFinite } from '../helpers.js';
import { runUntil } from './harness.js';

function ok(r: Result): { state: PlantState; events: PlantEvent[] } {
  if ('rejected' in r) throw new Error(`unexpected rejection: ${r.rejected}`);
  return r;
}

function rejected(r: Result): string {
  if (!('rejected' in r)) throw new Error('expected a rejection');
  return r.rejected;
}

/** Nominal plant tripped, then left to cool for `coolTicks`. */
function tripped(mode: 'auto' | 'manual' = 'auto', coolTicks = 20): PlantState {
  const s0 = createInitialState(1, 0);
  const s = applyTrip({ ...s0, controlMode: mode }, 'manual').state;
  return runUntil(s, coolTicks).state;
}

/** Deep copy for unchanged-state checks (PlantState is plain JSON data). */
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const isOnline = (s: PlantState): boolean => s.status === 'online';
const progressSteps = (events: PlantEvent[]): RestartStep[] =>
  events.flatMap((e) => (e.type === 'restartProgress' && e.ok ? [e.step] : []));

/** Put a manual restart at the ramp step with a known previous TBT. */
function manualRamp(prevTbtC: number, tbtC: number): PlantState {
  const s = tripped('manual', 0);
  return {
    ...s,
    status: 'restarting',
    restart: { step: 'ramp', stepStartedTick: s.tick, auto: false, prevTbtC },
    heater: { ...s.heater, tbtC },
    loops: { ...s.loops, tbt: { ...s.loops.tbt, mode: 'manual', output: 60 } },
  };
}

describe('beginRestart (Auto)', () => {
  it('brings a tripped nominal plant online within 120 ticks, reporting each step in order', () => {
    const s = tripped('auto');
    expect(s.heater.tbtC).toBeLessThan(100); // it really cooled
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
    expect(allFinite(run.state)).toBe(true);
  });

  it('is rejected unless tripped', () => {
    expect(rejected(beginRestart(createInitialState(1, 0)))).toMatch(/tripped/);
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

  it('lets the operator walk the sequence and ramp the burner to online', () => {
    let s = tripped('manual');
    const events: PlantEvent[] = [];
    for (const step of ['vacuum', 'recirc', 'ignition'] as const) {
      const r = ok(restartStep(s, step));
      s = r.state;
      events.push(...r.events);
    }
    s = runUntil(s, 1).state; // light the burner
    const r = ok(restartStep(s, 'ramp'));
    events.push(...r.events);
    // Operator opens the burner to full firing.
    s = { ...r.state, loops: { ...r.state.loops, tbt: { ...r.state.loops.tbt, mode: 'manual', output: 100 } } };
    const run = runUntil(s, 200, isOnline);
    events.push(...run.events);
    expect(run.state.status).toBe('online');
    expect(progressSteps(events)).toEqual(['vacuum', 'recirc', 'ignition', 'ramp']);
    expect(events.some((e) => e.type === 'online')).toBe(true);
  });

  it('re-trips with flameOut on a ramp faster than 4 C per plant minute', () => {
    // 3 C in one 40 s tick = 4.5 C/min.
    const { state, events } = stepRestart(manualRamp(100, 103));
    expect(state.status).toBe('tripped');
    expect(state.trip?.cause).toBe('flameOut');
    expect(state.loops.tbt.output).toBe(0);
    expect(events.some((e) => e.type === 'trip' && e.cause === 'flameOut')).toBe(true);
  });

  it('wears the burner and scales the hot stages on a ramp between 2 and 4 C per plant minute', () => {
    // 2 C in one 40 s tick = 3 C/min.
    const s = manualRamp(100, 102);
    const { state, events } = stepRestart(s);
    expect(state.status).toBe('restarting');
    expect(state.heater.burnerCondition).toBeLessThan(s.heater.burnerCondition);
    expect(state.stages[0]!.hardScaleMm).toBeGreaterThan(s.stages[0]!.hardScaleMm);
    expect(state.stages[10]!.hardScaleMm).toBe(s.stages[10]!.hardScaleMm);
    expect(events.filter((e) => e.type === 'damage').map((e) => e.type === 'damage' && e.component)).toEqual([
      'burner',
      'stageScale',
    ]);
  });

  it('takes no penalty on a gentle ramp', () => {
    const s = manualRamp(100, 101); // 1.5 C/min
    const { state, events } = stepRestart(s);
    expect(state.heater.burnerCondition).toBe(s.heater.burnerCondition);
    expect(events).toEqual([]);
  });
});

describe('acid clean', () => {
  it('is rejected while online', () => {
    expect(rejected(beginAcidClean(createInitialState(1, 0)))).toMatch(/tripped/);
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
