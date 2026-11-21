import {
  CONTAMINATION_BACKUP_HOURS,
  CONTAMINATION_GAS_CAP_FRACTION,
  LHV_OFFGRADE_MJkg,
  LHV_STANDARD_MJkg,
} from '../../constants.js';
import { NOMINAL, type PlantState } from '../../state.js';

/** Backup tonnes that carry the plant at nominal burn for `hours` plant hours, at the tank's current grade. */
function nominalBackupTonnes(s: PlantState, hours: number): number {
  const lhv = s.fuel.backup.grade === 'offgrade' ? LHV_OFFGRADE_MJkg : LHV_STANDARD_MJkg;
  return (NOMINAL.heatMW * hours * 3600) / (lhv * 1000);
}

/**
 * Can the fuel the burner is on be contaminated without stranding the plant? The other fuel must
 * carry it: backup needs 2 plant hours of nominal burn in the tank, gas needs its cap at 70 % of nominal burn.
 */
export function fuelContaminationViable(s: PlantState): boolean {
  if (s.faults.fuelContamination) return false;
  if (s.fuel.active === 'gas') return s.fuel.backup.tonnes >= nominalBackupTonnes(s, CONTAMINATION_BACKUP_HOURS);
  return s.fuel.gas.capMW >= CONTAMINATION_GAS_CAP_FRACTION * NOMINAL.heatMW;
}

/** Contaminate the fuel the burner is on. */
export function applyFuelContamination(s: PlantState): PlantState {
  return { ...s, faults: { ...s.faults, fuelContamination: { fuel: s.fuel.active } } };
}

/** True while the burner fires the contaminated fuel and no changeover away from it is underway. */
export function contaminationActive(s: PlantState): boolean {
  const c = s.faults.fuelContamination;
  return c !== null && s.fuel.active === c.fuel && s.fuel.changeover === null;
}
