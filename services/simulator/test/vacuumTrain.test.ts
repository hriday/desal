import type { GameMode, PlantEvent } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { AIR_LEAK_LOAD, COOLING_LOSS_FLOOR, RESTART_VACUUM_MIN, TICK_PLANT_S } from '../src/constants.js';
import { applyTrip } from '../src/safety/interlocks.js';
import type { QueuedEvent } from '../src/scenario/chaosTypes.js';
import { PROFILES, VACUUM_TRAIN_MINUTE, VACUUM_TRAIN_SALT } from '../src/scenario/difficulty.js';
import { drawVacuumTrainFault, vacuumTrainParamsAtFire } from '../src/scenario/vacuumTrain.js';
import { startShift } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

const TICKS_PER_MIN = 60 / TICK_PLANT_S;

/** Shift 1 running in Auto with no chaos plan. */
function quiet(): PlantState {
  const s = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
  return { ...s, chaos: { ...s.chaos, active: null } };
}
const at = (seed: number, mode: GameMode): PlantState => {
  const s = createInitialState(seed, 0, GAME_ID, mode);
  return { ...s, run: { ...s.run, mode } };
};
const onGrid = (x: number, step: number): boolean => Math.abs(x / step - Math.round(x / step)) < 1e-6;
const cmd = (s: PlantState, command: Record<string, unknown>) => tick(s, [env(s, command)]);
const rejection = (events: PlantEvent[]): string | undefined =>
  (events.find((e) => e.type === 'commandRejected') as { reason: string } | undefined)?.reason;

describe('the fault mix', () => {
  it('has the profile values, the salt and the minute window', () => {
    expect(PROFILES.normal.vacuumTrainChance).toBe(0.2);
    expect(PROFILES.normal.vacuumTrainFromShift).toBe(2);
    expect(PROFILES.hard.vacuumTrainChance).toBe(0.4);
    expect(PROFILES.hard.vacuumTrainFromShift).toBe(2);
    expect(VACUUM_TRAIN_SALT).toBe(0x7a1c5);
    expect(VACUUM_TRAIN_MINUTE).toEqual([60, 360]);
  });
});

describe('drawVacuumTrainFault', () => {
  const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

  it('is deterministic per (seed, shift) and never consumes the game seed', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      for (const n of [2, 3, 7]) {
        const s = at(seed, 'hard');
        expect(drawVacuumTrainFault(s, n)).toEqual(drawVacuumTrainFault(s, n));
        expect(s.seed).toBe(at(seed, 'hard').seed);
      }
    }
  });

  it('never in shift 1', () => {
    for (const seed of SEEDS) {
      for (const mode of ['normal', 'hard'] as const) expect(drawVacuumTrainFault(at(seed, mode), 1)).toBeNull();
    }
  });

  it('draws an own-clock entry in the minute window, with no params and eventId 0', () => {
    for (const seed of SEEDS) {
      const e = drawVacuumTrainFault(at(seed, 'hard'), 2);
      if (!e) continue;
      expect(['coolingLoss', 'airLeak']).toContain(e.kind);
      expect(e).toMatchObject({ eventId: 0, params: {}, cascade: false, disaster: false });
      expect(Number.isInteger(e.earliestMinute)).toBe(true);
      expect(e.earliestMinute).toBeGreaterThanOrEqual(VACUUM_TRAIN_MINUTE[0]);
      expect(e.earliestMinute).toBeLessThanOrEqual(VACUUM_TRAIN_MINUTE[1]);
    }
  });

  it('splits the kinds roughly 50/50 over seeds 1-200, and Hard draws more than Normal', () => {
    const count = { normal: 0, hard: 0 };
    let cooling = 0;
    let total = 0;
    for (const seed of SEEDS) {
      for (const mode of ['normal', 'hard'] as const) {
        for (const n of [2, 3, 4]) {
          const e = drawVacuumTrainFault(at(seed, mode), n);
          if (!e) continue;
          count[mode]++;
          total++;
          if (e.kind === 'coolingLoss') cooling++;
        }
      }
    }
    expect(cooling / total).toBeGreaterThan(0.4);
    expect(cooling / total).toBeLessThan(0.6);
    // Nominally 20 % and 40 % of the 600 shift rolls. The small adjacent seeds land a little under
    // (0.155 and 0.31 measured) by sample noise, not bias: the seeds collide (seed i at shift 3 hashes
    // the same as seed i^1 at shift 2), so only about 200 distinct inputs are drawn. Over seeds 1-100,000
    // the rates are 0.1998 Normal and 0.4012 Hard. Hard is about twice Normal.
    expect(count.hard).toBeGreaterThan(1.5 * count.normal);
    expect(count.normal / 600).toBeGreaterThan(0.1);
    expect(count.normal / 600).toBeLessThan(0.3);
    expect(count.hard / 600).toBeGreaterThan(0.25);
    expect(count.hard / 600).toBeLessThan(0.5);
  });
});

