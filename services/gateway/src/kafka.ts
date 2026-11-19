import { randomUUID } from 'node:crypto';
import pkg from '@confluentinc/kafka-javascript';
import { PlantEventSchema, PlantStatusSchema, TOPICS, type CommandEnvelope, type PlantStatus } from '@desal/schema';

// The package exposes a KafkaJS-compatible API under `.KafkaJS`; the native
// librdkafka client underneath is what actually talks to the broker.
const { Kafka, logLevel } = pkg.KafkaJS;
export type KafkaInstance = InstanceType<typeof Kafka>;

/**
 * Integration tests set DESAL_TOPIC_SUFFIX to a unique value so they use throwaway
 * topics instead of the real game topics (same convention as the simulator).
 */
export function topicName(base: string): string {
  return base + (process.env.DESAL_TOPIC_SUFFIX ?? '');
}

export function createKafka(brokers: string = process.env.KAFKA_BROKERS ?? 'localhost:9092'): KafkaInstance {
  // clientId shows up in broker logs and Kafka UI, handy for spotting who is connected.
  return new Kafka({
    // WARN: keep connect/rebalance chatter (INFO) out of the logs.
    kafkaJS: { brokers: brokers.split(','), clientId: 'desal-gateway', logLevel: logLevel.WARN },
    // The broker advertises "localhost", which resolves to ::1 first, but Docker
    // only publishes the port on 127.0.0.1: stick to IPv4 to skip refused dials.
    'broker.address.family': 'v4',
  });
}

/** The topics the gateway streams to clients (base names, without the test suffix). */
export type GatewayTopic = typeof TOPICS.telemetry | typeof TOPICS.status | typeof TOPICS.events;
const CONSUMED: GatewayTopic[] = [TOPICS.telemetry, TOPICS.status, TOPICS.events];

/** onRecord gets the base topic name, the record key (gameId) and the parsed JSON value. */
export type RecordHandler = (topic: GatewayTopic, gameId: string, value: unknown) => void;

export interface SeenStatus {
  status: PlantStatus;
  /** Wall-clock ms when the gateway consumed it. */
  seenAt: number;
}

/** How long an ended game's id is remembered, so a straggling status cannot revive it. */
const ENDED_MEMORY_MS = 10 * 60_000;
/** Statuses older than this are useless (the game is abandoned after 90 s without heartbeats). */
const STATUS_MEMORY_MS = 90_000;
const PRUNE_EVERY_MS = 10_000;

/**
 * The latest status per live game, kept from the consumed records: commands take their shiftId
 * from it, and resume checks it. A gameEnd forgets the game. Status and events are separate
 * topics, so a game's final status can be consumed after its gameEnd; the ended set stops that
 * status from making the game look alive again.
 */
export class StatusBook {
  private readonly latest = new Map<string, SeenStatus>();
  private readonly ended = new Map<string, number>();
  private lastPrune = 0;

  observe(topic: GatewayTopic, gameId: string, value: unknown, now: number): void {
    if (topic === TOPICS.status) {
      const s = PlantStatusSchema.safeParse(value);
      if (s.success && !this.ended.has(gameId)) this.latest.set(gameId, { status: s.data, seenAt: now });
      if (now - this.lastPrune >= PRUNE_EVERY_MS) this.prune(now);
    } else if (topic === TOPICS.events) {
      const e = PlantEventSchema.safeParse(value);
      if (e.success && e.data.type === 'gameEnd') {
        this.latest.delete(gameId);
        this.ended.set(gameId, now);
      }
    }
  }

  get(gameId: string): SeenStatus | undefined {
    return this.latest.get(gameId);
  }

  hasEnded(gameId: string): boolean {
    return this.ended.has(gameId);
  }

  private prune(now: number): void {
    this.lastPrune = now;
    for (const [id, s] of this.latest) if (now - s.seenAt > STATUS_MEMORY_MS) this.latest.delete(id);
    for (const [id, at] of this.ended) if (now - at > ENDED_MEMORY_MS) this.ended.delete(id);
  }
}

export interface GatewayKafkaOptions {
  now?: () => number;
  log?: (msg: string) => void;
  /** How long start() waits for the topics to exist (the simulator creates them). */
  topicWaitMs?: number;
}

/**
 * The gateway's Kafka side: one consumer reading every game's telemetry, status and events, and
 * one producer writing client commands to plant.commands.
 */
export class GatewayKafka {
  /**
   * Fan-out: a consumer group splits a topic's partitions among its members, so instances sharing a
   * group would each see only some games. Every gateway instance needs every record (any game's
   * player may be connected to it), so each process gets its own random group. The simulator's
   * shared `desal-sim` group is the opposite: work sharing, each command handled once.
   */
  readonly groupId = `desal-gateway-${randomUUID()}`;
  private readonly book = new StatusBook();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly topicWaitMs: number;
  private readonly producer;
  private readonly consumer;
  private started = false;
  /** start() got as far as connecting: there is something for stop() to close and delete. */
  private opened = false;

