/** Plant seconds advanced per simulation tick. */
export const TICK_PLANT_S = 40;
/** Ticks in one operating shift. */
export const SHIFT_TICKS = 720;
/** Number of evaporator stages. */
export const STAGE_COUNT = 20;
/** Ticks between full state snapshots. */
export const SNAPSHOT_EVERY_TICKS = 30;

/**
 * PI(D) gains per loop kind, sized for errors in each loop's own units at dtS = TICK_PLANT_S
 * (ki multiplies error x seconds). Tuned against the unit models' per-tick process gains:
 * - tbt: integrating plant (recovered heat recirculates), ~0.008 C/tick per % firing.
 * - intakeFlow: instant plant, ~70 m3/h per % speed with two pumps.
 * - recirc: 60 s lag, 50 m3/h per %.
 * - blowdown: 3600 s lag, -0.006 CF per % (reverse).
 * - vacuum: 600 s lag, 0.007 quality per %.
 * - level: integrating plant, -0.0008 m/tick per % valve (reverse).
 */
export const LOOP_GAINS = {
  tbt: { kp: 18, ki: 0.02, kd: 0 },
  intakeFlow: { kp: 0.002, ki: 0.000125, kd: 0 },
  recirc: { kp: 0.004, ki: 0.00015, kd: 0 },
  blowdown: { kp: 500, ki: 0.14, kd: 0 },
  vacuum: { kp: 200, ki: 0.35, kd: 0 },
  level: { kp: 375, ki: 0.7, kd: 0 },
} as const;

/** Setpoint and output ranges per loop kind. 'level' applies to level1..level20. Outputs are percent. */
export const LOOP_RANGES = {
  tbt: { spMin: 90, spMax: 118, outMin: 0, outMax: 100 },
  intakeFlow: { spMin: 0, spMax: 7000, outMin: 0, outMax: 100 },
  recirc: { spMin: 2000, spMax: 5000, outMin: 0, outMax: 100 },
  blowdown: { spMin: 1.2, spMax: 1.8, outMin: 0, outMax: 100 },
  vacuum: { spMin: 0.5, spMax: 1.0, outMin: 0, outMax: 100 },
  level: { spMin: 0.15, spMax: 0.6, outMin: 0, outMax: 100 },
} as const;

/**
 * Controller action per loop kind. 'direct': raising the output raises the measurement
 * (error = setpoint - measured). 'reverse': raising the output lowers it (error = measured -
 * setpoint): a high level must open the drain valve, and a high CF must raise blowdown.
 */
export const LOOP_ACTION: Record<keyof typeof LOOP_GAINS, 'direct' | 'reverse'> = {
  tbt: 'direct',
  intakeFlow: 'direct',
  recirc: 'direct',
  blowdown: 'reverse',
  vacuum: 'direct',
  level: 'reverse',
};

/** Measurement bias added per tick to a drifting loop sensor. */
export const LOOP_DRIFT_PER_TICK = 0.05;
/** Gain multiplier applied to an oscillating loop. */
export const LOOP_OSC_GAIN_MULT = 4;

/** Rated flow of one clean, new intake pump (m3/h). */
export const PUMP_RATED_M3H = 3500;
/** Flow loss at full pump wear (fraction). */
export const PUMP_WEAR_FLOW_LOSS = 0.5;
/** Required intake flow at seawater <= 30 C (m3/h). */
export const INTAKE_REQUIRED_BASE_M3H = 5500;
/** Fractional extra required flow per degC of seawater above 30 C. */
export const INTAKE_REQUIRED_PER_C = 0.03;
/** Biofouling growth per tick per ug/L chlorophyll. */
export const BIO_GROWTH_PER_CHL = 0.000625;
/** Biofouling kill per tick per mg/L chlorine per unit biofouling. */
export const BIO_KILL_PER_CHLORINE = 0.01;
/** Fraction of the biofouling-to-screen gap closed per tick. */
export const SCREEN_LAG_PER_TICK = 0.02;
/** Screen fouling above which pumps can cavitate. */
export const CAVITATION_SCREEN_THRESHOLD = 0.5;
/** Pump speed (percent) above which pumps can cavitate. */
export const CAVITATION_SPEED_PCT = 80;
/** Cavitation rise per tick at full screen fouling. */
export const CAVITATION_RISE_PER_TICK = 0.04;
/** Cavitation decay per tick when conditions are not met. */
export const CAVITATION_DECAY_PER_TICK = 0.01;
/** Baseline pump wear per tick (thousands of plant hours to wear out). */
export const PUMP_WEAR_BASE_PER_TICK = 2.2e-6;
/** Extra pump wear per tick at full cavitation. */
export const PUMP_WEAR_CAVITATION_PER_TICK = 3e-5;

