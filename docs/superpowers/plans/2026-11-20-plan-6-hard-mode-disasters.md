# Hard Mode and Disasters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a player-chosen Normal / Hard mode, three disasters (contaminated fuel, earthquake, tsunami), and a livelier Normal shift 1.

**Architecture:**
- **Mode.** `Run.mode` is set from `startGame`, carried in the snapshot (v4, which migrates v3), and reported in `gameStart`, `gameEnd` and status.
- **Difficulty.** A `DifficultyProfile` per mode feeds `drawChaosPlan`.
- **Disasters.** They are new `ScenarioKind`s fired by the existing director. Each lives in its own file under `scenario/disaster/`. They are drawn from a separate RNG substream, so Normal's later shifts don't change.

**Tech Stack:** TypeScript, zod 4, vitest 4, React 19 + Vite, pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-11-20-hard-mode-disasters-design.md` (read §4 and §4.9 in full).

## Global Constraints

- **Determinism.** All randomness comes through `nextRandom`. The disaster draw uses `nextRandom((state.seed ^ DISASTER_SALT ^ shiftNumber) >>> 0)` and never consumes `state.seed`.
- **Normal shifts 2+.** Normal's draw for shifts 2+ is byte-identical to today's, except for an added disaster. Existing seeded tests for those shifts must pass unchanged.
- **`mode` defaults.** `mode` defaults to `'normal'` everywhere it is optional: the `startGame` command, the `newGame` ClientMsg, and records parsed from Kafka that predate it.
- **Snapshots.** The snapshot `VERSION` becomes 4, and `restore` also accepts version 3, migrating it to Normal with new fields defaulted.
- **Endings.** A disaster never ends a run directly. It ends a run only through `burnerFailed`, `noIntakePumps`, `bankrupt` or `outOfFuel`.
- **The event cap.** Disasters and their children (`QueuedEvent.disaster === true`) don't count toward `MAX_EVENTS` (7).
- **Disaster chances:**
  - Normal: 0.08 per shift from shift 3.
  - Hard: 0.4 per shift from shift 2.
  - Never two shifts running.
  - At most one per shift.
  - `earliestMinute` is drawn from 90–300.
- **Hard.** Every shift is a hell shift (shift 1 included, two in a row allowed). The hell target factor is 0.85, and orders are warned with p 0.7. The `CONTROLLER_FAULTS_FROM_SHIFT` gate stays.
- **Normal shift 1.** Two distinct `SHIFT_ONE_KINDS` events, at least 90 plant minutes apart.
- **Copy.** Plain operator English, metric units. The Hard button line is exactly: "Every shift is a bad one, and disasters strike."
- **Commands.** Test: `pnpm -r test`. Typecheck: `pnpm -r typecheck`. Both are green at the end of every task.

## Review Focus

1. **A v3 snapshot saved mid-shift by the live server.** It must restore as a Normal game and keep running, rather than being skipped. That would drop live players on deploy. Test in Task 2.
2. **A player switches back to the contaminated fuel before the flush finishes.** The damage must resume, and `flushFuel` must be rejected while that fuel is active. Test in Task 3.
3. **An earthquake when no spare pump exists, or with a sensor already failed.** Unviable children are dropped, the rest still fire, and nothing throws. Test in Task 4.
4. **A tsunami still in its warning or surge when the shift ends.** It must not leak into the next shift (`noFaults()`), and the event stays not-cleared in the debrief. Test in Task 5.
5. **An old client sends `newGame` with no mode, or the gateway reads a pre-mode `gameStart`/`gameEnd`/status record from Kafka.** Both must parse, with mode `'normal'`. Test in Tasks 1 and 7.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/schema/src/commands.ts` | Modify | `GameModeSchema`, `startGame.mode`, `flushFuel` crew job |
| `packages/schema/src/events.ts` | Modify | new kinds, `DISASTER_KINDS`, `mode` on `gameStart` / `gameEnd` |
| `packages/schema/src/status.ts` | Modify | `mode` on `PlantStatusSchema` |
| `packages/schema/src/ws.ts` | Modify | `newGame.mode` |
| `services/simulator/src/scenario/difficulty.ts` | Create | `DifficultyProfile`, `PROFILES`, `DISASTER_SALT` |
| `services/simulator/src/scenario/disaster/fuelContamination.ts` | Create | effect, per-tick step, viability, cleared |
| `services/simulator/src/scenario/disaster/earthquake.ts` | Create | follow-up children |
| `services/simulator/src/scenario/disaster/tsunami.ts` | Create | phases, surge damage, viability, cleared |
| `services/simulator/src/scenario/disaster/draw.ts` | Create | the disaster roll on its own substream |
| `services/simulator/src/{state,snapshot,shift,tick,commands,gameover,emit,constants}.ts` and `scenario/{draw,director,effects,library,sharp,chaosTypes}.ts` | Modify | wiring |
| `services/simulator/test/scenario/disaster/*.test.ts`, `test/hardmode.test.ts` | Create | tests |
| `services/simulator/test/bot.ts` | Modify | the engaged bot answers disasters; `mode` option |
| `services/gateway/src/sessions.ts` | Modify | pass `newGame.mode` into `startGame` |
| `apps/web/src/screens/{Start,TopBar,GameOver}.tsx`, `state/{GameProvider.tsx,store.ts}`, `expanded/labels.ts`, `plantConstants.ts`, `expanded/FuelView.tsx`, `equipment/Fuel.tsx` | Modify | UI |
| `docs/superpowers/specs/2026-11-19-flink-report-card-leaderboard-design.md`, `docs/superpowers/plans/2026-11-19-plan-5-flink-report-card-leaderboard.md` | Modify | Plan 5 learns modes |

