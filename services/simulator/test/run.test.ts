import { PlantEventSchema, PlantStatusSchema, TelemetryReadingSchema, type PlantEvent } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/commands.js';
import { START_BALANCE_USD, SHIFT_TICKS } from '../src/constants.js';
import { restore, serialize } from '../src/snapshot.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

const T0 = Date.UTC(2026, 0, 1);
const fresh = (): PlantState => createInitialState(1, T0, GAME_ID);

describe('run state', () => {
  it('starts with the operating account and zeroed counters', () => {
    expect(fresh().run).toEqual({
      gameId: GAME_ID,
      balanceUsd: START_BALANCE_USD,
      shiftNumber: 0,
      totalProductM3: 0,
      shiftsCompleted: 0,
      eventSeq: 0,
      over: null,
    });
  });

  it('stamps seq 0,1,2,... with no gaps, and one tick shares gameId, tick and plantTime', () => {
    let s = fresh();
    const all: { tick: number; events: PlantEvent[]; status: ReturnType<typeof tick>['status']; telemetry: ReturnType<typeof tick>['telemetry'] }[] = [];
    const cmds = [
      [env(s, { type: 'startShift', mode: 'auto' }, null)],
      [env(s, { type: 'manualTrip' }, 1)],
      [],
    ];
    for (const c of cmds) {
      const r = tick(s, c);
      s = r.state;
      all.push({ tick: s.tick, events: r.events, status: r.status, telemetry: r.telemetry });
    }
    const events = all.flatMap((a) => a.events);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['shiftStart', 'trip']));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(s.run.eventSeq).toBe(events.length);
    for (const a of all) {
      for (const e of a.events) {
        expect(PlantEventSchema.parse(e)).toEqual(e);
        expect(e.gameId).toBe(GAME_ID);
        expect(e.tick).toBe(a.status.tick);
        expect(e.plantTime).toBe(a.status.plantTime);
      }
      for (const t of a.telemetry) {
        expect(TelemetryReadingSchema.parse(t).gameId).toBe(GAME_ID);
        expect(t.tick).toBe(a.status.tick);
        expect(t.plantTime).toBe(a.status.plantTime);
      }
      expect(a.status.gameId).toBe(GAME_ID);
    }
  });

  it('status carries the new fields and validates', () => {
    let s = fresh();
    s = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]).state;
    const beforeOrder = s.run.balanceUsd;
    s = tick(s, [env(s, { type: 'orderFuel', tonnes: 20 })]).state;
    const last = tick(s, []);
    const status = last.status;
    expect(PlantStatusSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({
      gameId: GAME_ID,
      shiftNumber: 1,
      balanceUsd: last.state.run.balanceUsd,
      acidCleanRemainingTicks: 0,
      restartAuto: null,
      offeredGrade: 'standard',
    });
    expect(status.pumps['P-101'].overhaulRemainingTicks).toBe(0);
    expect(status.deliveries).toHaveLength(1);
    expect(status.deliveries[0]).toMatchObject({ tonnes: 20, grade: 'standard' });
    expect(status.deliveries[0]!.arrivesInTicks).toBeGreaterThan(0);
    // The 20 t order (20 x 42.5 x 14 = $11,900) was paid when placed.
    expect(status.balanceUsd).toBeLessThan(beforeOrder - 11900);
  });

  it('shiftNumber advances across two shifts and the run totals accumulate', () => {
    let s = fresh();
    for (let n = 1; n <= 2; n++) {
      s = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]).state;
      expect(s.run.shiftNumber).toBe(n);
      expect(s.shift?.id).toBe(n);
      for (let i = 0; i < SHIFT_TICKS && s.phase === 'running'; i++) s = tick(s, []).state;
      expect(s.phase).toBe('handover');
      expect(s.run.shiftsCompleted).toBe(n);
    }
    expect(s.run.totalProductM3).toBeGreaterThan(0);
    expect(s.run.eventSeq).toBeGreaterThanOrEqual(4);
  });

  it('rejects a wrong-game envelope and leaves the state unchanged', () => {
    const s = fresh();
    const bad = { ...env(s, { type: 'startShift', mode: 'auto' }, null), gameId: '00000000-0000-4000-8000-000000000000' };
    const r = applyCommand(s, bad);
    expect(r.state).toBe(s);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'commandRejected', reason: 'wrong game' });
    const viaTick = tick(s, [bad]);
    expect(viaTick.state.phase).toBe('handover');
    expect(viaTick.events[0]).toMatchObject({ type: 'commandRejected', seq: 0, gameId: GAME_ID });
  });

  it('round-trips the run fields through a snapshot', () => {
    let s = fresh();
    s = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]).state;
    s = { ...s, run: { ...s.run, balanceUsd: 12345.5, totalProductM3: 900, shiftsCompleted: 1, over: { reason: 'quit', atTick: 3 } } };
    const r = restore(serialize(s));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.run).toEqual(s.run);
  });
});
