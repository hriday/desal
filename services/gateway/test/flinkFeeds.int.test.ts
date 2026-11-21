import { TOPICS, type Leaderboard, type RunRank, type ShiftReport } from '@desal/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { board, GAME_A, GAME_B, report, RUN_A, RUN_B } from './fixtures.js';

// Throwaway topics for this run (set before anything calls topicName), as in kafka.int.test.ts.
process.env.DESAL_TOPIC_SUFFIX = `.test-gw-flink-${Date.now()}`;
const { createKafka, topicName } = await import('../src/kafka.js');
const { FlinkFeeds } = await import('../src/flinkFeeds.js');

const kafka = createKafka();
const admin = kafka.admin();
const producer = kafka.producer();
const REPORTS = topicName(TOPICS.shiftReports);
const BOARD = topicName(TOPICS.leaderboard);
const RANKS = topicName(TOPICS.runRanks);
const topics = [REPORTS, BOARD, RANKS];
let feeds: InstanceType<typeof FlinkFeeds> | undefined;

beforeAll(async () => {
  await admin.connect();
  await producer.connect();
  // The simulator owns topic creation; here the test stands in for it.
  await admin.createTopics({ topics: topics.map((topic) => ({ topic, numPartitions: topic === REPORTS ? 3 : 1, replicationFactor: 1 })) });
});

afterAll(async () => {
  await feeds?.stop();
  await producer.disconnect();
  await admin.deleteTopics({ topics }).catch(() => {});
  await admin.disconnect();
});

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const send = (topic: string, key: string, value: unknown) =>
  producer.send({ topic, messages: [{ key, value: value === null ? null : JSON.stringify(value) }] });

describe('FlinkFeeds', () => {
  it('rebuilds board and ranks from the beginning, sees only new reports, and passes tombstones', async () => {
    // Before start: the compacted topics' records must be read, the old report must not.
    await send(BOARD, 'board', board());
    await send(RANKS, RUN_A, { runId: RUN_A, allTime: 4, today: 1 });
    await send(REPORTS, GAME_A, report(1));

    const reports: [string, ShiftReport][] = [];
    const boards: Leaderboard[] = [];
    const ranks: RunRank[] = [];
    const gone: string[] = [];
    feeds = new FlinkFeeds(kafka, {
      onReport: (g, r) => reports.push([g, r]),
      onBoard: (b) => boards.push(b),
      onRank: (r) => ranks.push(r),
      onRankDeleted: (id) => gone.push(id),
      log: () => {},
    });
    await feeds.start();

    await send(REPORTS, GAME_B, report(2));
    await send(RANKS, RUN_B, { runId: RUN_B, allTime: 9, today: null });
    await send(RANKS, RUN_A, null);

    await waitFor(() => reports.length >= 1 && boards.length >= 1 && ranks.length >= 2 && gone.length >= 1, 30_000, 'all feeds');
    await new Promise((r) => setTimeout(r, 500)); // the pre-start report does not trickle in
    expect(reports).toEqual([[GAME_B, report(2)]]);
    expect(boards).toEqual([board()]);
    expect(ranks).toEqual([
      { runId: RUN_A, allTime: 4, today: 1 },
      { runId: RUN_B, allTime: 9, today: null },
    ]);
    expect(gone).toEqual([RUN_A]);

    await feeds.stop();
    expect((await admin.listGroups()).groups.map((g) => g.groupId)).not.toContain(feeds.groupId);
  });
});
