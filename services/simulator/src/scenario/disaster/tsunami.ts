import { TICK_PLANT_S, TSUNAMI_FOULING, TSUNAMI_SURGE_TICKS, TSUNAMI_SURGE_WEAR } from '../../constants.js';
import type { PlantState } from '../../state.js';
import { addStormFouling } from '../sharp.js';

/** Can a tsunami be fired without stranding the plant? At least one intake pump must still be usable. */
export function tsunamiViable(s: PlantState): boolean {
  return Object.values(s.intake.pumps).some((p) => p.wear < 1 && p.overhaulRemainingTicks === 0);
}

/** Start the warning: the surge reaches the intake `warnMinutes` later, cooling the sea by `coolC`. */
export function applyTsunami(s: PlantState, p: { warnMinutes: number; coolC?: number }): PlantState {
  return {
    ...s,
    faults: {
      ...s.faults,
      tsunami: {
        warnRemainingTicks: (p.warnMinutes * 60) / TICK_PLANT_S,
        surgeRemainingTicks: TSUNAMI_SURGE_TICKS,
        surgeDone: false,
        cleanedAfterSurge: false,
        coolC: p.coolC ?? 0,
      },
    },
  };
}

/**
 * Advance a tsunami by `k` ticks. The warning counts down; when it ends the surge fouls the screens
 * and cools the sea; then each surge tick wears every running pump, TSUNAMI_SURGE_WEAR in total.
 */
export function stepTsunami(s: PlantState, k = 1): PlantState {
  const t = s.faults.tsunami;
  if (!t || t.surgeDone) return s;
  if (t.warnRemainingTicks > 0) {
    const warnRemainingTicks = Math.max(0, t.warnRemainingTicks - k);
    let next: PlantState = { ...s, faults: { ...s.faults, tsunami: { ...t, warnRemainingTicks } } };
    if (warnRemainingTicks === 0) {
      next = addStormFouling(next, TSUNAMI_FOULING);
      next = { ...next, seawater: { ...next.seawater, tempC: next.seawater.tempC - t.coolC } };
    }
    return next;
  }
  const wear = (TSUNAMI_SURGE_WEAR / TSUNAMI_SURGE_TICKS) * k;
  const pumps = Object.fromEntries(
    Object.entries(s.intake.pumps).map(([id, p]) => [id, p.running ? { ...p, wear: Math.min(1, p.wear + wear) } : p]),
  ) as PlantState['intake']['pumps'];
  const surgeRemainingTicks = Math.max(0, t.surgeRemainingTicks - k);
  return {
    ...s,
    intake: { ...s.intake, pumps },
    faults: { ...s.faults, tsunami: { ...t, surgeRemainingTicks, surgeDone: surgeRemainingTicks === 0 } },
  };
}
