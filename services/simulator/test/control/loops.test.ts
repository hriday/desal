import { LOOP_GAINS, LOOP_RANGES } from '../../src/constants.js';
import { loopKind } from '../../src/control/loops.js';
import { pidStep } from '../../src/control/pid.js';
import type { Loop } from '../../src/state.js';
import { allFinite } from '../helpers.js';

const G = LOOP_GAINS.tbt;
const mk = (over: Partial<Loop> = {}): Loop => ({
  mode: 'auto', setpoint: 50, output: 0, integral: 0, prevError: 0, fault: null, ...over,
});
/** First-order plant: y += (u - y) * 0.1. */
function run(loop: Loop, y: number, steps: number) {
  const ys: number[] = [];
  const us: number[] = [];
  for (let i = 0; i < steps; i++) {
    loop = pidStep(loop, y, G, 0, 100, 1);
    y += (loop.output - y) * 0.1;
    ys.push(y);
    us.push(loop.output);
  }
  return { loop, y, ys, us };
}
const signChanges = (us: number[]): number => {
  const d = us.slice(1).map((v, i) => v - us[i]!).filter((v) => v !== 0);
  return d.slice(1).filter((v, i) => Math.sign(v) !== Math.sign(d[i]!)).length;
};

describe('pidStep', () => {
  it('settles within 2% in 200 steps with <10% overshoot', () => {
    const { ys } = run(mk(), 0, 200);
    expect(Math.max(...ys)).toBeLessThanOrEqual(55);
    expect(Math.abs(ys[199]! - 50)).toBeLessThanOrEqual(1);
    expect(allFinite(ys)).toBe(true);
  });
  it('manual leaves the output where the operator set it', () => {
    const { loop } = run(mk({ mode: 'manual', output: 37 }), 10, 50);
    expect(loop.output).toBe(37);
  });
  it('stuck freezes the output', () => {
    const { us } = run(mk({ output: 20, fault: { kind: 'stuck', bias: 0 } }), 0, 30);
    expect(new Set(us)).toEqual(new Set([20]));
  });
  it('drift makes the true value deviate from the setpoint', () => {
    const { ys } = run(mk({ fault: { kind: 'drift', bias: 0 } }), 0, 200);
    const e1 = Math.abs(ys[100]! - 50);
    const e2 = Math.abs(ys[199]! - 50);
    expect(e1).toBeGreaterThan(1);
    expect(e2).toBeGreaterThan(e1);
  });
  it('oscillate makes a settled loop change slope sign >= 6 times in 100 steps', () => {
    const settled = run(mk(), 0, 200);
    const osc = { ...settled.loop, fault: { kind: 'oscillate' as const, bias: 0 } };
    const { us } = run(osc, settled.y, 100);
    expect(signChanges(us)).toBeGreaterThanOrEqual(6);
  });
  it('manual -> auto is bumpless (<5% jump)', () => {
    const manual = run(mk({ mode: 'manual', output: 60 }), 30, 100);
    const { us } = run({ ...manual.loop, mode: 'auto' }, manual.y, 1);
    expect(Math.abs(us[0]! - 60)).toBeLessThan(5);
  });
});

describe('loopKind / ranges', () => {
  it('maps levelN to level', () => {
    expect(loopKind('level7')).toBe('level');
    expect(loopKind('tbt')).toBe('tbt');
    expect(LOOP_RANGES[loopKind('level20')].spMax).toBe(0.6);
  });
});
