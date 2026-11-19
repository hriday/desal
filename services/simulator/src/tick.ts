import type { PlantEvent, PlantStatus, TelemetryReading } from '@desal/schema';
import { applyCommand } from './commands.js';
import {
  LOOP_ACTION,
  LOOP_GAINS,
  LOOP_RANGES,
  SHIFT_TICKS,
  SNAPSHOT_EVERY_TICKS,
  TICK_PLANT_S,
} from './constants.js';
import { pidStep } from './control/pid.js';
import { toStatus, toTelemetry } from './emit.js';
import { applyTrip, checkInterlocks } from './safety/interlocks.js';
import { stepAcidClean, stepRestart } from './safety/restart.js';
import { stepScenario } from './scenario/engine.js';
import { endShift } from './shift.js';
import type { Loop, PlantState } from './state.js';
import { stepFuel } from './units/fuel.js';
import { heaterDemandMW, stepHeater } from './units/heater.js';
import { stepIntake } from './units/intake.js';
import { stepProduct } from './units/product.js';
import { recoveredTempC, stepStages } from './units/stages.js';

export interface TickResult {
  state: PlantState;
  telemetry: TelemetryReading[];
  status: PlantStatus;
  events: PlantEvent[];
  snapshotDue: boolean;
}

/** One plant step's outputs, before the shift accumulators and the clock are advanced. */
export interface PlantStep {
  state: PlantState;
  events: PlantEvent[];
  /** Product delivered this step (m3); 0 unless the plant was online. */
  deliveredM3: number;
  /** Delivered product was off spec this step. */
  offSpec: boolean;
  fuelCostUsd: number;
}

type Kind = keyof typeof LOOP_GAINS;

function stepLoop(loop: Loop, kind: Kind, measured: number): Loop {
  const { outMin, outMax } = LOOP_RANGES[kind];
  return pidStep(loop, measured, LOOP_GAINS[kind], outMin, outMax, TICK_PLANT_S, LOOP_ACTION[kind]);
}

/**
 * Step every PID on its measured value. While restarting, the restart sequence owns tbt, vacuum
 * and recirc; while tripped or acid cleaning, the burner is locked out (tbt is not stepped).
 */
function stepLoops(s: PlantState): PlantState {
  const restarting = s.status === 'restarting';
  const burnerOff = s.status === 'tripped' || s.status === 'acidCleaning';
  const l = s.loops;
  return {
    ...s,
    loops: {
      tbt: restarting || burnerOff ? l.tbt : stepLoop(l.tbt, 'tbt', s.heater.tbtC),
      intakeFlow: stepLoop(l.intakeFlow, 'intakeFlow', s.intake.flowM3h),
      recirc: restarting ? l.recirc : stepLoop(l.recirc, 'recirc', s.brine.recircM3h),
      blowdown: stepLoop(l.blowdown, 'blowdown', s.brine.concentrationFactor),
      vacuum: restarting ? l.vacuum : stepLoop(l.vacuum, 'vacuum', s.vacuum.quality),
      levels: l.levels.map((loop, i) => stepLoop(loop, 'level', s.stages[i]?.levelM ?? loop.setpoint)),
    },
  };
}

/**
 * Advance the plant one step: scenario, loops, intake, fuel, heater, stages, product,
 * restart/acid clean, then interlocks. A manual-mode flame-out reported by the fuel system trips
 * the plant (unless it is already down). Does not touch accumulators, tick or plant time.
 */
export function stepPlant(s0: PlantState): PlantStep {
  const dt = TICK_PLANT_S;
  const events: PlantEvent[] = [];

  const sc = stepScenario(s0);
  events.push(...sc.events);
  let s = stepIntake(stepLoops(sc.state), dt);

  const fuel = stepFuel(s, heaterDemandMW(s), dt);
  s = fuel.state;
  const flameOut = fuel.events.some((e) => e.type === 'fuelChangeover' && e.phase === 'flameOut');
  const burnerUp = s.status === 'online' || s.status === 'restarting';
  // A flame-out only matters while the burner is up; drop the report otherwise.
  events.push(...fuel.events.filter((e) => burnerUp || !(e.type === 'fuelChangeover' && e.phase === 'flameOut')));

  s = stepHeater(s, fuel.deliveredMW, recoveredTempC(s), dt);
  const st = stepStages(s, dt);
  const online = st.state.status === 'online';
  const product = stepProduct(st.state, online ? st.distillateM3h : 0, st.carryover, dt);
  s = product.state;

  const restart = stepRestart(s);
  s = stepAcidClean(restart.state);
  events.push(...restart.events);

  const up = s.status === 'online' || s.status === 'restarting';
  const cause = flameOut && up ? 'flameOut' : checkInterlocks(s, fuel.deliveredMW);
  if (cause) {
    const trip = applyTrip(s, cause);
    s = trip.state;
    events.push(...trip.events);
  }
  return {
    state: s,
    events,
    deliveredM3: online ? product.deliveredM3 : 0,
    offSpec: online && product.offSpec,
    fuelCostUsd: fuel.costUsd,
  };
}

type StepTotals = Pick<PlantStep, 'deliveredM3' | 'offSpec' | 'fuelCostUsd'> & { trips: number };

function withAccumulators(s: PlantState, x: StepTotals): PlantState {
  if (!s.shift) return s;
  const acc = s.shift.acc;
  return {
    ...s,
    shift: {
      ...s.shift,
      acc: {
        productM3: acc.productM3 + x.deliveredM3,
        offSpecTicks: acc.offSpecTicks + (x.offSpec ? 1 : 0),
        fuelCostUsd: acc.fuelCostUsd + x.fuelCostUsd,
        trips: acc.trips + x.trips,
      },
    },
  };
}

const countTrips = (events: PlantEvent[]): number => events.filter((e) => e.type === 'trip').length;

/**
 * Advance the simulation one tick. Commands are applied first; outside a running shift
 * (handover, paused) only the status is emitted and the plant does not advance.
 */
export function tick(s0: PlantState, commands: unknown[]): TickResult {
  let s = s0;
  const events: PlantEvent[] = [];
  for (const c of commands) {
    const r = applyCommand(s, c);
    s = r.state;
    events.push(...r.events);
  }
  const commandTrips = countTrips(events);

  if (s.phase !== 'running') {
    // A manual trip while paused still counts against the shift.
    s = withAccumulators(s, { deliveredM3: 0, offSpec: false, fuelCostUsd: 0, trips: commandTrips });
    return { state: s, telemetry: [], status: toStatus(s), events, snapshotDue: commandTrips > 0 };
  }

  const step = stepPlant(s);
  events.push(...step.events);
  const trips = commandTrips + countTrips(step.events);
  s = withAccumulators(step.state, { ...step, trips });
  s = { ...s, tick: s.tick + 1, plantTime: s.plantTime + TICK_PLANT_S * 1000 };
  const telemetry = toTelemetry(s);

  let ended = false;
  if (s.shift && s.tick - s.shift.startTick >= SHIFT_TICKS) {
    const end = endShift(s);
    s = end.state;
    events.push(...end.events);
    ended = true;
  }
  const snapshotDue = s.tick % SNAPSHOT_EVERY_TICKS === 0 || ended || trips > 0;
  return { state: s, telemetry, status: toStatus(s), events, snapshotDue };
}
