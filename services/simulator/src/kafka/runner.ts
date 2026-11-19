import { PLANT_KEY, TOPICS } from '@desal/schema';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { restore, serialize } from '../snapshot.js';
import type { PlantState } from '../state.js';
import { tick, type TickResult } from '../tick.js';
import { topicName, type KafkaInstance } from './client.js';
import { readToEnd } from './read.js';

// ---------------------------------------------------------------------------
// Career load
// ---------------------------------------------------------------------------

export type CareerLoad = { kind: 'found'; state: PlantState } | { kind: 'none' } | { kind: 'corrupt'; reason: string };

/**
 * Reads the saved career from plant.state.
 *
 * plant.state is compacted, so it holds (at least) the latest snapshot per key;
 * older ones may linger until the cleaner runs, which is why we read every record
 * up to the end and keep the *last* value for PLANT_KEY.
 */
export async function loadCareer(kafka: KafkaInstance): Promise<CareerLoad> {
  const records = await readToEnd(kafka, topicName(TOPICS.state));
  let latest: string | null | undefined;
  for (const r of records) if (r.key === PLANT_KEY) latest = r.value;
  // A null value is a tombstone (an explicit delete), so treat it as no career.
  if (latest === undefined || latest === null) return { kind: 'none' };
  const r = restore(latest);
  return r.ok ? { kind: 'found', state: r.state } : { kind: 'corrupt', reason: r.reason };
}

// ---------------------------------------------------------------------------
// I/O seam: the runner talks to Kafka only through this, so its loop can be
// unit-tested with a fake.
// ---------------------------------------------------------------------------

export interface OutRecord {
  topic: string;
  messages: KafkaJS.Message<string, string>[];
}

