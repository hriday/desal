// Simulator constants the client mirrors. Source: services/simulator/src/constants.ts; keep in sync.

/** DEFAULT_MAX_SALINITY_PPM: product salinity limit when no shift target applies (ppm). */
export const DEFAULT_MAX_SALINITY_PPM = 25;
/** INTAKE_REQUIRED_BASE_M3H: required intake flow at seawater <= 30 C (m3/h). */
export const INTAKE_REQUIRED_BASE_M3H = 5500;
/** INTAKE_REQUIRED_PER_C: fractional extra required flow per degC of seawater above 30 C. */
export const INTAKE_REQUIRED_PER_C = 0.03;
/** TICK_PLANT_S: plant seconds advanced per simulation tick. */
export const TICK_PLANT_S = 40;
/** STAGE_COUNT: number of evaporator stages. */
export const STAGE_COUNT = 20;
/** CHANGEOVER_TICKS: ticks a fuel changeover lasts. */
export const CHANGEOVER_TICKS = 8;
