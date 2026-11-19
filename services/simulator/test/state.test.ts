import { createInitialState } from '../src/state.js';
import { allFinite } from './helpers.js';
import { GAME_ID } from './envelope.js';

describe('createInitialState', () => {
  const s = createInitialState(1, 0, GAME_ID);
  it('has the expected structure', () => {
    expect(s.stages).toHaveLength(20);
    expect(Object.keys(s.intake.pumps)).toHaveLength(3);
    expect(s.loops.levels).toHaveLength(20);
    expect(s.phase).toBe('handover');
    expect(s.intake.pumps['P-103'].running).toBe(false);
    expect(s.shift).toBeNull();
  });
  it('has only finite numbers', () => {
    expect(allFinite(s)).toBe(true);
  });
});
