import { randomUUID } from 'node:crypto';
import { PLANT_KEY, TOPICS } from '@desal/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createInitialState } from '../../src/state.js';

// Each test gets its own topic suffix (set before anything calls topicName, which
// reads the env var at call time), so tests never see each other's records or the
// real career topics.
const RUN = `.test-${Date.now()}`;
let n = 0;
process.env.DESAL_TOPIC_SUFFIX = RUN;

const { createKafka, ensureTopics, topicName } = await import('../../src/kafka/client.js');
const { SimRunner, loadCareer } = await import('../../src/kafka/runner.js');

const kafka = createKafka();
const admin = kafka.admin();
const producer = kafka.producer();
const created: string[] = [];
const consumers: { disconnect(): Promise<void> }[] = [];
const collectGroups: string[] = [];

beforeAll(async () => {
  await admin.connect();
  await producer.connect();
});

beforeEach(async () => {
  process.env.DESAL_TOPIC_SUFFIX = `${RUN}-${++n}`;
  // Record first, so a half-failed creation still gets cleaned up.
  created.push(...Object.values(TOPICS).map(topicName));
  await ensureTopics(kafka);
});

afterAll(async () => {
  await Promise.allSettled(consumers.map((c) => c.disconnect()));
  await producer.disconnect();
  // Best effort: a failed cleanup must not fail the run.
  await admin.deleteTopics({ topics: created }).catch(() => {});
  // Drop the runners' suffixed commands groups (desal-sim<suffix>) and the collector
  // groups, so nothing from the test run lingers in Kafka UI.
  const groups = Array.from({ length: n }, (_, i) => `desal-sim${RUN}-${i + 1}`);
  await admin.deleteGroups([...groups, ...collectGroups]).catch(() => {});
  await admin.disconnect();
});

/** Collects every record of a topic (from the beginning) into an array that fills in the background. */
async function collect<T = Record<string, unknown>>(base: string): Promise<T[]> {
  const out: T[] = [];
  // Throwaway group + fromBeginning: read the whole topic without disturbing anyone's offsets.
  // autoCommit off: the group stores no offsets (it is deleted in afterAll).
  const groupId = `test-collect-${randomUUID()}`;
  collectGroups.push(groupId);
  const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: true, autoCommit: false } });
  consumers.push(consumer);
  await consumer.connect();
  await consumer.subscribe({ topics: [topicName(base)] });
  await consumer.run({
    eachMessage: async ({ message }) => {
      out.push(JSON.parse(String(message.value)) as T);
    },
  });
  return out;
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function sendCommand(value: string): Promise<void> {
  await producer.send({ topic: topicName(TOPICS.commands), messages: [{ key: PLANT_KEY, value }] });
}

const startShift = (shiftId: number | null = null) =>
  JSON.stringify({ commandId: randomUUID(), issuedAt: Date.now(), shiftId, command: { type: 'startShift', mode: 'auto' } });

type Status = { phase: string; tick: number; shiftId: number | null };
type Event = { type: string; reason?: string };
type Reading = { sensorId: string };

