import { LOOP_RANGES } from './constants.js';
import { nextRandom } from './rng.js';
import type { LoopSensorId, PlantState } from './state.js';

const LOOP_SALT: Record<LoopSensorId, number> = { tbt: 1, intakeFlow: 2, recirc: 3, blowdown: 4, vacuum: 5 };

/** The process value a loop controls, as the plant really has it. */
export function trueLoopValue(s: PlantState, loop: LoopSensorId): number {
  switch (loop) {
    case 'tbt':
      return s.heater.tbtC;
    case 'intakeFlow':
      return s.intake.flowM3h;
    case 'recirc':
      return s.brine.recircM3h;
    case 'blowdown':
      return s.brine.concentrationFactor;
    case 'vacuum':
      return s.vacuum.quality;
  }
}

/**
 * What a loop's sensor reads: the true value, unless the sensor has failed. A frozen sensor returns
 * its stored value; a noisy one adds symmetric noise of `amplitude` x the loop's span. The noise is a
 * pure function of state.seed (which stepFaults advances once per tick) and the loop, so the PID and
 * the telemetry of one tick agree and a replay reproduces it exactly.
 */
export function measured(s: PlantState, loop: LoopSensorId, trueValue: number): number {
  const fault = s.faults.sensors[loop];
  if (!fault) return trueValue;
  if (fault.kind === 'freeze') return fault.value;
  const [u] = nextRandom((s.seed + LOOP_SALT[loop] * 0x9e3779b1) >>> 0);
  const range = LOOP_RANGES[loop];
  return trueValue + (u * 2 - 1) * fault.amplitude * (range.spMax - range.spMin);
}
