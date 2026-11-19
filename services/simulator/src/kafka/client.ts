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
  // Messages are keyed by sensorId. Kafka hashes the key to pick a partition, so
  // one sensor's readings always land in one partition and stay in order, while
  // the 6 partitions let Flink process different sensors in parallel.
  // ~108 msgs/s is the bulk of all traffic, so on a shared server it gets tight
  // limits: 24 h, and at most 256 MiB per partition (6 x 256 MiB ~ 1.5 GiB total);
  // whichever limit is hit first deletes the oldest segments.
  {
    base: TOPICS.telemetry,
    numPartitions: 6,
    configEntries: [
      LOG_APPEND_TIME,
      { name: 'retention.ms', value: '86400000' },
      { name: 'retention.bytes', value: '268435456' },
    ],
  },
  // 1 partition = one total order for operator actions; replaying them
  // reproduces the same plant history.
  { base: TOPICS.commands, numPartitions: 1 },
  { base: TOPICS.events, numPartitions: 1, configEntries: [LOG_APPEND_TIME] },
  // Status is only interesting while fresh, so expire it after 1 hour.
  {
    base: TOPICS.status,
    numPartitions: 1,
    configEntries: [LOG_APPEND_TIME, { name: 'retention.ms', value: '3600000' }],
  },
  // Compaction keeps only the latest value per key (the plant key), so this
  // topic holds the current state: the career save, never deleted by age.
  { base: TOPICS.state, numPartitions: 1, configEntries: [{ name: 'cleanup.policy', value: 'compact' }] },
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
