import type { Command } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { CREW_JOBS, TICK_PLANT_S, TUBE_PLUG_DERATE } from '../src/constants.js';
import { applyCommand, DELIVERY_TICKS } from '../src/commands.js';
import { applyEffect } from '../src/scenario/effects.js';
import { tick } from '../src/tick.js';
import { startShift } from '../src/shift.js';
import { createInitialState, type PlantState, type SimEvent } from '../src/state.js';
import { allFinite } from './helpers.js';
import { GAME_ID } from './envelope.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const env = (command: Command | Record<string, unknown>, shiftId: number | null = 1) => ({
  commandId: ID,
  issuedAt: 0,
  gameId: GAME_ID,
  shiftId,
  command,
});

const running = (mode: 'auto' | 'manual' = 'auto'): PlantState => startShift(createInitialState(1, 0, GAME_ID), mode).state;
const rejection = (events: SimEvent[]): string => {
  expect(events).toHaveLength(1);
  const e = events[0]!;
  if (e.type !== 'commandRejected') throw new Error(`expected commandRejected, got ${e.type}`);
  expect(e.commandId).toBe(ID);
  return e.reason;
};

describe('applyCommand rejections never throw or change state', () => {
  const s = running();
  const bad: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['string', 'nope'],
    ['empty object', {}],
    ['unknown type', env({ type: 'selfDestruct' })],
    ['NaN value', env({ type: 'setSetpoint', loop: 'tbt', value: NaN })],
    ['Infinity value', env({ type: 'setOutput', loop: 'tbt', value: Infinity })],
    ['bad loop id', env({ type: 'setSetpoint', loop: 'level24', value: 0.3 })],
    ['bad uuid', { ...env({ type: 'pause' }), commandId: 'x' }],
  ];
  it.each(bad)('%s', (_n, input) => {
    const r = applyCommand(s, input);
    expect(r.state).toBe(s);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'commandRejected' });
  });
});

