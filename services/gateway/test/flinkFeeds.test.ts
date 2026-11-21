import { TOPICS, type Leaderboard, type RunRank, type ShiftReport } from '@desal/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { FlinkFeeds } from '../src/flinkFeeds.js';
import { topicName, type KafkaInstance } from '../src/kafka.js';
import { board, GAME_A, report, RUN_A } from './fixtures.js';

type Message = { key: Buffer | null; value: Buffer | null; offset: string };
type EachMessage = (p: { topic: string; partition: number; message: Message }) => Promise<void>;

const REPORTS = topicName(TOPICS.shiftReports);
const BOARD = topicName(TOPICS.leaderboard);
const RANKS = topicName(TOPICS.runRanks);

/** A fake Kafka client: records how the consumer is set up and lets the test push records. */
function fakeKafka() {
  const state = {
    config: undefined as unknown,
    subscribed: [] as string[],
    seeks: [] as { topic: string; partition: number; offset: string }[],
    deletedGroups: [] as string[],
    disconnected: false,
    eachMessage: undefined as EachMessage | undefined,
  };
  const kafka = {
    consumer(config: unknown) {
      state.config = config;
      return {
        connect: async () => {},
        subscribe: async ({ topics }: { topics: string[] }) => void state.subscribed.push(...topics),
        run: async ({ eachMessage }: { eachMessage: EachMessage }) => void (state.eachMessage = eachMessage),
        seek: (s: { topic: string; partition: number; offset: string }) => void state.seeks.push(s),
        assignment: () => [],
        disconnect: async () => void (state.disconnected = true),
      };
    },
    admin() {
      return {
        connect: async () => {},
        disconnect: async () => {},
        // shift.reports has two partitions with records; the compacted topics one each.
        fetchTopicOffsets: async (t: string) =>
          t === REPORTS
            ? [
                { partition: 0, high: '40', low: '0', offset: '40' },
                { partition: 1, high: '7', low: '0', offset: '7' },
              ]
            : [{ partition: 0, high: '3', low: '0', offset: '3' }],
        deleteGroups: async (ids: string[]) => void state.deletedGroups.push(...ids),
      };
    },
  };
  return { kafka: kafka as unknown as KafkaInstance, state };
}

let fake: ReturnType<typeof fakeKafka>;
let feeds: FlinkFeeds;
let reports: [string, ShiftReport][];
let boards: Leaderboard[];
let ranks: RunRank[];
let gone: string[];
let logs: string[];
let offset: number;

function push(topic: string, key: string | null, value: unknown): Promise<void> {
  const raw = value === null ? null : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return fake.state.eachMessage!({ topic, partition: 0, message: { key: key === null ? null : Buffer.from(key), value: raw, offset: String(offset++) } });
}

beforeEach(async () => {
  fake = fakeKafka();
  reports = [];
  boards = [];
  ranks = [];
  gone = [];
  logs = [];
  offset = 0;
  feeds = new FlinkFeeds(fake.kafka, {
    onReport: (gameId, r) => reports.push([gameId, r]),
    onBoard: (b) => boards.push(b),
    onRank: (r) => ranks.push(r),
    onRankDeleted: (runId) => gone.push(runId),
    log: (m) => logs.push(m),
  });
  await feeds.start();
});

describe('FlinkFeeds', () => {
  it('uses its own throwaway group: compacted topics from the beginning, shift.reports from its end', () => {
    expect(fake.state.config).toEqual({
      kafkaJS: { groupId: expect.stringMatching(/^desal-gateway-flink-[0-9a-f-]{36}$/), fromBeginning: true, autoCommit: false },
    });
    expect(feeds.groupId).toMatch(/^desal-gateway-flink-/);
    expect(fake.state.subscribed.sort()).toEqual([REPORTS, BOARD, RANKS].sort());
    expect(fake.state.seeks).toEqual([
      { topic: REPORTS, partition: 0, offset: '40' },
      { topic: REPORTS, partition: 1, offset: '7' },
    ]);
  });

  it('skips a non-JSON and a schema-invalid shift report, then delivers the next valid one', async () => {
    await push(REPORTS, GAME_A, '{not json');
    await push(REPORTS, GAME_A, { ...report(1), grade: 'Z' });
    await push(REPORTS, 'not-a-game-id', report(1));
    await push(REPORTS, GAME_A, report(2));
    expect(reports).toEqual([[GAME_A, report(2)]]);
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatch(/non-JSON/);
  });

  it('delivers a valid leaderboard and skips an invalid one', async () => {
    await push(BOARD, 'board', { online: 'many' });
    await push(BOARD, 'board', board());
    expect(boards).toEqual([board()]);
    expect(logs).toHaveLength(1);
  });

  it('delivers ranks, and passes a run.ranks tombstone as a delete', async () => {
    await push(RANKS, RUN_A, { runId: RUN_A, allTime: 0, today: null }); // allTime must be >= 1
    await push(RANKS, RUN_A, { runId: RUN_A, allTime: 5, today: 2 });
    await push(RANKS, RUN_A, null);
    expect(ranks).toEqual([{ runId: RUN_A, allTime: 5, today: 2 }]);
    expect(gone).toEqual([RUN_A]);
    expect(logs).toHaveLength(1);
  });

  it('ignores tombstones on the other topics', async () => {
    await push(REPORTS, GAME_A, null);
    await push(BOARD, 'board', null);
    expect(reports).toEqual([]);
    expect(boards).toEqual([]);
    expect(gone).toEqual([]);
  });

  it('stop() disconnects and deletes the group', async () => {
    await feeds.stop();
    expect(fake.state.disconnected).toBe(true);
    expect(fake.state.deletedGroups).toEqual([feeds.groupId]);
  });
});
