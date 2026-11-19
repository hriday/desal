import type { PlantEvent } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import {
  ACID_CLEAN_COST_USD,
  ALLOC_BASE_USD,
  PUMP_OVERHAUL_COST_USD,
  PUMP_OVERHAUL_TICKS,
  SHIFT_TICKS,
  STANDING_COST_USD_PER_HOUR,
  START_BALANCE_USD,
} from '../src/constants.js';
import { allocationUsd, backupOrderCostUsd } from '../src/economy.js';
import { applyTrip } from '../src/safety/interlocks.js';
import { endShift, startShift } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

const T0 = Date.UTC(2026, 0, 1);
const running = (): PlantState => startShift(createInitialState(1, T0, GAME_ID), 'auto').state;
/** One running tick's share of the hourly standing cost (90 ticks per plant hour). */
const STANDING_PER_TICK = STANDING_COST_USD_PER_HOUR / 90;
const paused = (): PlantState => ({ ...running(), phase: 'paused' });
const withBalance = (s: PlantState, balanceUsd: number): PlantState => ({ ...s, run: { ...s.run, balanceUsd } });
const rejection = (events: PlantEvent[]) => events.find((e) => e.type === 'commandRejected');
const summaryOf = (events: PlantEvent[]) => {
  const end = events.find((e) => e.type === 'shiftEnd');
  if (end?.type !== 'shiftEnd') throw new Error('no shiftEnd');
  return end.summary;
};

describe('allocation', () => {
  it('starts at $15,000 and shift 1 is allocated $10,000 at startShift', () => {
    expect(START_BALANCE_USD).toBe(15000);
    expect(ALLOC_BASE_USD).toBe(10000);
    const r = startShift(createInitialState(1, T0, GAME_ID), 'auto');
    expect(r.state.run.balanceUsd).toBe(25000);
    expect(r.events.find((e) => e.type === 'accountChange')).toMatchObject({
      cause: 'allocation',
      deltaUsd: 10000,
      balanceUsd: 25000,
      shiftId: 1,
    });
  });

  it('allocationUsd = 10000 x (1 - 0.03(n-1)) x min(1, prev in-spec / prev target), floored at 0', () => {
    expect(allocationUsd(1, null)).toBe(10000);
    expect(allocationUsd(2, { productM3: 4000, targetM3: 4000 })).toBeCloseTo(9700, 9);
    expect(allocationUsd(2, { productM3: 5000, targetM3: 4000 })).toBeCloseTo(9700, 9);
    expect(allocationUsd(2, { productM3: 2000, targetM3: 4000 })).toBeCloseTo(4850, 9);
    expect(allocationUsd(11, { productM3: 3000, targetM3: 4000 })).toBeCloseTo(10000 * 0.7 * 0.75, 9);
    expect(allocationUsd(40, { productM3: 4000, targetM3: 4000 })).toBe(0);
    expect(allocationUsd(2, { productM3: -5, targetM3: 4000 })).toBe(0);
  });

  it('the next shift is allocated by the previous shift in-spec water, as the summary predicted', () => {
    const s0 = running();
    const half: PlantState = {
      ...s0,
      shift: { ...s0.shift!, acc: { ...s0.shift!.acc, productM3: s0.shift!.target.productM3 / 2 } },
    };
    const end = endShift(half);
    const predicted = summaryOf(end.events.map((e) => ({ ...e, gameId: GAME_ID, seq: 0 }) as PlantEvent)).nextAllocationUsd;
    expect(predicted).toBeCloseTo(10000 * 0.97 * 0.5, 9);
    const next = startShift(end.state, 'auto');
    expect(next.state.run.balanceUsd).toBeCloseTo(end.state.run.balanceUsd + predicted, 9);
    expect(next.events.find((e) => e.type === 'accountChange')).toMatchObject({ cause: 'allocation' });
  });
});