  constructor(
    private readonly kafka: KafkaInstance,
    opts: GatewayKafkaOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[gateway] ${m}`));
    this.topicWaitMs = opts.topicWaitMs ?? 30_000;
    this.producer = kafka.producer({
      // Fail a send after 5 s instead of librdkafka's default 5 min of internal retries.
      'message.timeout.ms': 5000,
      // Idempotence: the broker de-duplicates librdkafka's internal retries (producer id +
      // sequence), so a retried command is never written twice or reordered. Implies acks=all.
      'enable.idempotence': true,
    });
    // fromBeginning false = "latest": the gateway streams live play only; old records are of no
    // use to a connected player. autoCommit off: this group is thrown away (deleted on stop and
    // never reused, the next process gets a new id), so committed offsets would never be read.
    this.consumer = kafka.consumer({ kafkaJS: { groupId: this.groupId, fromBeginning: false, autoCommit: false } });
  }

  get connected(): boolean {
    return this.started;
  }

  latestStatus(gameId: string): SeenStatus | undefined {
    return this.book.get(gameId);
  }

  async start(onRecord: RecordHandler): Promise<void> {
    const names = new Map(CONSUMED.map((t) => [topicName(t), t] as const));
    const ends = await this.topicEnds([...names.keys()]);
    // From here on the group may exist on the broker, so stop() must clean up even if start fails.
    this.opened = true;
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: [...names.keys()] });
    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        const base = names.get(topic);
        const gameId = message.key?.toString();
        if (!base || !gameId || message.value === null) return;
        let value: unknown;
        try {
          value = JSON.parse(message.value.toString());
        } catch {
          this.log(`skipping a non-JSON record on ${topic} at offset ${message.offset}`);
          return;
        }
        this.book.observe(base, gameId, value, this.now());
        onRecord(base, gameId, value);
      },
    });
    // "Latest" for a brand-new group is resolved when the partition gets assigned, a moment after
    // subscribe; records produced in between would be skipped. Pinning each partition to the end
    // offset captured above means everything produced after start() is called is seen.
    // (seek before assignment is remembered and applied on assignment.)
    for (const [topic, parts] of ends) for (const p of parts) this.consumer.seek({ topic, ...p });
    // Only report connected (which opens the /ws gate) once the group owns every partition:
    // before that no record flows, and a resume would see no status at all.
    const partitions = [...ends.values()].reduce((n, parts) => n + parts.length, 0);
    const deadline = this.now() + this.topicWaitMs;
    while (this.consumer.assignment().length < partitions) {
      if (this.now() >= deadline) throw new Error(`partitions not assigned after ${this.topicWaitMs} ms`);
      await new Promise((r) => setTimeout(r, 100));
    }
    this.started = true;
  }

  gameEnded(gameId: string): boolean {
    return this.book.hasEnded(gameId);
  }

  /** Commands are keyed by gameId like every record, so one game's commands stay in order on one partition. */
  async sendCommand(env: CommandEnvelope): Promise<void> {
    await this.producer.send({ topic: topicName(TOPICS.commands), messages: [{ key: env.gameId, value: JSON.stringify(env) }] });
  }

  /** Disconnects and deletes this instance's consumer group, also after a failed start(). Never rejects. */
  async stop(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    this.started = false;
    await this.consumer.disconnect().catch((e: unknown) => this.log(`consumer disconnect failed: ${String(e)}`));
    await this.producer.disconnect().catch((e: unknown) => this.log(`producer disconnect failed: ${String(e)}`));
    // An empty group lingers in the broker (and Kafka UI) until offsets.retention; it is never
    // reused, so delete it now. Best effort: a crash leaves it to expire on its own.
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.deleteGroups([this.groupId]);
    } catch (e) {
      this.log(`deleting group ${this.groupId} failed: ${String(e)}`);
    } finally {
      await admin.disconnect().catch(() => {});
    }
  }

  /**
   * Each topic's end offsets (high-water marks), retried until the topics exist: the simulator
   * creates them, and on a fresh deploy the gateway may start first.
   */
  private async topicEnds(topics: string[]): Promise<Map<string, { partition: number; offset: string }[]>> {
    const deadline = this.now() + this.topicWaitMs;
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const out = new Map<string, { partition: number; offset: string }[]>();
          for (const t of topics) {
            out.set(t, (await admin.fetchTopicOffsets(t)).map((o) => ({ partition: o.partition, offset: o.high })));
          }
          return out;
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          if (this.now() >= deadline) throw new Error(`topics not ready after ${this.topicWaitMs} ms: ${why}`);
          if (attempt === 1) this.log(`waiting for topics (${why})`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } finally {
      await admin.disconnect();
    }
  }
}
