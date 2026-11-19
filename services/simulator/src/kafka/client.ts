import pkg from '@confluentinc/kafka-javascript';
import { TOPICS } from '@desal/schema';

// The package exposes a KafkaJS-compatible API under `.KafkaJS`; the native
// librdkafka client underneath is what actually talks to the broker.
const { Kafka } = pkg.KafkaJS;
type KafkaInstance = InstanceType<typeof Kafka>;

/**
 * Integration tests set DESAL_TOPIC_SUFFIX to a unique value so they create
 * throwaway topics instead of touching the real career topics.
 */
export function topicName(base: string): string {
  return base + (process.env.DESAL_TOPIC_SUFFIX ?? '');
}

export function createKafka(brokers: string = process.env.KAFKA_BROKERS ?? 'localhost:9092'): KafkaInstance {
  // clientId shows up in broker logs and Kafka UI, handy for spotting who is connected.
  return new Kafka({ kafkaJS: { brokers: brokers.split(','), clientId: 'desal-sim' } });
}

interface TopicSpec {
  base: string;
  numPartitions: number;
  configEntries?: { name: string; value: string }[];
}

const SPECS: TopicSpec[] = [
  // Messages are keyed by sensorId. Kafka hashes the key to pick a partition, so
  // one sensor's readings always land in one partition and stay in order, while
  // the 6 partitions let Flink process different sensors in parallel.
  { base: TOPICS.telemetry, numPartitions: 6 },
  // 1 partition = one total order for operator actions; replaying them
  // reproduces the same plant history.
  { base: TOPICS.commands, numPartitions: 1 },
  { base: TOPICS.events, numPartitions: 1 },
  // Status is only interesting while fresh, so expire it after 1 hour.
  { base: TOPICS.status, numPartitions: 1, configEntries: [{ name: 'retention.ms', value: '3600000' }] },
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
