import type { PlantEvent, ScenarioKind, ShiftSummary } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { SHIFT_TICKS } from '../../src/constants.js';
import { applyTrip } from '../../src/safety/interlocks.js';
import type { FiredEvent, QueuedEvent } from '../../src/scenario/chaosTypes.js';
import { elapsedMinutes, isCleared, isSettled, stepDirector } from '../../src/scenario/director.js';
import { drawEvent } from '../../src/scenario/library.js';
import { startShift } from '../../src/shift.js';
import { restore, serialize } from '../../src/snapshot.js';
import { createInitialState, type PlantState } from '../../src/state.js';
import { tick } from '../../src/tick.js';
import { GAME_ID } from '../envelope.js';

type Q = { kind: ScenarioKind; params?: Record<string, number | string>; earliestMinute?: number };

/** Shift 3 running in Auto, with the director's plan replaced by `queue` (normal or hell). */
function running(queue: Q[], hell: boolean, seed = 1): PlantState {
  const fresh = createInitialState(seed, 0, GAME_ID);
  const started = startShift({ ...fresh, run: { ...fresh.run, shiftNumber: 2 } }, 'auto').state;
  const q: QueuedEvent[] = queue.map((e, i) => ({
    eventId: i + 1,
    kind: e.kind,
    params: e.params ?? {},
    earliestMinute: e.earliestMinute ?? 0,
    cascade: false,
    disaster: false,
  }));
  const plan = { ...started.chaos.active!.plan, hell, queue: q };
  return { ...started, chaos: { ...started.chaos, active: { plan, fired: [], lastFiredMinute: null, nextEventId: q.length + 1 } } };
}

const fired = (s: PlantState): FiredEvent[] => s.chaos.active?.fired ?? [];

/**
 * Advance `ticks` ticks with tick(), applying `hold` to the state after each one (it stands in for
 * physics or player action the test needs), and collect every event.
 */
function advance(s: PlantState, ticks: number, hold: (s: PlantState) => PlantState = (x) => x) {
  const events: PlantEvent[] = [];
  for (let i = 0; i < ticks && s.phase === 'running'; i++) {
    const r = tick(s, []);
    events.push(...r.events);
    s = hold(r.state);
  }
  return { s, events };
}

/** Run until `pred` holds (or the shift ends). */
function until(s: PlantState, pred: (s: PlantState) => boolean, hold: (s: PlantState) => PlantState = (x) => x): PlantState {
  while (s.phase === 'running' && !pred(s)) s = hold(tick(s, []).state);
  return s;
}

const LEAK = { stage: 3, ppm: 8 };
/** Keep a leak open while its event is uncleared, standing in for Task 7's physics. */
const holdLeak = (s: PlantState): PlantState => {
  const leak = fired(s).find((e) => e.kind === 'tubeLeak');
  return leak && !leak.cleared ? { ...s, faults: { ...s.faults, tubeLeak: LEAK } } : s;
};

