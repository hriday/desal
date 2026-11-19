import { describe, expect, it } from 'vitest';
import { POWER_DIP_MAX_MINUTES, PUMP_TRIP_WEAR, RECIRC_PUMP_MAX_M3H, STORM_FOULING_PER_TICK } from '../../src/constants.js';
import type { FiredEvent } from '../../src/scenario/chaosTypes.js';
import { isCleared } from '../../src/scenario/director.js';
import { applyEffect } from '../../src/scenario/effects.js';
import { drawEvent } from '../../src/scenario/library.js';
import { startShift } from '../../src/shift.js';
import { createInitialState, type PlantState } from '../../src/state.js';
import { tick } from '../../src/tick.js';
import { GAME_ID } from '../envelope.js';

/** A shift running at nominal with the director's plan emptied, so only what a test applies happens. */
function quiet(): PlantState {
  const s = startShift(createInitialState(1, 0, GAME_ID), 'auto').state;
  return { ...s, chaos: { ...s.chaos, active: null } };
}
function run(s: PlantState, n: number, each?: (s: PlantState) => void): PlantState {
  for (let i = 0; i < n; i++) {
    s = tick(s, []).state;
    each?.(s);
  }
  return s;
}
const settle = (): PlantState => run(quiet(), 30);

describe('pumpTrip', () => {
  it('stops the pump, costs wear, halves intake and does not trip the plant', () => {
    const s0 = settle();
    const before = s0.intake.flowM3h;
    const hit = applyEffect(s0, 'pumpTrip', { pumpId: 'P-101' });
    expect(hit.intake.pumps['P-101'].running).toBe(false);
    expect(hit.intake.pumps['P-101'].wear).toBeCloseTo(s0.intake.pumps['P-101'].wear + PUMP_TRIP_WEAR);
    expect(run(hit, 3).intake.flowM3h).toBeLessThanOrEqual(0.6 * before);
    let tripped = false;
    const after20 = run(hit, 20, (x) => {
      if (x.status === 'tripped') tripped = true;
    });
    expect(tripped).toBe(false);
    expect(after20.status).toBe('online');
  });

  it('starting P-103 restores the flow within 10 ticks', () => {
    const s0 = settle();
    const before = s0.intake.flowM3h;
    const hit = applyEffect(s0, 'pumpTrip', { pumpId: 'P-101' });
    const started: PlantState = {
      ...hit,
      intake: { ...hit.intake, pumps: { ...hit.intake.pumps, 'P-103': { ...hit.intake.pumps['P-103'], running: true } } },
    };
    expect(run(started, 10).intake.flowM3h).toBeGreaterThanOrEqual(0.95 * before);
  });

  it('Auto never starts the standby: P-103 stays stopped for 60 ticks', () => {
    const hit = applyEffect(settle(), 'pumpTrip', { pumpId: 'P-101' });
    run(hit, 60, (x) => {
      expect(x.intake.pumps['P-103'].running).toBe(false);
    });
  });
});

describe('powerDip', () => {
  it('stops the pump without wear, caps recirculation, and expires', () => {
    const s0 = settle();
    const hit = applyEffect(s0, 'powerDip', { pumpId: 'P-102', recircFactor: 0.6, minutes: 20 });
    expect(hit.intake.pumps['P-102'].running).toBe(false);
    expect(hit.intake.pumps['P-102'].wear).toBe(s0.intake.pumps['P-102'].wear);
    expect(hit.faults.powerDipRemainingTicks).toBe(30);
    const during = run(hit, 20);
    expect(during.brine.recircM3h).toBeLessThanOrEqual(0.6 * RECIRC_PUMP_MAX_M3H + 0.1);
    expect(during.faults.powerDipRemainingTicks).toBe(10);
    const after = run(hit, 30);
    expect(after.faults.powerDipRemainingTicks).toBe(0);
    expect(run(after, 5).faults.powerDipRemainingTicks).toBe(0);
  });

  it('draw caps the duration at the named maximum at a high shift number', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const [e] = drawEvent('powerDip', 60, seed, 400);
      expect(Number(e.params.minutes)).toBeLessThanOrEqual(POWER_DIP_MAX_MINUTES);
    }
    const [e] = drawEvent('powerDip', 60, 1, 400);
    expect(e.params.minutes).toBe(POWER_DIP_MAX_MINUTES);
  });
});

describe('storm', () => {
  it('adds fouling and cooling at once, grows it while active, and stops after', () => {
    const s0 = settle();
    const hit = applyEffect(s0, 'storm', { fouling: 0.1, deltaC: 2, minutes: 10 });
    expect(hit.seawater.tempC).toBeCloseTo(s0.seawater.tempC - 2);
    expect(hit.intake.screenFouling).toBeCloseTo(s0.intake.screenFouling + 0.1);
    expect(hit.faults.stormFouling).toBeCloseTo(0.1);
    expect(hit.faults.stormRemainingTicks).toBe(15);
    expect(run(hit, 5).faults.stormFouling).toBeCloseTo(0.1 + 5 * STORM_FOULING_PER_TICK);
    const over = run(hit, 15);
    expect(over.faults.stormRemainingTicks).toBe(0);
    const grown = over.faults.stormFouling;
    expect(grown).toBeCloseTo(0.1 + 15 * STORM_FOULING_PER_TICK);
    const later = run(over, 20);
    expect(later.faults.stormFouling).toBe(grown);
    // The fouling stays (it is not relaxed away) until the crew cleans the screens.
    expect(later.intake.screenFouling).toBeGreaterThanOrEqual(s0.intake.screenFouling + grown - 0.01);
  });
});

describe('storm clearing', () => {
  const ev = { eventId: 1, kind: 'storm', atMinute: 0, params: {}, cleared: false, how: null } as unknown as FiredEvent;

  it('a storm at full screen fouling is not cleared by the crew; it expires', () => {
    const s0 = settle();
    const full: PlantState = { ...s0, intake: { ...s0.intake, screenFouling: 1 } };
    const hit = applyEffect(full, 'storm', { fouling: 0.1, deltaC: 1, minutes: 10 });
    expect(hit.faults.stormFouling).toBe(0);
    expect(isCleared(hit, ev)).toBeNull();
    expect(isCleared(run(hit, 1), ev)).toBeNull();
    expect(isCleared(run(hit, 14), ev)).toBeNull();
    expect(isCleared(run(hit, 15), ev)).toBe('expired');
  });

  it('with the crew flag set it clears as crew', () => {
    const hit = applyEffect(settle(), 'storm', { fouling: 0.1, deltaC: 1, minutes: 10 });
    expect(isCleared({ ...hit, faults: { ...hit.faults, stormCleanedByCrew: true } }, ev)).toBe('crew');
  });
});

describe('interlock', () => {
  it('a single-pump loss with the other duty pump running does not trip noIntakeFlow, even in a heavy storm', () => {
    let s = applyEffect(settle(), 'storm', { fouling: 0.4, deltaC: 0, minutes: 120 });
    s = applyEffect(s, 'pumpTrip', { pumpId: 'P-101' });
    run(s, 60, (x) => expect(x.status).not.toBe('tripped'));
  });
});
