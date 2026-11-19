import { describe, expect, it } from 'vitest';
import { createInitialState, type PlantState } from '../../src/state.js';
import { stepFuel } from '../../src/units/fuel.js';
import { allFinite } from '../helpers.js';
import { GAME_ID } from '../envelope.js';

const DT = 40;

function base(): PlantState {
  const s = createInitialState(1, 0, GAME_ID);
  return {
    ...s,
    fuel: {
      ...s.fuel,
      active: 'gas',
      changeover: null,
      gas: { capMW: 60, priceUsdPerGJ: 8, curtailmentNotice: null },
      backup: { tonnes: 100, grade: 'standard', priceUsdPerGJ: 12 },
      deliveries: [],
    },
  };
}

function withFuel(s: PlantState, f: Partial<PlantState['fuel']>): PlantState {
  return { ...s, fuel: { ...s.fuel, ...f } };
}

describe('stepFuel', () => {
  it('delivers gas demand and charges per tick', () => {
    const r = stepFuel(base(), 40, DT);
    expect(r.deliveredMW).toBe(40);
    expect(r.costUsd).toBeCloseTo(12.8, 9);
    expect(r.state.fuel.burnMW).toBe(40);
  });

  it('applies a due curtailment', () => {
    const s = withFuel(base(), { gas: { capMW: 60, priceUsdPerGJ: 8, curtailmentNotice: { atTick: 0, capMW: 20 } } });
    const r = stepFuel(s, 40, DT);
    expect(r.deliveredMW).toBe(20);
    expect(r.state.fuel.gas.capMW).toBe(20);
    expect(r.state.fuel.gas.curtailmentNotice).toBeNull();
  });

  it('does not apply a future curtailment', () => {
    const s = withFuel(base(), { gas: { capMW: 60, priceUsdPerGJ: 8, curtailmentNotice: { atTick: 5, capMW: 20 } } });
    expect(stepFuel(s, 40, DT).deliveredMW).toBe(40);
  });

  it('caps delivery at 30 MW for 8 ticks of changeover then switches', () => {
    let s = withFuel(base(), { changeover: { to: 'backup', remainingTicks: 8 } });
    for (let i = 0; i < 8; i++) {
      expect(s.fuel.active).toBe('gas');
      const r = stepFuel(s, 50, DT);
      expect(r.deliveredMW).toBe(30);
      s = r.state;
      if (i < 7) expect(r.events.some((e) => e.type === 'fuelChangeover')).toBe(false);
      else expect(r.events).toMatchObject([{ type: 'fuelChangeover', from: 'gas', to: 'backup', phase: 'done' }]);
    }
    expect(s.fuel.active).toBe('backup');
    expect(s.fuel.changeover).toBeNull();
    expect(stepFuel(s, 50, DT).deliveredMW).toBe(50);
  });

  it('flames out in manual mode above 60 % firing during changeover', () => {
    const s = withFuel(base(), { changeover: { to: 'backup', remainingTicks: 5 } });
    const manual = stepFuel({ ...s, controlMode: 'manual', heater: { ...s.heater, firingPct: 80 } }, 40, DT);
    expect(manual.events).toMatchObject([{ type: 'fuelChangeover', phase: 'flameOut' }]);
    expect(manual.state.trip).toBeNull();
    const auto = stepFuel({ ...s, controlMode: 'auto', heater: { ...s.heater, firingPct: 80 } }, 40, DT);
    expect(auto.events.some((e) => e.type === 'fuelChangeover')).toBe(false);
  });

  it('does not flame out in manual mode without a changeover', () => {
    const b = base();
    const s = { ...b, controlMode: 'manual' as const, heater: { ...b.heater, firingPct: 80 } };
    expect(stepFuel(s, 40, DT).events).toEqual([]);
  });

  it('caps off-grade backup at 51 MW and drains faster per MW than standard', () => {
    const off = withFuel(base(), { active: 'backup', backup: { tonnes: 100, grade: 'offgrade', priceUsdPerGJ: 12 } });
    expect(stepFuel(off, 60, DT).deliveredMW).toBe(51);

    const std = withFuel(base(), { active: 'backup' });
    const offDrain = 100 - stepFuel(off, 40, DT).state.fuel.backup.tonnes;
    const stdDrain = 100 - stepFuel(std, 40, DT).state.fuel.backup.tonnes;
    expect(offDrain).toBeGreaterThan(stdDrain);
    expect(stdDrain).toBeCloseTo((40 * DT) / (42.5 * 1000), 12);
  });

  it('delivers only what the tank holds and never goes negative', () => {
    const s = withFuel(base(), { active: 'backup', backup: { tonnes: 0.01, grade: 'standard', priceUsdPerGJ: 12 } });
    const r = stepFuel(s, 40, DT);
    expect(r.deliveredMW).toBeCloseTo((0.01 * 1000 * 42.5) / DT, 9);
    expect(r.deliveredMW).toBeLessThan(40);
    expect(r.state.fuel.backup.tonnes).toBeGreaterThanOrEqual(0);
    expect(r.state.fuel.backup.tonnes).toBeCloseTo(0, 12);
  });

  it('adds a due delivery once, sets grade, emits one event', () => {
    const s = withFuel(base(), { deliveries: [{ arrivesAtTick: 0, tonnes: 20, grade: 'offgrade' }] });
    const r = stepFuel(s, 40, DT);
    expect(r.events).toMatchObject([{ type: 'deliveryArrived', tonnes: 20, grade: 'offgrade' }]);
    expect(r.state.fuel.backup.tonnes).toBe(120);
    expect(r.state.fuel.backup.grade).toBe('offgrade');
    expect(r.state.fuel.deliveries).toEqual([]);
    expect(stepFuel(r.state, 40, DT).events).toEqual([]);
  });

  it('keeps a future delivery queued', () => {
    const s = withFuel(base(), { deliveries: [{ arrivesAtTick: 3, tonnes: 20, grade: 'standard' }] });
    const r = stepFuel(s, 40, DT);
    expect(r.events).toEqual([]);
    expect(r.state.fuel.deliveries).toHaveLength(1);
  });

  it('empty backup with zero gas cap delivers 0 with no NaN', () => {
    const s = withFuel(base(), {
      active: 'backup',
      gas: { capMW: 0, priceUsdPerGJ: 8, curtailmentNotice: null },
      backup: { tonnes: 0, grade: 'standard', priceUsdPerGJ: 12 },
    });
    const r = stepFuel(s, 40, DT);
    expect(r.deliveredMW).toBe(0);
    expect(r.costUsd).toBe(0);
    expect(allFinite(r)).toBe(true);
  });

  it('does not mutate its input', () => {
    const s = withFuel(base(), { changeover: { to: 'backup', remainingTicks: 2 } });
    const snap = JSON.stringify(s);
    stepFuel(s, 40, DT);
    expect(JSON.stringify(s)).toBe(snap);
  });
});