export interface SimIO {
  /** Connect, and deliver each command record's value (parsed JSON, or the raw string) to onCommand. */
  start(onCommand: (raw: unknown) => void): Promise<void>;
  /** Produce one batch; rejects if Kafka does not acknowledge it. */
  send(record: OutRecord): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Commands consumer group: the group is where Kafka stores the simulator's committed
 * read position in plant.commands. Suffixed like topic names, so integration tests
 * (unique suffix) never join the real simulator's group and trigger rebalances in it.
 */
export function commandsGroup(): string {
  return `desal-sim${process.env.DESAL_TOPIC_SUFFIX ?? ''}`;
}

function parseCommand(value: Buffer | null): unknown {
  if (value === null) return null;
  const text = value.toString();
  try {
    return JSON.parse(text);
  } catch {
    // Unparseable: pass the raw string on so tick() answers with a commandRejected.
    return text;
  }
}

export function kafkaIO(kafka: KafkaInstance): SimIO {
  // librdkafka retries a failed produce internally until message.timeout.ms
  // (default 5 min). Cap it at 5 s so a dead broker surfaces quickly as a failed
  // send, which is what flips the runner into kafkaDown.
  const producer = kafka.producer({ 'message.timeout.ms': 5000 });
  // Commands consumer, group `desal-sim`: Kafka stores the group's committed
  // offset, so after a restart we continue after the last command we consumed
  // instead of replaying old ones. After eachMessage returns, the offset is only
  // *stored* in the client; librdkafka commits stored offsets to Kafka every ~5 s
  // (auto.commit.interval.ms) and on clean disconnect.
  //
  // Delivery semantic, after a crash (two windows):
  //  - Commands applied after the last snapshot are lost: their effect is not in
  //    the snapshot (the career is saved every 30 ticks), and they are not
  //    replayed if their offset was already committed. Fine for a game.
  //  - Commands inside the last uncommitted ~5 s window are redelivered
  //    (at-least-once), so they may be applied again.
  // A future improvement is storing the command offset inside the snapshot and
  // seeking to it on load, which makes "state + position" atomic.
  const groupId = commandsGroup();
  const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: false } });
  const topic = topicName(TOPICS.commands);

  return {
    async start(onCommand) {
      await producer.connect();
      // A brand-new group has no committed offset. Rather than "latest at the moment
      // the partition gets assigned" (a race: a command sent during the join could be
      // skipped), pin it to the end of the topic right now: everything sent after
      // start() returns is consumed, nothing from before is replayed.
      const admin = kafka.admin();
      await admin.connect();
      let startAt: { partition: number; offset: string }[] = [];
      try {
        const [committed] = await admin.fetchOffsets({ groupId, topics: [topic] });
        const ends = await admin.fetchTopicOffsets(topic);
        startAt = ends
          .filter((e) => (committed?.partitions.find((p) => p.partition === e.partition)?.offset ?? '-1') === '-1')
          .map((e) => ({ partition: e.partition, offset: e.high }));
      } finally {
        await admin.disconnect();
      }
      await consumer.connect();
      await consumer.subscribe({ topics: [topic] });
      await consumer.run({
        eachMessage: async ({ message }) => {
          onCommand(parseCommand(message.value));
        },
      });
      // Applied when the partition is assigned (the client remembers pending seeks).
      for (const s of startAt) consumer.seek({ topic, ...s });
    },
    async send(record) {
      await producer.send(record);
    },
    async stop() {
      await consumer.disconnect();
      await producer.disconnect();
    },
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunnerOptions {
  /** Real milliseconds per tick (1 tick = 40 plant seconds). */
  tickMs?: number;
  /** While Kafka is down, how often to retry the failed send. */
  retryMs?: number;
  log?: (msg: string) => void;
}

function snapshotRecord(s: PlantState): OutRecord {
  // Keyed by PLANT_KEY so compaction keeps exactly one latest save per plant.
  return { topic: topicName(TOPICS.state), messages: [{ key: PLANT_KEY, value: serialize(s) }] };
}

/** The records one tick produces, in produce order: events, status, telemetry, snapshot. */
function tickRecords(r: TickResult): OutRecord[] {
  const out: OutRecord[] = [];
  // No producer timestamps: these topics use LogAppendTime (the broker stamps
  // wall-clock time); plant time, the event time, travels in each payload.
  // Events and status are keyed by the plant: one partition, one total order.
  if (r.events.length > 0) {
    out.push({
      topic: topicName(TOPICS.events),
      messages: r.events.map((e) => ({ key: PLANT_KEY, value: JSON.stringify(e) })),
    });
  }
  out.push({
    topic: topicName(TOPICS.status),
    messages: [{ key: PLANT_KEY, value: JSON.stringify(r.status) }],
  });
  if (r.telemetry.length > 0) {
    // One batched send for all ~108 readings. Key = sensorId, so each sensor's
    // readings hash to one partition and stay in order for that sensor.
    out.push({
      topic: topicName(TOPICS.telemetry),
      messages: r.telemetry.map((t) => ({ key: t.sensorId, value: JSON.stringify(t) })),
    });
  }
  if (r.snapshotDue) out.push(snapshotRecord(r.state));
  return out;
}

function isSimIO(x: KafkaInstance | SimIO): x is SimIO {
  return typeof (x as SimIO).send === 'function';
}

/**
 * Drives the deterministic tick() in real time and wires it to Kafka.
 *
 * A self-scheduling setTimeout loop (not setInterval) guarantees ticks never
 * overlap: the next tick is only scheduled after this tick's records are acked.
 */
export class SimRunner {
  private readonly io: SimIO;
  private readonly tickMs: number;
  private readonly retryMs: number;
  private readonly log: (msg: string) => void;
  private current: PlantState;
  private queue: unknown[] = [];
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private loopDone: Promise<void> = Promise.resolve();
  /** Records of the tick whose produce failed; resent (all of them) until Kafka acks. */
  private unsent: OutRecord[] | null = null;

  constructor(kafka: KafkaInstance | SimIO, initial: PlantState, opts: RunnerOptions = {}) {
    this.io = isSimIO(kafka) ? kafka : kafkaIO(kafka);
    this.current = initial;
    this.tickMs = opts.tickMs ?? 1000;
    this.retryMs = opts.retryMs ?? 2000;
    this.log = opts.log ?? ((m) => console.log(`[sim] ${m}`));
  }

  get state(): PlantState {
    return this.current;
  }

  /** True while produces fail: the plant is frozen until Kafka acks again. */
  get kafkaDown(): boolean {
    return this.unsent !== null;
  }

  async start(): Promise<void> {
    await this.io.start((raw) => this.queue.push(raw));
    // Save immediately: a --new-career replaces the old save now, not 30 ticks later.
    await this.io.send(snapshotRecord(this.current));
    this.running = true;
    this.schedule(this.tickMs);
    this.log(`running at tick ${this.current.tick} (phase ${this.current.phase})`);
  }

  /** Stops ticking, waits for the in-flight tick, writes a final snapshot (unless Kafka is down), disconnects. */
  async stop({ finalSnapshot = true }: { finalSnapshot?: boolean } = {}): Promise<void> {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer);
    await this.loopDone;
    if (finalSnapshot && !this.kafkaDown) {
      try {
        await this.io.send(snapshotRecord(this.current));
        this.log(`final snapshot written at tick ${this.current.tick}`);
      } catch (e) {
        this.log(`final snapshot failed: ${String(e)}`);
      }
    }
    await this.io.stop();
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.loopDone = this.step();
    }, ms);
  }

  /** One loop iteration: a tick when healthy, a resend while Kafka is down. Never rejects. */
  private async step(): Promise<void> {
    const began = Date.now();
    if (this.unsent) {
      await this.resend();
    } else {
      const r = tick(this.current, this.queue.splice(0));
      // The tick is committed even if its produce fails; its records are kept and
      // resent (at-least-once: a retry may duplicate records that did get through).
      this.current = r.state;
      await this.produce(tickRecords(r));
    }
    if (!this.running) return;
    // While down, retry every retryMs; otherwise keep a 1 tick/tickMs cadence.
    this.schedule(this.unsent ? this.retryMs : Math.max(0, this.tickMs - (Date.now() - began)));
  }

  private async produce(records: OutRecord[]): Promise<void> {
    try {
      for (const r of records) await this.io.send(r);
    } catch (e) {
      this.unsent = records;
      this.log(`Kafka down (${String(e)}): plant frozen at tick ${this.current.tick}, retrying every ${this.retryMs} ms`);
    }
  }

  private async resend(): Promise<void> {
    const records = this.unsent!;
    try {
      for (const r of records) await this.io.send(r);
      this.unsent = null;
      this.log(`Kafka back: resuming at tick ${this.current.tick}`);
    } catch {
      // Still down; step() schedules the next retry.
    }
  }
}
