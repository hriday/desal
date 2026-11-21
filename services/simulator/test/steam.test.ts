import type { PlantEvent } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { MOTIVE_STEAM_NOMINAL_BAR, RESTART_VACUUM_MIN, TICK_PLANT_S } from '../src/constants.js';
import { applyTrip } from '../src/safety/interlocks.js';
import type { QueuedEvent } from '../src/scenario/chaosTypes.js';
import { startShift } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { ejectorReach, stepSteam } from '../src/units/steam.js';
import { env, GAME_ID } from './envelope.js';

const SAG_PER_TICK = (0.25 * TICK_PLANT_S) / 60;
const minutes = (ticks: number): number => (ticks * TICK_PLANT_S) / 60;

/** Shift 1 running in Auto with no chaos plan. */
function quiet(): PlantState {
  const s = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
  return { ...s, chaos: { ...s.chaos, active: null } };
}
const withLowSteam = (s: PlantState, floorBar: number): PlantState => ({ ...s, faults: { ...s.faults, lowSteam: { floorBar } } });
const standby = (s: PlantState, on: boolean) => env(s, { type: 'standbySteam', on });

/** Tick until a trip (or `max` ticks); the number of ticks it took and the trip cause, if any. */
function untilTrip(s: PlantState, max: number): { ticks: number; cause: string | null } {
  for (let i = 1; i <= max; i++) {
    const r = tick(s, []);
    s = r.state;
    const trip = r.events.find((e) => e.type === 'trip');
    if (trip && trip.type === 'trip') return { ticks: i, cause: trip.cause };
  }
  return { ticks: max, cause: null };
}

describe('ejectorReach', () => {
  it('is 1 at and above 13 bar, a third at 11, and 0 at and below 10', () => {
    expect(ejectorReach(13)).toBe(1);
    expect(ejectorReach(14.5)).toBe(1);
    expect(Math.abs(ejectorReach(11) - 1 / 3)).toBeLessThanOrEqual(1e-9);
    expect(ejectorReach(10)).toBe(0);
    expect(ejectorReach(8)).toBe(0);
  });
});

describe('stepSteam', () => {
  it('holds nominal with no fault, and with the standby line on', () => {
    const s = quiet();
    expect(stepSteam({ ...s, steam: { motiveBar: 12, standby: false, unbilledTicks: 0 } }, TICK_PLANT_S).steam.motiveBar).toBe(MOTIVE_STEAM_NOMINAL_BAR);
    const faulted = withLowSteam({ ...s, steam: { motiveBar: 12, standby: true, unbilledTicks: 0 } }, 10);
    expect(stepSteam(faulted, TICK_PLANT_S).steam.motiveBar).toBe(MOTIVE_STEAM_NOMINAL_BAR);
  });
});

describe('motive steam on the plant', () => {
  // Captured on the pre-Plan-8 code (commit 3c1abac): quiet() with the vacuum knocked to 0.8.
  it('nominal ticking keeps 14.5 bar and the vacuum exactly as before', () => {
    let s: PlantState = { ...quiet(), vacuum: { quality: 0.8 } };
    const q: number[] = [];
    for (let i = 0; i < 90; i++) {
      s = tick(s, []).state;
      expect(s.steam.motiveBar).toBe(MOTIVE_STEAM_NOMINAL_BAR);
      q.push(s.vacuum.quality);
    }
    expect(q[0]).toBe(0.8128986029936764);
    expect(q[29]).toBe(0.9528965174296531);
    expect(q[89]).toBe(0.9503065997012348);
  });

  it('sags 0.25 bar/min to the floor and never below it', () => {
    let s = withLowSteam(quiet(), 10);
    s = tick(s, []).state;
    expect(s.steam.motiveBar).toBeCloseTo(MOTIVE_STEAM_NOMINAL_BAR - SAG_PER_TICK, 9);
    expect(SAG_PER_TICK).toBeCloseTo(0.1667, 4);
    for (let i = 2; i <= 27; i++) s = tick(s, []).state;
    expect(Math.abs(s.steam.motiveBar - 10)).toBeLessThanOrEqual(1e-9);
    for (let i = 0; i < 60 && s.status === 'online'; i++) {
      s = tick(s, []).state;
      expect(s.steam.motiveBar).toBeGreaterThanOrEqual(10);
    }
  });

  it('ignored at a 10.0 bar floor, the vacuum trips the plant 15-30 plant minutes in', () => {
    const r = untilTrip(withLowSteam(quiet(), 10), 200);
    expect(r.cause).toBe('lossOfVacuum');
    expect(minutes(r.ticks)).toBeGreaterThanOrEqual(15);
    expect(minutes(r.ticks)).toBeLessThanOrEqual(30);
  });

  it('ignored at a 11.0 bar floor, the vacuum trips the plant 22-38 plant minutes in', () => {
    const r = untilTrip(withLowSteam(quiet(), 11), 200);
    expect(r.cause).toBe('lossOfVacuum');
    expect(minutes(r.ticks)).toBeGreaterThanOrEqual(22);
    expect(minutes(r.ticks)).toBeLessThanOrEqual(38);
  });

  it('every floor on the 10.0-11.0 grid trips when ignored', () => {
    for (let i = 0; i <= 10; i++) {
      const floorBar = Number((10 + i / 10).toFixed(1));
      const r = untilTrip(withLowSteam(quiet(), floorBar), 200);
      expect(r.cause, `floor ${floorBar}`).toBe('lossOfVacuum');
    }
  });

  it('the standby line restores 14.5 bar on the same tick, and the vacuum recovers toward 0.95', () => {
    let s = withLowSteam(quiet(), 10);
    for (let i = 0; i < 30; i++) s = tick(s, []).state;
    const low = s.vacuum.quality;
    expect(low).toBeLessThan(0.9);
    s = tick(s, [standby(s, true)]).state;
    expect(s.steam.motiveBar).toBe(MOTIVE_STEAM_NOMINAL_BAR);
    for (let i = 0; i < 90; i++) s = tick(s, []).state;
    expect(s.status).toBe('online');
    expect(s.vacuum.quality).toBeGreaterThan(0.94);
    expect(s.vacuum.quality).toBeGreaterThan(low);
  });
});