describe('director: normal shift', () => {
  const plan: Q[] = [
    { kind: 'tubeLeak', params: LEAK },
    { kind: 'vacuumLoss', params: { ratePerMin: 0.004 } },
  ];

  it('fires the first event between minute 30 and 150', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const s = until(running(plan, false, seed), (x) => fired(x).length > 0);
      const first = fired(s)[0]!;
      expect(first.eventId).toBe(1);
      expect(first.atMinute).toBeGreaterThanOrEqual(30);
      expect(first.atMinute).toBeLessThanOrEqual(150);
    }
  });

  it('holds the second event while the first is uncleared, until the 180-minute override', () => {
    let s = until(running(plan, false), (x) => fired(x).length > 0, holdLeak);
    const first = fired(s)[0]!.atMinute;
    s = until(s, (x) => fired(x).length > 1, (x) => {
      // Still unsettled and still unfired right up to the override.
      if (fired(x).length === 1) expect(isSettled(holdLeak(x))).toBe(false);
      return holdLeak(x);
    });
    const second = fired(s)[1]!;
    expect(second.kind).toBe('vacuumLoss');
    expect(second.atMinute).toBeGreaterThanOrEqual(first + 180);
    expect(second.atMinute).toBeLessThan(first + 181);
    expect(fired(s)[0]!.cleared).toBe(false);
  });

  it('after the first clears, fires the second 60 minutes after the first', () => {
    let s = until(running(plan, false), (x) => fired(x).length > 0, holdLeak);
    const first = fired(s)[0]!.atMinute;
    // The crew plugs the leak ten minutes in.
    s = until(s, (x) => elapsedMinutes(x) >= first + 10, holdLeak);
    const cleared = advance({ ...s, faults: { ...s.faults, tubeLeak: null } }, 1);
    expect(cleared.events.filter((e) => e.type === 'eventCleared')).toMatchObject([{ eventId: 1, kind: 'tubeLeak', how: 'crew' }]);
    s = until(cleared.s, (x) => fired(x).length > 1);
    const second = fired(s)[1]!.atMinute;
    expect(second).toBeGreaterThanOrEqual(first + 60);
    expect(second).toBeLessThan(first + 61);
  });

  it('a trip after the first event clears holds the next one until the 180-minute override', () => {
    let s = until(running(plan, false), (x) => fired(x).length > 0, holdLeak);
    const first = fired(s)[0]!.atMinute;
    s = until(s, (x) => elapsedMinutes(x) >= first + 5, holdLeak);
    s = advance({ ...s, faults: { ...s.faults, tubeLeak: null } }, 1).s;
    expect(fired(s)[0]!.cleared).toBe(true);
    s = until(s, (x) => elapsedMinutes(x) >= first + 20);
    s = applyTrip(s, 'manual').state;
    // Never restarted: the plant stays down, so it never settles.
    s = until(s, (x) => fired(x).length > 1, (x) => {
      expect(x.status).not.toBe('online');
      return x;
    });
    const second = fired(s)[1]!.atMinute;
    expect(second).toBeGreaterThanOrEqual(first + 180);
    expect(second).toBeLessThan(first + 181);
  });

  it('an event that would fire after minute 420 never fires and is left out of the summary', () => {
    // The first is pinned at minute 300 and never clears; the second would need minute 480.
    const s0 = running([{ ...plan[0]!, earliestMinute: 300 }, plan[1]!], false);
    const { events } = advance(s0, SHIFT_TICKS, holdLeak);
    const scenario = events.filter((e) => e.type === 'scenario');
    expect(scenario.map((e) => e.eventId)).toEqual([1]);
    const end = events.find((e) => e.type === 'shiftEnd') as { summary: ShiftSummary } | undefined;
    expect(end!.summary.events.map((e) => e.eventId)).toEqual([1]);

    // Past minute 420 the queue is dropped.
    const late = advance(s0, 640, holdLeak).s;
    expect(elapsedMinutes(late)).toBeGreaterThan(420);
    expect(late.chaos.active!.plan.queue).toEqual([]);
  });

  it('an event pinned after minute 420 never fires', () => {
    const { events } = advance(running([{ ...plan[0]!, earliestMinute: 430 }], false), SHIFT_TICKS);
    expect(events.filter((e) => e.type === 'scenario')).toEqual([]);
    const end = events.find((e) => e.type === 'shiftEnd') as { summary: ShiftSummary };
    expect(end.summary.events).toEqual([]);
  });
});

describe('director: hell shift', () => {
  it('fires 5 events in a burst, 10–40 minutes apart, regardless of clearing', () => {
    const plan: Q[] = [
      { kind: 'tubeLeak', params: LEAK },
      { kind: 'vacuumLoss', params: { ratePerMin: 0.004 } },
      { kind: 'tubeLeak', params: LEAK },
      { kind: 'vacuumLoss', params: { ratePerMin: 0.004 } },
      { kind: 'controllerFault', params: { loop: 'recirc', kind: 'drift' } },
    ];
    // Nothing is ever fixed: the leak stays open and the ejector stays failed.
    const hold = (s: PlantState): PlantState =>
      fired(s).length > 0 ? { ...s, faults: { ...s.faults, tubeLeak: LEAK, ejectorFailed: true } } : s;
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = until(running(plan, true, seed), (x) => fired(x).length === 5, hold);
      const f = fired(s);
      expect(f.map((e) => e.eventId)).toEqual([1, 2, 3, 4, 5]);
      expect(f[0]!.atMinute).toBeGreaterThanOrEqual(30);
      expect(f[0]!.atMinute).toBeLessThanOrEqual(120);
      for (let i = 1; i < f.length; i++) {
        const gap = f[i]!.atMinute - f[i - 1]!.atMinute;
        expect(gap).toBeGreaterThanOrEqual(10);
        expect(gap).toBeLessThan(41);
      }
      expect(f.filter((e) => e.kind !== 'controllerFault').every((e) => !e.cleared)).toBe(true);
    }
  });
});

