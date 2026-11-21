import {
  BRINE_DENSITY,
  BURNER_MAX_MW,
  BURNER_WEAR_GAS,
  BURNER_WEAR_OFFGRADE_MULT,
  BURNER_WEAR_STANDARD_MULT,
  CONTAMINATION_WEAR_MULT,
  CP_BRINE,
  HEATER_TAU_S,
  MIN_RECIRC_KGS,
  TICK_PLANT_S,
} from '../constants.js';
import { contaminationActive } from '../scenario/disaster/fuelContamination.js';
import type { PlantState } from '../state.js';

/**
 * The burner is permitted to fire only when online, or during a restart from ignition onward.
 * Tripped, acid cleaning, and the vacuum/recirc restart steps are locked out (no interlock
 * watches the plant then).
 */
function burnerPermitted(s: PlantState): boolean {
  if (s.status === 'online') return true;
  if (s.status !== 'restarting' || !s.restart) return false;
  return s.restart.step === 'ignition' || s.restart.step === 'ramp';
}

/**
 * Heat the burner would deliver at the current firing demand. Firing lives in loops.tbt.output
 * (auto or manual); it is 0 while the burner is locked out.
 */
export function heaterDemandMW(s: PlantState): number {
  if (!burnerPermitted(s)) return 0;
  return BURNER_MAX_MW * (s.loops.tbt.output / 100) * s.heater.burnerCondition;
}

function wearMultiplier(s: PlantState): number {
  if (contaminationActive(s)) return CONTAMINATION_WEAR_MULT;
  if (s.fuel.active !== 'backup') return 1;
  return s.fuel.backup.grade === 'offgrade' ? BURNER_WEAR_OFFGRADE_MULT : BURNER_WEAR_STANDARD_MULT;
}

/**
 * Advance the brine heater: TBT relaxes (first-order lag) toward the steady outlet temperature
 * for the delivered heat, and the burner wears faster on backup fuel. Does not step the TBT PID.
 */
export function stepHeater(s: PlantState, deliveredMW: number, recoveredTempC: number, dtS: number): PlantState {
  const massKgS = Math.max(MIN_RECIRC_KGS, (s.brine.recircM3h * BRINE_DENSITY) / 3600);
  const steadyC = recoveredTempC + (deliveredMW * 1e6) / (massKgS * CP_BRINE);
  const tbtC = s.heater.tbtC + (steadyC - s.heater.tbtC) * (1 - Math.exp(-dtS / HEATER_TAU_S));
  const wear = BURNER_WEAR_GAS * (dtS / TICK_PLANT_S) * wearMultiplier(s);
  const burnerCondition = Math.min(1, Math.max(0, s.heater.burnerCondition - wear));
  return {
    ...s,
    heater: { tbtC, firingPct: s.loops.tbt.output, burnerCondition, heatMW: deliveredMW },
  };
}
