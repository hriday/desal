import { describe, expect, it } from 'vitest';
import { SHIFT_TICKS } from '../src/constants.js';
import { applyEffect } from '../src/scenario/effects.js';
import { loadScenario } from '../src/scenario/engine.js';
import { scenarioForShift } from '../src/scenario/library.js';
import { applyTrip } from '../src/safety/interlocks.js';
import { restartStep } from '../src/safety/restart.js';
import { toStatus } from '../src/emit.js';
import { drawPendingPlan, startShift } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

const T0 = Date.UTC(2026, 0, 1);

function runShift(s: PlantState): PlantState {
  for (let i = 0; i < SHIFT_TICKS && s.phase === 'running'; i++) s = tick(s, []).state;
  return s;
}

const allLoops = (s: PlantState) => [
  s.loops.tbt,
  s.loops.intakeFlow,
  s.loops.recirc,
  s.loops.blowdown,
  s.loops.vacuum,
  ...s.loops.levels,
];

describe('startShift resets per-shift supply conditions and controller faults', () => {
  it('shift 3 curtailment and price spike do not carry into shift 4; damage does', () => {
    // A career that has played shifts 1 and 2; shift 3 is given a curtailment and a price spike by hand.
    const career = { ...createInitialState(1, T0, GAME_ID), run: { ...createInitialState(1, T0, GAME_ID).run, shiftNumber: 2 } };
    const started = startShift(career, 'auto').state;
    const ev = (eventId: number, kind: 'offgradeOnly' | 'gasCurtailNotice' | 'gasPriceSpike', params: Record<string, number>) => ({ eventId, kind, params, earliestMinute: 0, cascade: false });
    // A hell plan fires all three by minute 200 (first by 120, then 10–40 apart).
    const active = started.chaos.active!;
    const plan = {
      ...active.plan,
      hell: true,
      queue: [ev(1, 'offgradeOnly', {}), ev(2, 'gasCurtailNotice', { capMW: 25, effectiveMinute: 240 }), ev(3, 'gasPriceSpike', { mult: 1.8 })],
    };
    const shift3: PlantState = { ...started, chaos: { ...started.chaos, active: { ...active, plan, nextEventId: 4 } } };
    const ended = runShift(shift3);
    expect(ended.phase).toBe('handover');
    // Shift 3 really did curtail and spike the gas.
    expect(ended.fuel.gas.capMW).toBe(25);
    expect(ended.fuel.gas.priceUsdPerGJ).toBeCloseTo(8 * 1.8);

    // Leave a fault and a pending notice behind, as a random shift-4+ event could.
    const dirty: PlantState = {
      ...ended,
      fuel: { ...ended.fuel, gas: { ...ended.fuel.gas, curtailmentNotice: { atTick: ended.tick + 5, capMW: 10 } } },
      loops: {
        ...ended.loops,
        recirc: { ...ended.loops.recirc, fault: { kind: 'stuck', bias: 0 } },
        levels: ended.loops.levels.map((l, i) => (i === 3 ? { ...l, fault: { kind: 'drift', bias: 2 } } : l)),
      },
    };

    const shift4 = startShift(dirty, 'auto').state;
    expect(shift4.shift?.id).toBe(4);
    expect(shift4.fuel.gas).toEqual({ capMW: 60, priceUsdPerGJ: 8, curtailmentNotice: null });
    expect(allLoops(shift4).every((l) => l.fault === null)).toBe(true);

    // Persistent damage is kept across the shift boundary.
    expect(shift4.stages).toEqual(dirty.stages);
    expect(shift4.heater.burnerCondition).toBe(dirty.heater.burnerCondition);
    expect(shift4.intake.pumps).toEqual(dirty.intake.pumps);
    expect(shift4.fuel.backup).toEqual(dirty.fuel.backup);
  });

  it('keeps bearingWearMult across shifts (persistent damage by design)', () => {
    const s = createInitialState(1, T0, GAME_ID);
    const worn: PlantState = {
      ...s,
      intake: { ...s.intake, pumps: { ...s.intake.pumps, 'P-102': { ...s.intake.pumps['P-102'], bearingWearMult: 4 } } },
    };
    expect(startShift(worn, 'auto').state.intake.pumps['P-102'].bearingWearMult).toBe(4);
  });

  it('lets Scenario.initial override the starting gas cap and price', () => {
    const base = scenarioForShift(1, 0);
    const scenario = { ...base, initial: { ...base.initial, gasCapMW: 30, gasPriceUsdPerGJ: 11 } };
    const s = loadScenario(createInitialState(1, T0, GAME_ID), scenario);
    expect(s.fuel.gas).toEqual({ capMW: 30, priceUsdPerGJ: 11, curtailmentNotice: null });
  });
});

