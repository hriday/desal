import type { PumpId, ScenarioKind } from '@desal/schema';
import { POWER_DIP_RECIRC_FACTOR, PUMP_TRIP_WEAR, STORM_FOULING_PER_TICK, TICK_PLANT_S } from '../constants.js';
import type { PlantState } from '../state.js';

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

/**
 * Apply a sharp event's effect to the plant. pumpTrip, powerDip and storm are here; Task 7 adds the
 * rest, until then those kinds only leave their fired record.
 */
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
        faults: { ...fouled.faults, stormRemainingTicks: (Number(p.minutes) * 60) / TICK_PLANT_S },
      };
    }
    case 'tubeLeak':
    case 'vacuumLoss':
    case 'sensorFailure':
      return s;
  }
}

/** Advance the per-shift faults by `dt` plant seconds. Task 7 adds the leak, ejector and sensor faults. */
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
  return next;
}