/** Maximum burner thermal output (MW). */
export const BURNER_MAX_MW = 60;
/** Uncurtailed gas supply cap (MW): each shift starts here unless its scenario says otherwise. */
export const GAS_CAP_MW = 60;
/** Base gas price (USD/GJ): each shift starts here unless its scenario says otherwise. */
export const GAS_BASE_PRICE_USD_PER_GJ = 8;
/** Off-grade backup fuel limits the burner to this fraction of BURNER_MAX_MW. */
export const OFFGRADE_CAP_FRACTION = 0.85;
/** Burner output cap during a fuel changeover, as a fraction of BURNER_MAX_MW. */
export const CHANGEOVER_CAP_FRACTION = 0.5;
/** Ticks a fuel changeover lasts. */
export const CHANGEOVER_TICKS = 8;
/** Manual-mode firing (percent) above which a changeover flames out the burner. */
export const FLAMEOUT_FIRING_PCT = 60;
/** Lower heating value of standard backup fuel (MJ/kg). */
export const LHV_STANDARD_MJkg = 42.5;
/** Lower heating value of off-grade backup fuel (MJ/kg). */
export const LHV_OFFGRADE_MJkg = 38;

/** Specific heat of brine (J/kg/K). */
export const CP_BRINE = 4000;
/** Brine heater thermal time constant (s). */
export const HEATER_TAU_S = 600;
/** Burner condition lost per tick on gas (about 0.01 per 8-hour shift of 720 ticks). */
export const BURNER_WEAR_GAS = 1.4e-5;
/** Burner wear multiplier on standard-grade backup fuel. */
export const BURNER_WEAR_STANDARD_MULT = 3;
/** Burner wear multiplier on off-grade backup fuel. */
export const BURNER_WEAR_OFFGRADE_MULT = 6;
/** Brine density (kg/m3). */
export const BRINE_DENSITY = 1025;
/** Floor on brine recirculation mass flow (kg/s) so zero flow stays finite. */
export const MIN_RECIRC_KGS = 1;

/** Latent heat of vaporisation used for flash distillate (J/kg). */
export const LATENT_J_kg = 2.33e6;
/** Distillate density used to convert mass flow to volume flow (kg/m3). */
export const DISTILLATE_DENSITY = 1000;
/** Total scale thickness at which stage effectiveness halves (mm). */
export const SCALE_REF_MM = 1.0;
/** Heater temperature rise needed with perfectly clean tubes (degC); divided by mean effectiveness. */
export const HEATER_DT0_C = 9;
/** Bottom-stage approach to seawater with perfect vacuum and full cooling flow (degC). */
export const BOTTOM_APPROACH_C = 6;
/** Bottom-stage temperature rise at zero vacuum quality (degC). */
export const BOTTOM_VACUUM_PENALTY_C = 20;
/** Bottom-stage temperature rise at zero cooling (intake) flow (degC). */
export const BOTTOM_FLOW_PENALTY_C = 15;
/** Soft scale growth rate at 110 C with no antiscalant and CF <= 1.5 (mm/s). */
export const SCALE_K = 3e-6;
/** Fraction of soft scale that hardens per second (1/s). */
export const SOFT_TO_HARD_PER_S = 1e-6;
/** Fractional removal of soft scale per second while ball cleaning runs (1/s). */
export const BALL_CLEAN_RATE = 2e-4;
/** Distillate multiplier while ball cleaning runs. */
export const BALL_CLEAN_DISTILLATE_FACTOR = 0.95;

/** Brine recirculation at full recirc pump output (m3/h). */
export const RECIRC_PUMP_MAX_M3H = 5000;
/** Nominal brine recirculation the stage levels are balanced against (m3/h). */
export const RECIRC_NOMINAL_M3H = 4180;
/** Recirc flow time constant (s). */
export const RECIRC_TAU_S = 60;
/** Vacuum quality with no ejector steam. */
export const VACUUM_QUALITY_MIN = 0.3;
/** Nominal vacuum quality. */
export const VACUUM_QUALITY_NOMINAL = 0.95;
/** Vacuum quality time constant (s). */
export const VACUUM_TAU_S = 600;
/** Concentration factor with blowdown fully closed. */
export const CF_MAX = 1.8;
/** Concentration factor with blowdown fully open. */
export const CF_MIN = 1.2;
/** Nominal concentration factor (blowdown loop setpoint). */
export const CF_NOMINAL = 1.45;
/** Concentration factor time constant (s). */
export const CF_TAU_S = 3600;
/** Blowdown flow at full blowdown valve (m3/h). */
export const BLOWDOWN_MAX_M3H = 1800;
/** Interstage valve opening (percent) that holds the level at nominal recirc. */
export const LEVEL_BALANCE_VALVE_PCT = 50;
/** Level rate per unit of inflow/outflow imbalance (m/s). */
export const K_LEVEL = 0.002;
/** Level jump per unit fractional change of recirc flow (m). */
export const LEVEL_RECIRC_DISTURB_M = 0.5;
/** Maximum stage level (m). */
export const LEVEL_MAX_M = 1.0;
/** Stage level above which brine carries over into the distillate (m). */
export const CARRYOVER_LEVEL_M = 0.6;
/** Product salinity with clean separation and no carryover (ppm). */
export const BASE_SALINITY_PPM = 8;
/** Product salinity added per unit of brine carryover (ppm). */
export const CARRYOVER_SALINITY_PPM = 400;
/** Concentration factor above which product salinity starts to rise. */
export const CF_SALINITY_KNEE = 1.5;
/** Product salinity added per unit of concentration factor above the knee (ppm). */
export const CF_SALINITY_PPM = 10;
/** Product salinity limit when no shift target applies (ppm). */
export const DEFAULT_MAX_SALINITY_PPM = 25;

