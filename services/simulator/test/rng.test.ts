import { nextRandom } from '../src/rng.js';

describe('nextRandom', () => {
  it('is deterministic', () => {
    expect(nextRandom(42)).toEqual(nextRandom(42));
  });
  it('stays in [0,1) over 10k draws', () => {
    let seed = 7;
    for (let i = 0; i < 10000; i++) {
      const [v, next] = nextRandom(seed);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      seed = next;
    }
  });
});
