import { describe, expect, it } from 'vitest';
import type { QueuedEvent } from '../../../src/scenario/chaosTypes.js';
import { stepDirector } from '../../../src/scenario/director.js';
import { startShift } from '../../../src/shift.js';
import { createInitialState, type PlantState } from '../../../src/state.js';
import { GAME_ID } from '../../envelope.js';

/** A running shift whose queue is `queue`, every entry due now. */
function withQueue(queue: Omit<QueuedEvent, 'eventId'>[]): PlantState {
  const s = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
  const q = queue.map((e, i) => ({ ...e, eventId: i + 1 }));
  const active = { plan: { ...s.chaos.active!.plan, queue: q }, fired: [], lastFiredMinute: null, nextEventId: q.length + 1 };
  return { ...s, tick: s.tick + 60, chaos: { ...s.chaos, active } };
}
const contamination = (fuel: string): Omit<QueuedEvent, 'eventId'> => ({
  kind: 'fuelContamination',
  params: { fuel },
  earliestMinute: 1,
  cascade: false,
  disaster: true,
});
const scenarios = (r: ReturnType<typeof stepDirector>) => r.events.filter((e) => e.type === 'scenario');

describe('fuelContamination at fire time', () => {
  it('hits, and the radio names, the fuel active when it fires, not the one drawn', () => {
    const s0 = withQueue([contamination('gas')]);
    const s = { ...s0, fuel: { ...s0.fuel, active: 'backup' as const } };
    const r = stepDirector(s);
    expect(r.state.faults.fuelContamination).toEqual({ fuel: 'backup' });
    expect(r.state.chaos.active!.fired[0]!.params.fuel).toBe('backup');
    const ev = scenarios(r)[0] as { radio: string; message: string };
    expect(ev.radio).toContain('backup tank');
    expect(ev.message).toContain('backup tank');
  });

  it('is dropped, with no event, when it is no longer viable', () => {
    const s0 = withQueue([contamination('gas')]);
    const s = { ...s0, fuel: { ...s0.fuel, active: 'gas' as const, backup: { ...s0.fuel.backup, tonnes: 0 } } };
    const r = stepDirector(s);
    expect(scenarios(r)).toHaveLength(0);
    expect(r.state.faults.fuelContamination).toBeNull();
    expect(r.state.chaos.active!.plan.queue).toHaveLength(0);
    expect(r.state.chaos.active!.fired).toHaveLength(0);
  });
});

describe('earthquake aftershock at fire time', () => {
  it('is dropped, not substituted, when no pump can take the dip', () => {
    const s0 = withQueue([{ kind: 'powerDip', params: { pumpId: 'P1' }, earliestMinute: 1, cascade: true, disaster: true }]);
    const pumps = Object.fromEntries(Object.entries(s0.intake.pumps).map(([id, p]) => [id, { ...p, running: false }]));
    const r = stepDirector({ ...s0, intake: { ...s0.intake, pumps } as typeof s0.intake });
    expect(scenarios(r)).toHaveLength(0);
    expect(r.state.chaos.active!.plan.queue).toHaveLength(0);
  });
});
