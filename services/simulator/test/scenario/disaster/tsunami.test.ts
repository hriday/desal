import { describe, expect, it } from 'vitest';
import {
  CREW_JOBS,
  INTAKE_TRIP_FRACTION,
  SHIFT_TICKS,
  TICK_PLANT_S,
  TSUNAMI_FOULING,
  TSUNAMI_SURGE_TICKS,
} from '../../../src/constants.js';
import type { FiredEvent } from '../../../src/scenario/chaosTypes.js';
import { applyTsunami, tsunamiViable } from '../../../src/scenario/disaster/tsunami.js';
import { isCleared } from '../../../src/scenario/director.js';
import { applyEffect } from '../../../src/scenario/effects.js';
import { drawEvent, eventMessage } from '../../../src/scenario/library.js';
import { startShift } from '../../../src/shift.js';
import { createInitialState, type PlantState } from '../../../src/state.js';
import { tick } from '../../../src/tick.js';
import { env, GAME_ID } from '../../envelope.js';

const WARN_MIN = 20;
const WARN_TICKS = (WARN_MIN * 60) / TICK_PLANT_S;
const fired = { eventId: 1, kind: 'tsunami', params: {}, cleared: false, how: null } as unknown as FiredEvent;

function quiet(): PlantState {
  const s = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
  return { ...s, chaos: { ...s.chaos, active: null } };
}
function run(s: PlantState, n: number): PlantState {
  for (let i = 0; i < n; i++) s = tick(s, []).state;
  return s;
}
const cmd = (s: PlantState, command: Record<string, unknown>) => tick(s, [env(s, command)]);
const hit = (s: PlantState): PlantState => applyEffect(s, 'tsunami', { warnMinutes: WARN_MIN, coolC: 1.5 });
const wearOf = (s: PlantState, id: 'P-101' | 'P-102' | 'P-103') => s.intake.pumps[id].wear;
/** Run to the end of the warning (the surge arrives), and on through the whole surge. */
const throughWarning = (s: PlantState) => run(s, WARN_TICKS);
const throughSurge = (s: PlantState) => run(s, TSUNAMI_SURGE_TICKS + 1);

describe('tsunami warning', () => {
  it('puts the warning minutes in the radio line', () => {
    expect(eventMessage('tsunami', { warnMinutes: 18, coolC: 1 })).toBe(
      'Tsunami warning! The surge hits the intake in about 18 minutes. Protect the pumps.',
    );
    const [e] = drawEvent('tsunami', 100, 7, 3, undefined);
    expect(Number(e.params.warnMinutes)).toBeGreaterThanOrEqual(15);
    expect(Number(e.params.warnMinutes)).toBeLessThanOrEqual(25);
    expect(Number(e.params.coolC)).toBeGreaterThanOrEqual(1);
    expect(Number(e.params.coolC)).toBeLessThanOrEqual(2);
    expect(e.message).toContain(`${e.params.warnMinutes} minutes`);
  });

  it('adds no pump wear and no fouling during the warning', () => {
    const base = run(quiet(), 5);
    const s = run(hit(base), WARN_TICKS - 2);
    expect(s.faults.tsunami?.warnRemainingTicks).toBeGreaterThan(0);
    expect(s.faults.stormFouling).toBe(0);
    for (const id of ['P-101', 'P-102'] as const) expect(wearOf(s, id) - wearOf(base, id)).toBeLessThan(1e-3);
  });
});

describe('tsunami surge', () => {
  it('wears each running pump by 0.7 and leaves a stopped pump alone', () => {
    const base = run(quiet(), 5);
    expect(base.intake.pumps['P-103'].running).toBe(false);
    const before = { a: wearOf(base, 'P-101'), b: wearOf(base, 'P-102'), c: wearOf(base, 'P-103') };
    const s = throughSurge(throughWarning(hit(base)));
    expect(s.faults.tsunami?.surgeDone).toBe(true);
    expect(wearOf(s, 'P-101') - before.a).toBeGreaterThan(0.69);
    expect(wearOf(s, 'P-101') - before.a).toBeLessThan(0.71);
    expect(wearOf(s, 'P-102') - before.b).toBeGreaterThan(0.69);
    expect(wearOf(s, 'P-102') - before.b).toBeLessThan(0.71);
    expect(wearOf(s, 'P-103')).toBe(before.c);
  });

  it('fouls the screens with debris and cools the sea when the surge arrives', () => {
    const base = run(quiet(), 5);
    const s = throughWarning(hit(base));
    expect(s.faults.stormFouling).toBeCloseTo(TSUNAMI_FOULING);
    expect(s.seawater.tempC).toBeCloseTo(base.seawater.tempC - 1.5, 1);
    expect(TSUNAMI_FOULING).toBeGreaterThan(0.1 * 2);
  });

  it('wears out a pump that starts at 0.4', () => {
    const base = run(quiet(), 5);
    const worn: PlantState = {
      ...base,
      intake: { ...base.intake, pumps: { ...base.intake.pumps, 'P-101': { ...base.intake.pumps['P-101'], wear: 0.4 } } },
    };
    const s = throughSurge(throughWarning(hit(worn)));
    expect(wearOf(s, 'P-101')).toBeGreaterThanOrEqual(1);
      });

  it('is not viable with every pump worn out or under overhaul', () => {
    const s = quiet();
    const p = s.intake.pumps;
    const with3 = (a: Partial<typeof p['P-101']>, b: Partial<typeof p['P-101']>, c: Partial<typeof p['P-101']>) => ({
      ...s,
      intake: { ...s.intake, pumps: { 'P-101': { ...p['P-101'], ...a }, 'P-102': { ...p['P-102'], ...b }, 'P-103': { ...p['P-103'], ...c } } },
    });
    expect(tsunamiViable(s)).toBe(true);
    expect(tsunamiViable(with3({ wear: 1 }, { overhaulRemainingTicks: 5 }, { wear: 1 }))).toBe(false);
    expect(tsunamiViable(with3({ wear: 1 }, { overhaulRemainingTicks: 5 }, { wear: 0.99 }))).toBe(true);
  });
});

