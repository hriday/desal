import type { AccountCause } from '@desal/schema';
import {
  ALLOC_BASE_USD,
  ALLOC_DECAY_PER_SHIFT,
  LHV_OFFGRADE_MJkg,
  LHV_STANDARD_MJkg,
  STANDBY_STEAM_COST_USD_PER_H,
  STANDING_COST_USD_PER_HOUR,
  TICK_PLANT_S,
} from './constants.js';
import type { PlantState, SimEvent } from './state.js';

/**
 * Operating allocation for shift `n`, credited at its start: ALLOC_BASE_USD x (1 - 0.03(n - 1)),
 * and from shift 2 also x min(1, previous shift's in-spec m3 / its target). Floored at 0. With no
 * previous shift on record the performance factor is 1.
 */
export function allocationUsd(n: number, prev: { productM3: number; targetM3: number } | null): number {
  const base = ALLOC_BASE_USD * Math.max(0, 1 - ALLOC_DECAY_PER_SHIFT * (n - 1));
  if (n < 2 || !prev || prev.targetM3 <= 0) return base;
  return base * Math.min(1, Math.max(0, prev.productM3 / prev.targetM3));
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

/** Take spending off the balance and add it to the running shift's spentUsd. */
function spend(s: PlantState, usd: number): PlantState {
  const run = { ...s.run, balanceUsd: s.run.balanceUsd - usd };
  if (!s.shift) return { ...s, run };
  return { ...s, run, shift: { ...s.shift, acc: { ...s.shift.acc, spentUsd: s.shift.acc.spentUsd + usd } } };
}

/** Pay for gas burned this tick. Per-tick spending emits no event (the balance shows in status). */
export const spendPerTick = (s: PlantState, usd: number): PlantState => (usd === 0 ? s : spend(s, usd));

const accountChange = (s: PlantState, deltaUsd: number, cause: AccountCause): SimEvent => ({
  type: 'accountChange',
  tick: s.tick,
  plantTime: s.plantTime,
  shiftId: s.shift?.id ?? null,
  deltaUsd,
  balanceUsd: s.run.balanceUsd,
  cause,
});

/** Debit a discrete charge (delivery, repair), count it as shift spending, and report it. */
export function charge(s: PlantState, usd: number, cause: AccountCause): { state: PlantState; event: SimEvent } {
  const state = spend(s, usd);
  return { state, event: accountChange(state, -usd, cause) };
}

const TICKS_PER_HOUR = 3600 / TICK_PLANT_S;

/**
 * Charge one running tick's share of the standing cost, whatever the plant status. Call after the
 * clock has advanced. The charge is spent every tick, but reported as one accountChange per plant
 * hour of the shift (carrying that hour's total), so plant.events is not flooded.
 */
export function chargeStanding(s: PlantState): { state: PlantState; events: SimEvent[] } {
  const state = spend(s, STANDING_COST_USD_PER_HOUR / TICKS_PER_HOUR);
  const hourDone = s.shift !== null && (s.tick - s.shift.startTick) % TICKS_PER_HOUR === 0;
  return { state, events: hourDone ? [accountChange(state, -STANDING_COST_USD_PER_HOUR, 'standing')] : [] };
}

/**
 * Charge one running tick's share of the standby steam line's running cost while the line is on (call
 * after chargeStanding). Like the standing cost it is spent every tick and reported on the same plant
 * hour boundaries, as one accountChange carrying the hour's on-time total (none for an hour it was off).
 */
export function chargeStandbySteam(s: PlantState): { state: PlantState; events: SimEvent[] } {
  if (!s.steam.standby && s.steam.unbilledTicks === 0) return { state: s, events: [] };
  let state = s;
  let unbilledTicks = s.steam.unbilledTicks;
  if (s.steam.standby) {
    state = spend(state, STANDBY_STEAM_COST_USD_PER_H / TICKS_PER_HOUR);
    unbilledTicks += 1;
  }
  const hourDone = s.shift !== null && (s.tick - s.shift.startTick) % TICKS_PER_HOUR === 0;
  if (!hourDone || unbilledTicks === 0) return { state: { ...state, steam: { ...state.steam, unbilledTicks } }, events: [] };
  state = { ...state, steam: { ...state.steam, unbilledTicks: 0 } };
  return { state, events: [accountChange(state, -(unbilledTicks * STANDBY_STEAM_COST_USD_PER_H) / TICKS_PER_HOUR, 'standbySteam')] };
}

/** Credit an allocation and report it. */
export function credit(s: PlantState, usd: number, cause: AccountCause): { state: PlantState; event: SimEvent } {
  const state: PlantState = { ...s, run: { ...s.run, balanceUsd: s.run.balanceUsd + usd } };
  return { state, event: accountChange(state, usd, cause) };
}