/** TBT high-high trip (degC). */
export const TBT_HH_C = 118;
/** Stage level at or above which the stage-flood interlock trips (m). */
export const LEVEL_FLOOD_M = 0.8;
/** Vacuum quality below which the loss-of-vacuum interlock trips. */
export const VACUUM_TRIP = 0.6;
/** Intake flow, as a fraction of required, below which the no-intake-flow interlock trips. */
export const INTAKE_TRIP_FRACTION = 0.2;
/** Hard scale added to each of the hottest stages by a trip's thermal cycle (mm). */
export const TRIP_SCALE_MM = 0.02;
/** Number of hottest stages (1..N) that take thermal-cycling scale on a trip. */
export const TRIP_SCALE_STAGES = 5;
/** Burner condition lost to a trip's thermal cycle. */
export const TRIP_BURNER_DAMAGE = 0.01;

/** Vacuum quality the restart's vacuum step must reach before recirc may start. */
export const RESTART_VACUUM_MIN = 0.85;
/** Recirc flow, as a fraction of its setpoint, the recirc step must reach before ignition. */
export const RESTART_RECIRC_FRACTION = 0.8;
/** Burner firing (percent) set at ignition. */
export const IGNITION_FIRING_PCT = 15;
/** Firing rise per tick the Auto ramp allows itself (percent per tick); below RAMP_WARN_PCT_PER_TICK. */
export const AUTO_RAMP_PCT_PER_TICK = 5;
/**
 * An Auto restart step that makes no progress for this many ticks (1 plant hour) gives up, back to
 * tripped. Before the ramp a step must complete in this time; the ramp counts each
 * RESTART_PROGRESS_TBT_C gain in TBT as progress (a cold ramp legitimately takes ~300 ticks).
 */
export const RESTART_STEP_TIMEOUT_TICKS = 90;
/** TBT gain (C) over the best seen in the ramp that counts as progress and restarts the stall clock. */
export const RESTART_PROGRESS_TBT_C = 0.5;
/** Manual firing rise per tick above which the burner wears and the hot stages scale (percent per tick). */
export const RAMP_WARN_PCT_PER_TICK = 10;
/** Manual firing rise per tick above which the burner flames out and the plant re-trips (percent per tick). */
export const RAMP_TRIP_PCT_PER_TICK = 25;
/** Burner condition lost per tick of an over-fast manual ramp. */
export const RAMP_BURNER_WEAR = 0.002;
/** Hard scale added per tick of an over-fast manual ramp to each of the hottest stages (mm). */
export const RAMP_SCALE_MM = 0.005;
/** The plant is back online once TBT is within this margin of its setpoint (degC). */
export const ONLINE_MARGIN_C = 2;
/** Acid clean duration (ticks): 2 plant hours. */
export const ACID_CLEAN_TICKS = 180;

// Operating account (spec 3.1): tunable placeholders. Water output is the point; the account only
// limits spending. There is no revenue and there are no fines.
/** Balance a new game starts with (USD). */
export const START_BALANCE_USD = 15000;
/** Shift 1's operating allocation, credited at startShift (USD). */
export const ALLOC_BASE_USD = 10000;
/** Cut of the base allocation per shift: shift n gets 1 - ALLOC_DECAY_PER_SHIFT x (n - 1) of it. */
export const ALLOC_DECAY_PER_SHIFT = 0.03;
/** Cost of an acid clean, charged when it starts (USD). */
export const ACID_CLEAN_COST_USD = 6000;
/** Cost of a pump overhaul, charged when it starts (USD). */
export const PUMP_OVERHAUL_COST_USD = 8000;
/** Product target of shift 1 (m3); later shifts scale it by 1 + TARGET_GROWTH_PER_SHIFT x (n - 1). */
export const BASE_TARGET_M3 = 3900;
/** Fractional target growth per shift (uncapped): each shift of a run is harder than the last. */
export const TARGET_GROWTH_PER_SHIFT = 0.04;
/** Fuel guidance for shift 1 (USD), shown at handover; scales with the target. */
export const BASE_FUEL_BUDGET_USD = 12000;
/** Ticks a pump overhaul lasts (1 plant hour); counted only while the shift runs. */
export const PUMP_OVERHAUL_TICKS = 90;

/** Concurrency cap: live games per simulator; over it, startGame is answered with gameRejected capacity. */
export const MAX_GAMES = 10;

/** Wear a tripped pump takes (fraction of its life). */
export const PUMP_TRIP_WEAR = 0.1;
/** Screen fouling a storm adds per tick while it lasts. */
export const STORM_FOULING_PER_TICK = 0.0005;
/** Recirculation cap (fraction of the pump's maximum) when a power dip gives none. */
export const POWER_DIP_RECIRC_FACTOR = 0.6;
/** Longest power dip the draw may make, in plant minutes, however hard the shift. */
export const POWER_DIP_MAX_MINUTES = 60;
