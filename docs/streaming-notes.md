# Streaming notes: Kafka concepts in this codebase

A map from Kafka concept to where it appears in the code and why it was done that way. Flink (Plan 3) builds on the same topics.

## Topics

Every record on every `plant.*` topic is keyed by `gameId` (the one simulator process runs many games). The four Flink
output topics are not: they hold no gameId except `shift.reports`, which only the gateway reads.

| Topic | Partitions | Key | Config | Written by |
| --- | --- | --- | --- | --- |
| `plant.telemetry` | 6 | `gameId` | LogAppendTime, 24 h and 256 MiB per partition retention | simulator |
| `plant.commands` | 1 | `gameId` | 24 h and 256 MiB retention | gateway (players), `send` CLI |
| `plant.events` | 1 | `gameId` | LogAppendTime, 7 days (kept for Flink) and 256 MiB per partition retention | simulator |
| `plant.status` | 1 | `gameId` | LogAppendTime, 1 h retention | simulator |
| `plant.state` | 1 | `gameId` | `cleanup.policy=compact`, `segment.ms=1h`, `min.cleanable.dirty.ratio=0.1` | simulator (one save per game; tombstone when it ends) |
| `shift.reports` | 1 | `gameId` | LogAppendTime, 7 days retention | created by the simulator; written by Flink (one report card per finished shift; read only by the gateway) |
| `run.results` | 1 | `runId` | `cleanup.policy=compact`, `retention.ms=-1` (kept forever), `segment.ms=1h`, `min.cleanable.dirty.ratio=0.1` | created by the simulator; written by Flink (one result per finished run) |
| `leaderboard` | 1 | one key | `cleanup.policy=compact`, `segment.ms=1h`, `min.cleanable.dirty.ratio=0.1` | created by the simulator; written by Flink (the current boards) |
| `run.ranks` | 1 | `runId` | `cleanup.policy=compact`, `segment.ms=1h`, `min.cleanable.dirty.ratio=0.1` | created by the simulator; written by Flink (each run's current rank; read only by the gateway) |

`ensureTopics` creates all nine, so the Flink output topics exist with the right shape before any Flink job starts, and
`waitForTopics` waits for all nine.

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

**Keys.** Every record on every plant topic is keyed by `gameId`, the game it belongs to (a UUID). The one exception is a
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

## Chaos events, shifts and money

This is the contract for the events a shift produces, as Plan 5's Flink jobs will read them from `plant.events`. Field names and types are those of `packages/schema/src/events.ts`, `status.ts` and `commands.ts`; if this page and the schema disagree, the schema wins. Every event below also carries the base fields (`gameId`, `epoch`, `seq`, `tick`, `plantTime`, `shiftId`) and follows the `seq`/`epoch` rules above.

### The shift and its events

A shift is 720 ticks (480 plant minutes). The simulator draws each shift's plan from the game's seed when the previous shift ends (shift 1's when the game is created), so the handover orders can describe it; `startShift` activates the drawn plan, and its `shiftStart` carries those orders. A plan holds 1 or 2 events in a normal shift and 4 to 6 in a hell shift. A director fires them over the shift, so the same seed always gives the same plan. Plant minute 0 is the shift's first tick; nothing fires after minute 420.

| Event | When it is emitted | Fields |
| --- | --- | --- |
| `shiftStart` | Once, when the player starts a shift. | `scenarioId` (string), `mode` (`auto` or `manual`), `target` (`productM3`, `maxSalinityPpm`, `fuelBudgetUsd`, all numbers), `hell` (boolean), `orders` |
| `scenario` | When the director fires an event. | `eventId` (integer, 1 or more, unique within the shift), `kind`, `message` (string), `radio` (string, the line the player hears) |
| `eventCleared` | When a fired event is dealt with. | `eventId`, `kind`, `how` |
| `shiftEnd` | Once, when the shift's clock runs out. | `summary`, `runId` (see "Runs" below) |

`orders` is `{ targetM3, maxSalinityPpm, budgetUsd, lines: string[], briefing: string[] }`. `budgetUsd` is the shift's fuel guidance (`target.fuelBudgetUsd`), not the allocation credited to the account. `briefing` has lines only on shift 1; `lines` is the foreman's note. On a hell shift, `target.productM3` is 85 % of the normal target (rounded). `hell` is true for the whole shift even when the orders did not warn of it.

`kind` is one of: `bloom`, `seawaterTemp`, `pumpBearing`, `gasCurtailNotice`, `gasPriceSpike`, `offgradeOnly`, `deliveryDelay`, `demandChange`, `controllerFault`, and the six sharp kinds `pumpTrip`, `tubeLeak`, `vacuumLoss`, `powerDip`, `storm`, `sensorFailure`, plus `lowSteam` (low motive steam to the ejectors: player-fixed, not sharp, and planned on its own salted substream from shift 2, at most one per shift, so every other event keeps its draw). No event says that a sensor failed: the `sensorFailure` scenario event is the only record of it, the player sees only the reading's behaviour.

`eventId` joins a `scenario` to its `eventCleared` and to the `events` list of the `shiftEnd` summary. It restarts at 1 every shift, so key on (`shiftId`, `eventId`). `atMinute` in the summary is a plant minute and may be fractional. A fired event that is never cleared has no `eventCleared`; it shows in the summary with `cleared: false` and `how: null`.

`how` in `eventCleared` is one of:

- `player`: the player's own action fixed it (a pump restarted, a loop put in Manual, chlorine dosed up, the standby steam line switched on).
- `crew`: a `dispatchCrew` job finished (tube leak, vacuum loss, sensor failure, storm screens).
- `expired`: it ended by itself (a storm that passed).
- `noted`: a kind that needs no response (`seawaterTemp`, `gasCurtailNotice`, `gasPriceSpike`, `offgradeOnly`, `deliveryDelay`, `demandChange`, `pumpBearing`). Its `eventCleared` follows its `scenario` at once, in the same tick.

In hell shifts a fired event can queue another (cascades): a storm may bring a bloom, a power dip a sensor failure, a pump trip a bearing fault. The follow-up is a normal `scenario` with its own `eventId`; nothing in the events says it was a cascade. At most 7 events fire in one shift.

The `shiftEnd` summary is:

`productM3` (in-spec water only), `targetM3`, `offSpecMinutes`, `offSpecM3`, `fuelCostUsd`, `fuelBudgetUsd`, `trips`, `spentUsd`, `nextAllocationUsd`, `balanceUsd` (all numbers); `damage` (`maxHardScaleMm`, `pumpWear` as a record of pump id to number, `burnerCondition`); `hell` (boolean); `events`, a list of `{ eventId, kind, atMinute, cleared, how }` where `how` is the values above or null.

The examples below are real output: shift 2 of a game on host seed 3, played by the engaged test bot (`services/simulator/test/bot.ts`), with long fractions rounded. The shift had a vacuum loss (eventId 1) and then a tube leak (eventId 2), both fixed by the crew. For the six sharp kinds, `message` is the radio line.

Example `scenario`:

```json
{
  "gameId": "8f14e45f-ceea-467a-9575-1f2b0c6e4a11",
  "epoch": 0, "seq": 23, "tick": 1009, "plantTime": 40360000, "shiftId": 2,
  "type": "scenario",
  "eventId": 2,
  "kind": "tubeLeak",
  "message": "Control, salt's showing in the product — tube leak near stage 18, about +8.32 ppm!",
  "radio": "Control, salt's showing in the product — tube leak near stage 18, about +8.32 ppm!"
}
```

Example `eventCleared`:

```json
{
  "gameId": "8f14e45f-ceea-467a-9575-1f2b0c6e4a11",
  "epoch": 0, "seq": 26, "tick": 1100, "plantTime": 44000000, "shiftId": 2,
  "type": "eventCleared",
  "eventId": 2,
  "kind": "tubeLeak",
  "how": "crew"
}
```

Example `shiftStart` (shift 2 has no briefing):

```json
{
  "gameId": "8f14e45f-ceea-467a-9575-1f2b0c6e4a11",
  "epoch": 0, "seq": 15, "tick": 721, "plantTime": 28840000, "shiftId": 2,
  "type": "shiftStart",
  "scenarioId": "shift-2",
  "mode": "auto",
  "target": { "productM3": 4056, "maxSalinityPpm": 25, "fuelBudgetUsd": 12480 },
  "hell": false,
  "orders": {
    "targetM3": 4056, "maxSalinityPpm": 25, "budgetUsd": 12480,
    "lines": ["Seawater is 29.5 °C with chlorophyll at 1.2 µg/L."],
    "briefing": []
  }
}
```

Shift 1's `orders` carry the briefing:

```json
{
  "targetM3": 3900, "maxSalinityPpm": 25, "budgetUsd": 12000,
  "lines": ["Seawater is 30.0 °C with chlorophyll at 1.0 µg/L."],
  "briefing": [
    "Deliver 3,900 m³ of in-spec water this shift.",
    "Keep product salt under 25 ppm — diverted or off-spec water doesn't count.",
    "Click a monitor to act on it, and watch the fuel budget ($12,000)."
  ]
}
```

Example `shiftEnd`:

```json
{
  "gameId": "8f14e45f-ceea-467a-9575-1f2b0c6e4a11",
  "epoch": 0, "seq": 31, "tick": 1440, "plantTime": 57600000, "shiftId": 2,
  "type": "shiftEnd",
  "runId": "3b9d6f0e-51c2-4d7a-9f3e-2a8c1d4e6b70",
  "summary": {
    "productM3": 4163.88, "targetM3": 4056, "offSpecMinutes": 0, "offSpecM3": 0,
    "fuelCostUsd": 9829.24, "fuelBudgetUsd": 12480, "trips": 0,
    "spentUsd": 12349.24, "nextAllocationUsd": 10340, "balanceUsd": 13373.09,
    "damage": { "maxHardScaleMm": 0.0000931, "pumpWear": { "P-101": 0.003168, "P-102": 0.003168, "P-103": 0 }, "burnerCondition": 0.97984 },
    "hell": false,
    "events": [
      { "eventId": 1, "kind": "vacuumLoss", "atMinute": 132, "cleared": true, "how": "crew" },
      { "eventId": 2, "kind": "tubeLeak", "atMinute": 192, "cleared": true, "how": "crew" }
    ]
  }
}
```

`spentUsd` counts fuel, deliveries, repairs, crew jobs and the standing cost (here $9,829 fuel + $1,800 crew + $720 standing).

### Runs: call sign and runId

A run is one game from `startGame` to `gameEnd`. At `startGame` the simulator gives it two names, both kept in the
game's state and its snapshot:

- `callSign`: the run's public name, e.g. `Kestrel-42` (one of 64 bird and weather words, then a number from 10 to
  99), derived from the game seed (`callSignFor` in `services/simulator/src/callsign.ts`). Call signs need not be
  unique. It is on `gameStart`, on `gameEnd` and at the top level of every `plant.status` record.
- `runId`: a random UUID minted by the game host (`GameHost`, option `newRunId`). It is on `gameEnd` and on every
  `shiftEnd`, and nowhere else. Flink keys `run.results` and `run.ranks` by it, so those topics and `leaderboard` never
  contain a gameId.

**runId never reaches a browser.** The gateway reads it (to look up a finished run's rank in `run.ranks`) and strips it
from every event and leaderboard row before anything goes out over HTTP or WebSocket. In the schema it is optional on
`shiftEnd` and `gameEnd` for that reason; on Kafka the simulator always sets it.

### Account events

Every change to the balance is one `accountChange { deltaUsd, balanceUsd, cause }`. `cause` is one of:

- `allocation`: the budget paid in at shift start.
- `fuel`: part of the cause enum; gas burn is tracked in the shift summary, not as an `accountChange`.
- `delivery`: a backup fuel order, charged when it is placed.
- `acidClean`: the acid clean.
- `overhaul`: a pump overhaul.
- `crew`: a `dispatchCrew` job, charged when it is accepted (not when it finishes).
- `standing`: staff and standby cost, $90 per plant hour. It is charged on every running tick, in any plant status (online, tripped, restarting), and reported as one `accountChange` with `deltaUsd: -90` per plant hour (90 ticks), not one per tick.

### The `dispatchCrew` command

`{ "type": "dispatchCrew", "job": "plugTubes" }`. There is one crew. A job is only accepted when its fault exists, and it is charged when accepted.

| Job | Cost (USD) | Plant minutes | Needs |
| --- | --- | --- | --- |
| `plugTubes` | 800 | 60 | a tube leak |
| `repairEjector` | 1000 | 45 | a failed ejector (vacuum loss) |
| `replaceSensor` | 400 | 30 | a failed sensor |
| `cleanScreens` | 300 | 30 | a storm's fouled screens |

A rejected dispatch produces a `commandRejected` event with one of these `reason` values: `not running` (the shift is not running), `crew busy` (a job is already in progress), `nothing to repair` (its fault does not exist), `stale shift` (the envelope's `shiftId` is not the current shift). The crew and the shift's faults are cleared at the next shift start, so a job never carries over.

### Status fields

`plant.status` gained these fields (`status.ts`):

- `callSign`: the run's call sign (see "Runs" above).
- `shiftProductM3`, `shiftOffSpecM3`: in-spec and off-spec water made so far this shift (numbers).
- `productFlowM3h`: current product flow (number).
- `crew`: `{ job, remainingTicks }` while a job runs, else null.
- `orders`: the pending orders in handover, the active ones while running, else null. Same shape as `shiftStart.orders`.
- `divertMode`: `auto` or `manual`. `divertToDrain` stays, and is now the valve's direction (set by the player in Manual, by the plant in Auto). Older records without it read as `manual`.
- `standbySteam`: whether the standby steam line is on (boolean, default false); it holds the motive steam at 14.5 bar.
- `hell`: the active shift's hell flag while the shift is running, and null in every other phase (handover, paused, over). It is null in handover on purpose, so an unwarned hell shift cannot be seen in advance.

### Plant-realism commands and telemetry

- `setDivertMode { mode }` (`auto` or `manual`) changes only the mode; the valve keeps its position until Auto's next decision. `divertToDrain { on }` sets Manual and the valve.
- `standbySteam { on }` switches the standby steam line. It clears an active `lowSteam` with `how: 'player'`.
- Neither command has refusals of its own; the usual envelope refusals (invalid, game over, handover, stale shift) apply.
- Telemetry gains `vacuum.motiveSteamBar` (unit `vacuum`, no loop), emitted right after `vacuum.quality`: 128 readings per tick.

### Operating point

Nominal TBT is 93.5 degC. The TBT setpoint range is 85 to 112 degC. The high-high trip (`tbtHighHigh`) is at 115 degC. Scale grows fast above 105 degC, and the hard scale starts there too.

### Snapshots

The snapshot version is 7. The pending and active plan, the director's position and the crew job are in it, so a restart in the middle of a shift replays the same events. Older saves are migrated one version at a time (`restore` in `services/simulator/src/snapshot.ts`):

- v3 -> v4: game mode `normal`, disaster flags and the fuel contamination and tsunami faults defaulted.
- v4 -> v5: the 20-stage plant resampled to the 24-stage layout, with a balanced makeup loop.
- v5 -> v6: `callSign` derived from the save's seed and a fresh `runId`, so a run that was in flight at the upgrade
  reports its result under a new runId.
- v6 -> v7: divert mode `manual` (restored games keep the latch), motive steam 14.5 bar, standby line off, no lowSteam fault.

Version 2 (and 1) saves are skipped with a log line, as v1 was; games in flight at the upgrade end.
