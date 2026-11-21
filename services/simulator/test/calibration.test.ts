import type { PlantEvent } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { DISTILLATE_DENSITY, LATENT_J_kg, SHIFT_TICKS, TICK_PLANT_S } from '../src/constants.js';
import { startShift } from '../src/shift.js';
import { createInitialState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { GAME_ID } from './envelope.js';

/** An untouched shift 1 in Auto: no commands for the whole shift. */
function untouchedShift() {
  let s = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
  const events: PlantEvent[] = [];
  let maxSalinity = 0;
  let minLevel = Infinity;
  let maxLevel = -Infinity;
  let distillateKg = 0;
  let heatJ = 0;
  for (let i = 0; i < SHIFT_TICKS; i++) {
    const r = tick(s, []);
    s = r.state;
    events.push(...r.events);
    maxSalinity = Math.max(maxSalinity, s.product.salinityPpm);
    for (const st of s.stages) {
      minLevel = Math.min(minLevel, st.levelM);
      maxLevel = Math.max(maxLevel, st.levelM);
    }
    distillateKg += (s.product.flowM3h * DISTILLATE_DENSITY * TICK_PLANT_S) / 3600;
    heatJ += s.heater.heatMW * 1e6 * TICK_PLANT_S;
  }
  const end = events.find((e) => e.type === 'shiftEnd');
  if (end?.type !== 'shiftEnd') throw new Error('shift did not end');
  return { s, events, summary: end.summary, maxSalinity, minLevel, maxLevel, gor: distillateKg / (heatJ / LATENT_J_kg) };
}

describe('calibration: untouched shift 1 in Auto', () => {
  const run = untouchedShift();

  it('meets the product target (3,900-4,300 m3)', () => {
    expect(run.summary.productM3).toBeGreaterThanOrEqual(3900);
    expect(run.summary.productM3).toBeLessThanOrEqual(4300);
    expect(run.summary.productM3).toBeGreaterThanOrEqual(run.summary.targetM3);
  });

  it('keeps product salinity under 25 ppm throughout, with no off-spec time', () => {
    expect(run.maxSalinity).toBeLessThan(25);
    expect(run.summary.offSpecMinutes).toBe(0);
  });

  it('does not trip', () => {
    expect(run.events.filter((e) => e.type === 'trip')).toEqual([]);
    expect(run.summary.trips).toBe(0);
  });

  it('stays under the fuel budget', () => {
    expect(run.summary.fuelCostUsd).toBeLessThan(12000);
    expect(run.summary.fuelCostUsd).toBeLessThan(run.summary.fuelBudgetUsd);
  });

  it('runs at a GOR of 7-9', () => {
    expect(run.gor).toBeGreaterThanOrEqual(7);
    expect(run.gor).toBeLessThanOrEqual(9);
  });

  it('holds every stage level within 0.15-0.6 m', () => {
    expect(run.minLevel).toBeGreaterThanOrEqual(0.15);
    expect(run.maxLevel).toBeLessThanOrEqual(0.6);
  });
});
