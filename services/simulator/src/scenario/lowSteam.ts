import { nextRandom } from '../rng.js';
import type { PlantState } from '../state.js';
import type { QueuedEvent } from './chaosTypes.js';
import { LOW_STEAM_MINUTE, LOW_STEAM_SALT, PROFILES } from './difficulty.js';
import { drawEvent } from './library.js';

/**
 * Roll for low motive steam in shift `shiftNumber`, on the run's mode profile. Null before the
 * profile's first low-steam shift or on a missed roll; otherwise a lowSteam due at a minute drawn
 * from LOW_STEAM_MINUTE. Its params (the floor) are drawn when it fires (lowSteamParamsAtFire).
 * Pure, and on its own substream: it never consumes `s.seed`. The eventId is left at 0 for the
 * caller to assign.
 */
export function drawLowSteam(s: PlantState, shiftNumber: number): QueuedEvent | null {
  const profile = PROFILES[s.run.mode];
  if (shiftNumber < profile.lowSteamFromShift) return null;
  let seed = (s.seed ^ LOW_STEAM_SALT ^ shiftNumber) >>> 0;
  let v: number;
  [v, seed] = nextRandom(seed);
  if (v >= profile.lowSteamChance) return null;
  [v] = nextRandom(seed);
  const [lo, hi] = LOW_STEAM_MINUTE;
  const earliestMinute = lo + Math.floor(v * (hi - lo + 1));
  return { eventId: 0, kind: 'lowSteam', params: {}, earliestMinute, cascade: false, disaster: false };
}

/** The floor a lowSteam firing now sags toward, drawn on its own substream (never consumes `s.seed`). */
export function lowSteamParamsAtFire(s: PlantState): { floorBar: number } {
  const [e] = drawEvent('lowSteam', 0, (s.seed ^ LOW_STEAM_SALT ^ s.tick) >>> 0, s.chaos.active?.plan.shiftNumber ?? 1);
  return { floorBar: Number(e.params.floorBar) };
}