describe('water first: in-spec water is what counts', () => {
  it('an untouched shift 1 in Auto meets its target in spec with no surprise charges', () => {
    let s = running();
    const startBalance = s.run.balanceUsd;
    const events: PlantEvent[] = [];
    for (let i = 0; i < SHIFT_TICKS; i++) {
      const r = tick(s, []);
      s = r.state;
      events.push(...r.events);
    }
    const sum = summaryOf(events);
    console.log(
      `untouched shift 1: in-spec ${sum.productM3.toFixed(0)}/${sum.targetM3} m3, spent $${sum.spentUsd.toFixed(0)}, ` +
        `balance $${sum.balanceUsd.toFixed(0)}, next allocation $${sum.nextAllocationUsd.toFixed(0)}`,
    );
    expect(startBalance).toBe(START_BALANCE_USD + ALLOC_BASE_USD);
    expect(sum.productM3).toBeGreaterThanOrEqual(sum.targetM3);
    expect(sum.offSpecM3).toBe(0);
    // Fuel plus 8 hours of standing cost; the only account reports are the hourly standing charges.
    expect(sum.spentUsd).toBeCloseTo(sum.fuelCostUsd + 8 * STANDING_COST_USD_PER_HOUR, 6);
    expect(s.run.balanceUsd).toBeGreaterThanOrEqual(START_BALANCE_USD + ALLOC_BASE_USD - sum.spentUsd - 1e-6);
    expect(sum.balanceUsd).toBe(s.run.balanceUsd);
    expect(sum.nextAllocationUsd).toBeCloseTo(10000 * 0.97, 9);
    const accounts = events.filter((e) => e.type === 'accountChange');
    expect(accounts).toHaveLength(8);
    expect(accounts.every((e) => e.type === 'accountChange' && e.cause === 'standing')).toBe(true);
  });

  it('off-spec water does not count toward progress and is tracked separately; it earns and costs nothing', () => {
    const s0 = running();
    // A 0 ppm limit makes every delivered m3 off spec.
    const off: PlantState = { ...s0, shift: { ...s0.shift!, target: { ...s0.shift!.target, maxSalinityPpm: 0 } } };
    const s1 = tick(off, []).state;
    const acc = s1.shift!.acc;
    expect(acc.productM3).toBe(0);
    expect(acc.offSpecM3).toBeGreaterThan(0);
    expect(s1.run.balanceUsd).toBeCloseTo(s0.run.balanceUsd - acc.spentUsd, 9);
    expect(acc.spentUsd).toBeCloseTo(acc.fuelCostUsd + STANDING_PER_TICK, 9);
  });

  it('a shift ending 500 m3 short is not fined; only its next allocation shrinks', () => {
    const s0 = running();
    const target = s0.shift!.target.productM3;
    const short: PlantState = { ...s0, shift: { ...s0.shift!, acc: { ...s0.shift!.acc, productM3: target - 500 } } };
    const r = endShift(short);
    expect(r.state.run.balanceUsd).toBe(s0.run.balanceUsd);
    expect(r.events.some((e) => e.type === 'accountChange')).toBe(false);
    const sum = summaryOf(r.events.map((e) => ({ ...e, gameId: GAME_ID, seq: 0 }) as PlantEvent));
    expect(sum.nextAllocationUsd).toBeCloseTo(9700 * ((target - 500) / target), 9);
    expect(r.state.run.totalProductM3).toBe(target - 500);
  });
});