describe('vacuumTrainParamsAtFire', () => {
  it('draws the coolingLoss floor and the airLeak load on their grids, in range, without touching the seed', () => {
    const s0 = quiet();
    const floors = new Set<number>();
    const loads = new Set<number>();
    for (let t = 0; t < 300; t++) {
      const s = { ...s0, tick: s0.tick + t };
      const { floor } = vacuumTrainParamsAtFire(s, 'coolingLoss') as { floor: number };
      const { load } = vacuumTrainParamsAtFire(s, 'airLeak') as { load: number };
      expect(floor).toBeGreaterThanOrEqual(COOLING_LOSS_FLOOR[0]);
      expect(floor).toBeLessThanOrEqual(COOLING_LOSS_FLOOR[1]);
      expect(onGrid(floor, 0.01)).toBe(true);
      expect(load).toBeGreaterThanOrEqual(AIR_LEAK_LOAD[0]);
      expect(load).toBeLessThanOrEqual(AIR_LEAK_LOAD[1]);
      expect(onGrid(load, 0.1)).toBe(true);
      expect(vacuumTrainParamsAtFire(s, 'coolingLoss')).toEqual({ floor });
      expect(vacuumTrainParamsAtFire(s, 'airLeak')).toEqual({ load });
      floors.add(floor);
      loads.add(load);
    }
    expect(floors.size).toBeGreaterThan(5);
    expect(loads.size).toBeGreaterThan(5);
  });
});

// Review Focus 4 (restated, Ruling F): a trip during coolingLoss. With the burner off the restart's
// vacuum step passes (cutting load relieves the fouled condenser), but the plant cannot hold online
// at full load until the strainer is cleaned: it re-trips on lossOfVacuum.
describe('a trip during coolingLoss', () => {
  const HOLD_TICKS = 60;
  /** Tick with the Auto restart retried every 10 ticks while tripped: lossOfVacuum trips seen and the longest online run. */
  function play(s: PlantState, ticks: number, stop: (x: PlantState, onlineRun: number) => boolean = () => false) {
    let vacuumTrips = 0;
    let onlineRun = 0;
    let longestOnline = 0;
    for (let i = 0; i < ticks; i++) {
      const cmds = s.status === 'tripped' && !s.restart && i % 10 === 0 ? [env(s, { type: 'restart' })] : [];
      const r = tick(s, cmds);
      s = r.state;
      if (r.events.some((e) => e.type === 'trip' && e.cause === 'lossOfVacuum')) vacuumTrips++;
      onlineRun = s.status === 'online' ? onlineRun + 1 : 0;
      longestOnline = Math.max(longestOnline, onlineRun);
      if (stop(s, onlineRun)) break;
    }
    return { s, vacuumTrips, longestOnline };
  }

  it('re-trips on lossOfVacuum and cannot hold online until the crew cleans the strainer, then restarts and holds online', () => {
    let s: PlantState = { ...quiet(), faults: { ...quiet().faults, coolingLoss: { floor: 0.25 } } };
    // Let the cooling fall to its floor (8.75 min) and the vacuum below the restart's minimum before tripping by hand.
    for (let i = 0; i < 60 * TICKS_PER_MIN && (s.ejectors.coolCap > 0.25 || s.vacuum.quality >= RESTART_VACUUM_MIN); i++) {
      s = tick(s, []).state;
    }
    expect(s.status).toBe('online');
    expect(s.ejectors.coolCap).toBe(0.25);
    s = applyTrip(s, 'manual').state;
    s = cmd(s, { type: 'restart' }).state;
    expect(s.status).toBe('restarting');

    // Before the clean: 300 ticks (200 plant minutes) of Auto restarts never hold online for HOLD_TICKS.
    const before = play(s, 300);
    expect(before.vacuumTrips).toBeGreaterThanOrEqual(2);
    expect(before.longestOnline).toBeLessThan(HOLD_TICKS);
    expect(before.s.faults.coolingLoss).toEqual({ floor: 0.25 });

    // The clean: the crew can go while the plant is down or restarting.
    const sent = cmd(before.s, { type: 'dispatchCrew', job: 'cleanStrainer' });
    expect(rejection(sent.events)).toBeUndefined();
    const cleaned = play(sent.state, 2000, (x) => x.faults.coolingLoss === null);
    expect(cleaned.s.faults.coolingLoss).toBeNull();

    // After it: the restart reaches online and holds there, with no lossOfVacuum.
    const after = play(cleaned.s, 2000, (_x, run) => run >= HOLD_TICKS);
    expect(after.s.status).toBe('online');
    expect(after.longestOnline).toBeGreaterThanOrEqual(HOLD_TICKS);
    const held = play(after.s, HOLD_TICKS);
    expect(held.vacuumTrips).toBe(0);
    expect(held.s.status).toBe('online');
    expect(held.s.ejectors.coolCap).toBe(2);
  });
});

