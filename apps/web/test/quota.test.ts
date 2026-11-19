import { crewMinutesLeft, paceState, progress } from '../src/screens/quota';

// 360 ticks = 4 h left at 40 s/tick; the plant's best flow is 857 m3/h (PLANT_MAX_PRODUCT_M3H), so 4 h can make 3,428 m3.
const base = { productM3: 0, targetM3: 1000, flowM3h: 300, ticksRemaining: 360 };

describe('paceState', () => {
  it('done once the target is met', () => expect(paceState({ ...base, productM3: 1000 })).toBe('done'));
  it('onPace when the current flow reaches the target in time', () =>
    expect(paceState({ ...base, flowM3h: 300 })).toBe('onPace'));
  it('behind when current flow falls short but the plant flat out could still make it', () =>
    expect(paceState({ ...base, flowM3h: 100 })).toBe('behind'));
  it('outOfReach when even the plant flat out cannot make it', () =>
    expect(paceState({ ...base, targetM3: 3500, flowM3h: 500 })).toBe('outOfReach'));
  it('not outOfReach when running hotter could still make it (above design flow, under the max)', () => {
    // 4 h at the 531.9 m3/h design flow makes 2,128 m3; the plant's 857 m3/h max makes 3,428.
    expect(paceState({ ...base, targetM3: 3000, flowM3h: 500 })).toBe('behind');
  });
  it('a shift-4 target at tick 0 is not out of reach (C2)', () =>
    // 4,368 m3 in 8 h: above the 4,255 nominal output, well under the plant's maximum.
    expect(paceState({ productM3: 0, targetM3: 4368, flowM3h: 531.9, ticksRemaining: 720 })).toBe('behind'));
  it('no time left and short of target is outOfReach, not NaN', () =>
    expect(paceState({ ...base, productM3: 10, ticksRemaining: 0 })).toBe('outOfReach'));
  it('a zero target is done', () => expect(paceState({ ...base, targetM3: 0 })).toBe('done'));
  it('survives NaN inputs', () =>
    expect(paceState({ productM3: NaN, targetM3: 100, flowM3h: NaN, ticksRemaining: NaN })).toBe('outOfReach'));
});

describe('progress and crew minutes', () => {
  it('clamps and guards a zero target', () => {
    expect(progress(500, 1000)).toBe(0.5);
    expect(progress(2000, 1000)).toBe(1);
    expect(progress(5, 0)).toBe(0);
  });
  it('rounds crew minutes up from fractional ticks', () => {
    expect(crewMinutesLeft(45)).toBe(30);
    expect(crewMinutesLeft(0.1)).toBe(1);
    expect(crewMinutesLeft(-3)).toBe(0);
  });
});
