import { SHARP_KINDS, type ScenarioKind } from '@desal/schema';
import { BASE_FUEL_BUDGET_USD } from '../constants.js';
import { nextRandom } from '../rng.js';
import type { PlantState } from '../state.js';
import type { ChaosPlan, QueuedEvent } from './chaosTypes.js';
import { difficulty, drawEvent, shiftTargetM3 } from './library.js';
import { buildOrders } from './orders.js';

const HELL_WATER_FACTOR = 0.85;
const HELL_WARNED_P = 0.7;
const SHIFT_ONE_KINDS: readonly ScenarioKind[] = ['pumpTrip', 'sensorFailure', 'storm'];
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

/** Chance that shift `n` is a hell shift (when the previous one wasn't). Shift 1 is never hell. */
export const hellChance = (n: number): number => Math.min(0.45, 0.1 + 0.04 * (n - 2));

/** Remove and return a uniformly chosen element of `pool`; null when the pool is empty. */
function take<T>(pool: T[], seed: number): [T | null, number] {
  if (pool.length === 0) return [null, seed];
  const [v, next] = nextRandom(seed);
  return [pool.splice(Math.floor(v * pool.length), 1)[0] as T, next];
}

/**
 * Draw shift `shiftNumber`'s chaos plan. Pure: all randomness comes from `seed`, and the next seed is
 * returned. `state` is read only for pump availability and, in the orders, equipment and seawater.
 */
export function drawChaosPlan(input: {
  shiftNumber: number;
  seed: number;
  lastWasHell: boolean;
  state: PlantState;
}): [ChaosPlan, number] {
  const n = Math.max(1, input.shiftNumber);
  const { state } = input;
  let s = input.seed >>> 0;

  const pumps = Object.entries(state.intake.pumps);
  const running = pumps.filter(([, p]) => p.running && p.overhaulRemainingTicks === 0).map(([id]) => id);
  // A trip or dip needs a running pump to hit and a spare that is neither running nor under overhaul.
  const pumpEventsOk = running.length > 0 && pumps.some(([, p]) => !p.running && p.overhaulRemainingTicks === 0);
  const viable = (k: ScenarioKind): boolean => pumpEventsOk || (k !== 'pumpTrip' && k !== 'powerDip');

  let hell = false;
  let warned = false;
  let v: number;
  if (n >= 2) {
    [v, s] = nextRandom(s);
    hell = !input.lastWasHell && v < hellChance(n);
    [v, s] = nextRandom(s);
    warned = hell && v < HELL_WARNED_P;
  }

  // Unviable pump events are simply left out of the pool, which substitutes another sharp kind.
  const sharp = (n === 1 ? SHIFT_ONE_KINDS : SHARP_KINDS).filter(viable);
  const filler = FILLER_KINDS.filter((k) => n >= CONTROLLER_FAULTS_FROM_SHIFT || k !== 'controllerFault');
  const kinds: ScenarioKind[] = [];
  let kind: ScenarioKind | null;

  if (n === 1) {
    [kind, s] = take(sharp, s);
    kinds.push(kind as ScenarioKind);
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
    let e;
    [e, s] = drawEvent(k, 0, s, n, running);
    queue.push({ eventId: queue.length + 1, kind: k, params: e.params, earliestMinute: 0, cascade: false });
  }

  const base = shiftTargetM3(n);
  const targetM3 = hell ? Math.round(base * HELL_WATER_FACTOR) : base;
  const partial = { shiftNumber: n, hell, warned, targetM3, queue };
  const budgetUsd = Math.round(BASE_FUEL_BUDGET_USD * difficulty(n));
  return [{ ...partial, orders: buildOrders(partial, state, budgetUsd) }, s];
}
