import type { PlantEvent } from '@desal/schema';
import { TICK_PLANT_S } from '../../src/constants.js';
import { applyTrip, checkInterlocks } from '../../src/safety/interlocks.js';
import { stepAcidClean, stepRestart } from '../../src/safety/restart.js';
import type { PlantState } from '../../src/state.js';
import { stepFuel } from '../../src/units/fuel.js';
import { heaterDemandMW, stepHeater } from '../../src/units/heater.js';
import { stepIntake } from '../../src/units/intake.js';
import { stepProduct } from '../../src/units/product.js';
import { recoveredTempC, stepStages } from '../../src/units/stages.js';

/**
 * Test-only stand-in for the tick orchestrator (Task 12): units, then restart/acid-clean, then
 * interlocks. No PID is stepped: every actuator holds its balance output (the plant starts at
 * equilibrium, and a trip leaves vacuum and recirc running), and during a restart the sequence
 * itself owns the tbt, vacuum and recirc outputs.
 */
export function tickOnce(s0: PlantState): { state: PlantState; events: PlantEvent[] } {
  const dt = TICK_PLANT_S;
  const events: PlantEvent[] = [];
  let s = stepIntake(s0, dt);
  const fuel = stepFuel(s, heaterDemandMW(s), dt);
  s = fuel.state;
  events.push(...fuel.events);
  s = stepHeater(s, fuel.deliveredMW, recoveredTempC(s), dt);
  const st = stepStages(s, dt);
  s = stepProduct(st.state, st.distillateM3h, st.carryover, dt).state;
  if (s.status === 'restarting') {
    const r = stepRestart(s);
    s = r.state;
    events.push(...r.events);
  }
  s = stepAcidClean(s);
  const cause = checkInterlocks(s, fuel.deliveredMW);
  if (cause) {
    const t = applyTrip(s, cause);
    s = t.state;
    events.push(...t.events);
  }
  return { state: { ...s, tick: s.tick + 1, plantTime: s.plantTime + dt }, events };
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
