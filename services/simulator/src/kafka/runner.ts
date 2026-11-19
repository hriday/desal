import { TOPICS } from '@desal/schema';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { GameHost, HostTick } from '../host.js';
import { restore, serialize, snapshotIssue } from '../snapshot.js';
import type { PlantState } from '../state.js';
import { topicName, type KafkaInstance } from './client.js';
import { readToEnd, type ReadRecord } from './read.js';

// ---------------------------------------------------------------------------
// Loading live games
// ---------------------------------------------------------------------------

/**
 * The games to resume, from plant.state records in offset order: per key (gameId), the newest
 * save that restores cleanly. Newer invalid saves are skipped (and logged), so one bad write does
 * not lose a game while an older valid save is still in the topic. A tombstone (null value) means
 * the game ended: the key is dropped, and nothing older than a tombstone is ever used. Games whose
 * save says they are already over are dropped too.
 */
export function pickGames(records: ReadRecord[], log: (msg: string) => void = () => {}): PlantState[] {
  const byKey = new Map<string, ReadRecord[]>();
  for (const r of records) {
    if (r.key === null) {
      log(`skipping a plant.state record with no key at offset ${r.offset}`);
      continue;
    }
    byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  }
  const games: PlantState[] = [];
  for (const [key, saves] of byKey) {
    for (let i = saves.length - 1; i >= 0; i--) {
      const { offset, value } = saves[i]!;
      if (value === null) break; // tombstone: the game ended
      const r = restore(value);
      if (!r.ok) {
        log(
          r.reason === 'unknown version: 1'
            ? `skipping a v1 save (single-career era) for key ${key} at offset ${offset}`
            : `skipping an invalid save for ${key} at offset ${offset}: ${r.reason}`,
        );
        continue;
      }
      if (r.state.run.gameId !== key) {
        log(`skipping a save keyed ${key} at offset ${offset}: it holds game ${r.state.run.gameId}`);
        continue;
      }
      if (r.state.phase !== 'over') games.push(r.state);
      break;
    }
  }
  return games;
}

/**
 * Reads every live game from plant.state.
 *
 * plant.state is compacted, so it holds (at least) the latest save per gameId; older ones may
 * linger until the cleaner runs, which is why we read every record up to the high-water mark: the
 * newest per key is normally the one, and the older ones are the fallback if it is invalid.
 */
export async function loadGames(kafka: KafkaInstance, log?: (msg: string) => void): Promise<PlantState[]> {
  return pickGames(await readToEnd(kafka, topicName(TOPICS.state)), log);
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
    // Unparseable: pass the raw string on so the host answers with a commandRejected.
    return text;
  }
}

export function kafkaIO(kafka: KafkaInstance): SimIO {
  const producer = kafka.producer({
    // librdkafka retries a failed produce internally until message.timeout.ms
    // (default 5 min). Cap it at 5 s so a dead broker surfaces quickly as a failed
    // send, which is what flips the runner into kafkaDown.
    'message.timeout.ms': 5000,
    // Idempotence: the broker de-duplicates librdkafka's own internal retries by
    // (producer id, sequence number), so a retried batch is never written twice or
    // out of order. It implies acks=all. Our runner-level resends after an outage
    // are new sends, so consumers still de-dup those by event seq.
    'enable.idempotence': true,
  });
  // Commands consumer, group `desal-sim`: Kafka stores the group's committed
  // offset, so after a restart we continue after the last command we consumed
  // instead of replaying old ones. After eachMessage returns, the offset is only
  // *stored* in the client; librdkafka commits stored offsets to Kafka every ~5 s
  // (auto.commit.interval.ms) and on clean disconnect.
  //
  // Delivery semantic, after a crash (two windows):
  //  - Commands applied after a game's last snapshot are lost: their effect is not
  //    in the snapshot (each game is saved every 30 ticks), and they are not
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
  /** Per-game problems that do not stop the runner (a game error, a refused snapshot). */
  warn?: (msg: string) => void;
  /** Wall clock (ms); the host's liveness check is the only consumer. */
  now?: () => number;
  /**
   * Called once the runner has halted on an unrecoverable error (an exception inside host.step(),
   * a non-retriable produce error), after its final snapshot attempt and disconnect. The process
   * should exit non-zero.
   */
  onFatal?: (error: unknown) => void;
}

/**
 * librdkafka error codes for produce failures that resending can never fix (the record or the
 * client is at fault, not the broker's availability). Everything else, e.g. a timeout, is treated
 * as an outage: the games freeze and the tick is resent.
 */
const NON_RETRIABLE_PRODUCE_CODES = new Set([
  2, // ERR_INVALID_MSG
  4, // ERR_INVALID_MSG_SIZE
  10, // ERR_MSG_SIZE_TOO_LARGE (what the broker returned, live, for an oversize record)
  18, // ERR_RECORD_LIST_TOO_LARGE
  29, // ERR_TOPIC_AUTHORIZATION_FAILED
  31, // ERR_CLUSTER_AUTHORIZATION_FAILED
  58, // ERR_SASL_AUTHENTICATION_FAILED
  87, // ERR_INVALID_RECORD
  -150, // ERR__FATAL: the idempotent producer lost its ordering guarantee and must be recreated
  -169, // ERR__AUTHENTICATION
  -186, // ERR__INVALID_ARG
]);

