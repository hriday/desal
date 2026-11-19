import { randomUUID } from 'node:crypto';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { KafkaInstance } from './client.js';

export interface ReadRecord {
  partition: number;
  offset: number;
  key: string | null;
  value: string | null;
}

export interface ReadOptions {
  /** Only the last record of each partition (e.g. "the latest status"). */
  lastOnly?: boolean;
  /** Give up after this long (ms); the read normally ends as soon as it reaches the end. */
  timeoutMs?: number;
}

/**
 * Reads a topic from the beginning up to its end *as of the call*, then stops.
 *
 * Kafka topics never "end", so we capture each partition's high-water mark (the
 * offset the next record will get) first and stop once every partition has
 * delivered offset high-1. Records produced after that are not waited for.
 */
export async function readToEnd(
  kafka: KafkaInstance,
  topic: string,
  { lastOnly = false, timeoutMs = 30_000 }: ReadOptions = {},
): Promise<ReadRecord[]> {
  const admin = kafka.admin();
  await admin.connect();
  let offsets: { partition: number; low: string; high: string }[];
  try {
    offsets = await admin.fetchTopicOffsets(topic);
  } finally {
    await admin.disconnect();
  }
  // low = first offset still stored (older ones deleted/compacted), high = next offset.
  // Partitions with high <= low are empty; an all-empty topic returns at once.
  const pending = new Map<number, number>();
  for (const o of offsets) {
    const low = Number(o.low);
    const high = Number(o.high);
    if (high > low) pending.set(o.partition, high - 1);
  }
  if (pending.size === 0) return [];

  // A throwaway group id: this one-off reader must never share (or commit)
  // offsets with a real consumer group. autoCommit off = it leaves no trace.
  const consumer: KafkaJS.Consumer = kafka.consumer({
    kafkaJS: { groupId: `desal-read-${randomUUID()}`, fromBeginning: true, autoCommit: false },
  });
  const out: ReadRecord[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  await consumer.connect();
  try {
    await consumer.subscribe({ topics: [topic] });
    await consumer.run({
      eachMessage: async ({ partition, message }) => {
        const last = pending.get(partition);
        const offset = Number(message.offset);
        if (last === undefined || offset > last) return;
        if (!lastOnly || offset === last) {
          out.push({ partition, offset, key: message.key?.toString() ?? null, value: message.value?.toString() ?? null });
        }
        if (offset === last) {
          pending.delete(partition);
          if (pending.size === 0) finish();
        }
      },
    });
    if (lastOnly) {
      // seek() before the partition is assigned is remembered and applied on
      // assignment, so we jump straight to the last record instead of reading all.
      for (const [partition, last] of pending) consumer.seek({ topic, partition, offset: String(last) });
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out reading ${topic} to its end`)), timeoutMs);
    });
    try {
      await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await consumer.disconnect();
  }
  return out;
}
