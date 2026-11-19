# Plan 2: Many Games, Run Economy, Gateway. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-career simulator into a public, many-games backend. Each visitor's game is a run of shifts with an operating account and game-over rules. A WebSocket gateway lets a browser (Plan 3) or a terminal client start a game, send commands, and receive live frames, status and events. Everything is deployed to desal.moosha.org.

**Architecture:** The pure `tick(state, commands)` stays per plant. A new pure `GameHost` holds many `PlantState`s keyed by `gameId`, routes commands, enforces the concurrency cap and ends abandoned games. The Kafka runner drives the host at 1 Hz. Every topic is keyed by `gameId`. A new `services/gateway` (Node, `ws`) fans the topics out to WebSocket clients, using its own per-instance consumer group, and turns client messages into command envelopes. Caddy routes `/ws` to the gateway publicly. Kafka UI stays at `/` behind basic auth until Plan 3 brings the UI.

**Tech Stack:** As Plan 1 (Node ≥ 22, TypeScript ESM, pnpm, zod 4, vitest, `@confluentinc/kafka-javascript`), plus `ws` (WebSocket server and client).

**Spec:** `docs/superpowers/specs/2026-11-18-desal-operator-game-design.md`. It was updated on 2026-11-18 with: one-sitting runs, many games, the operating account, game over, and public access.

**Starts from:** Plan 1 merged, including its final-review fix wave. That wave brings: `KAFKA_LOG_DIRS`, per-shift reset of gas and faults, a uniform post-tick stamp on every record of a tick, the restart stall timeout, the runner crash guard, snapshot validation and fallback.

**Milestone map:** Plan 3 is the control-room UI (wall, zoom, controls, handover, debrief, game-over screen), served at `/`, with Kafka UI moved behind auth. Plan 4 is the Flink jobs (alarms, KPIs, debrief and handover reports). Running Flink needs a decision about server memory. Plan 5 is balancing and polish.

## Global Constraints

- 1 tick = 1 real second = 40 plant seconds. A shift is 720 ticks. There are 20 stages, pumps P-101 and P-102 on duty, and P-103 on standby. The core stays deterministic: all randomness comes from the state's seed. **Wall-clock time is only read in the host's liveness check, never in `tick()`.**
- **One game = one run of shifts in one sitting.** A game is never saved for a visitor to continue later. Snapshots exist only so a simulator restart can resume games that were live.
- **Every message carries `gameId`** (UUID v4), and **`gameId` is the Kafka key on every topic.** One game's records then stay ordered on one partition, and Flink later uses `keyBy(gameId)`.
- **Concurrency cap: 10 live games** (`MAX_GAMES`). Over the cap, `startGame` is answered with `gameRejected{reason:'capacity'}`.
- **Liveness:** a game with no command or heartbeat for **90 s of wall time** ends with reason `abandoned`. The gateway sends `heartbeat` every 15 s per connected game, and a reconnecting client resumes within that window.
- **Operating account** (spec §3.1; the numbers are tunable placeholders, kept in `constants.ts`):
  - Start balance: `START_BALANCE_USD = 40000`.
  - Revenue: `REVENUE_PER_M3 = 3`, earned on water delivered in spec while online.
  - Off-spec fine: `OFFSPEC_FINE_PER_M3 = 10`, charged on water delivered off-spec.
  - Shortfall fine: `SHORTFALL_FINE_PER_M3 = 4`, charged on m³ short of target at shift end.
  - Fuel:
    - Gas is charged per tick as it burns.
    - Backup fuel is charged in full when ordered, at `tonnes × LHV(grade) × backup price`, so burning backup fuel costs nothing per tick.
    - The initial 200 t of backup fuel is free.
  - Repairs: `ACID_CLEAN_COST_USD = 6000`, charged when acid cleaning starts. `PUMP_OVERHAUL_COST_USD = 8000`, charged when an overhaul starts.