// Review Focus 2: standby switched off again while the fault is still active.
describe('standby off again during lowSteam', () => {
  it('sags again from 14.5, stays cleared with one eventCleared, and standby back on restores 14.5 at once', () => {
    const shift = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
    const entry: QueuedEvent = { eventId: 1, kind: 'lowSteam', params: {}, earliestMinute: 5, cascade: false, disaster: false };
    const plan = { ...shift.chaos.active!.plan, queue: [entry] };
    let s: PlantState = { ...shift, chaos: { ...shift.chaos, active: { plan, fired: [], lastFiredMinute: null, nextEventId: 2 } } };
    const events: PlantEvent[] = [];
    const step = (cmds: Record<string, unknown>[] = []) => {
      const r = tick(s, cmds);
      events.push(...r.events);
      s = r.state;
    };
    while (!events.some((e) => e.type === 'scenario')) step();
    expect(s.faults.lowSteam).not.toBeNull();
    for (let i = 0; i < 10; i++) step();
    expect(s.steam.motiveBar).toBeLessThan(MOTIVE_STEAM_NOMINAL_BAR - 1);

    step([standby(s, true)]);
    expect(s.steam.motiveBar).toBe(MOTIVE_STEAM_NOMINAL_BAR);
    step();
    expect(s.chaos.active!.fired[0]!.cleared).toBe(true);

    step([standby(s, false)]);
    expect(s.steam.motiveBar).toBeCloseTo(MOTIVE_STEAM_NOMINAL_BAR - SAG_PER_TICK, 9);
    const atOff = s.vacuum.quality;
    for (let i = 0; i < 40; i++) step();
    expect(s.vacuum.quality).toBeLessThan(atOff - 0.05);
    expect(s.chaos.active!.fired[0]!.cleared).toBe(true);

    step([standby(s, true)]);
    expect(s.steam.motiveBar).toBe(MOTIVE_STEAM_NOMINAL_BAR);
    for (let i = 0; i < 10; i++) step();
    const clears = events.filter((e) => e.type === 'eventCleared' && e.eventId === 1);
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({ kind: 'lowSteam', how: 'player' });
  });
});

// Review Focus 3: a trip during lowSteam; the restart's vacuum step waits for the standby line.
describe('a trip during lowSteam', () => {
  it('the Auto restart cannot pull vacuum until the standby line is on, then reaches online', () => {
    let s = withLowSteam(quiet(), 10);
    for (let i = 0; i < 27; i++) s = tick(s, []).state;
    expect(s.status).toBe('online');
    s = applyTrip(s, 'manual').state;
    s = tick(s, [env(s, { type: 'restart' })]).state;
    for (let i = 0; i < 60; i++) {
      s = tick(s, []).state;
      expect(s.status).toBe('restarting');
      expect(s.restart?.step).toBe('vacuum');
      expect(s.vacuum.quality).toBeLessThan(RESTART_VACUUM_MIN);
    }
    s = tick(s, [standby(s, true)]).state;
    for (let i = 0; i < 600 && s.status !== 'online'; i++) {
      s = tick(s, []).state;
      expect(s.status, `tick ${i}`).not.toBe('tripped');
    }
    expect(s.status).toBe('online');
  });
});

describe('shift start', () => {
  it('resets the motive steam and the standby line, and clears the lowSteam fault', () => {
    const s0 = createInitialState(1, 0, GAME_ID);
    const s = withLowSteam({ ...s0, steam: { motiveBar: 11.2, standby: true, unbilledTicks: 30 } }, 10.4);
    const started = startShift(s, 'auto').state;
    expect(started.steam).toEqual({ motiveBar: MOTIVE_STEAM_NOMINAL_BAR, standby: false, unbilledTicks: 0 });
    expect(started.faults.lowSteam).toBeNull();
  });
  it('puts Divert back on Auto, leaving the valve where it was until Auto decides', () => {
    const s0 = createInitialState(1, 0, GAME_ID);
    const s = { ...s0, product: { ...s0.product, divertMode: 'manual' as const, divertToDrain: true } };
    const started = startShift(s, 'auto').state;
    expect(started.product.divertMode).toBe('auto');
    expect(started.product.divertToDrain).toBe(true);
  });
});
