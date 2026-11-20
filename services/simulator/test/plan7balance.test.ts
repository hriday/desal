import { describe, expect, it } from 'vitest';
import { SHIFT_TICKS } from '../src/constants.js';
import { drawPendingPlan } from '../src/shift.js';
import { createInitialState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

/*
 * Plan 7 balance baseline, pinned on the 20-stage plant (commit b209717) before any Plan 7 change.
 * The 24-stage layout must not move these (spec §1 anti-goal); Task 3 checks them.
 *
 *   passive Hard broken by shift 3: 20/20
 *   engaged Hard runs (shift reached): 5,5,5,5,5,5,6,6,6,6,6,7,7,7,7,7,7,7,8,8, median 6
 *   engaged runs (shift reached): 7,7,7,8,8,8,8,8,8,8,8,8,8,8,8,9,9,9,9,9,9,9,9,9,9,9,9,9,9,10, median 8.5
 *   passive Normal: all 20 runs survive shift 1 with at least 95 % of its target
 */

/** In-spec water (m3) a calm shift 1 makes on seed 1 with today's plant: printed by the run below on b209717. */
const BASELINE_CALM_SHIFT_M3 = 4254.75;

describe('Plan 7 balance baseline', () => {
  it("a calm shift makes today's water", () => {
    let s = drawPendingPlan(createInitialState(1, 0, GAME_ID));
    s = { ...s, chaos: { ...s.chaos, pending: { ...s.chaos.pending!, queue: [] } } };
    s = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]).state;
    let productM3 = 0;
    for (let i = 0; i < SHIFT_TICKS; i++) {
      const r = tick(s, []);
      s = r.state;
      for (const e of r.events) if (e.type === 'shiftEnd') productM3 = e.summary.productM3;
    }
    expect(s.phase).toBe('handover');
    expect(Math.abs(productM3 - BASELINE_CALM_SHIFT_M3)).toBeLessThanOrEqual(0.01 * BASELINE_CALM_SHIFT_M3);
  });
});