describe('applyCommand', () => {
  it('reports unknown commandId when unparseable', () => {
    const r = applyCommand(running(), {});
    const e = r.events[0]!;
    expect(e.type === 'commandRejected' && e.commandId).toBe('unknown');
    expect(e.type === 'commandRejected' && e.reason.startsWith('invalid:')).toBe(true);
  });

  it('echoes at most 64 chars of an invalid commandId, so a huge one cannot make an unproducible event', () => {
    const huge = 'x'.repeat(5_000_000);
    const e = applyCommand(running(), { commandId: huge, command: { type: 'pause' } }).events[0]!;
    expect(e.type === 'commandRejected' && e.commandId).toBe('x'.repeat(64));
  });

  it('rejects a stale shift id', () => {
    const s = running();
    const r = applyCommand(s, env({ type: 'pause' }, 7));
    expect(r.state).toBe(s);
    expect(rejection(r.events)).toBe('stale shift');
  });

  it('rejects TBT setpoint 130, accepts 112', () => {
    const s = running();
    const bad = applyCommand(s, env({ type: 'setSetpoint', loop: 'tbt', value: 130 }));
    expect(bad.state).toBe(s);
    rejection(bad.events);
    const good = applyCommand(s, env({ type: 'setSetpoint', loop: 'tbt', value: 112 }));
    expect(good.events).toEqual([]);
    expect(good.state.loops.tbt.setpoint).toBe(112);
  });

  it('TBT setpoint range is 85-112 C: 84 and 113 are rejected, 85 is accepted', () => {
    const s = running();
    for (const value of [84, 113]) {
      const r = applyCommand(s, env({ type: 'setSetpoint', loop: 'tbt', value }));
      expect(r.state).toBe(s);
      expect(rejection(r.events)).toContain('out of range');
    }
    expect(applyCommand(s, env({ type: 'setSetpoint', loop: 'tbt', value: 85 })).state.loops.tbt.setpoint).toBe(85);
  });

  it('setOutput on tbt: rejected in Auto, accepted in Manual, range-checked', () => {
    const a = running('auto');
    const r = applyCommand(a, env({ type: 'setOutput', loop: 'tbt', value: 50 }));
    expect(r.state).toBe(a);
    rejection(r.events);
    const m = running('manual');
    expect(applyCommand(m, env({ type: 'setOutput', loop: 'tbt', value: 50 })).state.loops.tbt.output).toBe(50);
    const over = applyCommand(m, env({ type: 'setOutput', loop: 'tbt', value: 101 }));
    expect(over.state).toBe(m);
    rejection(over.events);
  });

  it('level setpoints are accepted in Manual; other setpoints are not', () => {
    const m = running('manual');
    const r = applyCommand(m, env({ type: 'setSetpoint', loop: 'level3', value: 0.4 }));
    expect(r.events).toEqual([]);
    expect(r.state.loops.levels[2]!.setpoint).toBe(0.4);
    const t = applyCommand(m, env({ type: 'setSetpoint', loop: 'tbt', value: 110 }));
    expect(t.state).toBe(m);
    rejection(t.events);
  });

  it('rejects any non-start command during handover', () => {
    const h = createInitialState(1, 0, GAME_ID);
    const r = applyCommand(h, env({ type: 'setSetpoint', loop: 'tbt', value: 110 }, null));
    expect(r.state).toBe(h);
    expect(rejection(r.events)).toContain('handover');
  });

  it('startShift works only in handover', () => {
    const h = createInitialState(1, 0, GAME_ID);
    const r = applyCommand(h, env({ type: 'startShift', mode: 'manual' }, null));
    expect(r.state.phase).toBe('running');
    expect(r.state.shift?.id).toBe(1);
    expect(r.state.controlMode).toBe('manual');
    expect(r.state.loops.tbt.mode).toBe('manual');
    expect(r.state.loops.levels.every((l) => l.mode === 'auto')).toBe(true);
    expect(r.events[0]).toMatchObject({ type: 'shiftStart', shiftId: 1, mode: 'manual', target: r.state.shift?.target });
    expect(r.events[0]).toHaveProperty('target.maxSalinityPpm');
    const again = applyCommand(r.state, env({ type: 'startShift', mode: 'auto' }, 1));
    expect(again.state).toBe(r.state);
    rejection(again.events);
  });

  it('double selectFuel is rejected', () => {
    const s = running();
    const first = applyCommand(s, env({ type: 'selectFuel', fuel: 'backup' }));
    expect(first.events[0]).toMatchObject({ type: 'fuelChangeover', from: 'gas', to: 'backup', phase: 'started' });
    expect(first.state.fuel.changeover).not.toBeNull();
    const second = applyCommand(first.state, env({ type: 'selectFuel', fuel: 'gas' }));
    expect(second.state).toBe(first.state);
    rejection(second.events);
    const same = applyCommand(s, env({ type: 'selectFuel', fuel: 'gas' }));
    expect(same.state).toBe(s);
    rejection(same.events);
  });

  it('orderFuel schedules an off-grade delivery at tick + 90 under offgradeOnly', () => {
    // 100 t costs $53,200 (off-grade) or $59,500 (standard), more than the starting balance.
    const r0 = running();
    const s: PlantState = { ...r0, run: { ...r0.run, balanceUsd: 100000 } };
    const o: PlantState = {
      ...s,
      tick: 10,
      scenario: { ...s.scenario, effects: { ...s.scenario.effects, offgradeOnly: true } },
    };
    const r = applyCommand(o, env({ type: 'orderFuel', tonnes: 100 }));
    expect(DELIVERY_TICKS).toBe(90);
    expect(r.state.fuel.deliveries).toEqual([{ arrivesAtTick: 100, tonnes: 100, grade: 'offgrade' }]);
    const std = applyCommand(s, env({ type: 'orderFuel', tonnes: 100 }));
    expect(std.state.fuel.deliveries[0]).toMatchObject({ arrivesAtTick: 90, grade: 'standard' });
    for (const tonnes of [0, 501]) rejection(applyCommand(s, env({ type: 'orderFuel', tonnes })).events);
  });

  it('pause then resume round-trips; wrong phase rejected', () => {
    const s = running();
    const p = applyCommand(s, env({ type: 'pause' }));
    expect(p.state.phase).toBe('paused');
    expect(applyCommand(p.state, env({ type: 'resume' })).state.phase).toBe('running');
    rejection(applyCommand(p.state, env({ type: 'pause' })).events);
    rejection(applyCommand(s, env({ type: 'resume' })).events);
  });

  it('setLoopMode: bumpless in Auto, restricted in Manual', () => {
    const a = running('auto');
    const r = applyCommand(a, env({ type: 'setLoopMode', loop: 'tbt', mode: 'manual' }));
    expect(r.state.loops.tbt.mode).toBe('manual');
    expect(r.state.loops.tbt.output).toBe(a.loops.tbt.output);
    const m = running('manual');
    const bad = applyCommand(m, env({ type: 'setLoopMode', loop: 'tbt', mode: 'auto' }));
    expect(bad.state).toBe(m);
    rejection(bad.events);
    expect(applyCommand(m, env({ type: 'setLoopMode', loop: 'level1', mode: 'manual' })).state.loops.levels[0]!.mode).toBe(
      'manual',
    );
  });

  it('simple actuation commands and dose ranges', () => {
    const s = running();
    expect(applyCommand(s, env({ type: 'pump', pumpId: 'P-103', action: 'start' })).state.intake.pumps['P-103'].running).toBe(true);
    expect(applyCommand(s, env({ type: 'pump', pumpId: 'P-101', action: 'stop' })).state.intake.pumps['P-101'].running).toBe(false);
    expect(applyCommand(s, env({ type: 'setDose', chemical: 'chlorine', mgL: 3 })).state.pretreat.chlorineMgL).toBe(3);
    expect(applyCommand(s, env({ type: 'setDose', chemical: 'antiscalant', mgL: 10 })).state.pretreat.antiscalantMgL).toBe(10);
    for (const mgL of [-0.1, 10.1]) rejection(applyCommand(s, env({ type: 'setDose', chemical: 'chlorine', mgL })).events);
    expect(applyCommand(s, env({ type: 'ballCleaning', on: true })).state.ballCleaning).toBe(true);
    expect(applyCommand(s, env({ type: 'divertToDrain', on: true })).state.product.divertToDrain).toBe(true);
  });

  it('manualTrip, restart delegation, acidClean', () => {
    const s = running();
    const t = applyCommand(s, env({ type: 'manualTrip' }));
    expect(t.state.status).toBe('tripped');
    expect(allFinite(t.state)).toBe(true);
    const again = applyCommand(t.state, env({ type: 'manualTrip' }));
    expect(again.state).toBe(t.state);
    rejection(again.events);
    const rs = applyCommand(t.state, env({ type: 'restart' }));
    expect(rs.state.status).toBe('restarting');
    const wrongMode = applyCommand(t.state, env({ type: 'restartStep', step: 'vacuum' }));
    expect(wrongMode.state).toBe(t.state);
    rejection(wrongMode.events);
    const noTrip = applyCommand(s, env({ type: 'restart' }));
    expect(noTrip.state).toBe(s);
    rejection(noTrip.events);
    expect(applyCommand(t.state, env({ type: 'acidClean' })).state.status).toBe('acidCleaning');
  });
});

