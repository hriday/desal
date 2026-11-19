import type { PlantEvent } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import {
  ACID_CLEAN_COST_USD,
  PUMP_OVERHAUL_COST_USD,
  PUMP_OVERHAUL_TICKS,
  SHIFT_TICKS,
  START_BALANCE_USD,
} from '../src/constants.js';
import { backupOrderCostUsd, tickRevenue } from '../src/economy.js';
import { applyTrip } from '../src/safety/interlocks.js';
import { endShift, startShift } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

const T0 = Date.UTC(2026, 0, 1);
const running = (): PlantState => startShift(createInitialState(1, T0, GAME_ID), 'auto').state;
const paused = (): PlantState => ({ ...running(), phase: 'paused' });
const withBalance = (s: PlantState, balanceUsd: number): PlantState => ({ ...s, run: { ...s.run, balanceUsd } });
const rejection = (events: PlantEvent[]) => events.find((e) => e.type === 'commandRejected');

describe('operating account: revenue and fines', () => {
  it('an untouched shift 1 in Auto is profitable', () => {
    let s = running();
    const events: PlantEvent[] = [];
    for (let i = 0; i < SHIFT_TICKS; i++) {
      const r = tick(s, []);
      s = r.state;
      events.push(...r.events);
    }
    const end = events.find((e) => e.type === 'shiftEnd');
    if (end?.type !== 'shiftEnd') throw new Error('shift did not end');
    const delta = s.run.balanceUsd - START_BALANCE_USD;
    console.log(
      `untouched shift 1: revenue $${end.summary.revenueUsd.toFixed(0)}, fuel $${end.summary.fuelCostUsd.toFixed(0)}, ` +
        `fines $${end.summary.finesUsd.toFixed(0)}, profit $${delta.toFixed(0)}`,
    );
    expect(s.run.balanceUsd).toBeGreaterThan(START_BALANCE_USD);
    expect(end.summary.revenueUsd).toBeCloseTo(3 * end.summary.productM3, 6);
    expect(end.summary.finesUsd).toBe(0);
    expect(end.summary.balanceUsd).toBe(s.run.balanceUsd);
    expect(delta).toBeCloseTo(end.summary.revenueUsd - end.summary.fuelCostUsd, 6);
  });

  it('tickRevenue: in-spec water earns $3/m3; off-spec earns nothing and is fined $10/m3', () => {
    expect(tickRevenue(10, false)).toEqual({ revenueUsd: 30, fineUsd: 0 });
    expect(tickRevenue(10, true)).toEqual({ revenueUsd: 0, fineUsd: 100 });
    expect(tickRevenue(0, true)).toEqual({ revenueUsd: 0, fineUsd: 0 });
  });

  it('off-spec water delivered in a running tick is fined and earns nothing', () => {
    const s0 = running();
    // A 0 ppm limit makes every delivered m3 off spec.
    const off: PlantState = { ...s0, shift: { ...s0.shift!, target: { ...s0.shift!.target, maxSalinityPpm: 0 } } };
    const s1 = tick(off, []).state;
    const acc = s1.shift!.acc;
    expect(acc.productM3).toBeGreaterThan(0);
    expect(acc.revenueUsd).toBe(0);
    expect(acc.finesUsd).toBeCloseTo(10 * acc.productM3, 9);
    expect(s1.run.balanceUsd).toBeCloseTo(START_BALANCE_USD - acc.finesUsd - acc.fuelCostUsd, 9);
  });
});

