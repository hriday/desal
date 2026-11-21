import { ServerMsgSchema, type ClientMsg, type ServerMsg } from '@desal/schema';

export const GAME_ID_KEY = 'desal.gameId';
/** Reconnect delays double from 1 s, capped at 10 s; after a 1013 (gateway full) from 8 s, capped at 30 s. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 10000;
const FULL_FIRST_ATTEMPT = 3;
const FULL_CAP_MS = 30000;
/** WebSocket close code the gateway uses when it (or this client's share of it) is full. */
export const CLOSE_TRY_AGAIN_LATER = 1013;

/** 'full': closed with 1013, the gateway is at capacity; it retries more slowly. */
export type ConnState = 'connecting' | 'open' | 'closed' | 'full';

export interface SocketOptions {
  /** Injectable for tests. */
  factory?: (url: string) => WebSocket;
  /** The first message on every open; default: resume the stored game, if any. */
  hello?: () => ClientMsg | null;
}

export function defaultWsUrl(): string {
  return (
    import.meta.env.VITE_WS_URL ??
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  );
}

export function storedGameId(): string | null {
  try { return sessionStorage.getItem(GAME_ID_KEY); } catch { return null; }
}
export function storeGameId(id: string | null): void {
  try { if (id) sessionStorage.setItem(GAME_ID_KEY, id); else sessionStorage.removeItem(GAME_ID_KEY); } catch { /* storage unavailable */ }
}

const resumeStored = (): ClientMsg | null => {
  const id = storedGameId();
  return id ? { t: 'resume', gameId: id } : null;
};

export interface GameSocket {
  send(m: ClientMsg): boolean;
  /** Waiting to reconnect: do it now (the player pressed Retry). */
  retryNow(): void;
  close(): void;
}

/**
 * The gateway connection: reconnects with backoff until close(). The backoff resets only once the
 * gateway has sent a valid message (an accepted socket that is closed at once is no recovery).
 */
export function createSocket(
  url: string,
  onMsg: (m: ServerMsg) => void,
  onConn: (c: ConnState) => void,
  opts: SocketOptions = {},
): GameSocket {
  const factory = opts.factory ?? ((u: string) => new WebSocket(u));
  const hello = opts.hello ?? resumeStored;
  let ws: WebSocket | null = null;
  let attempt = 0;
  let full = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const rawSend = (m: ClientMsg): boolean => {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(m));
    return true;
  };

  const connect = () => {
    timer = undefined;
    onConn('connecting');
    const sock = factory(url);
    ws = sock;
    sock.onopen = () => {
      onConn('open');
      const first = hello();
      if (first) rawSend(first);
    };
    sock.onmessage = (e: MessageEvent) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(e.data)); } catch {
        console.warn('socket: dropped non-JSON message');
        return;
      }
      const r = ServerMsgSchema.safeParse(parsed);
      if (!r.success) {
        console.warn('socket: dropped invalid server message', r.error.issues[0]?.message);
        return;
      }
      attempt = 0;
      full = false;
      const m = r.data;
      if (m.t === 'game') storeGameId(m.gameId);
      else if (m.t === 'error' && (m.reason === 'game ended' || m.reason === 'no game')) storeGameId(null);
      else if (m.t === 'event' && m.event.type === 'gameEnd') storeGameId(null); // nothing left to resume
      onMsg(m);
    };
    sock.onclose = (e: CloseEvent) => {
      if (ws !== sock) return;
      ws = null;
      if (closed) return;
      if (e?.code === CLOSE_TRY_AGAIN_LATER) {
        // At capacity: stop the fast retry, keep growing the backoff (up to 30 s).
        full = true;
        attempt = Math.max(attempt, FULL_FIRST_ATTEMPT);
      }
      onConn(full ? 'full' : 'closed');
      const delay = Math.min(full ? FULL_CAP_MS : BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
      attempt++;
      timer = setTimeout(connect, delay);
    };
    sock.onerror = () => { /* onclose follows */ };
  };

  connect();

  return {
    send: rawSend,
    retryNow() {
      if (closed || timer === undefined) return;
      clearTimeout(timer);
      connect();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      const s = ws;
      ws = null;
      s?.close();
    },
  };
}
