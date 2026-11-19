import type { AccountCause } from '@desal/schema';
import {
  LHV_OFFGRADE_MJkg,
  LHV_STANDARD_MJkg,
  OFFSPEC_FINE_PER_M3,
  REVENUE_PER_M3,
  SHORTFALL_FINE_PER_M3,
} from './constants.js';
import type { PlantState, SimEvent } from './state.js';

/**
 * Money from one tick's delivered product: in-spec water earns revenue, off-spec water earns nothing
 * and is fined. The caller passes 0 m3 unless the plant was online.
 */
export function tickRevenue(deliveredM3: number, offSpec: boolean): { revenueUsd: number; fineUsd: number } {
  return offSpec
    ? { revenueUsd: 0, fineUsd: deliveredM3 * OFFSPEC_FINE_PER_M3 }
    : { revenueUsd: deliveredM3 * REVENUE_PER_M3, fineUsd: 0 };
}

/** Fine for ending a shift short of its product target. */
export function shortfallFineUsd(targetM3: number, productM3: number): number {
  return Math.max(0, targetM3 - productM3) * SHORTFALL_FINE_PER_M3;
}

/**
 * Price of `tonnes` of backup fuel of the grade currently offered, paid in full on order:
 * tonnes x LHV (GJ/t, numerically the MJ/kg value) x backup price (USD/GJ).
 */
export function backupOrderCostUsd(s: PlantState, tonnes: number): number {
  const lhvGJt = s.scenario.effects.offgradeOnly ? LHV_OFFGRADE_MJkg : LHV_STANDARD_MJkg;
  return tonnes * lhvGJt * s.fuel.backup.priceUsdPerGJ;
}

export const canAfford = (s: PlantState, usd: number): boolean => s.run.balanceUsd >= usd;

/**
 * Apply a per-tick movement (revenue in, gas and off-spec fines out) to the balance. Per-tick
 * amounts emit no event (they show in status); only discrete charges do, via charge().
 */
export function settleTick(s: PlantState, creditUsd: number, debitUsd: number): PlantState {
  return { ...s, run: { ...s.run, balanceUsd: s.run.balanceUsd + creditUsd - debitUsd } };
}

/** Debit a discrete charge (delivery, repair, shortfall fine) and report it as an accountChange. */
export function charge(s: PlantState, usd: number, cause: AccountCause): { state: PlantState; event: SimEvent } {
  const balanceUsd = s.run.balanceUsd - usd;
  return {
    state: { ...s, run: { ...s.run, balanceUsd } },
    event: {
      type: 'accountChange',
      tick: s.tick,
      plantTime: s.plantTime,
      shiftId: s.shift?.id ?? null,
      deltaUsd: -usd,
      balanceUsd,
      cause,
    },
  };
}