export function isNonRetriableProduceError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'number' && NON_RETRIABLE_PRODUCE_CODES.has(code);
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Message = KafkaJS.Message<string, string>;

function isSimIO(x: KafkaInstance | SimIO): x is SimIO {
  return typeof (x as SimIO).send === 'function';
}

/** A produce error that resending cannot fix; carries the client's original error. */
class FatalProduceError extends Error {
  constructor(readonly original: unknown) {
    super(`non-retriable produce error: ${errorText(original)}`);
  }
}

/**
 * Drives GameHost.step() in real time and wires it to Kafka.
 *
 * A self-scheduling setTimeout loop (not setInterval) guarantees steps never
 * overlap: the next step is only scheduled after this step's records are acked.
 *
 * Unrecoverable errors halt the runner instead of crashing the process or
 * retrying forever: it attempts a final snapshot of every live game,
 * disconnects, and reports through onFatal.
 */
export class SimRunner {
  private readonly io: SimIO;
  private readonly tickMs: number;
  private readonly retryMs: number;
  private readonly log: (msg: string) => void;
  private readonly warn: (msg: string) => void;
  private readonly now: () => number;
  private readonly onFatal: (error: unknown) => void;
  private queue: unknown[] = [];
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private loopDone: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | null = null;
  private halted = false;
  /** Records of the step whose produce failed; resent (all of them) until Kafka acks. */
  private unsent: OutRecord[] | null = null;
  /**
   * Wall time spent with Kafka down, hidden from the host's clock: games freeze during an
   * outage, liveness included, so a long outage (no heartbeats can arrive) abandons nobody.
   */
  private frozenMs = 0;
  private downSince = 0;

  constructor(
    kafka: KafkaInstance | SimIO,
    private readonly host: GameHost,
    opts: RunnerOptions = {},
  ) {
    this.io = isSimIO(kafka) ? kafka : kafkaIO(kafka);
    this.tickMs = opts.tickMs ?? 1000;
    this.retryMs = opts.retryMs ?? 2000;
    this.log = opts.log ?? ((m) => console.log(`[sim] ${m}`));
    this.warn = opts.warn ?? ((m) => console.warn(`[sim] WARN ${m}`));
    this.now = opts.now ?? Date.now;
    this.onFatal = opts.onFatal ?? (() => {});
  }

  /** True while produces fail: every game is frozen until Kafka acks again. */
  get kafkaDown(): boolean {
    return this.unsent !== null;
  }

  /** True once the runner has halted on an unrecoverable error. */
  get failed(): boolean {
    return this.halted;
  }

  private hostNow(): number {
    return this.now() - this.frozenMs;
  }

  /** Resume `games` (from loadGames) with a fresh liveness clock, connect, and start ticking. */
  async start(games: PlantState[] = []): Promise<void> {
    this.host.restore(games, this.hostNow());
    await this.io.start((raw) => this.queue.push(raw));
    this.running = true;
    this.schedule(this.tickMs);
    this.log(`running with ${this.host.games().size} live game(s)`);
  }

  /**
   * Stops ticking, waits for the in-flight step, writes a final snapshot of every live game
   * (unless Kafka is down), disconnects. Never rejects; safe to call again, and after a fatal halt
   * (which already closed).
   */
  async stop({ finalSnapshot = true }: { finalSnapshot?: boolean } = {}): Promise<void> {
    if (!this.stopping) {
      if (!this.running) return;
      this.stopping = this.close(finalSnapshot, true);
    }
    await this.stopping;
  }

