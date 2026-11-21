import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  PublicLeaderboardSchema,
  ServerMsgSchema,
  TOPICS,
  type GameMode,
  type PublicLeaderboard,
  type ServerMsg,
} from '@desal/schema';

// The whole pipeline through a real Flink: simulator -> Kafka -> report-card and leaderboard jobs
// -> gateway -> a ws client. Run by scripts/e2e-flink.sh, which creates the suffixed topics,
// submits both jobs on them and sets DESAL_TOPIC_SUFFIX; vitest.int.config.ts skips this file
// unless DESAL_E2E_FLINK=1.
if (!process.env.DESAL_TOPIC_SUFFIX) throw new Error('DESAL_TOPIC_SUFFIX must be set (run scripts/e2e-flink.sh)');
const simHost = await import('@desal/simulator/host');
const simClient = await import('@desal/simulator/kafka/client');
const simRunner = await import('@desal/simulator/kafka/runner');
const { GatewayKafka, createKafka } = await import('../src/kafka.js');
const { FlinkFeeds } = await import('../src/flinkFeeds.js');
const { createGateway } = await import('../src/server.js');

type Of<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

const kafka = createKafka();
const simKafka = simClient.createKafka();
// Unpaced: every runner step ticks every game, so a 720-tick shift takes 720 x 20 ms.
const host = new simHost.GameHost({ paced: false, idleMs: 10_000 });
/** Every runId the simulator produced (gameEnd and shiftEnd carry one), spied from the runner's records. */
const runIds = new Set<string>();
/** The online count of every board the gateway consumed. */
const onlineSeen: number[] = [];
let runner: InstanceType<typeof simRunner.SimRunner>;
let gwKafka: InstanceType<typeof GatewayKafka>;
let feeds: InstanceType<typeof FlinkFeeds>;
let gateway: ReturnType<typeof createGateway>;
let base: string;
const sockets: WebSocket[] = [];

let clientSeq = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(find: () => T | undefined | Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = await find();
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** A ws client that records every server message (raw text too, for the leak checks). */
class Client {
  readonly msgs: ServerMsg[] = [];
  readonly raw: string[] = [];
  readonly ws: WebSocket;
  gameId = '';
  callSign = '';
  constructor() {
    // Its own address per client: the gateway limits games per client IP (see e2e.int.test.ts).
    this.ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { 'x-forwarded-for': `10.0.1.${++clientSeq}` } });
    sockets.push(this.ws);
    this.ws.on('message', (d) => {
      this.raw.push(d.toString());
      this.msgs.push(ServerMsgSchema.parse(JSON.parse(d.toString())));
    });
  }
  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }
  of<T extends ServerMsg['t']>(t: T): Of<T>[] {
    return this.msgs.filter((m): m is Of<T> => m.t === t);
  }
  event<T extends string>(type: T) {
    return this.of('event').find((m) => m.event.type === type)?.event as Extract<Of<'event'>['event'], { type: T }> | undefined;
  }
  async start(mode: GameMode): Promise<void> {
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.send({ t: 'newGame', mode });
    this.gameId = (await until(() => this.of('game')[0], 20_000, 'game')).gameId;
    this.callSign = (await until(() => this.event('gameStart'), 20_000, 'gameStart')).callSign;
  }
  startShift(): void {
    this.send({ t: 'cmd', command: { type: 'startShift', mode: 'auto' } });
  }
}

async function board(): Promise<PublicLeaderboard | undefined> {
  const res = await fetch(`${base}/api/leaderboard`);
  if (res.status === 503) return undefined;
  return PublicLeaderboardSchema.parse(await res.json());
}

const inBoard = (b: PublicLeaderboard, mode: GameMode, callSign: string) =>
  b[mode].allTime.some((r) => r.callSign === callSign);

beforeAll(async () => {
  // The script created the topics; this only checks they are usable.
  await simClient.waitForTopics(simKafka);
  const io = simRunner.kafkaIO(simKafka);
  const send = io.send.bind(io);
  io.send = async (record) => {
    await send(record);
    if (record.topic === simClient.topicName(TOPICS.events)) {
      for (const m of record.messages) {
        const ev = JSON.parse(String(m.value)) as { runId?: string };
        if (ev.runId) runIds.add(ev.runId);
      }
    }
  };
  runner = new simRunner.SimRunner(io, host, { tickMs: 20, log: () => {} });
  await runner.start([]);
  gwKafka = new GatewayKafka(kafka, { log: () => {} });
  gateway = createGateway({ kafka: gwKafka, heartbeatMs: 1000, log: () => {} });
  const port = await gateway.listen(0, '127.0.0.1');
  await gwKafka.start(gateway.onRecord);
  feeds = new FlinkFeeds(kafka, {
    onReport: gateway.onReport,
    onBoard: (b) => {
      onlineSeen.push(b.online);
      gateway.onBoard(b);
    },
    onRank: gateway.onRank,
    onRankDeleted: gateway.onRankDeleted,
    log: () => {},
  });
  await feeds.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await gateway?.close();
  await feeds?.stop();
  await gwKafka?.stop();
  await runner?.stop({ finalSnapshot: false });
  // The script deletes the topics once the Flink jobs reading them are cancelled.
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.deleteGroups([simRunner.commandsGroup()]).catch(() => {});
  } finally {
    await admin.disconnect().catch(() => {});
  }
});

