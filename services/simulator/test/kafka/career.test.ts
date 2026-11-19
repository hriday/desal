import { PLANT_KEY } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { pickCareer } from '../../src/kafka/runner.js';
import type { ReadRecord } from '../../src/kafka/read.js';
import { serialize } from '../../src/snapshot.js';
import { createInitialState } from '../../src/state.js';

const at = (tick: number) => ({ ...createInitialState(1, 0), tick });
let offset = 0;
const rec = (value: string | null, key: string | null = PLANT_KEY): ReadRecord => ({ partition: 0, offset: offset++, key, value });
/** A save whose state had a NaN: JSON turns it into null, which restore rejects. */
const nanSave = () => serialize({ ...at(99), heater: { ...at(99).heater, tbtC: Number.NaN } });

describe('pickCareer', () => {
  it('is none for no records, and none when the latest record is a tombstone', () => {
    expect(pickCareer([])).toEqual({ kind: 'none' });
    expect(pickCareer([rec(serialize(at(5))), rec(null)])).toEqual({ kind: 'none' });
  });

  it('takes the newest snapshot for the plant key, ignoring other keys', () => {
    const r = pickCareer([rec(serialize(at(5))), rec(serialize(at(10))), rec('junk', 'other-plant')]);
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.state.tick).toBe(10);
      expect(r.skipped).toEqual([]);
    }
  });

  it('falls back to the newest VALID snapshot when newer ones are bad, and reports what it skipped', () => {
    const bad1 = rec(nanSave());
    const bad2 = rec('{not json');
    const r = pickCareer([rec(serialize(at(5))), rec(serialize(at(10))), bad1, bad2]);
    expect(r.kind).toBe('found');
    if (r.kind !== 'found') return;
    expect(r.state.tick).toBe(10);
    expect(r.skipped.map((x) => x.offset)).toEqual([bad2.offset, bad1.offset]);
    expect(r.skipped[0]!.reason).toMatch(/invalid JSON/);
    expect(r.skipped[1]!.reason).toMatch(/heater\.tbtC/);
  });

  it('is corrupt only when no snapshot is valid, reporting the newest failure', () => {
    const r = pickCareer([rec('{not json'), rec(nanSave())]);
    expect(r.kind).toBe('corrupt');
    if (r.kind === 'corrupt') expect(r.reason).toMatch(/heater\.tbtC/);
  });
});
