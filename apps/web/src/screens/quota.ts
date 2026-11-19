import { PLANT_MAX_PRODUCT_M3H, TICK_PLANT_S } from '../plantConstants';

export type Pace = 'done' | 'onPace' | 'behind' | 'outOfReach';

export interface PaceInput { productM3: number; targetM3: number; flowM3h: number; ticksRemaining: number }

const fin = (v: number) => (Number.isFinite(v) ? v : 0);

/** Where the shift quota stands: met, on pace at the current flow, behind, or out of reach even with the plant flat out. */
export function paceState(input: PaceInput): Pace {
  const product = fin(input.productM3);
  const target = fin(input.targetM3);
  if (product >= target) return 'done';
  const hoursLeft = Math.max(0, fin(input.ticksRemaining)) * TICK_PLANT_S / 3600;
  if (product + PLANT_MAX_PRODUCT_M3H * hoursLeft < target) return 'outOfReach';
  if (product + Math.max(0, fin(input.flowM3h)) * hoursLeft >= target) return 'onPace';
  return 'behind';
}

/** Bar fill 0..1; 0 for a missing or non-positive target. */
export function progress(productM3: number, targetM3: number): number {
  const t = fin(targetM3);
  return t > 0 ? Math.min(1, Math.max(0, fin(productM3) / t)) : 0;
}

/** Whole minutes of crew work left, from a (possibly fractional) tick count. */
export const crewMinutesLeft = (remainingTicks: number): number =>
  Math.max(0, Math.ceil(fin(remainingTicks) * TICK_PLANT_S / 60));
