import { TOPICS } from '@desal/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as gameoverModule from '../../src/gameover.js';
import { GameHost } from '../../src/host.js';
import * as tickModule from '../../src/tick.js';
import { topicName } from '../../src/kafka/client.js';
import { commandsGroup, SimRunner, type OutRecord, type SimIO } from '../../src/kafka/runner.js';
import { restore } from '../../src/snapshot.js';
import type { PlantState } from '../../src/state.js';
import { nextId } from '../envelope.js';

/** In-memory stand-in for Kafka: records every send and fails while `down` is set. */
class FakeIO implements SimIO {
  down = false;
  sent: OutRecord[] = [];
  attempts = 0;
  deliver: (raw: unknown) => void = () => {};

  async start(onCommand: (raw: unknown) => void): Promise<void> {
    this.deliver = onCommand;
  }
  async send(record: OutRecord): Promise<void> {
    this.attempts++;
    if (this.down) throw new Error('broker unreachable');
    this.sent.push(record);
  }
  async stop(): Promise<void> {}

  on(base: string): OutRecord[] {
    return this.sent.filter((r) => r.topic === topicName(base));
  }
  /** Every message sent to a topic, flattened. */
  messages(base: string) {
    return this.on(base).flatMap((r) => r.messages);
  }
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const B = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const cmd = (gameId: string, command: Record<string, unknown>, shiftId: number | null = null) => ({
  commandId: nextId(),
  issuedAt: 0,
  gameId,
  shiftId,
  command,
});
const kafkaError = (code: number, message: string) => Object.assign(new Error(message), { code });

interface Ctx {
  io: FakeIO;
  host: GameHost;
  runner: SimRunner;
  logs: string[];
  warns: string[];
  fatal: unknown[];
}

/** A runner on a fake IO with games A and B started (one tick); both shifts start on the next tick. */
async function setup(): Promise<Ctx> {
  const io = new FakeIO();
  const host = new GameHost();
  const logs: string[] = [];
  const warns: string[] = [];
  const fatal: unknown[] = [];
  const runner = new SimRunner(io, host, {
    tickMs: 1000,
    retryMs: 2000,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    onFatal: (e) => fatal.push(e),
  });
  await runner.start();
  io.deliver(cmd(A, { type: 'startGame' }));
  io.deliver(cmd(B, { type: 'startGame' }));
  await vi.advanceTimersByTimeAsync(1000);
  io.deliver(cmd(A, { type: 'startShift', mode: 'auto' }));
  io.deliver(cmd(B, { type: 'startShift', mode: 'auto' }));
  return { io, host, runner, logs, warns, fatal };
}

const tickOf = (host: GameHost, id: string) => host.games().get(id)!.state.tick;

describe('SimRunner on GameHost (fake I/O)', () => {
  let c: Ctx;

  beforeEach(async () => {
    vi.useFakeTimers();
    c = await setup();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    c.io.down = false;
    const stopping = c.runner.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;
    vi.useRealTimers();
  });

  it('keys every record by gameId, and every record carries that gameId', async () => {
    await vi.advanceTimersByTimeAsync(3000);
    for (const base of [TOPICS.events, TOPICS.status, TOPICS.telemetry]) {
      const msgs = c.io.messages(base);
      expect(msgs.length, base).toBeGreaterThan(0);
      for (const m of msgs) expect(m.key, base).toBe(JSON.parse(String(m.value)).gameId);
    }
    const statusKeys = new Set(c.io.messages(TOPICS.status).map((m) => m.key));
    expect(statusKeys).toEqual(new Set([A, B]));
    // Event time travels in the payload; the broker stamps LogAppendTime.
    expect(c.io.messages(TOPICS.telemetry)[0]!.timestamp).toBeUndefined();
  });

  it('produces each tick in the order events, status, telemetry', async () => {
    const before = c.io.sent.length;
    await vi.advanceTimersByTimeAsync(1000); // applies the startShifts: shiftStart events
    const order = c.io.sent.slice(before).map((r) => r.topic);
    expect(order).toEqual([topicName(TOPICS.events), topicName(TOPICS.status), topicName(TOPICS.telemetry)]);
  });

  it('a game ended by quitGame gets its gameEnd, final status, then a tombstone and never a snapshot', async () => {
    await vi.advanceTimersByTimeAsync(2000);
    c.io.deliver(cmd(A, { type: 'quitGame' }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(c.host.games().has(A)).toBe(false);
    const ends = c.io.messages(TOPICS.events).filter((m) => JSON.parse(String(m.value)).type === 'gameEnd');
    expect(ends.map((m) => m.key)).toEqual([A]);
    expect(JSON.parse(String(c.io.messages(TOPICS.status).filter((m) => m.key === A).at(-1)!.value)).phase).toBe('over');
    // tick() reports snapshotDue on the ending tick; the runner must tombstone instead.
    const saves = c.io.messages(TOPICS.state).filter((m) => m.key === A);
    expect(saves).toEqual([{ key: A, value: null }]);
    expect(c.warns).toEqual([]);
  });

  it('a game the host drops without a gameEnd is still tombstoned, with a warning', async () => {
    await vi.advanceTimersByTimeAsync(1000);
    // A's tick throws and even its gameEnd cannot be built: the host drops it with nothing to say.
    const realTick = tickModule.tick;
    vi.spyOn(tickModule, 'tick').mockImplementation((s, cmds) => {
      if (s.run.gameId === A) throw new Error('model blew up');
      return realTick(s, cmds);
    });
    vi.spyOn(gameoverModule, 'endGame').mockImplementation(() => {
      throw new Error('cannot render');
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(c.host.games().has(A)).toBe(false);
    expect(c.io.messages(TOPICS.state).filter((m) => m.key === A)).toEqual([{ key: A, value: null }]);
    expect(c.warns.some((w) => w.includes(A) && /model blew up/.test(w))).toBe(true);
    expect(c.warns.some((w) => w.includes(A) && /without a gameEnd/.test(w))).toBe(true);
    // B is unaffected.
    expect(c.host.games().has(B)).toBe(true);
    expect(c.fatal).toEqual([]);
  });

  it('logs a game error from the host at warn level with its gameId; the other games carry on', async () => {
    await vi.advanceTimersByTimeAsync(1000);
    const realTick = tickModule.tick;
    vi.spyOn(tickModule, 'tick').mockImplementation((s, cmds) => {
      if (s.run.gameId === A) throw new Error('model blew up');
      return realTick(s, cmds);
    });
    const bTick = tickOf(c.host, B);
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.warns.some((w) => w.includes(A) && /model blew up/.test(w))).toBe(true);
    expect(c.io.messages(TOPICS.state).filter((m) => m.key === A)).toEqual([{ key: A, value: null }]);
    expect(tickOf(c.host, B)).toBe(bTick + 2);
    expect(c.fatal).toEqual([]);
  });

  it('writes periodic snapshots keyed by gameId', async () => {
    await vi.advanceTimersByTimeAsync(31_000);
    const saves = c.io.messages(TOPICS.state);
    expect(new Set(saves.map((m) => m.key))).toEqual(new Set([A, B]));
    for (const m of saves) {
      const r = restore(String(m.value));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.state.run.gameId).toBe(m.key);
    }
  });

  it('a produce failure freezes every game, retries every 2 s, and resumes all of them', async () => {
    await vi.advanceTimersByTimeAsync(1000);
    c.io.down = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.runner.kafkaDown).toBe(true);
    expect(c.logs.some((l) => /kafka down/i.test(l))).toBe(true);
    const frozen = { a: tickOf(c.host, A), b: tickOf(c.host, B) };
    const attempts = c.io.attempts;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(tickOf(c.host, A)).toBe(frozen.a);
    expect(tickOf(c.host, B)).toBe(frozen.b);
    expect(c.io.attempts - attempts).toBe(5);

    // Commands that arrive meanwhile wait in the queue.
    const a = c.host.games().get(A)!.state;
    c.io.deliver(cmd(A, { type: 'setDose', chemical: 'chlorine', mgL: 3 }, a.shift!.id));

    c.io.down = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.runner.kafkaDown).toBe(false);
    expect(c.logs.some((l) => /kafka back/i.test(l))).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tickOf(c.host, A)).toBeGreaterThanOrEqual(frozen.a + 3);
    expect(tickOf(c.host, B)).toBeGreaterThanOrEqual(frozen.b + 3);
    expect(c.host.games().get(A)!.state.pretreat.chlorineMgL).toBe(3);
  });

  it('an outage longer than the idle limit does not abandon games: their liveness clock freezes too', async () => {
    await vi.advanceTimersByTimeAsync(1000);
    c.io.down = true;
    await vi.advanceTimersByTimeAsync(120_000);
    c.io.down = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(c.runner.kafkaDown).toBe(false);
    expect([...c.host.games().keys()].sort()).toEqual([A, B]);
    expect(c.io.messages(TOPICS.events).some((m) => JSON.parse(String(m.value)).type === 'gameEnd')).toBe(false);
  });

  it('never overlaps ticks: a slow produce delays the next tick instead of racing it', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    c.io.send = async (record) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2500));
      inFlight--;
      c.io.sent.push(record);
    };
    const t0 = tickOf(c.host, A);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(maxInFlight).toBe(1);
    expect(tickOf(c.host, A)).toBeGreaterThan(t0);
  });

  it('stop() writes a final snapshot of every live game', async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await c.runner.stop();
    const saves = c.io.on(TOPICS.state).at(-1)!.messages;
    expect(saves.map((m) => m.key).sort()).toEqual([A, B]);
    for (const m of saves) {
      const r = restore(String(m.value));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.state.tick).toBe(tickOf(c.host, m.key!));
    }
  });

  it('an exception in host.step halts: final snapshots of every game, onFatal, no more ticks', async () => {
    await vi.advanceTimersByTimeAsync(1000);
    const boom = new Error('host blew up');
    vi.spyOn(c.host, 'step').mockImplementation(() => {
      throw boom;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.fatal).toEqual([boom]);
    expect(c.runner.failed).toBe(true);
    expect(c.logs.some((l) => /fatal/i.test(l) && /host blew up/.test(l))).toBe(true);
    expect(c.io.on(TOPICS.state).at(-1)!.messages.map((m) => m.key).sort()).toEqual([A, B]);
    const sent = c.io.sent.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.io.sent.length).toBe(sent);
    await expect(c.runner.stop()).resolves.toBeUndefined();
  });

  it('a non-retriable produce error (message too large) halts instead of retrying forever as kafkaDown', async () => {
    const send = c.io.send.bind(c.io);
    c.io.send = async (record) => {
      if (record.topic === topicName(TOPICS.telemetry)) {
        c.io.attempts++;
        throw kafkaError(10, 'Broker: Message size too large');
      }
      return send(record);
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.runner.kafkaDown).toBe(false);
    expect(c.fatal).toHaveLength(1);
    expect(c.logs.some((l) => /fatal/i.test(l) && /too large/i.test(l))).toBe(true);
    const attempts = c.io.attempts;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(c.io.attempts).toBe(attempts);
    // A final snapshot was attempted (and here succeeded: only telemetry is oversize).
    expect(c.io.on(TOPICS.state).at(-1)!.messages.map((m) => m.key).sort()).toEqual([A, B]);
  });

  it("refuses to write a game's invalid snapshot (NaN), keeping its last good save; other games still save", async () => {
    const realTick = tickModule.tick;
    vi.spyOn(tickModule, 'tick').mockImplementation((s, cmds) => {
      const r = realTick(s, cmds);
      const state: PlantState = s.run.gameId === A ? { ...r.state, heater: { ...r.state.heater, tbtC: Number.NaN } } : r.state;
      return { ...r, state, snapshotDue: true };
    });
    await vi.advanceTimersByTimeAsync(1000);
    const saves = c.io.messages(TOPICS.state);
    expect(saves.map((m) => m.key)).toEqual([B]);
    for (const m of saves) expect(restore(String(m.value)).ok).toBe(true);
    expect(c.warns.some((w) => w.includes(A) && /invalid snapshot/i.test(w))).toBe(true);
    expect(c.fatal).toEqual([]);
  });
});

describe('SimRunner start', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('restores the loaded games into the host with a fresh liveness clock', async () => {
    const seed = new GameHost();
    seed.step([cmd(A, { type: 'startGame' })], 0);
    const saved = seed.games().get(A)!.state;

    const io = new FakeIO();
    const host = new GameHost();
    const runner = new SimRunner(io, host, { log: () => {}, now: () => 5_000_000 });
    await runner.start([saved]);
    expect(host.games().get(A)).toEqual({ state: saved, lastSeenMs: 5_000_000 });
    const stopping = runner.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
  });
});

describe('commandsGroup', () => {
  it('is suffixed like topic names, so test runs never join the real desal-sim group', () => {
    const prev = process.env.DESAL_TOPIC_SUFFIX;
    try {
      delete process.env.DESAL_TOPIC_SUFFIX;
      expect(commandsGroup()).toBe('desal-sim');
      process.env.DESAL_TOPIC_SUFFIX = '.test-1';
      expect(commandsGroup()).toBe('desal-sim.test-1');
    } finally {
      if (prev === undefined) delete process.env.DESAL_TOPIC_SUFFIX;
      else process.env.DESAL_TOPIC_SUFFIX = prev;
    }
  });
});