describe('dispatchCrew', () => {
  const dispatch = (s: PlantState, job: keyof typeof CREW_JOBS) =>
    applyCommand(s, env({ type: 'dispatchCrew', job }));
  const leaking = (): PlantState => applyEffect(running(), 'tubeLeak', { stage: 2, ppm: 30 });
  const idle = (s: PlantState, n: number): PlantState => {
    for (let i = 0; i < n; i++) s = tick(s, []).state;
    return s;
  };

  it('rejects with nothing to repair when the job has no fault', () => {
    const s = running();
    for (const job of Object.keys(CREW_JOBS) as (keyof typeof CREW_JOBS)[]) {
      const r = dispatch(s, job);
      expect(r.state).toBe(s);
      expect(rejection(r.events)).toBe('nothing to repair');
    }
  });

  it('plugTubes charges $800 at once, runs 90 ticks, then plugs the stage', () => {
    const s = leaking();
    const r = dispatch(s, 'plugTubes');
    expect(r.state.run.balanceUsd).toBe(s.run.balanceUsd - 800);
    expect(r.state.crew).toEqual({ job: 'plugTubes', remainingTicks: 90 });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'accountChange', deltaUsd: -800, cause: 'crew' });
    const mid = idle(r.state, 89);
    expect(mid.crew?.remainingTicks).toBe(1);
    expect(mid.faults.tubeLeak).not.toBeNull();
    const done = idle(mid, 1);
    expect(done.faults.tubeLeak).toBeNull();
    expect(done.faults.stageDerate[2]).toBe(TUBE_PLUG_DERATE);
    expect(done.crew).toBeNull();
  });

  it('a second dispatch while busy is rejected as crew busy and charges nothing', () => {
    const first = dispatch(leaking(), 'plugTubes').state;
    const sensors = applyEffect(first, 'sensorFailure', { loop: 'tbt', mode: 'freeze' });
    const r = dispatch(sensors, 'replaceSensor');
    expect(r.state).toBe(sensors);
    expect(rejection(r.events)).toBe('crew busy');
  });

  it('replaceSensor clears every sensor fault', () => {
    let s = applyEffect(running(), 'sensorFailure', { loop: 'tbt', mode: 'freeze' });
    s = applyEffect(s, 'sensorFailure', { loop: 'vacuum', mode: 'noise' });
    const r = dispatch(s, 'replaceSensor');
    expect(r.state.run.balanceUsd).toBe(s.run.balanceUsd - 400);
    const done = idle(r.state, 45);
    expect(done.faults.sensors).toEqual({});
    expect(done.crew).toBeNull();
  });

  it('is rejected as not running during handover and while paused', () => {
    const h = { ...leaking(), phase: 'handover' as const };
    const r = dispatch(h, 'plugTubes');
    expect(r.state).toBe(h);
    expect(rejection(r.events)).toBe('not running');
    const p = { ...leaking(), phase: 'paused' as const };
    expect(rejection(dispatch(p, 'plugTubes').events)).toBe('not running');
  });

  it('rejects insufficient funds without starting the crew', () => {
    const s = leaking();
    const poor = { ...s, run: { ...s.run, balanceUsd: 100 } };
    const r = dispatch(poor, 'plugTubes');
    expect(r.state).toBe(poor);
    expect(rejection(r.events)).toBe('insufficient funds');
  });

  it('every job costs and lasts what the spec says (4.6)', () => {
    const faulted: Record<string, PlantState> = {
      plugTubes: leaking(),
      repairEjector: applyEffect(running(), 'vacuumLoss', { ratePerMin: 0.012 }),
      replaceSensor: applyEffect(running(), 'sensorFailure', { loop: 'tbt', mode: 'freeze' }),
      cleanScreens: applyEffect(running(), 'storm', { fouling: 0.2, deltaC: 2, minutes: 90 }),
    };
    const spec = {
      plugTubes: [800, 60],
      repairEjector: [1000, 45],
      replaceSensor: [400, 30],
      cleanScreens: [300, 30],
    } as const;
    for (const [job, [usd, min]] of Object.entries(spec)) {
      const s = faulted[job]!;
      const r = dispatch(s, job as keyof typeof spec);
      expect(s.run.balanceUsd - r.state.run.balanceUsd).toBe(usd);
      expect(r.state.crew).toEqual({ job, remainingTicks: (min * 60) / TICK_PLANT_S });
    }
  });
});
