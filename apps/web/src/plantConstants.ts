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
/** DESIGN_PRODUCT_M3H: design product flow (m3/h). Mirrors the simulator's NOMINAL.productM3h at 93.5 C TBT (services/simulator/src/state.ts). */
export const DESIGN_PRODUCT_M3H = 531.9;
/**
 * PLANT_MAX_PRODUCT_M3H: best product flow the plant can make, flat out at TBT 112 C and recirc 6500 (m3/h).
 * Source: services/simulator/src/constants.ts (pinned there by test/maxproduct.test.ts). Running hotter
 * is the intended way to catch up (spec 4.12), so the quota bar's "out of reach" uses this, not the design flow.
 */
export const PLANT_MAX_PRODUCT_M3H = 857;
/** RECIRC_NOMINAL_M3H: nominal brine recirculation (m3/h). Source: services/simulator/src/constants.ts. */
export const RECIRC_NOMINAL_M3H = 5350;

/**
 * The crew's jobs: cost (USD) and duration (plant minutes). Mirrors the simulator's CREW_JOBS in
 * services/simulator/src/constants.ts (spec 4.6); keep in sync. `plain` names the job on a button, `doing` the work under way.
 */
export const CREW_JOBS = {
  plugTubes: { costUsd: 800, minutes: 60, plain: 'plug tubes', doing: 'Plugging tubes' },
  repairEjector: { costUsd: 1000, minutes: 45, plain: 'repair ejector', doing: 'Repairing ejector' },
  replaceSensor: { costUsd: 400, minutes: 30, plain: 'replace instrument', doing: 'Replacing sensor' },
  cleanScreens: { costUsd: 300, minutes: 30, plain: 'clean screens', doing: 'Cleaning screens' },
} as const;
