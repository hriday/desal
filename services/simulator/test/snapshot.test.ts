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
  return JSON.stringify({ format: 'desal-snapshot', version: 2, savedAt: 0, state, ...over });
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
    for (const bad of ['not json{', 'null', wrap(s, { format: 'other' }), wrap(s, { version: 1 }), wrap(s, { version: 3 })]) {
      const r = restore(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
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
