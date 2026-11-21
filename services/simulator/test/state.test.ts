import { createInitialState } from '../src/state.js';
import { allFinite } from './helpers.js';
import { GAME_ID } from './envelope.js';

describe('createInitialState', () => {
  const s = createInitialState(1, 0, GAME_ID);
  it('has the expected structure', () => {
    expect(s.stages).toHaveLength(24);
    expect(Object.keys(s.intake.pumps)).toHaveLength(3);
    expect(s.loops.levels).toHaveLength(23);
    expect(s.phase).toBe('handover');
    expect(s.intake.pumps['P-103'].running).toBe(false);
    expect(s.shift).toBeNull();
  });
  it('starts with no chaos or crew and healthy faults', () => {
    expect(s.chaos).toEqual({ pending: null, active: null, lastWasHell: false, lastHadDisaster: false });
    expect(s.crew).toBeNull();
    expect(s.faults.stageDerate).toHaveLength(24);
    expect(s.faults.stageDerate.every((d) => d === 1)).toBe(true);
    expect(s.faults).toMatchObject({ tubeLeak: null, ejectorFailed: false, powerDipRemainingTicks: 0, stormRemainingTicks: 0, stormFouling: 0, fuelContamination: null, tsunami: null, sensors: {} });
  });
  it('has only finite numbers', () => {
    expect(allFinite(s)).toBe(true);
  });
});
