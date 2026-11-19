# Streaming notes: Kafka concepts in this codebase

A map from Kafka concept to where it appears in the code and why it was done that way. Flink (Plan 3) builds on the same topics.

## Topics

| Topic | Partitions | Key | Config | Written by |
| --- | --- | --- | --- | --- |
| `plant.telemetry` | 6 | `sensorId` | LogAppendTime, 24 h and 256 MiB per partition retention | simulator |
| `plant.commands` | 1 | `plant-1` | defaults | `send` CLI (and later the app) |
| `plant.events` | 1 | `plant-1` | LogAppendTime | simulator |
| `plant.status` | 1 | `plant-1` | LogAppendTime, 1 h retention | simulator |
| `plant.state` | 1 | `plant-1` | `cleanup.policy=compact` | simulator (career save) |

## Concept to code

| Concept | Where | Why |
| --- | --- | --- |
| Topics and partitions | `SPECS` in `services/simulator/src/kafka/client.ts` | Telemetry (~108 msgs/s, most of the traffic) gets 6 partitions so a consumer (Flink) can process sensors in parallel; the low-volume topics get 1. |
| Message keys and ordering | `tickRecords` in `src/kafka/runner.ts`; `src/cli/send.ts` | Kafka hashes the key to a partition, and order is only guaranteed within a partition. Keying telemetry by `sensorId` keeps each sensor's readings in order. Events and status use one key and one partition, so they have one total order. |
| One-partition command log | `plant.commands` in `SPECS`; `send.ts` | A single partition gives operator actions one total order, so replaying them reproduces the plant history. The key is set anyway so adding plants later stays correct. |
| Consumer groups and committed offsets | `commandsGroup()` and `kafkaIO` in `src/kafka/runner.ts` | The group `desal-sim` is where Kafka stores the simulator's read position in `plant.commands`; after a restart it continues after the last committed command. |
| Throwaway groups | `src/cli/watch.ts`, `readToEnd` in `src/kafka/read.ts` | A fresh random group id per watcher means every watcher sees every record (consumers in one group split the partitions instead). They commit nothing and delete the group on exit so it does not clutter Kafka UI. |
| `fromBeginning` and seeking | `kafkaIO.start`, `readToEnd` | A new group has no committed offset, so its start position is chosen explicitly: pinned to the topic end for commands (avoids a race with the partition assignment), or beginning / last record for readers. |
| Reading to the current end | `readToEnd` in `src/kafka/read.ts` | Topics never end, so the reader captures each partition's high-water mark first and stops once it has delivered the record just below it. |
| Log compaction (career save) | `plant.state` in `SPECS`; `loadCareer`, `snapshotRecord` in `runner.ts` | Compaction keeps the latest value per key, so the topic holds the current state and is never deleted by age. Older snapshots can linger until the cleaner runs, so `loadCareer` reads to the end and takes the newest value for `plant-1` that restores (`pickCareer`), falling back past invalid ones and logging the skip. The fallback only works while older records survive compaction, so `snapshotRecord` also validates every save before producing it and refuses to write an invalid one. A null value (tombstone) as the newest record means no career. |
| Retention | `SPECS` (telemetry, status) | Time and size limits delete the oldest segments, whichever limit is hit first; this keeps a shared server's disk bounded. |
| Timestamp type: LogAppendTime, plant time in payload | `LOG_APPEND_TIME` in `client.ts`; `tickRecords` in `runner.ts` | Plant time runs 40x ahead of wall clock, so it cannot be the record timestamp. The broker stamps append time; event time is the payload's `plantTime`, which Flink will use. See below. |
| Idempotent topic creation | `ensureTopics` in `client.ts`; `src/main.ts` | `createTopics` does not throw when a topic exists, so calling it at every start is safe. Auto-creation is disabled in the broker (`KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"` in `infra/docker-compose.yml`) so a typo in a topic name fails loudly. It does not reconcile configs of existing topics; use `kafka-configs.sh --alter` (the command is in the comment above `ensureTopics`). |
| Producer failure handling | `kafkaIO`, `SimRunner.produce` in `runner.ts` | `message.timeout.ms` is capped at 5 s so a dead broker shows up quickly as a failed send; the runner then freezes the plant and resends. Non-retriable produce errors (`isNonRetriableProduceError`: message too large, invalid record, auth) are not an outage: the runner halts, attempts a final snapshot, and the process exits 1. |
| Topic-name suffix for tests | `topicName` in `client.ts`; `commandsGroup` in `runner.ts` | `DESAL_TOPIC_SUFFIX` gives integration tests their own topics and consumer group, so they cannot touch the real career or trigger rebalances in the real simulator's group. |
| KRaft and listeners | `infra/docker-compose.yml` | One node is broker and controller (no ZooKeeper). Two advertised listeners (`HOST` for apps on the machine, `DOCKER` for Kafka UI) because a client reconnects to whatever address the broker advertises, which must be reachable from the client's side. |

## Plant time is not the Kafka timestamp

Every record has a Kafka timestamp, by default the producer's clock (`CreateTime`). The simulator's clock is plant time, which runs 40x faster than wall-clock time. Used as the record timestamp it would break time-based retention (records stamped in the future never expire) and Kafka 4 even rejects timestamps more than an hour ahead.

So the telemetry, status and events topics use `message.timestamp.type=LogAppendTime`: the broker stamps wall-clock append time, and retention behaves normally. The event time lives in the payload, in each record's `plantTime` field. That field is what Flink will use as event time (with watermarks), not the Kafka timestamp. `plant.commands` and `plant.state` keep the default.

All records produced by one tick share one clock: every event, telemetry reading and the status from a single `tick()` call carry the same `tick` and `plantTime`, those of the state after the tick (the post-advance clock while running; the unchanged clock in handover or pause). So events join telemetry and status on `tick` exactly, e.g. a `trip` lines up with the readings that show it.

## Delivery semantics

- **Plant output (producer side): at-least-once.** If a tick's produce fails, the tick stays applied, its records are kept and all of them are resent until Kafka acknowledges. A retry can duplicate records that already got through (`SimRunner.step` and `resend`). Consumers must tolerate duplicates.
- **Commands (consumer side).** After `eachMessage` returns, the offset is stored in the client; librdkafka commits stored offsets about every 5 s (`auto.commit.interval.ms`) and on clean disconnect. After a crash:
  - Commands applied after the last snapshot are lost: their effect is not in the snapshot (saved every 30 ticks, and on shift end or a safety trip), and their offset may already be committed, so they are not replayed.
  - Commands inside the last uncommitted window are redelivered (at-least-once) and may be applied again.
  - A possible fix is to store the command offset inside the snapshot and seek to it on load, making state and position atomic.
