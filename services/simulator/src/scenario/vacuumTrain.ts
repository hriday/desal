import { nextRandom } from '../rng.js';
import type { PlantState } from '../state.js';
import type { QueuedEvent } from './chaosTypes.js';
import { PROFILES, VACUUM_TRAIN_MINUTE, VACUUM_TRAIN_SALT } from './difficulty.js';
import { drawEvent } from './library.js';

/** The ejector-train faults: the condenser cooling loss and the air leak. */
export type VacuumTrainKind = 'coolingLoss' | 'airLeak';

type Params = Record<string, number | string>;

/**
 * Roll for an ejector-train fault in shift `shiftNumber`, on the run's mode profile. Null before the
 * profile's first such shift or on a missed roll; otherwise a coolingLoss (third draw < 0.5) or an
 * airLeak, due at a minute drawn from VACUUM_TRAIN_MINUTE. Its params (the floor or the load) are
 * drawn when it fires (vacuumTrainParamsAtFire). Pure, and on its own substream: it never consumes
 * `s.seed`. The eventId is left at 0 for the caller to assign.
 */
export function drawVacuumTrainFault(s: PlantState, shiftNumber: number): QueuedEvent | null {
  const profile = PROFILES[s.run.mode];
  if (shiftNumber < profile.vacuumTrainFromShift) return null;
  let seed = (s.seed ^ VACUUM_TRAIN_SALT ^ shiftNumber) >>> 0;
  let v: number;
  [v, seed] = nextRandom(seed);
  if (v >= profile.vacuumTrainChance) return null;
  [v, seed] = nextRandom(seed);
  const [lo, hi] = VACUUM_TRAIN_MINUTE;
  const earliestMinute = lo + Math.floor(v * (hi - lo + 1));
  [v] = nextRandom(seed);
  const kind: VacuumTrainKind = v < 0.5 ? 'coolingLoss' : 'airLeak';
  return { eventId: 0, kind, params: {}, earliestMinute, cascade: false, disaster: false };
}

/**
 * The params an ejector-train fault firing now takes (coolingLoss: the cooling floor; airLeak: the
 * air load), drawn on its own substream (never consumes `s.seed`).
 */
export function vacuumTrainParamsAtFire(s: PlantState, kind: VacuumTrainKind): Params {
  const [e] = drawEvent(kind, 0, (s.seed ^ VACUUM_TRAIN_SALT ^ s.tick) >>> 0, s.chaos.active?.plan.shiftNumber ?? 1);
  return e.params;
}