describe('SimRunner + Kafka', () => {
  it('fresh start: startShift auto → running status, heater.tbtC telemetry, one shiftStart within 5 s', async () => {
    const status = await collect<Status>(TOPICS.status);
    const telemetry = await collect<Reading>(TOPICS.telemetry);
    const events = await collect<Event>(TOPICS.events);
    const runner = new SimRunner(kafka, createInitialState(42, Date.now()), { log: () => {} });
    await runner.start();
    try {
      await sendCommand(startShift());
      const t0 = Date.now();
      await waitFor(
        () =>
          status.some((s) => s.phase === 'running') &&
          telemetry.some((r) => r.sensorId === 'heater.tbtC') &&
          events.some((e) => e.type === 'shiftStart'),
        5000,
        'running status, heater.tbtC reading and shiftStart',
      );
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(events.filter((e) => e.type === 'shiftStart')).toHaveLength(1);
    } finally {
      await runner.stop();
    }
  });

  it('resume: a new runner continues from the last snapshot with the same shift and no second shiftStart', async () => {
    const events = await collect<Event>(TOPICS.events);
    const status = await collect<Status>(TOPICS.status);
    const r1 = new SimRunner(kafka, createInitialState(7, Date.now()), { tickMs: 50, log: () => {} });
    await r1.start();
    await sendCommand(startShift());
    await waitFor(() => r1.state.tick >= 40, 30_000, '40 ticks');
    const shiftId = r1.state.shift?.id;
    // No final snapshot: simulate a crash, so the career resumes from the periodic snapshot.
    await r1.stop({ finalSnapshot: false });

    const career = await loadCareer(kafka);
    expect(career.kind).toBe('found');
    if (career.kind !== 'found') return;
    expect(career.state.tick).toBeGreaterThanOrEqual(30);
    expect(career.state.shift?.id).toBe(shiftId);

    const r2 = new SimRunner(kafka, career.state, { tickMs: 50, log: () => {} });
    await r2.start();
    try {
      await waitFor(() => r2.state.tick >= career.state.tick + 5, 10_000, 'r2 ticking');
      await waitFor(() => status.some((s) => s.tick >= career.state.tick + 5), 10_000, 'r2 status');
    } finally {
      await r2.stop();
    }
    expect(r2.state.shift?.id).toBe(shiftId);
    expect(status.filter((s) => s.tick > career.state.tick).every((s) => s.shiftId === shiftId)).toBe(true);
    expect(events.filter((e) => e.type === 'shiftStart')).toHaveLength(1);
  });

  it('loadCareer: empty plant.state → none, quickly', async () => {
    const t0 = Date.now();
    expect(await loadCareer(kafka)).toEqual({ kind: 'none' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('corrupt: garbage on plant.state for the plant key → loadCareer returns corrupt', async () => {
    await producer.send({ topic: topicName(TOPICS.state), messages: [{ key: PLANT_KEY, value: '{not json' }] });
    const career = await loadCareer(kafka);
    expect(career.kind).toBe('corrupt');
    if (career.kind === 'corrupt') expect(career.reason).toMatch(/invalid JSON/);
  });

  it('fallback: a good save followed by garbage → loadCareer returns the good save and reports the skip', async () => {
    const good = { ...createInitialState(5, Date.now()), tick: 42 };
    const { serialize } = await import('../../src/snapshot.js');
    await producer.send({ topic: topicName(TOPICS.state), messages: [{ key: PLANT_KEY, value: serialize(good) }] });
    await producer.send({ topic: topicName(TOPICS.state), messages: [{ key: PLANT_KEY, value: '{not json' }] });
    const career = await loadCareer(kafka);
    expect(career.kind).toBe('found');
    if (career.kind !== 'found') return;
    expect(career.state.tick).toBe(42);
    expect(career.skipped).toHaveLength(1);
    expect(career.skipped[0]!.reason).toMatch(/invalid JSON/);
  });

  it('bad command: {"nonsense":true} → commandRejected, and the runner keeps ticking', async () => {
    const events = await collect<Event>(TOPICS.events);
    const runner = new SimRunner(kafka, createInitialState(3, Date.now()), { tickMs: 100, log: () => {} });
    await runner.start();
    try {
      await sendCommand(startShift());
      await waitFor(() => runner.state.phase === 'running', 10_000, 'shift start');
      await sendCommand('{"nonsense":true}');
      await sendCommand('not json at all');
      await waitFor(() => events.filter((e) => e.type === 'commandRejected').length >= 2, 10_000, 'commandRejected');
      const tick = runner.state.tick;
      await waitFor(() => runner.state.tick >= tick + 5, 10_000, 'more ticks');
      expect(runner.kafkaDown).toBe(false);
    } finally {
      await runner.stop();
    }
  });
});
