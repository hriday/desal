import type { ScenarioKind } from '@desal/schema';
import { nextRandom } from '../../rng.js';
import type { LoopSensorId, PlantState } from '../../state.js';
import type { QueuedEvent } from '../chaosTypes.js';
import { drawEvent } from '../library.js';
import { pumpAvailability } from '../sharp.js';

const SENSOR_LOOPS: readonly LoopSensorId[] = ['tbt', 'intakeFlow', 'recirc', 'blowdown', 'vacuum', 'makeup'];
const SEVERE_LEAK_P = 0.4;
const AFTERSHOCK_P = 0.5;
const AFTERSHOCK_DELAY_MIN = [20, 60] as const;

type Child = Omit<QueuedEvent, 'eventId'>;

/**
 * What an earthquake that fires at `atMinute` sets off: a power dip, one tube leak (severe, with its
 * ppm doubled, at p 0.4), two sensor failures on different instruments, and at p 0.5 an aftershock
 * dip 20-60 minutes later. The plant models one leak at a time, so "two leaks" is one severe leak.
 * Children that cannot happen now are dropped: a dip with no running pump and spare, a leak while
 * one is open, a failure on an instrument that has already failed. Returns the children and the next seed.
 */
export function earthquakeFollowUps(s: PlantState, atMinute: number, seed: number): [Child[], number] {
  const n = s.chaos.active?.plan.shiftNumber ?? s.run.shiftNumber;
  const child = (kind: ScenarioKind, params: Child['params'], earliestMinute: number): Child => ({
    kind,
    params,
    earliestMinute,
    cascade: true,
    disaster: true,
  });
  const out: Child[] = [];
  let v: number;

  const { running, spares } = pumpAvailability(s);
  const dipOk = running.length > 0 && spares.length > 0;
  if (dipOk) {
    const [dip, next] = drawEvent('powerDip', atMinute, seed, n, running);
    seed = next;
    out.push(child('powerDip', dip.params, atMinute));
  }

  if (s.faults.tubeLeak === null) {
    const [leak, next] = drawEvent('tubeLeak', atMinute, seed, n);
    [v, seed] = nextRandom(next);
    const ppm = v < SEVERE_LEAK_P ? Number(leak.params.ppm) * 2 : Number(leak.params.ppm);
    out.push(child('tubeLeak', { ...leak.params, ppm }, atMinute));
  }

  const free = SENSOR_LOOPS.filter((l) => s.faults.sensors[l] === undefined);
  for (let i = 0; i < 2 && free.length > 0; i++) {
    [v, seed] = nextRandom(seed);
    const loop = free.splice(Math.floor(v * free.length), 1)[0]!;
    [v, seed] = nextRandom(seed);
    out.push(child('sensorFailure', { loop, mode: v < 0.5 ? 'freeze' : 'noise' }, atMinute));
  }

  [v, seed] = nextRandom(seed);
  if (v < AFTERSHOCK_P && dipOk) {
    let w: number;
    [w, seed] = nextRandom(seed);
    const delay = AFTERSHOCK_DELAY_MIN[0] + Math.floor(w * (AFTERSHOCK_DELAY_MIN[1] - AFTERSHOCK_DELAY_MIN[0] + 1));
    const [dip, next] = drawEvent('powerDip', atMinute + delay, seed, n, running);
    seed = next;
    out.push(child('powerDip', dip.params, atMinute + delay));
  }
  return [out, seed];
}
