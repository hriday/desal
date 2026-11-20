import { describe, expect, it } from 'vitest';
import { startShift } from '../src/shift.js';
import { restore, serialize } from '../src/snapshot.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { GAME_ID } from './envelope.js';

const T0 = Date.UTC(2026, 0, 1);

function run(s: PlantState, n: number) {
  const telemetry: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const r = tick(s, []);
    s = r.state;
    telemetry.push(r.telemetry);
  }
  return { state: s, telemetry };
}

function midShift2(): PlantState {
  const s0 = { ...createInitialState(7, T0, GAME_ID), run: { ...createInitialState(7, T0, GAME_ID).run, shiftNumber: 1 } };
  return run(startShift(s0, 'auto').state, 300).state;
}

const clone = (): any => JSON.parse(JSON.stringify(createInitialState(1, T0, GAME_ID)));

function wrap(state: unknown, over: Record<string, unknown> = {}): string {
  return JSON.stringify({ format: 'desal-snapshot', version: 4, savedAt: 0, state, ...over });
}

describe('snapshots', () => {
  it('round-trips mid-shift 2 and continues identically', () => {
    const s = midShift2();
    expect(s.shift?.id).toBe(2);
    const r = restore(serialize(s));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state).toEqual(s);
    expect(run(r.state, 100).telemetry).toEqual(run(s, 100).telemetry);
  });

  it('a save from before run.epoch existed restores with epoch 0', () => {
    const old = clone();
    delete old.run.epoch;
    const r = restore(wrap(old));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.run.epoch).toBe(0);
  });

  it('rejects garbage, wrong format and unknown version', () => {
    const s = createInitialState(1, T0, GAME_ID);
    for (const bad of ['not json{', 'null', wrap(s, { format: 'other' }), wrap(s, { version: 1 }), wrap(s, { version: 5 })]) {
      const r = restore(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('serializes version 4', () => {
    expect(JSON.parse(serialize(createInitialState(1, T0, GAME_ID))).version).toBe(4);
  });

  it('migrates a version 3 save to Normal with the new fields defaulted', () => {
    const doc = JSON.parse(serialize({ ...midShift2(), run: { ...midShift2().run, mode: 'hard' } }));
    const st = doc.state;
    expect(st.chaos.active.plan.queue.length + st.chaos.active.fired.length).toBeGreaterThan(0);
    delete st.run.mode;
    delete st.chaos.lastHadDisaster;
    delete st.faults.fuelContamination;
    delete st.faults.tsunami;
    for (const p of [st.chaos.pending, st.chaos.active.plan]) for (const e of p?.queue ?? []) delete e.disaster;
    for (const e of st.chaos.active.fired) delete e.disaster;
    doc.version = 3;
    const r = restore(JSON.stringify(doc));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.run.mode).toBe('normal');
    expect(r.state.chaos.lastHadDisaster).toBe(false);
    expect(r.state.faults.fuelContamination).toBeNull();
    expect(r.state.faults.tsunami).toBeNull();
    const events = [...(r.state.chaos.pending?.queue ?? []), ...r.state.chaos.active!.plan.queue, ...r.state.chaos.active!.fired];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.disaster === false)).toBe(true);
  });

  it('rejects a version 2 save with its reason', () => {
    const r = restore(wrap(createInitialState(1, T0, GAME_ID), { version: 2 }));
    expect(r).toEqual({ ok: false, reason: 'unknown version: 2' });
  });

  it('round-trips populated chaos, crew and fault state', () => {
    const s = createInitialState(3, T0, GAME_ID);
    const orders = { targetM3: 100, maxSalinityPpm: 50, budgetUsd: 1000, lines: ['a'], briefing: [] };
    const plan = {
      shiftNumber: 4,
      hell: true,
      warned: false,
      targetM3: 100,
      initial: { seawaterTempC: 31.5, chlorophyllUgL: 1.2, gasCapMW: 30 },
      orders,
      queue: [{ eventId: 2, kind: 'tubeLeak' as const, params: { stage: 3, ppm: 40, note: 'x' }, earliestMinute: 15, cascade: true, disaster: false }],
    };
    const populated: PlantState = {
      ...s,
      chaos: {
        pending: plan,
        active: {
          plan,
          fired: [{ eventId: 1, kind: 'pumpTrip', params: { pumpId: 'P-101' }, atMinute: 5, cleared: true, how: 'crew', disaster: false }],
          lastFiredMinute: 5,
          nextEventId: 3,
        },
        lastWasHell: true,
        lastHadDisaster: false,
      },
      crew: { job: 'replaceSensor', remainingTicks: 12 },
      faults: {
        ...s.faults,
        tubeLeak: { stage: 3, ppm: 40 },
        sensors: { tbt: { kind: 'freeze', value: 107.5 }, vacuum: { kind: 'noise', amplitude: 0.02 } },
      },
    };
    const r = restore(serialize(populated));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state).toEqual(populated);
  });

  it('rejects a null in a numeric field and reports its path', () => {
    const s = clone();
    s.heater.tbtC = null;
    const r = restore(wrap(s));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('state.heater.tbtC');
  });

  it('rejects wrong stage count, missing pump and bad enum', () => {
    const a = clone();
    a.stages.pop();
    expect(restore(wrap(a)).ok).toBe(false);
    const b = clone();
    delete b.intake.pumps['P-103'];
    expect(restore(wrap(b)).ok).toBe(false);
    const c = clone();
    c.phase = 'bogus';
    expect(restore(wrap(c)).ok).toBe(false);
  });

  it('restores a mid-restart save from before the stall clock, starting the clock at the step start', () => {
    const s = clone();
    s.status = 'restarting';
    s.restart = { step: 'ramp', stepStartedTick: 12, auto: true, prevFiringPct: 20 };
    const r = restore(wrap(s));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.restart).toEqual({ ...s.restart, progressTick: 12, bestTbtC: 0 });
  });
});
