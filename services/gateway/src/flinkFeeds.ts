import { randomUUID } from 'node:crypto';
import { LeaderboardSchema, RunRankSchema, ShiftReportSchema, TOPICS, type Leaderboard, type RunRank, type ShiftReport } from '@desal/schema';
import { z } from 'zod';
import { topicName, type KafkaInstance } from './kafka.js';

export interface FlinkFeedsOptions {
  /** A shift report card for the game `gameId` (the shift.reports record key). */
  onReport(gameId: string, report: ShiftReport): void;
  /** The latest leaderboard (one record, key "board"). */
  onBoard(board: Leaderboard): void;
  /** A run's rank, new or changed. */
  onRank(rank: RunRank): void;
  /** A tombstone on run.ranks: the run has no rank any more. */
  onRankDeleted(runId: string): void;
  log?: (msg: string) => void;
}

const GameIdSchema = z.uuid();

type Feed = 'reports' | 'board' | 'ranks';

/**
 * The gateway's view of what the Flink jobs produce: shift report cards (shift.reports), the
 * leaderboard and every run's rank (run.ranks). Separate from GatewayKafka on purpose: the game
 * never needs Flink, so this consumer may fail to start (or the topics stay empty) without the
 * gateway noticing beyond a log line.
 */
export class FlinkFeeds {
  /**
   * Like GatewayKafka: every gateway instance needs every record, so each gets its own random
   * group, never reused (deleted on stop), hence no committed offsets either.
   */
  readonly groupId = `desal-gateway-flink-${randomUUID()}`;
  private readonly log: (msg: string) => void;
  private readonly consumer;
  private opened = false;

  constructor(
    private readonly kafka: KafkaInstance,
    private readonly opts: FlinkFeedsOptions,
  ) {
    this.log = opts.log ?? ((m) => console.log(`[gateway] ${m}`));
    // fromBeginning: leaderboard and run.ranks are compacted (the latest value per key), so reading
    // them from the start rebuilds the cache after a restart. shift.reports is seeked to its end in
    // start(): an old report card is of no use to a connected player.
    this.consumer = kafka.consumer({ kafkaJS: { groupId: this.groupId, fromBeginning: true, autoCommit: false } });
  }

  async start(): Promise<void> {
    const feeds = new Map<string, Feed>([
      [topicName(TOPICS.shiftReports), 'reports'],
      [topicName(TOPICS.leaderboard), 'board'],
      [topicName(TOPICS.runRanks), 'ranks'],
    ]);
    const reportsTopic = topicName(TOPICS.shiftReports);
    const reportEnds = await this.endOffsets(reportsTopic);
    this.opened = true;
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: [...feeds.keys()] });
    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        const feed = feeds.get(topic);
        const key = message.key?.toString();
        if (!feed || key === undefined) return;
        this.handle(feed, topic, key, message.value, message.offset);
      },
    });
    // As in GatewayKafka: the end offsets captured before subscribing, applied on assignment.
    for (const p of reportEnds) this.consumer.seek({ topic: reportsTopic, ...p });
  }

  /** Disconnects and deletes this instance's consumer group, also after a failed start(). Never rejects. */
  async stop(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    await this.consumer.disconnect().catch((e: unknown) => this.log(`flink feeds: consumer disconnect failed: ${String(e)}`));
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.deleteGroups([this.groupId]);
    } catch (e) {
      this.log(`deleting group ${this.groupId} failed: ${String(e)}`);
    } finally {
      await admin.disconnect().catch(() => {});
    }
  }

  private handle(feed: Feed, topic: string, key: string, raw: Buffer | null, offset: string): void {
    if (raw === null) {
      // A tombstone. Only run.ranks deletes keys; the others are never tombstoned by the jobs.
      if (feed === 'ranks') this.opts.onRankDeleted(key);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      this.log(`flink feeds: skipping a non-JSON record on ${topic} at offset ${offset}`);
      return;
    }
    const skip = (why: string) => this.log(`flink feeds: skipping an invalid record on ${topic} at offset ${offset}: ${why}`);
    const firstIssue = (e: z.ZodError) => `${e.issues[0]?.path.join('.') || 'value'}: ${e.issues[0]?.message}`;
    if (feed === 'reports') {
      const r = ShiftReportSchema.safeParse(value);
      if (!GameIdSchema.safeParse(key).success) return skip('key is not a gameId');
      if (!r.success) return skip(firstIssue(r.error));
      this.opts.onReport(key, r.data);
    } else if (feed === 'board') {
      const r = LeaderboardSchema.safeParse(value);
      if (!r.success) return skip(firstIssue(r.error));
      this.opts.onBoard(r.data);
    } else {
      const r = RunRankSchema.safeParse(value);
      if (!r.success) return skip(firstIssue(r.error));
      this.opts.onRank(r.data);
    }
  }

  private async endOffsets(topic: string): Promise<{ partition: number; offset: string }[]> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      return (await admin.fetchTopicOffsets(topic)).map((o) => ({ partition: o.partition, offset: o.high }));
    } finally {
      await admin.disconnect();
    }
  }
}
