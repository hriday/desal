import { describe, expect, it } from 'vitest';
import type { QueuedEvent } from '../../../src/scenario/chaosTypes.js';
import { earthquakeFollowUps } from '../../../src/scenario/disaster/earthquake.js';
import { stepDirector } from '../../../src/scenario/director.js';
import { eventMessage } from '../../../src/scenario/library.js';
import { startShift } from '../../../src/shift.js';
import { createInitialState, type PlantState } from '../../../src/state.js';
import { GAME_ID } from '../../envelope.js';
import type { SimEvent } from '../../../src/state.js';

/** A running shift 3 (two pumps running, one spare) whose queue is just an earthquake, due now. */
function quake(hell = false, seed = 1, extra: Partial<QueuedEvent>[] = []): PlantState {
  const fresh = createInitialState(seed, 0, GAME_ID);
  const s = startShift({ ...fresh, run: { ...fresh.run, shiftNumber: 2 } }, 'auto').state;
  const q: QueuedEvent[] = [
    { eventId: 1, kind: 'earthquake', params: {}, earliestMinute: 1, cascade: false, disaster: true },
    ...extra.map((e, i) => ({ eventId: 2 + i, kind: 'bloom', params: {}, earliestMinute: 500, cascade: false, disaster: false, ...e }) as QueuedEvent),
  ];
  const plan = { ...s.chaos.active!.plan, hell, queue: q };
  const active = { plan, fired: [], lastFiredMinute: null, nextEventId: q.length + 1 };
  return { ...s, tick: s.tick + 60, chaos: { ...s.chaos, active } };
}
/** Step until the earthquake has fired (the first tick draws its minute). */
function fire(s: PlantState): { state: PlantState; events: SimEvent[] } {
  const events: SimEvent[] = [];
  for (let i = 0; i < 40; i++) {
    const r = stepDirector({ ...s, tick: s.tick + i });
    if (r.events.some((e) => e.type === 'scenario')) return { state: r.state, events: [...events, ...r.events] };
  }
  throw new Error('earthquake never fired');
}
const kinds = (events: SimEvent[]) => events.filter((e) => e.type === 'scenario').map((e) => (e as { kind: string }).kind);

describe('earthquake', () => {
  it('fires its children in the same tick, after the earthquake is noted', () => {
    const { events } = fire(quake());
    const ks = kinds(events);
    expect(ks.slice(0, 1)).toEqual(['earthquake']);
    expect(ks.filter((k) => k === 'powerDip').length).toBeGreaterThanOrEqual(1);
    expect(ks).toContain('tubeLeak');
    const sensors = events.filter((e) => e.type === 'scenario' && (e as { kind: string }).kind === 'sensorFailure');
    expect(sensors).toHaveLength(2);
    const at = events.findIndex((e) => e.type === 'scenario');
    expect(events[at + 1]).toMatchObject({ type: 'eventCleared', kind: 'earthquake', how: 'noted' });
  });

  it('hits two different instruments', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { state } = fire(quake(false, seed));
      const loops = state.chaos.active!.fired.filter((e) => e.kind === 'sensorFailure').map((e) => e.params.loop);
      expect(new Set(loops).size).toBe(2);
    }
  });

  it('has an aftershock in some seeds and not others', () => {
    const counts = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) {
      const [children] = earthquakeFollowUps(quake(false, seed), 100, seed);
      const dips = children.filter((c) => c.kind === 'powerDip');
      counts.add(dips.length);
      for (const d of dips.slice(1)) expect(d.earliestMinute).toBeGreaterThanOrEqual(120);
      for (const d of dips.slice(1)) expect(d.earliestMinute).toBeLessThanOrEqual(160);
    }
    expect(counts).toEqual(new Set([1, 2]));
  });

  it('marks every child as a disaster cascade, and one leak can be severe', () => {
    const ppms = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) {
      const [children] = earthquakeFollowUps(quake(false, seed), 100, seed);
      expect(children.every((c) => c.cascade && c.disaster)).toBe(true);
      ppms.add(Number(children.find((c) => c.kind === 'tubeLeak')!.params.ppm));
    }
    expect(ppms.size).toBe(2);
  });

  it('gives all its children to a shift already at 7 non-disaster events', () => {
    const base = quake(true);
    const a = base.chaos.active!;
    const prior = Array.from({ length: 6 }, (_, i) => ({
      eventId: 100 + i, kind: 'bloom' as const, params: {}, atMinute: 1, cleared: true, how: 'noted' as const, disaster: false,
    }));
    const s = { ...base, chaos: { ...base.chaos, active: { ...a, fired: prior } } };
    const ks = kinds(fire(s).events);
    expect(ks).toContain('tubeLeak');
    expect(ks.filter((k) => k === 'sensorFailure')).toHaveLength(2);
    expect(ks).toContain('powerDip');
  });

  it('drops the power dip without a spare pump, and still fires the rest', () => {
    const s = quake();
    const pumps = Object.fromEntries(Object.entries(s.intake.pumps).map(([id, p]) => [id, { ...p, running: true }]));
    const ks = kinds(fire({ ...s, intake: { ...s.intake, pumps } as PlantState['intake'] }).events);
    expect(ks).not.toContain('powerDip');
    expect(ks).toContain('tubeLeak');
    expect(ks.filter((k) => k === 'sensorFailure')).toHaveLength(2);
  });

  it('picks other instruments when some have failed, and drops the failures when none are left', () => {
    const s = quake();
    const frozen = { kind: 'freeze', value: 1 } as const;
    const some = { ...s, faults: { ...s.faults, sensors: { tbt: frozen, intakeFlow: frozen, recirc: frozen } } };
    const [c1] = earthquakeFollowUps(some, 100, 5);
    const picked = c1.filter((c) => c.kind === 'sensorFailure').map((c) => String(c.params.loop));
    expect(picked).toHaveLength(2);
    expect(new Set(picked).size).toBe(2);
    for (const loop of picked) expect(['blowdown', 'vacuum', 'makeup']).toContain(loop);
    const all = {
      ...s,
      faults: { ...s.faults, sensors: { ...some.faults.sensors, blowdown: frozen, vacuum: frozen, makeup: frozen }, tubeLeak: { stage: 1, ppm: 5 } },
    };
    const [c2] = earthquakeFollowUps(all, 100, 5);
    expect(c2.some((c) => c.kind === 'sensorFailure' || c.kind === 'tubeLeak')).toBe(false);
    expect(() => fire({ ...quake(), faults: all.faults })).not.toThrow();
  });

  it('has a radio line that says Earthquake', () => {
    expect(eventMessage('earthquake', {})).toContain('Earthquake');
    const radio = fire(quake()).events.find((e) => e.type === 'scenario') as { radio: string };
    expect(radio.radio).toContain('Earthquake');
  });
});
