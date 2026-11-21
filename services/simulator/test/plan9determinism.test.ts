import { readFileSync } from 'node:fs';
import type { GameMode, ShiftSummary } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { SHIFT_TICKS } from '../src/constants.js';
import type { ChaosPlan } from '../src/scenario/chaosTypes.js';
import { VACUUM_TRAIN_MINUTE } from '../src/scenario/difficulty.js';
import { drawPendingPlan } from '../src/shift.js';
import { createInitialState, type PlantState } from '../src/state.js';
import { tick } from '../src/tick.js';
import { env, GAME_ID } from './envelope.js';

// Frozen on the pre-Plan-9 code (Task 1): seeds 1-10, Normal and Hard, shifts 1-8.
interface PlanRecord {
  seed: number;
  mode: GameMode;
  n: number;
  nextSeed: number;
  pending: ChaosPlan;
}
const RECORDS = JSON.parse(readFileSync(new URL('./fixtures/plans-pre-plan9.json', import.meta.url), 'utf8')) as PlanRecord[];

/** The state the fixture was drawn from: shift n − 1 just ended, no disaster last shift. */
function before(r: PlanRecord): PlantState {
  const s = createInitialState(r.seed, 0, GAME_ID);
  return { ...s, run: { ...s.run, mode: r.mode, shiftNumber: r.n - 1 }, chaos: { ...s.chaos, lastHadDisaster: false } };
}
const isNew = (kind: string): boolean => kind === 'coolingLoss' || kind === 'airLeak';
const newFaults = (p: ChaosPlan) => p.queue.filter((e) => isNew(e.kind));
const drawn = RECORDS.map((r) => ({ r, s: drawPendingPlan(before(r)) }));

describe('Plan 9 determinism: coolingLoss and airLeak ride their own substream', () => {
  it('keeps the game seed sequence and every other queued event', () => {
    expect(RECORDS.length).toBe(160);
    for (const { r, s } of drawn) {
      const tag = `seed ${r.seed} ${r.mode} shift ${r.n}`;
      expect(s.seed, tag).toBe(r.nextSeed);
      const plan = s.chaos.pending!;
      expect({ ...plan, queue: plan.queue.filter((e) => !isNew(e.kind)) }, tag).toEqual(r.pending);
    }
  });

  it('never in shift 1, at most one per plan, the last eventId, in the minute window, more often on Hard', () => {
    const total: Record<GameMode, number> = { normal: 0, hard: 0 };
    for (const { r, s } of drawn) {
      const nf = newFaults(s.chaos.pending!);
      if (r.n === 1) expect(nf, `seed ${r.seed} ${r.mode}`).toHaveLength(0);
      expect(nf.length).toBeLessThanOrEqual(1);
      for (const e of nf) {
        expect(e.eventId).toBe(s.chaos.pending!.queue.length);
        expect(e.disaster).toBe(false);
        expect(e.params).toEqual({});
        expect(e.earliestMinute).toBeGreaterThanOrEqual(VACUUM_TRAIN_MINUTE[0]);
        expect(e.earliestMinute).toBeLessThanOrEqual(VACUUM_TRAIN_MINUTE[1]);
      }
      total[r.mode] += nf.length;
    }
    expect(total.normal).toBeGreaterThanOrEqual(1);
    expect(total.hard).toBeGreaterThan(total.normal);
  });

  // As Plan 8's lowSteam: an uncleared fault holds Normal events back through isSettled, so the
  // check uses Hard plans (no settling rule), where the fault cannot move the others.
  it("removing the entry leaves the other events' fire timing and the final game seed identical", () => {
    const hits = drawn.filter(
      ({ r, s }) => r.mode === 'hard' && newFaults(s.chaos.pending!).length === 1 && s.chaos.pending!.queue.length > 1,
    );
    expect(hits.length).toBeGreaterThan(0);
    const kinds = new Set<string>();
    for (const hit of hits.slice(0, 3)) {
      const plan = hit.s.chaos.pending!;
      const without: PlantState = {
        ...hit.s,
        chaos: { ...hit.s.chaos, pending: { ...plan, queue: plan.queue.filter((e) => !isNew(e.kind)) } },
      };
      /** Play the shift to its end; the fired events (from the summary) and the final state. */
      const play = (s: PlantState) => {
        s = tick(s, [env(s, { type: 'startShift', mode: 'auto' }, null)]).state;
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
      const others = (f: ShiftSummary['events']) => f.filter((e) => !isNew(e.kind)).map((e) => [e.eventId, e.kind, e.atMinute]);
      const tag = `seed ${hit.r.seed} shift ${hit.r.n}`;
      const mine = a.fired.find((e) => isNew(e.kind));
      if (!mine) continue; // the run's plant tripped out of running before its minute
      kinds.add(mine.kind);
      expect(others(a.fired), tag).toEqual(others(b.fired));
      expect(others(a.fired).length, tag).toBeGreaterThan(0);
      expect(a.s.seed, tag).toBe(b.s.seed);
    }
    expect(kinds.size).toBeGreaterThan(0);
  }, 120_000);
});
