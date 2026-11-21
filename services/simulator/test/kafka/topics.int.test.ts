import { execFileSync } from 'node:child_process';
import { TOPICS } from '@desal/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Unique suffix per run so this test never touches the real career topics.
// Must be set before client.ts reads it (topicName reads env at call time).
const SUFFIX = `.test-${Date.now()}`;
process.env.DESAL_TOPIC_SUFFIX = SUFFIX;

const { createKafka, ensureTopics, topicName } = await import('../../src/kafka/client.js');

const kafka = createKafka();
const admin = kafka.admin();

beforeAll(async () => {
  await admin.connect();
});

afterAll(async () => {
  await admin.deleteTopics({ topics: Object.values(TOPICS).map(topicName) });
  await admin.disconnect();
});

describe('ensureTopics', () => {
  it('is idempotent and creates all five topics with the right shape', async () => {
    await ensureTopics(kafka);
    await ensureTopics(kafka);

    const expected: Record<string, number> = {
      [TOPICS.telemetry]: 6,
      [TOPICS.commands]: 1,
      [TOPICS.events]: 1,
      [TOPICS.status]: 1,
      [TOPICS.state]: 1,
    };
    const meta = await admin.fetchTopicMetadata({ topics: Object.keys(expected).map(topicName) });
    expect(meta).toHaveLength(5);
    for (const [base, partitions] of Object.entries(expected)) {
      const t = meta.find((m) => m.name === topicName(base));
      expect(t?.partitions, base).toHaveLength(partitions);
    }
  });

  it('configures compaction, retention and LogAppendTime timestamps', () => {
    // The KafkaJS-compatible admin in @confluentinc/kafka-javascript has no
    // describeConfigs, so ask the broker's own CLI inside the container.
    const describe = (topic: string) =>
      execFileSync(
        'docker',
        [
          'exec', 'desal-kafka', '/opt/kafka/bin/kafka-configs.sh',
          '--bootstrap-server', 'localhost:9092',
          '--entity-type', 'topics', '--entity-name', topicName(topic), '--describe',
        ],
        { encoding: 'utf8' },
      );
    const state = describe(TOPICS.state);
    expect(state).toContain('cleanup.policy=compact');
    expect(state).toContain('segment.ms=3600000');
    expect(state).toContain('min.cleanable.dirty.ratio=0.1');
    expect(describe(TOPICS.status)).toContain('retention.ms=3600000');
    for (const t of [TOPICS.telemetry, TOPICS.status, TOPICS.events]) {
      expect(describe(t), t).toContain('message.timestamp.type=LogAppendTime');
    }
    const telemetry = describe(TOPICS.telemetry);
    expect(telemetry).toContain('retention.ms=86400000');
    expect(telemetry).toContain('retention.bytes=268435456');
    // One client could otherwise fill the disk through commands and the rejections they cause.
    const commands = describe(TOPICS.commands);
    expect(commands).toContain('retention.ms=86400000');
    expect(commands).toContain('retention.bytes=268435456');
    const events = describe(TOPICS.events);
    expect(events).toContain('retention.ms=604800000'); // 7 days, kept for Flink
    expect(events).toContain('retention.bytes=268435456');
  });
});
