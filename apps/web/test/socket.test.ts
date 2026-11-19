import type { ServerMsg } from '@desal/schema';
import { createSocket, GAME_ID_KEY } from '../src/net/socket';

const gameId = '11111111-1111-4111-8111-111111111111';

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWS.instances.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
  recv(m: unknown) { this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) }); }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWS.instances = [];
  sessionStorage.clear();
});
afterEach(() => vi.useRealTimers());

const make = () => {
  const msgs: ServerMsg[] = [];
  const conns: string[] = [];
  const sock = createSocket('ws://x/ws', (m) => msgs.push(m), (c) => conns.push(c), { factory: (u) => new FakeWS(u) as unknown as WebSocket });
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
    // a successful open resets the backoff and resumes again
    vi.advanceTimersByTime(10000);
    ws().open();
    expect(ws().sent).toEqual([JSON.stringify({ t: 'resume', gameId })]);
    ws().drop();
    const n = FakeWS.instances.length;
    vi.advanceTimersByTime(1000);
    expect(FakeWS.instances).toHaveLength(n + 1);
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
    ws().recv('not json');
    ws().recv({ t: 'frame', tick: 1, plantTime: 1, readings: { a: 'x' } });
    expect(msgs).toEqual([{ t: 'pong' }]);
    expect(warn).toHaveBeenCalledTimes(3);
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
