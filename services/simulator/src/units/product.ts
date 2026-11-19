import {
  BASE_SALINITY_PPM,
  CARRYOVER_SALINITY_PPM,
  CF_SALINITY_KNEE,
  CF_SALINITY_PPM,
  DEFAULT_MAX_SALINITY_PPM,
} from '../constants.js';
import type { PlantState } from '../state.js';

/** Product water: salinity from carryover and brine concentration; delivery unless diverted to drain. */
export function stepProduct(
  s: PlantState,
  distillateM3h: number,
  carryover: number,
  dtS: number,
): { state: PlantState; deliveredM3: number; offSpec: boolean } {
  const cf = s.brine.concentrationFactor;
  const salinityPpm =
    BASE_SALINITY_PPM +
    carryover * CARRYOVER_SALINITY_PPM +
    (cf > CF_SALINITY_KNEE ? (cf - CF_SALINITY_KNEE) * CF_SALINITY_PPM : 0);
  const limit = s.shift?.target.maxSalinityPpm ?? DEFAULT_MAX_SALINITY_PPM;
  const divert = s.product.divertToDrain;
  return {
    state: { ...s, product: { ...s.product, flowM3h: distillateM3h, salinityPpm } },
    deliveredM3: divert ? 0 : (distillateM3h * dtS) / 3600,
    offSpec: !divert && salinityPpm > limit,
  };
}
