import { LOOP_ACTION, LOOP_GAINS, LOOP_RANGES } from '../../src/constants.js';
import { loopKind } from '../../src/control/loops.js';
import { pidStep } from '../../src/control/pid.js';
import { createInitialState, type Loop } from '../../src/state.js';
import { allFinite } from '../helpers.js';

/**
 * Gains for the toy first-order test plant below (dt = 1). Kept local: the plant loops' LOOP_GAINS are
 * tuned for their own process gains at dtS = 40 and do not suit this plant.
 */
const G = { kp: 5, ki: 0.3, kd: 0 };
const mk = (over: Partial<Loop> = {}): Loop => ({
  mode: 'auto', setpoint: 50, output: 0, integral: 0, prevError: 0, fault: null, ...over,
});
/** First-order plant: y += (u - y) * 0.1. */
function run(loop: Loop, y: number, steps: number) {
  const ys: number[] = [];
  const us: number[] = [];
  for (let i = 0; i < steps; i++) {
    loop = pidStep(loop, y, G, 0, 100, 1, 'direct');
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
    expect(Math.abs(us[0]! - 60)).toBeLessThan(0.5);
  });
  it.each([1, 40])('manual -> auto does not bump at dtS=%i with nonzero error', (dt) => {
    const manual = pidStep(mk({ mode: 'manual', output: 60 }), 30, G, 0, 100, dt, 'direct');
    const auto = pidStep({ ...manual, mode: 'auto' }, 30, G, 0, 100, dt, 'direct');
    expect(Math.abs(auto.output - 60)).toBeLessThan(0.5);
  });
});

describe('loopKind / ranges', () => {
  it('maps levelN to level', () => {
    expect(loopKind('level7')).toBe('level');
    expect(loopKind('tbt')).toBe('tbt');
    expect(LOOP_RANGES[loopKind('level20')].spMax).toBe(0.6);
  });
});

describe('controller action', () => {
  it('maps loop kinds to their action', () => {
    expect(LOOP_ACTION.level).toBe('reverse');
    expect(LOOP_ACTION.blowdown).toBe('reverse');
    for (const k of ['tbt', 'intakeFlow', 'recirc', 'vacuum'] as const) expect(LOOP_ACTION[k]).toBe('direct');
  });

  it('a reverse loop settles a plant whose output lowers the measurement', () => {
    // Plant: y relaxes toward 100 - u, so opening the output pulls y down (like a drain valve).
    let loop = mk({ setpoint: 30 });
    let y = 80;
    for (let i = 0; i < 300; i++) {
      loop = pidStep(loop, y, G, 0, 100, 1, 'reverse');
      y += (100 - loop.output - y) * 0.1;
    }
    expect(Math.abs(y - 30)).toBeLessThan(0.5);
    expect(loop.output).toBeGreaterThan(60);
  });

  it('a reverse loop opens its output when the measurement is above setpoint', () => {
    const l = pidStep(mk({ setpoint: 50, output: 50, integral: 50 / G.ki }), 60, G, 0, 100, 1, 'reverse');
    expect(l.output).toBeGreaterThan(50);
  });

  it('reverse manual -> auto is bumpless', () => {
    const manual = pidStep(mk({ mode: 'manual', output: 60 }), 30, G, 0, 100, 40, 'reverse');
    const auto = pidStep({ ...manual, mode: 'auto' }, 30, G, 0, 100, 40, 'reverse');
    expect(Math.abs(auto.output - 60)).toBeLessThan(0.5);
  });
});

describe('initial loop state', () => {
  it('holds every initial output for one step at zero error', () => {
    const s = createInitialState(1, 0);
    const named = (['tbt', 'intakeFlow', 'recirc', 'blowdown', 'vacuum'] as const).map((k) => [k, s.loops[k]] as const);
    const all = [...named, ...s.loops.levels.map((l) => ['level', l] as const)];
    for (const [kind, l] of all) {
      const { outMin, outMax } = LOOP_RANGES[kind];
      const next = pidStep(l, l.setpoint, LOOP_GAINS[kind], outMin, outMax, 40, LOOP_ACTION[kind]);
      expect(Math.abs(next.output - l.output)).toBeLessThan(1e-9);
    }
  });
});
