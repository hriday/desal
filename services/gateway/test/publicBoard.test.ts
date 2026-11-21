import { LeaderboardSchema, PublicLeaderboardSchema } from '@desal/schema';
import { describe, expect, it } from 'vitest';
import { stripRunId, toPublic } from '../src/publicBoard.js';
import { board, GAME_A, gameEnd, RUN_A, RUN_B, RUN_C, shiftEnd } from './fixtures.js';

describe('toPublic', () => {
  it('drops every runId and passes the strict public schema, both boards keeping their own rows', () => {
    const b = board();
    const pub = toPublic(b);
    expect(PublicLeaderboardSchema.safeParse(pub).success).toBe(true);
    const json = JSON.stringify(pub);
    for (const runId of [RUN_A, RUN_B, RUN_C]) expect(json).not.toContain(runId);
    expect(json).not.toContain('runId');
    expect(pub.normal.allTime.map((r) => r.callSign)).toEqual(['Kestrel-42', 'Heron-7']);
    expect(pub.normal.today.map((r) => r.callSign)).toEqual(['Kestrel-42']);
    expect(pub.hard.allTime.map((r) => r.callSign)).toEqual(['Osprey-3']);
    expect(pub.hard.today).toEqual([]);
    expect(pub).toMatchObject({ updatedAt: b.updatedAt, online: 4, normal: { stats: b.normal.stats } });
  });

  it('drops keys the public board does not define', () => {
    // LeaderboardSchema keeps nothing extra, but a hand-built board might carry anything.
    const b = { ...board(), gameId: GAME_A } as ReturnType<typeof board>;
    expect(JSON.stringify(toPublic(b))).not.toContain(GAME_A);
    expect(LeaderboardSchema.safeParse(board()).success).toBe(true);
  });
});

describe('stripRunId', () => {
  it('returns a copy without runId, leaving the input alone', () => {
    for (const e of [gameEnd(GAME_A, 10, RUN_A), shiftEnd(GAME_A, RUN_A)]) {
      const out = stripRunId(e);
      expect(out).not.toHaveProperty('runId');
      expect(e).toHaveProperty('runId', RUN_A);
      expect(out).toEqual({ ...e, runId: undefined });
    }
  });
});
