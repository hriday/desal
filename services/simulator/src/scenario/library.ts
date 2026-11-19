import type { ScenarioKind } from '@desal/schema';
import { BASE_FUEL_BUDGET_USD, BASE_TARGET_M3, TARGET_GROWTH_PER_SHIFT } from '../constants.js';
import { nextRandom } from '../rng.js';
import type { Scenario, ScenarioEvent } from './types.js';

const PUMPS = ['P-101', 'P-102', 'P-103'] as const;
const FAULT_LOOPS = ['tbt', 'intakeFlow', 'recirc', 'blowdown', 'vacuum'] as const;
const FAULT_KINDS = ['stuck', 'drift', 'oscillate'] as const;

export function eventMessage(kind: ScenarioKind, p: Record<string, number | string>): string {
  switch (kind) {
    case 'bloom':
      return `Algal bloom in the intake water: chlorophyll rising toward ${p.peakUgL} ug/L.`;
    case 'seawaterTemp':
      return `Seawater temperature ${Number(p.deltaC) >= 0 ? 'rising' : 'falling'} by ${Math.abs(Number(p.deltaC))} C.`;
    case 'pumpBearing':
      return `Pump ${p.pumpId} bearing wear accelerating (x${p.mult}).`;
    case 'gasCurtailNotice':
      return `Gas supplier notice: supply capped at ${p.capMW} MW from plant minute ${p.effectiveMinute}.`;
    case 'gasPriceSpike':
      return `Gas price spike: price multiplied by ${p.mult}.`;
    case 'offgradeOnly':
      return 'Backup fuel deliveries are off-grade only.';
    case 'deliveryDelay':
      return `Backup fuel delivery delayed by ${p.ticks} ticks.`;
    case 'demandChange':
      return `Water demand changed by ${Number(p.deltaM3) >= 0 ? '+' : ''}${p.deltaM3} m3.`;
    case 'controllerFault':
      return `Controller fault on loop ${p.loop}: ${p.kind}.`;
  }
}

function pick<T>(seed: number, items: readonly T[]): [T, number] {
  const [v, next] = nextRandom(seed);
  return [items[Math.floor(v * items.length)] as T, next];
}

function range(seed: number, lo: number, hi: number, step = 1): [number, number] {
  const [v, next] = nextRandom(seed);
  const n = Math.round((lo + v * (hi - lo)) / step) * step;
  return [Number(n.toFixed(6)), next];
}

/** Round away float noise so params and messages stay readable. */
const tidy = (x: number): number => Number(x.toFixed(6));

/** Difficulty multiplier for shift `n`: 4% harder per shift, uncapped. */
const difficulty = (n: number): number => 1 + TARGET_GROWTH_PER_SHIFT * (Math.max(1, n) - 1);

/** Shift `n`'s product target. The hand-written shifts 2-3 follow it too. */
export const shiftTargetM3 = (n: number): number => Math.round(BASE_TARGET_M3 * difficulty(n));

/** Scheduled events drawn for procedural shift `n` (>= 4): two, one more every second shift, at most eight. */
export const eventCountForShift = (n: number): number => Math.min(2 + Math.floor((n - 4) / 2), 8);

/**
 * Draw params and a message for an event of `kind` occurring at `atMinute` in shift `n`. Severity
 * scales with `n`; timing details (ramp, notice lead) and which pump or loop is hit stay random.
 */
export function drawEvent(kind: ScenarioKind, atMinute: number, seed: number, n: number): [ScenarioEvent, number] {
  let s = seed;
  let params: Record<string, number | string> = {};
  switch (kind) {
    case 'bloom': {
      let rampMinutes: number;
      [rampMinutes, s] = range(s, 60, 180, 10);
      params = { peakUgL: tidy(6 + 0.5 * n), rampMinutes };
      break;
    }
    case 'seawaterTemp':
      params = { deltaC: tidy(Math.min(8, 0.5 * n)) };
      break;
    case 'pumpBearing': {
      let pumpId: string;
      [pumpId, s] = pick(s, PUMPS);
      params = { pumpId, mult: tidy(1 + 0.5 * n) };
      break;
    }
    case 'gasCurtailNotice': {
      let lead: number;
      [lead, s] = range(s, 60, 120, 10);
      params = { capMW: Math.max(0, 40 - 3 * n), effectiveMinute: atMinute + lead };
      break;
    }
    case 'gasPriceSpike':
      params = { mult: tidy(1.2 + 0.05 * n) };
      break;
    case 'deliveryDelay':
      params = { ticks: 15 * n };
      break;
    case 'demandChange':
      params = { deltaM3: 25 * n };
      break;
    case 'controllerFault': {
      let loop: string, fkind: string;
      [loop, s] = pick(s, FAULT_LOOPS);
      [fkind, s] = pick(s, FAULT_KINDS);
      params = { loop, kind: fkind };
      break;
    }
    case 'offgradeOnly':
      break;
  }
  return [{ atMinute, kind, params, message: eventMessage(kind, params) }, s];
}

