import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CALL_SIGN_WORDS, callSignFor } from '../src/callsign.js';
import { drawPendingPlan } from '../src/shift.js';
import { createInitialState } from '../src/state.js';

describe('call signs', () => {
  it('has 64 distinct words', () => {
    expect(CALL_SIGN_WORDS).toHaveLength(64);
    expect(new Set(CALL_SIGN_WORDS).size).toBe(64);
  });

  it('is deterministic from the seed', () => {
    expect(callSignFor(7)).toBe(callSignFor(7));
  });

  it('is a capitalised word and a two-digit number for every seed, and uses most of the words', () => {
    const words = new Set<string>();
    for (let seed = 0; seed < 1000; seed++) {
      const c = callSignFor(seed);
      expect(c).toMatch(/^[A-Z][a-z]+-[1-9][0-9]$/);
      words.add(c.split('-')[0]!);
    }
    expect(words.size).toBeGreaterThanOrEqual(40);
  });

  it('a new game takes its call sign from the seed', () => {
    expect(createInitialState(3, 0, '11111111-1111-4111-8111-111111111111').run.callSign).toBe(callSignFor(3));
  });

  it('does not consume the game seed: the shift-1 plan for seed 3 is the one drawn before call signs existed', () => {
    // Captured from the simulator before call signs were added (same seed, time and gameId).
    const before = JSON.parse(readFileSync(new URL('./fixtures/pending-plan-seed3.json', import.meta.url), 'utf8'));
    const s = drawPendingPlan(createInitialState(3, Date.UTC(2026, 0, 1), '11111111-1111-4111-8111-111111111111'));
    expect(s.seed).toBe(before.seed);
    expect(s.chaos.pending).toEqual(before.pending);
  });
});
