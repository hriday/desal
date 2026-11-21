import type { LoopId } from '@desal/schema';
import { BURNER_MIN_FIRING_PCT, LOOP_RANGES, type LOOP_GAINS } from '../constants.js';

/** Map a loop id to its gain/range kind: levelN -> 'level'. */
export function loopKind(loop: LoopId): keyof typeof LOOP_GAINS {
  return loop.startsWith('level') ? 'level' : (loop as keyof typeof LOOP_GAINS);
}

/**
 * The output range a loop's PID may command in Auto. The TBT loop never asks for less than the
 * burner's minimum fire: a cut setpoint lets TBT fall at low fire instead of starving the flame.
 */
export function autoOutputRange(kind: keyof typeof LOOP_GAINS): { outMin: number; outMax: number } {
  const { outMin, outMax } = LOOP_RANGES[kind];
  return { outMin: kind === 'tbt' ? Math.max(outMin, BURNER_MIN_FIRING_PCT) : outMin, outMax };
}
