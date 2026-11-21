import type { PlantEvent } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import {
  COOL_CAP_NOMINAL,
  COOLING_LOSS_FALL_PER_MIN,
  COOLING_LOSS_FLOOR,
  AIR_LEAK_LOAD,
  STANDBY_EJECTORS_COST_USD_PER_H,
  STANDBY_STEAM_COST_USD_PER_H,
  TICK_PLANT_S,
} from '../src/constants.js';
import { startShift } from '../src/shift.js';
import { createInitialState, NOMINAL, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { ejectorCapacity, ejectorReadings, ejectorTrains, stepEjectors } from '../src/units/ejectors.js';
import { ejectorLoadFactor } from '../src/units/stages.js';
import { env, GAME_ID } from './envelope.js';

const TICKS_PER_MIN = 60 / TICK_PLANT_S;
const minutes = (ticks: number): number => (ticks * TICK_PLANT_S) / 60;

/** Shift 1 running in Auto with no chaos plan. */
function quiet(): PlantState {
  const s = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
  return { ...s, chaos: { ...s.chaos, active: null } };
}
type Faults = PlantState['faults'];
const withFaults = (s: PlantState, f: Partial<Faults>): PlantState => ({ ...s, faults: { ...s.faults, ...f } });
const withStandby = (s: PlantState, on: boolean): PlantState => ({ ...s, ejectors: { ...s.ejectors, standby: on } });
const standbyCmd = (s: PlantState, on: boolean) => env(s, { type: 'standbyEjectors', on });

/** Tick until a trip (or `max` ticks): the ticks it took and the trip cause, if any. */
function untilTrip(s: PlantState, max: number): { ticks: number; cause: string | null; minQ: number } {
  let minQ = s.vacuum.quality;
  for (let i = 1; i <= max; i++) {
    const r = tick(s, []);
    s = r.state;
    minQ = Math.min(minQ, s.vacuum.quality);
    const trip = r.events.find((e) => e.type === 'trip');
    if (trip && trip.type === 'trip') return { ticks: i, cause: trip.cause, minQ };
  }
  return { ticks: max, cause: null, minQ };
}

/** Run `n` ticks with no commands. */
function run(s: PlantState, n: number): PlantState {
  for (let i = 0; i < n; i++) s = tick(s, []).state;
  return s;
}

describe('ejector train capacity', () => {
  it('is exactly 1 at nominal, with one train', () => {
    const s = quiet();
    expect(ejectorTrains(s)).toBe(1);
    expect(ejectorCapacity(s)).toBe(1);
    expect(ejectorCapacity(withStandby(s, true))).toBe(1);
    expect(ejectorTrains(withStandby(s, true))).toBe(2);
    expect(ejectorTrains(withFaults(s, { ejectorFailed: true }))).toBe(0);
  });

  it('the constants are the plan\'s', () => {
    expect(COOL_CAP_NOMINAL).toBe(2);
    expect(COOLING_LOSS_FALL_PER_MIN).toBe(0.2);
    expect(COOLING_LOSS_FLOOR).toEqual([0.25, 0.4]);
    expect(AIR_LEAK_LOAD).toEqual([2.5, 3.5]);
    expect(STANDBY_EJECTORS_COST_USD_PER_H).toBe(100);
  });
});

describe('ejector readings', () => {
  it('nominal (seawater 30): stage 24 60-90 mbar, intercondenser 250, cooling out 36, vent 10', () => {
    const s0 = quiet();
    const s = run({ ...s0, seawater: { ...s0.seawater, tempC: 30 } }, 30);
    const r = ejectorReadings(s);
    expect(r.lastStageMbar).toBeGreaterThanOrEqual(60);
    expect(r.lastStageMbar).toBeLessThanOrEqual(90);
    expect(r.intercondenserMbar).toBe(250);
    expect(r.coolingOutC).toBe(36);
    expect(r.ventAirKgH).toBe(10);
  });

  it('are emitted right after vacuum.motiveSteamBar, in order', () => {
    const r = tick(quiet(), []);
    const ids = r.telemetry.map((t) => t.sensorId);
    const i = ids.indexOf('vacuum.motiveSteamBar');
    expect(ids.slice(i + 1, i + 5)).toEqual([
      'vacuum.lastStageMbar',
      'vacuum.intercondenserMbar',
      'vacuum.coolingOutC',
      'vacuum.ventAirKgH',
    ]);
    const byId = (id: string) => r.telemetry.find((t) => t.sensorId === id)!.value;
    const want = ejectorReadings(r.state);
    expect(byId('vacuum.lastStageMbar')).toBe(want.lastStageMbar);
    expect(byId('vacuum.intercondenserMbar')).toBe(250);
    expect(byId('vacuum.ventAirKgH')).toBe(10);
  });

  describe('each fault shows its own pattern', () => {
    const nominal = run(quiet(), 15);
    const base = ejectorReadings(nominal);
    /** Develop a fault for `n` ticks (or until the plant leaves online). */
    const develop = (f: Partial<Faults>, n = 15): ReturnType<typeof ejectorReadings> => {
      let s = withFaults(nominal, f);
      for (let i = 0; i < n && s.status === 'online'; i++) s = tick(s, []).state;
      return ejectorReadings(s);
    };

    it('a failed ejector (standby off): stage 24 up, intercondenser down, cooling same, vent down', () => {
      const r = develop({ ejectorFailed: true, ejectorRatePerMin: 0.01 });
      expect(r.lastStageMbar).toBeGreaterThan(base.lastStageMbar);
      expect(r.intercondenserMbar).toBeLessThan(base.intercondenserMbar);
      expect(r.coolingOutC).toBe(base.coolingOutC);
      expect(r.ventAirKgH).toBeLessThan(base.ventAirKgH);
    });

    it('coolingLoss at its floor: intercondenser at least doubles, cooling out up 6 degC or more, vent same', () => {
      const r = develop({ coolingLoss: { floor: COOLING_LOSS_FLOOR[0] } });
      expect(r.lastStageMbar).toBeGreaterThan(base.lastStageMbar);
      expect(r.intercondenserMbar).toBeGreaterThanOrEqual(2 * base.intercondenserMbar);
      expect(r.coolingOutC).toBeGreaterThanOrEqual(base.coolingOutC + 6);
      expect(r.ventAirKgH).toBe(base.ventAirKgH);
    });

    it('airLeak 3.0: vent triples, intercondenser up, cooling same', () => {
      const r = develop({ airLeak: { load: 3 } });
      expect(r.lastStageMbar).toBeGreaterThan(base.lastStageMbar);
      expect(r.ventAirKgH).toBeCloseTo(3 * base.ventAirKgH, 9);
      expect(r.intercondenserMbar).toBeGreaterThan(base.intercondenserMbar);
      expect(r.coolingOutC).toBe(base.coolingOutC);
    });

    it('lowSteam: only stage 24 moves', () => {
      const r = develop({ lowSteam: { floorBar: 10 } }, 25);
      expect(r.lastStageMbar).toBeGreaterThan(base.lastStageMbar);
      expect(r.intercondenserMbar).toBe(base.intercondenserMbar);
      expect(r.coolingOutC).toBe(base.coolingOutC);
      expect(r.ventAirKgH).toBe(base.ventAirKgH);
    });
  });
});

describe('condenser cooling ramp', () => {
  it('falls 0.2 per plant minute to the floor and stops there; snaps back to 2 when the fault clears', () => {
    let s = withFaults(quiet(), { coolingLoss: { floor: 0.3 } });
    const perTick = COOLING_LOSS_FALL_PER_MIN / TICKS_PER_MIN;
    s = stepEjectors(s, TICK_PLANT_S);
    expect(s.ejectors.coolCap).toBeCloseTo(2 - perTick, 12);
    for (let i = 0; i < 9; i++) s = stepEjectors(s, TICK_PLANT_S);
    expect(s.ejectors.coolCap).toBeCloseTo(2 - 10 * perTick, 9);
    for (let i = 0; i < 100; i++) {
      s = stepEjectors(s, TICK_PLANT_S);
      expect(s.ejectors.coolCap).toBeGreaterThanOrEqual(0.3);
    }
    expect(s.ejectors.coolCap).toBe(0.3);
    s = stepEjectors(withFaults(s, { coolingLoss: null }), TICK_PLANT_S);
    expect(s.ejectors.coolCap).toBe(2);
  });

  it('is unchanged (same object) at nominal', () => {
    const s = quiet();
    expect(stepEjectors(s, TICK_PLANT_S)).toBe(s);
  });
});

describe('unattended trip windows (nominal load, vacuum loop in Auto)', () => {
  const start = run(quiet(), 15);
  const tripMinute = (f: Partial<Faults>): number => {
    const r = untilTrip(withFaults(start, f), 120 * TICKS_PER_MIN);
    expect(r.cause).toBe('lossOfVacuum');
    return minutes(r.ticks);
  };

  for (const floor of COOLING_LOSS_FLOOR) {
    it(`coolingLoss floor ${floor} trips within 15-40 plant minutes`, () => {
      const m = tripMinute({ coolingLoss: { floor } });
      console.log(`coolingLoss floor ${floor}: trip at ${m.toFixed(2)} plant minutes`);
      expect(m).toBeGreaterThanOrEqual(15);
      expect(m).toBeLessThanOrEqual(40);
    });
  }

  for (const load of AIR_LEAK_LOAD) {
    it(`airLeak ${load} trips within 12-35 plant minutes`, () => {
      const m = tripMinute({ airLeak: { load } });
      console.log(`airLeak ${load}: trip at ${m.toFixed(2)} plant minutes`);
      expect(m).toBeGreaterThanOrEqual(12);
      expect(m).toBeLessThanOrEqual(35);
    });
  }
});

describe('holding the vacuum', () => {
  const start = run(quiet(), 15);

  it('airLeak 3.5 with the standby ejectors on holds >= 0.65 for 120 minutes', () => {
    const r = untilTrip(withStandby(withFaults(start, { airLeak: { load: 3.5 } }), true), 120 * TICKS_PER_MIN);
    expect(r.cause).toBeNull();
    expect(r.minQ).toBeGreaterThanOrEqual(0.65);
  });

  it('coolingLoss 0.25 with the standby ejectors on still trips (shared cooling header)', () => {
    const r = untilTrip(withStandby(withFaults(start, { coolingLoss: { floor: 0.25 } }), true), 120 * TICKS_PER_MIN);
    expect(r.cause).toBe('lossOfVacuum');
  });

  it('coolingLoss 0.25 with the load cut (ejectorLoadFactor <= 0.5) holds above 0.6 for 60 minutes', () => {
    let s: PlantState = { ...start, loops: { ...start.loops, tbt: { ...start.loops.tbt, setpoint: NOMINAL.tbtC - 6 } } };
    s = run(s, 60);
    expect(s.status).toBe('online');
    expect(ejectorLoadFactor(s.heater.tbtC, s.heater.firingPct)).toBeLessThanOrEqual(0.5);
    const r = untilTrip(withFaults(s, { coolingLoss: { floor: 0.25 } }), 60 * TICKS_PER_MIN);
    expect(r.cause).toBeNull();
    expect(r.minQ).toBeGreaterThan(0.6);
  });

  it('a failed ejector with the standby ejectors on: the fall stops and the vacuum recovers to >= 0.9 within 60 minutes', () => {
    // Let the failed ejector pull the vacuum down first, then switch the standby on.
    let s = withFaults(start, { ejectorFailed: true, ejectorRatePerMin: 0.01 });
    s = run(s, 10 * TICKS_PER_MIN);
    expect(s.vacuum.quality).toBeLessThan(0.9);
    s = withStandby(s, true);
    let prev = s.vacuum.quality;
    let best = prev;
    let fell = false;
    for (let i = 0; i < 60 * TICKS_PER_MIN; i++) {
      const r = tick(s, []);
      s = r.state;
      expect(r.events.find((e) => e.type === 'trip')).toBeUndefined();
      if (s.vacuum.quality < prev - 1e-12 && s.vacuum.quality < 0.95) fell = true;
      prev = s.vacuum.quality;
      best = Math.max(best, prev);
    }
    expect(fell).toBe(false);
    expect(best).toBeGreaterThanOrEqual(0.9);
  });
});

describe('standby ejectors (Review Focus 2)', () => {
  const calm = quiet;
  const accountEvents = (events: PlantEvent[], cause: string) =>
    events.filter((e) => e.type === 'accountChange' && e.cause === cause) as Array<{ deltaUsd: number }>;

  it('with no fault, the vacuum and stage 24 are identical to standby off over 90 ticks', () => {
    let a: PlantState = { ...calm(), vacuum: { quality: 0.8 } };
    let b = withStandby(a, true);
    for (let i = 0; i < 90; i++) {
      a = tick(a, []).state;
      b = tick(b, []).state;
      expect(b.vacuum.quality).toBe(a.vacuum.quality);
      expect(ejectorReadings(b).lastStageMbar).toBe(ejectorReadings(a).lastStageMbar);
    }
  });

  it('an hour of standby is one accountChange of -100 with cause standbyEjectors', () => {
    let s = calm();
    const events: PlantEvent[] = [];
    for (let i = 0; i < 90; i++) {
      const r = tick(s, i === 0 ? [standbyCmd(s, true)] : []);
      s = r.state;
      events.push(...r.events);
    }
    const billed = accountEvents(events, 'standbyEjectors');
    expect(billed).toHaveLength(1);
    expect(billed[0]!.deltaUsd).toBeCloseTo(-100, 9);
  });

  it('the standby steam line is billed the same when both are on', () => {
    const both = (on: boolean): PlantEvent[] => {
      let s = calm();
      const events: PlantEvent[] = [];
      for (let i = 0; i < 90; i++) {
        const cmds = i === 0 ? [env(s, { type: 'standbySteam', on: true }), ...(on ? [standbyCmd(s, true)] : [])] : [];
        const r = tick(s, cmds);
        s = r.state;
        events.push(...r.events);
      }
      return events;
    };
    const steamOnly = accountEvents(both(false), 'standbySteam');
    const withEj = accountEvents(both(true), 'standbySteam');
    expect(withEj).toHaveLength(1);
    expect(withEj[0]!.deltaUsd).toBeCloseTo(-STANDBY_STEAM_COST_USD_PER_H, 9);
    expect(withEj[0]!.deltaUsd).toBe(steamOnly[0]!.deltaUsd);
  });
});

describe('robustness (Review Focus 3)', () => {
  it('all faults stacked with the standby toggled every 10 ticks over 200 ticks: every reading and the quality are finite', () => {
    let s = withFaults(quiet(), {
      ejectorFailed: true,
      ejectorRatePerMin: 0.01,
      coolingLoss: { floor: 0.25 },
      airLeak: { load: 3.5 },
      lowSteam: { floorBar: 10 },
    });
    for (let i = 0; i < 200; i++) {
      const cmds = i % 10 === 0 ? [standbyCmd(s, (i / 10) % 2 === 0)] : [];
      const r = tick(s, cmds);
      s = r.state;
      expect(Number.isFinite(s.vacuum.quality)).toBe(true);
      for (const t of r.telemetry) expect(Number.isFinite(t.value), t.sensorId).toBe(true);
      for (const v of Object.values(ejectorReadings(s))) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('startShift', () => {
  it('resets the ejector train to nominal', () => {
    const s0 = quiet();
    const dirty: PlantState = { ...s0, phase: 'handover', shift: null, ejectors: { coolCap: 0.3, standby: true, unbilledTicks: 7 } };
    expect(startShift(dirty, 'auto').state.ejectors).toEqual({ coolCap: 2, standby: false, unbilledTicks: 0 });
  });
});