describe('startShift with a restart in progress', () => {
  it('drops a Manual restart carried over handover back to tripped, so an Auto shift can restart', () => {
    const s0 = { ...createInitialState(1, T0, GAME_ID), controlMode: 'manual' as const };
    const tripped = applyTrip(s0, 'manual').state;
    const r = restartStep(tripped, 'vacuum');
    if ('rejected' in r) throw new Error(r.rejected);
    const handover: PlantState = { ...r.state, phase: 'handover' };
    expect(handover.status).toBe('restarting');

    const started = startShift(handover, 'auto').state;
    expect(started.status).toBe('tripped');
    expect(started.restart).toBeNull();
    expect(started.loops.tbt.output).toBe(0);
    // No damage, and the original trip record is kept.
    expect(started.stages).toEqual(handover.stages);
    expect(started.heater).toEqual(handover.heater);
    expect(started.trip).toEqual(handover.trip);

    // The Auto one-button restart is accepted now.
    const t = tick(started, [env(started, { type: 'restart' })]);
    expect(t.events.filter((e) => e.type === 'commandRejected')).toEqual([]);
    expect(t.state.status).toBe('restarting');
  });

  it('leaves an online or tripped plant as it is', () => {
    const online = createInitialState(1, T0, GAME_ID);
    expect(startShift(online, 'auto').state.status).toBe('online');
    const tripped = applyTrip(online, 'manual').state;
    const started = startShift(tripped, 'auto').state;
    expect(started.status).toBe('tripped');
    expect(started.trip).toEqual(tripped.trip);
  });
});

describe('status shiftTarget outside a shift', () => {
  it('is null in handover after shift 2 (endShift keeps s.shift), and the live target while running', () => {
    let s = createInitialState(1, T0, GAME_ID);
    for (let n = 1; n <= 2; n++) {
      const started = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]);
      expect(started.state.phase).toBe('running');
      expect(started.status.shiftTarget).toEqual(started.state.shift!.target);
      s = runShift(started.state);
    }
    expect(s.phase).toBe('handover');
    expect(s.shift?.id).toBe(2); // the finished shift's record is kept until the next startShift
    expect(tick(s, []).status.shiftTarget).toBeNull();
    const over = tick(s, [env(s, { type: 'quitGame' })]);
    expect(over.state.phase).toBe('over');
    expect(over.status.shiftTarget).toBeNull();
  });
});

describe('chaos plan lifecycle', () => {
  const fresh = () => drawPendingPlan(createInitialState(1, T0, GAME_ID));

  it('draws shift 1 at game creation and activates it at startShift', () => {
    const s = fresh();
    expect(s.chaos.pending?.shiftNumber).toBe(1);
    expect(s.chaos.pending?.hell).toBe(false);
    const started = startShift(s, 'auto');
    const { pending, active } = started.state.chaos;
    expect(pending).toBeNull();
    expect(active?.plan.shiftNumber).toBe(1);
    expect(active).toMatchObject({ fired: [], lastFiredMinute: null, nextEventId: active!.plan.queue.length + 1 });
    expect(started.state.shift!.target.productM3).toBe(active!.plan.targetM3);
    expect(started.state.seawater.tempC).toBe(active!.plan.initial.seawaterTempC);
    const ev = started.events.find((e) => e.type === 'shiftStart');
    expect(ev).toMatchObject({ hell: false, orders: active!.plan.orders });
  });

  it('is deterministic from the seed', () => {
    expect(fresh()).toEqual(fresh());
  });

  it('draws a plan on the spot when a bare state has none', () => {
    const started = startShift(createInitialState(1, T0, GAME_ID), 'auto').state;
    expect(started.chaos.active?.plan.shiftNumber).toBe(1);
  });

  it('the orders quote the seawater the next shift actually starts with', () => {
    const s = runShift(startShift(fresh(), 'auto').state);
    const orders = s.chaos.pending!.orders;
    const next = startShift(s, 'auto').state;
    expect(orders.lines[0]).toContain(`${next.seawater.tempC.toFixed(1)} C`);
    expect(orders.lines[0]).toContain(`${next.seawater.chlorophyllUgL.toFixed(1)} ug/L`);
  });

  it('after a full shift: next plan pending, active cleared', () => {
    const s = runShift(startShift(fresh(), 'auto').state);
    expect(s.phase).toBe('handover');
    expect(s.chaos.pending?.shiftNumber).toBe(2);
    expect(s.chaos.active).toBeNull();
  });

  it('shiftEnd summary reports fired events only, and the plan hell flag', () => {
    const s0 = startShift(fresh(), 'auto').state;
    const active = {
      ...s0.chaos.active!,
      // Queue entries pinned past minute 420 never fire, and the summary leaves them out.
      plan: { ...s0.chaos.active!.plan, hell: true, queue: s0.chaos.active!.plan.queue.map((e) => ({ ...e, earliestMinute: 430 })) },
      fired: [{ eventId: 1, kind: 'pumpTrip' as const, params: { pumpId: 'P-101' }, atMinute: 40, cleared: true, how: 'player' as const }],
    };
    let s: PlantState = { ...s0, chaos: { ...s0.chaos, active } };
    const ends: unknown[] = [];
    for (let i = 0; i < SHIFT_TICKS && s.phase === 'running'; i++) {
      const t = tick(s, []);
      s = t.state;
      ends.push(...t.events.filter((e) => e.type === 'shiftEnd'));
    }
    const summary = (ends[0] as { summary: { hell: boolean; events: unknown[] } }).summary;
    expect(summary.hell).toBe(true);
    expect(summary.events).toEqual([{ eventId: 1, kind: 'pumpTrip', atMinute: 40, cleared: true, how: 'player' }]);
  });

  it('startShift clears a running crew job and every per-shift fault (never carried over)', () => {
    const s0 = fresh();
    const dirty: PlantState = {
      ...s0,
      crew: { job: 'plugTubes', remainingTicks: 30 },
      faults: {
        tubeLeak: { stage: 2, ppm: 10 },
        ejectorFailed: true,
        ejectorRatePerMin: 0.01,
        powerDipRemainingTicks: 5,
        powerDipRecircFactor: 0.5,
        stormRemainingTicks: 9,
        stormFouling: 0.2,
        stormCleanedByCrew: true,
        sensors: { tbt: { kind: 'freeze', value: 100 } },
        stageDerate: s0.faults.stageDerate.map(() => 0.5),
      },
    };
    const next = startShift(dirty, 'auto').state;
    expect(next.crew).toBeNull();
    expect(next.faults).toEqual(createInitialState(1, T0, GAME_ID).faults);
  });

  it('records lastWasHell from the activated plan', () => {
    const s0 = fresh();
    const hellPlan = { ...s0.chaos.pending!, hell: true };
    expect(startShift({ ...s0, chaos: { ...s0.chaos, pending: hellPlan } }, 'auto').state.chaos.lastWasHell).toBe(true);
  });
});

