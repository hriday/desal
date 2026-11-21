import type { PlantState } from '../src/state.js';

export const GAME_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

let counter = 0;

/** A fresh, valid v4-shaped UUID per call (deterministic: a counter in the last group). */
export function nextId(): string {
  counter++;
  return `123e4567-e89b-42d3-a456-${counter.toString(16).padStart(12, '0')}`;
}

/** Wrap a command in an envelope addressed to the state's current shift. */
export function env(s: PlantState, command: Record<string, unknown>, shiftId: number | null = s.shift?.id ?? null) {
  return { commandId: nextId(), issuedAt: 0, gameId: s.run.gameId, shiftId, command };
}