/** A hell state whose plan is these sharp kinds with params drawn from `seed`. */
function hellOf(kinds: ScenarioKind[], seed: number): PlantState {
  let r = seed;
  const queue = kinds.map((kind) => {
    let e;
    [e, r] = drawEvent(kind, 0, r, 3, ['P-101', 'P-102']);
    return { kind, params: e.params };
  });
  return running(queue, true, seed);
}

/** Step only the director (and the clock) through the shift: fast enough for thousands of seeds. */
function directOnly(s: PlantState, onTick: (s: PlantState) => void): PlantState {
  for (let i = 0; i < SHIFT_TICKS; i++) {
    s = stepDirector(s).state;
    onTick(s);
    s = { ...s, tick: s.tick + 1 };
  }
  return s;
}

describe('director: cascades', () => {
  it('a hell storm can queue a bloom 60–120 minutes later', () => {
    let found: { s: PlantState; storm: FiredEvent } | null = null;
    for (let seed = 1; seed <= 50 && !found; seed++) {
      const s = until(hellOf(['storm'], seed), (x) => fired(x).length > 0);
      if (s.chaos.active!.plan.queue.length > 0) found = { s, storm: fired(s)[0]! };
    }
    expect(found).not.toBeNull();
    const { s, storm } = found!;
    const [bloom] = s.chaos.active!.plan.queue;
    expect(bloom).toMatchObject({ eventId: 2, kind: 'bloom', cascade: true });
    expect(bloom!.earliestMinute).toBeGreaterThanOrEqual(storm.atMinute + 60);
    expect(bloom!.earliestMinute).toBeLessThanOrEqual(storm.atMinute + 120);
    expect(s.chaos.active!.nextEventId).toBe(3);
    const later = until(s, (x) => fired(x).length > 1);
    expect(fired(later)[1]).toMatchObject({ eventId: 2, kind: 'bloom' });
  });

  it('a normal storm never cascades', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = until(running([{ kind: 'storm', params: { fouling: 0.1, deltaC: 1.5, minutes: 90 } }], false, seed), (x) => fired(x).length > 0);
      expect(s.chaos.active!.plan.queue).toEqual([]);
    }
  });

  it('never has more than 7 events fired and queued, across 2,000 seeds', () => {
    const kinds: ScenarioKind[] = ['storm', 'powerDip', 'pumpTrip', 'storm', 'powerDip', 'pumpTrip'];
    let reachedCap = 0;
    const cascadeKinds = new Set<string>();
    for (let seed = 1; seed <= 2000; seed++) {
      let max = 0;
      const end = directOnly(hellOf(kinds, seed), (s) => {
        const a = s.chaos.active!;
        max = Math.max(max, a.fired.length + a.plan.queue.length);
      });
      expect(max).toBeLessThanOrEqual(7);
      if (max === 7) reachedCap++;
      for (const e of fired(end).filter((x) => x.eventId > 6)) cascadeKinds.add(e.kind);
    }
    expect(reachedCap).toBeGreaterThan(0);
    expect([...cascadeKinds].sort()).toEqual(['bloom', 'pumpBearing', 'sensorFailure']);
  });

  it('pumpTrip → pumpBearing goes on the standby, immediately', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const s = until(hellOf(['pumpTrip', 'tubeLeak'], seed), (x) => fired(x).length > 0);
      const [head] = s.chaos.active!.plan.queue;
      if (head?.cascade) {
        expect(head).toMatchObject({ kind: 'pumpBearing', eventId: 3, earliestMinute: fired(s)[0]!.atMinute });
        expect(head.params.pumpId).toBe('P-103');
        return;
      }
    }
    expect.unreachable('no seed in 1..50 cascaded');
  });
});

