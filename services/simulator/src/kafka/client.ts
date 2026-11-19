import pkg from '@confluentinc/kafka-javascript';
import { TOPICS } from '@desal/schema';

// The package exposes a KafkaJS-compatible API under `.KafkaJS`; the native
// librdkafka client underneath is what actually talks to the broker.
const { Kafka, logLevel } = pkg.KafkaJS;
export type KafkaInstance = InstanceType<typeof Kafka>;

/**
 * Integration tests set DESAL_TOPIC_SUFFIX to a unique value so they create
 * throwaway topics instead of touching the real career topics.
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

// Records on these topics carry plant time as their Kafka timestamp (event time,
// which Flink will use). Plant time runs 40x faster than the wall clock, so it is
// soon hours ahead; Kafka 4 rejects timestamps more than 1 h in the future by
// default (message.timestamp.after.max.ms), so lift that limit per topic.
const ALLOW_FUTURE_TIMESTAMPS = { name: 'message.timestamp.after.max.ms', value: '9223372036854775807' };

const SPECS: TopicSpec[] = [
  // Messages are keyed by sensorId. Kafka hashes the key to pick a partition, so
  // one sensor's readings always land in one partition and stay in order, while
  // the 6 partitions let Flink process different sensors in parallel.
  { base: TOPICS.telemetry, numPartitions: 6, configEntries: [ALLOW_FUTURE_TIMESTAMPS] },
  // 1 partition = one total order for operator actions; replaying them
  // reproduces the same plant history.
  { base: TOPICS.commands, numPartitions: 1 },
  { base: TOPICS.events, numPartitions: 1, configEntries: [ALLOW_FUTURE_TIMESTAMPS] },
  // Status is only interesting while fresh, so expire it after 1 hour.
  // (Time-based retention compares against record timestamps, so with plant-time
  // timestamps a status record only expires 1 h after the wall clock reaches it.)
  {
    base: TOPICS.status,
    numPartitions: 1,
    configEntries: [{ name: 'retention.ms', value: '3600000' }, ALLOW_FUTURE_TIMESTAMPS],
  },
  // Compaction keeps only the latest value per key (the plant key), so this
  // topic holds the current state: the career save, never deleted by age.
  { base: TOPICS.state, numPartitions: 1, configEntries: [{ name: 'cleanup.policy', value: 'compact' }] },
];

/** Creates any missing topics; safe to call repeatedly. */
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
