import { LOOP_DRIFT_PER_TICK, LOOP_OSC_GAIN_MULT } from '../constants.js';
import type { Loop } from '../state.js';

export interface Gains {
  kp: number;
  ki: number;
  kd: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Advance one loop by one tick. Pure: returns a new Loop. `action` is the loop kind's LOOP_ACTION. */
export function pidStep(
  loop: Loop,
  measured: number,
  gains: Gains,
  outMin: number,
  outMax: number,
  dtS: number,
  action: 'direct' | 'reverse' = 'direct',
): Loop {
  const errorOf = (y: number): number => (action === 'direct' ? loop.setpoint - y : y - loop.setpoint);
  if (loop.mode === 'manual') {
    // Back-calculate the integral so switching to auto holds the current output.
    const error = errorOf(measured);
    // The first auto step adds error*dtS before computing, so back-calculate against that.
    const integral =
      gains.ki > 0 ? (loop.output - gains.kp * error) / gains.ki - error * dtS : 0;
    return { ...loop, integral, prevError: error };
  }
  if (loop.fault?.kind === 'stuck') return loop;

  let fault = loop.fault;
  let y = measured;
  if (fault?.kind === 'drift') {
    fault = { ...fault, bias: fault.bias + LOOP_DRIFT_PER_TICK };
    y = measured + fault.bias;
  }
  const mult = fault?.kind === 'oscillate' ? LOOP_OSC_GAIN_MULT : 1;
  const kp = gains.kp * mult;
  const ki = gains.ki * mult;
  const kd = gains.kd * mult;

  const error = errorOf(y);
  const derivative = dtS > 0 ? (error - loop.prevError) / dtS : 0;
  const trialIntegral = loop.integral + error * dtS;
  const raw = kp * error + ki * trialIntegral + kd * derivative;
  const output = clamp(raw, outMin, outMax);
  // Anti-windup: stop integrating while saturated and the error pushes further in.
  const saturatedHigh = raw > outMax && error > 0;
  const saturatedLow = raw < outMin && error < 0;
  const integral = saturatedHigh || saturatedLow ? loop.integral : trialIntegral;
  return { ...loop, output, integral, prevError: error, fault };
}