describe('director: firing', () => {
  it('informational kinds emit scenario then eventCleared{noted} in the same tick', () => {
    const s0 = running([{ kind: 'demandChange', params: { deltaM3: 100 } }], false);
    let s = s0;
    let events: PlantEvent[] = [];
    while (events.length === 0 && s.phase === 'running') {
      const r = tick(s, []);
      s = r.state;
      events = r.events.filter((e) => e.type === 'scenario' || e.type === 'eventCleared');
    }
    expect(events).toMatchObject([
      { type: 'scenario', eventId: 1, kind: 'demandChange' },
      { type: 'eventCleared', eventId: 1, kind: 'demandChange', how: 'noted' },
    ]);
    expect(events[0]!.seq + 1).toBe(events[1]!.seq);
    expect(fired(s)[0]).toMatchObject({ cleared: true, how: 'noted' });
    expect(s.shift!.target.productM3).toBe(s0.shift!.target.productM3 + 100);
  });

  it('the scenario event carries the plan eventId, the message and the radio line', () => {
    const s = running([{ kind: 'pumpTrip', params: { pumpId: 'P-102' }, earliestMinute: 30 }], false);
    const ev = advance(s, 50).events.find((e) => e.type === 'scenario');
    expect(ev).toMatchObject({
      eventId: 1,
      kind: 'pumpTrip',
      message: "Control, P-102 just tripped — she's coasting down!",
      radio: "Control, P-102 just tripped — she's coasting down!",
    });
  });

  it('a pump trip with no spare to start is substituted by the next sharp kind', () => {
    const s0 = running([{ kind: 'pumpTrip', params: { pumpId: 'P-101' }, earliestMinute: 30 }], false);
    const p = s0.intake.pumps;
    const overhaul = { ...s0, intake: { ...s0.intake, pumps: { ...p, 'P-103': { ...p['P-103'], overhaulRemainingTicks: 500 } } } };
    const s = until(overhaul, (x) => fired(x).length > 0);
    expect(fired(s)[0]).toMatchObject({ eventId: 1, kind: 'tubeLeak' });
    expect(fired(s)[0]!.params).toHaveProperty('stage');

    const dip = running([{ kind: 'powerDip', params: { pumpId: 'P-101', recircFactor: 0.6, minutes: 30 }, earliestMinute: 30 }], false);
    const dp = dip.intake.pumps;
    const noSpare = { ...dip, intake: { ...dip.intake, pumps: { ...dp, 'P-103': { ...dp['P-103'], overhaulRemainingTicks: 500 } } } };
    expect(fired(until(noSpare, (x) => fired(x).length > 0))[0]!.kind).toBe('storm');
  });

  it('a pump trip whose target has stopped re-aims at a running pump', () => {
    const s0 = running([{ kind: 'pumpTrip', params: { pumpId: 'P-101' }, earliestMinute: 30 }], false);
    const p = s0.intake.pumps;
    const swapped = { ...s0, intake: { ...s0.intake, pumps: { ...p, 'P-101': { ...p['P-101'], running: false }, 'P-103': { ...p['P-103'], running: true } } } };
    const s = until(swapped, (x) => fired(x).length > 0);
    expect(fired(s)[0]!.kind).toBe('pumpTrip');
    expect(['P-102', 'P-103']).toContain(fired(s)[0]!.params.pumpId);
  });

  it('does nothing outside a running shift or without an active plan', () => {
    const s = running([{ kind: 'tubeLeak', params: LEAK }], false);
    const paused = { ...s, phase: 'paused' as const };
    expect(stepDirector(paused)).toEqual({ state: paused, events: [] });
    const none = { ...s, chaos: { ...s.chaos, active: null } };
    expect(stepDirector(none)).toEqual({ state: none, events: [] });
  });
});