describe('spending', () => {
  it('burning gas is charged per tick and counted as spent', () => {
    const s0 = running();
    const s1 = tick(s0, []).state;
    const acc = s1.shift!.acc;
    expect(acc.fuelCostUsd).toBeGreaterThan(0);
    expect(acc.spentUsd).toBeCloseTo(acc.fuelCostUsd + STANDING_PER_TICK, 9);
    expect(s1.run.balanceUsd).toBeCloseTo(s0.run.balanceUsd - acc.fuelCostUsd - STANDING_PER_TICK, 9);
  });

  it('burning backup fuel costs nothing per tick (only the standing cost is spent)', () => {
    const s0 = running();
    const backup: PlantState = { ...s0, fuel: { ...s0.fuel, active: 'backup' } };
    const s1 = tick(backup, []).state;
    expect(s1.fuel.backup.tonnes).toBeLessThan(200);
    expect(s1.shift!.acc.fuelCostUsd).toBe(0);
    expect(s1.shift!.acc.spentUsd).toBeCloseTo(STANDING_PER_TICK, 9);
    expect(s1.run.balanceUsd).toBeCloseTo(s0.run.balanceUsd - STANDING_PER_TICK, 9);
  });

  it('ordering backup fuel costs tonnes x LHV(offered grade) x backup price, charged on order', () => {
    const s0 = paused();
    const b0 = s0.run.balanceUsd;
    expect(backupOrderCostUsd(s0, 10)).toBeCloseTo(10 * 42.5 * 14, 9);
    const r = tick(s0, [env(s0, { type: 'orderFuel', tonnes: 10 })]);
    expect(r.state.run.balanceUsd).toBeCloseTo(b0 - 5950, 9);
    expect(r.state.shift!.acc.spentUsd).toBeCloseTo(5950, 9);
    expect(r.state.fuel.deliveries).toHaveLength(1);
    expect(r.events.find((e) => e.type === 'accountChange')).toMatchObject({ cause: 'delivery', deltaUsd: -5950, balanceUsd: b0 - 5950 });
    const offgrade: PlantState = { ...s0, scenario: { ...s0.scenario, effects: { ...s0.scenario.effects, offgradeOnly: true } } };
    expect(backupOrderCostUsd(offgrade, 10)).toBeCloseTo(10 * 38 * 14, 9);
  });

  it('an unaffordable order is rejected and leaves the balance unchanged', () => {
    const s0 = withBalance(paused(), 100);
    const r = tick(s0, [env(s0, { type: 'orderFuel', tonnes: 10 })]);
    expect(rejection(r.events)).toMatchObject({ reason: 'insufficient funds' });
    expect(r.state.run.balanceUsd).toBe(100);
    expect(r.state.fuel.deliveries).toEqual([]);
    expect(r.events.some((e) => e.type === 'accountChange')).toBe(false);
  });

  it('acid cleaning is charged when it starts, counted as spent, and rejected when unaffordable', () => {
    const tripped = applyTrip(paused(), 'manual').state;
    const b0 = tripped.run.balanceUsd;
    const r = tick(tripped, [env(tripped, { type: 'acidClean' })]);
    expect(r.state.status).toBe('acidCleaning');
    expect(r.state.run.balanceUsd).toBe(b0 - ACID_CLEAN_COST_USD);
    expect(r.state.shift!.acc.spentUsd).toBe(ACID_CLEAN_COST_USD);
    expect(r.events.find((e) => e.type === 'accountChange')).toMatchObject({ cause: 'acidClean', deltaUsd: -6000 });

    const poor = withBalance(tripped, 5999);
    const p = tick(poor, [env(poor, { type: 'acidClean' })]);
    expect(rejection(p.events)).toMatchObject({ reason: 'insufficient funds' });
    expect(p.state.status).toBe('tripped');
    expect(p.state.run.balanceUsd).toBe(5999);
  });

  it('overhaul: rejected on a running pump; charges $8,000; the pump cannot start for 90 ticks; wear reset', () => {
    expect(PUMP_OVERHAUL_COST_USD).toBe(8000);
    expect(PUMP_OVERHAUL_TICKS).toBe(90);
    const base = paused();
    const b0 = base.run.balanceUsd;
    const s0: PlantState = {
      ...base,
      intake: {
        ...base.intake,
        pumps: { ...base.intake.pumps, 'P-103': { ...base.intake.pumps['P-103'], wear: 0.6, cavitation: 0.3, bearingWearMult: 4 } },
      },
    };

    const onRunning = tick(s0, [env(s0, { type: 'overhaulPump', pumpId: 'P-101' })]);
    expect(rejection(onRunning.events)).toMatchObject({ reason: expect.stringMatching(/running/) });
    expect(onRunning.state.run.balanceUsd).toBe(b0);

    const poor = withBalance(s0, 7999);
    const p = tick(poor, [env(poor, { type: 'overhaulPump', pumpId: 'P-103' })]);
    expect(rejection(p.events)).toMatchObject({ reason: 'insufficient funds' });
    expect(p.state.intake.pumps['P-103'].overhaulRemainingTicks).toBe(0);

    let s = tick(s0, [env(s0, { type: 'overhaulPump', pumpId: 'P-103' })]).state;
    expect(s.run.balanceUsd).toBe(b0 - 8000);
    expect(s.shift!.acc.spentUsd).toBe(8000);
    expect(s.intake.pumps['P-103'].overhaulRemainingTicks).toBe(90);

    const again = tick(s, [env(s, { type: 'overhaulPump', pumpId: 'P-103' })]);
    expect(rejection(again.events)).toMatchObject({ reason: 'under overhaul' });

    // Paused ticks do not count the overhaul down.
    s = tick(s, []).state;
    expect(s.intake.pumps['P-103'].overhaulRemainingTicks).toBe(90);

    s = { ...s, phase: 'running' };
    for (let i = 0; i < PUMP_OVERHAUL_TICKS - 1; i++) {
      const r = tick(s, [env(s, { type: 'pump', pumpId: 'P-103', action: 'start' })]);
      expect(rejection(r.events)).toMatchObject({ reason: 'under overhaul' });
      s = r.state;
      expect(s.intake.pumps['P-103'].running).toBe(false);
      expect(s.intake.pumps['P-103'].wear).toBe(0.6);
    }
    s = tick(s, []).state;
    expect(s.intake.pumps['P-103']).toEqual({ running: false, wear: 0, cavitation: 0, bearingWearMult: 1, overhaulRemainingTicks: 0 });
    const started = tick(s, [env(s, { type: 'pump', pumpId: 'P-103', action: 'start' })]);
    expect(rejection(started.events)).toBeUndefined();
    expect(started.state.intake.pumps['P-103'].running).toBe(true);
  });

  it('no automatic path starts a pump under overhaul (trip, Auto restart, shift change)', () => {
    let s = paused();
    s = tick(s, [env(s, { type: 'pump', pumpId: 'P-102', action: 'stop' })]).state;
    s = tick(s, [env(s, { type: 'overhaulPump', pumpId: 'P-102' })]).state;
    s = { ...s, phase: 'running' };
    s = tick(s, [env(s, { type: 'manualTrip' })]).state;
    s = tick(s, [env(s, { type: 'restart' })]).state;
    for (let i = 0; i < 80; i++) {
      s = tick(s, []).state;
      expect(s.intake.pumps['P-102'].running).toBe(false);
    }
    expect(s.intake.pumps['P-102'].overhaulRemainingTicks).toBeGreaterThan(0);
    // Across a handover and into the next shift.
    s = { ...s, tick: s.shift!.startTick + SHIFT_TICKS - 1 };
    s = tick(s, []).state;
    expect(s.phase).toBe('handover');
    s = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]).state;
    s = tick(s, []).state;
    expect(s.intake.pumps['P-102'].running).toBe(false);
    expect(s.intake.pumps['P-102'].overhaulRemainingTicks).toBeGreaterThan(0);
  });
});

