import type { GameEndReason, GameScore } from '@desal/schema';
import { backupOrderCostUsd } from './economy.js';
import type { PlantState, SimEvent } from './state.js';

/** Backup tonnes below this count as an empty tank (draining leaves float dust). */
const EMPTY_TANK_T = 1e-9;

/** The run's final score: ranked by in-spec water delivered, then shifts completed; the balance is informational. */
export function scoreOf(s: PlantState): GameScore {
  return { shiftsCompleted: s.run.shiftsCompleted, totalProductM3: s.run.totalProductM3, balanceUsd: s.run.balanceUsd };
}

/** A pump that can still supply intake water: not worn out and not under overhaul. */
const usable = (p: PlantState['intake']['pumps']['P-101']): boolean => p.wear < 1 && p.overhaulRemainingTicks <= 0;

/**
 * Has the plant reached a state it cannot go on from? Checked once per running tick, after the plant
 * step (and after endShift on the shift's last tick). Bankruptcy is judged only at a shift end, so a
 * shift can run into the red and recover before handover.
 */
export function checkGameOver(s: PlantState, atShiftEnd: boolean): GameEndReason | null {
  if (s.heater.burnerCondition <= 0) return 'burnerFailed';
  if (!Object.values(s.intake.pumps).some(usable)) return 'noIntakePumps';
  const f = s.fuel;
  if (
    f.gas.capMW <= 0 &&
    f.backup.tonnes < EMPTY_TANK_T &&
    f.deliveries.length === 0 &&
    s.run.balanceUsd < backupOrderCostUsd(s, 1)
  ) {
    return 'outOfFuel';
  }
  if (atShiftEnd && s.run.balanceUsd < 0) return 'bankrupt';
  return null;
}

/**
 * End the game: record the reason, move to phase 'over' and emit the final gameEnd with the score.
 * Shared by game-over checks, quitGame and the host's abandoned/error endings.
 *
 * A shift still in progress (running or paused) adds its in-spec water to the total, since that
 * water was delivered, but does not count as completed. In handover the last shift's water was
 * already added by endShift.
 */
export function endGame(s: PlantState, reason: GameEndReason): { state: PlantState; events: SimEvent[] } {
  const inProgressM3 = s.shift && (s.phase === 'running' || s.phase === 'paused') ? s.shift.acc.productM3 : 0;
  const run = { ...s.run, totalProductM3: s.run.totalProductM3 + inProgressM3, over: { reason, atTick: s.tick } };
  const state: PlantState = { ...s, phase: 'over', run };
  return {
    state,
    events: [
      { type: 'gameEnd', tick: s.tick, plantTime: s.plantTime, shiftId: s.shift?.id ?? null, mode: 'normal', reason, score: scoreOf(state) },
    ],
  };
}
