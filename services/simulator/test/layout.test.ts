import { describe, expect, it } from 'vitest';
import {
  BLOWDOWN_MAX_M3H,
  LEVEL_FLOOD_M,
  MAKEUP_MAX_M3H,
  PLANT_MAX_PRODUCT_M3H,
  SHIFT_TICKS,
  STAGE_COUNT,
} from '../src/constants.js';
import { applyEffect } from '../src/scenario/effects.js';
import { drawPendingPlan } from '../src/shift.js';
import { BALANCE, createInitialState, NOMINAL, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

// Spec §2.1-2.3: 24 stages, the stage-24 brine pool and the seawater makeup loop that tops it up.

const POOL = STAGE_COUNT - 1;
const pool = (s: PlantState): number => s.stages[POOL]!.levelM;

/** A running shift 1 at nominal conditions (30 C seawater, no events), in `mode`. */
function calmShift(mode: 'auto' | 'manual' = 'auto'): PlantState {
  let s = drawPendingPlan(createInitialState(1, 0, GAME_ID));
  const plan = s.chaos.pending!;
  s = { ...s, chaos: { ...s.chaos, pending: { ...plan, queue: [], initial: { seawaterTempC: 30, chlorophyllUgL: 1 } } } };
  return tick(s, [env(s, { type: 'startShift', mode }, null)]).state;
}

/** Tick `n` times with no commands, calling `each` on every state. */
function run(s: PlantState, n: number, each: (s: PlantState) => void = () => {}): PlantState {
  for (let i = 0; i < n; i++) {
    s = tick(s, []).state;
    each(s);
  }
  return s;
}

const send = (s: PlantState, ...commands: Record<string, unknown>[]): PlantState =>
  tick(s, commands.map((c) => env(s, c))).state;

describe('the 24-stage layout', () => {
  it('starts with 24 stages, 23 level loops and the makeup loop in Auto at its balanced output', () => {
    const s = createInitialState(1, 0, GAME_ID);
    expect(s.stages).toHaveLength(24);
    expect(s.loops.levels).toHaveLength(23);
    expect(s.loops.makeup.mode).toBe('auto');
    expect(s.loops.makeup.output).toBeCloseTo(BALANCE.makeupPct, 10);
    expect(s.brine.makeupM3h).toBe(NOMINAL.makeupM3h);
    expect(NOMINAL.makeupM3h).toBeCloseTo(NOMINAL.productM3h + (BLOWDOWN_MAX_M3H * BALANCE.blowdownPct) / 100, 9);
  });

  it('a calm shift holds the pool at its nominal level and the makeup at its nominal flow, without oscillating', () => {
    const levels: number[] = [];
    run(calmShift(), SHIFT_TICKS - 1, (s) => {
      expect(Math.abs(pool(s) - NOMINAL.levelM)).toBeLessThanOrEqual(0.02);
      expect(Math.abs(s.brine.makeupM3h - NOMINAL.makeupM3h)).toBeLessThanOrEqual(0.01 * NOMINAL.makeupM3h);
      levels.push(pool(s));
    });
    const tail = levels.slice(-360);
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
    const sd = Math.sqrt(tail.reduce((a, b) => a + (b - mean) ** 2, 0) / tail.length);
    expect(sd).toBeLessThan(0.005);
  });

  it('the Auto makeup loop holds the pool through a manual trip and an Auto restart', () => {
    let s = run(calmShift(), 30);
    s = send(s, { type: 'manualTrip' });
    expect(s.status).toBe('tripped');
    s = run(s, 20, (x) => expect(Math.abs(pool(x) - NOMINAL.levelM)).toBeLessThanOrEqual(0.05));
    s = send(s, { type: 'restart' });
    expect(s.status).toBe('restarting');
    s = run(s, 500, (x) => expect(Math.abs(pool(x) - NOMINAL.levelM)).toBeLessThanOrEqual(0.05));
    expect(s.status).toBe('online');
  });

  it('the Auto makeup loop holds the pool through a power dip', () => {
    let s = run(calmShift(), 30);
    s = applyEffect(s, 'powerDip', { pumpId: 'P-101', minutes: 60 });
    expect(s.faults.powerDipRemainingTicks).toBeGreaterThan(0);
    run(s, 300, (x) => expect(Math.abs(pool(x) - NOMINAL.levelM)).toBeLessThanOrEqual(0.05));
  });

  it('makeup in Manual at 0 % empties the pool in about 30 minutes and starves the recirc pump', () => {
    let s = run(calmShift(), 10);
    s = send(s, { type: 'setLoopMode', loop: 'makeup', mode: 'manual' }, { type: 'setOutput', loop: 'makeup', value: 0 });
    expect(s.loops.makeup.output).toBe(0);
    s = run(s, 44);
    expect(pool(s)).toBeLessThanOrEqual(0.1);
    s = run(s, 45);
    expect(s.brine.distillateM3h).toBeLessThan(0.5 * NOMINAL.productM3h);
    expect(s.brine.recircM3h).toBeLessThan(0.5 * NOMINAL.recircM3h);
  });

  it('makeup never exceeds the intake flow, even with every intake pump stopped', () => {
    let s = run(calmShift(), 10);
    s = send(
      s,
      { type: 'pump', pumpId: 'P-101', action: 'stop' },
      { type: 'pump', pumpId: 'P-102', action: 'stop' },
      { type: 'pump', pumpId: 'P-103', action: 'stop' },
    );
    expect(s.brine.makeupM3h).toBeLessThanOrEqual(s.intake.flowM3h);
    run(s, 100, (x) => expect(x.brine.makeupM3h).toBeLessThanOrEqual(x.intake.flowM3h));
  });

  it('at maximum load (TBT 112, recirc 6500, blowdown wide open) makeup still out-supplies distillate plus blowdown', () => {
    expect(MAKEUP_MAX_M3H).toBeGreaterThanOrEqual(PLANT_MAX_PRODUCT_M3H + BLOWDOWN_MAX_M3H);
    let s = run(calmShift(), 10);
    s = send(
      s,
      { type: 'setSetpoint', loop: 'tbt', value: 112 },
      { type: 'setSetpoint', loop: 'recirc', value: 6500 },
      { type: 'setLoopMode', loop: 'blowdown', mode: 'manual' },
      { type: 'setOutput', loop: 'blowdown', value: 100 },
    );
    s = run(s, 360, (x) => expect(Math.abs(pool(x) - NOMINAL.levelM)).toBeLessThanOrEqual(0.05));
    expect(s.status).toBe('online');
    expect(s.heater.tbtC).toBeGreaterThan(110);
    expect(s.brine.blowdownM3h).toBe(BLOWDOWN_MAX_M3H);
  });

  it('a pool at the flood level trips stageFlood', () => {
    const s = calmShift();
    // Just over the line: within one tick the Auto makeup loop can only take a few mm off.
    const stages = s.stages.map((st, i) => (i === POOL ? { ...st, levelM: LEVEL_FLOOD_M + 0.01 } : st));
    const r = tick({ ...s, stages }, []);
    expect(r.state.status).toBe('tripped');
    expect(r.state.trip?.cause).toBe('stageFlood');
  });

  it('accepts setpoint, mode and output commands on the makeup loop and reports it in the status', () => {
    let s = calmShift();
    s = send(s, { type: 'setSetpoint', loop: 'makeup', value: 0.35 });
    expect(s.loops.makeup.setpoint).toBe(0.35);
    s = send(s, { type: 'setLoopMode', loop: 'makeup', mode: 'manual' });
    const r = tick(s, [env(s, { type: 'setOutput', loop: 'makeup', value: 40 })]);
    expect(r.events.filter((e) => e.type === 'commandRejected')).toEqual([]);
    expect(r.status.loops.makeup).toMatchObject({ mode: 'manual', setpoint: 0.35, output: 40, fault: null });
    expect(r.status.loops.level23).toBeDefined();
    expect(r.status.loops.level24).toBeUndefined();
  });

  it('a Manual shift leaves the makeup and level loops in Auto and puts the other five in Manual', () => {
    let s = calmShift('manual');
    for (const id of ['tbt', 'intakeFlow', 'recirc', 'blowdown', 'vacuum'] as const) expect(s.loops[id].mode).toBe('manual');
    expect(s.loops.makeup.mode).toBe('auto');
    expect(s.loops.levels.every((l) => l.mode === 'auto')).toBe(true);
    // Like a level loop, the makeup loop can be steered in Manual control mode.
    const r = tick(s, [env(s, { type: 'setSetpoint', loop: 'makeup', value: 0.4 }), env(s, { type: 'setLoopMode', loop: 'makeup', mode: 'manual' })]);
    expect(r.events.filter((e) => e.type === 'commandRejected')).toEqual([]);
    s = r.state;
    expect(s.loops.makeup).toMatchObject({ setpoint: 0.4, mode: 'manual' });
  });
});
