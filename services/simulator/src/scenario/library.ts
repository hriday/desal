import type { ScenarioKind } from '@desal/schema';
import {
  BASE_FUEL_BUDGET_USD,
  BASE_TARGET_M3,
  EJECTOR_RATE_BASE_PER_MIN,
  EJECTOR_RATE_MAX_PER_MIN,
  POWER_DIP_MAX_MINUTES,
  RECOVERY_STAGES,
  TARGET_GROWTH_PER_SHIFT,
} from '../constants.js';
import { nextRandom } from '../rng.js';
import { radioLine } from './orders.js';
import type { Scenario, ScenarioEvent } from './types.js';

const PUMPS = ['P-101', 'P-102', 'P-103'] as const;
const FAULT_LOOPS = ['tbt', 'intakeFlow', 'recirc', 'blowdown', 'vacuum', 'makeup'] as const;
const FAULT_KINDS = ['stuck', 'drift', 'oscillate'] as const;
/**
 * Shift 1's gentle sensor failure only hits loops whose frozen reading visibly misleads the plant
 * (a frozen blowdown or vacuum reading barely shows), and always freezes (spec §4.10).
 */
const SHIFT_ONE_SENSOR_LOOPS = ['tbt', 'intakeFlow', 'recirc'] as const;

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
    case 'pumpTrip':
    case 'tubeLeak':
    case 'vacuumLoss':
    case 'powerDip':
    case 'storm':
    case 'sensorFailure':
      return radioLine(kind, p);
    case 'fuelContamination':
    case 'earthquake':
    case 'tsunami':
      return radioLine(kind, p);
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
export const difficulty = (n: number): number => 1 + TARGET_GROWTH_PER_SHIFT * (Math.max(1, n) - 1);

/** Shift `n`'s fuel budget (USD). */
export const shiftFuelBudgetUsd = (n: number): number => Math.round(BASE_FUEL_BUDGET_USD * difficulty(n));

/** Shift `n`'s product target. */
export const shiftTargetM3 = (n: number): number => Math.round(BASE_TARGET_M3 * difficulty(n));

/**
 * Draw params and a message for an event of `kind` occurring at `atMinute` in shift `n`. Severity
 * scales with `n`; timing details (ramp, notice lead) and which pump or loop is hit stay random.
 */
export function drawEvent(
  kind: ScenarioKind,
  atMinute: number,
  seed: number,
  n: number,
  /** The pumps a trip or dip may hit (running ones); defaults to all three. */
  hittablePumps: readonly string[] = PUMPS,
  /** The fuel the burner is on; fuelContamination hits this one. */
  activeFuel: 'gas' | 'backup' = 'gas',
): [ScenarioEvent, number] {
  let s = seed;
  const d = difficulty(n);
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
      params = { pumpId, mult: tidy(Math.min(6, 1 + 0.5 * n)) };
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
      params = { ticks: Math.min(180, 15 * n) };
      break;
    case 'demandChange':
      params = { deltaM3: Math.min(600, 25 * n) };
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
    case 'pumpTrip': {
      let pumpId: string;
      [pumpId, s] = pick(s, hittablePumps);
      params = { pumpId };
      break;
    }
    case 'tubeLeak': {
      let stage: number;
      // Recovery stages 1-21 only: a reject-stage leak (seawater in its tubes) would barely show.
      [stage, s] = range(s, 0, RECOVERY_STAGES - 1);
      params = { stage, ppm: tidy(Math.min(20, 8 * d)) };
      break;
    }
    case 'vacuumLoss':
      params = { ratePerMin: tidy(Math.min(EJECTOR_RATE_MAX_PER_MIN, EJECTOR_RATE_BASE_PER_MIN * d)) };
      break;
    case 'powerDip': {
      let pumpId: string, minutes: number;
      [pumpId, s] = pick(s, hittablePumps);
      [minutes, s] = range(s, 20, 40, 5);
      params = { pumpId, recircFactor: tidy(Math.max(0.35, 0.7 - 0.1 * d)), minutes: Math.min(POWER_DIP_MAX_MINUTES, Math.round(minutes * d)) };
      break;
    }
    case 'storm': {
      let minutes: number;
      [minutes, s] = range(s, 60, 120, 10);
      params = { fouling: tidy(Math.min(0.4, 0.1 * d)), deltaC: tidy(Math.min(6, 1.5 * d)), minutes };
      break;
    }
    case 'tsunami': {
      let warnMinutes: number, coolC: number;
      [warnMinutes, s] = range(s, 15, 25);
      [coolC, s] = range(s, 1, 2, 0.1);
      params = { warnMinutes, coolC };
      break;
    }
    case 'fuelContamination':
      params = { fuel: activeFuel };
      break;
    case 'sensorFailure': {
      let loop: string, mode: string;
      if (n === 1) {
        [loop, s] = pick(s, SHIFT_ONE_SENSOR_LOOPS);
        mode = 'freeze';
      } else {
        [loop, s] = pick(s, FAULT_LOOPS);
        [mode, s] = pick(s, ['freeze', 'noise'] as const);
      }
      params = { loop, mode };
      break;
    }
  }
  return [{ atMinute, kind, params, message: eventMessage(kind, params) }, s];
}

/**
 * The scenario for shift `shiftNumber`: the conditions the shift starts in and its base target.
 * Events come from the chaos plan (drawChaosPlan), not from the scenario.
 */
export function scenarioForShift(shiftNumber: number, rngSeed: number): Scenario {
  const n = Math.max(1, shiftNumber);
  const target = {
    productM3: shiftTargetM3(n),
    maxSalinityPpm: 25,
    fuelBudgetUsd: shiftFuelBudgetUsd(n),
  };
  if (n === 1) {
    return { id: 'shift-1', target, initial: { seawaterTempC: 30, chlorophyllUgL: 1 }, events: [] };
  }
  let s = rngSeed >>> 0;
  let tempC: number, chl: number;
  [tempC, s] = range(s, 28, 33, 0.5);
  [chl, s] = range(s, 0.5, 2, 0.1);
  return { id: `shift-${n}`, target, initial: { seawaterTempC: tempC, chlorophyllUgL: chl }, events: [] };
}
