import type { FuelGrade, LoopId } from '@desal/schema';

// Command limits and prices the client mirrors so controls show ranges and costs before sending.
// Sources (keep in sync): services/simulator/src/constants.ts (LOOP_RANGES, PUMP_OVERHAUL_COST_USD,
// ACID_CLEAN_COST_USD, LHV_*), services/simulator/src/commands.ts (DOSE_MAX_MGL, ORDER_MIN_T/ORDER_MAX_T).
// Prices that change at run time (backup fuel) come from status, not from here. The plant still
// validates every command; these only shape the UI.

/** LOOP_RANGES: setpoint and output ranges per loop kind; 'level' covers level1..level20. Outputs are percent. */
export const LOOP_RANGES = {
  tbt: { spMin: 90, spMax: 118, outMin: 0, outMax: 100 },
  intakeFlow: { spMin: 0, spMax: 7000, outMin: 0, outMax: 100 },
  recirc: { spMin: 2000, spMax: 5000, outMin: 0, outMax: 100 },
  blowdown: { spMin: 1.2, spMax: 1.8, outMin: 0, outMax: 100 },
  vacuum: { spMin: 0.5, spMax: 1.0, outMin: 0, outMax: 100 },
  level: { spMin: 0.15, spMax: 0.6, outMin: 0, outMax: 100 },
} as const;

export type LoopKind = keyof typeof LOOP_RANGES;

/** DOSE_MAX_MGL: chlorine and antiscalant doses are 0..10 mg/L. */
export const DOSE_MAX_MGL = 10;
/** ORDER_MIN_T / ORDER_MAX_T: one backup fuel order is 1..500 t. */
export const ORDER_MIN_T = 1;
export const ORDER_MAX_T = 500;
/** PUMP_OVERHAUL_COST_USD: charged when an overhaul starts. */
export const PUMP_OVERHAUL_COST_USD = 8000;
/** ACID_CLEAN_COST_USD: charged when an acid clean starts. */
export const ACID_CLEAN_COST_USD = 6000;
/** LHV_STANDARD_MJkg / LHV_OFFGRADE_MJkg, numerically GJ/t. */
export const LHV_GJ_PER_T: Record<FuelGrade, number> = { standard: 42.5, offgrade: 38 };

export const loopKind = (loop: LoopId): LoopKind => (loop.startsWith('level') ? 'level' : (loop as LoopKind));

/** The range a setSetpoint or setOutput for this loop must fall in. */
export function loopRange(loop: LoopId, type: 'setSetpoint' | 'setOutput'): { min: number; max: number } {
  const r = LOOP_RANGES[loopKind(loop)];
  return type === 'setSetpoint' ? { min: r.spMin, max: r.spMax } : { min: r.outMin, max: r.outMax };
}

/**
 * Price of a backup fuel order of the offered grade: tonnes x LHV x the reported backup price
 * (status.fuel.backupPriceUsdPerGJ). An unknown grade prices as standard (the dearer); an unknown
 * price gives undefined (no estimate, so no order).
 */
export function backupOrderCostUsd(tonnes: number, grade: FuelGrade, priceUsdPerGJ: number | undefined): number | undefined {
  if (typeof priceUsdPerGJ !== 'number' || !Number.isFinite(priceUsdPerGJ)) return undefined;
  const lhv = Object.hasOwn(LHV_GJ_PER_T, grade) ? LHV_GJ_PER_T[grade] : LHV_GJ_PER_T.standard;
  return tonnes * lhv * priceUsdPerGJ;
}

/**
 * Estimated water target (m3) for shift n, shown on the handover before the shift starts; once the shift
 * runs, status.shiftTarget is authoritative. Approximates the scenario targets in
 * services/simulator/src/scenario/library.ts (base 3900 m3, growing each shift).
 */
export const nextTargetEstimateM3 = (n: number): number => Math.round(3900 * (1 + 0.04 * (n - 1)));
