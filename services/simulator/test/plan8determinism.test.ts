import { readFileSync } from 'node:fs';
import type { GameMode, ShiftSummary } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { SHIFT_TICKS } from '../src/constants.js';
import type { ChaosPlan } from '../src/scenario/chaosTypes.js';
import { LOW_STEAM_MINUTE } from '../src/scenario/difficulty.js';
import { drawPendingPlan } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

// Frozen on the pre-Plan-8 code (Task 1): seeds 1-10, Normal and Hard, shifts 1-8.
interface PlanRecord {
  seed: number;
  mode: GameMode;
  n: number;
  nextSeed: number;
  pending: ChaosPlan;
}
const RECORDS = JSON.parse(readFileSync(new URL('./fixtures/plans-pre-plan8.json', import.meta.url), 'utf8')) as PlanRecord[];

/** The state the fixture was drawn from: shift n − 1 just ended, no disaster last shift. */
function before(r: PlanRecord): PlantState {
  const s = createInitialState(r.seed, 0, GAME_ID);
  return { ...s, run: { ...s.run, mode: r.mode, shiftNumber: r.n - 1 }, chaos: { ...s.chaos, lastHadDisaster: false } };
}
const lowSteams = (p: ChaosPlan) => p.queue.filter((e) => e.kind === 'lowSteam');
const drawn = RECORDS.map((r) => ({ r, s: drawPendingPlan(before(r)) }));

describe('Plan 8 determinism: lowSteam rides its own substream', () => {
  it('keeps the game seed sequence and every other queued event', () => {
    expect(RECORDS.length).toBe(160);
    for (const { r, s } of drawn) {
      const tag = `seed ${r.seed} ${r.mode} shift ${r.n}`;
      expect(s.seed, tag).toBe(r.nextSeed);
      const plan = s.chaos.pending!;
      expect({ ...plan, queue: plan.queue.filter((e) => e.kind !== 'lowSteam') }, tag).toEqual(r.pending);
    }
  });

  it('never in shift 1, at most one per plan, in both modes, more often on Hard', () => {
    const total: Record<GameMode, number> = { normal: 0, hard: 0 };
    for (const { r, s } of drawn) {
      const ls = lowSteams(s.chaos.pending!);
      if (r.n === 1) expect(ls, `seed ${r.seed} ${r.mode}`).toHaveLength(0);
      expect(ls.length).toBeLessThanOrEqual(1);
      for (const e of ls) {
        expect(e.eventId).toBe(s.chaos.pending!.queue.length);
        expect(e.disaster).toBe(false);
        expect(e.params).toEqual({});
        expect(e.earliestMinute).toBeGreaterThanOrEqual(LOW_STEAM_MINUTE[0]);
        expect(e.earliestMinute).toBeLessThanOrEqual(LOW_STEAM_MINUTE[1]);
      }
      total[r.mode] += ls.length;
    }
    expect(total.normal).toBeGreaterThanOrEqual(1);
    expect(total.hard).toBeGreaterThanOrEqual(1);
    expect(total.hard).toBeGreaterThan(total.normal);
  });

  // Only when the player answers it: an uncleared lowSteam holds Normal events back through isSettled,
  // as an open disaster does (see director.ts), so an ignored fault can move later events.
  it("leaves the other events' fire timing and the game seed untouched when the fault is answered (standby on from shift start)", () => {
    for (const mode of ['normal', 'hard'] as const) {
      const hit = drawn.find(({ r, s }) => r.mode === mode && lowSteams(s.chaos.pending!).length === 1 && s.chaos.pending!.queue.length > 1)!;
      expect(hit, mode).toBeDefined();
      const plan = hit.s.chaos.pending!;
      const without: PlantState = {
        ...hit.s,
        chaos: { ...hit.s.chaos, pending: { ...plan, queue: plan.queue.filter((e) => e.kind !== 'lowSteam') } },
      };
      /** Play the shift to its end; the fired events (from the summary) and the final state. */
      const play = (s: PlantState) => {
        s = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]).state;
        s = tick(s, [env(s, { type: 'standbySteam', on: true })]).state;
        expect(s.steam.standby).toBe(true);
        let fired: ShiftSummary['events'] = [];
        for (let i = 0; i < SHIFT_TICKS + 1 && s.phase === 'running'; i++) {
          const r = tick(s, []);
          s = r.state;
          for (const e of r.events) if (e.type === 'shiftEnd') fired = e.summary.events;
        }
        return { s, fired };
      };
      const a = play(hit.s);
      const b = play(without);
      const others = (f: ShiftSummary['events']) => f.filter((e) => e.kind !== 'lowSteam').map((e) => [e.eventId, e.kind, e.atMinute]);
      const tag = `seed ${hit.r.seed} ${mode} shift ${hit.r.n}`;
      expect(a.s.phase, tag).toBe('handover');
      expect(a.fired.some((e) => e.kind === 'lowSteam'), tag).toBe(true);
      expect(others(a.fired), tag).toEqual(others(b.fired));
      expect(others(a.fired).length, tag).toBeGreaterThan(0);
      expect(a.s.seed, tag).toBe(b.s.seed);
    }
  }, 60_000);
});