---

### Task 1: Schemas, and stubs that keep the build green

**Files:**
- Modify: the four schema files above.
- Modify: `services/simulator/src/scenario/{library,effects,director}.ts` (stubs).
- Modify: `apps/web/src/expanded/labels.ts`, `apps/web/src/plantConstants.ts`.
- Test: `packages/schema/test/mode.test.ts`.

**Interfaces:**
- Produces:
  - `GameModeSchema = z.enum(['normal','hard'])` and `type GameMode`.
  - `ScenarioKindSchema` gains `'fuelContamination' | 'earthquake' | 'tsunami'`.
  - `DISASTER_KINDS: readonly ScenarioKind[] = ['fuelContamination','earthquake','tsunami']`.
  - `CrewJobSchema` gains `'flushFuel'`.
  - `startGame: { type:'startGame', mode: GameModeSchema.default('normal') }`.
  - `ClientMsg newGame: { t:'newGame', mode: GameModeSchema.default('normal') }`.
  - `gameStart` and `gameEnd` gain `mode: GameModeSchema.default('normal')`.
  - `PlantStatusSchema` gains top-level `mode: GameModeSchema.default('normal')`.

- [ ] **Step 1: Write failing tests in `packages/schema/test/mode.test.ts`**
  - `CommandSchema.parse({type:'startGame'}).mode === 'normal'`; `{type:'startGame', mode:'hard'}` keeps `'hard'`; `mode:'easy'` fails.
  - `ClientMsgSchema.parse({t:'newGame'})` has `mode 'normal'`.
  - A `gameEnd` record without `mode` parses with `'normal'`. Build it from the existing fixture used by the events tests.
  - `CrewJobSchema.parse('flushFuel')` succeeds. `DISASTER_KINDS` has exactly the three kinds, each in `ScenarioKindSchema.options`.
- [ ] **Step 2:** Run `pnpm --filter @desal/schema test`. Expected: FAIL.
- [ ] **Step 3:** Implement the schema changes.
- [ ] **Step 4: Stubs so `pnpm -r typecheck` passes.**
  - Simulator:
    - `eventMessage` returns a plain placeholder line per new kind.
    - `applyEffect` returns `s` for the new kinds.
    - `isCleared` returns `null` for them.
    - `CREW_JOBS.flushFuel = { costUsd: 1500, minutes: 60 }`.
    - `crewJobHasFault(s,'flushFuel')` returns `false`.

    Tasks 3–5 replace each stub. Mark each one `// Plan 6 Task N`.
  - Web:
    - `KIND_TEXT`: `fuelContamination: 'Contaminated fuel'`, `earthquake: 'Earthquake'`, `tsunami: 'Tsunami'`.
    - `plantConstants` crew entry: `flushFuel: { costUsd: 1500, minutes: 60, plain: 'flush fuel', doing: 'Flushing fuel' }`.
