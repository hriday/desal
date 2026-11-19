import { crewMinutesLeft, paceState, progress } from '../src/screens/quota';

// 360 ticks = 4 h left at 40 s/tick; design flow 531.9 m3/h.
const base = { productM3: 0, targetM3: 1000, flowM3h: 300, ticksRemaining: 360 };

describe('paceState', () => {
  it('done once the target is met', () => expect(paceState({ ...base, productM3: 1000 })).toBe('done'));
  it('onPace when the current flow reaches the target in time', () =>
    expect(paceState({ ...base, flowM3h: 300 })).toBe('onPace'));
  it('behind when current flow falls short but design flow could still make it', () =>
    expect(paceState({ ...base, flowM3h: 100 })).toBe('behind'));
  it('outOfReach when even design flow cannot make it', () =>
    expect(paceState({ ...base, targetM3: 5000, flowM3h: 500 })).toBe('outOfReach'));
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
