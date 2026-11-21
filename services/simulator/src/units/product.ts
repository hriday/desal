import {
  BASE_SALINITY_PPM,
  CARRYOVER_SALINITY_PPM,
  CF_SALINITY_KNEE,
  CF_SALINITY_PPM,
  DEFAULT_MAX_SALINITY_PPM,
  DIVERT_RETURN_FRACTION,
  SALINITY_FALL_TAU_S,
  SALINITY_RISE_TAU_S,
} from '../constants.js';
import type { PlantState } from '../state.js';
import { lag } from './lag.js';

/** The salinity the product is heading toward: carryover, brine concentration and tube leak. */
export function rawSalinityPpm(s: PlantState, carryover: number): number {
  const cf = s.brine.concentrationFactor;
  return (
    BASE_SALINITY_PPM +
    carryover * CARRYOVER_SALINITY_PPM +
    (cf > CF_SALINITY_KNEE ? (cf - CF_SALINITY_KNEE) * CF_SALINITY_PPM : 0) +
    (s.faults.tubeLeak?.ppm ?? 0)
  );
}

/**
 * Product water: salinity lags toward its raw value (fast up, slow down). In Auto the divert valve
 * follows the lagged salinity with a hysteresis band; in Manual it keeps the player's latch.
 * Delivery unless diverted to drain.
 */
export function stepProduct(
  s: PlantState,
  distillateM3h: number,
  carryover: number,
  dtS: number,
): { state: PlantState; deliveredM3: number; offSpec: boolean } {
  const raw = rawSalinityPpm(s, carryover);
  const prev = s.product.salinityPpm;
  const salinityPpm = lag(prev, raw, dtS, raw > prev ? SALINITY_RISE_TAU_S : SALINITY_FALL_TAU_S);
  const limit = s.shift?.target.maxSalinityPpm ?? DEFAULT_MAX_SALINITY_PPM;
  let divert = s.product.divertToDrain;
  if (s.product.divertMode === 'auto') {
    if (salinityPpm > limit) divert = true;
    else if (salinityPpm < DIVERT_RETURN_FRACTION * limit) divert = false;
  }
  return {
    state: { ...s, product: { ...s.product, flowM3h: distillateM3h, salinityPpm, divertToDrain: divert } },
    deliveredM3: divert ? 0 : (distillateM3h * dtS) / 3600,
    offSpec: !divert && salinityPpm > limit,
  };
}
