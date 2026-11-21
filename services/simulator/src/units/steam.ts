import { EJECTOR_FULL_REACH_BAR, EJECTOR_NO_REACH_BAR, LOW_STEAM_SAG_BAR_PER_MIN, MOTIVE_STEAM_NOMINAL_BAR } from '../constants.js';
import type { PlantState } from '../state.js';

/**
 * How much of the vacuum the ejectors can pull at motive steam `bar`: 1 at or above
 * EJECTOR_FULL_REACH_BAR, falling linearly to 0 at EJECTOR_NO_REACH_BAR and below.
 */
export function ejectorReach(bar: number): number {
  const r = (bar - EJECTOR_NO_REACH_BAR) / (EJECTOR_FULL_REACH_BAR - EJECTOR_NO_REACH_BAR);
  return Math.min(1, Math.max(0, r));
}

/**
 * Advance the motive steam one step. With no lowSteam fault, or with the standby steam line on, it is
 * nominal (the line restores it on the tick it is opened). Otherwise it sags at
 * LOW_STEAM_SAG_BAR_PER_MIN from wherever it is, down to the fault's floor.
 */
export function stepSteam(s: PlantState, dtS: number): PlantState {
  const fault = s.faults.lowSteam;
  const motiveBar =
    s.steam.standby || !fault
      ? MOTIVE_STEAM_NOMINAL_BAR
      : Math.max(fault.floorBar, s.steam.motiveBar - (LOW_STEAM_SAG_BAR_PER_MIN * dtS) / 60);
  return motiveBar === s.steam.motiveBar ? s : { ...s, steam: { ...s.steam, motiveBar } };
}
