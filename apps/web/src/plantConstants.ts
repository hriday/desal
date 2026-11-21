// Simulator constants the client mirrors. Source: services/simulator/src/constants.ts; keep in sync.

/** DEFAULT_MAX_SALINITY_PPM: product salinity limit when no shift target applies (ppm). */
export const DEFAULT_MAX_SALINITY_PPM = 25;
/** INTAKE_REQUIRED_BASE_M3H: required intake flow at seawater <= 30 C (m3/h). */
export const INTAKE_REQUIRED_BASE_M3H = 5500;
/** INTAKE_REQUIRED_PER_C: fractional extra required flow per degC of seawater above 30 C. */
export const INTAKE_REQUIRED_PER_C = 0.03;
/** EJECTOR_FULL_REACH_BAR: motive steam at or above which the ejector reaches full vacuum (bar). Source: services/simulator/src/constants.ts; the Motive steam row is `warn` below it. */
export const EJECTOR_FULL_REACH_BAR = 13;
/** STEAM_BAD_BAR: motive steam below which the Motive steam row turns `bad` (bar). */
export const STEAM_BAD_BAR = 11;
/** TICK_PLANT_S: plant seconds advanced per simulation tick. */
export const TICK_PLANT_S = 40;
/** STAGE_COUNT: number of evaporator stages: heat recovery 1-21, then heat rejection 22-24. Source: services/simulator/src/constants.ts. */
export const STAGE_COUNT = 24;
/** RECOVERY_STAGES: heat-recovery stages (1-21), whose tubes carry the recycled brine. Source: services/simulator/src/constants.ts. */
export const RECOVERY_STAGES = 21;
/** LEVEL_LOOP_COUNT: interstage level loops level1..level23; stage 24 (the brine pool) is the makeup loop's. Source: services/simulator/src/constants.ts. */
export const LEVEL_LOOP_COUNT = 23;
/** RECIRC_SUCTION_MIN_M: brine pool (S24) level below which the recirc pump loses suction (m). Source: services/simulator/src/constants.ts. */
export const RECIRC_SUCTION_MIN_M = 0.1;
/**
 * MAKEUP_NOMINAL_M3H: seawater makeup into the brine pool at nominal (m3/h), replacing the distillate and
 * blowdown drawn from it. Mirrors the simulator's NOMINAL.makeupM3h (services/simulator/src/state.ts), about 1713.7.
 */
export const MAKEUP_NOMINAL_M3H = 1714;
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
  flushFuel: { costUsd: 1500, minutes: 60, plain: 'flush fuel', doing: 'Flushing fuel' },
  cleanStrainer: { costUsd: 400, minutes: 30, plain: 'clean the condenser strainer', doing: 'Cleaning condenser strainer' },
  sealLeak: { costUsd: 600, minutes: 60, plain: 'seal the air leak', doing: 'Sealing air leak' },
} as const;

/** STAGE24_NOMINAL_APPROACH_C: nominal stage 24 temperature above seawater (degC): BOTTOM_APPROACH_C 6 + (1 - VACUUM_QUALITY_NOMINAL 0.95) x BOTTOM_VACUUM_PENALTY_C 20. Source: services/simulator/src/constants.ts and units/stages.ts bottomTempC. */
export const STAGE24_NOMINAL_APPROACH_C = 7;
/** STAGE24_WARN_MARGIN_MBAR: the Stage 24 pressure row warns this far (mbar) above the nominal for the seawater temperature. */
export const STAGE24_WARN_MARGIN_MBAR = 10;
/** INTERCOND_WARN_HIGH_MBAR / INTERCOND_WARN_LOW_MBAR: the Intercondenser row warns at or above / at or below these (nominal 250 mbar): cooling loss or air leak / failed ejector. */
export const INTERCOND_WARN_HIGH_MBAR = 350;
export const INTERCOND_WARN_LOW_MBAR = 160;
/** COOLING_OUT_WARN_RISE_C: the Condenser cooling out row warns at or above seawater plus this (degC); nominal is seawater + 6. */
export const COOLING_OUT_WARN_RISE_C = 10;
/** VENT_AIR_WARN_HIGH_KGH / VENT_AIR_WARN_LOW_KGH: the Vent air row warns at or above / at or below these (nominal 10 kg/h): air leak / failed ejector. */
export const VENT_AIR_WARN_HIGH_KGH = 18;
export const VENT_AIR_WARN_LOW_KGH = 6;
/** STAGE24_FLOW_PENALTY_C: stage 24 temperature rise at zero cooling (intake) flow (degC); scales with the intake shortfall. Source: BOTTOM_FLOW_PENALTY_C in services/simulator/src/constants.ts. */
export const STAGE24_FLOW_PENALTY_C = 15;
