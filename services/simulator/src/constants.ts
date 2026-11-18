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
