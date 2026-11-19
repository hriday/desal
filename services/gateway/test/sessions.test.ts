import { TOPICS, type CommandEnvelope, type ServerMsg } from '@desal/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { StatusBook, type GatewayTopic } from '../src/kafka.js';
import { MAX_MSG_BYTES, RESUME_WAIT_MS, START_WAIT_MS } from '../src/protocol.js';
import { Sessions } from '../src/sessions.js';
import { GAME_A, GAME_B, gameEnd, gameRejected, gameStart, noSuchGame, online, reading, status } from './fixtures.js';

const CMD_ID = '6f1c1a3e-2b7d-4c1a-9f3e-1d2c3b4a5f60';

let clock: number;
let sent: CommandEnvelope[];
let book: StatusBook;
let sessions: Sessions;
let ids: number;
/** Command types whose send should fail (a Kafka produce error). */
let failing: Set<string>;
/** Fake scheduler: tests fire timers by hand. */
let timers: { fn: () => void; ms: number; cancelled: boolean }[];
const fire = () => {
  for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
};
const inbox = new Map<string, ServerMsg[]>();
const closed = new Map<string, number>();

function open(socketId: string, clientId?: string): ServerMsg[] {
  const box: ServerMsg[] = [];
  inbox.set(socketId, box);
  sessions.open(socketId, { send: (m) => box.push(m), close: (code) => closed.set(socketId, code) }, clientId);
  return box;
}

const client = (socketId: string, msg: unknown) => sessions.onClient(socketId, JSON.stringify(msg));

/** What GatewayKafka does per consumed record: update latestStatus, then route. */
function deliver(topic: GatewayTopic, gameId: string, value: unknown): void {
  book.observe(topic, gameId, value, clock);
  sessions.onRecord(topic, gameId, value);
}

/** Opens a socket and plays it into GAME_A's started game (the gateway's generated id is mapped to GAME_A). */
function bound(socketId: string): ServerMsg[] {
  const box = open(socketId);
  client(socketId, { t: 'newGame' });
  deliver(TOPICS.events, sent.at(-1)!.gameId, gameStart(sent.at(-1)!.gameId));
  box.length = 0;
  return box;
}

beforeEach(() => {
  clock = 1_000_000;
  sent = [];
  ids = 0;
  failing = new Set();
  timers = [];
  inbox.clear();
  closed.clear();
  book = new StatusBook();
  sessions = new Sessions({
    send: async (env) => {
      if (failing.has(env.command.type)) throw new Error('produce failed');
      sent.push(env);
    },
    latestStatus: (id) => book.get(id),
    gameEnded: (id) => book.hasEnded(id),
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => (t.cancelled = true);
    },
    now: () => clock,
    // The first generated id becomes the game id for newGame; later ones are command ids.
    newId: () => (ids++ === 0 ? GAME_A : `00000000-0000-4000-8000-${(ids).toString(16).padStart(12, '0')}`),
  });
});

