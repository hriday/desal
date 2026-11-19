import { randomUUID } from 'node:crypto';
import { createServer, STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { CommandEnvelope } from '@desal/schema';
import { WebSocket, WebSocketServer } from 'ws';
import type { RecordHandler, SeenStatus } from './kafka.js';
import { CLOSE_GOING_AWAY, CLOSE_TRY_AGAIN_LATER, HEARTBEAT_MS, MAX_MSG_BYTES, MAX_SOCKETS } from './protocol.js';
import { Sessions } from './sessions.js';

/** The part of GatewayKafka the server uses (a fake in tests). */
export interface GatewayKafkaLike {
  readonly connected: boolean;
  sendCommand(env: CommandEnvelope): Promise<void>;
  latestStatus(gameId: string): SeenStatus | undefined;
}

export interface GatewayOptions {
  kafka: GatewayKafkaLike;
  /** Allowed browser Origins; empty allows all (local dev). Clients sending no Origin are always allowed (R2). */
  allowedOrigins?: string[];
  maxSockets?: number;
  heartbeatMs?: number;
  log?: (msg: string) => void;
}

export interface Gateway {
  /** Starts listening; resolves with the bound port (pass 0 for a free one). */
  listen(port: number, host?: string): Promise<number>;
  /** Closes every socket (1001), stops the timers and the HTTP server. */
  close(): Promise<void>;
  /** Feed consumed Kafka records here (GatewayKafka.start's callback). */
  onRecord: RecordHandler;
  socketCount(): number;
}

/** A client that stops reading while we queue this much for it is dropped instead of growing memory. */
const MAX_BUFFERED_BYTES = 1 << 20;

function refuse(socket: Duplex, code: number): void {
  socket.end(`HTTP/1.1 ${code} ${STATUS_CODES[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** HTTP (GET /healthz) plus the WebSocket endpoint /ws. */
export function createGateway(opts: GatewayOptions): Gateway {
  const { kafka } = opts;
  const allowed = new Set(opts.allowedOrigins ?? []);
  const maxSockets = opts.maxSockets ?? MAX_SOCKETS;
  const log = opts.log ?? ((m: string) => console.log(`[gateway] ${m}`));
  const sessions = new Sessions({
    send: (env) => kafka.sendCommand(env),
    latestStatus: (id) => kafka.latestStatus(id),
    log,
  });
  const alive = new WeakMap<WebSocket, boolean>();

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const ok = kafka.connected;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ok' : 'kafka not connected');
      return;
    }
    res.writeHead(404).end();
  });

  // maxPayload: ws itself closes a socket (1009) whose message exceeds 16 KB, before buffering it.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://gateway').pathname !== '/ws') return refuse(socket, 404);
    const origin = req.headers.origin;
    if (origin !== undefined && allowed.size > 0 && !allowed.has(origin)) return refuse(socket, 403);
    // Without Kafka a socket could neither start a game nor see one: refuse until it is up.
    if (!kafka.connected) return refuse(socket, 503);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (sessions.socketCount() >= maxSockets) {
        ws.close(CLOSE_TRY_AGAIN_LATER, 'gateway full');
        return;
      }
      accept(ws);
    });
  });

  function accept(ws: WebSocket): void {
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
    });
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