describe('isCleared', () => {
  const s = running([], false);
  const ev = (kind: ScenarioKind, params: Record<string, number | string> = {}): FiredEvent => ({
    eventId: 1,
    kind,
    params,
    atMinute: 40,
    cleared: false,
    how: null,
    disaster: false,
  });
  const p = s.intake.pumps;
  const oneRunning = { ...s, intake: { ...s.intake, pumps: { ...p, 'P-101': { ...p['P-101'], running: false } } } };

  it('pump trip and power dip: two pumps running (and the dip over)', () => {
    expect(isCleared(oneRunning, ev('pumpTrip'))).toBeNull();
    expect(isCleared(s, ev('pumpTrip'))).toBe('player');
    const dipping = { ...s, faults: { ...s.faults, powerDipRemainingTicks: 3 } };
    expect(isCleared(dipping, ev('powerDip'))).toBeNull();
    expect(isCleared(oneRunning, ev('powerDip'))).toBeNull();
    expect(isCleared(s, ev('powerDip'))).toBe('player');
  });

  it('crew faults: cleared when the fault field is clear', () => {
    expect(isCleared({ ...s, faults: { ...s.faults, tubeLeak: LEAK } }, ev('tubeLeak'))).toBeNull();
    expect(isCleared(s, ev('tubeLeak'))).toBe('crew');
    expect(isCleared({ ...s, faults: { ...s.faults, ejectorFailed: true } }, ev('vacuumLoss'))).toBeNull();
    expect(isCleared(s, ev('vacuumLoss'))).toBe('crew');
    const frozen = { ...s, faults: { ...s.faults, sensors: { tbt: { kind: 'freeze' as const, value: 108 } } } };
    expect(isCleared(frozen, ev('sensorFailure', { loop: 'tbt', mode: 'freeze' }))).toBeNull();
    expect(isCleared(frozen, ev('sensorFailure', { loop: 'vacuum', mode: 'freeze' }))).toBe('crew');
  });

  it('storm: crew when the screens are cleaned, expired when it passes with fouling left', () => {
    const storming = { ...s, faults: { ...s.faults, stormRemainingTicks: 50, stormFouling: 0.2, stormCleanedByCrew: false } };
    expect(isCleared(storming, ev('storm'))).toBeNull();
    expect(isCleared({ ...storming, faults: { ...storming.faults, stormCleanedByCrew: true } }, ev('storm'))).toBe('crew');
    expect(isCleared({ ...storming, faults: { ...storming.faults, stormRemainingTicks: 0 } }, ev('storm'))).toBe('expired');
  });

  it('controller fault: cleared when its loop is in Manual', () => {
    expect(isCleared(s, ev('controllerFault', { loop: 'recirc', kind: 'drift' }))).toBeNull();
    const manual = { ...s, loops: { ...s.loops, recirc: { ...s.loops.recirc, mode: 'manual' as const } } };
    expect(isCleared(manual, ev('controllerFault', { loop: 'recirc', kind: 'drift' }))).toBe('player');
    const levels = s.loops.levels.map((l, i) => (i === 2 ? { ...l, mode: 'manual' as const } : l));
    expect(isCleared({ ...s, loops: { ...s.loops, levels } }, ev('controllerFault', { loop: 'level3', kind: 'stuck' }))).toBe('player');
  });

  it('bloom: cleared by raising chlorine, or once chlorophyll settles under the alarm', () => {
    const blooming = {
      ...s,
      seawater: { ...s.seawater, chlorophyllUgL: 5 },
      scenario: { ...s.scenario, effects: { ...s.scenario.effects, chlorophyllTarget: 8, chlorophyllRampPerTick: 0.05 } },
    };
    const bloom = ev('bloom', { peakUgL: 8, rampMinutes: 120, chlorineAtFireMgL: 1 });
    expect(isCleared(blooming, bloom)).toBeNull();
    expect(isCleared({ ...blooming, pretreat: { ...blooming.pretreat, chlorineMgL: 1.5 } }, bloom)).toBe('player');
    // Still ramping, below the alarm: not yet.
    expect(isCleared({ ...blooming, seawater: { ...blooming.seawater, chlorophyllUgL: 2 } }, bloom)).toBeNull();
    const mild = { ...blooming, seawater: { ...blooming.seawater, chlorophyllUgL: 3 }, scenario: { ...blooming.scenario, effects: { ...blooming.scenario.effects, chlorophyllTarget: 3 } } };
    expect(isCleared(mild, bloom)).toBe('player');
  });

  it('isSettled needs every fired event cleared, the plant online and salinity in spec', () => {
    expect(isSettled(s)).toBe(true);
    const withOpen = { ...s, chaos: { ...s.chaos, active: { ...s.chaos.active!, fired: [ev('tubeLeak')] } } };
    expect(isSettled(withOpen)).toBe(false);
    expect(isSettled({ ...s, status: 'tripped' })).toBe(false);
    expect(isSettled({ ...s, product: { ...s.product, salinityPpm: 30 } })).toBe(false);
  });
});

describe('director: replay', () => {
  it('a snapshot mid-shift restores and continues exactly like an uninterrupted run', () => {
    const kinds: ScenarioKind[] = ['storm', 'pumpTrip', 'tubeLeak', 'powerDip', 'vacuumLoss', 'bloom'];
    // Find a plan that has events both before and after the snapshot point.
    for (let seed = 1; seed <= 20; seed++) {
      const mid = advance(hellOf(kinds, seed), 120).s;
      if (fired(mid).length === 0 || mid.chaos.active!.plan.queue.length === 0) continue;
      const restored = restore(serialize(mid));
      expect(restored.ok).toBe(true);
      const a = advance(mid, 200);
      const b = advance((restored as { ok: true; state: PlantState }).state, 200);
      expect(b.events).toEqual(a.events);
      expect(b.s).toEqual(a.s);
      expect(a.events.some((e) => e.type === 'scenario')).toBe(true);
      return;
    }
    expect.unreachable('no seed split its events around tick 120');
  });
});
