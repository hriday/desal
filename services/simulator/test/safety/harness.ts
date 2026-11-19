import type { PlantEvent } from '@desal/schema';
import { TICK_PLANT_S } from '../../src/constants.js';
import type { PlantState } from '../../src/state.js';
import { stepPlant } from '../../src/tick.js';

/**
 * One plant step through the real orchestrator (src/tick.ts stepPlant), then advance the clock.
 * Unlike tick(), it runs regardless of phase and keeps no shift accumulators, so the safety tests
 * can drive a bare initial state.
 */
export function tickOnce(s0: PlantState): { state: PlantState; events: PlantEvent[] } {
  const { state, events } = stepPlant(s0);
  return { state: { ...state, tick: state.tick + 1, plantTime: state.plantTime + TICK_PLANT_S * 1000 }, events };
}

/** Run ticks until done(state) or the limit; returns the final state, all events, and ticks run. */
export function runUntil(
  s0: PlantState,
  limit: number,
  done: (s: PlantState) => boolean = () => false,
): { state: PlantState; events: PlantEvent[]; ticks: number } {
  let s = s0;
  const events: PlantEvent[] = [];
  let ticks = 0;
  while (ticks < limit && !done(s)) {
    const r = tickOnce(s);
    s = r.state;
    events.push(...r.events);
    ticks++;
  }
  return { state: s, events, ticks };
}