- **Game over** (each check happens once per tick, after the plant step):
  - `bankrupt`: balance < 0 at a shift end.
  - `outOfFuel`: gas cap is 0, backup tank is 0, no delivery is pending, and the balance is below the cost of 1 t of the currently offered grade.
  - `burnerFailed`: burnerCondition ≤ 0.
  - `noIntakePumps`: every pump has wear ≥ 1 or is under overhaul.
  - `quit`, from the player.
  - `abandoned`, from liveness.

  After game over, `phase` becomes `'over'`. The final `gameEnd{reason, score}` is emitted and the game is removed from the host.
- **Final score** = `{ shiftsCompleted, totalProductM3, balanceUsd }`, ranked in that order.
- **Difficulty:** shift `n` target = `3900 × (1 + 0.04 × (n − 1))` m³ with no cap. Shifts 1–3 keep their hand-written scenarios. For shift ≥ 4, the procedural scenario draws `min(2 + floor((n − 4) / 2), 8)` events, and event severity scales with `n`.
- Every record emitted in one tick for one game has the same `tick` and `plantTime`. Events also carry a per-game monotonically increasing `seq`, so downstream consumers can de-duplicate the at-least-once deliveries.
- The producer is idempotent (`enable.idempotence=true`).
- Kafka concept comments: wherever a key, consumer group, offset choice, tombstone or idempotence setting is chosen, write 1–3 lines explaining *why*.

## Review Focus

1. **A client that disconnects and reconnects** with its `gameId` inside 90 s resumes the same game. After 90 s it gets `{t:'error', reason:'game ended'}` and the game has a `gameEnd{reason:'abandoned'}`. *Pinned in Tasks 8 and 9.*
2. **A command for a game that doesn't exist or has ended** (stale tab, forged gameId) is rejected with a `commandRejected`. It never creates a game and never crashes the host. *Pinned in Task 5.*
3. **Many games at once stay isolated.** Commands for game A never touch game B, and one game's thrown exception ends only that game (`gameEnd{reason:'error'}`), not the process. *Pinned in Task 5.*
4. **A malicious or broken WebSocket client** (non-JSON, huge messages, a flood of messages, more than one game per socket, unknown message types) cannot crash the gateway or exceed the cap. Messages over 16 KB close the socket. More than 20 messages/s per socket are dropped with an error. *Pinned in Task 8.*
5. **Running out of money mid-shift with an order pending** is not game over until the shift end (bankrupt is only checked at shift end). An unaffordable `orderFuel` or `acidClean` is rejected with reason `insufficient funds`. *Pinned in Tasks 3 and 4.*

---

## File Structure

```
packages/schema/src/
  commands.ts        + gameId on envelope; startGame, quitGame, heartbeat, overhaulPump; − newCareer
  events.ts          + gameId, seq on every event; gameStart, gameEnd, gameRejected, accountChange
  status.ts          + gameId, phase 'over', account, shiftNumber, deliveries, acidCleanRemainingTicks, restartAuto, pumps overhaul
  telemetry.ts       + gameId
  ws.ts              NEW  client↔gateway WebSocket protocol
  topics.ts          − PLANT_KEY (keys are gameIds now)
services/simulator/src/
  state.ts           + run: { gameId, balanceUsd, shiftNumber, totalProductM3, shiftsCompleted, eventSeq, over }
  economy.ts         NEW  revenue, fines, charges, affordability
  gameover.ts        NEW  game-over checks + score
  host.ts            NEW  GameHost: many plants, routing, cap, liveness
  commands.ts        new commands, affordability checks, − newCareer
  shift.ts           shiftNumber, shortfall fine at endShift
  scenario/library.ts uncapped difficulty
  tick.ts            economy + game-over + seq stamping
  emit.ts            status additions
  kafka/runner.ts    drives GameHost; per-game keys; snapshots per game + tombstones; loadGames
  main.ts            − --new-career
  cli/send.ts, cli/watch.ts  --game <id>
services/gateway/    NEW package @desal/gateway
  src/protocol.ts    validate client messages (uses @desal/schema ws.ts)
  src/sessions.ts    socket ↔ gameId, rate limits, heartbeats, frames
  src/kafka.ts       fan-out consumer, command producer
  src/server.ts      HTTP (/healthz) + WebSocket (/ws)
  src/main.ts
  src/cli/play.ts    terminal client
  Dockerfile
deploy/compose.yml, deploy/desal.caddy, scripts/deploy/deploy.sh, docs/hosting.md, docs/streaming-notes.md
```

