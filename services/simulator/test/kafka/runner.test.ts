import { PLANT_KEY, TOPICS } from '@desal/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { topicName } from '../../src/kafka/client.js';
import { commandsGroup, SimRunner, type OutRecord, type SimIO } from '../../src/kafka/runner.js';
import { createInitialState } from '../../src/state.js';
import { env } from '../envelope.js';

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
}

const initial = createInitialState(1, 1_700_000_000_000);

describe('SimRunner (fake I/O)', () => {
  let io: FakeIO;
  let logs: string[];
  let runner: SimRunner;

  beforeEach(async () => {
    vi.useFakeTimers();
    io = new FakeIO();
    logs = [];
    runner = new SimRunner(io, initial, { tickMs: 1000, retryMs: 2000, log: (m) => logs.push(m) });
    await runner.start();
    io.deliver(env(initial, { type: 'startShift', mode: 'auto' }));
  });

  afterEach(async () => {
    io.down = false;
    // stop() waits for an in-flight (possibly slow, fake-timed) tick to finish.
    const stopping = runner.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;
    vi.useRealTimers();
  });

  it('writes a snapshot on start and ticks once per interval in produce order events, status, telemetry', async () => {
    expect(io.on(TOPICS.state)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(runner.state.tick).toBe(3);
    expect(io.on(TOPICS.status)).toHaveLength(3);

    // First tick applies startShift: shiftStart event, then status, then one telemetry batch.
    const first = io.sent.slice(1, 4).map((r) => r.topic);
    expect(first).toEqual([topicName(TOPICS.events), topicName(TOPICS.status), topicName(TOPICS.telemetry)]);
    const telemetry = io.on(TOPICS.telemetry)[0]!;
    expect(telemetry.messages.length).toBeGreaterThan(100);
    const m = telemetry.messages[0]!;
    const reading = JSON.parse(String(m.value));
    expect(m.key).toBe(reading.sensorId);
    // Event time travels in the payload; the broker stamps LogAppendTime.
    expect(m.timestamp).toBeUndefined();
    expect(typeof reading.plantTime).toBe('number');
    const status = io.on(TOPICS.status)[0]!.messages[0]!;
    expect(status.key).toBe(PLANT_KEY);
  });

  it('freezes the plant while Kafka is down, retries every 2 s, and resumes on success', async () => {
    await vi.advanceTimersByTimeAsync(2000);
    expect(runner.state.tick).toBe(2);

    io.down = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(runner.kafkaDown).toBe(true);
    expect(logs.some((l) => /kafka down/i.test(l))).toBe(true);
    const frozenAt = runner.state.tick;
    const attemptsAtFailure = io.attempts;

    // 10 s down: no ticking, one retry every 2 s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.state.tick).toBe(frozenAt);
    expect(io.attempts - attemptsAtFailure).toBe(5);

    // Commands that arrive meanwhile wait in the queue.
    io.deliver(env(runner.state, { type: 'setDose', chemical: 'chlorine', mgL: 3 }));

    io.down = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(runner.kafkaDown).toBe(false);
    expect(logs.some((l) => /kafka back/i.test(l))).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(runner.state.tick).toBeGreaterThanOrEqual(frozenAt + 3);
    expect(runner.state.pretreat.chlorineMgL).toBe(3);
  });

  it('never overlaps ticks: a slow produce delays the next tick instead of racing it', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    io.send = async (record) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2500));
      inFlight--;
      io.sent.push(record);
    };
    await vi.advanceTimersByTimeAsync(20_000);
    expect(maxInFlight).toBe(1);
    expect(runner.state.tick).toBeGreaterThan(0);
  });

  it('stop() writes a final snapshot of the current state', async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await runner.stop();
    const snaps = io.on(TOPICS.state);
    const last = JSON.parse(String(snaps.at(-1)!.messages[0]!.value));
    expect(last.state.tick).toBe(runner.state.tick);
    expect(snaps.at(-1)!.messages[0]!.key).toBe(PLANT_KEY);
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
