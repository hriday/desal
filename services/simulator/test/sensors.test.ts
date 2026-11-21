import { describe, expect, it } from 'vitest';
import { LOOP_RANGES, SENSOR_NOISE_AMPLITUDE } from '../src/constants.js';
import { measured } from '../src/sensors.js';
import { startShift } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { GAME_ID } from './envelope.js';

const base = (seed = 1): PlantState => startShift(createInitialState(seed, 0, GAME_ID), 'auto').state;
const withFault = (s: PlantState, f: PlantState['faults']['sensors']): PlantState => ({ ...s, faults: { ...s.faults, sensors: f } });

describe('measured', () => {
  it('returns the true value exactly when the sensor is healthy', () => {
    const s = base();
    expect(measured(s, 'tbt', 107.123)).toBe(107.123);
    expect(measured(withFault(s, { vacuum: { kind: 'freeze', value: 0.9 } }), 'tbt', 107.123)).toBe(107.123);
  });

  it('a frozen sensor returns its stored value whatever the truth does', () => {
    const s = withFault(base(), { tbt: { kind: 'freeze', value: 100 } });
    expect(measured(s, 'tbt', 90)).toBe(100);
    expect(measured(s, 'tbt', 118)).toBe(100);
  });

  it('noise stays within the amplitude of the span and is deterministic from the seed', () => {
    const f = { tbt: { kind: 'noise' as const, amplitude: SENSOR_NOISE_AMPLITUDE } };
    const span = LOOP_RANGES.tbt.spMax - LOOP_RANGES.tbt.spMin;
    const seq = (seed: number): number[] => {
      let s = withFault(base(seed), f);
      const out: number[] = [];
      for (let i = 0; i < 20; i++) {
        out.push(measured(s, 'tbt', 100));
        s = tick(s, []).state;
      }
      return out;
    };
    const a = seq(7);
    expect(seq(7)).toEqual(a);
    expect(seq(8)).not.toEqual(a);
    for (const v of a) expect(Math.abs(v - 100)).toBeLessThanOrEqual(SENSOR_NOISE_AMPLITUDE * span + 1e-9);
    expect(new Set(a).size).toBeGreaterThan(10);
  });

  it('noise reaches the PID: the loop output differs from the noise-free run on the same seed', () => {
    const clean = base(7);
    const noisy = withFault(base(7), { tbt: { kind: 'noise', amplitude: SENSOR_NOISE_AMPLITUDE } });
    let a = clean;
    let b = noisy;
    for (let i = 0; i < 10; i++) {
      a = tick(a, []).state;
      b = tick(b, []).state;
    }
    expect(b.loops.tbt.output).not.toBe(a.loops.tbt.output);
  });
});
