import { randomUUID } from 'node:crypto';
import { CommandEnvelopeSchema, PlantStatusSchema, TOPICS, type CommandEnvelope } from '@desal/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_A, GAME_B, gameEnd, online, reading, status } from './fixtures.js';

// A unique suffix (set before anything calls topicName) gives this run its own throwaway
// topics, so it never sees real game records.
process.env.DESAL_TOPIC_SUFFIX = `.test-gw-${Date.now()}`;
const { GatewayKafka, createKafka, topicName } = await import('../src/kafka.js');

const kafka = createKafka();
const admin = kafka.admin();
const producer = kafka.producer();
const topics = [TOPICS.telemetry, TOPICS.status, TOPICS.events, TOPICS.commands].map(topicName);
const extraGroups: string[] = [];
let gw: InstanceType<typeof GatewayKafka> | undefined;

beforeAll(async () => {
  await admin.connect();
  await producer.connect();
  // The simulator owns topic creation; here the test stands in for it.
  await admin.createTopics({
    topics: topics.map((topic) => ({ topic, numPartitions: topic.startsWith(TOPICS.telemetry) ? 6 : 1, replicationFactor: 1 })),
  });
});

afterAll(async () => {
  await gw?.stop();
  await producer.disconnect();
  // Best effort cleanup: throwaway topics, plus the gateway's group in case stop() failed to.
  await admin.deleteTopics({ topics }).catch(() => {});
  await admin.deleteGroups([...extraGroups, ...(gw ? [gw.groupId] : [])]).catch(() => {});
  await admin.disconnect();
});

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('GatewayKafka', () => {
  it('fans out status, events and telemetry for two games, and produces commands keyed by gameId', async () => {
    gw = new GatewayKafka(kafka);
    expect(gw.groupId).toMatch(/^desal-gateway-[0-9a-f-]{36}$/);
    const got: { topic: string; gameId: string; value: unknown }[] = [];
    // Produced before start(): the gateway starts at the latest offset, so it must not see this.
    await producer.send({ topic: topicName(TOPICS.status), messages: [{ key: GAME_A, value: JSON.stringify(status(GAME_A, 0)) }] });
    await gw.start((topic, gameId, value) => got.push({ topic, gameId, value }));
    expect(gw.connected).toBe(true);

    // A fake simulator: one tick for each of two games, keyed by gameId like the real one.
    for (const g of [GAME_A, GAME_B]) {
      await producer.send({ topic: topicName(TOPICS.events), messages: [{ key: g, value: JSON.stringify(online(g, 1)) }] });
      await producer.send({ topic: topicName(TOPICS.status), messages: [{ key: g, value: JSON.stringify(status(g, 1, 7)) }] });
      await producer.send({
        topic: topicName(TOPICS.telemetry),
        messages: ['TBT', 'FLOW'].map((s) => ({ key: g, value: JSON.stringify(reading(g, 1, s)) })),
      });
    }
    await waitFor(() => got.length >= 8, 30_000, '8 records');
    await new Promise((r) => setTimeout(r, 500)); // nothing extra (e.g. the pre-start status) trickles in
    expect(got).toHaveLength(8);
    for (const g of [GAME_A, GAME_B]) {
      const mine = got.filter((r) => r.gameId === g);
      expect(mine.map((r) => r.topic).sort()).toEqual([TOPICS.events, TOPICS.status, TOPICS.telemetry, TOPICS.telemetry].sort());
      // Values arrive parsed, and each belongs to the game its key names.
      for (const r of mine) expect((r.value as { gameId: string }).gameId).toBe(g);
    }

    // latestStatus is kept from the consumed status records.
    const seen = gw.latestStatus(GAME_A);
    expect(PlantStatusSchema.parse(seen?.status).shiftId).toBe(7);
    expect(seen?.seenAt).toBeGreaterThan(Date.now() - 60_000);

    // A gameEnd makes the gateway forget that game.
    await producer.send({ topic: topicName(TOPICS.events), messages: [{ key: GAME_A, value: JSON.stringify(gameEnd(GAME_A)) }] });
    await waitFor(() => got.length >= 9, 30_000, 'gameEnd');
    expect(gw.latestStatus(GAME_A)).toBeUndefined();
    expect(gw.latestStatus(GAME_B)).toBeDefined();

    // sendCommand lands on plant.commands keyed by gameId.
    const env: CommandEnvelope = {
      commandId: randomUUID(),
      issuedAt: Date.now(),
      gameId: GAME_B,
      shiftId: 7,
      command: { type: 'heartbeat' },
    };
    await gw.sendCommand(env);
    const groupId = `test-gw-collect-${randomUUID()}`;
    extraGroups.push(groupId);
    const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: true, autoCommit: false } });
    const cmds: { key: string | null; value: unknown }[] = [];
    await consumer.connect();
    try {
      await consumer.subscribe({ topics: [topicName(TOPICS.commands)] });
      await consumer.run({
        eachMessage: async ({ message }) => {
          cmds.push({ key: message.key?.toString() ?? null, value: JSON.parse(String(message.value)) });
        },
      });
      await waitFor(() => cmds.length >= 1, 30_000, 'the command');
    } finally {
      await consumer.disconnect();
    }
    expect(cmds).toEqual([{ key: GAME_B, value: env }]);
    expect(CommandEnvelopeSchema.parse(cmds[0]!.value)).toEqual(env);

    // stop() disconnects and deletes the per-instance group.
    await gw.stop();
    expect(gw.connected).toBe(false);
    const groups = (await admin.listGroups()).groups.map((g) => g.groupId);
    expect(groups).not.toContain(gw.groupId);
  });
});
