# Streaming notes: Kafka concepts in this codebase

A map from Kafka concept to where it appears in the code and why it was done that way. Flink (Plan 3) builds on the same topics.

## Topics

Every record on every topic is keyed by `gameId` (the one simulator process runs many games).

| Topic | Partitions | Key | Config | Written by |
| --- | --- | --- | --- | --- |
| `plant.telemetry` | 6 | `gameId` | LogAppendTime, 24 h and 256 MiB per partition retention | simulator |
| `plant.commands` | 1 | `gameId` | 24 h and 256 MiB retention | gateway (players), `send` CLI |
| `plant.events` | 1 | `gameId` | LogAppendTime, 7 days (kept for Flink) and 256 MiB per partition retention | simulator |
| `plant.status` | 1 | `gameId` | LogAppendTime, 1 h retention | simulator |
| `plant.state` | 1 | `gameId` | `cleanup.policy=compact`, `segment.ms=1h`, `min.cleanable.dirty.ratio=0.1` | simulator (one save per game; tombstone when it ends) |

## Concept to code

| Concept | Where | Why |
| --- | --- | --- |
| Topics and partitions | `SPECS` in `services/simulator/src/kafka/client.ts` | Telemetry (~108 msgs/s per game, most of the traffic) gets 6 partitions so a consumer (Flink) can process games in parallel; the low-volume topics get 1. |
| Keys = gameId: ordering and spread | `stepRecords` in `src/kafka/runner.ts`; `send.ts`; `sendCommand` in `services/gateway/src/kafka.ts` | Kafka hashes the key to a partition and only orders records within a partition. With `gameId` as key, one game's telemetry stays in order on one partition while different games spread over the 6 partitions. Flink will `keyBy(gameId)` to get the same grouping, one game's state on one task. Keying by `sensorId` (the single-plant design) would have kept sensors ordered but split a game's tick across partitions. |
| One-partition command log | `plant.commands` in `SPECS` | A single partition gives all operator actions one total order, so replaying them reproduces every game's history. The `gameId` key keeps one game's commands in order even if partitions are added later. |
| Consumer groups: work sharing | `commandsGroup()` and `kafkaIO` in `src/kafka/runner.ts` | The simulator's group `desal-sim` is where Kafka stores its read position in `plant.commands`. Members of one group split the partitions, so each command is handled once; a second simulator instance would take over work, not duplicate it. After a restart it continues after the last committed command. |
| Consumer groups: fan-out | `GatewayKafka.groupId` in `services/gateway/src/kafka.ts`; `src/cli/watch.ts`, `readToEnd` in `read.ts` | The opposite need: every gateway instance must see every record (any game's player may be connected to it), so each process uses its own random group `desal-gateway-<uuid>` and deletes it on exit. Watchers use a throwaway `desal-watch-<uuid>` for the same reason. Throwaway groups do not commit offsets (`autoCommit: false`). |
| `fromBeginning` and seeking | `kafkaIO.start`, `GatewayKafka.start`, `readToEnd` | A new group has no committed offset, so its start position is chosen explicitly. "Latest" is only resolved when the partition is assigned, so a record produced in between would be skipped; instead the end offset is captured first and each partition is seeked to it (the seek is applied on assignment). Readers use the beginning or the last record. |
| Reading to the current end | `readToEnd` in `src/kafka/read.ts` | Topics never end, so the reader captures each partition's high-water mark first and stops once it has delivered the record just below it. |
| Log compaction and tombstones (game saves) | `plant.state` in `SPECS`; `snapshot`, `stepRecords` in `runner.ts`; `loadGames`, `pickGames` | Compaction keeps the latest value per key, so the topic holds the latest save of every live game and is never deleted by age. When a game ends the simulator writes a tombstone (key `gameId`, null value): compaction then drops that game's older saves, and the tombstone itself after `delete.retention.ms` (24 h default, so slow readers still see the delete). `pickGames` treats a tombstone as "game over, use nothing older". The cleaner never touches the active segment and skips a log until its dirty share exceeds `min.cleanable.dirty.ratio` (default 0.5), so the topic sets `segment.ms` to 1 h and the ratio to 0.1: old saves and tombstones go in about an hour, not days. Until then older saves linger, so `loadGames` reads to the end and takes, per key, the newest save that restores, falling back past invalid ones and logging the skip. That fallback only works while older records survive, so `snapshot` also validates every save before producing it and refuses to write an invalid one. Single-career (v1) saves are keyed `plant-1` and have version 1; `pickGames` skips them with a log line. |
| Retention | `SPECS` (telemetry, commands, events, status) | Time and size limits delete the oldest segments, whichever limit is hit first; this keeps a shared server's disk bounded. Commands and events are size-capped too because public players drive them (each rejected command adds an event); the gateway also rate-limits each socket with a token bucket (burst 25, 5/s). |
| Timestamp type: LogAppendTime, plant time in payload | `LOG_APPEND_TIME` in `client.ts`; `stepRecords` in `runner.ts` | Plant time runs 40x ahead of wall clock, so it cannot be the record timestamp. The broker stamps append time; plant time travels in the payload (`tick`, `plantTime`). Flink orders a game's records by `tick` and `seq`/`epoch`, not by watermarks; see below. |
| Produce order within a tick | `stepRecords` in `runner.ts` | One batch per topic, sent in the order events, telemetry, status, state. Per game, the status record comes after that tick's telemetry (and events), so a consumer can treat "status N" as "tick N is complete" and the save comes last. This is order across topics as the producer sends them, a convention, not a Kafka guarantee: the topics are different partitions, so a consumer reading several topics can still see them interleaved. |
| Idempotent producer | `kafkaIO` in `runner.ts`; `GatewayKafka` constructor | `enable.idempotence` makes the broker de-duplicate librdkafka's own internal retries by (producer id, sequence number), so a retried batch is not written twice or reordered (implies `acks=all`). It does not cover the runner's own resend of a tick after an outage, which is a new send, hence the next row. |
| De-duplicating by `(gameId, epoch, seq)` | `seq`, `epoch` in `packages/schema/src/events.ts`; assigned in `tick()` and `GameHost.restore` | Delivery is at-least-once, so downstream code must tolerate duplicates. Each event carries `seq`, a per-game counter, and `epoch`, the number of times the game was restored from a snapshot. A crash can lose the records after the last snapshot, so a restored game may reuse seq (and tick) values; its epoch is one higher, which marks them as new. A consumer drops an event whose `(epoch, seq)` it has already seen for that `gameId`, and resets its marks when the epoch goes up. Idempotence handles transport retries; `seq` handles application-level resends. Status and telemetry can be de-duplicated by `(epoch, tick)`. Every tick that emits an event is snapshotted, which keeps seq rewinds rare. |
| Idempotent topic creation | `ensureTopics` in `client.ts`; `src/main.ts` | `createTopics` does not throw when a topic exists, so calling it at every start is safe. Auto-creation is disabled in the broker (`KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"` in `infra/docker-compose.yml`) so a typo in a topic name fails loudly. It does not reconcile configs of existing topics; use `kafka-configs.sh --alter` (the commands are in the comment above `ensureTopics`). |
| Waiting for topic metadata | `waitForTopics` in `client.ts`; `GatewayKafka.topicEnds` | `createTopics` returns before every broker's metadata has caught up; reading then fails with unknown-topic errors. Startup retries, bounded, instead of exiting; the gateway may also start before the simulator has created the topics. |
| Producer failure handling | `kafkaIO`, `SimRunner.produce` in `runner.ts` | `message.timeout.ms` is capped at 5 s so a dead broker shows up quickly as a failed send; the runner then freezes every game and resends. Non-retriable produce errors (`isNonRetriableProduceError`: message too large, invalid record, auth) are not an outage: the runner halts, attempts a final snapshot, and the process exits 1. |
| Topic-name suffix for tests | `topicName` in `client.ts` (simulator and gateway); `commandsGroup` in `runner.ts` | `DESAL_TOPIC_SUFFIX` gives integration tests their own topics and consumer group, so they cannot touch real games or trigger rebalances in the real simulator's group. |
| KRaft and listeners | `infra/docker-compose.yml`; production in `deploy/compose.yml` ([docs/hosting.md](hosting.md)) | One node is broker and controller (no ZooKeeper). Two advertised listeners (`HOST` for apps on the machine, `DOCKER` for Kafka UI) because a client reconnects to whatever address the broker advertises, which must be reachable from the client's side. |

## Plant time is not the Kafka timestamp

Every record has a Kafka timestamp, by default the producer's clock (`CreateTime`). The simulator's clock is plant time, which runs 40x faster than wall-clock time. Used as the record timestamp it would break time-based retention (records stamped in the future never expire) and Kafka 4 even rejects timestamps more than an hour ahead.

So the telemetry, status and events topics use `message.timestamp.type=LogAppendTime`: the broker stamps wall-clock append time, and retention behaves normally. Plant time lives in the payload, in each record's `tick` and `plantTime` fields. Flink does not use it as watermarked event time (see "Event time" below); the LogAppendTime timestamp serves wall-clock windows. `plant.commands` and `plant.state` keep the default.

All records produced by one tick share one clock: every event, telemetry reading and the status from a single `tick()` call carry the same `tick` and `plantTime`, those of the state after the tick (the post-advance clock while running; the unchanged clock in handover or pause). So events join telemetry and status on `tick` exactly, e.g. a `trip` lines up with the readings that show it.

## Delivery semantics

- **Plant output (producer side): at-least-once.** If a tick's produce fails, the tick stays applied, its records are kept and all of them are resent until Kafka acknowledges. A retry can duplicate records that already got through (`SimRunner.step` and `resend`). Consumers must tolerate duplicates: de-duplicate events by per-game `seq`.
- **Commands (consumer side, group `desal-sim`).** After `eachMessage` returns, the offset is stored in the client; librdkafka commits stored offsets about every 5 s (`auto.commit.interval.ms`) and on clean disconnect. After a crash:
  - Commands applied after the last snapshot are lost: their effect is not in the snapshot (each game is saved every 30 ticks, and on shift end or a safety trip), and their offset may already be committed, so they are not replayed.
  - Commands inside the last uncommitted window are redelivered (at-least-once) and may be applied again.
  - A possible fix is to store the command offset inside the snapshot and seek to it on load, making state and position atomic.

## What consumers may rely on

This is the contract for anything reading the plant topics: the gateway today, Flink jobs next.

**Keys.** Every record on every topic is keyed by `gameId`, the game it belongs to (a UUID). The one exception is a
host event about a message the simulator could not attribute (an unparseable command), keyed by the all-zero id
`00000000-0000-0000-0000-000000000000`. A `plant.state` tombstone (null value) under a `gameId` means that game ended.

**Order per key.** Kafka orders records only within a partition, and equal keys always go to one partition, so within
one topic one game's records arrive in the order the simulator produced them. Nothing is promised across games, or
across topics.

**Produce order across topics.** Each simulator step sends one batch per topic in the order events, telemetry, status,
state. So on the broker, status N of a game is written after that game's telemetry N (and after the events of tick N),
and its snapshot comes last. That holds only for the order of writes. A consumer reading several topics gets each
topic-partition on its own schedule, so it can see status N before the last readings of tick N (the gateway's
`FrameAssembler` holds an incomplete frame until it completes or tick N+1 begins). Within one topic-partition, the
order is exactly the produce order.

**seq and epoch (events).** Each event has `seq`, a per-game counter that increases by one per event, and `epoch`, the
number of times the game has been restored from a snapshot. Delivery is at-least-once, so the same event can arrive
twice; de-duplicate on `(gameId, epoch, seq)`. After a crash the game resumes from its last snapshot: its `seq` and
`tick` can go back to the snapshot's values and repeat values already seen, but `epoch` is one higher. So when the
epoch goes up, reset whatever marks you keep for that game (last seq, last tick); records of an older epoch arriving
after a newer one are stale. Telemetry carries `epoch` and `tick` too and is only produced while a shift runs (one
reading per sensor per tick): de-duplicate it on `(gameId, epoch, tick, sensorId)`. Status also carries both, but it is
a latest-value stream, not a log: in handover and while paused the clock stands still and every step re-sends the
status with the same `tick`, so keep the newest rather than dropping repeats. Every tick that emits an event is
snapshotted (and a running game at least every 30 ticks), so a rewind is rare and short.

**Host events.** Events with `host: true` come from the simulator's game host, not from a plant: `gameRejected`
(capacity or duplicate) and `commandRejected` for a command it could not route (`no such game`, or an invalid
envelope). They have `seq` 0, `epoch` 0, `tick` 0 and a wall-clock `plantTime`, and are not part of the game's seq
order. Never de-duplicate them, never let them advance a game's marks. A host `commandRejected` with reason
`no such game` means the simulator holds no game with that id (it ended, or was lost): treat the game as over.

**Event time.** Flink jobs are keyed process functions over `gameId`, driven by `tick` and `seq`/`epoch`. They do not
use event-time watermarks on `plantTime`: plant time runs 40x faster than the wall clock and stops while a game is
paused or in handover, so a watermark on it would stall per game, and across games it means nothing. Within a game
`tick` already gives a total order of steps (every record of one step shares its `tick` and `plantTime`). Where a job
needs wall-clock windows, it uses the record timestamp, which is the broker's LogAppendTime.
