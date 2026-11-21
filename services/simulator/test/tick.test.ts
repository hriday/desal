import { PlantEventSchema, PlantStatusSchema, TELEMETRY_SENSOR_COUNT, TelemetryReadingSchema, type PlantEvent } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { LOOP_RANGES, SHIFT_TICKS, TICK_PLANT_S } from '../src/constants.js';
import { SENSOR_IDS } from '../src/emit.js';
import { startShift } from '../src/shift.js';
import { createInitialState, NOMINAL, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';
import { allFinite } from './helpers.js';

const T0 = Date.UTC(2026, 0, 1);

const running = (mode: 'auto' | 'manual' = 'auto'): PlantState => startShift(createInitialState(1, T0, GAME_ID), mode).state;

function runTicks(s: PlantState, n: number): { state: PlantState; events: PlantEvent[] } {
  const events: PlantEvent[] = [];
  for (let i = 0; i < n; i++) {
    const r = tick(s, []);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

describe('non-running phases', () => {
  it('in handover, ticks emit status only and do not advance the plant', () => {
    const s = createInitialState(1, T0, GAME_ID);
    const r = tick(s, []);
    expect(r.state.tick).toBe(0);
    expect(r.state.plantTime).toBe(T0);
    expect(r.telemetry).toEqual([]);
    expect(r.status.phase).toBe('handover');
    expect(r.state.stages).toEqual(s.stages);
  });

  it('a paused game does not advance', () => {
    const s = runTicks(running(), 5).state;
    const p = tick(s, [env(s, { type: 'pause' })]);
    expect(p.state.phase).toBe('paused');
    expect(p.state.tick).toBe(s.tick);
    expect(p.telemetry).toEqual([]);
    const later = runTicks(p.state, 10).state;
    expect(later.tick).toBe(s.tick);
    expect(later.plantTime).toBe(s.plantTime);
    expect(later.heater).toEqual(s.heater);
    const resumed = tick(later, [env(later, { type: 'resume' })]);
    expect(resumed.state.tick).toBe(s.tick + 1);
    expect(resumed.telemetry.length).toBe(SENSOR_IDS.length);
  });

  it('applies commands in handover and runs the first tick once a shift starts', () => {
    const s = createInitialState(1, T0, GAME_ID);
    const r = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]);
    expect(r.events[0]).toMatchObject({ type: 'shiftStart', shiftId: 1 });
    expect(r.state.phase).toBe('running');
    expect(r.state.tick).toBe(1);
    expect(r.state.plantTime).toBe(T0 + TICK_PLANT_S * 1000);
  });
});

describe('shift lifecycle', () => {
  it('ends at exactly tick 720 with one shiftEnd, then waits for startShift', () => {
    let s = running();
    const ends: { tick: number; event: PlantEvent }[] = [];
    for (let i = 0; i < SHIFT_TICKS; i++) {
      const r = tick(s, []);
      s = r.state;
      for (const e of r.events) if (e.type === 'shiftEnd') ends.push({ tick: s.tick, event: e });
    }
    expect(ends).toHaveLength(1);
    expect(ends[0]!.tick).toBe(720);
    const end = ends[0]!.event;
    expect(PlantEventSchema.parse(end)).toEqual(end);
    if (end.type !== 'shiftEnd') throw new Error('unreachable');
    expect(end.shiftId).toBe(1);
    expect(end.summary.productM3).toBeCloseTo(s.shift!.acc.productM3, 9);
    expect(end.summary.targetM3).toBe(3900);
    expect(end.summary.fuelBudgetUsd).toBe(12000);
    expect(Object.keys(end.summary.damage.pumpWear).sort()).toEqual(['P-101', 'P-102', 'P-103']);
    expect(s.phase).toBe('handover');
    expect(s.shift?.id).toBe(1);

    const idle = runTicks(s, 5);
    expect(idle.state.tick).toBe(720);
    expect(idle.events).toEqual([]);
    const status = tick(idle.state, []).status;
    expect(status.shiftId).toBe(1);
    expect(status.shiftTicksRemaining).toBe(0);

    const next = tick(idle.state, [env(idle.state, { type: 'startShift', mode: 'auto' }, 1)]);
    expect(next.events[0]).toMatchObject({ type: 'shiftStart', shiftId: 2 });
    expect(next.state.phase).toBe('running');
    expect(next.state.shift?.startTick).toBe(720);
    expect(next.state.tick).toBe(721);
  });

  it('counts no production while tripped, and counts the manual trip', () => {
    const s = runTicks(running(), 3).state;
    const t = tick(s, [env(s, { type: 'manualTrip' })]);
    expect(t.state.status).toBe('tripped');
    expect(t.state.shift!.acc.trips).toBe(1);
    expect(t.snapshotDue).toBe(true);
    const product = t.state.shift!.acc.productM3;
    const later = runTicks(t.state, 20).state;
    expect(later.shift!.acc.productM3).toBe(product);
    expect(later.shift!.acc.trips).toBe(1);
  });

  it('turns a manual-mode flame-out during a fuel changeover into exactly one flameOut trip', () => {
    let s = running('manual');
    s = tick(s, [env(s, { type: 'setOutput', loop: 'tbt', value: 70 })]).state;
    const r = tick(s, [env(s, { type: 'selectFuel', fuel: 'backup' })]);
    expect(r.state.status).toBe('tripped');
    expect(r.state.trip?.cause).toBe('flameOut');
    const after = runTicks(r.state, 10);
    expect(after.events.filter((e) => e.type === 'trip')).toEqual([]);
    expect(after.state.shift!.acc.trips).toBe(1);
  });
});

describe('TBT setpoint at its maximum without antiscalant', () => {
  it('speeds stage-1 scaling until it trips on tbtHighHigh, counting the trip', () => {
    let s = runTicks(running(), 5).state;
    const rate0 = tick(s, []).state.stages[0]!.softScaleMm - s.stages[0]!.softScaleMm;
    s = tick(s, [
      env(s, { type: 'setSetpoint', loop: 'tbt', value: LOOP_RANGES.tbt.spMax }),
      env(s, { type: 'setDose', chemical: 'antiscalant', mgL: 0 }),
    ]).state;
    let maxRate = 0;
    let trip: { events: PlantEvent[]; state: PlantState; snapshotDue: boolean } | null = null;
    for (let i = 0; i < 400 && !trip; i++) {
      const prev = s.stages[0]!.softScaleMm;
      const r = tick(s, []);
      if (r.events.some((e) => e.type === 'trip')) trip = r;
      else maxRate = Math.max(maxRate, r.state.stages[0]!.softScaleMm - prev);
      s = r.state;
    }
    // Whichever comes first: the scaling rate visibly rises before any trip ...
    expect(maxRate).toBeGreaterThan(3 * rate0);
    // ... and if the plant trips, it is on TBT high-high and counted against the shift.
    if (trip) {
      expect(trip.events.find((e) => e.type === 'trip')).toMatchObject({ cause: 'tbtHighHigh' });
      expect(trip.state.shift!.acc.trips).toBe(1);
      expect(trip.snapshotDue).toBe(true);
    }
  });
});

describe('lowering the TBT setpoint in Auto (ruling R12a)', () => {
  // A vacuum loss tells the player to cut TBT; doing so in Auto must not trip the plant. The deepest
  // cut is to the bottom of the setpoint range (a 10 C cut from 93.5 would leave the 85-112 C range).
  for (const value of [NOMINAL.tbtC - 5, LOOP_RANGES.tbt.spMin]) {
    it(`a cut from ${NOMINAL.tbtC} to ${value} C at nominal does not trip within 60 ticks, and TBT follows it down`, () => {
      const s0 = running();
      const s = { ...s0, chaos: { ...s0.chaos, active: null } };
      const drop = NOMINAL.tbtC - value;
      const cut = tick(s, [env(s, { type: 'setSetpoint', loop: 'tbt', value })]);
      expect(cut.state.loops.tbt.setpoint).toBe(value);
      const r = runTicks(cut.state, 60);
      expect([...cut.events, ...r.events].filter((e) => e.type === 'trip')).toEqual([]);
      expect(r.state.status).toBe('online');
      expect(r.state.heater.tbtC).toBeLessThan(NOMINAL.tbtC - drop / 2);
    });
  }
});

describe('record stamps', () => {
  /** Every record of one tick() call: events, telemetry and status. */
  const stamps = (r: ReturnType<typeof tick>) => [...r.events, ...r.telemetry, r.status].map((x) => [x.tick, x.plantTime]);

  it('in a running tick that trips, every event, reading and status carry the post-tick tick and plantTime', () => {
    const s = runTicks(running(), 3).state;
    const r = tick(s, [env(s, { type: 'manualTrip' }), env(s, { type: 'setDose', chemical: 'chlorine', mgL: 99 })]);
    expect(r.events.some((e) => e.type === 'trip')).toBe(true);
    expect(r.events.some((e) => e.type === 'damage')).toBe(true);
    expect(r.events.some((e) => e.type === 'commandRejected')).toBe(true);
    expect(r.telemetry.length).toBeGreaterThan(0);
    expect(new Set(stamps(r).map((x) => x.join()))).toEqual(new Set([`${s.tick + 1},${s.plantTime + TICK_PLANT_S * 1000}`]));
  });

  it('a tick that trips on an interlock stamps the trip like its telemetry', () => {
    let s = running('manual');
    s = tick(s, [env(s, { type: 'setOutput', loop: 'tbt', value: 70 })]).state;
    const r = tick(s, [env(s, { type: 'selectFuel', fuel: 'backup' })]);
    expect(r.events.some((e) => e.type === 'trip')).toBe(true);
    expect(new Set(stamps(r).map((x) => x.join()))).toEqual(new Set([`${r.state.tick},${r.state.plantTime}`]));
  });

  it('shiftStart is stamped like the first tick of the shift it starts', () => {
    const s = createInitialState(1, T0, GAME_ID);
    const r = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]);
    expect(r.events[0]).toMatchObject({ type: 'shiftStart', tick: 1, plantTime: T0 + TICK_PLANT_S * 1000 });
    expect(new Set(stamps(r).map((x) => x.join()))).toEqual(new Set([`1,${T0 + TICK_PLANT_S * 1000}`]));
  });

  it('outside a running shift every record carries the unchanged tick', () => {
    const s = runTicks(running(), 3).state;
    const paused = tick(s, [env(s, { type: 'pause' })]).state;
    const r = tick(paused, [env(paused, { type: 'manualTrip' }), env(paused, { type: 'setDose', chemical: 'chlorine', mgL: 99 })]);
    expect(r.events.map((e) => e.type)).toContain('commandRejected');
    expect(new Set(stamps(r).map((x) => x.join()))).toEqual(new Set([`${paused.tick},${paused.plantTime}`]));
  });
});

