import { SHARP_KINDS, type GameMode, type ScenarioKind } from '@desal/schema';
import { nextRandom } from '../rng.js';
import type { PlantState } from '../state.js';
import type { ChaosPlan, QueuedEvent } from './chaosTypes.js';
import { PROFILES } from './difficulty.js';
import { drawEvent, shiftFuelBudgetUsd, shiftTargetM3 } from './library.js';
import { buildOrders } from './orders.js';
import type { Scenario } from './types.js';

const HELL_WATER_FACTOR = 0.85;
const HELL_WARNED_P = 0.7;
const SHIFT_ONE_KINDS: readonly ScenarioKind[] = ['pumpTrip', 'sensorFailure', 'storm'];
/** Plant minutes before Normal shift 1's second event may fire. */
const SHIFT_ONE_SECOND_MINUTE = 90;
/** Controller faults join the mix from this shift on. */
const CONTROLLER_FAULTS_FROM_SHIFT = 5;
const FILLER_KINDS: readonly ScenarioKind[] = [
  'bloom',
  'seawaterTemp',
  'pumpBearing',
  'gasCurtailNotice',
  'gasPriceSpike',
  'offgradeOnly',
  'deliveryDelay',
  'demandChange',
  'controllerFault',
];

/** Chance that shift `n` is a hell shift on Normal (when the previous one wasn't). Shift 1 is never hell. */
export const hellChance = (n: number): number => Math.min(0.45, 0.1 + 0.04 * (n - 2));

/** Remove and return a uniformly chosen element of `pool`; null when the pool is empty. */
function take<T>(pool: T[], seed: number): [T | null, number] {
  if (pool.length === 0) return [null, seed];
  const [v, next] = nextRandom(seed);
  return [pool.splice(Math.floor(v * pool.length), 1)[0] as T, next];
}

/**
 * Draw shift `shiftNumber`'s chaos plan for `mode` (default Normal). Pure: all randomness comes from
 * `seed`, and the next seed is returned. Hard makes every shift a hell shift, shift 1 included and
 * back to back. Normal shift 1 holds two different gentle events, the second held back 90 minutes;
 * Normal shifts 2+ draw exactly as before Hard mode existed. Disasters are drawn separately
 * (drawDisaster). `state` is read only for pump availability and, in the orders, equipment; the orders quote
 * `initial` (the conditions the shift will start in, default: the state's current seawater).
 */
export function drawChaosPlan(input: {
  shiftNumber: number;
  seed: number;
  lastWasHell: boolean;
  state: PlantState;
  initial?: Scenario['initial'];
  mode?: GameMode;
}): [ChaosPlan, number] {
  const n = Math.max(1, input.shiftNumber);
  const { state } = input;
  const alwaysHell = PROFILES[input.mode ?? 'normal'].hellEveryShift;
  const initial = input.initial ?? {
    seawaterTempC: state.seawater.tempC,
    chlorophyllUgL: state.seawater.chlorophyllUgL,
  };
  let s = input.seed >>> 0;

  const pumps = Object.entries(state.intake.pumps);
  const running = pumps.filter(([, p]) => p.running && p.overhaulRemainingTicks === 0).map(([id]) => id);
  // A trip or dip needs a running pump to hit and a spare that is neither running nor under overhaul.
  const pumpEventsOk = running.length > 0 && pumps.some(([, p]) => !p.running && p.overhaulRemainingTicks === 0);
  const viable = (k: ScenarioKind): boolean => pumpEventsOk || (k !== 'pumpTrip' && k !== 'powerDip');

  let hell = false;
  let warned = false;
  let v: number;
  if (n >= 2 || alwaysHell) {
    [v, s] = nextRandom(s);
    hell = alwaysHell || (!input.lastWasHell && v < hellChance(n));
    [v, s] = nextRandom(s);
    warned = hell && v < HELL_WARNED_P;
  }
  const gentle = n === 1 && !hell;

  // Unviable pump events are simply left out of the pool, which substitutes another sharp kind.
  const sharp = (gentle ? SHIFT_ONE_KINDS : SHARP_KINDS).filter(viable);
  const filler = FILLER_KINDS.filter((k) => n >= CONTROLLER_FAULTS_FROM_SHIFT || k !== 'controllerFault');
  const kinds: ScenarioKind[] = [];
  let kind: ScenarioKind | null;

  if (gentle) {
    // Two different kinds; with pump events unviable the pool still holds two.
    for (let i = 0; i < 2; i++) {
      [kind, s] = take(sharp, s);
      if (kind) kinds.push(kind);
    }
  } else if (hell) {
    [v, s] = nextRandom(s);
    const count = 4 + Math.floor(v * 3);
    for (let i = 0; i < count; i++) {
      [v, s] = nextRandom(s);
      [kind, s] = v < 0.7 && sharp.length > 0 ? take(sharp, s) : take(filler, s);
      if (kind) kinds.push(kind);
    }
  } else {
    [kind, s] = take(sharp, s);
    kinds.push(kind as ScenarioKind);
    [v, s] = nextRandom(s);
    if (v < 0.5) {
      [v, s] = nextRandom(s);
      [kind, s] = v < 0.5 && sharp.length > 0 ? take(sharp, s) : take(filler, s);
      if (kind) kinds.push(kind);
    }
  }

  const queue: QueuedEvent[] = [];
  for (const k of kinds) {
    // Normal shift 1's second event waits 90 minutes; every other event is scheduled by the director.
    const earliestMinute = gentle && queue.length === 1 ? SHIFT_ONE_SECOND_MINUTE : 0;
    let e;
    [e, s] = drawEvent(k, earliestMinute, s, n, running);
    queue.push({ eventId: queue.length + 1, kind: k, params: e.params, earliestMinute, cascade: false, disaster: false });
  }

  const base = shiftTargetM3(n);
  const targetM3 = hell ? Math.round(base * HELL_WATER_FACTOR) : base;
  const partial = { shiftNumber: n, hell, warned, targetM3, initial, queue };
  const view: PlantState = {
    ...state,
    seawater: { ...state.seawater, tempC: initial.seawaterTempC, chlorophyllUgL: initial.chlorophyllUgL },
  };
  return [{ ...partial, orders: buildOrders(partial, view, shiftFuelBudgetUsd(n)) }, s];
}
