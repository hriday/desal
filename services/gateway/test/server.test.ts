import { TOPICS, type CommandEnvelope } from '@desal/schema';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { StatusBook } from '../src/kafka.js';
import { createGateway, type Gateway } from '../src/server.js';
import { gameStart } from './fixtures.js';

/** A fake GatewayKafka: records commands, and is "connected" unless told otherwise. */
function fakeKafka(connected = true) {
  const book = new StatusBook();
  const sent: CommandEnvelope[] = [];
  return {
    connected,
    sent,
    async sendCommand(env: CommandEnvelope) {
      sent.push(env);
    },
    latestStatus: (id: string) => book.get(id),
  };
}

let gw: Gateway | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    // A refused handshake is still "connecting"; terminating it reports an error we expect.
    s.on('error', () => {});
    if (s.readyState !== WebSocket.CLOSED) s.terminate();
  }
  await gw?.close();
  gw = undefined;
});

async function start(opts: { connected?: boolean; allowedOrigins?: string[]; maxSockets?: number } = {}) {
  const kafka = fakeKafka(opts.connected);
  gw = createGateway({ kafka, allowedOrigins: opts.allowedOrigins ?? [], maxSockets: opts.maxSockets });
  const port = await gw.listen(0);
  return { kafka, port, url: `ws://127.0.0.1:${port}/ws` };
}

function connect(url: string, origin?: string): WebSocket {
  const ws = new WebSocket(url, origin ? { origin } : {});
  sockets.push(ws);
  return ws;
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
const closedWith = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
const refusedWith = (ws: WebSocket) =>
  new Promise<number>((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('open', () => reject(new Error('connection was accepted')));
  });
const nextMsg = (ws: WebSocket) => new Promise<unknown>((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));

describe('gateway server', () => {
  it('GET /healthz is 200 ok while Kafka is connected, 503 otherwise', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    await gw!.close();

    const down = await start({ connected: false });
    expect((await fetch(`http://127.0.0.1:${down.port}/healthz`)).status).toBe(503);
  });

  it('plays a game over /ws: newGame sends startGame, gameStart answers game', async () => {
    const { kafka, url } = await start();
    const ws = connect(url);
    await opened(ws);
    ws.send(JSON.stringify({ t: 'newGame' }));
    await expect.poll(() => kafka.sent.length).toBe(1);
    const gameId = kafka.sent[0]!.gameId;
    expect(kafka.sent[0]!.command).toEqual({ type: 'startGame' });
    const reply = nextMsg(ws);
    gw!.onRecord(TOPICS.events, gameId, gameStart(gameId));
    expect(await reply).toEqual({ t: 'game', gameId });
  });

  it('refuses the 51st socket with close code 1013', async () => {
    const { url } = await start();
    const first = Array.from({ length: 50 }, () => connect(url));
    await Promise.all(first.map(opened));
    const extra = connect(url);
    expect(await closedWith(extra)).toBe(1013);
    // Room again once one leaves.
    const left = closedWith(first[0]!);
    first[0]!.close();
    await left;
    await expect.poll(() => gw!.socketCount()).toBe(49);
    await opened(connect(url));
  });

  it('checks the Origin against ALLOWED_ORIGINS, allowing clients that send none', async () => {
    const { url } = await start({ allowedOrigins: ['https://desal.example'] });
    expect(await refusedWith(connect(url, 'https://evil.example'))).toBe(403);
    await opened(connect(url, 'https://desal.example'));
    await opened(connect(url)); // R2: no Origin header (e.g. the play CLI)
  });

  it('allows every origin when ALLOWED_ORIGINS is empty', async () => {
    const { url } = await start();
    await opened(connect(url, 'http://localhost:5173'));
  });

  it('refuses sockets (503) while Kafka is not connected', async () => {
    const { url } = await start({ connected: false });
    expect(await refusedWith(connect(url))).toBe(503);
  });

  it('refuses upgrades on any path but /ws', async () => {
    const { port } = await start();
    expect(await refusedWith(connect(`ws://127.0.0.1:${port}/other`))).toBe(404);
  });

  it('closes a socket that sends more than 16 KB (code 1009)', async () => {
    const { url } = await start();
    const ws = connect(url);
    await opened(ws);
    const closed = closedWith(ws);
    ws.send('x'.repeat(16 * 1024 + 1));
    expect(await closed).toBe(1009);
  });
});
