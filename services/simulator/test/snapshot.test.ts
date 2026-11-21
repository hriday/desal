import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callSignFor } from '../src/callsign.js';
import { STAGE_COUNT } from '../src/constants.js';
import { startShift } from '../src/shift.js';
import { restore, serialize } from '../src/snapshot.js';
import { BALANCE, createInitialState, NOMINAL, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { GAME_ID } from './envelope.js';

const T0 = Date.UTC(2026, 0, 1);
const RUN_ID = 'dddddddd-dddd-4ddd-8ddd-000000000001';
const FRESH_RUN_ID = 'eeeeeeee-eeee-4eee-8eee-000000000001';

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
  return JSON.stringify({ format: 'desal-snapshot', version: 7, savedAt: 0, state, ...over });
}

/**
 * A live 20-stage save (format version 4), written on the Plan 6 plant: seed 3 played by the engaged
 * bot to mid-shift 2, then given a tube leak on old stage 20 (index 19), a plugged stage 5 (derate 0.6)
 * and a stuck controller fault on level20, which is in Manual.
 */
const fixtureJson = (): string => readFileSync(new URL('./fixtures/snapshot-v4.json', import.meta.url), 'utf8');
const fixture = (): any => JSON.parse(fixtureJson());

/** The v3 shape of a v4 doc: the fields version 4 added are deleted. */
function toV3(doc: any): any {
  const st = doc.state;
  delete st.run.mode;
  delete st.chaos.lastHadDisaster;
  delete st.faults.fuelContamination;
  delete st.faults.tsunami;
  for (const p of [st.chaos.pending, st.chaos.active?.plan]) for (const e of p?.queue ?? []) delete e.disaster;
  for (const e of st.chaos.active?.fired ?? []) delete e.disaster;
  doc.version = 3;
  return doc;
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
    for (const bad of ['not json{', 'null', wrap(s, { format: 'other' }), wrap(s, { version: 1 }), wrap(s, { version: 8 })]) {
      const r = restore(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('serializes version 7', () => {
    expect(JSON.parse(serialize(createInitialState(1, T0, GAME_ID))).version).toBe(7);
  });

  describe('a live v6 save restores as v7 (Manual divert, nominal steam, no low-steam fault)', () => {
    const json = readFileSync(new URL('./fixtures/snapshot-v6.json', import.meta.url), 'utf8');
    const r = restore(json);
    const s = r.ok ? r.state : (null as unknown as PlantState);

    it('restores with the defaults', () => {
      expect(JSON.parse(json).version).toBe(6);
      expect(r.ok).toBe(true);
      expect(s.product.divertMode).toBe('manual');
      expect(s.product.divertToDrain).toBe(true);
      expect(s.steam).toEqual({ motiveBar: 14.5, standby: false, unbilledTicks: 0 });
      expect(s.faults.lowSteam).toBeNull();
    });

    it('keeps running: 90 ticks, no trip, the valve stays on the drain', () => {
      let x = s;
      for (let i = 0; i < 90; i++) {
        const t = tick(x, []);
        expect(t.events.filter((e) => e.type === 'trip')).toEqual([]);
        x = t.state;
        expect(x.product.divertToDrain).toBe(true);
      }
    });

    it('serialize then restore round-trips equal', () => {
      const again = restore(serialize(s));
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.state).toEqual(s);
    });
  });

  it('a v6 round-trip keeps the call sign, runId and mode', () => {
    const s = createInitialState(5, T0, GAME_ID, 'hard', RUN_ID);
    const r = restore(serialize(s), () => FRESH_RUN_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.run).toMatchObject({ callSign: callSignFor(5), runId: RUN_ID, mode: 'hard' });
    expect(r.state).toEqual(s);
  });

  it('a v5 save gets the call sign from its seed and a fresh runId, and keeps its mode and 24 stages', () => {
    const s = midShift2();
    const doc = JSON.parse(serialize({ ...s, run: { ...s.run, mode: 'hard' } }));
    delete doc.state.run.callSign;
    delete doc.state.run.runId;
    doc.version = 5;
    const r = restore(JSON.stringify(doc), () => FRESH_RUN_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.run.callSign).toBe(callSignFor(s.seed));
    expect(r.state.run.runId).toBe(FRESH_RUN_ID);
    expect(r.state.run.mode).toBe('hard');
    expect(r.state.stages).toEqual(s.stages);
    expect(r.state.loops).toEqual(s.loops);
    expect(r.state).toEqual({
      ...s,
      run: { ...s.run, mode: 'hard', callSign: callSignFor(s.seed), runId: FRESH_RUN_ID },
      product: { ...s.product, divertMode: 'manual' }, // a pre-v7 save keeps the behaviour it was played with
    });
  });

  it('a v5 save without an injected id generator gets a random uuid', () => {
    const doc = JSON.parse(serialize(createInitialState(1, T0, GAME_ID)));
    delete doc.state.run.callSign;
    delete doc.state.run.runId;
    doc.version = 5;
    const r = restore(JSON.stringify(doc));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.run.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('rejects a v6 save without a call sign or runId', () => {
    const a = clone();
    delete a.run.callSign;
    expect(restore(wrap(a)).ok).toBe(false);
    const b = clone();
    b.run.runId = 'not-a-uuid';
    expect(restore(wrap(b)).ok).toBe(false);
  });

  describe('a live v4 save restores as 24 stages', () => {
    const old = fixture().state;
    const r = restore(fixtureJson(), () => FRESH_RUN_ID);
    const s = r.ok ? r.state : (null as unknown as PlantState);
    const from = (j: number): number => Math.floor((j * 20) / 24);

    it('restores, with the v7 defaults', () => {
      expect(r.ok).toBe(true);
      expect(s.product.divertMode).toBe('manual');
      expect(s.steam).toEqual({ motiveBar: 14.5, standby: false, unbilledTicks: 0 });
      expect(s.faults.lowSteam).toBeNull();
      expect(old.stages).toHaveLength(20);
      expect(s.stages).toHaveLength(STAGE_COUNT);
    });

    it('migrates on to v7: call sign from the seed, a fresh runId, its mode kept', () => {
      expect(s.run).toMatchObject({ callSign: callSignFor(old.seed), runId: FRESH_RUN_ID, mode: old.run.mode });
    });

    it('resamples the stages and their derates: new stage j copies old stage floor(j*20/24)', () => {
      for (let j = 0; j < STAGE_COUNT; j++) {
        const o = old.stages[from(j)];
        expect(s.stages[j]).toMatchObject({ levelM: o.levelM, softScaleMm: o.softScaleMm, hardScaleMm: o.hardScaleMm });
        expect(s.faults.stageDerate[j]).toBe(old.faults.stageDerate[from(j)]);
      }
      // The plugged old stage 5 (index 4) lands on new index 5 only (floor(5 x 20 / 24) = 4).
      expect(s.faults.stageDerate.flatMap((d, j) => (d === 0.6 ? [j] : []))).toEqual([5]);
    });

    it('moves the tube leak on old stage 20 into the last recovery stage (21)', () => {
      expect(old.faults.tubeLeak.stage).toBe(19);
      expect(s.faults.tubeLeak).toEqual({ stage: 20, ppm: old.faults.tubeLeak.ppm });
    });

    it('keeps the 20 level loops and clones level20 into level21-23', () => {
      expect(s.loops.levels).toHaveLength(23);
      for (let i = 0; i < 20; i++) expect(s.loops.levels[i]).toEqual(old.loops.levels[i]);
      expect(s.loops.levels[19]).toMatchObject({ mode: 'manual', fault: { kind: 'stuck', bias: 0 } });
      for (let i = 20; i < 23; i++) expect(s.loops.levels[i]).toEqual(old.loops.levels[19]);
    });

    it('adds a balanced makeup loop in Auto and holds the save\'s CF as the CF target', () => {
      expect(s.loops.makeup.mode).toBe('auto');
      expect(s.loops.makeup.setpoint).toBe(NOMINAL.levelM);
      expect(s.loops.makeup.output).toBeCloseTo(BALANCE.makeupPct, 10);
      expect(s.loops.makeup.fault).toBeNull();
      expect(s.brine.makeupM3h).toBe(NOMINAL.makeupM3h);
      expect(s.brine.cfTargetHeld).toBe(old.brine.concentrationFactor);
      expect(s.brine.distillateM3h).toBe(NOMINAL.productM3h);
    });

    it('keeps running: 90 ticks and nothing trips', () => {
      expect(s.status).toBe('online');
      let x = s;
      for (let i = 0; i < 90; i++) {
        const t = tick(x, []);
        expect(t.events.filter((e) => e.type === 'trip')).toEqual([]);
        x = t.state;
      }
      expect(x.status).toBe('online');
      expect(x.shift?.id).toBe(2);
    });

    it('re-serializes as a version 7 save that round-trips', () => {
      const again = restore(serialize(s));
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.state).toEqual(s);
    });
  });

  it('migrates a version 3 save through v4, v5 and v6 to v7: Normal, new fields defaulted, 24 stages, a call sign and runId', () => {
    const doc = toV3(fixture());
    const st = doc.state;
    expect(st.chaos.active.plan.queue.length + st.chaos.active.fired.length).toBeGreaterThan(0);
    const r = restore(JSON.stringify(doc), () => FRESH_RUN_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.run.callSign).toBe(callSignFor(st.seed));
    expect(r.state.run.runId).toBe(FRESH_RUN_ID);
    expect(r.state.stages).toHaveLength(STAGE_COUNT);
    expect(r.state.loops.levels).toHaveLength(23);
    expect(r.state.loops.makeup.mode).toBe('auto');
    expect(r.state.run.mode).toBe('normal');
    expect(r.state.product.divertMode).toBe('manual');
    expect(r.state.steam).toEqual({ motiveBar: 14.5, standby: false, unbilledTicks: 0 });
    expect(r.state.faults.lowSteam).toBeNull();
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

  it('rejects a version 4 save whose stages are not 20', () => {
    const doc = fixture();
    doc.state.stages.pop();
    expect(restore(JSON.stringify(doc)).ok).toBe(false);
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

  it('rejects wrong stage count, wrong level-loop count, missing pump and bad enum', () => {
    const a = clone();
    a.stages.pop();
    expect(restore(wrap(a)).ok).toBe(false);
    const l = clone();
    l.loops.levels.push(l.loops.levels[0]);
    expect(restore(wrap(l)).ok).toBe(false);
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