---

### Task 1: Schema v2: gameId everywhere, game lifecycle messages

**Files:** Modify `packages/schema/src/{commands,events,status,telemetry,topics,index}.ts`. Create `packages/schema/src/ws.ts`. Tests: `packages/schema/test/{commands,events,status,ws}.test.ts`.

**Interfaces (produces):**
- **Command envelope:** `CommandEnvelopeSchema` = `{ commandId: uuid, issuedAt, gameId: uuid, shiftId: number|null, command }`.
- **Command set:**
  - New: `startGame{}`, `quitGame{}`, `heartbeat{}`, and `overhaulPump{pumpId}`.
  - Removed: `newCareer`.
  - `startShift{mode}` stays. It starts the next shift of the run.
- **Events:** every event has `{ gameId, seq: int ≥ 0, tick, plantTime, shiftId: number|null }`.
  - New events:
    - `gameStart{}`
    - `gameRejected{reason:'capacity'|'duplicate'}`
    - `gameEnd{reason: GameEndReason, score: GameScore}`
    - `accountChange{deltaUsd, balanceUsd, cause: 'revenue'|'fuel'|'delivery'|'acidClean'|'overhaul'|'offSpecFine'|'shortfallFine'}`
  - `accountChange` is emitted only for discrete charges (delivery, acidClean, overhaul, shortfallFine). Per-tick revenue, fuel and off-spec amounts are visible in status and telemetry instead, to avoid an event flood.
- **Score and end reasons:**
  - `GameScore = { shiftsCompleted, totalProductM3, balanceUsd }`.
  - `GameEndReason = 'bankrupt'|'outOfFuel'|'burnerFailed'|'noIntakePumps'|'quit'|'abandoned'|'error'`.
  - `ShiftSummary` gains `{ revenueUsd, finesUsd, balanceUsd }`.
- **Status:** `PlantStatusSchema` gains:
  - `gameId`, `shiftNumber`, `balanceUsd`
  - `phase` now includes `'over'`
  - `deliveries: {arrivesInTicks, tonnes, grade}[]`
  - `acidCleanRemainingTicks`, `restartAuto: boolean|null`
  - `pumps[id].overhaulRemainingTicks`
  - `offeredGrade: FuelGrade`
- **Telemetry:** `TelemetryReading` gains `gameId`.
- **Topics:** `TOPICS` is unchanged. `PLANT_KEY` is removed.
- `ws.ts` (client ↔ gateway):
  - `ClientMsgSchema`: `{t:'newGame'}` | `{t:'resume', gameId}` | `{t:'cmd', command: Command}` | `{t:'ping'}`
  - `ServerMsgSchema`: `{t:'game', gameId}` | `{t:'status', status}` | `{t:'frame', tick, plantTime, readings: Record<string, number>}` | `{t:'event', event}` | `{t:'error', reason}` | `{t:'pong'}`

- [ ] **Step 1: Failing tests.**
  - Envelope without a `gameId` is rejected.
  - `newCareer` is rejected.
  - Every event type round-trips with `gameId` and `seq`, and a negative `seq` is rejected.
  - `phase:'over'` is accepted.
  - `ws.ts`: each client and server message round-trips, and an unknown `t` is rejected.