describe('tsunami response', () => {
  it('survives on one healthy pump at full speed, then clears as player after cleaning and restarting a spare', () => {
    let s = quiet();
    s = cmd(s, { type: 'setLoopMode', loop: 'intakeFlow', mode: 'manual' }).state;
    s = cmd(s, { type: 'setOutput', loop: 'intakeFlow', value: 100 }).state;
    s = run(s, 10);
    s = hit(s);
    s = cmd(s, { type: 'pump', pumpId: 'P-102', action: 'stop' }).state;
    let minFlowRatio = Infinity;
    for (let i = 0; i < WARN_TICKS + TSUNAMI_SURGE_TICKS + 2; i++) {
      const r = tick(s, []);
      s = r.state;
      expect(s.status).toBe('online');
      if (s.faults.tsunami?.surgeDone) break;
      minFlowRatio = Math.min(minFlowRatio, s.intake.flowM3h / (INTAKE_TRIP_FRACTION * s.intake.requiredM3h));
    }
    expect(s.faults.tsunami?.surgeDone).toBe(true);
    expect(minFlowRatio).toBeGreaterThan(1.15);
    expect(isCleared(s, fired)).toBeNull();

    let r = cmd(s, { type: 'dispatchCrew', job: 'cleanScreens' });
    expect(r.events.find((e) => e.type === 'commandRejected')).toBeUndefined();
    s = r.state;
    r = cmd(s, { type: 'pump', pumpId: 'P-103', action: 'start' });
    s = r.state;
    for (let i = 0; i < (CREW_JOBS.cleanScreens.minutes * 60) / TICK_PLANT_S + 1; i++) {
      s = tick(s, []).state;
      expect(s.status).toBe('online');
    }
    expect(s.faults.tsunami?.cleanedAfterSurge).toBe(true);
    expect(s.faults.stormFouling).toBe(0);
    expect(isCleared(s, fired)).toBe('player');
  });

  it('rejects cleanScreens during the warning, before any fouling', () => {
    const s = hit(run(quiet(), 5));
    expect(cmd(s, { type: 'dispatchCrew', job: 'cleanScreens' }).events.some((e) => e.type === 'commandRejected')).toBe(true);
  });

  it('trips with noIntakeFlow when every pump is stopped', () => {
    let s = hit(run(quiet(), 5));
    s = cmd(s, { type: 'pump', pumpId: 'P-101', action: 'stop' }).state;
    s = cmd(s, { type: 'pump', pumpId: 'P-102', action: 'stop' }).state;
    s = run(s, 3);
    expect(s.status).toBe('tripped');
    expect(s.trip?.cause).toBe('noIntakeFlow');
  });

  it('leaves no tsunami for the next shift when the shift ends mid-surge, and the debrief shows it not cleared', () => {
    let s = quiet();
    const a = {
      plan: { shiftNumber: 1, hell: false, queue: [] },
      fired: [{ eventId: 1, kind: 'tsunami', atMinute: 0, params: {}, cleared: false, how: null }],
      lastFiredMinute: null,
      nextEventId: 2,
    };
    s = { ...s, chaos: { ...s.chaos, active: a as unknown as NonNullable<PlantState['chaos']['active']> } };
    s = { ...s, tick: s.shift!.startTick + SHIFT_TICKS - 40 };
    s = { ...s, shift: { ...s.shift!, startTick: s.tick - (SHIFT_TICKS - 40) } };
    s = applyTsunami(s, { warnMinutes: 15, coolC: 1 });
    let ended: ReturnType<typeof tick> | undefined;
    for (let i = 0; i < 60 && s.phase === 'running'; i++) {
      ended = tick(s, []);
      s = ended.state;
    }
    expect(s.phase).toBe('handover');
    const end = ended!.events.find((e) => e.type === 'shiftEnd') as { summary: { events: { kind: string; cleared: boolean }[] } };
    expect(end.summary.events.find((e) => e.kind === 'tsunami')).toMatchObject({ cleared: false });
    expect(startShift(s, 'auto').state.faults.tsunami).toBeNull();
  });
});
