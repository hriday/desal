import { ServerMsgSchema, type ClientMsg, type ServerMsg } from '@desal/schema';

export const GAME_ID_KEY = 'desal.gameId';
const BACKOFF_MS = [1000, 2000, 4000, 8000];
const BACKOFF_CAP_MS = 10000;

export type ConnState = 'connecting' | 'open' | 'closed';

export interface SocketOptions {
  /** Injectable for tests. */
  factory?: (url: string) => WebSocket;
}

export function defaultWsUrl(): string {
  return (
    import.meta.env.VITE_WS_URL ??
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  );
}

function storedGameId(): string | null {
  try { return sessionStorage.getItem(GAME_ID_KEY); } catch { return null; }
}
function storeGameId(id: string | null): void {
  try { if (id) sessionStorage.setItem(GAME_ID_KEY, id); else sessionStorage.removeItem(GAME_ID_KEY); } catch { /* storage unavailable */ }
}

export function createSocket(
  url: string,
  onMsg: (m: ServerMsg) => void,
  onConn: (c: ConnState) => void,
  opts: SocketOptions = {},
): { send(m: ClientMsg): boolean; close(): void } {
  const factory = opts.factory ?? ((u: string) => new WebSocket(u));
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const rawSend = (m: ClientMsg): boolean => {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(m));
    return true;
  };

  const connect = () => {
    onConn('connecting');
    const sock = factory(url);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      onConn('open');
      const id = storedGameId();
      if (id) rawSend({ t: 'resume', gameId: id });
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
      const m = r.data;
      if (m.t === 'game') storeGameId(m.gameId);
      else if (m.t === 'error' && m.reason === 'game ended') storeGameId(null);
      onMsg(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (closed) return;
      onConn('closed');
      const delay = BACKOFF_MS[attempt] ?? BACKOFF_CAP_MS;
      attempt++;
      timer = setTimeout(connect, delay);
    };
    sock.onerror = () => { /* onclose follows */ };
  };

  connect();

  return {
    send: rawSend,
    close() {
      closed = true;
      clearTimeout(timer);
      const s = ws;
      ws = null;
      s?.close();
    },
  };
}