- [ ] **Step 5:** Run `pnpm -r typecheck && pnpm -r test`. Expected: all pass.
- [ ] **Step 6:** Commit `feat(schema): game modes, disaster kinds, flushFuel crew job`.

### Task 2: Mode in the run, difficulty profiles, snapshot v4

**Files:**
- Create: `services/simulator/src/scenario/difficulty.ts`.
- Modify: `state.ts`, `host.ts`, `gameover.ts`, `emit.ts`, `snapshot.ts`, `scenario/chaosTypes.ts`.
- Test: `services/simulator/test/scenario/difficulty.test.ts`, `test/snapshot.test.ts`, `test/host.test.ts`.

**Interfaces:**
- Consumes: `GameMode` (Task 1).
- Produces:
  - `Run.mode: GameMode`.
  - `createInitialState(seed, startPlantTime, gameId, mode: GameMode = 'normal')`.
  - `ChaosState.lastHadDisaster: boolean`. This is the existing `chaos` object plus the new field, default `false`.
  - `QueuedEvent.disaster: boolean` and `FiredEvent.disaster: boolean`.
  - `faults.fuelContamination: { fuel: FuelKind } | null` and `faults.tsunami: TsunamiFault | null`. Declare `TsunamiFault` here so the snapshot is done once: `{ warnRemainingTicks: number; surgeRemainingTicks: number; surgeDone: boolean; cleanedAfterSurge: boolean }`. `noFaults()` sets both to `null`.
  - In `difficulty.ts`:
    - `interface DifficultyProfile { hellEveryShift: boolean; disasterChance: number; disasterFromShift: number }`.
    - `PROFILES: Record<GameMode, DifficultyProfile>`:
      - normal `{false, 0.08, 3}`;
      - hard `{true, 0.4, 2}`.
    - `DISASTER_SALT = 0xd15a5`.
    - `DISASTER_MINUTE = [90, 300] as const`.

- [ ] **Step 1: Failing tests**
  - `host.step` with `startGame {mode:'hard'}` creates a state with `run.mode === 'hard'`. Its `gameStart` event has `mode: 'hard'`, and so does the status.
  - Without a mode, it is `'normal'`.
  - `endGame` emits a `gameEnd` with the run's mode.
  - `serialize` writes `version: 4`.
  - Restoring a v3 document gives `ok: true`, `run.mode === 'normal'`, `chaos.lastHadDisaster === false`, `faults.fuelContamination === null` and `faults.tsunami === null`, and every queued and fired event has `disaster: false`. Build the v3 document by taking a serialized v4 snapshot of a running mid-shift game, deleting those fields and setting `version: 3`.
  - Version 2 is still rejected.