describe('newGame', () => {
  it('sends exactly one startGame and binds the socket; replies game on gameStart', () => {
    const box = open('s1');
    client('s1', { t: 'newGame' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ gameId: GAME_A, shiftId: null, issuedAt: clock, command: { type: 'startGame' } });
    expect(box).toEqual([]);
    deliver(TOPICS.events, GAME_A, gameStart(GAME_A));
    expect(box[0]).toEqual({ t: 'game', gameId: GAME_A });
    // Bound: the game's records now reach the socket.
    deliver(TOPICS.status, GAME_A, status(GAME_A, 1));
    expect(box.at(-1)).toEqual({ t: 'status', status: status(GAME_A, 1) });
  });

  it('rejects a second newGame on the same socket', () => {
    const box = open('s1');
    client('s1', { t: 'newGame' });
    client('s1', { t: 'newGame' });
    expect(sent).toHaveLength(1);
    expect(box).toEqual([{ t: 'error', reason: 'already in a game' }]);
  });

  it('gives up on a start the simulator never answers: capacity after 10 s, and unbinds', () => {
    const box = open('s1');
    client('s1', { t: 'newGame' });
    expect(START_WAIT_MS).toBe(10_000);
    expect(timers.map((t) => t.ms)).toEqual([START_WAIT_MS]);
    fire();
    expect(box).toEqual([{ t: 'error', reason: 'capacity' }]);
    client('s1', { t: 'cmd', command: { type: 'pause' } });
    expect(box.at(-1)).toEqual({ t: 'error', reason: 'no game' });
    deliver(TOPICS.events, GAME_A, gameStart(GAME_A)); // too late: nobody is bound any more
    expect(box.filter((m) => m.t === 'game')).toEqual([]);
  });

  it('a gameStart (or closing the socket) cancels the start timeout', () => {
    const box = open('s1');
    client('s1', { t: 'newGame' });
    deliver(TOPICS.events, GAME_A, gameStart(GAME_A));
    fire();
    expect(box).toEqual([{ t: 'game', gameId: GAME_A }, { t: 'event', event: gameStart(GAME_A) }]);
    open('s2');
    client('s2', { t: 'newGame' });
    expect(timers.at(-1)!.cancelled).toBe(false);
    sessions.close('s2');
    expect(timers.at(-1)!.cancelled).toBe(true);
  });

  it('answers gameRejected with a capacity error and unbinds', () => {
    const box = open('s1');
    client('s1', { t: 'newGame' });
    deliver(TOPICS.events, GAME_A, gameRejected(GAME_A));
    expect(box).toEqual([{ t: 'error', reason: 'capacity' }]);
    client('s1', { t: 'cmd', command: { type: 'pause' } });
    expect(box.at(-1)).toEqual({ t: 'error', reason: 'no game' });
  });
});

describe('cmd', () => {
  it('is rejected before the socket is bound', () => {
    const box = open('s1');
    client('s1', { t: 'cmd', command: { type: 'pause' } });
    expect(sent).toEqual([]);
    expect(box).toEqual([{ t: 'error', reason: 'no game' }]);
  });

  it('carries shiftId from the latest status, and the client commandId when given', () => {
    bound('s1');
    deliver(TOPICS.status, GAME_A, status(GAME_A, 5, 3));
    clock += 250;
    client('s1', { t: 'cmd', command: { type: 'setDose', chemical: 'chlorine', mgL: 1 }, commandId: CMD_ID });
    expect(sent.at(-1)).toEqual({
      commandId: CMD_ID,
      issuedAt: clock,
      gameId: GAME_A,
      shiftId: 3,
      command: { type: 'setDose', chemical: 'chlorine', mgL: 1 },
    });
    client('s1', { t: 'cmd', command: { type: 'pause' } });
    expect(sent.at(-1)!.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.at(-1)!.commandId).not.toBe(CMD_ID);
  });

  it('rejects client heartbeat and startGame (the gateway owns those)', () => {
    const box = bound('s1');
    const before = sent.length;
    client('s1', { t: 'cmd', command: { type: 'heartbeat' } });
    client('s1', { t: 'cmd', command: { type: 'startGame' } });
    expect(sent).toHaveLength(before);
    expect(box).toEqual([
      { t: 'error', reason: 'invalid message' },
      { t: 'error', reason: 'invalid message' },
    ]);
  });
});

