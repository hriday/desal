import { SHARP_KINDS, type ScenarioKind } from '@desal/schema';
import { TICK_PLANT_S } from '../constants.js';
import { nextRandom } from '../rng.js';
import type { LoopSensorId, PlantState, SimEvent } from '../state.js';
import type { ActiveChaos, FiredEvent, QueuedEvent } from './chaosTypes.js';
import { applyEffect } from './effects.js';
import { drawEvent, eventMessage } from './library.js';
import { radioLine } from './orders.js';

/** Normal shift: the first event fires in this plant-minute window. */
const NORMAL_FIRST_MIN = [30, 150] as const;
/** Normal shift: a later event waits at least this long after the previous one... */
const NORMAL_GAP_MIN = 60;
/** ...and for the plant to settle, unless this long has passed since the previous one. */
const NORMAL_OVERRIDE_MIN = 180;
/** Hell shift: the first event fires in this window, and each next one this long after the previous. */
const HELL_FIRST_MIN = [30, 120] as const;
const HELL_GAP_MIN = [10, 40] as const;
/** Nothing fires after this plant minute (480 − 60); what is left in the queue is dropped. */
const LAST_FIRE_MIN = 420;
/** Events per shift, fired and queued, cascades included. */
const MAX_EVENTS = 7;
/** Intake chlorophyll alarm level (the web's chlorophyll alarm, apps/web/src/alarms/rules.ts). */
const BLOOM_ALARM_UGL = 4;

/** Kinds that need no response: cleared ("noted") as soon as they fire. */
const INFORMATIONAL: readonly ScenarioKind[] = [
  'seawaterTemp',
  'gasCurtailNotice',
  'gasPriceSpike',
  'offgradeOnly',
  'deliveryDelay',
  'demandChange',
  'pumpBearing',
];

type Params = Record<string, number | string>;
type ClearHow = 'player' | 'crew' | 'expired';

/** A uniform integer in [lo, hi], and the next seed. */
function randInt(seed: number, lo: number, hi: number): [number, number] {
  const [v, next] = nextRandom(seed);
  return [lo + Math.floor(v * (hi - lo + 1)), next];
}

/** Plant minutes since the shift started (0 outside a shift). */
export const elapsedMinutes = (s: PlantState): number =>
  s.shift ? ((s.tick - s.shift.startTick) * TICK_PLANT_S) / 60 : 0;

const runningPumps = (s: PlantState): number => Object.values(s.intake.pumps).filter((p) => p.running).length;

function loopMode(s: PlantState, loopId: string): 'auto' | 'manual' | null {
  const level = /^level(\d+)$/.exec(loopId);
  if (level) return s.loops.levels[Number(level[1]) - 1]?.mode ?? null;
  if (loopId === 'tbt' || loopId === 'intakeFlow' || loopId === 'recirc' || loopId === 'blowdown' || loopId === 'vacuum') {
    return s.loops[loopId].mode;
  }
  return null;
}

/**
 * How fired event `e` has been cleared in state `s`, or null while it still needs a response
 * (spec §4.3 / §4.10). Informational kinds return null: they are marked "noted" when they fire.
 */
export function isCleared(s: PlantState, e: FiredEvent): ClearHow | null {
  const f = s.faults;
  switch (e.kind) {
    case 'pumpTrip':
      return runningPumps(s) >= 2 ? 'player' : null;
    case 'powerDip':
      return runningPumps(s) >= 2 && f.powerDipRemainingTicks === 0 ? 'player' : null;
    case 'tubeLeak':
      return f.tubeLeak === null ? 'crew' : null;
    case 'vacuumLoss':
      return f.ejectorFailed ? null : 'crew';
    case 'sensorFailure':
      return f.sensors[e.params.loop as LoopSensorId] === undefined ? 'crew' : null;
    case 'storm':
      // A storm always adds fouling, which only cleanScreens removes; with it gone the crew cleared
      // the storm. Otherwise the storm clears when it passes (its fouling stays until cleaned).
      if (f.stormFouling === 0) return 'crew';
      return f.stormRemainingTicks === 0 ? 'expired' : null;
    case 'controllerFault':
      return loopMode(s, String(e.params.loop)) === 'manual' ? 'player' : null;
    case 'bloom': {
      const dosedUp = s.pretreat.chlorineMgL > Number(e.params.chlorineAtFireMgL);
      // "Back under the alarm" once the bloom has played out (chlorophyll at its target).
      const chl = s.seawater.chlorophyllUgL;
      const subsided = chl < BLOOM_ALARM_UGL && Math.abs(chl - s.scenario.effects.chlorophyllTarget) < 1e-9;
      return dosedUp || subsided ? 'player' : null;
    }
    case 'seawaterTemp':
    case 'gasCurtailNotice':
    case 'gasPriceSpike':
    case 'offgradeOnly':
    case 'deliveryDelay':
    case 'demandChange':
    case 'pumpBearing':
      return null;
  }
}

