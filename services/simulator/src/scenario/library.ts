import type { ScenarioKind } from '@desal/schema';
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

/** Draw sensible params and a message for an event of `kind` occurring at `atMinute`. */
export function drawEvent(kind: ScenarioKind, atMinute: number, seed: number): [ScenarioEvent, number] {
  let s = seed;
  let params: Record<string, number | string> = {};
  switch (kind) {
    case 'bloom': {
      let peakUgL: number, rampMinutes: number;
      [peakUgL, s] = range(s, 4, 10);
      [rampMinutes, s] = range(s, 60, 180, 10);
      params = { peakUgL, rampMinutes };
      break;
    }
    case 'seawaterTemp': {
      let deltaC: number;
      [deltaC, s] = range(s, 1, 4, 0.5);
      params = { deltaC };
      break;
    }
    case 'pumpBearing': {
      let pumpId: string, mult: number;
      [pumpId, s] = pick(s, PUMPS);
      [mult, s] = range(s, 2, 6, 0.5);
      params = { pumpId, mult };
      break;
    }
    case 'gasCurtailNotice': {
      let capMW: number, lead: number;
      [capMW, s] = range(s, 20, 35);
      [lead, s] = range(s, 60, 120, 10);
      params = { capMW, effectiveMinute: atMinute + lead };
      break;
    }
    case 'gasPriceSpike': {
      let mult: number;
      [mult, s] = range(s, 1.3, 2, 0.1);
      params = { mult };
      break;
    }
    case 'deliveryDelay': {
      let ticks: number;
      [ticks, s] = range(s, 45, 180, 15);
      params = { ticks };
      break;
    }
    case 'demandChange': {
      let deltaM3: number;
      [deltaM3, s] = range(s, -300, 300, 50);
      params = { deltaM3 };
      break;
    }
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

const PROCEDURAL_KINDS: ScenarioKind[] = [
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

export function scenarioForShift(shiftNumber: number, rngSeed: number): Scenario {
  if (shiftNumber <= 1) {
    return {
      id: 'calm-seas',
      target: { productM3: 3900, maxSalinityPpm: 25, fuelBudgetUsd: 12000 },
      initial: { seawaterTempC: 30, chlorophyllUgL: 1 },
      events: [],
      randomPerHour: [],
    };
  }
  if (shiftNumber === 2) {
    return {
      id: 'green-water',
      target: { productM3: 3900, maxSalinityPpm: 25, fuelBudgetUsd: 12000 },
      initial: { seawaterTempC: 30, chlorophyllUgL: 1 },
      events: [ev(90, 'bloom', { peakUgL: 8, rampMinutes: 120 })],
      randomPerHour: [],
    };
  }
  if (shiftNumber === 3) {
    return {
      id: 'pipeline-notice',
      target: { productM3: 3700, maxSalinityPpm: 25, fuelBudgetUsd: 16000 },
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
  const scale = Math.min(1.15, 1 + 0.02 * (shiftNumber - 3));
  // Pick 2-4 distinct kinds without replacement.
  let count: number;
  [count, s] = range(s, 2, 4);
  const pool = [...PROCEDURAL_KINDS];
  const events: ScenarioEvent[] = [];
  for (let i = 0; i < count; i++) {
    let idx: number;
    [idx, s] = range(s, 0, pool.length - 1);
    const kind = pool.splice(idx, 1)[0] as ScenarioKind;
    let atMinute: number;
    [atMinute, s] = range(s, 0, 360, 10);
    let e: ScenarioEvent;
    [e, s] = drawEvent(kind, atMinute, s);
    events.push(e);
  }
  events.sort((a, b) => a.atMinute - b.atMinute);
  let tempC: number, chl: number;
  [tempC, s] = range(s, 28, 33, 0.5);
  [chl, s] = range(s, 0.5, 2, 0.1);
  return {
    id: `procedural-${shiftNumber}`,
    target: {
      productM3: Math.round(3900 * scale),
      maxSalinityPpm: 25,
      fuelBudgetUsd: Math.round(12000 * scale),
    },
    initial: { seawaterTempC: tempC, chlorophyllUgL: chl },
    events,
    randomPerHour: [
      { kind: 'controllerFault', p: 0.05 },
      { kind: 'gasPriceSpike', p: 0.05 },
    ],
  };
}
