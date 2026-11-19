import { TOPICS, type CommandEnvelope, type ServerMsg } from '@desal/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { StatusBook, type GatewayTopic } from '../src/kafka.js';
import { MAX_MSG_BYTES } from '../src/protocol.js';
import { Sessions } from '../src/sessions.js';
import { GAME_A, GAME_B, gameEnd, gameRejected, gameStart, online, reading, status } from './fixtures.js';

const CMD_ID = '6f1c1a3e-2b7d-4c1a-9f3e-1d2c3b4a5f60';

let clock: number;
let sent: CommandEnvelope[];
let book: StatusBook;
let sessions: Sessions;
let ids: number;
const inbox = new Map<string, ServerMsg[]>();
const closed = new Map<string, number>();

function open(socketId: string): ServerMsg[] {
  const box: ServerMsg[] = [];
  inbox.set(socketId, box);
  sessions.open(socketId, { send: (m) => box.push(m), close: (code) => closed.set(socketId, code) });
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
  inbox.clear();
  closed.clear();
  book = new StatusBook();
  sessions = new Sessions({
    send: (env) => {
      sent.push(env);
    },
    latestStatus: (id) => book.get(id),
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

  it('drops a 25 msgs/s flood beyond 20 per second, with rate limited errors', () => {
    const box = open('s1');
    for (let i = 0; i < 25; i++) client('s1', { t: 'ping' });
    expect(box.filter((m) => m.t === 'pong')).toHaveLength(20);
    expect(box.filter((m) => m.t === 'error')).toEqual(Array(5).fill({ t: 'error', reason: 'rate limited' }));
    clock += 1000; // a new second: allowed again
    box.length = 0;
    client('s1', { t: 'ping' });
    expect(box).toEqual([{ t: 'pong' }]);
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

  it('fails for an unknown game, and for one that ended', () => {
    const box = open('s1');
    client('s1', { t: 'resume', gameId: GAME_B });
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
