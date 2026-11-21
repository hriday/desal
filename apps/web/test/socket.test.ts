import type { ClientMsg, ServerMsg } from '@desal/schema';
import { createSocket, GAME_ID_KEY } from '../src/net/socket';

const gameId = '11111111-1111-4111-8111-111111111111';

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWS.instances.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.({ code: 1005 }); }
  open() { this.readyState = 1; this.onopen?.(); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  recv(m: unknown) { this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) }); }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWS.instances = [];
  sessionStorage.clear();
});
afterEach(() => vi.useRealTimers());

const make = (hello?: () => ClientMsg | null) => {
  const msgs: ServerMsg[] = [];
  const conns: string[] = [];
  const sock = createSocket('ws://x/ws', (m) => msgs.push(m), (c) => conns.push(c), { factory: (u) => new FakeWS(u) as unknown as WebSocket, hello });
  return { msgs, conns, sock, ws: () => FakeWS.instances.at(-1)! };
};

describe('socket', () => {
  it('reports connecting/open and send returns false while not open', () => {
    const { sock, conns, ws } = make();
    expect(conns).toEqual(['connecting']);
    expect(sock.send({ t: 'ping' })).toBe(false);
    ws().open();
    expect(conns).toEqual(['connecting', 'open']);
    expect(sock.send({ t: 'ping' })).toBe(true);
    expect(ws().sent).toEqual([JSON.stringify({ t: 'ping' })]);
    ws().drop();
    expect(sock.send({ t: 'ping' })).toBe(false);
    sock.close();
  });

  it('reconnects with 1,2,4,8 then 10s backoff and resumes with the stored id', () => {
    sessionStorage.setItem(GAME_ID_KEY, gameId);
    const { sock, ws, conns } = make();
    ws().open();
    expect(ws().sent).toEqual([JSON.stringify({ t: 'resume', gameId })]);
    ws().drop();
    expect(conns.at(-1)).toBe('closed');
    const delays = [1000, 2000, 4000, 8000, 10000, 10000];
    for (const d of delays) {
      const n = FakeWS.instances.length;
      vi.advanceTimersByTime(d - 1);
      expect(FakeWS.instances).toHaveLength(n);
      vi.advanceTimersByTime(1);
      expect(FakeWS.instances).toHaveLength(n + 1);
      ws().drop(); // never opened: backoff keeps growing
    }
    // the first valid server message (not the open) resets the backoff; it resumes again on open
    vi.advanceTimersByTime(10000);
    ws().open();
    expect(ws().sent).toEqual([JSON.stringify({ t: 'resume', gameId })]);
    ws().recv({ t: 'pong' });
    ws().drop();
    const n = FakeWS.instances.length;
    vi.advanceTimersByTime(1000);
    expect(FakeWS.instances).toHaveLength(n + 1);
    sock.close();
  });

  it('resets the backoff only after a valid server message, not on open', () => {
    const { sock, ws } = make();
    const nextAfter = (d: number) => {
      const n = FakeWS.instances.length;
      vi.advanceTimersByTime(d - 1);
      expect(FakeWS.instances).toHaveLength(n);
      vi.advanceTimersByTime(1);
      expect(FakeWS.instances).toHaveLength(n + 1);
    };
    for (const d of [1000, 2000, 4000]) {
      ws().open(); // the gateway accepts the socket ...
      ws().drop(); // ... and closes it at once: not a recovery
      nextAfter(d);
    }
    ws().open();
    ws().recv({ t: 'nope' }); // invalid: does not count
    ws().drop();
    nextAfter(8000);
    ws().open();
    ws().recv({ t: 'pong' });
    ws().drop();
    nextAfter(1000);
    sock.close();
  });

  it('a 1013 close (gateway full) reports full and slows down: 8, 16, then 30 s at most', () => {
    const { sock, ws, conns } = make();
    ws().open();
    ws().drop(1013);
    expect(conns.at(-1)).toBe('full');
    for (const d of [8000, 16000, 30000, 30000]) {
      const n = FakeWS.instances.length;
      vi.advanceTimersByTime(d - 1);
      expect(FakeWS.instances).toHaveLength(n);
      vi.advanceTimersByTime(1);
      expect(FakeWS.instances).toHaveLength(n + 1);
      ws().drop(1013);
    }
    sock.close();
  });

  it('retryNow() reconnects at once instead of waiting out the backoff', () => {
    const { sock, ws } = make();
    ws().drop(1013);
    expect(FakeWS.instances).toHaveLength(1);
    sock.retryNow();
    expect(FakeWS.instances).toHaveLength(2);
    vi.advanceTimersByTime(60000);
    expect(FakeWS.instances).toHaveLength(2); // the cancelled timer does not fire as well
    ws().open();
    sock.retryNow(); // connected: nothing to do
    expect(FakeWS.instances).toHaveLength(2);
    sock.close();
  });

  it('sends hello() on every open instead of the default resume', () => {
    const hellos: (ClientMsg | null)[] = [{ t: 'newGame', mode: 'normal' }, null];
    const { sock, ws } = make(() => hellos.shift() ?? null);
    ws().open();
    expect(ws().sent).toEqual([JSON.stringify({ t: 'newGame', mode: 'normal' })]);
    ws().drop();
    vi.advanceTimersByTime(1000);
    ws().open();
    expect(ws().sent).toEqual([]);
    sock.close();
  });

  it('does not send resume without a stored gameId', () => {
    const { sock, ws } = make();
    ws().open();
    expect(ws().sent).toEqual([]);
    sock.close();
  });

  it('delivers valid messages, drops invalid ones with a log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sock, ws, msgs } = make();
    ws().open();
    ws().recv({ t: 'pong' });
    ws().recv({ t: 'nope' });
    ws().recv({ t: 'error', reason: 'something else' });
    ws().recv('not json');
    ws().recv({ t: 'frame', tick: 1, plantTime: 1, readings: { a: 'x' } });
    expect(msgs).toEqual([{ t: 'pong' }]);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
    sock.close();
  });

  it('stores gameId on game and forgets it on "game ended"', () => {
    const { sock, ws } = make();
    ws().open();
    ws().recv({ t: 'game', gameId });
    expect(sessionStorage.getItem(GAME_ID_KEY)).toBe(gameId);
    ws().recv({ t: 'error', reason: 'game ended' });
    expect(sessionStorage.getItem(GAME_ID_KEY)).toBeNull();
    sessionStorage.setItem(GAME_ID_KEY, gameId);
    ws().recv({ t: 'error', reason: 'no game' });
    expect(sessionStorage.getItem(GAME_ID_KEY)).toBeNull();
    sock.close();
  });

  it('close() stops reconnecting', () => {
    const { sock, ws } = make();
    ws().open();
    sock.close();
    vi.advanceTimersByTime(60000);
    expect(FakeWS.instances).toHaveLength(1);
  });
});