describe('limits', () => {
  it('closes the socket on a message over 16 KB', () => {
    const box = open('s1');
    sessions.onClient('s1', JSON.stringify({ t: 'ping', pad: 'x'.repeat(MAX_MSG_BYTES) }));
    expect(box).toEqual([{ t: 'error', reason: 'too large' }]);
    expect(closed.get('s1')).toBe(1009);
  });

  it('answers non-JSON and schema-invalid messages with invalid message', () => {
    const box = open('s1');
    sessions.onClient('s1', '{not json');
    client('s1', { t: 'nope' });
    client('s1', { t: 'resume', gameId: 'not-a-uuid' });
    expect(box).toEqual([
      { t: 'error', reason: 'invalid message' },
      { t: 'error', reason: 'invalid message' },
      { t: 'error', reason: 'invalid message' },
    ]);
    expect(closed.size).toBe(0);
  });

  it('token bucket: a burst of 25, then drops silently (no error per dropped message)', () => {
    const box = open('s1');
    for (let i = 0; i < 30; i++) client('s1', { t: 'ping' });
    expect(box.filter((m) => m.t === 'pong')).toHaveLength(25);
    expect(box.filter((m) => m.t === 'error')).toEqual([]);
    expect(closed.size).toBe(0);
  });

  it('refills 5 tokens per second, up to the burst of 25', () => {
    const box = open('s1');
    const pings = (n: number) => {
      box.length = 0;
      for (let i = 0; i < n; i++) client('s1', { t: 'ping' });
      return box.filter((m) => m.t === 'pong').length;
    };
    expect(pings(25)).toBe(25);
    clock += 1000;
    expect(pings(10)).toBe(5);
    clock += 200;
    expect(pings(3)).toBe(1);
    clock += 60_000; // a long pause refills to the burst, never beyond
    expect(pings(30)).toBe(25);
  });

  it('allows a 20-command burst (set all stage levels)', () => {
    const box = bound('s1');
    for (let i = 1; i <= 20; i++) client('s1', { t: 'cmd', command: { type: 'setSetpoint', loop: `level${i}`, value: 0.5 } });
    expect(box).toEqual([]);
    expect(sent.filter((e) => e.command.type === 'setSetpoint')).toHaveLength(20);
  });

  it('closes the socket (1008) after 3 consecutive seconds of an empty bucket', () => {
    open('s1');
    // A flood at 50 msgs/s: the burst is gone after about 0.55 s, and the bucket stays empty from then on.
    for (let ms = 0; ms < 3400; ms += 20) {
      client('s1', { t: 'ping' });
      clock += 20;
    }
    expect(closed.has('s1')).toBe(false); // empty for about 2.85 s
    for (let ms = 0; ms < 400; ms += 20) {
      client('s1', { t: 'ping' });
      clock += 20;
    }
    expect(closed.get('s1')).toBe(1008);
  });

  it('a pause longer than a second restarts the 3 s count', () => {
    open('s1');
    const flood = (ms: number) => {
      for (let t = 0; t < ms; t += 20) {
        client('s1', { t: 'ping' });
        clock += 20;
      }
    };
    flood(2500);
    clock += 1500; // quiet: the bucket is no longer being hammered
    flood(2500);
    expect(closed.has('s1')).toBe(false);
  });

  it('ping answers pong', () => {
    const box = open('s1');
    client('s1', { t: 'ping' });
    expect(box).toEqual([{ t: 'pong' }]);
  });
});

describe('resume', () => {
  it('binds within 90 s of the last status, and fails after', () => {
    deliver(TOPICS.status, GAME_B, status(GAME_B, 9));
    clock += 89_000;
    const box = open('s1');
    client('s1', { t: 'resume', gameId: GAME_B });
    expect(box).toEqual([{ t: 'game', gameId: GAME_B }]);
    deliver(TOPICS.events, GAME_B, online(GAME_B, 10));
    expect(box.at(-1)).toEqual({ t: 'event', event: online(GAME_B, 10) });

    clock += 2_000; // 91 s since the status
    const late = open('s2');
    client('s2', { t: 'resume', gameId: GAME_B });
    expect(late).toEqual([{ t: 'error', reason: 'game ended' }]);
  });

  it('fails for an unknown game once the wait is over, and at once for one that ended', () => {
    const box = open('s1');
    client('s1', { t: 'resume', gameId: GAME_B });
    expect(box).toEqual([]); // no status known yet: wait for one
    expect(timers.map((t) => t.ms)).toEqual([RESUME_WAIT_MS]);
    fire();
    deliver(TOPICS.status, GAME_B, status(GAME_B, 9));
    deliver(TOPICS.events, GAME_B, gameEnd(GAME_B));
    deliver(TOPICS.status, GAME_B, status(GAME_B, 10)); // a straggling final status does not revive it
    client('s1', { t: 'resume', gameId: GAME_B });
    expect(box).toEqual([
      { t: 'error', reason: 'game ended' },
      { t: 'error', reason: 'game ended' },
    ]);
  });
});