- [ ] **Step 2: Run** `pnpm --filter @desal/schema test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. The simulator typecheck will now fail, which is expected; Task 2 fixes it. In this task, run only the schema package's typecheck.
- [ ] **Step 5: Commit** `feat(schema): gameId everywhere, game lifecycle and ws protocol`

---

### Task 2: Run state, per-game stamping, status additions

**Files:** Modify `services/simulator/src/{state,snapshot,shift,tick,emit,commands}.ts` and their tests. Test: `test/run.test.ts`.

**Interfaces:**
- `PlantState.run = { gameId: string; balanceUsd: number; shiftNumber: number; totalProductM3: number; shiftsCompleted: number; eventSeq: number; over: { reason: GameEndReason; atTick: number } | null }`.
  - `careerShiftCount` is replaced by `run.shiftNumber`.
  - `Phase` adds `'over'`.
  - `PlantStateSchema` mirrors it; the drift guard must stay green.
- `createInitialState(seed, startPlantTime, gameId)` sets `run.balanceUsd = START_BALANCE_USD`, with the other run fields at 0 or null.
- `tick()` stamps every emitted event with `gameId` and `seq = run.eventSeq++`, in emission order, and stamps every telemetry reading with `gameId`. Status carries the new fields.
- `startShift` increments `run.shiftNumber` and uses it for `shift.id` and for `scenarioForShift`. `endShift` adds `acc.productM3` to `run.totalProductM3` and increments `run.shiftsCompleted`.
- Remove `newCareer` handling from `applyCommand`, and reject an envelope whose `gameId` ≠ `run.gameId` with reason `'wrong game'`.

- [ ] **Step 1: Failing tests.**
  - Over a 3-tick run with a trip, the events' `seq` values are 0,1,2,… with no gaps.
  - All records of one tick share the same `gameId`, `tick` and `plantTime`.
  - Status validates against `PlantStatusSchema` with the new fields.
  - `shiftNumber` advances across two shifts.
  - A wrong-game envelope is rejected and the state is unchanged.
  - A snapshot round-trip still passes with the run fields.
- [ ] **Step 2–4:** Run (FAIL), implement, then run `pnpm test && pnpm typecheck` (PASS).
- [ ] **Step 5: Commit** `feat(sim): run state, per-game stamping and sequence numbers`

---

### Task 3: Operating account

**Files:** Create `services/simulator/src/economy.ts`. Modify `tick.ts`, `commands.ts`, `shift.ts`, `constants.ts`, `units/fuel.ts` (gas-only per-tick cost). Test: `test/economy.test.ts`.

**Interfaces:**
- Per-tick accounting:
  - `tickRevenue(deliveredM3: number, offSpec: boolean): { revenueUsd: number; fineUsd: number }`. Online only; the caller gates it.
  - `chargeGasPerTick` uses `stepFuel`'s cost only when `fuel.active === 'gas'`. Backup fuel costs 0 per tick.
- Charging for orders and repairs:
  - `backupOrderCostUsd(s, tonnes): number` = `tonnes × LHV(offeredGrade) × backup.priceUsdPerGJ`, where LHV is in GJ/t: 42.5 standard, 38 off-grade.
  - `charge(s, usd, cause): { state; event: accountChange }`.
- Commands:
  - `orderFuel`, `acidClean`: rejected `'insufficient funds'` if the balance is below the cost; otherwise charge, then act.
  - New `overhaulPump{pumpId}`:
    - Requires the pump to be stopped and not already under overhaul, and must be affordable.
    - Charges `PUMP_OVERHAUL_COST_USD` and sets `pumps[id].overhaulRemainingTicks = PUMP_OVERHAUL_TICKS (90)`.
    - While overhauling, the pump can't start (`pump start` is rejected `'under overhaul'`).
    - On completion, wear is 0, cavitation is 0, and `bearingWearMult` is 1.
    - `Pump` gains `overhaulRemainingTicks`.
- `endShift` charges the shortfall fine, `max(0, target − acc.productM3) × SHORTFALL_FINE_PER_M3`. `ShiftSummary` reports revenue, fines and balance.

- [ ] **Step 1: Failing tests.**
  - An untouched shift 1 in Auto ends with balance > `START_BALANCE_USD`, i.e. it is profitable. Log the delta in the test output.
  - Off-spec water is fined and earns nothing.
  - Burning backup fuel costs 0 per tick, while ordering it costs `tonnes × 42.5 × 14` for standard.
  - An unaffordable `orderFuel` is rejected `'insufficient funds'` and leaves the balance unchanged.
  - Overhaul: rejected while the pump runs; charges $8,000; the pump can't start for 90 ticks; wear is reset at the end.
  - A shift ending 500 m³ short is fined $2,000.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): operating account, repairs and fines`

