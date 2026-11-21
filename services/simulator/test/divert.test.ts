import type { Command } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { BASE_SALINITY_PPM, CARRYOVER_SALINITY_PPM } from '../src/constants.js';
import { applyCommand } from '../src/commands.js';
import { applyEffect } from '../src/scenario/effects.js';
import { startShift } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { stepProduct } from '../src/units/product.js';
import { GAME_ID } from './envelope.js';

const DT = 40;
const LIMIT = 25;
const ID = '123e4567-e89b-42d3-a456-426614174000';
const env = (command: Command, shiftId: number | null = 1) => ({ commandId: ID, issuedAt: 0, gameId: GAME_ID, shiftId, command });

const quiet = (): PlantState => {
  const s = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
  return { ...s, chaos: { ...s.chaos, active: null } };
};
const run = (s: PlantState, n: number): PlantState => {
  for (let i = 0; i < n; i++) s = tick(s, []).state;
  return s;
};
/** Nominal product state with a given lagged salinity, mode and valve. */
const product = (ppm: number, mode: 'auto' | 'manual', divert: boolean): PlantState => {
  const s = createInitialState(1, 0, GAME_ID);
  return {
    ...s,
    brine: { ...s.brine, concentrationFactor: 1.45 },
    product: { ...s.product, salinityPpm: ppm, divertMode: mode, divertToDrain: divert },
  };
};
/** Step with the lagged salinity forced to `ppm`; the carryover makes raw == ppm so it holds exactly. */
const at = (s: PlantState, ppm: number) => {
  const forced = { ...s, product: { ...s.product, salinityPpm: ppm } };
  return stepProduct(forced, 500, (ppm - BASE_SALINITY_PPM) / CARRYOVER_SALINITY_PPM, DT);
};

describe('auto divert band (limit 25)', () => {
  it('diverts above the limit, holds in the band, returns below 0.9 x limit, then stays', () => {
    let r = at(product(8, 'auto', false), 25.1);
    expect(r.state.product.divertToDrain).toBe(true);
    expect(r.deliveredM3).toBe(0);
    expect(r.offSpec).toBe(false);
    r = at(r.state, 23.0);
    expect(r.state.product.divertToDrain).toBe(true);
    r = at(r.state, 22.4);
    expect(r.state.product.divertToDrain).toBe(false);
    expect(r.deliveredM3).toBeGreaterThan(0);
    r = at(r.state, 24.0);
    expect(r.state.product.divertToDrain).toBe(false);
  });
});

describe('manual divert', () => {
  it('a latch on stays diverted even at 5 ppm', () => {
    const r = stepProduct(product(5, 'manual', true), 500, 0, DT);
    expect(r.state.product.divertToDrain).toBe(true);
    expect(r.deliveredM3).toBe(0);
  });
  it('a latch off delivers at 40 ppm and is off-spec', () => {
    const r = at(product(40, 'manual', false), 40);
    expect(r.state.product.divertToDrain).toBe(false);
    expect(r.deliveredM3).toBeGreaterThan(0);
    expect(r.offSpec).toBe(true);
  });
});

describe('toggling by hand while Auto is diverting', () => {
  it('Auto diverts at 30 ppm; divertToDrain off goes Manual delivering off-spec; back to Auto in the band holds; no flip-flop', () => {
    let r = at(product(8, 'auto', false), 30);
    expect(r.state.product.divertToDrain).toBe(true);

    const planted = (st: PlantState): PlantState => ({ ...quiet(), product: { ...st.product } });
    let s = applyCommand(planted(r.state), env({ type: 'divertToDrain', on: false })).state;
    expect(s.product.divertMode).toBe('manual');
    expect(s.product.divertToDrain).toBe(false);
    r = at(s, 30);
    expect(r.state.product.divertToDrain).toBe(false);
    expect(r.offSpec).toBe(true);

    s = applyCommand({ ...s, product: { ...s.product, salinityPpm: 23 } }, env({ type: 'setDivertMode', mode: 'auto' })).state;
    expect(s.product.divertMode).toBe('auto');
    expect(s.product.divertToDrain).toBe(false);
    r = at(s, 23);
    expect(r.state.product.divertToDrain).toBe(false);
    expect(r.deliveredM3).toBeGreaterThan(0);

    let st = r.state;
    for (let i = 0; i < 30; i++) {
      st = at(st, i % 2 === 0 ? 22.6 : 24.9).state;
      expect(st.product.divertToDrain).toBe(false);
    }
    st = at(st, 25.5).state;
    expect(st.product.divertToDrain).toBe(true);
  });

  it('a valve held to drain in the band never flips either', () => {
    let st = at(product(8, 'auto', false), 26).state;
    for (let i = 0; i < 30; i++) {
      st = at(st, i % 2 === 0 ? 22.6 : 24.9).state;
      expect(st.product.divertToDrain).toBe(true);
    }
  });
});

describe('tick level: a tube leak in a new (Auto) game', () => {
  it('loses no in-spec water to offSpecM3 and resumes delivery only below 0.9 x limit', () => {
    let s = run(quiet(), 30);
    s = applyEffect(s, 'tubeLeak', { stage: 2, ppm: 40 });
    let diverted = false;
    for (let i = 0; i < 80; i++) {
      s = tick(s, []).state;
      if (s.product.salinityPpm > LIMIT) {
        diverted = true;
        expect(s.product.divertToDrain).toBe(true);
      }
      expect(s.shift!.acc.offSpecM3).toBe(0);
    }
    expect(diverted).toBe(true);
    // Plug the leak: salinity decays and the valve stays on drain until below 0.9 x limit.
    s = { ...s, faults: { ...s.faults, tubeLeak: null } };
    let resumedAt: number | null = null;
    for (let i = 0; i < 400 && resumedAt === null; i++) {
      const before = s.shift!.acc.productM3;
      s = tick(s, []).state;
      expect(s.shift!.acc.offSpecM3).toBe(0);
      if (s.shift!.acc.productM3 > before) resumedAt = s.product.salinityPpm;
    }
    expect(resumedAt).not.toBeNull();
    expect(resumedAt!).toBeLessThan(0.9 * LIMIT);
  });
});
