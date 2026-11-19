import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ServerMsgSchema, TOPICS, type ServerMsg } from '@desal/schema';

// Unique suffix before anything calls topicName: a throwaway set of topics for the whole stack.
process.env.DESAL_TOPIC_SUFFIX = `.test-e2e-${Date.now()}`;
const simHost = await import('@desal/simulator/host');
const simClient = await import('@desal/simulator/kafka/client');
const simRunner = await import('@desal/simulator/kafka/runner');
const { GatewayKafka, createKafka } = await import('../src/kafka.js');
const { createGateway } = await import('../src/server.js');

type Of<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

const kafka = createKafka();
const simKafka = simClient.createKafka();
const host = new simHost.GameHost({ idleMs: 3000 });
let runner: InstanceType<typeof simRunner.SimRunner>;
let gwKafka: InstanceType<typeof GatewayKafka>;
let gateway: ReturnType<typeof createGateway>;
let url: string;
const sockets: WebSocket[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A ws client that records every server message. */
class Client {
  readonly msgs: ServerMsg[] = [];
  readonly ws: WebSocket;
  gameId = '';
  constructor() {
    this.ws = new WebSocket(url); // no Origin header, like the play CLI (R2)
    sockets.push(this.ws);
    this.ws.on('message', (d) => this.msgs.push(ServerMsgSchema.parse(JSON.parse(d.toString()))));
  }
  opened(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }
  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }
  async until<T>(find: () => T | undefined, ms: number, what: string): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = find();
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  }
  of<T extends ServerMsg['t']>(t: T): Of<T>[] {
    return this.msgs.filter((m): m is Of<T> => m.t === t);
  }
  async start(): Promise<void> {
    await this.opened();
    this.send({ t: 'newGame' });
    this.gameId = (await this.until(() => this.of('game')[0], 20_000, 'game')).gameId;
  }
}

beforeAll(async () => {
  await simClient.ensureTopics(simKafka);
  await simClient.waitForTopics(simKafka);
  // idleMs 3 s: an unattended game is abandoned quickly. The gateway heartbeats every 1 s, so a
  // connected game stays alive well inside that window.
  runner = new simRunner.SimRunner(simKafka, host, { tickMs: 250, log: () => {} });
  await runner.start([]);
  gwKafka = new GatewayKafka(kafka, { log: () => {} });
  gateway = createGateway({ kafka: gwKafka, heartbeatMs: 1000, log: () => {} });
  const port = await gateway.listen(0, '127.0.0.1');
  await gwKafka.start(gateway.onRecord);
  url = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await gateway?.close();
  await gwKafka?.stop();
  await runner?.stop({ finalSnapshot: false });
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.deleteTopics({ topics: Object.values(TOPICS).map(simClient.topicName) }).catch(() => {});
    await admin.deleteGroups([simRunner.commandsGroup()]).catch(() => {});
  } finally {
    await admin.disconnect().catch(() => {});
  }
});

describe('full stack: simulator + gateway + two ws clients', () => {
  it('isolates two games, streams frames, ends on quit and on abandonment', async () => {
    const a = new Client();
    const b = new Client();
    await Promise.all([a.start(), b.start()]);
    expect(a.gameId).not.toBe(b.gameId);

    a.send({ t: 'cmd', command: { type: 'startShift', mode: 'auto' } });
    const running = await a.until(
      () => a.of('status').find((m) => m.status.phase === 'running'),
      20_000,
      'running status',
    );
    expect(running.status.gameId).toBe(a.gameId);
    await a.until(() => (a.of('frame').length >= 3 ? true : undefined), 20_000, '3 frames');
    for (const f of a.of('frame').slice(0, 3)) {
      const n = Object.keys(f.readings).length;
      expect(n).toBeGreaterThanOrEqual(108);
      expect(n).toBeLessThanOrEqual(109);
    }
    expect(JSON.stringify(b.msgs)).not.toContain(a.gameId);

    a.send({ t: 'cmd', command: { type: 'quitGame' } });
    const end = await a.until(
      () => a.of('event').find((m) => m.event.type === 'gameEnd'),
      20_000,
      'A gameEnd',
    );
    expect(end.event.type === 'gameEnd' && end.event.reason).toBe('quit');
    expect(JSON.stringify(b.msgs)).not.toContain(a.gameId);

    // B drops: its heartbeats stop and the host abandons it after idleMs.
    const bId = b.gameId;
    await b.until(() => b.of('status')[0], 20_000, 'B status');
    b.ws.close();
    await new Promise((r) => b.ws.once('close', r));
    const deadline = Date.now() + 20_000;
    while (host.games().has(bId)) {
      if (Date.now() > deadline) throw new Error('B was never abandoned');
      await sleep(100);
    }
    await sleep(1500); // let the gameEnd reach the gateway through Kafka

    const c = new Client();
    await c.opened();
    c.send({ t: 'resume', gameId: bId });
    const err = await c.until(() => c.of('error')[0], 10_000, 'resume error');
    expect(err.reason).toBe('game ended');
  });
});
