import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/commands.js';
import { LOOP_RANGES, PLANT_MAX_PRODUCT_M3H, SHIFT_TICKS } from '../src/constants.js';
import { startShift } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

/** A calm shift 1 (no chaos events) driven flat out: hottest TBT setpoint, most recirculation. */
function flatOut() {
  let s: PlantState = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
  s = { ...s, chaos: { ...s.chaos, active: { ...s.chaos.active!, plan: { ...s.chaos.active!.plan, queue: [] } } } };
  for (const [loop, value] of [['tbt', LOOP_RANGES.tbt.spMax], ['recirc', LOOP_RANGES.recirc.spMax]] as const) {
    const r = applyCommand(s, env(s, { type: 'setSetpoint', loop, value }));
    if (r.events.some((e) => e.type === 'commandRejected')) throw new Error(`${loop} setpoint rejected`);
    s = r.state;
  }
  let maxFlow = 0;
  let trips = 0;
  for (let i = 0; i < SHIFT_TICKS - 1; i++) {
    const r = tick(s, []);
    s = r.state;
    trips += r.events.filter((e) => e.type === 'trip').length;
    maxFlow = Math.max(maxFlow, s.product.flowM3h);
  }
  return { maxFlow, trips, salinityPpm: s.product.salinityPpm };
}

describe('PLANT_MAX_PRODUCT_M3H', () => {
  it('is the product flow the plant really reaches flat out (TBT 112 C, recirc 6500), within 3 %', () => {
    const run = flatOut();
    console.log(`flat-out product flow ${run.maxFlow.toFixed(1)} m3/h (constant ${PLANT_MAX_PRODUCT_M3H})`);
    expect(run.trips).toBe(0);
    expect(run.salinityPpm).toBeLessThan(25);
    expect(Math.abs(run.maxFlow - PLANT_MAX_PRODUCT_M3H) / PLANT_MAX_PRODUCT_M3H).toBeLessThanOrEqual(0.03);
  });
});
