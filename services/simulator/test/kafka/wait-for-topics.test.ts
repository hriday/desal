import { describe, expect, it } from 'vitest';
import { waitForTopics, type KafkaInstance } from '../../src/kafka/client.js';

/** A fake admin whose metadata calls fail `failures` times (like a fresh topic), then succeed. */
function fakeKafka(failures: number) {
  const calls = { metadata: 0, connect: 0, disconnect: 0 };
  const admin = {
    async connect() {
      calls.connect++;
    },
    async disconnect() {
      calls.disconnect++;
    },
    async fetchTopicMetadata({ topics }: { topics: string[] }) {
      calls.metadata++;
      if (calls.metadata <= failures) {
        throw Object.assign(new Error('Broker: Unknown topic or partition'), { code: 3 });
      }
      // Every topic with 6 led partitions: enough for every spec.
      return topics.map((name) => ({ name, partitions: Array.from({ length: 6 }, (_, partitionId) => ({ partitionId, leader: 1 })) }));
    },
    async fetchTopicOffsets() {
      return [{ partition: 0, low: '0', high: '0', offset: '0' }];
    },
  };
  return { kafka: { admin: () => admin } as unknown as KafkaInstance, calls };
}

describe('waitForTopics', () => {
  it('retries through ERR_UNKNOWN_TOPIC_OR_PART and resolves once metadata is ready', async () => {
    const { kafka, calls } = fakeKafka(2);
    const logs: string[] = [];
    await waitForTopics(kafka, { timeoutMs: 5000, intervalMs: 5, log: (m) => logs.push(m) });
    expect(calls.metadata).toBe(3);
    expect(logs[0]).toMatch(/waiting for topic metadata.*Unknown topic/);
    expect(logs.at(-1)).toMatch(/ready/);
    expect(calls.disconnect).toBe(calls.connect);
  });

  it('throws once timeoutMs has passed, and still disconnects', async () => {
    const { kafka, calls } = fakeKafka(Number.POSITIVE_INFINITY);
    const t0 = Date.now();
    await expect(waitForTopics(kafka, { timeoutMs: 100, intervalMs: 10 })).rejects.toThrow(/not ready after 100 ms.*Unknown topic/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(calls.metadata).toBeGreaterThan(2);
    expect(calls.disconnect).toBe(1);
  });
});