---

### Task 4: Game over and difficulty

**Files:** Create `services/simulator/src/gameover.ts`. Modify `tick.ts`, `scenario/library.ts`, `commands.ts` (`quitGame`). Test: `test/gameover.test.ts`, `test/scenario/difficulty.test.ts`.

**Interfaces:**
- `checkGameOver(s: PlantState, atShiftEnd: boolean): GameEndReason | null` implements the Global Constraints rules. `bankrupt` is checked only when `atShiftEnd`.
- `tick()` behaviour:
  - Runs the check after the plant step and after `endShift`.
  - On a hit: sets `run.over`, sets `phase = 'over'`, and emits `gameEnd{reason, score}` (stamped like other events).
  - In phase `'over'`, `tick()` returns only status and does not advance.
- `quitGame` (allowed in any phase except `'over'`) ends the game with reason `quit`.
- `scoreOf(s): GameScore`.
- Difficulty: `scenarioForShift(n, seed)` uses the uncapped target formula and the event-count and severity rule from Global Constraints. Severity examples:
  - Bloom peak `6 + 0.5·n` µg/L.
  - Curtailment cap `max(0, 40 − 3·n)` MW.
  - Price spike `1.2 + 0.05·n`.
  - Controller faults appear from shift 5.

- [ ] **Step 1: Failing tests.**
  - Each reason triggers on its own, and `bankrupt` triggers only at shift end (Review Focus 5).
  - After game over, `tick()` doesn't advance plant time, and exactly one `gameEnd` is emitted.
  - `quitGame` gives `gameEnd{reason:'quit'}` with the correct score.
  - Shift 10's target is 3900 × 1.36, and its event count is 5.
  - **Runs end:** an untouched Auto run, starting shifts automatically at each handover, reaches game over within 40 shifts. This is a seeded simulation of up to 28,800 ticks. If it is too slow, cap it with a smaller scenario multiplier in the test and note it.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): game over, final score, escalating difficulty`

---

### Task 5: GameHost (many plants, pure)

**Files:** Create `services/simulator/src/host.ts`. Test: `test/host.test.ts`.

**Interfaces:**
- `class GameHost`:
  - `constructor(opts?: { maxGames?: number (10); idleMs?: number (90000) })`
  - `games(): ReadonlyMap<string, { state: PlantState; lastSeenMs: number }>`
  - `restore(states: PlantState[], nowMs: number): void`
  - `step(envelopes: unknown[], nowMs: number): HostTick` → `{ perGame: Map<gameId, { telemetry, status, events, snapshotDue }>, ended: string[], hostEvents: PlantEvent[] }`
- Envelope routing:
  - Envelopes are parsed with `CommandEnvelopeSchema`. An unparseable envelope gives a host-level `commandRejected` with gameId `'00000000-0000-0000-0000-000000000000'`.
  - `startGame` for a new `gameId` creates `createInitialState(seed, nowMs, gameId)`, where the seed comes from a host RNG seeded at construction. It emits `gameStart`.
  - `startGame` at the cap gives `gameRejected{reason:'capacity'}`. A `startGame` for an existing id gives `'duplicate'`.
  - Any other command for an unknown `gameId` gives `commandRejected{reason:'no such game'}` and creates nothing.
  - `heartbeat` only refreshes `lastSeenMs`. So does every other command.
- Each tick:
  - Every game is ticked with its own commands.
  - A game whose `nowMs − lastSeenMs > idleMs` is ended with reason `abandoned`, via the same path as `quitGame`.
  - A game whose `tick()` throws is ended with reason `'error'` (`gameEnd` is emitted from the last good state). The other games continue.
  - Games in phase `'over'` are listed in `ended` and removed after their final records are returned.

- [ ] **Step 1: Failing tests (Review Focus 2, 3).**
  - Two games are isolated: a command to A doesn't change B.
  - The 11th `startGame` is rejected with `capacity`.
  - A duplicate `startGame` is rejected.
  - A command to an unknown game is rejected and creates nothing.
  - A game that hasn't been heard from for 90 s is ended `abandoned`; a heartbeat at 89 s keeps it alive.
  - Injecting a throwing game (e.g. a state with `stages: []`) ends only that game with `'error'`.
  - `restore` then `step` continues the restored games.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): GameHost for many concurrent games`

