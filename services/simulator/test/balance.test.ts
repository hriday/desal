import { beforeAll, describe, expect, it } from 'vitest';
import { CREW_JOBS } from '../src/constants.js';
import { allocationUsd } from '../src/economy.js';
import { engagedRun, median, type RunResult } from './bot.js';

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
const MAX_SHIFTS = 40;

// R19: doing the right thing must not end the run early (spec §2 anti-goal). The engaged bot
// (test/bot.ts) answers every event as the spec intends and otherwise leaves Auto alone.
describe('balance: an engaged player', () => {
  let runs: RunResult[] = [];
  beforeAll(() => {
    runs = SEEDS.map((seed) => engagedRun(seed, MAX_SHIFTS));
  }, 120_000);

  it('lasts a median of at least 8 shifts over 30 seeds', () => {
    const lengths = runs.map((r) => r.shifts);
    console.log(`engaged runs (shift reached): ${[...lengths].sort((a, b) => a - b).join(',')}, median ${median(lengths)}`);
    expect(median(lengths)).toBeGreaterThanOrEqual(8);
  });

  it('still pays real money for the crew: it is a choice, not a free fix', () => {
    const shift1 = allocationUsd(1, null);
    for (const [job, { costUsd }] of Object.entries(CREW_JOBS)) {
      expect(costUsd, job).toBeGreaterThanOrEqual(0.025 * shift1);
    }
    const crewPerShift = runs.reduce((sum, r) => sum + r.crewSpentUsd, 0) / runs.reduce((sum, r) => sum + r.shifts, 0);
    expect(crewPerShift).toBeGreaterThanOrEqual(0.04 * shift1);
  });
});
