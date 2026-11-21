import { PlantEventSchema, type PlantEvent } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { SHIFT_TICKS } from '../src/constants.js';
import { checkGameOver, scoreOf } from '../src/gameover.js';
import { startShift } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

const T0 = Date.UTC(2026, 0, 1);
const running = (): PlantState => startShift(createInitialState(1, T0, GAME_ID), 'auto').state;
const withBalance = (s: PlantState, balanceUsd: number): PlantState => ({ ...s, run: { ...s.run, balanceUsd } });
const gameEnds = (events: PlantEvent[]) => events.filter((e) => e.type === 'gameEnd');

function withPumps(s: PlantState, patch: Partial<PlantState['intake']['pumps']['P-101']>[]): PlantState {
  const ids = ['P-101', 'P-102', 'P-103'] as const;
  const pumps = { ...s.intake.pumps };
  ids.forEach((id, i) => (pumps[id] = { ...pumps[id], ...patch[i] }));
  return { ...s, intake: { ...s.intake, pumps } };
}

/** Gas cut off, the backup tank empty and nothing on order. */
function dry(s: PlantState): PlantState {
  return {
    ...s,
    fuel: { ...s.fuel, gas: { ...s.fuel.gas, capMW: 0 }, backup: { ...s.fuel.backup, tonnes: 0 }, deliveries: [] },
  };
}

describe('checkGameOver', () => {
  it('a healthy plant is not over, at a shift end or not', () => {
    expect(checkGameOver(running(), false)).toBeNull();
    expect(checkGameOver(running(), true)).toBeNull();
  });

  it('bankrupt: balance below 0, only at a shift end', () => {
    const s = withBalance(running(), -1);
    expect(checkGameOver(s, false)).toBeNull();
    expect(checkGameOver(s, true)).toBe('bankrupt');
    expect(checkGameOver(withBalance(running(), 0), true)).toBeNull();
  });

  it('outOfFuel: no gas, empty tank, nothing pending, and 1 t of the offered grade is unaffordable', () => {
    // 1 t standard = 42.5 x 14 = $595.
    expect(checkGameOver(withBalance(dry(running()), 594), false)).toBe('outOfFuel');
    expect(checkGameOver(withBalance(dry(running()), 595), false)).toBeNull();
    const pending = dry(running());
    const ordered = { ...pending, fuel: { ...pending.fuel, deliveries: [{ arrivesAtTick: 99, tonnes: 1, grade: 'standard' as const }] } };
    expect(checkGameOver(withBalance(ordered, 0), false)).toBeNull();
    const someGas = dry(running());
    expect(checkGameOver(withBalance({ ...someGas, fuel: { ...someGas.fuel, gas: { ...someGas.fuel.gas, capMW: 5 } } }, 0), false)).toBeNull();
    const someBackup = dry(running());
    expect(checkGameOver(withBalance({ ...someBackup, fuel: { ...someBackup.fuel, backup: { ...someBackup.fuel.backup, tonnes: 3 } } }, 0), false)).toBeNull();
    // Off-grade on offer: 1 t = 38 x 14 = $532.
    const offgrade = dry(running());
    const og = { ...offgrade, scenario: { ...offgrade.scenario, effects: { ...offgrade.scenario.effects, offgradeOnly: true } } };
    expect(checkGameOver(withBalance(og, 540), false)).toBeNull();
    expect(checkGameOver(withBalance(og, 531), false)).toBe('outOfFuel');
  });

  it('burnerFailed: burner condition at or below 0', () => {
    const s = running();
    expect(checkGameOver({ ...s, heater: { ...s.heater, burnerCondition: 0 } }, false)).toBe('burnerFailed');
    expect(checkGameOver({ ...s, heater: { ...s.heater, burnerCondition: 0.001 } }, false)).toBeNull();
  });

  it('noIntakePumps: every pump worn out or under overhaul', () => {
    const s = running();
    expect(checkGameOver(withPumps(s, [{ wear: 1 }, { wear: 1 }, { wear: 1 }]), false)).toBe('noIntakePumps');
    expect(checkGameOver(withPumps(s, [{ wear: 1 }, { wear: 1 }, { overhaulRemainingTicks: 5 }]), false)).toBe('noIntakePumps');
    expect(checkGameOver(withPumps(s, [{ wear: 1 }, { wear: 1 }, { wear: 0.99 }]), false)).toBeNull();
  });

  it('scoreOf reports shifts completed, total product and balance', () => {
    const s = { ...running(), run: { ...running().run, shiftsCompleted: 3, totalProductM3: 12000.5, balanceUsd: 777 } };
    expect(scoreOf(s)).toEqual({ shiftsCompleted: 3, totalProductM3: 12000.5, balanceUsd: 777 });
  });
});

