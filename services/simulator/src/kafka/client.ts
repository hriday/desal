import pkg from '@confluentinc/kafka-javascript';
import { TOPICS } from '@desal/schema';

// The package exposes a KafkaJS-compatible API under `.KafkaJS`; the native
// librdkafka client underneath is what actually talks to the broker.
const { Kafka, logLevel } = pkg.KafkaJS;
export type KafkaInstance = InstanceType<typeof Kafka>;

/**
 * Integration tests set DESAL_TOPIC_SUFFIX to a unique value so they create
 * throwaway topics instead of touching the real game topics.
 */
export function topicName(base: string): string {
  return base + (process.env.DESAL_TOPIC_SUFFIX ?? '');
}

export function createKafka(brokers: string = process.env.KAFKA_BROKERS ?? 'localhost:9092'): KafkaInstance {
  // clientId shows up in broker logs and Kafka UI, handy for spotting who is connected.
  return new Kafka({
    // WARN: keep connect/rebalance chatter (INFO) out of the CLI output.
    kafkaJS: { brokers: brokers.split(','), clientId: 'desal-sim', logLevel: logLevel.WARN },
    // The broker advertises "localhost", which resolves to ::1 first, but Docker
    // only publishes the port on 127.0.0.1: stick to IPv4 to skip refused dials.
    'broker.address.family': 'v4',
  });
}

interface TopicSpec {
  base: string;
  numPartitions: number;
  configEntries?: { name: string; value: string }[];
}

// CreateTime vs LogAppendTime: by default (CreateTime) a record's timestamp is
// whatever the producer says. Our producer's clock is *plant* time, which runs 40x
// faster than real time and can pause, so as a Kafka timestamp it would break
// time-based retention (records "from the future" never expire) and Kafka 4 even
// rejects timestamps >1 h ahead. LogAppendTime makes the broker stamp wall-clock
// append time instead, so retention works normally. Event time belongs in the
// payload: every record carries a `plantTime` field, and that is what Flink will
// use as event time (with watermarks), not the Kafka timestamp.
const LOG_APPEND_TIME = { name: 'message.timestamp.type', value: 'LogAppendTime' };

const SPECS: TopicSpec[] = [
  // Every topic is keyed by gameId. Kafka hashes the key to pick a partition, so all
  // of one game's readings land in one partition, in order, while the 6 partitions
  // let Flink (keyBy(gameId)) process different games in parallel.
  // ~108 msgs/s per game is the bulk of all traffic, so on a shared server it gets
  // tight limits: 24 h, and at most 256 MiB per partition (6 x 256 MiB ~ 1.5 GiB
  // total); whichever limit is hit first deletes the oldest segments.
  {
    base: TOPICS.telemetry,
    numPartitions: 6,
    configEntries: [
      LOG_APPEND_TIME,
      { name: 'retention.ms', value: '86400000' },
      { name: 'retention.bytes', value: '268435456' },
    ],
  },
  // 1 partition = one total order for operator actions across all games;
  // replaying them reproduces the same plant histories.
  { base: TOPICS.commands, numPartitions: 1 },
  { base: TOPICS.events, numPartitions: 1, configEntries: [LOG_APPEND_TIME] },
  // Status is only interesting while fresh, so expire it after 1 hour.
  {
    base: TOPICS.status,
    numPartitions: 1,
    configEntries: [LOG_APPEND_TIME, { name: 'retention.ms', value: '3600000' }],
  },
  // Compaction keeps only the latest value per key (gameId), so this topic holds the
  // latest save of every live game, never deleted by age. An ended game gets a
  // tombstone (null value): compaction then drops its older saves, and the tombstone
  // itself after delete.retention.ms (default 24 h, so slow readers still see the delete).
  //
  // The cleaner never touches the active segment, and skips a log until its dirty
  // (not yet compacted) share exceeds min.cleanable.dirty.ratio (default 0.5). Rolling
  // segments hourly with a 0.1 ratio gets old snapshots and tombstones compacted
  // within about an hour instead of piling up for days.
  {
    base: TOPICS.state,
    numPartitions: 1,
    configEntries: [
      { name: 'cleanup.policy', value: 'compact' },
      { name: 'segment.ms', value: '3600000' },
      { name: 'min.cleanable.dirty.ratio', value: '0.1' },
    ],
  },
];

/**
 * Creates any missing topics; safe to call repeatedly.
 *
 * It does not reconcile the configs of topics that already exist: this client's
 * KafkaJS-compatible admin has no alterConfigs/describeConfigs. To fix an existing
 * topic, use the broker CLI, e.g.
 *   docker exec desal-kafka /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:9092 \
 *     --entity-type topics --entity-name plant.telemetry --alter \
 *     --add-config message.timestamp.type=LogAppendTime,retention.ms=86400000,retention.bytes=268435456
 * and for a plant.state created before Plan 2 (prompt compaction of snapshots and tombstones):
 *   docker exec desal-kafka /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:9092 \
 *     --entity-type topics --entity-name plant.state --alter \
 *     --add-config segment.ms=3600000,min.cleanable.dirty.ratio=0.1
 */
export async function ensureTopics(kafka: KafkaInstance): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    // createTopics resolves false (no throw) when topics already exist, so a
    // second call is a harmless no-op. replicationFactor 1 = single local broker.
    await admin.createTopics({
      topics: SPECS.map((s) => ({
        topic: topicName(s.base),
        numPartitions: s.numPartitions,
        replicationFactor: 1,
        configEntries: s.configEntries,
      })),
    });
  } finally {
    await admin.disconnect();
  }
}

export interface WaitForTopicsOptions {
  timeoutMs?: number;
  intervalMs?: number;
  log?: (msg: string) => void;
}

/**
 * Waits until every topic is usable: its metadata lists all partitions with a leader, and its
 * offsets can be fetched.
 *
 * createTopics returns once the controller has accepted the topics, but each broker's metadata
 * cache catches up a moment later. Reading or subscribing in that window fails with
 * ERR_UNKNOWN_TOPIC_OR_PART (seen on a fresh deploy), so startup retries here, bounded, instead of
 * exiting. Throws only once timeoutMs has passed.
 */
export async function waitForTopics(
  kafka: KafkaInstance,
  { timeoutMs = 30_000, intervalMs = 500, log = () => {} }: WaitForTopicsOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const admin = kafka.admin();
  await admin.connect();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const meta = await admin.fetchTopicMetadata({ topics: SPECS.map((s) => topicName(s.base)) });
        for (const spec of SPECS) {
          const name = topicName(spec.base);
          const ready = meta.find((m) => m.name === name)?.partitions.filter((p) => p.leader >= 0).length ?? 0;
          if (ready < spec.numPartitions) throw new Error(`${name}: ${ready}/${spec.numPartitions} partitions ready`);
          await admin.fetchTopicOffsets(name);
        }
        if (attempt > 1) log('topic metadata ready');
        return;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (Date.now() >= deadline) throw new Error(`topics not ready after ${timeoutMs} ms: ${why}`);
        if (attempt === 1) log(`waiting for topic metadata (${why})`);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  } finally {
    await admin.disconnect();
  }
}