describe('emission', () => {
  it('flags snapshotDue on ticks 30 and 60', () => {
    let s = running();
    const due: number[] = [];
    for (let i = 0; i < 61; i++) {
      const r = tick(s, []);
      s = r.state;
      if (r.snapshotDue) due.push(s.tick);
    }
    expect(due).toEqual([30, 60]);
  });

  it('flags snapshotDue outside a running shift when a command was accepted, or any event was emitted', () => {
    const handover = createInitialState(1, T0, GAME_ID);
    expect(tick(handover, []).snapshotDue).toBe(false);
    // A rejection leaves the state as it was, but its event advanced seq: saved, so seq never rewinds.
    expect(tick(handover, [env(handover, { type: 'setDose', chemical: 'chlorine', mgL: 3 })]).snapshotDue).toBe(true);
    expect(tick(handover, [env(handover, { type: 'startShift', mode: 'auto' })]).snapshotDue).toBe(true);

    const paused = tick(running(), [env(running(), { type: 'pause' })]).state;
    expect(paused.phase).toBe('paused');
    expect(tick(paused, []).snapshotDue).toBe(false);
    expect(tick(paused, [env(paused, { type: 'setDose', chemical: 'chlorine', mgL: 3 })]).snapshotDue).toBe(true);
  });

  it('flags snapshotDue when a running game is paused', () => {
    const s = runTicks(running(), 3).state;
    const paused = tick(s, [env(s, { type: 'pause' })]);
    expect(paused.state.phase).toBe('paused');
    expect(paused.events).toEqual([]);
    expect(paused.snapshotDue).toBe(true);
    expect(tick(paused.state, []).snapshotDue).toBe(false);
  });

  it('flags snapshotDue on any running tick that emits an event (seq must not rewind after a crash)', () => {
    const s = runTicks(running(), 3).state; // tick 3: no periodic snapshot due
    const quiet = tick(s, []);
    expect(quiet.events).toEqual([]);
    expect(quiet.snapshotDue).toBe(false);
    const rejected = tick(s, [env(s, { type: 'setOutput', loop: 'tbt', value: 50 })]); // Auto mode: rejected
    expect(rejected.events.map((e) => e.type)).toEqual(['commandRejected']);
    expect(rejected.snapshotDue).toBe(true);
  });

  it('stamps the run epoch on every event, reading and status', () => {
    const s0 = { ...running(), run: { ...running().run, epoch: 4 } };
    const r = tick(s0, [env(s0, { type: 'setOutput', loop: 'tbt', value: 50 })]);
    expect(r.events.length).toBeGreaterThan(0);
    for (const e of r.events) expect(e.epoch).toBe(4);
    expect(r.telemetry.every((t) => t.epoch === 4)).toBe(true);
    expect(r.status.epoch).toBe(4);
  });

  it('emits TELEMETRY_SENSOR_COUNT readings per tick (the gateway assembles frames of that size)', () => {
    expect(SENSOR_IDS.length).toBe(TELEMETRY_SENSOR_COUNT);
    expect(TELEMETRY_SENSOR_COUNT).toBe(132);
    expect(SENSOR_IDS[SENSOR_IDS.indexOf('vacuum.quality') + 1]).toBe('vacuum.motiveSteamBar');
    const m = SENSOR_IDS.indexOf('vacuum.motiveSteamBar');
    expect(SENSOR_IDS.slice(m + 1, m + 5)).toEqual([
      'vacuum.lastStageMbar',
      'vacuum.intercondenserMbar',
      'vacuum.coolingOutC',
      'vacuum.ventAirKgH',
    ]);
    expect(SENSOR_IDS).toContain('stages.s24.levelM');
    expect(SENSOR_IDS).not.toContain('stages.s25.levelM');
    expect(SENSOR_IDS).toContain('brine.makeupM3h');
    expect(SENSOR_IDS).toContain('brine.coolingRejectM3h');
  });

  it('reports each loop\'s controller fault in the status (null when healthy), so the UI alarm clears with it', () => {
    const s0 = running();
    const healthy = tick(s0, []).status;
    expect(healthy.loops.vacuum!.fault).toBeNull();
    expect(healthy.loops.level3!.fault).toBeNull();
    const faulty: PlantState = {
      ...s0,
      loops: {
        ...s0.loops,
        vacuum: { ...s0.loops.vacuum, fault: { kind: 'stuck', bias: 0 } },
        levels: s0.loops.levels.map((l, i) => (i === 2 ? { ...l, fault: { kind: 'drift', bias: 0 } } : l)),
      },
    };
    const st = tick(faulty, []).status;
    expect(PlantStatusSchema.safeParse(st).success).toBe(true);
    expect(st.loops.vacuum!.fault).toBe('stuck');
    expect(st.loops.level3!.fault).toBe('drift');
    expect(st.loops.tbt!.fault).toBeNull();
  });

  it('emits every SENSOR_IDS entry exactly once per tick, as valid readings', () => {
    let s = running();
    expect(new Set(SENSOR_IDS).size).toBe(SENSOR_IDS.length);
    expect(SENSOR_IDS).toContain('stages.s02.levelM');
    expect(SENSOR_IDS).toContain('intake.P-101.wear');
    for (let i = 0; i < 3; i++) {
      const r = tick(s, []);
      s = r.state;
      expect(r.telemetry.map((t) => t.sensorId).sort()).toEqual([...SENSOR_IDS].sort());
      for (const t of r.telemetry) {
        expect(TelemetryReadingSchema.parse(t)).toEqual(t);
        expect(t.tick).toBe(s.tick);
        expect(t.shiftId).toBe(1);
      }
    }
  });

  it('derives per-pump flow as each running pump’s share of the intake flow', () => {
    const r = tick(running(), []);
    const v = (id: string) => r.telemetry.find((t) => t.sensorId === id)!.value;
    expect(v('intake.P-101.flowM3h') + v('intake.P-102.flowM3h')).toBeCloseTo(r.state.intake.flowM3h, 6);
    expect(v('intake.P-103.flowM3h')).toBe(0);
  });

  it('produces a status that matches PlantStatusSchema', () => {
    const r = tick(running(), []);
    expect(PlantStatusSchema.parse(r.status)).toEqual(r.status);
    expect(r.status.divertMode).toBe('auto');
    expect(r.status.standbySteam).toBe(false);
    expect(Object.keys(r.status.loops)).toHaveLength(29); // five plant loops, makeup and level1..level23
    expect(r.status.shiftTicksRemaining).toBe(SHIFT_TICKS - 1);
    expect(allFinite(r.status)).toBe(true);
  });

  it('reports doses, backup/gas prices, live shift target and changeover progress in status', () => {
    const st = running();
    st.fuel.changeover = { to: 'backup', remainingTicks: 7 };
    st.shift!.target = { productM3: 123, maxSalinityPpm: 45, fuelBudgetUsd: 6789 };
    const r = tick(st, []);
    const f = r.status.fuel;
    expect(f.backupPriceUsdPerGJ).toBe(r.state.fuel.backup.priceUsdPerGJ);
    expect(f.gasPriceUsdPerGJ).toBe(r.state.fuel.gas.priceUsdPerGJ);
    expect(f.gasCapMW).toBe(r.state.fuel.gas.capMW);
    expect(f.changeoverTo).toBe('backup');
    expect(f.changeoverRemainingTicks).toBe(r.state.fuel.changeover!.remainingTicks);
    expect(r.status.doses).toEqual({ chlorineMgL: r.state.pretreat.chlorineMgL, antiscalantMgL: r.state.pretreat.antiscalantMgL });
    expect(r.status.shiftTarget).toEqual({ productM3: 123, maxSalinityPpm: 45, fuelBudgetUsd: 6789 });
    expect(PlantStatusSchema.parse(r.status)).toEqual(r.status);
  });
});