describe('game over in tick()', () => {
  const cases: [string, (s: PlantState) => PlantState][] = [
    ['burnerFailed', (s) => ({ ...s, heater: { ...s.heater, burnerCondition: 0 } })],
    ['noIntakePumps', (s) => withPumps(s, [{ wear: 1 }, { wear: 1 }, { wear: 1 }])],
    ['outOfFuel', (s) => withBalance(dry(s), 100)],
  ];
  for (const [reason, make] of cases) {
    it(`${reason} ends the game on the next running tick`, () => {
      const r = tick(make(running()), []);
      const ends = gameEnds(r.events);
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ type: 'gameEnd', reason, gameId: GAME_ID });
      expect(PlantEventSchema.parse(ends[0])).toEqual(ends[0]);
      expect(r.state.phase).toBe('over');
      expect(r.state.run.over).toEqual({ reason, atTick: r.state.tick });
      expect(r.status.phase).toBe('over');
    });
  }

  it('bankrupt does not end the game mid-shift, only at the shift end', () => {
    const mid = tick(withBalance(running(), -5000), []);
    expect(gameEnds(mid.events)).toEqual([]);
    expect(mid.state.phase).toBe('running');

    const s0 = running();
    const last: PlantState = withBalance({ ...s0, tick: s0.shift!.startTick + SHIFT_TICKS - 1 }, -5000);
    const r = tick(last, []);
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(['shiftEnd', 'gameEnd']));
    const end = gameEnds(r.events)[0];
    expect(end).toMatchObject({ reason: 'bankrupt', score: { shiftsCompleted: 1 } });
    expect(r.events.findIndex((e) => e.type === 'gameEnd')).toBeGreaterThan(r.events.findIndex((e) => e.type === 'shiftEnd'));
    expect(r.state.phase).toBe('over');
  });

  it('after game over, tick() does not advance, rejects commands, and gameEnd is emitted exactly once', () => {
    let s = running();
    s = { ...s, heater: { ...s.heater, burnerCondition: 0 } };
    const all: PlantEvent[] = [];
    let r = tick(s, []);
    all.push(...r.events);
    const over = r.state;
    for (let i = 0; i < 5; i++) {
      r = tick(r.state, i === 2 ? [env(r.state, { type: 'manualTrip' }), env(r.state, { type: 'quitGame' }, null)] : []);
      all.push(...r.events);
      expect(r.state.tick).toBe(over.tick);
      expect(r.state.plantTime).toBe(over.plantTime);
      expect(r.telemetry).toEqual([]);
      expect(r.status.phase).toBe('over');
    }
    expect(gameEnds(all)).toHaveLength(1);
    const rejected = all.filter((e) => e.type === 'commandRejected');
    expect(rejected).toHaveLength(2);
    expect(rejected.every((e) => e.type === 'commandRejected' && e.reason === 'game over')).toBe(true);
    expect(r.state.run.over?.reason).toBe('burnerFailed');
  });
});

