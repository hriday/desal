import { describe, expect, it } from 'vitest';
import { applyTrip, checkInterlocks } from '../../src/safety/interlocks.js';
import { createInitialState, type PlantState } from '../../src/state.js';
import { allFinite } from '../helpers.js';

const NOMINAL_MW = 37.8;

function online(): PlantState {
  return createInitialState(1, 0);
}

function withTbt(s: PlantState, tbtC: number): PlantState {
  return { ...s, heater: { ...s.heater, tbtC } };
}

function withLevel(s: PlantState, i: number, levelM: number): PlantState {
  return { ...s, stages: s.stages.map((st, j) => (j === i ? { ...st, levelM } : st)) };
}

function withIntake(s: PlantState, flowM3h: number): PlantState {
  return { ...s, intake: { ...s.intake, flowM3h, requiredM3h: 5000 } };
}

describe('checkInterlocks', () => {
  it('is clear at nominal', () => {
    expect(checkInterlocks(online(), NOMINAL_MW)).toBeNull();
  });

  it('trips on TBT high-high at 118 C, not just below', () => {
    expect(checkInterlocks(withTbt(online(), 118), NOMINAL_MW)).toBe('tbtHighHigh');
    expect(checkInterlocks(withTbt(online(), 117.99), NOMINAL_MW)).toBeNull();
  });

  it('trips on any stage level at 0.8 m, not just below', () => {
    expect(checkInterlocks(withLevel(online(), 13, 0.8), NOMINAL_MW)).toBe('stageFlood');
    expect(checkInterlocks(withLevel(online(), 13, 0.79), NOMINAL_MW)).toBeNull();
  });

  it('trips on vacuum below 0.6, not at 0.6', () => {
    expect(checkInterlocks({ ...online(), vacuum: { quality: 0.599 } }, NOMINAL_MW)).toBe('lossOfVacuum');
    expect(checkInterlocks({ ...online(), vacuum: { quality: 0.6 } }, NOMINAL_MW)).toBeNull();
  });

  it('trips on intake flow below 20 % of required, not at 20 %', () => {
    expect(checkInterlocks(withIntake(online(), 999), NOMINAL_MW)).toBe('noIntakeFlow');
    expect(checkInterlocks(withIntake(online(), 1000), NOMINAL_MW)).toBeNull();
  });

  it('trips on no delivered fuel while online', () => {
    expect(checkInterlocks(online(), 0)).toBe('noFuel');
    expect(checkInterlocks(online(), 0.01)).toBeNull();
  });

  it('does not trip on no fuel while restarting before ignition', () => {
    const s: PlantState = {
      ...online(),
      status: 'restarting',
      restart: { step: 'recirc', stepStartedTick: 0, auto: true, prevFiringPct: 0, progressTick: 0, bestTbtC: 0 },
    };
    expect(checkInterlocks(s, 0)).toBeNull();
    const ramp: PlantState = { ...s, tick: 5, restart: { ...s.restart!, step: 'ramp', stepStartedTick: 4 } };
    expect(checkInterlocks(ramp, 0)).toBe('noFuel');
  });

  it('suppresses loss of vacuum only during the restart vacuum step', () => {
    const s: PlantState = {
      ...online(),
      status: 'restarting',
      vacuum: { quality: 0.4 },
      restart: { step: 'vacuum', stepStartedTick: 0, auto: true, prevFiringPct: 0, progressTick: 0, bestTbtC: 0 },
    };
    expect(checkInterlocks(s, 0)).toBeNull();
    expect(checkInterlocks({ ...s, restart: { ...s.restart!, step: 'recirc' } }, 0)).toBe('lossOfVacuum');
  });

  it('is silent while tripped or acid cleaning', () => {
    expect(checkInterlocks({ ...withTbt(online(), 130), status: 'tripped' }, 0)).toBeNull();
    expect(checkInterlocks({ ...withTbt(online(), 130), status: 'acidCleaning' }, 0)).toBeNull();
  });
});

describe('applyTrip', () => {
  it('zeroes firing, trips, and adds thermal-cycling damage', () => {
    const s = { ...online(), tick: 42 };
    const { state, events } = applyTrip(s, 'tbtHighHigh');
    expect(state.status).toBe('tripped');
    expect(state.trip).toEqual({ cause: 'tbtHighHigh', atTick: 42 });
    expect(state.restart).toBeNull();
    expect(state.loops.tbt.output).toBe(0);
    expect(state.heater.firingPct).toBe(0);
    state.stages.forEach((st, i) => expect(st.hardScaleMm).toBeCloseTo(i < 5 ? 0.02 : 0, 12));
    expect(state.heater.burnerCondition).toBeCloseTo(0.99, 12);
    expect(events.map((e) => e.type)).toEqual(['trip', 'damage', 'damage']);
    expect(events[0]).toMatchObject({ type: 'trip', cause: 'tbtHighHigh', tick: 42, shiftId: null });
    expect(events.slice(1)).toEqual([
      expect.objectContaining({ component: 'stageScale', value: 0.02 }),
      expect.objectContaining({ component: 'burner', value: 0.01 }),
    ]);
    expect(allFinite(state)).toBe(true);
  });

  it('does not mutate its input', () => {
    const s = online();
    applyTrip(s, 'manual');
    expect(s.status).toBe('online');
    expect(s.stages[0]?.hardScaleMm).toBe(0);
  });
});