/**
 * The plant is settled: every fired event is cleared, no trip is in progress (status online), and
 * product salinity is in spec.
 */
export function isSettled(s: PlantState): boolean {
  const fired = s.chaos.active?.fired ?? [];
  const maxPpm = s.shift?.target.maxSalinityPpm ?? Infinity;
  return fired.every((e) => e.cleared) && s.status === 'online' && s.product.salinityPpm <= maxPpm;
}

/**
 * The pumps a trip or dip may hit (running, not under overhaul), and the spares that could replace
 * one (not running, not under overhaul).
 */
function pumpAvailability(s: PlantState): { running: string[]; spares: string[] } {
  const pumps = Object.entries(s.intake.pumps).filter(([, p]) => p.overhaulRemainingTicks === 0);
  return {
    running: pumps.filter(([, p]) => p.running).map(([id]) => id),
    spares: pumps.filter(([, p]) => !p.running).map(([id]) => id),
  };
}

/**
 * The kind and params `e` actually fires with. A trip or dip is re-checked against the pumps now (the
 * plan was drawn at the previous handover): it re-aims at a running pump if its target has stopped,
 * and when no running pump has a spare to replace it, the next sharp kind in SHARP_KINDS order that
 * is valid fires instead, with freshly drawn params.
 */
function resolve(s: PlantState, e: QueuedEvent, minute: number, seed: number, n: number): [ScenarioKind, Params, number] {
  if (e.kind !== 'pumpTrip' && e.kind !== 'powerDip') return [e.kind, e.params, seed];
  const { running, spares } = pumpAvailability(s);
  if (running.length > 0 && spares.length > 0) {
    if (running.includes(String(e.params.pumpId))) return [e.kind, e.params, seed];
    const [drawn, next] = drawEvent(e.kind, minute, seed, n, running);
    return [e.kind, drawn.params, next];
  }
  const at = SHARP_KINDS.indexOf(e.kind);
  for (let i = 1; i < SHARP_KINDS.length; i++) {
    const kind = SHARP_KINDS[(at + i) % SHARP_KINDS.length]!;
    if (kind === 'pumpTrip' || kind === 'powerDip') continue;
    const [drawn, next] = drawEvent(kind, minute, seed, n);
    return [kind, drawn.params, next];
  }
  return [e.kind, e.params, seed]; // unreachable: SHARP_KINDS holds non-pump kinds
}

/** A hell-shift cascade that `kind` may trigger: the follow-up, its chance, and its delay window. */
const CASCADES: Partial<Record<ScenarioKind, { kind: ScenarioKind; p: number; delayMin: readonly [number, number] }>> = {
  storm: { kind: 'bloom', p: 0.6, delayMin: [60, 120] },
  powerDip: { kind: 'sensorFailure', p: 0.4, delayMin: [0, 0] },
  pumpTrip: { kind: 'pumpBearing', p: 0.4, delayMin: [0, 0] },
};

/**
 * Run the chaos director for one tick of a running shift: mark fired events that have cleared,
 * then fire the head of the queue when its time has come (normal: once the plant has settled, or
 * the 180-minute override; hell: in a burst, rolling cascades). Emits `eventCleared` and `scenario`
 * events. All randomness comes from `state.seed`.
 */
