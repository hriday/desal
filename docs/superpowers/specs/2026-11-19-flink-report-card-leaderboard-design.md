# Plan 5 design: Flink report card and leaderboard

> **Amended 2026-11-20 for Plan 6 (modes).** Plan 6 (`2026-11-20-hard-mode-disasters-design.md`) adds a game mode (`'normal' | 'hard'`), three new scenario kinds (`fuelContamination`, `earthquake`, `tsunami`) and the crew job `flushFuel`, and takes snapshot version 4. Changes here: `mode` on the run records and the report card; the leaderboard, its stats and "today" are computed per mode and served as `{ normal, hard }`; verdicts cover the new kinds; Plan 5's snapshot bump is v5 (migrating v4). Amended passages say "(modes)".

Status: draft for approval, 2026-11-19. This document extends the "main spec", `2026-11-18-desal-operator-game-design.md`, and Plan 4's `2026-11-19-chaos-director-design.md`. Where they disagree, this document wins for Flink. It replaces the main spec's plan to move alarms into Flink.

## 1. Intent and why

The project has two goals, and the game comes first. The second goal is learning Kafka and Flink: Flink must do real work that a player notices, not decoration. Since the main spec was written, alarms moved into the browser (they are instant) and the debrief moved into the simulator (Plan 4's event list). Porting either to Flink would look the same to a player, only slower.

The user answered "I don't know" when asked what Flink should give a player. Then the user accepted my proposal, quoted: "1. Report card at handover … 2. Leaderboard across all players". For the build approach, the user chose B: Java for the report card and Flink SQL for the leaderboard. On names, the user chose (a): a generated call sign per run, with no free text. The user also said, quoted: "flinks and kafka only I will see". The Flink dashboard is admin-only, like Kafka UI.

What this buys:
- **For the player:** each shift is judged ("you took 2 min to start the standby"), and runs are compared with everyone else's.
- **For learning:**
  - the DataStream API: keyed state, joining two streams, and state that survives restarts through checkpoints and savepoints;
  - Flink SQL: aggregations, windows, and a compacted topic read as a table;
  - running a Flink session cluster in production on a small server.

## 2. Goals, non-goals, anti-goals

**Goals**
- A **report card** for every completed shift. Shift N's report shows on the handover for shift N+1, starting with shift 1's report on shift 2's handover. Flink computes it from the shift's events and status stream. A shift cut short by game over gets no report card; its events still count in the run's stats (§4.3).
- A **leaderboard** on the start screen, plus the run's rank on the game-over Final report. (Modes) There is one board per game mode, Normal and Hard, and a run is ranked only against runs of its own mode.
- A **call sign** for every run, for example "Kestrel-42", shown in the top bar, on the handover and on the Final report.
- The **Flink web UI** at `https://desal.moosha.org/flink`, behind the same basic auth as `/kafka`.

**Non-goals**
- Moving alarms, trends or scoring rules out of the browser or simulator.
- Accounts, logins, typed names, or history across runs for one person.
- Trends over many shifts. The report compares this shift with the previous one and with the player's best shift so far in this run, nothing longer.

**Anti-goals** (failure even if it technically works)
- **The game must never need Flink to be playable.** If Flink is down or slow, handover shows today's debrief and the start screen shows "Leaderboard offline". Nothing blocks.
- **No gameId ever reaches the leaderboard, a Kafka topic that clients see, or another player's browser.** A gameId lets a socket send commands to that game.
- The Flink UI must not be reachable without the password.
- Report numbers must not contradict the simulator's debrief. Water, trips and spend come from the same events, so they must match the simulator's `ShiftSummary` exactly.

## 3. Approaches considered

- **A. Java DataStream API for both jobs.** Most control, but the leaderboard becomes a lot of hand-written counting code.
- **B. Java DataStream for the report card, Flink SQL for the leaderboard (chosen by the user).** Each job uses the tool built for its shape: per-game logic with response timing, and aggregation across all games. Both live in one Maven project and one jar, and the learner sees both halves of Flink.
- **C. Flink SQL only.** The least code, but response-time logic becomes MATCH_RECOGNIZE patterns that are hard to read and debug.

Also dropped:
- **PyFlink:** a heavier image, thinner docs, and against the main spec's Java choice.
- **Alarms in Flink:** invisible to the player, so decoration (see §1).

## 4. Design

### 4.1 Topology

```
plant.events ─┐                                   ┌─> shift.reports (key gameId)      ─> gateway ─> that game's sockets
plant.status ─┼─> Job 1 "report-card" (DataStream) ┤
              │                                   └─> run.results  (key runId, compacted, kept forever)
              │
run.results ──┼─> Job 2 "leaderboard" (Flink SQL) ─> leaderboard (one key "board", compacted) ─> gateway ─> every socket
plant.status ─┘   (also counts plants online)
```

- **Job 1 is keyed by `gameId`.** It is driven by plant time in the payload (`tick`, `plantTime`) and by each game's record order, with no watermarks on plant time. This follows the main spec and `docs/streaming-notes.md` ("Event time").
- **Job 2 reads `run.results` as an upsert table** from the earliest offset, so the all-time board is rebuilt from that topic whenever the job restarts without state. It reads `plant.status` only to count plants online, using processing time.
- **New topics:**
  - `shift.reports`: 7-day retention, 1 partition, key = gameId, read only by the gateway.
  - `run.results`: compacted, retention forever, key = runId.
  - `leaderboard`: compacted, one key.
  - `run.ranks`: compacted, key = runId (§4.4).
  - Topic setup follows the existing `ensureTopics` pattern. My call: Flink does not create topics, and the simulator's topic list gains them.
- **runId is not the gameId.** It is a random id the simulator mints at `startGame`, so `run.results` and `leaderboard` never contain a gameId.

### 4.2 Call sign and runId (simulator)

- At `startGame`, the simulator draws a **call sign** from the game's seed. It is an adjective or bird name from a fixed list of about 64 clean words, plus a number from 10 to 99, for example "Kestrel-42". It also mints a **runId** (a UUID). Both go into game state and the snapshot (v5, since Plan 6 took v4; a v4 save is migrated by deriving the call sign from its seed and minting a fresh runId).
- The call sign appears in `gameStart`, in `gameEnd`, and in status as `callSign`. (Modes) Plan 6 puts `mode` on `gameStart`, `gameEnd` and at the top level of `PlantStatus`; each defaults to `'normal'` for older records, and Flink reads it from there. The runId appears only in `gameEnd` and `shiftEnd` (as `runId`), which Flink reads. The gateway does not forward `runId` to browsers; a test pins this.
- Call signs need not be unique. The leaderboard shows the call sign with the run's date, for example "Kestrel-42 · 19 Nov".

### 4.3 Report card (Job 1, Java DataStream)

The job is keyed by gameId and joins `plant.events` with `plant.status` (connect + KeyedCoProcessFunction or equivalent). Per shift, it keeps:

- (Modes) The run's `mode` is read from `gameStart` (default `'normal'`) and copied onto every `ShiftReport` and the `RunResult`; the report card shows it.
- **Each fired event** (`scenario`): kind, fire time, and:
  - **response time:** plant minutes from firing to the first status in which the player's response is visible. The required response per kind follows Plan 4 §4.3:
    - pumpTrip: two intake pumps running;
    - controllerFault: that loop in Manual. Status reports `loops[*].fault`, so the job knows which loop it is;
    - sensorFailure: a `replaceSensor` crew job. The faulted loop is deliberately not in any event or status (Plan 4 ruling R4: the radio must not give it away), so Flink cannot tell which loop it is. Putting "a loop" in Manual would credit lucky guesses, so only the crew counts;
    - tubeLeak, vacuumLoss and storm: a matching crew job dispatched;
    - powerDip: two pumps running;
    - bloom: the chlorine dose raised. My call: compare the dose against the value at firing, which the job holds in state;
    - (modes) `fuelContamination` and `tsunami`: no status signal separates "responded" from "cleared" (the right response is a fuel switch or running on one pump, and the damage keeps coming), so they are graded on **time-to-clear**: the response time is the plant minutes from firing to the `eventCleared` with `how` player or crew. Crew job `flushFuel` is not treated as a response;
    - (modes) `earthquake` is **noted**: it clears at once with `how: 'noted'`, gets outcome "noted" and no verdict. Its consequences arrive as ordinary child `scenario` events (`cascade: true`) and are graded as the sharp kinds they are.
  - **time to clear:** from `eventCleared`, with the `how` value.
  - **outcome:** "cleared by you", "fixed by crew", "passed", "noted" or "not cleared". This is the same wording as the debrief.
  - **verdict:** *quick* (response ≤ 5 plant min), *ok* (≤ 15), *slow* (> 15), or *missed* (no response by shift end). Informational kinds, and `earthquake`, get no verdict. The thresholds are my call, as named constants.
- **Shift totals are copied from the `shiftEnd` summary, not recomputed.** That covers in-spec and off-spec water, off-spec minutes, trips and spend. Status and `accountChange` can't reproduce them: gas burn is not an `accountChange`, and status has no salinity. Copying keeps the "match the simulator exactly" anti-goal trivially true. Flink's own work is everything the summary lacks: per-event response timing, the hourly pace, plant minutes tripped (from status), the comparisons, the grade, and the cross-run aggregation.
- **Hourly pace:** in-spec water at the end of each plant hour against the hour's share of the target (8 points). The handover draws this as a small sparkline.
- **Comparison:** this shift against the previous shift and against the best shift so far in this run, on target %, events handled well, and minutes tripped. This is kept in keyed state. Shift 1 has no previous shift, so its report leaves the comparison out.
- **Grade:** A to F from one documented formula, for example 50 % target achievement, 30 % event handling, 20 % no trips or off-spec. The formula is a named, unit-tested function. My call on the weights; the builder tunes them so that a shift handled well by Plan 4's engaged bot gets a B or better and an untouched shift gets a D or worse.
- **Emitted on `shiftEnd`:** one `ShiftReport` record to `shift.reports`.
- **Emitted on `gameEnd`:** one `RunResult` record to `run.results`, containing runId, callSign, `mode`, endedAt (wall clock), shiftsCompleted, totalProductM3, the end reason, and per-kind event stats (count, handled-well count, mean response).
- **Restarts:** the job uses checkpoints and resumes from them. Upgrades use stop-with-savepoint and then restore (§4.6).
- **Snapshot epochs:** follow `docs/streaming-notes.md`. A record with a higher `epoch` than the job has seen means the simulator restored from a snapshot, possibly up to 30 ticks back after a crash. The job resets its marks and treats that epoch's records as the truth:
  - Per-event records are keyed by eventId within the shift. A re-fired event in the new epoch overwrites the old record.
  - Hourly pace points at or after the restored tick are recomputed from the new epoch's status, which carries the cumulative `shiftProductM3`.
  - Shift totals come from `shiftEnd` (above), so a crash cannot make them disagree with the simulator.

### 4.4 Leaderboard (Job 2, Flink SQL)

The job publishes one record. (Modes) Everything below is computed per mode (the SQL partitions by `mode`), so the record holds two boards: `{ updatedAt, online: n, normal: Board, hard: Board }` with `Board = { allTime: Row[10], today: Row[10], stats: [...] }`. `online` counts plants across both modes. The assembler emits both boards in the one record. Everything below describes one board.
- **allTime:** top 10 by `totalProductM3`, ties broken by more shifts, then the earlier run.
- **today:** the same ranking over runs that ended in the last 24 hours of wall clock.
- **Row:** rank, callSign, shiftsCompleted, totalProductM3, the end date, and `runId` (needed so the gateway can work out "your rank"). The browser never receives runId; the gateway strips it (§4.5).
- **online:** the number of distinct gameIds with a status record in the last 60 s. The count leaves the job, but the gameIds do not.
- **stats:** for each sharp event kind, the share handled well across all runs, for example "62 % of operators handled their first vacuum loss well".
- **Ranks for every run:** the job also writes each run's all-time rank, and today's rank while the run is still within 24 h (both within the run's own mode), to a compacted topic `run.ranks` (key runId). The gateway reads it to show the player their own rank even outside the top 10, for example "#57 all time". Like `run.results`, this topic is read only by the gateway and never reaches browsers.
- **Update rate:** at most every 5 s. My call: SQL results go through a small DataStream step that assembles the one record and throttles it.

### 4.5 Gateway

- Consumes `shift.reports`. It forwards each report only to sockets bound to that gameId, as a new server message `shiftReport`.
- Consumes `leaderboard` and caches the latest record.
  - It sends a `leaderboard` message on connect and on each change, with `runId` removed. (Modes) `GET /api/leaderboard` returns both boards: `{ updatedAt, online, normal, hard }`.
  - For a socket whose game has ended, it adds `yourRank: { allTime, today | null }`, looked up in `run.ranks` through the runId from that game's `gameEnd`. The gateway sees `gameEnd`; the browser never sees the runId.
- Schema: new zod schemas in `packages/schema` for `ShiftReport`, `RunResult` and the leaderboard record. These are the shared types, and the Java side mirrors them.
- **Java mirror:** the Java POJOs for these records are checked by a contract test. The test feeds the zod schemas example JSON produced by the Java serializers. My call on the mechanism: a JSON fixture committed by the Java tests and validated by a schema test.

### 4.6 Running Flink on the server

- A **session cluster**: one `flink-jobmanager` container and one `flink-taskmanager` container (2 slots), from an image built `FROM` the official Flink 2.x Java 17 image with the job jar added. The exact Flink and connector versions are the builder's to pin. Use the newest Flink 2.x release that has a released `flink-connector-kafka`, both at least two weeks old.
- **Memory:**

  | Process | Total process memory | Container cap |
  |---|---|---|
  | jobmanager | 640 MB | ~700 MB |
  | taskmanager | 1,024 MB | ~1.1 GB |

  - Existing caps stay. The total is about 3.5 GB of the 3.9 GB, with 2 GB of swap.
  - The builder confirms with `docker stats` under 3 live games and records the figures in `docs/hosting.md`.
- **Checkpoints and savepoints:**
  - checkpoints every 60 s to the Docker volume `desal_flink-checkpoints`, with RocksDB or the hashmap backend (builder's call, justified by state size);
  - savepoints go to the same volume.
- **Deploy (`scripts/deploy/deploy.sh`):**
  1. Build the Flink image on the server, like the other images.
  2. If the jobs are running, stop each one with a savepoint.
  3. Bring the cluster up.
  4. Submit each job from its savepoint, or fresh on the first deploy.
  - A job whose state is incompatible with its savepoint is resubmitted fresh, with a loud log line. This is acceptable: the reports only lose the shift in progress, and the leaderboard rebuilds from `run.results`.
- **The Flink UI:**
  - served at `/flink` through Caddy, behind the same basic auth as `/kafka`, with `X-Robots-Tag: noindex`;
  - if Flink's UI cannot run under a path prefix, the fallback is the SSH tunnel only, documented in hosting.md. The builder checks the prefix first;
  - the Flink REST port is never exposed publicly. Job submission and cancelling through the UI are admin-only behind the password, with `web.submit.enable: false` and cancel left on.

### 4.7 Web

- **Handover:** a "Report card" section above "Last shift" (modes: tagged HARD for a Hard run) holds the grade (a large letter stamped on the clipboard sheet), the event table with verdicts, the hourly pace sparkline, and the comparison lines.
  - Until the report arrives, the section shows "Grading…".
  - If no report has arrived 10 s after `shiftEnd`, the section is hidden and the existing debrief stands alone. A report that arrives later still appears.
- **Start screen:** a leaderboard card under the plant strip (modes: showing both the Normal and the Hard board, each labelled), with an "All time" / "Today" toggle, the top 10, "N plants running now", and two or three rotating stats lines. If no leaderboard is received within 5 s of connecting, it shows "Leaderboard offline".
- **Final report:** the call sign, plus "Rank #N all time · #M today" (within the run's mode) when available, otherwise "Ranking…".
- **Top bar:** the call sign.
- **Visual style:** follows Plan 4 §4.11, with the clipboard sheet and display font. Motion goes in `motion.css`, covered by the reduced-motion override.

### 4.8 Testing

- **Java:** Flink's operator test harnesses for the report-card function, driven by fixed event and status sequences. They cover:
  - each verdict band;
  - the epoch and tick dedup;
  - previous-shift comparison;
  - the grade bands;
  - RunResult on gameEnd.
- **Flink SQL:** a MiniCluster test feeding `run.results` fixtures, covering ranking, tie-breaks, the today window and the stats.
- **End-to-end:** an integration test runs the simulator against a local Flink. It plays a scripted shift and asserts:
  - a `shiftReport` reaches the gateway client;
  - its water figure equals the simulator's `ShiftSummary` exactly;
  - after a quit, the leaderboard contains the run's call sign and no gameId or runId anywhere in the client payload.
- **Local dev:** `docker compose` gains jobmanager and taskmanager services. README documents how to build and submit the jobs locally.

## 5. Constraints

- The server is 2 vCPU with 3.9 GB of RAM and 2 GB of swap. The user resized it on 2026-11-19, and I verified it on the server: `nproc` 2, 3,915 MB total. `docs/hosting.md` still says 1 vCPU / 2 GB, so the plan updates it. Caps are as in §4.6. Kafka 4.1.1 runs in KRaft mode.
- Use Java 17 and Maven. Pin versions exactly. Flink 2.x and its Kafka connector must have been released at least two weeks ago.
- Code comments explain each Flink concept where it is first used, as the main spec requires (keyed state, connect, checkpoint, savepoint, upsert table, windows).
- All existing guarantees stay: the game plays without Flink, saves resume across redeploys, and no gameId leaks.
- Snapshot goes to v5 for callSign and runId (Plan 6 took v4 for modes and disasters, and migrates v3). Plan 5's step migrates v4 saves (callSign derived from the seed, a fresh runId) and keeps v3 -> v4 -> v5 working; versions older than v3 follow the existing skip rule.

## 6. Left to the builder

- Exact Flink and connector versions, the state backend, and the parallelism (1 is expected).
- How the SQL results are assembled into the single leaderboard record.
- The word list for call signs. It must be clean, with no slurs or rude words, and kept in code.
- Layout details of the report card and the leaderboard card, within §4.7.
- Whether the response for a crew job is "dispatched" or "dispatched and accepted". My call: dispatched and accepted, as shown by status `crew`.

## 7. My calls (to check)

1. Response times come from status changes, not from `plant.commands`. Accepted commands have no event, and status shows what actually happened.
2. Verdict bands are quick ≤ 5, ok ≤ 15, slow > 15 plant minutes, or missed.
3. Grade weights are 50 / 30 / 20, tuned against the engaged and untouched bots.
4. A separate runId keeps gameIds out of every shared topic. Call signs are drawn from the seed and need not be unique.
5. The leaderboard ranks by total in-spec water, with ties broken by shifts. "Today" means the last 24 h of wall clock.
6. A report waits 10 s before the debrief shows alone, and the leaderboard waits 5 s before showing "offline".
7. The session cluster has 640 MB for the jobmanager and 1,024 MB for the taskmanager.
8. Topics are created by the simulator's `ensureTopics`, not by Flink.
9. The Flink UI is at `/flink` behind basic auth, with the SSH tunnel as the fallback if the path prefix fails.
10. Shift totals are copied from `shiftEnd`. Flink computes only what the simulator doesn't (§4.3).
11. sensorFailure counts as handled only by the replaceSensor crew, because the faulted loop is deliberately hidden.
12. After a crash restore, the newer epoch's records win, following `streaming-notes.md`.
13. Every run gets a rank, through `run.ranks`, so the Final report shows "#57" rather than only top-10 ranks.
14. Shift N's report shows at shift N+1's handover. A shift cut short by game over gets no report, but its events count in the run's stats.
15. (Modes) Boards, stats and "today" are per mode; the public endpoint returns `{ normal, hard }` and the start screen shows both. `mode` rides on the run records. `fuelContamination` and `tsunami` are graded on time-to-clear, `earthquake` is noted.
