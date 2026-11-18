import type { LoopId } from '@desal/schema';
import type { LOOP_GAINS } from '../constants.js';

/** Map a loop id to its gain/range kind: levelN -> 'level'. */
export function loopKind(loop: LoopId): keyof typeof LOOP_GAINS {
  return loop.startsWith('level') ? 'level' : (loop as keyof typeof LOOP_GAINS);
}