describe('heartbeats and close', () => {
  it('sends a heartbeat only for games with a bound socket', () => {
    bound('s1');
    open('s2'); // connected, never bound
    deliver(TOPICS.status, GAME_B, status(GAME_B, 1)); // a game nobody here plays
    sent.length = 0;
    sessions.everyHeartbeat();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ gameId: GAME_A, command: { type: 'heartbeat' } });

    sessions.close('s1');
    sent.length = 0;
    sessions.everyHeartbeat();
    expect(sent).toEqual([]); // the simulator abandons the game after 90 s unless a socket resumes
  });

  it('forwards gameEnd, then unbinds the game', () => {
    const box = bound('s1');
    deliver(TOPICS.events, GAME_A, gameEnd(GAME_A));
    expect(box).toEqual([{ t: 'event', event: gameEnd(GAME_A) }]);
    sent.length = 0;
    sessions.everyHeartbeat();
    expect(sent).toEqual([]);
    client('s1', { t: 'cmd', command: { type: 'pause' } });
    expect(box.at(-1)).toEqual({ t: 'error', reason: 'no game' });
  });
});

describe('host events', () => {
  it("maps a host 'no such game' rejection for a bound game to 'game ended', and unbinds it", () => {
    const box = bound('s1');
    const other = open('s2');
    deliver(TOPICS.events, GAME_A, noSuchGame(GAME_A));
    expect(box).toEqual([{ t: 'error', reason: 'game ended' }]);
    expect(other).toEqual([]);
    sent.length = 0;
    sessions.everyHeartbeat();
    expect(sent).toEqual([]); // nothing left to keep alive
    client('s1', { t: 'cmd', command: { type: 'pause' } });
    expect(box.at(-1)).toEqual({ t: 'error', reason: 'no game' });
    client('s1', { t: 'resume', gameId: GAME_A });
    expect(box.at(-1)).toEqual({ t: 'error', reason: 'game ended' });
  });

  it('ignores a host rejection for a game nobody here plays', () => {
    const box = open('s1');
    deliver(TOPICS.events, GAME_B, noSuchGame(GAME_B));
    expect(box).toEqual([]);
  });
});