---

### Task 6: Runner on GameHost, per-game keys, tombstones, idempotent producer

**Files:** Modify `services/simulator/src/kafka/{runner,client}.ts`, `src/main.ts`, `src/cli/{send,watch}.ts`. Tests: `test/kafka/runner.test.ts` (fake `SimIO`), `test/kafka/runner.int.test.ts`.

**Interfaces:**
- `SimRunner(io, host)` drives `host.step(queue, Date.now())` every 1,000 ms, with the same non-overlap, kafkaDown and crash-guard behaviour as Plan 1.
- **Records:**
  - Every record is keyed by `gameId`.
  - Per game, per tick, the order is events → status → telemetry, and snapshots go to `plant.state` keyed by `gameId`.
  - When a game ends, a **tombstone** (`value: null`) is produced to `plant.state` for its `gameId`. The comment explains how compaction then deletes it.
- **Loading on start:** `loadGames(kafka): Promise<PlantState[]>` reads `plant.state` to the high-water mark, keeps the latest valid value per key, drops tombstoned keys, and drops games already `'over'`.
  - On start, the runner calls `host.restore(games, Date.now())`. Restored games get a fresh `lastSeenMs`, so a reconnecting client has the full 90 s.
  - `--new-career` is removed.
- **Topics:** the producer config adds `'enable.idempotence': true`, with a comment. `plant.state` gets `segment.ms = 3600000` and `min.cleanable.dirty.ratio = 0.1` so tombstones and old snapshots compact promptly (comment). `ensureTopics` documents the `--alter` for existing topics.
- **CLI:** `send --game <id> '<command json>'` reads that game's latest status for `shiftId`. `send --new` sends `startGame` with a fresh uuid and prints it. `watch [events|status|telemetry <sensorId>] [--game <id>]`.

- [ ] **Step 1: Failing tests.**
  - Unit (fake IO): records are keyed by `gameId`; an ended game produces a tombstone; a produce failure freezes all games, then resumes.
  - Int (suffixed topics):
    - Two games started via `startGame` both produce status keyed by their ids.
    - After a runner restart both resume (`loadGames`).
    - `quitGame` produces `gameEnd` and a tombstone.
    - After a further restart, the quit game is not restored.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS). Update the integration tests from Plan 1 that used `PLANT_KEY`.
- [ ] **Step 5: Manual smoke** against local real topics:
  - `send --new` → `watch status --game <id>` shows handover.
  - `send --game <id> '{"type":"startShift","mode":"auto"}'` → running.
  - Stop and restart the simulator; the game resumes.
  - `send --game <id> '{"type":"quitGame"}'` → `gameEnd`.
- [ ] **Step 6: Commit** `feat(sim): Kafka runner on GameHost with per-game keys and tombstones`

---

### Task 7: Gateway: Kafka side

**Files:** Create the `services/gateway` package (`package.json` `@desal/gateway`, `tsconfig.json`, vitest configs), `src/kafka.ts`, `src/frames.ts`. Test: `test/frames.test.ts`, `test/kafka.int.test.ts`.

**Interfaces:**
- `frames.ts`: `FrameAssembler`.
  - `add(reading: TelemetryReading): Frame | null` accumulates readings per `(gameId, tick)`.
  - It emits a completed `{t:'frame', tick, plantTime, readings}` as soon as a reading with a *newer* tick arrives for that game, or when `flush(gameId)` is called (status arrival for that tick flushes).
  - It keeps at most 2 open ticks per game.