export function stepDirector(s0: PlantState): { state: PlantState; events: SimEvent[] } {
  const a0 = s0.chaos.active;
  if (s0.phase !== 'running' || !s0.shift || !a0) return { state: s0, events: [] };
  const base = { tick: s0.tick, plantTime: s0.plantTime, shiftId: s0.shift.id };
  const events: SimEvent[] = [];
  const minute = elapsedMinutes(s0);
  const { plan } = a0;
  let seed = s0.seed;

  // 1. Newly cleared events.
  const fired = a0.fired.map((e): FiredEvent => {
    if (e.cleared) return e;
    const how = isCleared(s0, e);
    if (!how) return e;
    events.push({ ...base, type: 'eventCleared', eventId: e.eventId, kind: e.kind, how });
    return { ...e, cleared: true, how };
  });
  let queue = plan.queue;
  // The head is unscheduled (earliestMinute 0) until the shift's first tick draws its fire minute.
  const head0 = queue[0];
  if (a0.lastFiredMinute === null && head0 && head0.earliestMinute === 0) {
    const [lo, hi] = plan.hell ? HELL_FIRST_MIN : NORMAL_FIRST_MIN;
    let at: number;
    [at, seed] = randInt(seed, lo, hi);
    queue = [{ ...head0, earliestMinute: at }, ...queue.slice(1)];
  }
  let active: ActiveChaos = { ...a0, fired, plan: { ...plan, queue } };
  let s: PlantState = { ...s0, seed, chaos: { ...s0.chaos, active } };

  // 2. Too late in the shift: drop whatever is left.
  if (minute > LAST_FIRE_MIN) {
    if (queue.length > 0) active = { ...active, plan: { ...plan, queue: [] } };
    return { state: { ...s, chaos: { ...s.chaos, active } }, events };
  }

  // 3. Fire the head when its time has come.
  const head = queue[0];
  if (!head || minute < head.earliestMinute) return { state: s, events };
  const last = a0.lastFiredMinute;
  if (!plan.hell && last !== null) {
    const since = minute - last;
    if (since < NORMAL_GAP_MIN) return { state: s, events };
    if (!isSettled(s) && since < NORMAL_OVERRIDE_MIN) return { state: s, events };
  }

  // 4. Fire.
  let kind: ScenarioKind, params: Params;
  [kind, params, seed] = resolve(s, head, minute, seed, plan.shiftNumber);
  const { spares } = pumpAvailability(s);
  s = applyEffect(s, kind, params);
  events.push({
    ...base,
    type: 'scenario',
    eventId: head.eventId,
    kind,
    message: eventMessage(kind, params),
    radio: radioLine(kind, params),
  });
  const noted = INFORMATIONAL.includes(kind);
  if (noted) events.push({ ...base, type: 'eventCleared', eventId: head.eventId, kind, how: 'noted' });
  const record: FiredEvent = {
    eventId: head.eventId,
    kind,
    params: kind === 'bloom' ? { ...params, chlorineAtFireMgL: s.pretreat.chlorineMgL } : params,
    atMinute: minute,
    cleared: noted,
    how: noted ? 'noted' : null,
  };

  // Schedule the next head: never earlier than its own minimum.
  let rest = queue.slice(1);
  const next = rest[0];
  if (next) {
    let gap = NORMAL_GAP_MIN;
    if (plan.hell) [gap, seed] = randInt(seed, HELL_GAP_MIN[0], HELL_GAP_MIN[1]);
    rest = [{ ...next, earliestMinute: Math.max(next.earliestMinute, minute + gap) }, ...rest.slice(1)];
  }

  // Hell cascades: an immediate follow-up jumps the queue; a delayed one joins its end.
  let nextEventId = a0.nextEventId;
  const cascade = plan.hell ? CASCADES[kind] : undefined;
  if (cascade) {
    let v: number;
    [v, seed] = nextRandom(seed);
    if (v < cascade.p && fired.length + 1 + rest.length < MAX_EVENTS) {
      let delay: number, drawn;
      [delay, seed] = randInt(seed, cascade.delayMin[0], cascade.delayMin[1]);
      [drawn, seed] = drawEvent(cascade.kind, minute + delay, seed, plan.shiftNumber);
      // The bearing goes on the standby the player will start in place of the tripped pump.
      const p = cascade.kind === 'pumpBearing' && spares[0] ? { ...drawn.params, pumpId: spares[0] } : drawn.params;
      const entry: QueuedEvent = { eventId: nextEventId++, kind: cascade.kind, params: p, earliestMinute: minute + delay, cascade: true };
      rest = delay === 0 ? [entry, ...rest] : [...rest, entry];
    }
  }

  active = {
    plan: { ...plan, queue: rest },
    fired: [...fired, record],
    lastFiredMinute: minute,
    nextEventId,
  };
  return { state: { ...s, seed, chaos: { ...s.chaos, active } }, events };
}
