import type { Pace } from '@desal/schema';
import { FAST_PACE } from './constants.js';
import type { PlantState } from './state.js';

/** Real ms between ticks of a busy game (1 tick/s, the old fixed pace). */
export const BUSY_TICK_MS = 1000;
/** Real ms between ticks of a calm game (FAST_PACE ticks/s); also the runner's step period. */
export const CALM_TICK_MS = 1000 / FAST_PACE;
/** A game is ticked by a host step up to this early, so step-timer jitter never costs it a whole step. */
export const DUE_SLACK_MS = CALM_TICK_MS / 2;

/**
 * Something needs the player: a fired event not yet cleared, or a trip or restart in progress.
 * Acid cleaning is planned work, so it is not busy. The same in Normal and Hard; nothing is stored.
 */
export function isBusy(s: PlantState): boolean {
  if (s.status === 'tripped' || s.status === 'restarting') return true;
  return s.chaos.active?.fired.some((e) => !e.cleared) ?? false;
}

/**
 * Calm only while a shift runs and nothing is busy. Handover, paused and over keep the old
 * 1 tick/s, so they report busy (the web shows the pace only while running).
 */
export function paceOf(s: PlantState): Pace {
  return s.phase === 'running' && !isBusy(s) ? 'calm' : 'busy';
}

/** Real ms until this game's next tick. */
export function tickIntervalMs(s: PlantState): number {
  return paceOf(s) === 'calm' ? CALM_TICK_MS : BUSY_TICK_MS;
}