- `kafka.ts`: `GatewayKafka`.
  - `start(onRecord: (topic, gameId, value) => void)` subscribes to telemetry, status and events with **consumer group `desal-gateway-${instanceId}`** (random per process), starting from the latest offset. The comment explains why every gateway instance needs every record (fan-out). It contrasts this with the simulator's shared `desal-sim` group (work sharing), and why the group is deleted on shutdown.
  - `sendCommand(env: CommandEnvelope)` produces to `plant.commands` keyed by `gameId`.
  - `latestStatus(gameId)` comes from an in-memory map updated by the consumer, and is used for `shiftId` and resume.
  - Uses the `topicName` suffix convention (copy the 3-line helper; don't import the simulator).

- [ ] **Step 1: Failing tests.**
  - Unit: the assembler emits a frame on the tick change and on flush, never mixes games, and is bounded.
  - Int: a fake producer writes status, events and telemetry for two games; `onRecord` receives them with the right gameIds; `sendCommand` lands on `plant.commands` keyed by `gameId`.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(gateway): Kafka fan-out consumer and frame assembly`

---

### Task 8: Gateway: sessions and WebSocket server

**Files:** Create `services/gateway/src/{protocol,sessions,server,main}.ts`. Test: `test/sessions.test.ts`, `test/server.test.ts`.

**Interfaces:**
- `Sessions`. It is pure-ish, with an injected `send(cmd)` and clock.
  - `open(socketId)`
  - `onClient(socketId, raw: string)`:
    - Rejects messages over `MAX_MSG_BYTES = 16384` (close), non-JSON (error), and messages over `MAX_MSGS_PER_S = 20` (error, drop).
    - `newGame`:
      - Allowed once per socket.
      - Generates a gameId, sends a `startGame` envelope, and binds the socket to the game.
      - Replies `{t:'game', gameId}` once `gameStart` arrives. On `gameRejected` it replies `{t:'error', reason:'capacity'}`.
    - `resume{gameId}` binds the socket if the gateway has seen a status for that game in the last 90 s, else replies `{t:'error', reason:'game ended'}`.
    - `cmd{command}`:
      - Requires a bound game.
      - Builds the envelope (uuid, now, gameId, `shiftId` from `latestStatus`) and sends it.
      - Rejects `startGame` and `heartbeat` from clients, since the gateway owns those.
    - `ping` → `pong`.
  - `close(socketId)` unbinds the socket. Heartbeats then stop, so the simulator ends the game after 90 s unless a socket resumes it.
  - `everyHeartbeat()` sends a `heartbeat` for each game with at least one bound socket. `server.ts` runs it every 15 s.
  - `onRecord(topic, gameId, value)` routes to that game's sockets: status → `{t:'status'}` (also flushes the frame), events → `{t:'event'}`, telemetry via `FrameAssembler`. `gameEnd` is forwarded, and then the game is unbound.
- `server.ts`: an `http` server with `GET /healthz` → 200 `ok` when Kafka is connected, plus `ws` on path `/ws`.
  - `maxPayload` is 16 KB.
  - At most `MAX_SOCKETS = 50`; extra sockets are closed with code 1013.
  - The `Origin` is checked against `ALLOWED_ORIGINS` (env, comma-separated; empty = allow all, for local dev).
- `main.ts`: env `PORT` (default 8081), `KAFKA_BROKERS`, `ALLOWED_ORIGINS`. SIGTERM closes sockets and Kafka cleanly.

- [ ] **Step 1: Failing tests (Review Focus 1, 4).**
  - Unit `Sessions` with a fake clock and send:
    - `newGame` sends exactly one `startGame` and binds the socket.
    - A second `newGame` on the same socket is rejected.
    - A `cmd` before binding is rejected.
    - A `cmd` carries `shiftId` from the latest status.
    - A client `heartbeat` or `startGame` is rejected.
    - Messages over 16 KB, non-JSON, and a 25 msgs/s flood are each handled as specified.
    - `resume` works within 90 s of the last status and fails after.
    - A heartbeat is sent only for bound games.
  - `server.test.ts` (real `ws` client, fake GatewayKafka): `/healthz`; the 51st socket is refused; a disallowed origin is refused.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(gateway): WebSocket sessions, limits and heartbeats`

---

### Task 9: End-to-end: terminal client and full-stack test

**Files:** Create `services/gateway/src/cli/play.ts` and `services/gateway/test/e2e.int.test.ts`.

**Interfaces:**
- `pnpm --filter @desal/gateway play [--url ws://localhost:8081/ws]`: a terminal client.
  - Startup: connects, sends `newGame`, prints the gameId.
  - Each status: prints a one-line summary (shift, phase, status, TBT, product flow, balance).
  - Keyboard input: lines like `startShift auto`, `setpoint tbt 110`, `trip`, `restart`, or `quit` are sent as commands. Raw JSON is also accepted.
  - Exits on `gameEnd`, printing the score.
- `e2e.int.test.ts` starts the real simulator runner and the real gateway in-process on suffixed topics, then connects two `ws` clients.
  - Both get distinct gameIds.
  - Client A runs `startShift auto` and receives a status with phase `running` and at least 3 frames with 108 readings each.
  - Client B's stream never contains A's gameId.
  - A sends `quitGame` and receives `gameEnd{reason:'quit'}`.
  - B disconnects; with `idleMs` lowered to 3 s for the test, B's game ends `abandoned`. Then `resume` of B's id gets `{t:'error', reason:'game ended'}`.

- [ ] **Step 1: Write** the e2e test. **Step 2:** Run it; expect FAIL. **Step 3:** Implement `play.ts` and any glue it needs. **Step 4:** Run; expect PASS.
- [ ] **Step 5: Manual:** run the simulator, gateway and `play` locally, and play a shift for a minute. Record the output in the report.
- [ ] **Step 6: Commit** `feat(gateway): terminal client and end-to-end test`

---

### Task 10: Deploy: gateway on desal.moosha.org

**Files:** Create `services/gateway/Dockerfile`. Modify `deploy/compose.yml`, `deploy/desal.caddy`, `scripts/deploy/deploy.sh`, `docs/hosting.md`.

**Interfaces:**
- Gateway container `desal-gateway`:
  - Image `desal-gateway:<commit>`, same Dockerfile pattern as the simulator.
  - `mem_limit: 192m`, `127.0.0.1:8081:8081`.
  - `KAFKA_BROKERS=kafka:29092`, `ALLOWED_ORIGINS=https://desal.moosha.org`.
  - `init: true`, `stop_grace_period: 15s`.
- Caddy: `handle /ws*` → `reverse_proxy 127.0.0.1:8081` with **no** basic auth (the game is public). `handle /healthz` → gateway. Everything else → Kafka UI behind basic auth, as before.
- `deploy.sh` builds both images and keeps the two newest of each.
- `docs/hosting.md` documents the gateway, the public `/ws`, and `play --url wss://desal.moosha.org/ws`.

- [ ] **Step 1:** Run `scripts/deploy/deploy.sh`.
- [ ] **Step 2: Verify from the laptop.**
  - `curl -s https://desal.moosha.org/healthz` → `ok`.
  - `curl -s -o /dev/null -w '%{http_code}' https://desal.moosha.org/` → `401`.
  - `pnpm --filter @desal/gateway play --url wss://desal.moosha.org/ws`: start a game, run `startShift auto`, watch status for 30 s, then `quit` and get a score.
  - `docker stats --no-stream` on the server shows every container under its cap.
- [ ] **Step 3: Commit** `feat(deploy): public gateway on desal.moosha.org`

---

### Task 11: Streaming notes

**Files:** Modify `docs/streaming-notes.md`, `README.md`.

- [ ] **Step 1:** Add rows and short paragraphs for:
  - keys = gameId (per-game ordering, partition spread, Flink `keyBy`);
  - fan-out vs work-sharing consumer groups (the gateway's per-instance group vs `desal-sim`);
  - tombstones and compaction (`plant.state` per game);
  - the idempotent producer;
  - event `seq` and de-duplicating at-least-once delivery downstream.

  Update the README's run instructions: simulator, gateway, `play`; `send --new`; and remove `--new-career`.
- [ ] **Step 2:** Run `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: streaming notes for many games and the gateway`
