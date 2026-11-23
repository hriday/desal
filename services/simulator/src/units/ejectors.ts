import { COOL_CAP_NOMINAL, COOLING_LOSS_FALL_PER_MIN } from '../constants.js';
import type { PlantState } from '../state.js';
import { bottomTempC, ejectorLoadFactor } from './stages.js';

/** The smallest cooling capacity the readings divide by (the fault floors are far above it). */
const MIN_COOL_CAP = 1e-3;

/** The most the condenser cooling loss can raise the intercondenser pressure (a factor on the nominal 250 mbar, so 750 mbar at most). */
const MAX_COOL_FACTOR = 3;

/** Working ejector trains: train A unless its 1st-stage ejector has failed, plus train B when the standby is on. */
export function ejectorTrains(s: PlantState): number {
  return (s.faults.ejectorFailed ? 0 : 1) + (s.ejectors.standby ? 1 : 0);
}

/** The air the ejectors must remove, as a multiple of the normal air (the airLeak fault's load). */
const airLoad = (s: PlantState): number => s.faults.airLeak?.load ?? 1;

/**
 * How much of the vacuum the ejector train can hold: the working trains, limited by the shared
 * condenser cooling, over the air it must remove at this load, capped at 1. Exactly 1 at nominal
 * (one train, cooling for two, normal air, nominal load), so the nominal plant is unchanged.
 */
export function ejectorCapacity(s: PlantState): number {
  const handled = Math.min(ejectorTrains(s), s.ejectors.coolCap);
  const load = airLoad(s) * ejectorLoadFactor(s.heater.tbtC, s.heater.firingPct);
  return Math.min(1, handled / load);
}

/**
 * Advance the condenser cooling one step. Under coolingLoss it falls at COOLING_LOSS_FALL_PER_MIN
 * toward the fault's floor and never below it; with no fault it is nominal (the clean strainer
 * restores it on the tick the fault clears).
 */
export function stepEjectors(s: PlantState, dtS: number): PlantState {
  const fault = s.faults.coolingLoss;
  const coolCap = fault
    ? Math.max(fault.floor, Math.min(COOL_CAP_NOMINAL, s.ejectors.coolCap) - (COOLING_LOSS_FALL_PER_MIN * dtS) / 60)
    : COOL_CAP_NOMINAL;
  return coolCap === s.ejectors.coolCap ? s : { ...s, ejectors: { ...s.ejectors, coolCap } };
}

/**
 * The ejector train's diagnosis readings: the stage 24 pressure (saturation at the bottom-stage
 * temperature, Magnus formula; hPa = mbar), the intercondenser pressure, the condenser cooling water
 * outlet temperature and the air vented from the after-condenser. Each fault moves its own pattern.
 */
export function ejectorReadings(s: PlantState): {
  lastStageMbar: number;
  intercondenserMbar: number;
  coolingOutC: number;
  ventAirKgH: number;
} {
  const t = bottomTempC(s);
  const trains = ejectorTrains(s);
  const air = airLoad(s);
  const coolCap = Math.max(MIN_COOL_CAP, s.ejectors.coolCap);
  return {
    lastStageMbar: 6.112 * Math.exp((17.62 * t) / (243.12 + t)),
    intercondenserMbar: 250 * (trains > 0 ? 1 : 0.6) * Math.sqrt(air / Math.max(1, trains)) * Math.min(MAX_COOL_FACTOR, Math.max(1, 1 / coolCap)),
    coolingOutC: s.seawater.tempC + 6 * Math.min(3, COOL_CAP_NOMINAL / coolCap),
    ventAirKgH: 10 * air * (trains > 0 ? 1 : 0.4),
  };
}
