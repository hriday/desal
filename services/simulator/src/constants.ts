/** Plant seconds advanced per simulation tick. */
export const TICK_PLANT_S = 40;
/** Ticks in one operating shift. */
export const SHIFT_TICKS = 720;
/** Number of evaporator stages. */
export const STAGE_COUNT = 20;
/** Ticks between full state snapshots. */
export const SNAPSHOT_EVERY_TICKS = 30;

/** PI(D) gains per loop kind. Placeholder tuning; real tuning happens in the calibration task. */
export const LOOP_GAINS = {
  tbt: { kp: 5, ki: 0.3, kd: 0 },
  intakeFlow: { kp: 0.6, ki: 0.05, kd: 0 },
  recirc: { kp: 0.6, ki: 0.05, kd: 0 },
  blowdown: { kp: 0.5, ki: 0.04, kd: 0 },
  vacuum: { kp: 0.5, ki: 0.04, kd: 0 },
  level: { kp: 0.7, ki: 0.05, kd: 0 },
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
