import { describe, expect, it } from 'vitest';
import { pickGames } from '../../src/kafka/runner.js';
import type { ReadRecord } from '../../src/kafka/read.js';
import { serialize } from '../../src/snapshot.js';
import { createInitialState, type PlantState } from '../../src/state.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const B = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const at = (gameId: string, tick: number): PlantState => ({ ...createInitialState(1, 0, gameId), tick });
let offset = 0;
const rec = (key: string | null, value: string | null): ReadRecord => ({ partition: 0, offset: offset++, key, value });
const save = (gameId: string, tick: number) => rec(gameId, serialize(at(gameId, tick)));
/** A save whose state had a NaN: JSON turns it into null, which restore rejects. */
const nanSave = (gameId: string) => {
  const s = at(gameId, 99);
  return rec(gameId, serialize({ ...s, heater: { ...s.heater, tbtC: Number.NaN } }));
};

function pick(records: ReadRecord[]) {
  const logs: string[] = [];
  const games = pickGames(records, (m) => logs.push(m));
  return { games, logs, ticks: Object.fromEntries(games.map((g) => [g.run.gameId, g.tick])) };
}

describe('pickGames', () => {
  it('is empty for no records', () => {
    expect(pick([]).games).toEqual([]);
  });

  it('keeps the newest save per gameId', () => {
    const { ticks, logs } = pick([save(A, 5), save(B, 7), save(A, 10)]);
    expect(ticks).toEqual({ [A]: 10, [B]: 7 });
    expect(logs).toEqual([]);
  });

  it('drops a game whose newest record is a tombstone, and never falls back past one', () => {
    expect(pick([save(A, 5), rec(A, null), save(B, 7)]).ticks).toEqual({ [B]: 7 });
    expect(pick([save(A, 5), rec(A, null), nanSave(A)]).ticks).toEqual({});
  });

  it('drops games that are already over', () => {
    const over = { ...at(A, 50), phase: 'over' as const };
    expect(pick([save(A, 5), rec(A, serialize(over))]).games).toEqual([]);
  });

  it('falls back to the newest VALID save when newer ones are bad, and logs each skip', () => {
    const { ticks, logs } = pick([save(A, 5), save(A, 10), nanSave(A), rec(A, '{not json')]);
    expect(ticks).toEqual({ [A]: 10 });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/invalid JSON/);
    expect(logs[1]).toMatch(/heater\.tbtC/);
    for (const l of logs) expect(l).toContain(A);
  });

  it('skips old v1 (single-career era) saves with a log line', () => {
    const v1 = JSON.stringify({ format: 'desal-snapshot', version: 1, savedAt: 0, state: at(A, 3) });
    const { games, logs } = pick([rec('plant-1', v1), save(B, 4)]);
    expect(games.map((g) => g.run.gameId)).toEqual([B]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/v1/);
  });

  it('skips a save whose key is not its gameId, and records with no key', () => {
    const { games, logs } = pick([rec(B, serialize(at(A, 3))), rec(null, serialize(at(A, 3)))]);
    expect(games).toEqual([]);
    expect(logs).toHaveLength(2);
  });
});