describe('full stack through Flink: report card, rank and leaderboard', () => {
  it('delivers a real report card, a rank and per-mode boards, and leaks no runId or foreign gameId', async () => {
    const a = new Client();
    await a.start('normal');

    // Shift 1, played with no commands (the plant runs in auto) to its end: 720 ticks.
    a.startShift();
    const shiftEnd = await until(() => a.event('shiftEnd'), 60_000, 'shift 1 shiftEnd');
    expect(shiftEnd.shiftId).toBe(1);
    await until(() => a.of('status').find((m) => m.status.phase === 'handover'), 20_000, 'handover');
    a.startShift();

    // The report card is held until the job has seen status up to shiftEnd (or 15 s of stall).
    const { report } = await until(() => a.of('shiftReport')[0], 60_000, 'shiftReport');
    expect(report.shiftId).toBe(1);
    expect(report.mode).toBe('normal');
    // Copied from the summary, never recomputed: exactly equal.
    expect(report.productM3).toBe(shiftEnd.summary.productM3);
    for (const k of ['targetM3', 'offSpecM3', 'offSpecMinutes', 'trips', 'spentUsd'] as const) {
      expect(report[k]).toBe(shiftEnd.summary[k]);
    }

    a.send({ t: 'cmd', command: { type: 'quitGame' } });
    await until(() => a.event('gameEnd'), 20_000, 'A gameEnd');
    const rank = await until(() => a.of('rank')[0], 60_000, 'rank');
    expect(rank.allTime).toBe(1); // the only Normal run on these topics
    const afterA = await until(
      async () => {
        const b = await board();
        return b && inBoard(b, 'normal', a.callSign) ? b : undefined;
      },
      60_000,
      "A's call sign on the normal board",
    );
    expect(inBoard(afterA, 'hard', a.callSign)).toBe(false);

    // A second run, in Hard mode, ended at once: it goes on the hard board only.
    const h = new Client();
    await h.start('hard');
    expect(h.gameId).not.toBe(a.gameId);
    expect(h.callSign).not.toBe(a.callSign); // otherwise the per-mode checks below prove nothing
    await until(() => h.of('status')[0], 20_000, 'H status');
    h.send({ t: 'cmd', command: { type: 'quitGame' } });
    await until(() => h.event('gameEnd'), 20_000, 'H gameEnd');
    const hRank = await until(() => h.of('rank')[0], 60_000, 'H rank');
    expect(hRank.allTime).toBe(1); // ranked within Hard, where it is alone
    const body = await until(
      async () => {
        const b = await board();
        return b && inBoard(b, 'hard', h.callSign) ? b : undefined;
      },
      60_000,
      "H's call sign on the hard board",
    );
    expect(Object.keys(body).sort()).toEqual(['hard', 'normal', 'online', 'updatedAt']);
    expect(inBoard(body, 'normal', h.callSign)).toBe(false);
    expect(inBoard(body, 'normal', a.callSign)).toBe(true);
    expect(inBoard(body, 'hard', a.callSign)).toBe(false);

    // The HOP window counted the live plants: never more than the two on these topics, and at
    // least one while a game was running.
    expect(onlineSeen.length).toBeGreaterThan(0);
    expect(Math.max(...onlineSeen)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...onlineSeen)).toBeLessThanOrEqual(2);
    process.stderr.write(`[flink e2e] online counts seen: ${onlineSeen.join(',')}; final body online ${body.online}\n`);

    // Leaks: every byte either client received, and both HTTP bodies.
    expect(runIds.size).toBe(2);
    const bodyText = JSON.stringify([afterA, body]);
    for (const [client, other] of [
      [a, h],
      [h, a],
    ] as const) {
      const all = client.raw.join('\n');
      expect(all).not.toContain(other.gameId);
      for (const id of runIds) expect(all).not.toContain(id);
    }
    for (const id of runIds) expect(bodyText).not.toContain(id);
    expect(bodyText).not.toContain(a.gameId);
    expect(bodyText).not.toContain(h.gameId);
  }, 300_000);
});
