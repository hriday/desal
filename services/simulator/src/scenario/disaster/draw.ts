import { DISASTER_KINDS, type ScenarioKind } from '@desal/schema';
import { nextRandom } from '../../rng.js';
import type { PlantState } from '../../state.js';
import type { QueuedEvent } from '../chaosTypes.js';
import { DISASTER_MINUTE, DISASTER_SALT, PROFILES } from '../difficulty.js';
import { drawEvent } from '../library.js';
import { fuelContaminationViable } from './fuelContamination.js';
import { tsunamiViable } from './tsunami.js';

/** Whether a disaster of `kind` can strike the plant as it is now. The earthquake always can (its children self-drop). */
function viable(s: PlantState, kind: ScenarioKind): boolean {
  if (kind === 'fuelContamination') return fuelContaminationViable(s);
  if (kind === 'tsunami') return tsunamiViable(s);
  return true;
}

/**
 * Roll for a disaster in shift `shiftNumber`, on the run's mode profile. Null before the profile's
 * first disaster shift, straight after a disaster shift, on a missed roll, or when no kind is
 * viable; otherwise one of the viable kinds, picked uniformly, due between DISASTER_MINUTE plant
 * minutes. Pure, and on its own substream: it never consumes `s.seed`. The eventId is left at 0
 * for the caller to assign.
 */
export function drawDisaster(s: PlantState, shiftNumber: number): QueuedEvent | null {
  const profile = PROFILES[s.run.mode];
  if (shiftNumber < profile.disasterFromShift || s.chaos.lastHadDisaster) return null;
  let seed = (s.seed ^ DISASTER_SALT ^ shiftNumber) >>> 0;
  let v: number;
  [v, seed] = nextRandom(seed);
  if (v >= profile.disasterChance) return null;
  const kinds = DISASTER_KINDS.filter((k) => viable(s, k));
  if (kinds.length === 0) return null;
  [v, seed] = nextRandom(seed);
  const kind = kinds[Math.floor(v * kinds.length)]!;
  [v, seed] = nextRandom(seed);
  const [lo, hi] = DISASTER_MINUTE;
  const earliestMinute = lo + Math.floor(v * (hi - lo + 1));
  const [e] = drawEvent(kind, earliestMinute, seed, shiftNumber, undefined, s.fuel.active);
  return { eventId: 0, kind, params: e.params, earliestMinute, cascade: false, disaster: true };
}