describe('routing', () => {
  it('sends frame N before status N, and only to that game sockets', () => {
    const a = bound('s1');
    const b = open('s2');
    deliver(TOPICS.telemetry, GAME_A, reading(GAME_A, 4, 'TBT', 90));
    deliver(TOPICS.telemetry, GAME_A, reading(GAME_A, 4, 'FLOW', 5));
    expect(a).toEqual([]);
    deliver(TOPICS.status, GAME_A, status(GAME_A, 4));
    expect(a).toEqual([
      { t: 'frame', tick: 4, plantTime: 160, readings: { TBT: 90, FLOW: 5 } },
      { t: 'status', status: status(GAME_A, 4) },
    ]);
    // A newer tick's reading also completes the open frame.
    deliver(TOPICS.telemetry, GAME_A, reading(GAME_A, 5, 'TBT', 91));
    deliver(TOPICS.telemetry, GAME_A, reading(GAME_A, 6, 'TBT', 92));
    expect(a.at(-1)).toEqual({ t: 'frame', tick: 5, plantTime: 200, readings: { TBT: 91 } });
    expect(b).toEqual([]);
  });

  it('ignores records that fail the schema', () => {
    const a = bound('s1');
    deliver(TOPICS.status, GAME_A, { gameId: GAME_A, tick: 'x' });
    deliver(TOPICS.events, GAME_A, { type: 'online' });
    expect(a).toEqual([]);
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('resume right after a gateway (re)start', () => {
  it('waits for the first status of an unknown game, then binds', () => {
    const box = open('s1');
    client('s1', { t: 'resume', gameId: GAME_B });
    client('s1', { t: 'cmd', command: { type: 'pause' } });
    expect(box).toEqual([{ t: 'error', reason: 'no game' }]);
    deliver(TOPICS.status, GAME_B, status(GAME_B, 3));
    expect(box.slice(1)).toEqual([
      { t: 'game', gameId: GAME_B },
      { t: 'status', status: status(GAME_B, 3) },
    ]);
    expect(timers[0]!.cancelled).toBe(true);
  });

  it('answers game ended at once when the game ends while waiting, and forgets a closed socket', () => {
    const box = open('s1');
    open('s2');
    client('s1', { t: 'resume', gameId: GAME_B });
    client('s2', { t: 'resume', gameId: GAME_B });
    sessions.close('s2');
    deliver(TOPICS.events, GAME_B, gameEnd(GAME_B));
    expect(box).toEqual([{ t: 'error', reason: 'game ended' }]);
    expect(timers.every((t) => t.cancelled)).toBe(true);
  });
});

describe('failed sends', () => {
  it('a failed startGame unbinds the socket and answers capacity', async () => {
    failing.add('startGame');
    const box = open('s1');
    client('s1', { t: 'newGame' });
    await flush();
    expect(box).toEqual([{ t: 'error', reason: 'capacity' }]);
    client('s1', { t: 'cmd', command: { type: 'pause' } });
    expect(box.at(-1)).toEqual({ t: 'error', reason: 'no game' });
    sessions.everyHeartbeat();
    expect(sent).toEqual([]);
  });

  it('a failed ordinary command is only logged', async () => {
    const box = bound('s1');
    failing.add('pause');
    client('s1', { t: 'cmd', command: { type: 'pause' } });
    await flush();
    expect(box).toEqual([]);
  });
});

describe('per-client limits', () => {
  /** newGame on a fresh socket of client c1; returns its inbox and the new game's id. */
  function newGame(socketId: string) {
    const box = open(socketId, 'c1');
    const before = sent.length;
    client(socketId, { t: 'newGame' });
    const gameId = sent.length > before ? sent.at(-1)!.gameId : null;
    if (gameId) deliver(TOPICS.status, gameId, status(gameId, 0));
    return { box, gameId };
  }

  it('one newGame per 10 s per client', () => {
    expect(newGame('s1').gameId).not.toBeNull();
    clock += 9_999;
    const second = newGame('s2');
    expect(second.gameId).toBeNull();
    expect(second.box).toEqual([{ t: 'error', reason: 'capacity' }]);
    clock += 1;
    expect(newGame('s3').gameId).not.toBeNull();
    // Another client is not affected.
    open('x1', 'c2');
    client('x1', { t: 'newGame' });
    expect(sent.at(-1)!.command.type).toBe('startGame');
    expect(sessions.clientSocketCount('c1')).toBe(3);
  });

  it('at most 3 live games per client, freed by gameEnd or by going quiet', () => {
    const games = [0, 1, 2].map((i) => {
      clock += 10_000;
      return newGame(`s${i}`).gameId!;
    });
    clock += 10_000;
    expect(newGame('s3').box).toEqual([{ t: 'error', reason: 'capacity' }]);
    deliver(TOPICS.events, games[0]!, gameEnd(games[0]!));
    expect(newGame('s4').gameId).not.toBeNull();
    clock += 10_000;
    expect(newGame('s5').gameId).toBeNull(); // 3 live again
    // Closing sockets does not free a slot: the games live on for 90 s.
    for (const id of ['s1', 's2', 's4']) sessions.close(id);
    expect(newGame('s6').gameId).toBeNull();
    clock += 91_000; // no status for 90 s: those games are gone
    expect(newGame('s7').gameId).not.toBeNull();
  });
});

describe('last socket leaving', () => {
  it('sends a heartbeat at once, so the full 90 s resume window applies', () => {
    bound('s1');
    sent.length = 0;
    sessions.close('s1');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ gameId: GAME_A, command: { type: 'heartbeat' } });
  });
});

describe('configurable per-client limits', () => {
  it('takes MAX_GAMES_PER_CLIENT and NEW_GAME_INTERVAL_MS from deps', () => {
    sessions = new Sessions({
      send: (env) => {
        sent.push(env);
      },
      latestStatus: (id) => book.get(id),
      now: () => clock,
      limits: { maxGames: 2, newGameIntervalMs: 0 },
    });
    for (const id of ['a', 'b', 'c']) {
      open(id, 'c1');
      client(id, { t: 'newGame' });
    }
    // No interval, so b starts at once (the default 10 s would refuse it); c is over the 2-game cap.
    expect(sent).toHaveLength(2);
    expect(inbox.get('b')).toEqual([]);
    expect(inbox.get('c')).toEqual([{ t: 'error', reason: 'capacity' }]);
  });
});
