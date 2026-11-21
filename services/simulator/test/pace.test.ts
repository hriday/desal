import { describe, expect, it } from 'vitest';
import { FAST_PACE } from '../src/constants.js';
import { GameHost } from '../src/host.js';
import { BUSY_TICK_MS, CALM_TICK_MS, DUE_SLACK_MS, isBusy, paceOf, tickIntervalMs } from '../src/pace.js';
import type { FiredEvent } from '../src/scenario/chaosTypes.js';
import type { PlantState } from '../src/state.js';
import { nextId } from './envelope.js';

const GID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const cmd = (command: Record<string, unknown>) => ({ commandId: nextId(), issuedAt: 0, gameId: GID, shiftId: null, command });

/** A game of `mode` one tick into its first shift. */
function running(mode: 'normal' | 'hard' = 'normal'): PlantState {
  const h = new GameHost({ paced: false });
  h.step([cmd({ type: 'startGame', mode })], 0);
  h.step([cmd({ type: 'startShift', mode: 'auto' })], 1000);
  const s = h.games().get(GID)!.state;
  expect(s.phase).toBe('running');
  return s;
}

const ev = (cleared: boolean): FiredEvent => ({
  eventId: 1,
  kind: 'pumpTrip',
  params: { pumpId: 'P-101' },
  atMinute: 5,
  cleared,
  how: cleared ? 'player' : null,
  disaster: false,
});

const withFired = (s: PlantState, fired: FiredEvent[]): PlantState => ({
  ...s,
  chaos: { ...s.chaos, active: { ...s.chaos.active!, fired } },
});

describe('pace constants', () => {
  it('runs 3 ticks per real second when calm, 1 when busy', () => {
    expect(FAST_PACE).toBe(3);
    expect(BUSY_TICK_MS).toBe(1000);
    expect(CALM_TICK_MS).toBe(1000 / 3);
    expect(DUE_SLACK_MS).toBe(CALM_TICK_MS / 2);
  });
});

describe('isBusy', () => {
  for (const mode of ['normal', 'hard'] as const) {
    describe(mode, () => {
      const s = running(mode);
      it('nothing fired: calm', () => expect(isBusy(withFired(s, []))).toBe(false));
      it('an uncleared fired event: busy', () => expect(isBusy(withFired(s, [ev(true), ev(false)]))).toBe(true));
      it('every fired event cleared: calm', () => expect(isBusy(withFired(s, [ev(true), ev(true)]))).toBe(false));
      it('tripped: busy', () => expect(isBusy({ ...withFired(s, []), status: 'tripped' })).toBe(true));
      it('restarting: busy', () => expect(isBusy({ ...withFired(s, []), status: 'restarting' })).toBe(true));
      it('acid cleaning with no open events: calm', () =>
        expect(isBusy({ ...withFired(s, []), status: 'acidCleaning' })).toBe(false));
      it('no active chaos (outside a shift): calm unless tripped', () => {
        const none = { ...s, chaos: { ...s.chaos, active: null } };
        expect(isBusy(none)).toBe(false);
        expect(isBusy({ ...none, status: 'tripped' })).toBe(true);
      });
    });
  }

  it('Hard and Normal give the same answer for the same plant', () => {
    const n = running('normal');
    const h = running('hard');
    for (const fired of [[], [ev(false)], [ev(true)]]) {
      for (const status of ['online', 'tripped', 'restarting', 'acidCleaning'] as const) {
        expect(isBusy({ ...withFired(h, fired), status })).toBe(isBusy({ ...withFired(n, fired), status }));
      }
    }
  });
});

describe('paceOf and tickIntervalMs', () => {
  const s = withFired(running(), []);

  it('a calm running plant is calm, at the calm interval', () => {
    expect(paceOf(s)).toBe('calm');
    expect(tickIntervalMs(s)).toBe(CALM_TICK_MS);
  });

  it('a busy running plant is busy, at the busy interval', () => {
    const b = withFired(s, [ev(false)]);
    expect(paceOf(b)).toBe('busy');
    expect(tickIntervalMs(b)).toBe(BUSY_TICK_MS);
  });

  it('handover, paused and over keep 1 tick/s: busy', () => {
    for (const phase of ['handover', 'paused', 'over'] as const) {
      expect(paceOf({ ...s, phase }), phase).toBe('busy');
      expect(tickIntervalMs({ ...s, phase }), phase).toBe(BUSY_TICK_MS);
    }
  });
});
