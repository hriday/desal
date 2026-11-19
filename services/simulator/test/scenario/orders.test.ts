import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../src/state.js';
import type { ChaosPlan } from '../../src/scenario/chaosTypes.js';
import { drawChaosPlan } from '../../src/scenario/draw.js';
import { buildOrders, radioLine } from '../../src/scenario/orders.js';

const state = createInitialState(1, 0, '00000000-0000-4000-8000-000000000000');
const q = (kind: ChaosPlan['queue'][number]['kind'], id = 1) => ({ eventId: id, kind, params: {}, earliestMinute: 0, cascade: false });
const plan = (over: Partial<Omit<ChaosPlan, 'orders'>>): Omit<ChaosPlan, 'orders'> => ({
  shiftNumber: 5,
  hell: false,
  warned: false,
  targetM3: 4500,
  initial: { seawaterTempC: 30, chlorophyllUgL: 1 },
  queue: [q('pumpTrip')],
  ...over,
});

describe('buildOrders', () => {
  it('gives shift 1 a three-line briefing that names the target', () => {
    const [p] = drawChaosPlan({ shiftNumber: 1, seed: 1, lastWasHell: false, state });
    expect(p.orders.briefing).toHaveLength(3);
    expect(p.orders.briefing[0]).toContain(String(p.targetM3));
    expect(buildOrders(plan({ shiftNumber: 2 }), state, 12000).briefing).toEqual([]);
  });

  it('carries target, salinity limit and budget', () => {
    expect(buildOrders(plan({}), state, 13000)).toMatchObject({ targetM3: 4500, maxSalinityPpm: 25, budgetUsd: 13000 });
  });

  it('adds a storm hint on a warned hell shift, with at most two hints', () => {
    const o = buildOrders(plan({ hell: true, warned: true, queue: [q('storm'), q('powerDip', 2), q('tubeLeak', 3)] }), state, 1);
    expect(o.lines.some((l) => /storm/i.test(l))).toBe(true);
    expect(o.lines.length).toBeLessThanOrEqual(1 + 2);
  });

  it('falls back to a generic line when a warned hell plan has no hintable events', () => {
    const o = buildOrders(plan({ hell: true, warned: true, queue: [q('sensorFailure'), q('controllerFault', 2)] }), state, 1);
    expect(o.lines).toContain('Expect a rough shift — stay sharp.');
    const hinted = buildOrders(plan({ hell: true, warned: true, queue: [q('storm')] }), state, 1);
    expect(hinted.lines).not.toContain('Expect a rough shift — stay sharp.');
  });

  it('quotes the initial seawater from the plan draw, not the live state', () => {
    const [p] = drawChaosPlan({ shiftNumber: 3, seed: 7, lastWasHell: false, state, initial: { seawaterTempC: 32.5, chlorophyllUgL: 1.7 } });
    expect(p.initial).toEqual({ seawaterTempC: 32.5, chlorophyllUgL: 1.7 });
    expect(p.orders.lines[0]).toContain('32.5 C');
    expect(p.orders.lines[0]).toContain('1.7 ug/L');
  });

  it('gives an unwarned hell shift the same lines as a normal one', () => {
    const queue = [q('storm'), q('powerDip', 2)];
    const hell = buildOrders(plan({ hell: true, warned: false, queue }), state, 1);
    const normal = buildOrders(plan({ hell: false, warned: false, queue }), state, 1);
    expect(hell.lines).toEqual(normal.lines);
    expect(hell.lines.some((l) => /storm/i.test(l))).toBe(false);
  });

  it('flags a worn pump by name, and only at 50% or more', () => {
    const p102 = state.intake.pumps['P-102'];
    const worn = { ...state, intake: { ...state.intake, pumps: { ...state.intake.pumps, 'P-102': { ...p102, wear: 0.6 } } } };
    expect(buildOrders(plan({}), worn, 1).lines).toContain('P-102 is running rough.');
    expect(buildOrders(plan({}), state, 1).lines.some((l) => /rough/.test(l))).toBe(false);
  });
});

describe('radioLine', () => {
  it('speaks in the plant voice', () => {
    expect(radioLine('pumpTrip', { pumpId: 'P-101' })).toBe("Control, P-101 just tripped — she's coasting down!");
  });
});