describe('startShift lines up two intake pumps', () => {
  const fresh = () => drawPendingPlan(createInitialState(1, T0, GAME_ID));
  const running = (s: PlantState) => (['P-101', 'P-102', 'P-103'] as const).filter((id) => s.intake.pumps[id].running);
  const withPumps = (s: PlantState, patch: Record<string, Partial<PlantState['intake']['pumps']['P-101']>>): PlantState => {
    const pumps = { ...s.intake.pumps };
    for (const [id, p] of Object.entries(patch)) pumps[id as keyof typeof pumps] = { ...pumps[id as keyof typeof pumps], ...p };
    return { ...s, intake: { ...s.intake, pumps } };
  };

  it('after a pump trip left one pump running, the next shift starts with two', () => {
    const tripped = applyEffect(startShift(fresh(), 'auto').state, 'pumpTrip', { pumpId: 'P-102' });
    expect(running(tripped)).toEqual(['P-101']);
    const next = startShift({ ...tripped, phase: 'handover' }, 'auto').state;
    expect(running(next)).toEqual(['P-101', 'P-102']);
  });

  it('does not start a worn-out pump', () => {
    const s = withPumps(fresh(), { 'P-102': { running: false, wear: 1 }, 'P-103': { running: false } });
    expect(running(startShift(s, 'auto').state)).toEqual(['P-101', 'P-103']);
    const only = withPumps(fresh(), { 'P-102': { running: false, wear: 1 }, 'P-103': { running: false, wear: 1 } });
    expect(running(startShift(only, 'auto').state)).toEqual(['P-101']);
  });

  it('starts the standby when a duty pump is under overhaul, but never a pump under overhaul', () => {
    const s = withPumps(fresh(), { 'P-102': { running: false, overhaulRemainingTicks: 50 }, 'P-103': { running: false } });
    expect(running(startShift(s, 'auto').state)).toEqual(['P-101', 'P-103']);
    const both = withPumps(fresh(), {
      'P-102': { running: false, overhaulRemainingTicks: 50 },
      'P-103': { running: false, overhaulRemainingTicks: 50 },
    });
    const next = startShift(both, 'auto').state;
    expect(running(next)).toEqual(['P-101']);
    expect(next.intake.pumps['P-102'].running).toBe(false);
  });
});

describe('status orders and hell', () => {
  const fresh = () => drawPendingPlan(createInitialState(1, T0, GAME_ID));

  it('handover shows the pending orders and no hell flag', () => {
    const st = toStatus(fresh());
    expect(st.phase).toBe('handover');
    expect(st.orders).not.toBeNull();
    expect(st.orders).toEqual(fresh().chaos.pending!.orders);
    expect(st.hell).toBeNull();
  });

  it('a running shift shows the active orders and hell flag; paused keeps orders, hides hell', () => {
    const running = startShift(fresh(), 'auto').state;
    const st = toStatus(running);
    expect(st.orders).toEqual(running.chaos.active!.plan.orders);
    expect(st.hell).toBe(false);
    const paused = toStatus({ ...running, phase: 'paused' });
    expect(paused.orders).toEqual(running.chaos.active!.plan.orders);
    expect(paused.hell).toBeNull();
  });

  it('reports the crew job', () => {
    const s = { ...fresh(), crew: { job: 'plugTubes' as const, remainingTicks: 7 } };
    expect(toStatus(s).crew).toEqual({ job: 'plugTubes', remainingTicks: 7 });
    expect(toStatus(fresh()).crew).toBeNull();
  });
});