  private async close(finalSnapshot: boolean, waitForLoop: boolean): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    if (waitForLoop) await this.loopDone;
    if (finalSnapshot && !this.kafkaDown) {
      const messages = [...this.host.games().values()].flatMap(({ state }) => this.snapshot(state));
      try {
        if (messages.length > 0) {
          await this.io.send({ topic: topicName(TOPICS.state), messages });
          this.log(`final snapshot written for ${messages.length} game(s)`);
        }
      } catch (e) {
        this.log(`final snapshot failed: ${errorText(e)}`);
      }
    }
    try {
      await this.io.stop();
    } catch (e) {
      this.log(`disconnect failed: ${errorText(e)}`);
    }
  }

  /**
   * Unrecoverable error inside the loop: stop ticking, save every game, disconnect, and report.
   * Runs inside step(), so it must not wait for loopDone (that is this very call).
   */
  private async halt(what: string, error: unknown): Promise<void> {
    this.halted = true;
    this.log(`FATAL: ${what}: ${errorText(error)}; halting`);
    // If stop() is already closing, it saves and disconnects once this step returns.
    if (this.stopping) return;
    this.stopping = this.close(true, false);
    await this.stopping;
    this.onFatal(error);
  }

  /**
   * A game's save, validated first: JSON turns a NaN or Infinity into null, which restore()
   * rejects, so an unvalidated write could overwrite the last good save with garbage. An invalid
   * state is refused (with a warning) and that game keeps its previous save.
   */
  private snapshot(s: PlantState): Message[] {
    const issue = snapshotIssue(s);
    if (issue) {
      this.warn(`game ${s.run.gameId}: refusing to write an invalid snapshot at tick ${s.tick}: ${issue}`);
      return [];
    }
    // Keyed by gameId so compaction keeps exactly one latest save per game.
    return [{ key: s.run.gameId, value: serialize(s) }];
  }

  /**
   * The records one host step produces, one batch per topic in the order events, telemetry,
   * status, state; so per game the order is events, telemetry, status, then its save.
   * Telemetry before status so a consumer can treat status N as "tick N complete".
   */
  private stepRecords(r: HostTick): OutRecord[] {
    const events: Message[] = [];
    const status: Message[] = [];
    const telemetry: Message[] = [];
    const state: Message[] = [];
    const ended = new Set(r.ended);
    // No producer timestamps: these topics use LogAppendTime (the broker stamps
    // wall-clock time); plant time, the event time, travels in each payload.
    // Every record is keyed by gameId: Kafka sends equal keys to one partition, so
    // one game's records stay in order, and Flink can keyBy(gameId).
    for (const e of r.hostEvents) events.push({ key: e.gameId, value: JSON.stringify(e) });
    for (const [gameId, out] of r.perGame) {
      for (const e of out.events) events.push({ key: gameId, value: JSON.stringify(e) });
      if (out.status) status.push({ key: gameId, value: JSON.stringify(out.status) });
      for (const t of out.telemetry) telemetry.push({ key: gameId, value: JSON.stringify(t) });
      if (ended.has(gameId)) continue;
      if (out.snapshotDue) state.push(...this.snapshot(this.host.games().get(gameId)!.state));
    }
    for (const gameId of r.ended) {
      if (!r.perGame.get(gameId)?.events.some((e) => e.type === 'gameEnd')) {
        this.warn(`game ${gameId} was dropped without a gameEnd (its state could not be rendered)`);
      }
      // Tombstone (null value): "this key is deleted". Readers of plant.state skip the
      // game from now on, and compaction later removes its older saves and then the
      // tombstone itself. Never a snapshot for an ended game, whatever snapshotDue says.
      state.push({ key: gameId, value: null });
    }
    const out: OutRecord[] = [];
    for (const [base, messages] of [
      [TOPICS.events, events],
      [TOPICS.telemetry, telemetry],
      [TOPICS.status, status],
      [TOPICS.state, state],
    ] as const) {
      if (messages.length > 0) out.push({ topic: topicName(base), messages });
    }
    return out;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.loopDone = this.step();
    }, ms);
  }

  /** One loop iteration: a host step when healthy, a resend while Kafka is down. Never rejects. */
  private async step(): Promise<void> {
    const began = this.now();
    try {
      if (this.unsent) {
        await this.resend();
      } else {
        let r: HostTick;
        try {
          r = this.host.step(this.queue.splice(0), this.hostNow());
        } catch (e) {
          // The host isolates per-game failures, so this is a bug in the host itself.
          return await this.halt('host step threw', e);
        }
        for (const { gameId, message } of r.errors) this.warn(`game ${gameId} ended with an error: ${message}`);
        // The step is committed even if its produce fails; its records are kept and
        // resent (at-least-once: a retry may duplicate records that did get through).
        await this.produce(this.stepRecords(r));
      }
    } catch (e) {
      if (e instanceof FatalProduceError) return await this.halt('produce failed', e.original);
      return await this.halt('runner error', e);
    }
    if (!this.running) return;
    // While down, retry every retryMs; otherwise keep a 1 tick/tickMs cadence.
    this.schedule(this.unsent ? this.retryMs : Math.max(0, this.tickMs - (this.now() - began)));
  }

  /**
   * Send records in order; false on an outage. A non-retriable error (the record or the client is
   * at fault) throws FatalProduceError instead: resending it would fail forever.
   */
  private async sendAll(records: OutRecord[]): Promise<boolean> {
    try {
      for (const r of records) await this.io.send(r);
      return true;
    } catch (e) {
      if (isNonRetriableProduceError(e)) throw new FatalProduceError(e);
      if (!this.unsent) {
        this.log(`Kafka down (${errorText(e)}): ${this.host.games().size} game(s) frozen, retrying every ${this.retryMs} ms`);
      }
      return false;
    }
  }

  private async produce(records: OutRecord[]): Promise<void> {
    if (!(await this.sendAll(records))) {
      this.unsent = records;
      this.downSince = this.now();
    }
  }

  private async resend(): Promise<void> {
    if (await this.sendAll(this.unsent!)) {
      this.unsent = null;
      this.frozenMs += this.now() - this.downSince;
      this.log('Kafka back: resuming');
    }
  }
}
