import type { PlantEvent } from '@desal/schema';
import { LOOP_ACTION, LOOP_GAINS, LOOP_RANGES, TICK_PLANT_S } from '../../src/constants.js';
import { pidStep } from '../../src/control/pid.js';
import { applyTrip, checkInterlocks } from '../../src/safety/interlocks.js';
import { stepAcidClean, stepRestart } from '../../src/safety/restart.js';
import type { Loop, PlantState } from '../../src/state.js';
import { stepFuel } from '../../src/units/fuel.js';
import { heaterDemandMW, stepHeater } from '../../src/units/heater.js';
import { stepIntake } from '../../src/units/intake.js';
import { stepProduct } from '../../src/units/product.js';
import { recoveredTempC, stepStages } from '../../src/units/stages.js';

type Kind = keyof typeof LOOP_GAINS;

function step(loop: Loop, kind: Kind, measured: number): Loop {
  const { outMin, outMax } = LOOP_RANGES[kind];
  return pidStep(loop, measured, LOOP_GAINS[kind], outMin, outMax, TICK_PLANT_S, LOOP_ACTION[kind]);
}

/**
 * Step the PIDs the restart sequence does not own. While restarting, the sequence owns tbt,
 * vacuum and recirc; while tripped or acid cleaning, the burner stays off (tbt is not stepped).
 * intakeFlow and recirc are held at their outputs: their placeholder gains act on m3/h errors and
 * bang-bang the output until the calibration task retunes them.
 */
function stepLoops(s: PlantState): PlantState {
  const restarting = s.status === 'restarting';
  const burnerOff = s.status === 'tripped' || s.status === 'acidCleaning';
  const l = s.loops;
  return {
    ...s,
    loops: {
      tbt: restarting || burnerOff ? l.tbt : step(l.tbt, 'tbt', s.heater.tbtC),
      intakeFlow: l.intakeFlow,
      recirc: l.recirc,
      blowdown: step(l.blowdown, 'blowdown', s.brine.concentrationFactor),
      vacuum: restarting ? l.vacuum : step(l.vacuum, 'vacuum', s.vacuum.quality),
      levels: l.levels.map((loop, i) => step(loop, 'level', s.stages[i]?.levelM ?? loop.setpoint)),
    },
  };
}

/**
 * Test-only stand-in for the tick orchestrator (Task 12): loops, units, restart/acid-clean,
 * then interlocks.
 */
export function tickOnce(s0: PlantState): { state: PlantState; events: PlantEvent[] } {
  const dt = TICK_PLANT_S;
  const events: PlantEvent[] = [];
  let s = stepIntake(stepLoops(s0), dt);
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