describe('quitGame', () => {
  it('ends a running game with reason quit and the current score', () => {
    const s0 = { ...running(), run: { ...running().run, shiftsCompleted: 2, totalProductM3: 8100, balanceUsd: 41234 } };
    const r = tick(s0, [env(s0, { type: 'quitGame' })]);
    const ends = gameEnds(r.events);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ reason: 'quit', score: { shiftsCompleted: 2, totalProductM3: 8100, balanceUsd: 41234 } });
    expect(r.state.phase).toBe('over');
    expect(r.state.run.over).toEqual({ reason: 'quit', atTick: s0.tick });
    expect(r.snapshotDue).toBe(true);
    expect(r.telemetry).toEqual([]);
  });

  it('quitting mid-shift 2 scores the in-progress water, but not the shift as completed', () => {
    let s = createInitialState(1, T0, GAME_ID);
    s = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]).state;
    for (let i = 0; i < SHIFT_TICKS && s.phase === 'running'; i++) s = tick(s, []).state;
    expect(s.phase).toBe('handover');
    const shift1M3 = s.run.totalProductM3;
    expect(shift1M3).toBeGreaterThan(0);
    s = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]).state;
    for (let i = 0; i < 200; i++) s = tick(s, []).state;
    const inProgressM3 = s.shift!.acc.productM3;
    expect(s.shift!.id).toBe(2);
    expect(inProgressM3).toBeGreaterThan(0);

    const end = gameEnds(tick(s, [env(s, { type: 'quitGame' })]).events)[0]!;
    expect(end).toMatchObject({ type: 'gameEnd', reason: 'quit' });
    if (end.type !== 'gameEnd') throw new Error('unreachable');
    expect(end.score.shiftsCompleted).toBe(1);
    expect(end.score.totalProductM3).toBeCloseTo(shift1M3 + inProgressM3, 6);

    // Paused counts the same way; in handover there is no shift in progress to add.
    const paused: PlantState = { ...s, phase: 'paused' };
    const pausedEnd = gameEnds(tick(paused, [env(paused, { type: 'quitGame' })]).events)[0]!;
    if (pausedEnd.type !== 'gameEnd') throw new Error('unreachable');
    expect(pausedEnd.score.totalProductM3).toBeCloseTo(shift1M3 + inProgressM3, 6);
  });

  it('quitting in handover scores only the completed shifts (the last shift is already counted)', () => {
    let s = createInitialState(1, T0, GAME_ID);
    s = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]).state;
    for (let i = 0; i < SHIFT_TICKS && s.phase === 'running'; i++) s = tick(s, []).state;
    const end = gameEnds(tick(s, [env(s, { type: 'quitGame' }, null)]).events)[0]!;
    if (end.type !== 'gameEnd') throw new Error('unreachable');
    expect(end.score).toMatchObject({ shiftsCompleted: 1, totalProductM3: s.run.totalProductM3 });
  });

  it('is allowed in handover and paused', () => {
    const h = createInitialState(1, T0, GAME_ID);
    expect(gameEnds(tick(h, [env(h, { type: 'quitGame' }, null)]).events)).toHaveLength(1);
    const p: PlantState = { ...running(), phase: 'paused' };
    expect(gameEnds(tick(p, [env(p, { type: 'quitGame' })]).events)).toHaveLength(1);
  });
});

describe('runs end', () => {
  it('an untouched Auto run, starting each shift at handover, reaches game over within 40 shifts', () => {
    let s = createInitialState(7, T0, GAME_ID);
    let end: PlantEvent | undefined;
    for (let t = 0; t < 40 * (SHIFT_TICKS + 1) && s.phase !== 'over'; t++) {
      const cmds = s.phase === 'handover' ? [env(s, { type: 'startShift', mode: 'auto' }, null)] : [];
      const r = tick(s, cmds);
      s = r.state;
      end ??= r.events.find((e) => e.type === 'gameEnd');
    }
    expect(s.phase).toBe('over');
    if (end?.type !== 'gameEnd') throw new Error('no gameEnd');
    console.log(
      `untouched run ended in shift ${s.run.shiftNumber}: ${end.reason}, score ${JSON.stringify(end.score)}`,
    );
    expect(s.run.shiftNumber).toBeLessThanOrEqual(40);
    expect(end.score).toEqual(scoreOf(s));
  });
});
