import { randomUUID } from 'node:crypto';
import { createServer, STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { CommandEnvelope, Leaderboard, RunRank, ShiftReport } from '@desal/schema';
import { WebSocket, WebSocketServer } from 'ws';
import { clientIdOf, DEFAULT_TRUSTED_PROXIES, trustedProxies } from './clients.js';
import type { RecordHandler, SeenStatus } from './kafka.js';
import { DEFAULT_PER_CLIENT, type PerClientLimits } from './limits.js';
import { CLOSE_GOING_AWAY, CLOSE_TRY_AGAIN_LATER, HEARTBEAT_MS, MAX_MSG_BYTES, MAX_SOCKETS } from './protocol.js';
import { Sessions } from './sessions.js';

/** The part of GatewayKafka the server uses (a fake in tests). */
export interface GatewayKafkaLike {
  readonly connected: boolean;
  sendCommand(env: CommandEnvelope): Promise<void>;
  latestStatus(gameId: string): SeenStatus | undefined;
  gameEnded(gameId: string): boolean;
}

export interface GatewayOptions {
  kafka: GatewayKafkaLike;
  /** Allowed browser Origins; empty allows all (local dev). Clients sending no Origin are always allowed (R2). */
  allowedOrigins?: string[];
  maxSockets?: number;
  /** Per-client caps; unset fields use DEFAULT_PER_CLIENT. */
  perClient?: Partial<PerClientLimits>;
  /** Comma-separated CIDRs whose X-Forwarded-For is trusted (TRUSTED_PROXIES); default DEFAULT_TRUSTED_PROXIES. */
  trustedProxies?: string;
  heartbeatMs?: number;
  /** Wall clock, ms (default Date.now). Injected so tests control time. */
  now?: () => number;
  log?: (msg: string) => void;
}

export interface Gateway {
  /** Starts listening; resolves with the bound port (pass 0 for a free one). */
  listen(port: number, host?: string): Promise<number>;
  /** Closes every socket (1001), stops the timers and the HTTP server. */
  close(): Promise<void>;
  /** Feed consumed Kafka records here (GatewayKafka.start's callback). */
  onRecord: RecordHandler;
  /** Feed FlinkFeeds' records here. */
  onReport(gameId: string, report: ShiftReport): void;
  onBoard(board: Leaderboard): void;
  onRank(rank: RunRank): void;
  onRankDeleted(runId: string): void;
  socketCount(): number;
}

/** A client that stops reading while we queue this much for it is dropped instead of growing memory. */
const MAX_BUFFERED_BYTES = 1 << 20;

/** Answer a refused upgrade, then make sure the socket goes away even if the peer never reads. */
function refuse(socket: Duplex, code: number): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${code} ${STATUS_CODES[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  // end() flushes the reply first; destroying at once could drop it before it is sent.
  setTimeout(() => socket.destroy(), 1000).unref();
}

/** HTTP (GET /healthz, GET /api/leaderboard) plus the WebSocket endpoint /ws. */
export function createGateway(opts: GatewayOptions): Gateway {
  const { kafka } = opts;
  const allowed = new Set(opts.allowedOrigins ?? []);
  const maxSockets = opts.maxSockets ?? MAX_SOCKETS;
  const perClient: PerClientLimits = { ...DEFAULT_PER_CLIENT, ...opts.perClient };
  const trusted = trustedProxies(opts.trustedProxies ?? DEFAULT_TRUSTED_PROXIES);
  const log = opts.log ?? ((m: string) => console.log(`[gateway] ${m}`));
  const sessions = new Sessions({
    send: (env) => kafka.sendCommand(env),
    latestStatus: (id) => kafka.latestStatus(id),
    gameEnded: (id) => kafka.gameEnded(id),
    limits: perClient,
    now: opts.now,
    log,
  });
  const alive = new WeakMap<WebSocket, boolean>();

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      // Only startup/shutdown can be observed: the client exposes no consumer crash or disconnect
      // events (consumer.on is not implemented; pinned by test/kafka.test.ts).
      const ok = kafka.connected;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ok' : 'kafka not connected');
      return;
    }
    // Compared as a string, never parsed (see the upgrade listener).
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/api/leaderboard') {
      // The same Origin rule as /ws. An allowed browser Origin is echoed for CORS: in local dev the
      // web app is served from another port; in production it is same-origin and sends none.
      const origin = req.headers.origin;
      if (origin !== undefined && allowed.size > 0 && !allowed.has(origin)) {
        res.writeHead(403).end();
        return;
      }
      const cors = origin !== undefined ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
      const board = sessions.publicBoard();
      res
        .writeHead(board ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors })
        .end(JSON.stringify(board ?? { error: 'leaderboard offline' }));
      return;
    }
    res.writeHead(404).end();
  });

  // maxPayload: ws itself closes a socket (1009) whose message exceeds 16 KB, before buffering it.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

  // Internet-facing: nothing a raw request carries may throw out of this listener (an uncaught
  // exception here would kill the process), so the path is compared as a string, never parsed.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', (e) => log(`upgrade socket: ${e.message}`));
    // ws completes the handshake synchronously, so code after it can still throw in here; an
    // HTTP 400 written onto an upgraded socket would be garbage to the client.
    let upgraded: WebSocket | null = null;
    try {
      if ((req.url ?? '').split('?')[0] !== '/ws') return refuse(socket, 404);
      const origin = req.headers.origin;
      if (origin !== undefined && allowed.size > 0 && !allowed.has(origin)) return refuse(socket, 403);
      // Without Kafka a socket could neither start a game nor see one: refuse until it is up.
      if (!kafka.connected) return refuse(socket, 503);
      const clientId = clientIdOf(req.socket.remoteAddress, req.headers['x-forwarded-for'], trusted);
      wss.handleUpgrade(req, socket, head, (ws) => {
        upgraded = ws;
        if (sessions.socketCount() >= maxSockets) {
          ws.close(CLOSE_TRY_AGAIN_LATER, 'gateway full');
          return;
        }
        if (sessions.clientSocketCount(clientId) >= perClient.maxSockets) {
          ws.close(CLOSE_TRY_AGAIN_LATER, 'too many connections');
          return;
        }
        accept(ws, clientId);
      });
    } catch (e) {
      log(`bad upgrade request: ${e instanceof Error ? e.message : String(e)}`);
      if (upgraded) (upgraded as WebSocket).terminate();
      else refuse(socket, 400);
    }
  });

  function accept(ws: WebSocket, clientId: string): void {
    const id = randomUUID();
    alive.set(ws, true);
    sessions.open(id, {
      send(msg) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          log(`dropping socket ${id}: client is not reading`);
          ws.terminate();
          return;
        }
        ws.send(JSON.stringify(msg));
      },
      close: (code, reason) => ws.close(code, reason),
    }, clientId);
    ws.on('message', (data) => sessions.onClient(id, data.toString()));
    ws.on('pong', () => alive.set(ws, true));
    ws.on('close', () => sessions.close(id));
    ws.on('error', (e) => log(`socket ${id}: ${e.message}`));
  }

  const timer = setInterval(() => {
    sessions.everyHeartbeat();
    // Transport keepalive: a socket whose peer vanished (no FIN) would otherwise look bound
    // forever and keep its game alive with heartbeats. No pong since the last round = dead.
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);

  return {
    onRecord: (topic, gameId, value) => sessions.onRecord(topic, gameId, value),
    onReport: (gameId, report) => sessions.onReport(gameId, report),
    onBoard: (board) => sessions.onBoard(board),
    onRank: (rank) => sessions.onRank(rank),
    onRankDeleted: (runId) => sessions.forgetRank(runId),
    socketCount: () => sessions.socketCount(),
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    async close() {
      clearInterval(timer);
      const closing = [...wss.clients].map(
        (ws) =>
          new Promise<void>((resolve) => {
            ws.once('close', () => resolve());
            ws.close(CLOSE_GOING_AWAY, 'gateway shutting down');
          }),
      );
      // Give clients a moment to complete the close handshake, then cut whoever is left.
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(closing), new Promise((r) => (grace = setTimeout(r, 1000)))]);
      clearTimeout(grace);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