- [ ] **Step 2:** Run `pnpm --filter @desal/simulator test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - `restore` accepts 3 or 4. For 3, it fills the defaults above before `PlantStateSchema.safeParse`.
  - The `startGame` mode reaches `createInitialState` in `host.ts`.
- [ ] **Step 4:** Run `pnpm -r typecheck && pnpm -r test`. Expected: pass.
- [ ] **Step 5:** Commit `feat(simulator): game mode on the run, difficulty profiles, snapshot v4`.

### Task 3: Contaminated fuel

**Files:**
- Create: `services/simulator/src/scenario/disaster/fuelContamination.ts`.
- Modify: `scenario/{effects,director,library,sharp}.ts`, `tick.ts` (or the fuel/heater unit that computes delivered MW and burner wear), `constants.ts`.
- Test: `services/simulator/test/scenario/disaster/fuelContamination.test.ts`.

**Interfaces:**
- Consumes: `faults.fuelContamination` (Task 2).
- Produces (all in `fuelContamination.ts`):
  - `fuelContaminationViable(s: PlantState): boolean`;
  - `applyFuelContamination(s: PlantState): PlantState`, which contaminates `s.fuel.active` (params: `{ fuel }`);
  - `contaminationActive(s: PlantState): boolean`, true when the burner is firing the contaminated fuel and no changeover away from it is underway.
- Constants:
  - `CONTAMINATION_HEAT_FACTOR = 0.7`;
  - `CONTAMINATION_WEAR_MULT = 40` (times `BURNER_WEAR_GAS`);
  - `CONTAMINATION_FLAMEOUT_P = 0.01` per tick.

  These are starting values; Task 6 may tune them.

- [ ] **Step 1: Failing tests** (drive a running shift, apply the effect directly, then tick):
  - While active, delivered heat is at most 0.7× that of an uncontaminated twin state, and `burnerCondition` falls about 40× faster than on gas.
  - Ignored, a healthy burner reaches `burnerFailed` within 270 ticks (3 plant hours) for seed 1, and the game ends with reason `burnerFailed`.
  - Switching fuel (`selectFuel`) stops the extra wear once the changeover completes.
  - `dispatchCrew flushFuel`:
    - is rejected with reason `'nothing to repair'` while the contaminated fuel is active and no changeover is underway;
    - is accepted after switching away;
    - on completion, `fuelContamination` is `null` and the event clears with `how:'crew'`.
  - Switching back before the flush restarts the damage.
  - `fuelContaminationViable` is false:
    - on gas with backup under 2 plant hours at nominal burn;
    - on backup with the gas cap under 0.7× nominal burn.
  - With the `CONTAMINATION_FLAMEOUT_P` roll forced (a seed where it fires), a flame-out trip occurs through the existing `flameOut` path.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement and replace the Task 1 stubs.
  - The radio line is: `Fuel lab: the ${fuel === 'gas' ? 'gas supply' : 'backup tank'} is contaminated. Switch fuel and flush it.`
  - The flame-out roll uses `nextRandom(s.seed)` inside tick and writes the seed back, as other per-tick rolls do.
- [ ] **Step 4:** Run `pnpm -r typecheck && pnpm -r test`. Expected: pass.
- [ ] **Step 5:** Commit `feat(simulator): contaminated fuel disaster and flushFuel crew job`.

### Task 4: Earthquake

**Files:**
- Create: `services/simulator/src/scenario/disaster/earthquake.ts`.
- Modify: `scenario/director.ts`, `scenario/library.ts`.
- Test: `services/simulator/test/scenario/disaster/earthquake.test.ts`.

**Interfaces:**
- Consumes: `QueuedEvent.disaster`, `drawEvent(kind, minute, seed, n, running)` (existing, in `library.ts`).
- Produces: `earthquakeFollowUps(s: PlantState, atMinute: number, seed: number): [Omit<QueuedEvent,'eventId'>[], number]`. It returns:
  - a `powerDip` at `atMinute`;
  - one `tubeLeak` at `atMinute`. With p 0.4 it is "severe": its ppm param is doubled. **Ruling:** the plant models one tube leak at a time, so the spec's "two leaks" becomes one severe leak;
  - two `sensorFailure`s at `atMinute`, on different instruments;
  - with p 0.5, an aftershock `powerDip` at `atMinute` + a value drawn from 20–60.

  All have `cascade: true` and `disaster: true`. Unviable kinds are dropped: a `powerDip` with no running pump and spare, or a sensor already failed.
- In `director.ts`:
  - `earthquake` is added to `INFORMATIONAL`, so it is noted at once.
  - When any kind in `DISASTER_KINDS` fires, it calls that disaster's follow-up hook (only the earthquake has one) and inserts the children into the queue with new eventIds. They bypass the `MAX_EVENTS` check.
  - The existing hell `CASCADES` count only non-disaster events toward the cap.

- [ ] **Step 1: Failing tests**
  - Firing an earthquake on a running plant (two running pumps, one spare) produces, in the same tick:
    - the `scenario` event for the earthquake, followed by `eventCleared how:'noted'`;
    - `scenario` events for a `powerDip`, a `tubeLeak` and two `sensorFailure`s on distinct loops.
  - The aftershock appears in some seeds and not others, over seeds 1–20.
  - A shift already at 7 non-disaster events still gets all the earthquake's children.
  - With no spare pump, there is no `powerDip` child and the rest still fire.
  - With a sensor already failed, the two `sensorFailure` children pick other instruments, or are dropped if none are left. Nothing throws.
  - The radio line contains "Earthquake".
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement. The radio line is: `Earthquake! Everyone is OK. Check the plant: power, tubes and instruments.`
- [ ] **Step 4:** Run `pnpm -r typecheck && pnpm -r test`. Expected: pass.
- [ ] **Step 5:** Commit `feat(simulator): earthquake disaster`.

### Task 5: Tsunami

**Files:**
- Create: `services/simulator/src/scenario/disaster/tsunami.ts`.
- Modify: `scenario/{effects,director,sharp,library}.ts`, `constants.ts`.
- Test: `services/simulator/test/scenario/disaster/tsunami.test.ts`.

**Interfaces:**
- Consumes: `faults.tsunami` (Task 2), `faults.stormFouling`, and the `cleanScreens` crew job.
- Produces:
  - `tsunamiViable(s)`: at least one usable intake pump.
  - `applyTsunami(s, p: { warnMinutes })`: sets the warning, with `warnMinutes` drawn from 15–25 in `drawEvent`.
  - `stepTsunami(s): PlantState`, called from `stepFaults`. It counts the warning, then the surge (`TSUNAMI_SURGE_TICKS = 45`, i.e. 30 plant minutes). At surge onset:
    - add `TSUNAMI_FOULING` to `faults.stormFouling`;
    - cool the seawater by 1–2 °C (drawn at fire time, as param `coolC`).

    Each surge tick adds `TSUNAMI_SURGE_WEAR / TSUNAMI_SURGE_TICKS` wear to every running pump (`TSUNAMI_SURGE_WEAR = 0.7`).
  - `crewJobHasFault(s,'cleanScreens')` is also true once `surgeDone && !cleanedAfterSurge`. Finishing `cleanScreens` sets `cleanedAfterSurge` when `surgeDone`.
  - `isCleared` for a tsunami: `'player'` when `surgeDone && cleanedAfterSurge && runningPumps >= 2`.

- [ ] **Step 1: Failing tests**
  - The radio line contains the warning minutes.
  - No pump wear is added during the warning.
  - Two healthy pumps left running through the whole surge each gain 0.7 ± 0.01 wear. A stopped pump gains none.
  - A pump at 0.4 wear left running reaches wear ≥ 1 and becomes unusable.
  - **Engaged sequence:** stop one of the two running pumps in the warning, then after the surge dispatch `cleanScreens` and start the spare. The plant never trips (one pump stays above the `noIntakeFlow` line), and the event clears `how:'player'`.
  - Stopping all pumps trips the plant with cause `noIntakeFlow`.
  - Ending the shift mid-surge leaves the next shift with `faults.tsunami === null`, and the debrief shows the tsunami not cleared.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement. The radio line is: `Tsunami warning! The surge hits the intake in about ${warnMinutes} minutes. Protect the pumps.`
- [ ] **Step 4:** Run `pnpm -r typecheck && pnpm -r test`. Expected: pass.
- [ ] **Step 5:** Commit `feat(simulator): tsunami disaster`.

### Task 6: The draw (Hard, the disaster roll, Normal shift 1), the bot and balance

**Files:**
- Create: `services/simulator/src/scenario/disaster/draw.ts`.
- Modify: `scenario/draw.ts`, `shift.ts`, `test/bot.ts`.
- Test: `test/scenario/draw.test.ts`, `test/hardmode.test.ts`.

**Interfaces:**
- Consumes: `PROFILES`, `DISASTER_SALT`, `DISASTER_MINUTE` (Task 2), and the three viability functions (Tasks 3, 5; the earthquake is always viable).
- Produces:
  - `drawDisaster(s: PlantState, shiftNumber: number): QueuedEvent | null`. It is pure, uses its own substream, and returns null when:
    - `shiftNumber < profile.disasterFromShift`;
    - `chaos.lastHadDisaster` is set;
    - the roll is at or above `profile.disasterChance`;
    - no kind is viable.

    Otherwise it picks uniformly among the viable kinds, with `earliestMinute` from `DISASTER_MINUTE`, `disaster: true` and `cascade: false`.
  - `drawChaosPlan` gains `mode: GameMode`:
    - Hard forces `hell = true` and ignores `lastWasHell`. Its shift 1 uses `SHARP_KINDS`, not `SHIFT_ONE_KINDS`.
    - Normal shift 1 draws two distinct `SHIFT_ONE_KINDS`, the second with `earliestMinute` at least 90 after the first. `QueuedEvent.earliestMinute` already exists; give the first 0 and the second 90.
  - `drawPendingPlan` appends `drawDisaster`'s event (with the next eventId) and sets `chaos.lastHadDisaster` when the shift starts.
  - `BotOptions` gains `mode?: GameMode` and `passive?: boolean`. With `passive`, the bot only sends `startShift`. The engaged bot answers:
    - contaminated fuel: `selectFuel` to the other fuel, then `dispatchCrew flushFuel`;
    - tsunami warning: stop pumps until one runs; after the surge, `cleanScreens`, then start the spare (its existing two-pumps rule);
    - earthquake children: already covered by the existing rules.

- [ ] **Step 1: Failing tests**
  - **Draw tests:**
    - For seeds 1–50, Normal shift 2+ queues equal the pre-change queues, ignoring any appended disaster. Pin them by snapshotting the current output in the test before changing `draw.ts`.
    - Hard has `hell === true` for shift 1 and two shifts in a row.
    - Normal shift 1 has exactly two non-disaster events of distinct `SHIFT_ONE_KINDS`, with `earliestMinute` 0 and 90.
    - `drawDisaster` returns:
      - null on Hard shift 1 and Normal shift 2;
      - null when `lastHadDisaster` is set;
      - non-null for some seeds on Hard shift 2.
    - Over 500 seeds, Hard's rate is within 0.35–0.45 and Normal's (shift 3+, `lastHadDisaster` false) within 0.05–0.11.
    - Calling `drawDisaster` leaves `state.seed` unchanged.
  - **`test/hardmode.test.ts`** (20 seeds, 1–20; the spec's §4.8 and §4.9.1):
    - Passive Hard: at least 14 of 20 runs end, or miss a shift target, by the end of shift 3.
    - Passive Normal: all 20 meet shift 1's target.
    - Engaged Hard: a median of at least 3 shifts.
    - Each disaster forced into shift 2 (inject it into the pending plan) with the engaged bot: the shift ends with the run alive.
    - Contaminated fuel forced with the passive bot: the run ends `burnerFailed`.
    - Tsunami forced with the passive bot: at least one pump's wear has risen by 0.6 or more since the shift began.
  - The existing `balance.test.ts` (engaged Normal, median at least 8 shifts) stays green.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Tune the Task 3 and 5 constants only if `hardmode.test.ts` demands it. Record any changed value and why in the commit message.
- [ ] **Step 4:** Run `pnpm -r typecheck && pnpm -r test`. Expected: pass. Update shift-1 tests that pinned a single event to the new two-event draw. Don't weaken them.
- [ ] **Step 5:** Commit `feat(simulator): Hard draws, disaster roll, livelier Normal shift 1`.

### Task 7: Gateway passes the mode through

**Files:**
- Modify: `services/gateway/src/sessions.ts`.
- Test: `services/gateway/test/sessions.test.ts` (or wherever the `newGame` tests live).

**Interfaces:**
- Consumes: `ClientMsg newGame.mode` (Task 1).

- [ ] **Step 1: Failing tests**
  - `{t:'newGame', mode:'hard'}` dispatches a `startGame` envelope with `command.mode === 'hard'`.
  - `{t:'newGame'}` dispatches with `'normal'`.
  - `{t:'newGame', mode:'nightmare'}` is rejected the same way any invalid ClientMsg is today.
  - A pre-mode `gameStart` record from Kafka still binds the game, with mode `'normal'`.
- [ ] **Step 2:** Run `pnpm --filter @desal/gateway test`. Expected: FAIL.
- [ ] **Step 3:** Implement by threading the parsed mode into `this.envelope(gameId, { type:'startGame', mode })`.
- [ ] **Step 4:** Run `pnpm -r typecheck && pnpm -r test`. Expected: pass.
- [ ] **Step 5:** Commit `feat(gateway): newGame carries the game mode`.

### Task 8: Web

**Files:**
- Modify: `apps/web/src/screens/{Start,TopBar,GameOver}.tsx`, `state/{GameProvider.tsx,store.ts}`, `expanded/FuelView.tsx` (and `equipment/Fuel.tsx` if it holds crew buttons), the how-to-play text in `screens/Start.tsx`, and `screens/screens.css` / `room.css`.
- Test: the existing web test files beside each component (vitest + testing-library, as used today).

**Interfaces:**
- Consumes: `PlantStatus.mode`, `gameEnd.mode`, `CrewJob 'flushFuel'`.
- Produces:
  - `StartProps.onStart: (mode: GameMode) => void`;
  - `GameProvider.newGame(mode: GameMode): boolean`, which sends `{ t:'newGame', mode }`;
  - the store keeps `mode` from the latest status, and from `gameEnd` for the over screen.

- [ ] **Step 1: Failing tests**
  - Start renders two buttons, "Start a run" and "Start a Hard run". The Hard one is followed by the exact line "Every shift is a bad one, and disasters strike." Clicking each calls `onStart` with `'normal'` or `'hard'`.
  - TopBar shows a `HARD` tag only when `status.mode === 'hard'`.
  - GameOver shows "Hard" or "Normal".
  - FuelView shows a `flushFuel` CrewButton.
  - The how-to-play text includes one line per disaster:
    - "Contaminated fuel: switch to the other fuel, then send the crew to flush it."
    - "Earthquake: everything breaks at once; fix what hurts most first."
    - "Tsunami: when the siren sounds, run on one intake pump until the surge passes, then clean the screens."
- [ ] **Step 2:** Run `pnpm --filter @desal/web test`. Expected: FAIL.
- [ ] **Step 3:** Implement. The HARD tag uses `var(--bad)` text in the existing topbar style. Keep the 16px gutter and no horizontal scroll at phone width.
- [ ] **Step 4:** Run `pnpm -r typecheck && pnpm -r test && pnpm --filter @desal/web build`. Expected: pass.
- [ ] **Step 5:** Commit `feat(web): choose Normal or Hard, HARD tag, flush fuel, disaster help`.

### Task 9: Plan 5 learns modes, end-to-end check, deploy

**Files:**
- Modify: `docs/superpowers/specs/2026-11-19-flink-report-card-leaderboard-design.md`, `docs/superpowers/plans/2026-11-19-plan-5-flink-report-card-leaderboard.md`.

- [ ] **Step 1: Amend Plan 5's spec and plan** per spec §7:
  - `RunResult.mode`;
  - Top-N, stats and "today" computed per mode;
  - `/api/leaderboard` returns `{ normal, hard }`;
  - the report card shows the mode and grades `fuelContamination` and `tsunami` like the sharp kinds, with `earthquake` noted;
  - Plan 5's snapshot bump becomes v5.

  Update the interfaces and tests the plan names to match. Commit `docs: Plan 5 learns game modes`.
- [ ] **Step 2: Local end-to-end check.** Bring up the infra, simulator, gateway and web (as in earlier plans' e2e steps), then start a Hard game in a browser. Confirm:
  - the HARD tag shows;
  - the first shift's orders mention a rough shift (when warned);
  - events fire within the first 2 plant hours.
- [ ] **Step 3: Deploy.** Ask the user before running `scripts/deploy/deploy.sh`. Then confirm all of these:
  - `docker ps` shows healthy containers;
  - the simulator log shows live games restored rather than skipped (a v3 restore);
  - a Hard game starts on https://desal.moosha.org.

---

## Execution notes

- Branch `plan-4-chaos`, in the worktree `/Users/hriday/code/desal/.claude/worktrees/plan-2-games`. BASE is the commit after this plan.
- Tasks run in order. Tasks 3–5 depend on Task 2's state fields, and Task 6 depends on the viability functions from Tasks 3–5.