describe('standing cost', () => {
  const calm = (s: PlantState): PlantState =>
    s.chaos.active ? { ...s, chaos: { ...s.chaos, active: { ...s.chaos.active, plan: { ...s.chaos.active.plan, queue: [] } } } } : s;
  const standingEvents = (events: PlantEvent[]) => events.filter((e) => e.type === 'accountChange' && e.cause === 'standing');

  it('is at most 15 % of the shift-1 allocation per shift', () => {
    expect(STANDING_COST_USD_PER_HOUR).toBeGreaterThan(0);
    expect(STANDING_COST_USD_PER_HOUR * 8).toBeLessThanOrEqual(0.15 * allocationUsd(1, null));
  });

  it('a tripped plant held for a shift loses 8 hours of standing cost, reported once per plant hour', () => {
    let s = calm(applyTrip(running(), 'manual').state);
    const b0 = s.run.balanceUsd;
    const events: PlantEvent[] = [];
    for (let i = 0; i < SHIFT_TICKS; i++) {
      const r = tick(s, []);
      s = r.state;
      events.push(...r.events);
    }
    expect(s.status).toBe('tripped');
    const sum = summaryOf(events);
    expect(sum.fuelCostUsd).toBe(0);
    expect(sum.spentUsd).toBeCloseTo(STANDING_COST_USD_PER_HOUR * 8, 6);
    expect(s.run.balanceUsd).toBeCloseTo(b0 - STANDING_COST_USD_PER_HOUR * 8, 6);
    const hourly = standingEvents(events);
    expect(hourly).toHaveLength(8);
    for (const e of hourly) expect(e).toMatchObject({ deltaUsd: -STANDING_COST_USD_PER_HOUR, shiftId: 1 });
    // The last hour's charge is reported before the shift ends.
    expect(events.indexOf(hourly[7]!)).toBeLessThan(events.findIndex((e) => e.type === 'shiftEnd'));
  });

  it('is charged every running tick, whatever the plant status', () => {
    for (const status of ['online', 'tripped', 'restarting', 'acidCleaning'] as const) {
      const s1 = tick(calm({ ...running(), status }), []).state;
      const standing = s1.shift!.acc.spentUsd - s1.shift!.acc.fuelCostUsd;
      expect(standing, status).toBeCloseTo(STANDING_PER_TICK, 9);
    }
  });

  it('nothing is charged while paused or in handover', () => {
    for (const s0 of [paused(), createInitialState(1, T0, GAME_ID)]) {
      let s = s0;
      const events: PlantEvent[] = [];
      for (let i = 0; i < 200; i++) {
        const r = tick(s, []);
        s = r.state;
        events.push(...r.events);
      }
      expect(s.run.balanceUsd).toBe(s0.run.balanceUsd);
      expect(standingEvents(events)).toEqual([]);
    }
  });
});
