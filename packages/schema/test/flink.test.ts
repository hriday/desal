import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LeaderboardSchema, PublicLeaderboardSchema, RunRankSchema, RunResultSchema, ServerMsgSchema, ShiftReportSchema } from '../src/index.js';

const dir = join(import.meta.dirname, 'fixtures', 'flink');
const load = (name: string): any => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const R = '11111111-2222-4333-8444-555555555555';

const report = load('shift-report.json');
const board = load('leaderboard.json');
const publicBoard = (() => {
  const b = structuredClone(board);
  for (const m of ['normal', 'hard']) for (const k of ['allTime', 'today']) for (const r of b[m][k]) delete r.runId;
  return b;
})();

describe('ShiftReportSchema', () => {
  it('parses a full example', () => {
    expect(ShiftReportSchema.parse(report)).toEqual(report);
  });
  it.each([
    ['grade E', { grade: 'E' }],
    ['mode easy', { mode: 'easy' }],
    ['9 pace points', { pace: [...report.pace, { hour: 8, productM3: 1, targetM3: 1 }] }],
    ['score over 100', { score: 101 }],
    ['pace hour 9', { pace: [{ hour: 9, productM3: 1, targetM3: 1 }] }],
  ])('rejects %s', (_n, patch) => {
    expect(ShiftReportSchema.safeParse({ ...report, ...patch }).success).toBe(false);
  });
  it('rejects verdict late', () => {
    const events = [{ ...report.events[0], verdict: 'late' }];
    expect(ShiftReportSchema.safeParse({ ...report, events }).success).toBe(false);
  });
});

describe('RunResultSchema', () => {
  it('requires mode', () => {
    const { mode: _m, ...noMode } = load('run-result.json');
    expect(RunResultSchema.safeParse(noMode).success).toBe(false);
  });
});

describe('leaderboard schemas', () => {
  it('the internal board keeps runId on rows', () => {
    expect(LeaderboardSchema.safeParse(board).success).toBe(true);
  });
  it('the public board parses without runIds', () => {
    expect(PublicLeaderboardSchema.safeParse(publicBoard).success).toBe(true);
  });
  it.each(['normal', 'hard'])('the public board rejects a runId in %s', (m) => {
    const b = structuredClone(publicBoard);
    b[m].today.push({ rank: 1, callSign: 'x', shiftsCompleted: 1, totalProductM3: 1, endedAt: 1, runId: R });
    expect(PublicLeaderboardSchema.safeParse(b).success).toBe(false);
  });
  it('a board missing hard fails', () => {
    const { hard: _h, ...noHard } = publicBoard;
    expect(PublicLeaderboardSchema.safeParse(noHard).success).toBe(false);
  });
});

describe('RunRankSchema', () => {
  it('accepts today: null', () => {
    expect(RunRankSchema.safeParse({ runId: R, allTime: 3, today: null }).success).toBe(true);
  });
});

describe('ServerMsgSchema', () => {
  it('parses rank and shiftReport messages', () => {
    expect(ServerMsgSchema.safeParse({ t: 'rank', allTime: 57, today: null }).success).toBe(true);
    expect(ServerMsgSchema.safeParse({ t: 'shiftReport', report }).success).toBe(true);
  });
});

describe('contract fixtures', () => {
  const schemas: Record<string, { parse: (v: unknown) => unknown }> = {
    'shift-report.json': ShiftReportSchema,
    'run-result.json': RunResultSchema,
    'leaderboard.json': LeaderboardSchema,
    'run-rank.json': RunRankSchema,
  };
  it('has all four fixture files', () => {
    expect(readdirSync(dir).sort()).toEqual(Object.keys(schemas).sort());
  });
  it.each(Object.keys(schemas))('%s parses with its schema', (name) => {
    expect(() => schemas[name]!.parse(load(name))).not.toThrow();
  });
});