function ev(atMinute: number, kind: ScenarioKind, params: ScenarioEvent['params']): ScenarioEvent {
  return { atMinute, kind, params, message: eventMessage(kind, params) };
}

/** Controller faults appear (scheduled or random) from this shift on. */
const CONTROLLER_FAULTS_FROM_SHIFT = 5;

const PROCEDURAL_KINDS: readonly ScenarioKind[] = [
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

/**
 * The scenario for shift `shiftNumber`. Shifts 1-3 are hand-written; later shifts are procedural,
 * with more and more severe events as the run goes on (eventCountForShift, drawEvent). Every shift's
 * target follows shiftTargetM3; the fuel budget (guidance only) scales with it.
 */
export function scenarioForShift(shiftNumber: number, rngSeed: number): Scenario {
  const n = Math.max(1, shiftNumber);
  const target = { productM3: shiftTargetM3(n), maxSalinityPpm: 25 };
  if (n === 1) {
    return {
      id: 'calm-seas',
      target: { ...target, fuelBudgetUsd: BASE_FUEL_BUDGET_USD },
      initial: { seawaterTempC: 30, chlorophyllUgL: 1 },
      events: [],
      randomPerHour: [],
    };
  }
  if (n === 2) {
    return {
      id: 'green-water',
      target: { ...target, fuelBudgetUsd: BASE_FUEL_BUDGET_USD },
      initial: { seawaterTempC: 30, chlorophyllUgL: 1 },
      events: [ev(90, 'bloom', { peakUgL: 8, rampMinutes: 120 })],
      randomPerHour: [],
    };
  }
  if (n === 3) {
    return {
      id: 'pipeline-notice',
      target: { ...target, fuelBudgetUsd: 16000 },
      initial: { seawaterTempC: 30, chlorophyllUgL: 1 },
      events: [
        ev(0, 'offgradeOnly', {}),
        ev(60, 'gasCurtailNotice', { capMW: 25, effectiveMinute: 180 }),
        ev(240, 'gasPriceSpike', { mult: 1.8 }),
      ],
      randomPerHour: [],
    };
  }

  let s = rngSeed >>> 0;
  // Controller faults join the mix from shift 5. Kinds are drawn without replacement.
  const faults = n >= CONTROLLER_FAULTS_FROM_SHIFT;
  const pool = PROCEDURAL_KINDS.filter((k) => faults || k !== 'controllerFault');
  const count = Math.min(eventCountForShift(n), pool.length);
  const events: ScenarioEvent[] = [];
  for (let i = 0; i < count; i++) {
    let idx: number;
    [idx, s] = range(s, 0, pool.length - 1);
    const kind = pool.splice(idx, 1)[0] as ScenarioKind;
    let atMinute: number;
    [atMinute, s] = range(s, 0, 360, 10);
    let e: ScenarioEvent;
    [e, s] = drawEvent(kind, atMinute, s, n);
    events.push(e);
  }
  events.sort((a, b) => a.atMinute - b.atMinute);
  let tempC: number, chl: number;
  [tempC, s] = range(s, 28, 33, 0.5);
  [chl, s] = range(s, 0.5, 2, 0.1);
  return {
    id: `procedural-${n}`,
    target: { ...target, fuelBudgetUsd: Math.round(BASE_FUEL_BUDGET_USD * difficulty(n)) },
    initial: { seawaterTempC: tempC, chlorophyllUgL: chl },
    events,
    randomPerHour: [
      ...(faults ? [{ kind: 'controllerFault' as const, p: 0.05 }] : []),
      { kind: 'gasPriceSpike', p: 0.05 },
    ],
  };
}
