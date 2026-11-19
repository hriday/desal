import type { PumpId, ScenarioKind } from '@desal/schema';
import {
  EJECTOR_HALVE_FIRING_FRAC,
  EJECTOR_HALVE_TBT_C,
  EJECTOR_MIN_LOAD_FACTOR,
  POWER_DIP_RECIRC_FACTOR,
  PUMP_TRIP_WEAR,
  SENSOR_NOISE_AMPLITUDE,
  STORM_FOULING_PER_TICK,
  TICK_PLANT_S,
  TUBE_LEAK_GROWTH_PPM_PER_MIN,
} from '../constants.js';
import { nextRandom } from '../rng.js';
import { trueLoopValue } from '../sensors.js';
import { NOMINAL, type LoopSensorId, type PlantState } from '../state.js';

/** The sharp kinds (SHARP_KINDS) as a type, for exhaustive dispatch. */
export type SharpKind = Extract<ScenarioKind, 'pumpTrip' | 'tubeLeak' | 'vacuumLoss' | 'powerDip' | 'storm' | 'sensorFailure'>;

const SENSOR_LOOPS: Record<LoopSensorId, true> = { tbt: true, intakeFlow: true, recirc: true, blowdown: true, vacuum: true };

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

/**
 * How much of a failed ejector's vacuum loss a load leaves: 1 at or above nominal, falling linearly to
 * a half at EJECTOR_HALVE_TBT_C below nominal TBT or EJECTOR_HALVE_FIRING_FRAC below nominal firing
 * (whichever cut is deeper), and never below EJECTOR_MIN_LOAD_FACTOR.
 */
export function ejectorLoadFactor(tbtC: number, firingPct: number): number {
  const tbtCut = (NOMINAL.tbtC - tbtC) / EJECTOR_HALVE_TBT_C;
  const firingCut = (NOMINAL.firingPct - firingPct) / (NOMINAL.firingPct * EJECTOR_HALVE_FIRING_FRAC);
  const cut = Math.max(0, tbtCut, firingCut);
  return Math.max(EJECTOR_MIN_LOAD_FACTOR, 1 - 0.5 * cut);
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
      if (!(loop in SENSOR_LOOPS)) return s;
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
