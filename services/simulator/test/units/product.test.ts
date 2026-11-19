import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../src/state.js';
import { stepProduct } from '../../src/units/product.js';
import { allFinite } from '../helpers.js';

const DT = 40;
const base = () => {
  const s = createInitialState(1, 0);
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
    const r = stepProduct(base(), 500, 0.1, DT);
    expect(r.state.product.salinityPpm).toBeGreaterThanOrEqual(40);
    expect(r.offSpec).toBe(true);
    expect(r.deliveredM3).toBeGreaterThan(0);
  });

  it('adds salinity above CF 1.5', () => {
    const s = base();
    const hi = stepProduct({ ...s, brine: { ...s.brine, concentrationFactor: 1.8 } }, 500, 0, DT);
    expect(hi.state.product.salinityPpm).toBeCloseTo(11, 12);
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
});
