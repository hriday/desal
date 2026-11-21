import { randomUUID } from 'node:crypto';
import { TOPICS } from '@desal/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GameHost } from '../../src/host.js';
import { serialize } from '../../src/snapshot.js';
import { createInitialState } from '../../src/state.js';

// Each test gets its own topic suffix (set before anything calls topicName, which
// reads the env var at call time), so tests never see each other's records or the
// real game topics.
const RUN = `.test-${Date.now()}`;
let n = 0;
process.env.DESAL_TOPIC_SUFFIX = RUN;

const { createKafka, ensureTopics, topicName, waitForTopics } = await import('../../src/kafka/client.js');
const { SimRunner, loadGames } = await import('../../src/kafka/runner.js');

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
  // Brand-new topics: wait for their metadata, as main() does (R3 startup race).
  await waitForTopics(kafka);
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

interface Rec<T> {
  key: string | null;
  value: T | null;
}

/** Collects every record of a topic (from the beginning) into an array that fills in the background. */
async function collect<T = Record<string, unknown>>(base: string): Promise<Rec<T>[]> {
  const out: Rec<T>[] = [];
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
      out.push({
        key: message.key?.toString() ?? null,
        value: message.value === null ? null : (JSON.parse(String(message.value)) as T),
      });
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

async function send(gameId: string, command: Record<string, unknown>, shiftId: number | null = null): Promise<void> {
  const value = JSON.stringify({ commandId: randomUUID(), issuedAt: Date.now(), gameId, shiftId, command });
  // Keyed by gameId, like the gateway and the send CLI do.
  await producer.send({ topic: topicName(TOPICS.commands), messages: [{ key: gameId, value }] });
}

async function sendRaw(value: string): Promise<void> {
  await producer.send({ topic: topicName(TOPICS.commands), messages: [{ key: null, value }] });
}

type Status = { gameId: string; phase: string; tick: number; shiftId: number | null };
type Event = { gameId: string; type: string; reason?: string };

const quiet = { log: () => {}, warn: () => {} };

describe('SimRunner + GameHost + Kafka', () => {
  it('two games: keyed by gameId, resume after restart, quit tombstones, quit game not restored', async () => {
    const A = randomUUID();
    const B = randomUUID();
    const status = await collect<Status>(TOPICS.status);
    const events = await collect<Event>(TOPICS.events);
    const state = await collect<unknown>(TOPICS.state);

    // Run 1: start both games and their shifts.
    const h1 = new GameHost();
    const r1 = new SimRunner(kafka, h1, { tickMs: 100, ...quiet });
    await r1.start();
    await send(A, { type: 'startGame' });
    await send(B, { type: 'startGame' });
    await waitFor(() => [A, B].every((id) => status.some((s) => s.key === id)), 10_000, 'status for both games');
    for (const r of status) expect(r.key).toBe(r.value!.gameId);
    await send(A, { type: 'startShift', mode: 'auto' });
    await send(B, { type: 'startShift', mode: 'auto' });
    await waitFor(() => [A, B].every((id) => (h1.games().get(id)?.state.tick ?? 0) >= 5), 10_000, 'both games ticking');
    await r1.stop(); // final snapshot of both
    const saved = { a: h1.games().get(A)!.state.tick, b: h1.games().get(B)!.state.tick };

    // Run 2: both resume where they were.
    const loaded = await loadGames(kafka);
    expect(Object.fromEntries(loaded.map((g) => [g.run.gameId, g.tick]))).toEqual({ [A]: saved.a, [B]: saved.b });
    const h2 = new GameHost();
    const r2 = new SimRunner(kafka, h2, { tickMs: 100, ...quiet });
    await r2.start(loaded);
    try {
      await waitFor(
        () => [A, B].every((id) => status.some((s) => s.key === id && s.value!.tick > (id === A ? saved.a : saved.b))),
        10_000,
        'both games resumed',
      );
      expect(events.filter((e) => e.value?.type === 'shiftStart')).toHaveLength(2);

      // Quit A: gameEnd, then a tombstone for A on plant.state.
      await send(A, { type: 'quitGame' });
      await waitFor(
        () =>
          events.some((e) => e.key === A && e.value?.type === 'gameEnd') &&
          state.some((r) => r.key === A && r.value === null),
        10_000,
        "A's gameEnd and tombstone",
      );
      expect(events.find((e) => e.key === A && e.value?.type === 'gameEnd')!.value!.reason).toBe('quit');
      expect(h2.games().has(A)).toBe(false);
    } finally {
      await r2.stop();
    }
    // Nothing after the tombstone revives A.
    const lastA = state.filter((r) => r.key === A).at(-1);
    expect(lastA?.value).toBeNull();

    // Run 3: only B comes back.
    const again = await loadGames(kafka);
    expect(again.map((g) => g.run.gameId)).toEqual([B]);
    const h3 = new GameHost();
    const r3 = new SimRunner(kafka, h3, { tickMs: 100, ...quiet });
    await r3.start(again);
    await r3.stop();
    expect([...h3.games().keys()]).toEqual([B]);
  });

  it('loadGames: empty plant.state → [], quickly', async () => {
    const t0 = Date.now();
    expect(await loadGames(kafka)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('loadGames: a good save followed by garbage for the same game → the good save, the skip logged', async () => {
    const id = randomUUID();
    const good = { ...createInitialState(5, Date.now(), id), tick: 42 };
    await producer.send({ topic: topicName(TOPICS.state), messages: [{ key: id, value: serialize(good) }] });
    await producer.send({ topic: topicName(TOPICS.state), messages: [{ key: id, value: '{not json' }] });
    const logs: string[] = [];
    const games = await loadGames(kafka, (m) => logs.push(m));
    expect(games.map((g) => g.tick)).toEqual([42]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/invalid JSON/);
  });

  it('bad commands → commandRejected, and the runner keeps ticking', async () => {
    const id = randomUUID();
    const events = await collect<Event>(TOPICS.events);
    const host = new GameHost();
    const runner = new SimRunner(kafka, host, { tickMs: 100, ...quiet });
    await runner.start();
    try {
      await send(id, { type: 'startGame' });
      await send(id, { type: 'startShift', mode: 'auto' });
      await waitFor(() => host.games().get(id)?.state.phase === 'running', 10_000, 'shift start');
      await sendRaw('{"nonsense":true}');
      await sendRaw('not json at all');
      await waitFor(() => events.filter((e) => e.value?.type === 'commandRejected').length >= 2, 10_000, 'commandRejected');
      const tick = host.games().get(id)!.state.tick;
      await waitFor(() => host.games().get(id)!.state.tick >= tick + 5, 10_000, 'more ticks');
      expect(runner.kafkaDown).toBe(false);
    } finally {
      await runner.stop();
    }
  });
});
