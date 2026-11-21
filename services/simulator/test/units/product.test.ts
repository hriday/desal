import { describe, expect, it } from 'vitest';
import { BASE_SALINITY_PPM, CARRYOVER_SALINITY_PPM } from '../../src/constants.js';
import { createInitialState } from '../../src/state.js';
import { rawSalinityPpm, stepProduct } from '../../src/units/product.js';
import { allFinite } from '../helpers.js';
import { GAME_ID } from '../envelope.js';

const DT = 40;
const base = () => {
  const s = createInitialState(1, 0, GAME_ID);
  return { ...s, brine: { ...s.brine, concentrationFactor: 1.45 } };
};

describe('stepProduct', () => {
  it('is in spec at nominal and delivers distillate x dt/3600', () => {
    const r = stepProduct(base(), 500, 0, DT);
    expect(r.state.product.salinityPpm).toBeLessThan(25);
    expect(r.state.product.flowM3h).toBe(500);
    expect(r.deliveredM3).toBeCloseTo((500 * DT) / 3600, 12);
    expect(r.offSpec).toBe(false);
    expect(allFinite(r)).toBe(true);
  });

  it('goes off-spec but still delivers with carryover 0.1', () => {
    const s = base();
    const manual = { ...s, product: { ...s.product, divertMode: 'manual' as const } };
    const r = stepProduct(manual, 500, 0.1, DT);
    expect(rawSalinityPpm(base(), 0.1)).toBeGreaterThanOrEqual(40);
    // Lagged: one 40 s step from 8 ppm is above the 25 ppm limit but not yet at raw.
    expect(r.state.product.salinityPpm).toBeGreaterThan(25);
    expect(r.offSpec).toBe(true);
    expect(r.deliveredM3).toBeGreaterThan(0);
  });

  it('adds salinity above CF 1.5', () => {
    const s = base();
    const hiS = { ...s, brine: { ...s.brine, concentrationFactor: 1.8 } };
    expect(rawSalinityPpm(hiS, 0)).toBeCloseTo(11, 12);
    expect(stepProduct(hiS, 500, 0, DT).state.product.salinityPpm).toBeGreaterThan(8);
  });

  it('diverts to drain: nothing delivered, never off-spec', () => {
    const s = base();
    const r = stepProduct({ ...s, product: { ...s.product, divertToDrain: true } }, 500, 0.1, DT);
    expect(r.deliveredM3).toBe(0);
    expect(r.offSpec).toBe(false);
  });

  it('does not mutate its input', () => {
    const s = base();
    const copy = (JSON.parse(JSON.stringify(s)) as typeof s);
    stepProduct(s, 500, 0.1, DT);
    expect(s).toEqual(copy);
  });

  it('raw salinity at nominal is the base, and stepProduct holds it exactly', () => {
    const s = base();
    expect(rawSalinityPpm(s, 0)).toBe(BASE_SALINITY_PPM);
    expect(stepProduct(s, 500, 0, DT).state.product.salinityPpm).toBe(BASE_SALINITY_PPM);
  });

  const withSal = (ppm: number) => {
    const s = base();
    return { ...s, product: { ...s.product, salinityPpm: ppm } };
  };
  // Carryover that makes the raw value `ppm` at CF 1.45.
  const carryFor = (ppm: number) => (ppm - BASE_SALINITY_PPM) / CARRYOVER_SALINITY_PPM;

  it('rises with a 60 s time constant', () => {
    const r = stepProduct(withSal(10), 500, carryFor(40), 60);
    expect(r.state.product.salinityPpm).toBeCloseTo(10 + 30 * (1 - Math.exp(-1)), 9);
  });

  it('falls with a 300 s time constant, and is within 5% of the gap after 15 plant minutes', () => {
    const one = stepProduct(withSal(40), 500, carryFor(10), 300);
    expect(one.state.product.salinityPpm).toBeCloseTo(40 - 30 * (1 - Math.exp(-1)), 9);
    let s = withSal(40);
    for (let i = 0; i < 23; i++) s = stepProduct(s, 500, carryFor(10), 40).state;
    expect(s.product.salinityPpm - 10).toBeLessThan(0.05 * 30 + 1e-9);
  });
});
