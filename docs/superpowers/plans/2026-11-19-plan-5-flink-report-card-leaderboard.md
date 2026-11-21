# Plan 5: Flink report card and leaderboard — Implementation Plan

> **Amended 2026-11-20 for Plan 6 (modes).** Plan 6 adds `mode: 'normal' | 'hard'` (already on `gameStart`, `gameEnd`, `PlantStatus` and the snapshot, default `'normal'` for older records), the scenario kinds `fuelContamination`, `earthquake`, `tsunami` and the crew job `flushFuel`, and takes snapshot VERSION 4 (with a v3 migration). This plan therefore: carries `mode` on `ShiftReport`, `RunResult` and the Java POJOs; computes Top-N, stats and "today" per mode (`GET /api/leaderboard` returns `{ normal, hard }`); grades the new kinds; and bumps the snapshot to **v5**, migrating v4 (superseded by Plan 7: this plan now takes **v6**, migrating v5). Amended passages are marked "(modes)".

> **Amended 2026-11-20 for Plan 7 (plant layout, pace, hints).** Plan 7 (`2026-11-20-plant-layout-pace-hints-design.md`) is built before this plan. It makes the plant 24 stages (21 heat-recovery, 3 heat-rejection) with a seawater makeup loop, adds `PlantStatus.pace` (`'calm' | 'busy'`), and takes snapshot VERSION 5 (migrating v4). This plan's snapshot bump is therefore **v6**, migrating v5, and the chain v3 -> v4 -> v5 -> v6 keeps working. Telemetry is now 127 readings (24 stages x 4, plus the others, including `brine.makeupM3h` and `brine.coolingRejectM3h`); loop ids are `makeup` and `level1`..`level23` (was `level1`..`level20`). The report card shows the shared `FIX` text under every slow or missed verdict, and "Last shift" no longer repeats it when a report card is present. `PlantStatus.pace` is ignored here (not to be confused with this plan's own `pace` sparkline array on `ShiftReport`). Amended passages are marked "(Plan 7)".

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flink grades every shift (a report card at the next handover) and ranks every run (a leaderboard on the start screen and the run's rank on the Final report), without the game ever needing Flink to play.

**Architecture:** The simulator gives each run a call sign and a private runId and creates four new topics. A Java DataStream job ("report-card") keyed by gameId joins `plant.events` and `plant.status` and writes `shift.reports` and `run.results` (both carry the run's `mode`). A Flink SQL job ("leaderboard") ranks `run.results` read as an upsert table, partitioned by mode, counts plants online, and a small DataStream step assembles one `leaderboard` record (a Normal board and a Hard board) plus per-run `run.ranks` (ranks within the run's mode). The gateway forwards reports and ranks to the right sockets and serves the public board over HTTP with every runId stripped. Flink runs as a session cluster in the existing compose project.

**Tech Stack:** TypeScript (zod 4, vitest 4, React 19), Java 17, Maven (run in Docker), Flink 2.2.1, flink-connector-kafka 5.0.0-2.2, Kafka 4.1.1.

**Spec:** `docs/superpowers/specs/2026-11-19-flink-report-card-leaderboard-design.md` (§ numbers below refer to it). Also read `docs/streaming-notes.md` ("What consumers may rely on", "Chaos events, shifts and money"): it is the contract Job 1 reads.

## Global Constraints

- The game must never need Flink: with Flink down, handover shows the existing debrief and the start screen shows "Leaderboard offline"; nothing blocks or errors.
- No gameId in `run.results`, `leaderboard`, `run.ranks`, or anything a browser receives except that browser's own game. No runId in anything a browser receives (HTTP or WebSocket).
- Report totals (`productM3`, `offSpecM3`, `offSpecMinutes`, `trips`, `spentUsd`, `targetM3`) are copied from the `shiftEnd` summary, never recomputed.
- Pinned versions: Flink `2.2.1`, Docker image `flink:2.2.1-java17`, `flink-connector-kafka` `5.0.0-2.2`, Maven image `maven:3.9.11-eclipse-temurin-17`, Java release 17. Any other Java dependency is pinned exactly and must have been released at least 14 days before it is added (check the artifact's Last-Modified on repo1.maven.org).
- Java is never run from the host JDK (it is Java 8 and there is no Maven): every Maven command goes through `services/flink/mvn.sh`.
- (Modes) Boards, stats and "today" are per mode and never mix Normal and Hard runs; a run's rank and rank messages are within its own mode.
- Verdict bands: quick ≤ 5, ok ≤ 15, slow > 15 plant minutes, missed = no response by shift end. (Modes) `fuelContamination` and `tsunami` are graded on time-to-clear (response = the clear tick); `earthquake` is noted (outcome "noted", no verdict); earthquake children are ordinary sharp events. 1 tick = 40 plant seconds (2/3 plant minute); an hour is 90 ticks; a shift is 720 ticks.
- Debrief wording, reused verbatim: `cleared by you`, `fixed by crew`, `passed`, `noted`, `not cleared`.
- (Plan 7) Snapshot version 6 (Plan 6 took 4, Plan 7 took 5). A v5 save is migrated (callSign from the seed, fresh runId) and v3 and v4 saves still migrate v3 -> v4 -> v5 -> v6; versions older than 3 are skipped by the existing rule.
- (Plan 7) The plant has 24 stages and 127 telemetry readings (including `brine.makeupM3h` and `brine.coolingRejectM3h`); loop ids are `makeup` and `level1`..`level23`. Any sensor, loop or telemetry fixture this plan writes or edits must match. `PlantStatus.pace` exists and is ignored by every Plan 5 job and screen.
- (Plan 7) Fix text: the `FIX` table (`FixEntry { text, hint, underway? }`) in `apps/web/src/expanded/labels.ts` is the single source of fix wording; the handover reads it through `whatToDo(e)` in `apps/web/src/screens/Handover.tsx`. The report card reuses it and never invents its own.
- Memory caps: Flink jobmanager process 640 MB (container `mem_limit: 700m`), taskmanager process 1,024 MB with 2 slots (container `mem_limit: 1100m`). Existing caps unchanged.
- Flink UI at `/flink`, behind the same Caddy basic auth as `/kafka`, `X-Robots-Tag "noindex, nofollow"`, `web.submit.enable: false`. Flink REST is published only on `127.0.0.1:8082`.
- Code comments explain each Flink concept where it is first used: keyed state, connect, checkpoint, savepoint, upsert table, windows, Top-N, changelog.
- Tests live under `test/**` (TS) and `src/test/java/**` (Java). TS commits pass `pnpm -r test` and `pnpm -r typecheck` (or the package's equivalents).

## Review Focus

1. **Flink down or empty.** Gateway with no `leaderboard` record yet → `GET /api/leaderboard` returns 503 and the start screen shows "Leaderboard offline" within 5 s; handover hides "Grading…" 10 s after `shiftEnd`. (Tests in Tasks 3 and 4.)
2. **No plants online.** HOP windows emit nothing without input, so a stale count would stay forever; the assembler must show 0 once no online count has arrived for 70 s. (Test in Task 8.)
3. **runId leakage through a forwarded event.** `gameEnd` and `shiftEnd` carry runId on Kafka; any path that forwards an event must strip it. (Test in Task 3, re-checked end to end in Task 10.)
4. **Status before scenario.** The two topics are consumed independently, so the status showing the response can arrive before the `scenario` event; the response must still be credited. (Test in Task 6.)
5. **Report for a shift that a crash rewound.** A higher epoch replays ticks; the re-fired event overwrites its record and pace points at or after the restored tick are recomputed, and exactly one report results per `shiftEnd` per epoch. (Test in Task 7.)
6. **(Modes) Boards must not mix modes.** A Hard run never appears on the Normal board or in its stats, and ranks are within the run's mode. (Tests in Tasks 8 and 10.)

## Rulings against the spec

- **Leaderboard over HTTP, not on WebSocket connect (§4.5).** The start screen holds no socket (it opens on Start), so the board is served as `GET /api/leaderboard` by the gateway. The player's own rank still arrives on the game's socket as a `rank` message. Cost if wrong: one small route and a fetch, easy to move.
- **(Modes) One `leaderboard` record holds both boards (`{ updatedAt, online, normal, hard }`).** SQL partitions by `mode`; the assembler emits both boards together, so the gateway cache and the HTTP route stay one record. `online` is global. `GET /api/leaderboard` returns it as is (runIds stripped).
- **"Today" ranks are computed in the assembler, not in SQL (§4.4).** A streaming SQL filter on "ended in the last 24 h" is evaluated once per row and never drops a row later, so SQL does the all-time Top-N, the stats and the online count, and the DataStream assembler re-ranks the last 24 h on a timer.
- **Job 1 starts at the latest offsets on its first run.** Replaying 7 days of events would re-send old reports; later runs resume from checkpoints/savepoints and committed offsets.
- **The call sign does not consume the game seed.** It is drawn from a value derived from the seed, so every existing scenario draw and balance result stays the same.
- **Java builds run in Docker.** The laptop has Java 8 and no Maven.

## File Structure

```
packages/schema/src/flink.ts                 ShiftReport, RunResult, Leaderboard (ModeBoard x2), RunRank, PublicLeaderboard schemas; reuses Plan 6's ModeSchema
packages/schema/src/{events,status,ws,topics}.ts   callSign/runId fields, new ServerMsgs, new topic names
packages/schema/test/flink.test.ts           schema tests + Java fixture contract test
packages/schema/test/fixtures/flink/*.json   written by the Java contract test, committed
services/simulator/src/callsign.ts           word list + callSignFor(seed)
services/gateway/src/flinkFeeds.ts           consumer for shift.reports, leaderboard, run.ranks
services/gateway/src/publicBoard.ts          strip runIds, LeaderboardCache
apps/web/src/screens/ReportCard.tsx          handover report card
apps/web/src/screens/LeaderboardCard.tsx     start screen card
apps/web/src/net/leaderboard.ts              leaderboardUrl(), fetchLeaderboard()
services/flink/                              Maven project (one jar, two jobs)
  mvn.sh  pom.xml  Dockerfile  flink-jobs.sh
  src/main/java/org/desal/flink/common/      Json, Topics, Args
  src/main/java/org/desal/flink/model/       POJOs mirroring packages/schema/src/flink.ts (incl. ModeBoard)
  src/main/java/org/desal/flink/reportcard/  Rules, Grading, GameState, ShiftTracker, ReportCardFunction, ReportCardJob
  src/main/java/org/desal/flink/leaderboard/ LeaderboardSql, BoardAssembler, LeaderboardJob
scripts/e2e-flink.sh                         local end-to-end run
```

---

### Task 1: Shared schemas for Flink records

**Files:**
- Create: `packages/schema/src/flink.ts`, `packages/schema/test/flink.test.ts`
- Modify: `packages/schema/src/events.ts`, `status.ts`, `ws.ts`, `topics.ts`, `index.ts`, `packages/schema/test/fixtures.ts` (fixtures gain the new required fields). (Modes) `ModeSchema`, `mode` on `gameStart`/`gameEnd`/status and the new `ScenarioKind`s and `flushFuel` already exist from Plan 6; this task reuses them.

**Interfaces:**
- Produces:
  - `TOPICS` gains `shiftReports: 'shift.reports'`, `runResults: 'run.results'`, `leaderboard: 'leaderboard'`, `runRanks: 'run.ranks'`.
  - Events: `gameStart` gains `callSign: string`; `gameEnd` gains `callSign: string` and `runId?: uuid`; `shiftEnd` gains `runId?: uuid`. Comment: runId is always present on Kafka; the gateway strips it before a browser sees the event.
  - `PlantStatusSchema` gains `callSign: z.string()`.
  - (Modes) Reuses Plan 6's `ModeSchema = z.enum(['normal','hard'])` (`ScenarioKindSchema` now includes `fuelContamination`, `earthquake`, `tsunami`). `gameStart`, `gameEnd` and `PlantStatus` already carry `mode` (default `'normal'`); `gameEnd` and status fixtures here keep it.
  - `GradeSchema = z.enum(['A','B','C','D','F'])`, `VerdictSchema = z.enum(['quick','ok','slow','missed'])`, `OutcomeSchema = z.enum(['cleared by you','fixed by crew','passed','noted','not cleared'])`.
  - `ComparisonSchema = { shiftId: int, targetPct: num, handledWell: int, handledOf: int, minutesTripped: num }`.
  - `ShiftReportSchema = { shiftId: int ≥1, epoch: int ≥0, mode: ModeSchema, grade, score: num 0..100, targetM3, productM3, offSpecM3, offSpecMinutes, trips, spentUsd, minutesTripped: num, self: ComparisonSchema, events: Array<{ eventId: int ≥1, kind: ScenarioKind, atMinute: num, responseMinutes: num|null, clearMinutes: num|null, outcome, verdict: Verdict|null }>, pace: Array<{ hour: int 1..8, productM3: num, targetM3: num }> (cumulative, max 8), vsPrevious: Comparison|null, vsBest: Comparison|null }`.
  - `KindStatSchema = { kind: ScenarioKind, count: int, handledWell: int, meanResponseMinutes: num|null, firstHandledWell: boolean }`; `RunResultSchema = { runId: uuid, callSign: string, mode: ModeSchema, endedAt: int (epoch ms), shiftsCompleted: int, totalProductM3: num, endReason: GameEndReason, kinds: KindStat[] }`.
  - `LeaderboardRowSchema = { rank: int ≥1, callSign, shiftsCompleted: int, totalProductM3: num, endedAt: int, runId: uuid }`; `ModeBoardSchema = { allTime: Row[] (max 10), today: Row[] (max 10), stats: Array<{ kind: ScenarioKind, operators: int, firstHandledWellPct: num 0..100 }> }` (stats only for graded sharp kinds); `LeaderboardSchema = { updatedAt: int, online: int ≥0, normal: ModeBoardSchema, hard: ModeBoardSchema }` (modes: one board per mode; `online` counts plants in both).
  - `PublicLeaderboardSchema` = `LeaderboardSchema` with rows `LeaderboardRowSchema.omit({ runId: true })` in both `normal` and `hard`, built with `.strict()` rows so a runId fails validation. This is the body of `GET /api/leaderboard`: `{ updatedAt, online, normal, hard }`.
  - `RunRankSchema = { runId: uuid, allTime: int ≥1, today: int ≥1 | null }` (ranks are within the run's own mode, so no `mode` field).
  - `ServerMsgSchema` gains `{ t: 'shiftReport', report: ShiftReportSchema }` and `{ t: 'rank', allTime: int, today: int|null }`.

- [ ] **Step 1: Write the failing tests** in `test/flink.test.ts`:
  - `ShiftReportSchema` parses a full example (shift 2, `mode: 'hard'`, grade 'B', 3 events including a `fuelContamination` and an `earthquake` with `outcome: 'noted'` and `verdict: null`, 8 pace points, vsPrevious set) and rejects `grade: 'E'`, `verdict: 'late'`, `mode: 'easy'`, `pace` with 9 points. `RunResultSchema` requires `mode`.
  - `PublicLeaderboardSchema.safeParse(board with a row carrying runId in normal or in hard).success === false`; the same board with runIds deleted parses; a board missing `hard` fails.
  - `RunRankSchema` accepts `today: null`.
  - `ServerMsgSchema` parses `{ t: 'rank', allTime: 57, today: null }` and a `shiftReport` message.
  - In `test/events.test.ts`: `gameEnd` without `runId` parses (the browser's view); `gameStart` without `callSign` fails; (modes) a `gameEnd` without `mode` parses as `'normal'`.
  - Contract test: for every file in `test/fixtures/flink/` (`shift-report.json`, `run-result.json`, `leaderboard.json`, `run-rank.json`), parse with the matching schema; `it.skipIf(files missing)` is NOT allowed — until Task 5 writes them, commit hand-written fixtures with the same names that Task 5's Java test will overwrite.
- [ ] **Step 2:** `pnpm --filter @desal/schema test` → FAIL (missing exports).
- [ ] **Step 3:** Implement the schemas above; update `fixtures.ts` and existing tests so every `gameStart`/`gameEnd`/status fixture carries `callSign: 'Kestrel-42'`.
- [ ] **Step 4:** `pnpm --filter @desal/schema test && pnpm -r typecheck` → schema PASS. Typecheck errors elsewhere (simulator, gateway, web missing `callSign`) are expected and are fixed in Tasks 2–4; note them in the report, do not fix them here.
- [ ] **Step 5:** Commit `feat(schema): Flink report, run result, leaderboard and rank records`.

### Task 2: Simulator — call sign, runId, topics, snapshot v6 (Plan 7)

**Files:**
- Create: `services/simulator/src/callsign.ts`, `services/simulator/test/callsign.test.ts`
- Modify: `src/state.ts` (`Run` gains `callSign: string`, `runId: string`), `src/host.ts` (startGame), `src/gameover.ts`, `src/shift.ts` (shiftEnd), `src/emit.ts` (`toStatus`), `src/snapshot.ts` (v6 + schema + v5 migration; Plan 7 owns v5), `src/kafka/client.ts` (SPECS), `docs/streaming-notes.md`, existing tests touched by the new fields

**Interfaces:**
- Produces: `CALL_SIGN_WORDS: readonly string[]` (exactly 64 distinct clean words: birds and weather/sea adjectives, e.g. Kestrel, Petrel, Heron, Osprey, Tern, Gannet, Brisk, Steady…; no slurs, nothing rude); `callSignFor(seed: number): string` returning `` `${word}-${n}` `` with `n` in 10..99. `GameHostOptions` gains `newRunId?: () => string` (default `crypto.randomUUID`).

- [ ] **Step 1: Write failing tests:**
  - `callsign.test.ts`: `CALL_SIGN_WORDS.length === 64` and all distinct; `callSignFor(7) === callSignFor(7)`; for seeds 0..999 every result matches `/^[A-Z][a-z]+-[1-9][0-9]$/`; at least 40 distinct words appear over seeds 0..999.
  - `host.test.ts`: a started game's `gameStart` carries `callSign`; its status has the same `callSign`; quitting yields `gameEnd` with that `callSign` and `runId` equal to the host's injected `newRunId()` value; two games get different runIds.
  - A test that `callSignFor` does not change the game's draws: the shift-1 pending plan of `createInitialState(seed, …)` after `drawPendingPlan` is identical with and without the call sign feature (compare against a snapshot of `s.chaos.pending` taken from `seed` 3 — i.e. the call sign must not consume `s.seed`). Balance tests must stay green unmodified.
  - `shiftEnd` events carry the game's runId (run one shift in a test with the existing helpers).
  - Snapshot (modes, Plan 7): a v6 round-trip keeps `callSign`, `runId` and `mode`; a v5 document (Plan 7's format: 24 stages, makeup loop, with `mode`) restores with `callSign === callSignFor(seed)`, a fresh `runId` from `newRunId()`, its `mode` kept and its 24 stages untouched; a v4 document still migrates through v5 (Plan 7: 20 stages to 24, balanced makeup loop) to v6; a v3 document still migrates through v4 and v5 to v6 (mode `'normal'`); a v2 document is rejected with `unknown version: 2`.
  - `kafka/topics.int.test.ts` (integration, needs local Kafka): the 4 new topics exist after `ensureTopics` with: `shift.reports` 1 partition, `retention.ms` 604800000, LogAppendTime; `run.results` `cleanup.policy=compact`, `retention.ms=-1`; `leaderboard` compact; `run.ranks` compact. `waitForTopics` covers them.
- [ ] **Step 2:** `pnpm --filter @desal/simulator test` → FAIL.
- [ ] **Step 3:** Implement. Derive the call sign from `nextRandom((seed ^ 0x5eed5) >>> 0)` without storing the result back into `s.seed`. Mint the runId in `GameHost` at startGame and store both on `Run`. Compacted topics also get `segment.ms=3600000` and `min.cleanable.dirty.ratio=0.1` like `plant.state`. Bump `VERSION` from 5 to 6 with a comment line "6 = callSign and runId on the run", adding a v5 -> v6 migration step after Plan 7's v4 -> v5 (the migration chain stays v3 -> v4 -> v5 -> v6). Update `streaming-notes.md`: topics table (4 rows, writers: simulator creates, Flink writes), the new event and status fields, "runId never reaches a browser", snapshot version 6 (and the v5 migration).
- [ ] **Step 4:** `pnpm --filter @desal/simulator test && pnpm --filter @desal/simulator typecheck` → PASS. With local Kafka up (`docker compose -f infra/docker-compose.yml up -d kafka`): `pnpm --filter @desal/simulator test:int` → PASS (check `package.json` for the int script name).
- [ ] **Step 5:** Commit `feat(simulator): call sign and runId per run, Flink topics, snapshot v6`.

### Task 3: Gateway — reports, ranks, public board, runId stripping

**Files:**
- Create: `services/gateway/src/flinkFeeds.ts`, `services/gateway/src/publicBoard.ts`, `services/gateway/test/flinkFeeds.test.ts`, `services/gateway/test/publicBoard.test.ts`
- Modify: `src/sessions.ts`, `src/server.ts`, `src/main.ts`, `test/sessions.test.ts`, `test/server.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas and `TOPICS`.
- Produces:
  - `stripRunId(e: PlantEvent): PlantEvent` (returns a copy without `runId`).
  - `toPublic(board: Leaderboard): PublicLeaderboard` (modes: strips runIds from both `normal` and `hard` rows).
  - `class FlinkFeeds { constructor(kafka, opts: { onReport(gameId: string, r: ShiftReport): void; onBoard(b: Leaderboard): void; onRank(r: RunRank): void; log? }); start(): Promise<void>; stop(): Promise<void> }` — its own random group `desal-gateway-flink-<uuid>`, `autoCommit: false`; `leaderboard` and `run.ranks` read from the beginning (compacted, they rebuild the cache), `shift.reports` seeked to its end like `GatewayKafka`. Invalid records are skipped with a log line. A tombstone on `run.ranks` deletes the entry.
  - `Sessions` gains `onReport(gameId, report)`, `onBoard(board)`, `onRank(rank)`. On a `gameEnd` with a runId, every socket bound to that game remembers `runId` (it stays after `unbindGame`), and gets `{ t: 'rank', … }` at once if a rank is known, and again whenever `onRank` changes it.
  - HTTP `GET /api/leaderboard` in `server.ts`: 200 with `PublicLeaderboard` JSON (`{ updatedAt, online, normal, hard }`) (`Cache-Control: no-store`) when a board is cached, else 503 `{"error":"leaderboard offline"}`. Same CORS/origin policy as the existing HTTP routes.
  - `main.ts` starts `FlinkFeeds` after `GatewayKafka`; a FlinkFeeds start failure is logged and retried every 30 s and never stops the gateway or its `/healthz`.

- [ ] **Step 1: Write failing tests:**
  - `sessions.test.ts`: an incoming `gameEnd` and `shiftEnd` with `runId` reach the socket without a `runId` key (`expect(JSON.stringify(sent)).not.toContain(runId)`); `onReport(gameId, r)` reaches only that game's sockets as `{ t: 'shiftReport', report: r }`; after `gameEnd` (runId R) then `onRank({ runId: R, allTime: 57, today: 3 })` the ended socket receives `{ t: 'rank', allTime: 57, today: 3 }`; a rank for another runId sends nothing; a rank known before `gameEnd` is sent right after the `gameEnd` message.
  - `publicBoard.test.ts`: `toPublic` output passes `PublicLeaderboardSchema` and `JSON.stringify` contains no runId, with rows in both `normal` and `hard` (both boards survive, each keeping its own rows).
  - `server.test.ts`: `/api/leaderboard` is 503 before any board and 200 after `onBoard`, with `normal` and `hard` keys and no runId.
  - `flinkFeeds.test.ts`: with a fake consumer (follow the existing pattern in `test/kafka.test.ts`), a non-JSON record and a schema-invalid record are skipped and the next valid one is delivered; a `run.ranks` tombstone is passed as a delete.
- [ ] **Step 2:** `pnpm --filter @desal/gateway test` → FAIL.
- [ ] **Step 3:** Implement. Strip runId at the single place events are broadcast in `Sessions.onRecord`.
- [ ] **Step 4:** `pnpm --filter @desal/gateway test && pnpm --filter @desal/gateway typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(gateway): forward shift reports and ranks, serve the public leaderboard`.

### Task 4: Web — report card, leaderboard card, call sign, rank

**Files:**
- Create: `apps/web/src/screens/ReportCard.tsx`, `apps/web/src/screens/LeaderboardCard.tsx`, `apps/web/src/net/leaderboard.ts`, `apps/web/test/reportcard.test.tsx`, `apps/web/test/leaderboard.test.tsx`
- Modify: `src/state/store.ts`, `src/state/GameProvider.tsx`, `src/screens/Handover.tsx`, `Start.tsx`, `GameOver.tsx`, `TopBar.tsx`, `screens.css`, `src/ui/motion.css`, `test/store.test.ts`, `test/screens.test.tsx`

**Interfaces:**
- Consumes: Task 1 `ShiftReport` (with `mode`), `PublicLeaderboard` (`normal`/`hard`), `ServerMsg` `shiftReport`/`rank`; Task 3 HTTP route.
- Produces:
  - Store: `reports: Record<number, ShiftReport>` (keyed by shiftId; a later report for the same shiftId replaces it), `rank: { allTime: number; today: number | null } | null`, `reportWait: 'waiting' | 'expired' | null` (set to `'waiting'` on a `shiftEnd` event, `'expired'` by a `reportTimeout` action, `null` on `shiftStart`). The call sign is read from `status.callSign`.
  - `GameProvider` dispatches `reportTimeout` 10 s (`REPORT_WAIT_MS = 10_000`) after a `shiftEnd` event.
  - `leaderboardUrl(wsUrl: string): string` maps `wss://h/ws` → `https://h/api/leaderboard` and `ws://localhost:8081/ws` → `http://localhost:8081/api/leaderboard`.
  - `fetchLeaderboard(url, signal): Promise<PublicLeaderboard>` (validates with zod; throws on non-200 or invalid).
  - `LeaderboardCard` props `{ load?: () => Promise<PublicLeaderboard> }` (injected in tests); (modes) renders both boards, a "Normal" section and a "Hard" section, each with its own All time / Today toggle, rows and stats lines; `OFFLINE_AFTER_MS = 5_000`; refreshes every 30 s while mounted.
  - `ReportCard` props `{ report: ShiftReport | undefined; wait: 'waiting' | 'expired' | null }`.

- [ ] **Step 1: Write failing tests:**
  - `reportcard.test.tsx`: with a report → the grade letter, one row per event showing its outcome text and verdict ("quick", "missed"…), an `svg` sparkline with 8 points when `pace` has 8, a "HARD" tag when `report.mode === 'hard'` (none for normal), and comparison lines "vs last shift" (absent when `vsPrevious` is null, as for shift 1's report); (Plan 7) under every event row whose verdict is `slow` or `missed` the `FIX` text for that kind (same string as `FIX[kind].text`), and none under `quick`, `ok` or a null verdict; with no report and `wait: 'waiting'` → "Grading…"; with no report and `wait: 'expired'` → renders nothing; a report arriving after expiry is shown.
  - `leaderboard.test.tsx`: renders the top rows as "Kestrel-42 · 19 Nov" with water and shifts, with the `normal` rows under "Normal" and the `hard` rows under "Hard" (a row appears in only its own section); toggling "Today" shows the `today` rows; "3 plants running now"; a stats line "62 % of operators handled their first vacuum loss well" for `{ kind: 'vacuumLoss', firstHandledWellPct: 62 }`; a loader that never resolves shows "Leaderboard offline" after 5 s (fake timers); a rejecting loader shows it at once; `leaderboardUrl` cases above.
  - `store.test.ts`: `shiftReport` stores by shiftId; `rank` sets rank; `shiftEnd` → `reportWait: 'waiting'`; `shiftStart` clears it.
  - `screens.test.tsx`: Handover shows `ReportCard` above "Last shift" for the previous shift's id, and the call sign on the sheet; (Plan 7) with a report present "Last shift" does not repeat the "What to do" lines (`whatToDo(e)`), and without one (Flink down, or after the 10 s expiry) they show as before; TopBar shows the call sign; GameOver shows the call sign and "Rank #57 all time · #3 today" (labelled with the run's mode when Hard), or "Ranking…" when `rank` is null; with `today: null` it shows only "#57 all time".
- [ ] **Step 2:** `pnpm --filter @desal/web test` → FAIL.
- [ ] **Step 3:** Implement. Kind nouns for stats lines: pumpTrip "pump trip", tubeLeak "tube leak", vacuumLoss "vacuum loss", powerDip "power dip", storm "storm", sensorFailure "sensor failure", fuelContamination "fuel contamination", tsunami "tsunami" (earthquake has no stats line). Up to 3 stats lines rotate every 6 s. The grade stamp animation lives in `motion.css` under the existing reduced-motion override. Layout follows Plan 4 §4.11 (clipboard sheet, display font). (Plan 7) The report card imports `FIX` from `apps/web/src/expanded/labels.ts` and reuses the handover's `whatToDo(e)` helper in `Handover.tsx` for the text; `Handover.tsx` passes the card's presence down so "Last shift" can drop its own "What to do" lines.
- [ ] **Step 4:** `pnpm --filter @desal/web test && pnpm --filter @desal/web typecheck && pnpm --filter @desal/web build` → PASS. `pnpm -r typecheck` is now clean.
- [ ] **Step 5:** Commit `feat(web): report card at handover, leaderboard on start, call sign and rank`.

### Task 5: Java project, record POJOs and the contract fixtures

**Files:**
- Create: `services/flink/mvn.sh`, `services/flink/pom.xml`, `services/flink/.gitignore` (`target/`), `src/main/java/org/desal/flink/common/{Json.java,Topics.java,Args.java}`, `src/main/java/org/desal/flink/model/{ShiftReport,EventLine,PacePoint,Comparison,RunResult,KindStat,Leaderboard,ModeBoard,LeaderboardRow,KindShare,RunRank}.java`, `src/test/java/org/desal/flink/model/ContractFixturesTest.java`
- Modify: `packages/schema/test/fixtures/flink/*.json` (overwritten by the Java test), `README.md` (one paragraph: Java needs only Docker; `services/flink/mvn.sh test`)

**Interfaces:**
- Produces:
  - `mvn.sh`: runs `docker run --rm -v "$PWD":/w -v desal-m2:/root/.m2 -w /w/services/flink maven:3.9.11-eclipse-temurin-17 mvn -B "$@"` with `$PWD` = repo root (the script cds there itself), so the test can write into `packages/schema/test/fixtures/flink/`.
  - `pom.xml`: groupId `org.desal`, artifactId `desal-flink`, `maven.compiler.release` 17; `flink.version` 2.2.1; Flink core/streaming/clients/table-api-java-bridge/table-planner-loader/flink-json `provided`; `flink-connector-kafka` 5.0.0-2.2 compile; `jackson-databind` pinned, compile, relocated by the shade plugin to `org.desal.shaded.jackson`; test: `flink-test-utils`, `flink-streaming-java` `test-jar`, `flink-table-test-utils` if needed, JUnit 5 (use the JUnit version flink-test-utils 2.2.1 depends on). Shade plugin builds `target/desal-flink.jar`.
  - `Json.MAPPER` (Jackson `ObjectMapper`, nulls written, no unknown-field failures on read); `Topics.name(base, suffix)`; `Args` parses `--brokers` (default `kafka:29092`) and `--topic-suffix` (default empty).
  - POJOs with public no-arg constructors and public fields named exactly as the Task 1 schemas (Flink POJO rules: these become state too). (Modes) `ShiftReport.mode` and `RunResult.mode` are `String` (`"normal"`/`"hard"`, default `"normal"`); `Leaderboard { updatedAt, online, ModeBoard normal, ModeBoard hard }`; `ModeBoard { List<LeaderboardRow> allTime, List<LeaderboardRow> today, List<KindShare> stats }`.
- [ ] **Step 1: Write the failing test** `ContractFixturesTest`: builds one realistic instance of each record (a shift 2 report with `mode` "hard", a quick pumpTrip, a missed tubeLeak, a `fuelContamination` event graded on time-to-clear and an `earthquake` event with outcome "noted" and a null verdict, 8 pace points, vsPrevious set; a RunResult with `mode` "hard" and two kinds; a Leaderboard with online 3 whose `normal` board has 2 allTime rows, 1 today row and one stat and whose `hard` board has 1 allTime row; a RunRank with `today: null`), serializes with `Json.MAPPER`, and writes each to `../../packages/schema/test/fixtures/flink/<name>.json` (pretty, trailing newline). Assert each POJO class is a Flink POJO: `TypeInformation.of(X.class) instanceof PojoTypeInfo`.
- [ ] **Step 2:** `services/flink/mvn.sh test` → FAIL (classes missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `services/flink/mvn.sh test` → PASS; then `pnpm --filter @desal/schema test` → PASS on the Java-written fixtures (`git diff` shows the fixtures changed from the hand-written ones).
- [ ] **Step 5:** Commit `feat(flink): Maven project, record POJOs, contract fixtures checked by zod`.

### Task 6: Report card rules (pure Java)

**Files:**
- Create: `src/main/java/org/desal/flink/reportcard/{Rules.java,Grading.java,StatusView.java,OpenEvent.java,GameState.java,ShiftTracker.java}`, tests `src/test/java/org/desal/flink/reportcard/{RulesTest,GradingTest,ShiftTrackerTest}.java`

**Interfaces:**
- Consumes: Task 5 POJOs, `Json`.
- Produces:
  - `Rules`: `QUICK_MAX_MIN = 5`, `OK_MAX_MIN = 15`, `TICK_MINUTES = 40.0 / 60`, `TICKS_PER_HOUR = 90`, `SHIFT_HOURS = 8`; `String verdict(Double responseMinutes)` (null → `"missed"`); `boolean hasVerdict(String kind)` (true for pumpTrip, powerDip, controllerFault, sensorFailure, tubeLeak, vacuumLoss, storm, bloom and, modes, fuelContamination and tsunami; false for earthquake and informational kinds); `String crewJobFor(String kind)` (tubeLeak→plugTubes, vacuumLoss→repairEjector, storm→cleanScreens, sensorFailure→replaceSensor, else null; modes: fuelContamination and tsunami also null, and a `flushFuel` crew job is never a response); `boolean responded(OpenEvent e, StatusView s)`:
    - pumpTrip, powerDip: ≥ 2 pumps running;
    - controllerFault: some loop with non-null `fault` is in mode `manual`;
    - bloom: `chlorineMgL > e.baselineChlorine`;
    - crew kinds: `s.crewJob` equals `crewJobFor(kind)`;
    - (modes) fuelContamination, tsunami, earthquake: always false. Status never credits them; the existing clear rule below credits the clear tick, which makes fuelContamination and tsunami graded on time-to-clear. `earthquake` has no verdict.
  - `String outcome(String how)`: player→"cleared by you", crew→"fixed by crew", expired→"passed", noted→"noted", null→"not cleared".
  - `Grading`: `double score(double productM3, double targetM3, List<String> verdicts, int trips, double offSpecMinutes)` = `50·clamp((pct−50)/50) + 30·eventScore + 20·cleanScore`, where `pct = 100·product/target`, `eventScore` = mean of quick 1, ok 0.75, slow 0.35, missed 0 (1.0 when there are no verdicts), `cleanScore = clamp(1 − 0.5·trips − offSpecMinutes/120)`; `String grade(double score)`: A ≥ 90, B ≥ 80, C ≥ 65, D ≥ 50, else F.
  - `StatusView.from(JsonNode status)`: tick, epoch, shiftId, mode (default "normal"), phase, plant status kind, pumps running count, loops (mode, fault), chlorine dose, crew job (or null), `shiftProductM3`.
  - `GameState` (Flink POJO): `epoch`, `lastSeq`, `lastStatusTick`, `ended`, `callSign`, `runId`, `mode` (from `gameStart`, default "normal"), current shift (`ShiftTracker` or null), `history` (list of `Comparison`, one per completed shift), per-kind run stats (map kind → `KindStat` accumulator), `lastStatus` (`StatusView`).
  - `ShiftTracker`: `onShiftStart(long tick, int shiftId, double targetM3)`, `onScenario(int eventId, String kind, long tick, StatusView latest)`, `onCleared(int eventId, String how, long tick)`, `onStatus(StatusView s)`, `ShiftReport finish(JsonNode summary, List<Comparison> history, String mode)` (copies `mode` onto the report), and `void rewindTo(long tick)` (drops pace points whose hour-end tick ≥ `tick`).
  - Response rule: a status counts only if `tick > fireTick`. At `onScenario`, if `latest` already has `tick > fireTick` and shows the response, credit `latest.tick` (status-before-scenario). An `eventCleared` with how player or crew and no response yet credits the clear tick (modes: this is how fuelContamination and tsunami are graded). An `earthquake` cleared `noted` gets outcome "noted" and no verdict. Earthquake children (`cascade: true` scenarios) are ordinary events and use their own kind's rule. An event cleared `expired` with no response gets verdict null (outcome "passed").
  - Pace: point h (1..8) = `shiftProductM3` of the last status with `tick − startTick + 1 ≤ 90·h`; `targetM3` of point h = `target·h/8`; point 8 = `summary.productM3` on finish.
  - `minutesTripped` = count of distinct status ticks (tick > `lastStatusTick`) in phase running with plant status `tripped` or `restarting`, × `TICK_MINUTES`.
  - `finish` copies totals from the summary, builds `self`, sets `vsPrevious` = last history entry (null if none), `vsBest` = history entry with the highest `targetPct` (null if none). `handledWell` = events with verdict quick or ok; `handledOf` = events with a verdict.
- [ ] **Step 1: Write failing tests** (exact values):
  - `RulesTest`: `verdict(5.0)="quick"`, `verdict(5.01)="ok"`, `verdict(15.0)="ok"`, `verdict(15.1)="slow"`, `verdict(null)="missed"`; responded cases for each kind above, including sensorFailure *not* credited by putting a loop in Manual.
  - `GradingTest`: engaged shift (product 4163.88 / target 4056, verdicts [quick, ok], 0 trips, 0 off-spec) → score ≥ 80 and grade A or B; untouched shift (product 3650 / 4056, verdicts [missed], 0 trips, 0 off-spec) → grade D or F; `grade(90)="A"`, `grade(89.99)="B"`, `grade(65)="C"`, `grade(49.9)="F"`.
  - `ShiftTrackerTest`: (a) pumpTrip fired at tick 1000, statuses at 1003 (1 pump), 1006 (2 pumps) → responseMinutes 4.0, verdict quick; (b) **status-before-scenario**: status 1006 (2 pumps) observed, then scenario at tick 1000 with that status as `latest` → credited 4.0; (c) tubeLeak with crew `plugTubes` first seen at tick 1030 → 20.0, slow; (d) bloom baseline 2.0 mg/L, status with 2.5 at tick 1012 → 8.0, ok; (e) storm cleared `expired` with no response → verdict null, outcome "passed"; (f) no response by finish → "missed", outcome "not cleared"; (g) pace with 8 points and point 8 = summary productM3; (h) totals equal the summary's exactly; (i) first shift → vsPrevious and vsBest null; with history [{shiftId 1, targetPct 90}, {shiftId 2, targetPct 105}] → vsPrevious shiftId 2, vsBest shiftId 2; (k) modes: `finish(..., "hard")` gives report.mode "hard", and a status JSON without `mode` gives `StatusView.mode == "normal"`; (l) modes: fuelContamination fired at tick 2000 and cleared `crew` at tick 2030 gives responseMinutes 20.0, verdict slow, outcome "fixed by crew"; tsunami cleared `player` at tick 2006 gives 4.0, quick; a status with crew job `flushFuel` credits neither; (m) modes: earthquake cleared `noted` gives outcome "noted", verdict null, `hasVerdict("earthquake")` false, and it does not count in `handledOf`; its `cascade` pumpTrip child is graded as an ordinary pumpTrip; (j) `rewindTo(1170)` drops hour points ending at or after tick 1170 and they are recomputed from later statuses.
- [ ] **Step 2:** `services/flink/mvn.sh test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `services/flink/mvn.sh test` → PASS.
- [ ] **Step 5:** Commit `feat(flink): report card rules, grading and shift tracker`.

### Task 7: Report card job (DataStream)

**Files:**
- Create: `src/main/java/org/desal/flink/reportcard/{ReportCardFunction.java,ReportCardJob.java,Input.java}`, test `src/test/java/org/desal/flink/reportcard/ReportCardFunctionTest.java`

**Interfaces:**
- Consumes: Task 6.
- Produces:
  - `Input` (key gameId, JSON payload, Kafka timestamp ms) and a `KafkaRecordDeserializationSchema<Input>` that skips null values and invalid JSON.
  - `ReportCardFunction extends KeyedCoProcessFunction<String, Input, Input, ShiftReportOut>` — input 1 events, input 2 status; main output `ShiftReportOut { gameId, ShiftReport report }`; side output `OutputTag<RunResult> RUN_RESULTS`. State: one `ValueState<GameState>` with a 7-day `StateTtlConfig`.
  - Event handling: drop `host: true`; epoch lower than state → drop; higher → set epoch, `lastSeq = -1`, `lastStatusTick = min(lastStatusTick, tick − 1)`, `shift.rewindTo(tick)`; same epoch and `seq ≤ lastSeq` → drop. `gameStart` → callSign and mode (absent → "normal"); `shiftStart` → new tracker; `scenario`/`eventCleared` → tracker; `shiftEnd` → runId, emit report keyed by gameId, append `self` to history, fold events into per-kind run stats (`firstHandledWell` set from the first occurrence of the kind in the run), clear the tracker; `gameEnd` → fold an open shift's events into run stats (no report), emit `RunResult` with `mode` (from state) and `endedAt` = the gameEnd record's Kafka timestamp, set `ended`. (Modes) Fold per-kind run stats for graded kinds only (earthquake is counted but never `handledWell`). After `ended`, records are ignored.
  - Status handling: same epoch rule (no seq), update `lastStatus`, pass to the tracker.
  - `ReportCardJob.main(args)`: env with checkpointing every 60 s (`EXACTLY_ONCE` mode not required; `AT_LEAST_ONCE` sinks), parallelism 1; two `KafkaSource<Input>` with group `desal-flink-report-card`, starting offsets `OffsetsInitializer.committedOffsets(OffsetResetStrategy.LATEST)`, no watermarks; `events.connect(status).keyBy(i -> i.gameId, i -> i.gameId).process(...)`; `KafkaSink` to `shift.reports` (key gameId, value report JSON) and `run.results` (key runId); every operator has a stable `.uid(...)` and `.name(...)`; job name `report-card`.
- [ ] **Step 1: Write failing tests** with `KeyedTwoInputStreamOperatorTestHarness` (or `ProcessFunctionTestHarnesses.forKeyedCoProcessFunction`) fed with JSON shaped like the streaming-notes examples:
  - one shift (shiftStart, scenario pumpTrip, statuses, eventCleared, shiftEnd) → exactly one report whose `productM3` equals the `shiftEnd` summary's `4163.88`;
  - the same `shiftEnd` delivered twice (same epoch, seq) → still one report;
  - **epoch rewind**: events and statuses up to tick 1200 in epoch 0, then epoch 1 resuming at tick 1170 with the scenario re-fired (same eventId, new tick 1175) and a shiftEnd → one report from epoch 1, the event's `atMinute` from tick 1175, pace points ≥ hour boundary 1170 recomputed from epoch-1 statuses; a late epoch-0 status after that is ignored;
  - host events ignored;
  - gameEnd mid-shift → no report, one RunResult whose `kinds` include the open shift's events and whose `endedAt` is the record timestamp; shift 2's report has `vsPrevious.shiftId == 1`;
  - (modes) a hard game (`gameStart.mode: 'hard'`) gives a report and RunResult with `mode: 'hard'`; a `gameStart` without `mode` gives `'normal'`; an earthquake with a cascaded pumpTrip child gives an earthquake "noted" with no verdict, and the child is graded;
  - `GameState` is a POJO type (`TypeInformation.of(GameState.class) instanceof PojoTypeInfo`) so savepoints can evolve.
- [ ] **Step 2:** `services/flink/mvn.sh test` → FAIL.
- [ ] **Step 3:** Implement, with comments explaining keyed state, connect, TTL, checkpoints and uids for savepoints at first use.
- [ ] **Step 4:** `services/flink/mvn.sh test` → PASS; `services/flink/mvn.sh -DskipTests package` produces `target/desal-flink.jar`.
- [ ] **Step 5:** Commit `feat(flink): report-card job joins events and status per game`.

### Task 8: Leaderboard job (Flink SQL + assembler)

**Files:**
- Create: `src/main/java/org/desal/flink/leaderboard/{LeaderboardSql.java,BoardAssembler.java,BoardInput.java,LeaderboardJob.java}`, test `src/test/java/org/desal/flink/leaderboard/{LeaderboardSqlTest,BoardAssemblerTest}.java`

**Interfaces:**
- Consumes: Task 5 POJOs.
- Produces:
  - `LeaderboardSql.kafkaTables(StreamTableEnvironment t, String brokers, String suffix)`: `runs` (connector `upsert-kafka`, topic `run.results`, key format `raw` on `runId`, value format `json`, `PRIMARY KEY (runId) NOT ENFORCED`; columns runId, callSign, mode STRING, endedAt BIGINT, shiftsCompleted INT, totalProductM3 DOUBLE, endReason, kinds `ARRAY<ROW<kind STRING, \`count\` INT, handledWell INT, meanResponseMinutes DOUBLE, firstHandledWell BOOLEAN>>`) and `status` (connector `kafka`, topic `plant.status`, json with `json.ignore-parse-errors`, only `gameId`, `pt AS PROCTIME()`, `scan.startup.mode` `latest-offset`).
  - `LeaderboardSql.queries(StreamTableEnvironment t)` returns three `Table`s, reading only the registered names `runs` and `status` (tests register their own):
    - `ranked`: Top-N per mode — `ROW_NUMBER() OVER (PARTITION BY mode ORDER BY totalProductM3 DESC, shiftsCompleted DESC, endedAt ASC)` filtered `rn <= 100000` (`MAX_RANKED_RUNS`), selecting runId, callSign, mode, shiftsCompleted, totalProductM3, endedAt, rn;
    - `stats`: `CROSS JOIN UNNEST(kinds)` restricted to the eight graded kinds (the six sharp kinds plus `fuelContamination` and `tsunami`; `earthquake` excluded), `GROUP BY mode, kind` with `COUNT(*) AS operators` and `SUM(CASE WHEN firstHandledWell THEN 1 ELSE 0 END) AS firstWell`;
    - `online`: `HOP(TABLE status, DESCRIPTOR(pt), INTERVAL '5' SECOND, INTERVAL '60' SECOND)` with `COUNT(DISTINCT gameId)` per window (modes: global, not per mode).
  - `BoardAssembler extends KeyedProcessFunction<String, BoardInput, Leaderboard>` (keyed by the constant `"board"`), side output `OutputTag<RunRank> RANKS`. State: `MapState<String, LeaderboardRow>` runs (all-time rank from `ranked`; a retraction deletes; modes: each entry is tagged with its `mode`), `MapState<String, Integer>` stats operators and firstWell (key `mode|kind`), `ValueState` online + last online processing time, last emitted ranks. Every 5 s processing-time timer (`EMIT_EVERY_MS = 5_000`), when anything changed or at least every 60 s: compute `today` per mode = that mode's runs with `endedAt ≥ now − 24 h` re-ranked with the same order; emit one `Leaderboard` holding a `normal` and a `hard` `ModeBoard` (top 10 each, `online` = 0 if no online value for 70 s (`ONLINE_STALE_MS = 70_000`), stats `firstHandledWellPct = 100·firstWell/operators` rounded to 1 decimal) and a `RunRank` for every run whose `(allTime, today)` changed (ranks within the run's own mode; today null once outside 24 h).
  - `LeaderboardJob.main(args)`: register tables, convert the three tables with `toChangelogStream`, map to `BoardInput`, union, `keyBy(x -> "board")`, process; sinks `leaderboard` (key `board`) and `run.ranks` (key runId); stable uids; checkpointing every 60 s; job name `leaderboard`.
- [ ] **Step 1: Write failing tests:**
  - `LeaderboardSqlTest` (MiniCluster via `StreamExecutionEnvironment`/`StreamTableEnvironment` in local mode, `runs` registered from `fromChangelogStream` with a primary key, `status` from `fromDataStream` with a processing-time column): 12 runs → `ranked` ranks by water, a tie on water broken by more shifts, a tie on both broken by the earlier `endedAt`; an upsert of an existing runId with more water moves it up and does not duplicate it; `stats` for vacuumLoss with 4 runs, 3 `firstHandledWell` → operators 4, firstWell 3; non-graded kinds (including earthquake) absent; (modes) ranking is partitioned by mode: a Normal run and a Hard run with identical water both have `rn == 1`, and a Hard run never shifts a Normal rank; `stats` are grouped per mode (the same kind in both modes gives two rows); fuelContamination and tsunami rows appear.
  - `BoardAssemblerTest` (`KeyedOneInputStreamOperatorTestHarness`, processing time driven by the harness): top 10 of 12; a run that ended 25 h ago is in allTime but not today, and its RunRank has `today: null`; ranks are emitted only for changed runs; with no online input for 70 s the board says `online: 0`; at most one board per 5 s of processing time; stats percentage 75.0; (modes) runs of both modes: the `normal` and `hard` boards each hold only their own runs, "today" is ranked per mode, and a run's RunRank is its rank within its own mode.
- [ ] **Step 2:** `services/flink/mvn.sh test` → FAIL.
- [ ] **Step 3:** Implement, with comments on upsert tables, Top-N and changelogs, HOP windows and processing time at first use.
- [ ] **Step 4:** `services/flink/mvn.sh test` → PASS.
- [ ] **Step 5:** Commit `feat(flink): leaderboard job ranks runs in Flink SQL`.

### Task 9: Running Flink — image, compose, Caddy, deploy

**Files:**
- Create: `services/flink/Dockerfile`, `services/flink/flink-jobs.sh`, `services/simulator/test/flink-deploy.test.ts`
- Modify: `deploy/compose.yml`, `infra/docker-compose.yml`, `deploy/desal.caddy`, `scripts/deploy/deploy.sh`, `docs/hosting.md`, `README.md`

**Interfaces:**
- Produces:
  - `Dockerfile`: stage 1 `maven:3.9.11-eclipse-temurin-17` runs `mvn -B -DskipTests package` (context = repo root, so the build copies `services/flink`); stage 2 `FROM flink:2.2.1-java17`, copies the jar to `/opt/flink/usrlib/desal-flink.jar` and `flink-jobs.sh` to `/opt/flink/bin/`, creates `/flink-data/{checkpoints,savepoints}` owned by `flink`.
  - Compose services `flink-jobmanager` (`command: jobmanager`, `mem_limit: 700m`, ports `127.0.0.1:8082:8081`) and `flink-taskmanager` (`command: taskmanager`, `mem_limit: 1100m`), both with image `${FLINK_IMAGE}`, volume `flink-checkpoints:/flink-data`, `FLINK_PROPERTIES` setting: `jobmanager.rpc.address: flink-jobmanager`, `jobmanager.memory.process.size: 640m`, `taskmanager.memory.process.size: 1024m`, `taskmanager.numberOfTaskSlots: 2`, `parallelism.default: 1`, `state.backend.type: hashmap` (state is a few KB per game), the checkpoint dir `file:///flink-data/checkpoints` and savepoint dir `file:///flink-data/savepoints` (use the key names valid in Flink 2.2 — check with Context7 `/apache/flink` before writing), `web.submit.enable: false`, `rest.bind-address: 0.0.0.0`. The volume is named `flink-checkpoints` so the project makes it `desal_flink-checkpoints`. Local `infra/docker-compose.yml` gets the same two services built from `services/flink/Dockerfile`.
  - `flink-jobs.sh` (runs inside the jobmanager container): `stop-all <savepoint-list-file>` stops each running job (`report-card`, `leaderboard`) with `flink stop --savepointPath /flink-data/savepoints <jobId>` and writes `name=path` lines; `submit-all <savepoint-list-file> [--topic-suffix S]` submits each job detached with `-s <path>` when it has one, and if that submit fails, prints `!!! <name>: savepoint incompatible, starting fresh` and submits without it; refuses to submit a job whose name is already running.
  - `deploy.sh`: builds `desal-flink:$COMMIT` on the server like the other images, writes `FLINK_IMAGE` to `.env`; before `docker compose up`, if `desal-flink-jobmanager` is running, `docker exec` `flink-jobs.sh stop-all /flink-data/savepoints/last.txt`; after `up`, waits for the jobmanager REST (`curl -s 127.0.0.1:8082/overview`) up to 120 s, then `submit-all /flink-data/savepoints/last.txt`. A Flink failure prints loudly but does not fail the game's deploy (the game must not need Flink). Image cleanup loop gains `desal-flink`.
  - Caddy: `redir /flink /flink/` and `handle_path /flink/*` with the same `basic_auth` block and `X-Robots-Tag` header as `/kafka`, reverse-proxying `127.0.0.1:8082`; `handle /api/leaderboard` proxies `127.0.0.1:8081` (public). The final "done" line names `/flink` too.
  - `hosting.md`: server is 2 vCPU / 3.9 GB + 2 GB swap; the new containers and caps; how deploy savepoints and resubmits; how to open `/flink`, and the SSH tunnel `ssh -L 8082:127.0.0.1:8082` as the fallback; a "Flink memory" table to be filled with `docker stats` figures in Task 11.
- [ ] **Step 1: Write failing tests** `flink-deploy.test.ts` (static checks, in the style of `compose.test.ts`): `deploy/compose.yml` has both Flink services with the caps above, the REST port bound only to `127.0.0.1`, and `web.submit.enable: false`; `desal.caddy` puts `/flink` behind `basic_auth` and never proxies 8082 outside that block; `deploy.sh` calls `stop-all` before `docker compose up` and `submit-all` after; `flink-jobs.sh` passes `bash -n`.
- [ ] **Step 2:** `pnpm --filter @desal/simulator test` → FAIL.
- [ ] **Step 3:** Implement. Then locally: `docker compose -f infra/docker-compose.yml up -d --build`, run `flink-jobs.sh submit-all` in the jobmanager, open `http://localhost:8082` and confirm both jobs RUNNING; check the UI works behind a path prefix by running Caddy locally or by loading `http://localhost:8082/#/overview` through a `handle_path` test config. If the UI cannot work under `/flink`, drop the Caddy route, keep the tunnel, and record it in hosting.md.
- [ ] **Step 4:** `pnpm --filter @desal/simulator test` → PASS; `flink-jobs.sh stop-all` then `submit-all` locally resumes both jobs from savepoints (paste the output in the report).
- [ ] **Step 5:** Commit `feat(deploy): Flink session cluster with savepointed redeploys and /flink UI`.

### Task 10: End-to-end test with a local Flink

**Files:**
- Create: `scripts/e2e-flink.sh`, `services/gateway/test/flink.int.test.ts`
- Modify: `services/gateway/vitest.int.config.ts` (exclude `flink.int.test.ts` unless `DESAL_E2E_FLINK=1`), `README.md` (how to run it)

**Interfaces:**
- Consumes: everything above. The test follows `test/e2e.int.test.ts`: in-process `GameHost` + `SimRunner` (`tickMs: 20`) + gateway, `DESAL_TOPIC_SUFFIX` set by the script.
- `scripts/e2e-flink.sh`: brings up `infra/docker-compose.yml` (Kafka and Flink), picks `SUFFIX=.e2e-$(date +%s)`, creates the suffixed topics first with a small tsx script calling the simulator's `ensureTopics` and `waitForTopics`, then submits both jobs with `--topic-suffix $SUFFIX` and the broker `kafka:29092`, runs `DESAL_E2E_FLINK=1 DESAL_TOPIC_SUFFIX=$SUFFIX pnpm --filter @desal/gateway test:int -- flink`, and cancels the two jobs on exit (trap).
- [ ] **Step 1: Write the test:** a client starts a game, plays shift 1 to its end with the engaged bot's commands or no commands, starts shift 2, and waits up to 60 s for a `shiftReport`: its `shiftId` is 1 and its `productM3` equals the `shiftEnd` summary's `productM3` exactly. It then quits; within 60 s it receives a `rank` message; `GET /api/leaderboard` contains the run's call sign in the `normal` board (and not in `hard`); (modes) a second run started in Hard mode shows on `hard` only, with the body shaped `{ updatedAt, online, normal, hard }`. Assert over every message the client received and the HTTP body: neither the gameId of another game nor any runId appears (collect the runId by spying the runner's produced `gameEnd`).
- [ ] **Step 2:** `scripts/e2e-flink.sh` → FAIL first if anything is missing; fix in the owning code.
- [ ] **Step 3:** `scripts/e2e-flink.sh` → PASS. `pnpm -r test` still PASS without Flink running (the file is excluded).
- [ ] **Step 4:** Commit `test: end-to-end report card and leaderboard through local Flink`.

### Task 11: Deploy and check live

- [ ] **Step 1:** `pnpm -r test`, `pnpm -r typecheck`, `services/flink/mvn.sh test` → all PASS on a clean tree.
- [ ] **Step 2:** `scripts/deploy/deploy.sh`. Expect both jobs RUNNING (`ssh root@68.183.200.37 docker exec desal-flink-jobmanager flink list -r`).
- [ ] **Step 3:** Live check at https://desal.moosha.org: the start screen shows the leaderboard card (or "Leaderboard offline" if empty, then a board after the first finished run); play shift 1, start shift 2's handover and see the report card with the same water figure as "Last shift"; quit and see the call sign and rank on the Final report. `https://desal.moosha.org/flink/` asks for the password and shows both jobs. `curl -s https://desal.moosha.org/api/leaderboard | grep -c runId` → 0.
- [ ] **Step 4:** Record `docker stats --no-stream` with 3 live games in `docs/hosting.md`'s Flink memory table; commit `docs: Flink memory on the server`; redeploy only if code changed.