// Review Focus 5: the two crew jobs.
describe('crew cleanStrainer and sealLeak', () => {
  const cases = [
    { job: 'cleanStrainer', kind: 'coolingLoss', costUsd: 400, minutes: 30, fault: (s: PlantState) => s.faults.coolingLoss },
    { job: 'sealLeak', kind: 'airLeak', costUsd: 600, minutes: 60, fault: (s: PlantState) => s.faults.airLeak },
  ] as const;

  for (const c of cases) {
    it(`${c.job} with no ${c.kind} is refused with nothing to repair`, () => {
      const s = quiet();
      const r = cmd(s, { type: 'dispatchCrew', job: c.job });
      expect(rejection(r.events)).toBe('nothing to repair');
      expect(r.state.crew).toBeNull();
    });

    it(`${c.job} answers a fired ${c.kind}: $${c.costUsd}, ${c.minutes} min, clears it, one eventCleared by the crew`, () => {
      const s0 = quiet();
      const entry: QueuedEvent = { eventId: 1, kind: c.kind, params: {}, earliestMinute: 2, cascade: false, disaster: false };
      const plan = { ...s0.chaos.pending!, shiftNumber: 1, hell: false, queue: [entry] };
      let s: PlantState = { ...s0, chaos: { ...s0.chaos, active: { plan, fired: [], lastFiredMinute: null, nextEventId: 2 } } };
      const events: PlantEvent[] = [];
      for (let i = 0; i < 10 && c.fault(s) === null; i++) {
        const r = tick(s, []);
        events.push(...r.events);
        s = r.state;
      }
      expect(c.fault(s)).not.toBeNull();
      expect(events.filter((e) => e.type === 'scenario' && e.kind === c.kind)).toHaveLength(1);
      const sent = cmd(s, { type: 'dispatchCrew', job: c.job });
      expect(rejection(sent.events)).toBeUndefined();
      expect(sent.events).toContainEqual(expect.objectContaining({ type: 'accountChange', deltaUsd: -c.costUsd, cause: 'crew' }));
      expect(sent.state.run.balanceUsd).toBeLessThanOrEqual(s.run.balanceUsd - c.costUsd);
      events.push(...sent.events);
      s = sent.state;
      const ticks = (c.minutes * 60) / TICK_PLANT_S;
      expect(s.crew).toEqual({ job: c.job, remainingTicks: ticks - 1 });
      for (let i = 0; i < ticks + 5; i++) {
        if (i === ticks - 2) expect(c.fault(s)).not.toBeNull();
        const r = tick(s, []);
        events.push(...r.events);
        s = r.state;
      }
      expect(c.fault(s)).toBeNull();
      expect(s.crew).toBeNull();
      const clears = events.filter((e) => e.type === 'eventCleared' && e.eventId === 1);
      expect(clears).toHaveLength(1);
      expect(clears[0]).toMatchObject({ kind: c.kind, how: 'crew' });
    });
  }
});
