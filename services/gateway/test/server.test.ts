import net from 'node:net';
import { TOPICS, type CommandEnvelope } from '@desal/schema';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { StatusBook } from '../src/kafka.js';
import type { PerClientLimits } from '../src/limits.js';
import { createGateway, type Gateway } from '../src/server.js';
import { BOARD_STALE_MS } from '../src/sessions.js';
import { board, gameStart, RUN_A, RUN_B, RUN_C } from './fixtures.js';

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
    gameEnded: (id: string) => book.hasEnded(id),
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

async function start(
  opts: {
    connected?: boolean;
    allowedOrigins?: string[];
    maxSockets?: number;
    perClient?: Partial<PerClientLimits>;
    trustedProxies?: string;
    now?: () => number;
  } = {},
) {
  const kafka = fakeKafka(opts.connected);
  gw = createGateway({
    kafka,
    allowedOrigins: opts.allowedOrigins ?? [],
    maxSockets: opts.maxSockets,
    perClient: opts.perClient,
    trustedProxies: opts.trustedProxies,
    now: opts.now,
  });
  const port = await gw.listen(0);
  return { kafka, port, url: `ws://127.0.0.1:${port}/ws` };
}

/** `forwardedFor` sets X-Forwarded-For (honoured because the test connects from loopback, like Caddy). */
function connect(url: string, origin?: string, forwardedFor?: string): WebSocket {
  const ws = new WebSocket(url, {
    ...(origin ? { origin } : {}),
    ...(forwardedFor ? { headers: { 'x-forwarded-for': forwardedFor } } : {}),
  });
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
    expect(kafka.sent[0]!.command).toEqual({ type: 'startGame', mode: 'normal' });
    const reply = nextMsg(ws);
    gw!.onRecord(TOPICS.events, gameId, gameStart(gameId));
    expect(await reply).toEqual({ t: 'game', gameId });
  });

  it('refuses the 51st socket with close code 1013', async () => {
    const { url } = await start();
    // Distinct clients, so the per-client cap (3) does not kick in first.
    const first = Array.from({ length: 50 }, (_, i) => connect(url, undefined, `198.51.100.${i}`));
    await Promise.all(first.map(opened));
    const extra = connect(url, undefined, '203.0.113.1');
    expect(await closedWith(extra)).toBe(1013);
    // Room again once one leaves.
    const left = closedWith(first[0]!);
    first[0]!.close();
    await left;
    await expect.poll(() => gw!.socketCount()).toBe(49);
    await opened(connect(url, undefined, '203.0.113.1'));
  });

  it('allows 3 sockets per client (X-Forwarded-For behind a loopback proxy); the 4th gets 1013', async () => {
    const { url } = await start();
    const mine = [1, 2, 3].map(() => connect(url, undefined, '192.0.2.7, 10.0.0.1'));
    await Promise.all(mine.map(opened));
    expect(await closedWith(connect(url, undefined, '192.0.2.7'))).toBe(1013);
    await opened(connect(url, undefined, '192.0.2.8')); // another client
  });

  it('takes the per-client socket cap from options (MAX_SOCKETS_PER_CLIENT)', async () => {
    const { url } = await start({ perClient: { maxSockets: 1 } });
    await opened(connect(url, undefined, '192.0.2.7'));
    expect(await closedWith(connect(url, undefined, '192.0.2.7'))).toBe(1013);
  });

  it('ignores X-Forwarded-For when the peer is not a trusted proxy', async () => {
    // 127.0.0.1 is not in this list, so every socket counts as the peer itself.
    const { url } = await start({ trustedProxies: '10.0.0.0/8', perClient: { maxSockets: 1 } });
    await opened(connect(url, undefined, '192.0.2.7'));
    expect(await closedWith(connect(url, undefined, '192.0.2.8'))).toBe(1013);
  });

  it('survives a malformed request target on /ws upgrade (pre-auth DoS)', async () => {
    const { port } = await start();
    for (const target of ['//[', '/%zz', 'http://[::', '*']) {
      const reply = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            `GET ${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
          );
        });
        let data = '';
        sock.on('data', (d) => (data += String(d)));
        sock.on('close', () => resolve(data));
        sock.on('error', reject);
      });
      expect(reply).toMatch(/^HTTP\/1\.1 (400|404)/);
    }
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
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

  it('GET /api/leaderboard is 503 until a board arrives, then the public board (no runId)', async () => {
    const { port } = await start({ now: () => board().updatedAt + 1000 });
    const url = `http://127.0.0.1:${port}/api/leaderboard`;
    const offline = await fetch(url);
    expect(offline.status).toBe(503);
    expect(await offline.json()).toEqual({ error: 'leaderboard offline' });

    gw!.onBoard(board());
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const text = await res.text();
    for (const runId of [RUN_A, RUN_B, RUN_C]) expect(text).not.toContain(runId);
    expect(text).not.toContain('runId');
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(['hard', 'normal', 'online', 'updatedAt']);
    expect(body.normal.allTime[0]).toEqual({ rank: 1, callSign: 'Kestrel-42', shiftsCompleted: 3, totalProductM3: 11999, endedAt: 1_763_500_000_000 });
    expect(body.hard.allTime[0].callSign).toBe('Osprey-3');
    expect((await fetch(`${url}?x=1`)).status).toBe(200);
  });

  it('GET /api/leaderboard is 503 once the board is older than BOARD_STALE_MS (Flink down)', async () => {
    let clock = board().updatedAt;
    const { port } = await start({ now: () => clock });
    const url = `http://127.0.0.1:${port}/api/leaderboard`;
    expect((await fetch(url)).status).toBe(503); // none yet
    gw!.onBoard(board());
    expect((await fetch(url)).status).toBe(200); // fresh
    clock += BOARD_STALE_MS + 1;
    const stale = await fetch(url);
    expect(stale.status).toBe(503);
    expect(await stale.json()).toEqual({ error: 'leaderboard offline' });
  });

  it('applies ALLOWED_ORIGINS to /api/leaderboard like /ws, answering CORS for allowed origins', async () => {
    const { port } = await start({ allowedOrigins: ['https://desal.example'], now: () => board().updatedAt });
    gw!.onBoard(board());
    const url = `http://127.0.0.1:${port}/api/leaderboard`;
    expect((await fetch(url, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const ok = await fetch(url, { headers: { origin: 'https://desal.example' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://desal.example');
    const none = await fetch(url); // R2: no Origin header
    expect(none.status).toBe(200);
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
    await gw!.close();

    const open = await start(); // ALLOWED_ORIGINS empty: any origin (local dev on another port)
    const dev = await fetch(`http://127.0.0.1:${open.port}/api/leaderboard`, { headers: { origin: 'http://localhost:5173' } });
    expect(dev.status).toBe(503);
    expect(dev.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
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