describe('operating account: fuel', () => {
  it('burning gas is charged per tick', () => {
    const s1 = tick(running(), []).state;
    const acc = s1.shift!.acc;
    expect(acc.fuelCostUsd).toBeGreaterThan(0);
    expect(s1.run.balanceUsd).toBeCloseTo(START_BALANCE_USD + acc.revenueUsd - acc.fuelCostUsd, 9);
  });

  it('burning backup fuel costs nothing per tick', () => {
    const s0 = running();
    const backup: PlantState = { ...s0, fuel: { ...s0.fuel, active: 'backup' } };
    const s1 = tick(backup, []).state;
    expect(s1.fuel.backup.tonnes).toBeLessThan(200);
    expect(s1.shift!.acc.fuelCostUsd).toBe(0);
    expect(s1.run.balanceUsd).toBeCloseTo(START_BALANCE_USD + s1.shift!.acc.revenueUsd, 9);
  });

  it('ordering backup fuel costs tonnes x LHV(offered grade) x backup price, charged on order', () => {
    const s0 = paused();
    expect(backupOrderCostUsd(s0, 10)).toBeCloseTo(10 * 42.5 * 14, 9);
    const r = tick(s0, [env(s0, { type: 'orderFuel', tonnes: 10 })]);
    expect(r.state.run.balanceUsd).toBeCloseTo(START_BALANCE_USD - 5950, 9);
    expect(r.state.fuel.deliveries).toHaveLength(1);
    const change = r.events.find((e) => e.type === 'accountChange');
    expect(change).toMatchObject({ type: 'accountChange', cause: 'delivery', deltaUsd: -5950, balanceUsd: START_BALANCE_USD - 5950 });

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
});

describe('operating account: repairs', () => {
  it('acid cleaning is charged when it starts, and rejected when unaffordable', () => {
    const tripped = applyTrip(paused(), 'manual').state;
    const r = tick(tripped, [env(tripped, { type: 'acidClean' })]);
    expect(r.state.status).toBe('acidCleaning');
    expect(r.state.run.balanceUsd).toBe(START_BALANCE_USD - ACID_CLEAN_COST_USD);
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
    const s0: PlantState = {
      ...base,
      intake: {
        ...base.intake,
        pumps: { ...base.intake.pumps, 'P-103': { ...base.intake.pumps['P-103'], wear: 0.6, cavitation: 0.3, bearingWearMult: 4 } },
      },
    };

    const onRunning = tick(s0, [env(s0, { type: 'overhaulPump', pumpId: 'P-101' })]);
    expect(rejection(onRunning.events)).toMatchObject({ reason: expect.stringMatching(/running/) });
    expect(onRunning.state.run.balanceUsd).toBe(START_BALANCE_USD);

    const poor = withBalance(s0, 7999);
    const p = tick(poor, [env(poor, { type: 'overhaulPump', pumpId: 'P-103' })]);
    expect(rejection(p.events)).toMatchObject({ reason: 'insufficient funds' });
    expect(p.state.intake.pumps['P-103'].overhaulRemainingTicks).toBe(0);

    let s = tick(s0, [env(s0, { type: 'overhaulPump', pumpId: 'P-103' })]).state;
    expect(s.run.balanceUsd).toBe(START_BALANCE_USD - 8000);
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
});

describe('operating account: shift end', () => {
  it('a shift ending 500 m3 short is fined $2,000, and the summary reports it', () => {
    const s0 = running();
    const short: PlantState = {
      ...s0,
      shift: { ...s0.shift!, acc: { ...s0.shift!.acc, productM3: s0.shift!.target.productM3 - 500, revenueUsd: 1234 } },
    };
    const r = endShift(short);
    expect(r.state.run.balanceUsd).toBe(START_BALANCE_USD - 2000);
    const change = r.events.find((e) => e.type === 'accountChange');
    expect(change).toMatchObject({ cause: 'shortfallFine', deltaUsd: -2000, balanceUsd: START_BALANCE_USD - 2000 });
    const end = r.events.find((e) => e.type === 'shiftEnd');
    if (end?.type !== 'shiftEnd') throw new Error('no shiftEnd');
    expect(end.summary.finesUsd).toBe(2000);
    expect(end.summary.revenueUsd).toBe(1234);
    expect(end.summary.balanceUsd).toBe(START_BALANCE_USD - 2000);
  });

  it('a shift meeting its target is not fined', () => {
    const s0 = running();
    const met: PlantState = { ...s0, shift: { ...s0.shift!, acc: { ...s0.shift!.acc, productM3: s0.shift!.target.productM3 + 10 } } };
    const r = endShift(met);
    expect(r.state.run.balanceUsd).toBe(START_BALANCE_USD);
    expect(r.events.some((e) => e.type === 'accountChange')).toBe(false);
  });
});
