import type { ScenarioKind } from '@desal/schema';
import type { PlantState } from '../state.js';

/** The sharp kinds (SHARP_KINDS) as a type, for exhaustive dispatch. */
export type SharpKind = Extract<ScenarioKind, 'pumpTrip' | 'tubeLeak' | 'vacuumLoss' | 'powerDip' | 'storm' | 'sensorFailure'>;

/**
 * Apply a sharp event's effect to the plant. Stub: Tasks 6–7 give each kind its physics; until then
 * a sharp event only leaves its fired record.
 */
export function applySharpEffect(s: PlantState, _kind: SharpKind, _params: Record<string, number | string>): PlantState {
  return s;
}

/** Advance the per-shift faults by `dt` plant seconds. Stub: Tasks 6–7 fill it. */
export function stepFaults(s: PlantState, _dt: number): PlantState {
  return s;
}
