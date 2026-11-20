import type { CrewJob, PumpId, ScenarioKind } from '@desal/schema';
import {
  POWER_DIP_RECIRC_FACTOR,
  PUMP_TRIP_WEAR,
  SENSOR_NOISE_AMPLITUDE,
  STORM_FOULING_PER_TICK,
  TICK_PLANT_S,
  TUBE_LEAK_GROWTH_PPM_PER_MIN,
  TUBE_PLUG_DERATE,
} from '../constants.js';
import { nextRandom } from '../rng.js';
import { isLoopSensor, trueLoopValue } from '../sensors.js';
import type { LoopSensorId, PlantState } from '../state.js';

/** The sharp kinds (SHARP_KINDS) as a type, for exhaustive dispatch. */
export type SharpKind = Extract<ScenarioKind, 'pumpTrip' | 'tubeLeak' | 'vacuumLoss' | 'powerDip' | 'storm' | 'sensorFailure'>;

type Params = Record<string, number | string>;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Stop a pump. A pump that is not there is left alone. Auto never restarts it: only the player does. */
function stopPump(s: PlantState, id: PumpId, extraWear: number): PlantState {
  const pump = s.intake.pumps[id];
  if (!pump) return s;
  const pumps = { ...s.intake.pumps, [id]: { ...pump, running: false, wear: clamp01(pump.wear + extraWear) } };
  return { ...s, intake: { ...s.intake, pumps } };
}

/** Add screen fouling that stays until the screens are cleaned; faults.stormFouling tracks the amount added. */
function addStormFouling(s: PlantState, amount: number): PlantState {
  const added = Math.min(Math.max(0, amount), 1 - s.intake.screenFouling);
  return {
    ...s,
    intake: { ...s.intake, screenFouling: s.intake.screenFouling + added },
    faults: { ...s.faults, stormFouling: s.faults.stormFouling + added },
  };
}

/** Apply a sharp event's effect to the plant. */
export function applySharpEffect(s: PlantState, kind: SharpKind, p: Params): PlantState {
  switch (kind) {
    case 'pumpTrip':
      return stopPump(s, p.pumpId as PumpId, PUMP_TRIP_WEAR);
    case 'powerDip': {
      const stopped = stopPump(s, p.pumpId as PumpId, 0);
      const factor = p.recircFactor === undefined ? POWER_DIP_RECIRC_FACTOR : Number(p.recircFactor);
      return {
        ...stopped,
        faults: {
          ...stopped.faults,
          powerDipRemainingTicks: (Number(p.minutes) * 60) / TICK_PLANT_S,
          powerDipRecircFactor: factor,
        },
      };
    }
    case 'storm': {
      const fouled = addStormFouling(s, Number(p.fouling));
      return {
        ...fouled,
        seawater: { ...fouled.seawater, tempC: fouled.seawater.tempC - Number(p.deltaC) },
        faults: { ...fouled.faults, stormCleanedByCrew: false, stormRemainingTicks: (Number(p.minutes) * 60) / TICK_PLANT_S },
      };
    }
    case 'tubeLeak':
      return { ...s, faults: { ...s.faults, tubeLeak: { stage: Number(p.stage), ppm: Number(p.ppm) } } };
    case 'vacuumLoss':
      return { ...s, faults: { ...s.faults, ejectorFailed: true, ejectorRatePerMin: Number(p.ratePerMin) } };
    case 'sensorFailure': {
      const loop = p.loop as LoopSensorId;
      if (!isLoopSensor(loop)) return s;
      const fault =
        p.mode === 'freeze'
          ? ({ kind: 'freeze', value: trueLoopValue(s, loop) } as const)
          : ({ kind: 'noise', amplitude: SENSOR_NOISE_AMPLITUDE } as const);
      return { ...s, faults: { ...s.faults, sensors: { ...s.faults.sensors, [loop]: fault } } };
    }
  }
}

/**
 * Advance the per-shift faults by `dt` plant seconds. The ejector's vacuum loss is applied in
 * stepStages (it needs the load); here the leak grows and the seed advances while any sensor is noisy.
 */
export function stepFaults(s: PlantState, dt: number): PlantState {
  const k = dt / TICK_PLANT_S;
  const f = s.faults;
  let next = s;
  if (f.stormRemainingTicks > 0) {
    next = addStormFouling(next, STORM_FOULING_PER_TICK * k);
    next = { ...next, faults: { ...next.faults, stormRemainingTicks: Math.max(0, f.stormRemainingTicks - k) } };
  }
  if (f.powerDipRemainingTicks > 0) {
    next = { ...next, faults: { ...next.faults, powerDipRemainingTicks: Math.max(0, f.powerDipRemainingTicks - k) } };
  }
  if (f.tubeLeak) {
    const ppm = f.tubeLeak.ppm + TUBE_LEAK_GROWTH_PPM_PER_MIN * (dt / 60);
    next = { ...next, faults: { ...next.faults, tubeLeak: { ...f.tubeLeak, ppm: Math.max(0, ppm) } } };
  }
  // Noise is a function of the seed, so a noisy sensor needs a fresh seed each tick (and it is saved).
  if (Object.values(f.sensors).some((x) => x.kind === 'noise')) {
    next = { ...next, seed: nextRandom(next.seed)[1] };
  }
  return next;
}

/** Whether `job` has a fault to fix. cleanScreens needs a storm running or storm fouling still on the screens. */
export function crewJobHasFault(s: PlantState, job: CrewJob): boolean {
  const f = s.faults;
  switch (job) {
    case 'plugTubes':
      return f.tubeLeak !== null;
    case 'repairEjector':
      return f.ejectorFailed;
    case 'replaceSensor':
      return Object.keys(f.sensors).length > 0;
    case 'cleanScreens':
      return f.stormRemainingTicks > 0 || f.stormFouling > 0;
    case 'flushFuel':
      return false; // Plan 6 Task 3
  }
}

/** Undo the fault `job` fixes. */
function finishCrewJob(s: PlantState, job: CrewJob): PlantState {
  const f = s.faults;
  switch (job) {
    case 'plugTubes': {
      if (!f.tubeLeak) return s;
      const stageDerate = f.stageDerate.map((d, i) => (i === f.tubeLeak!.stage ? TUBE_PLUG_DERATE : d));
      return { ...s, faults: { ...f, tubeLeak: null, stageDerate } };
    }
    case 'repairEjector':
      return { ...s, faults: { ...f, ejectorFailed: false, ejectorRatePerMin: 0 } };
    case 'replaceSensor':
      return { ...s, faults: { ...f, sensors: {} } };
    case 'cleanScreens':
      // Only the storm's fouling comes off; the screens then relax toward biofouling alone.
      return {
        ...s,
        intake: { ...s.intake, screenFouling: Math.max(0, s.intake.screenFouling - f.stormFouling) },
        faults: { ...f, stormFouling: 0, stormCleanedByCrew: true },
      };
    case 'flushFuel':
      return s; // Plan 6 Task 3
  }
}

/** Count the crew job down one tick and, when it ends, clear its fault and free the crew. */
export function stepCrew(s: PlantState): PlantState {
  if (!s.crew) return s;
  const remainingTicks = s.crew.remainingTicks - 1;
  if (remainingTicks > 0) return { ...s, crew: { ...s.crew, remainingTicks } };
  return { ...finishCrewJob(s, s.crew.job), crew: null };
}
