# Ejector Train (Two-Stage Ejectors, Condenser Cooling, Air Leaks, Standby Train) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make vacuum drops diagnosable and manageable. Model the two-stage ejector train's capacity (working trains, condenser cooling, air load), add a paid Standby ejectors switch, two new faults (`coolingLoss`, `airLeak`) with crew fixes, and four diagnosis readings.

**Architecture:**
- **State.** `PlantState` gains `ejectors: { coolCap, standby, unbilledTicks }` and two faults: `faults.coolingLoss: { floor }` and `faults.airLeak: { load }`. Snapshot v8 migrates v7.
- **Physics.** A new `units/ejectors.ts` owns the train:
  - `stepEjectors` ramps `coolCap`.
  - `ejectorCapacity` gives the effective capacity in [0, 1]. `stepStages` multiplies the vacuum target by it.
  - `ejectorReadings` gives the four readings.
- **Faults.** Both faults are planned on one salted substream ("vacuum train"), on their own clock like lowSteam. They never consume `s.seed`.
- **Consumers.** The web adds an "Ejector train" block, the switch, two crew buttons, hints and labels. Flink grades the new kinds, and counts standby ejectors as a vacuumLoss response.

**Tech Stack:** TypeScript, zod 4, vitest 4, React 19 + Vite, pnpm monorepo; Java 17, Flink 2.2.1, Maven via `services/flink/mvn.sh` (Docker).

**Spec:** `docs/superpowers/specs/2026-11-21-ejector-train-design.md` (short; read all of it). Plan 8's plan, `docs/superpowers/plans/2026-11-21-plan-8-plant-realism.md`, is the precedent for every pattern reused here: the standby cost, the own-clock substream, the snapshot migration and the frozen fixtures.

## Global Constraints

- **Capacity model** (`units/ejectors.ts`):
  - `trains = (faults.ejectorFailed ? 0 : 1) + (ejectors.standby ? 1 : 0)`.
  - `airLoad = faults.airLeak?.load ?? 1`.
  - `ejectorCapacity(s) = min(1, min(trains, ejectors.coolCap) / (airLoad × ejectorLoadFactor(s.heater.tbtC, s.heater.firingPct)))`.
  - At nominal (1 train, `coolCap` 2, `airLoad` 1, load factor 1) it is exactly 1.
- **Vacuum target** (`stepStages`):
  - If `faults.ejectorFailed && !ejectors.standby`, today's rate-based fall applies, unchanged.
  - Otherwise the target is `VACUUM_QUALITY_MIN + (1 − MIN) × pct(vacuum.output) × ejectorReach(motiveBar) × ejectorCapacity(s)`, with the same lag as today.
  - The nominal plant is bit-for-bit unchanged: BALANCE and the plan7balance and hardmode bands hold.
- **Constants** (`constants.ts`):
  - `COOL_CAP_NOMINAL = 2`;
  - `COOLING_LOSS_FALL_PER_MIN = 0.2`: `coolCap` falls linearly toward the fault's floor and never goes below it. It snaps back to 2 on the tick the fault is null;
  - `COOLING_LOSS_FLOOR = [0.25, 0.40] as const` (0.01 grid);
  - `AIR_LEAK_LOAD = [2.5, 3.5] as const` (0.1 grid);
  - `STANDBY_EJECTORS_COST_USD_PER_H = 100`.
- **Crew jobs** (`CREW_JOBS`; web `plantConstants.ts`):
  - `cleanStrainer: { costUsd: 400, minutes: 30 }`, plain `'clean the condenser strainer'`, doing `'Cleaning condenser strainer'`;
  - `sealLeak: { costUsd: 600, minutes: 60 }`, plain `'seal the air leak'`, doing `'Sealing air leak'`.
  - `crewJobHasFault`: `cleanStrainer` needs `faults.coolingLoss !== null`, and `sealLeak` needs `faults.airLeak !== null`.
  - Finishing a job sets that fault to null.
- **Readings** (telemetry unitId `vacuum`, emitted right after `vacuum.motiveSteamBar`, in this order). `TELEMETRY_SENSOR_COUNT` 128 → **132**:
  - `vacuum.lastStageMbar` = `6.112 × exp(17.62 T / (243.12 + T))` with `T = bottomTempC(s)` (the Magnus formula; hPa = mbar).
  - `vacuum.intercondenserMbar` = `250 × (trainsWorking > 0 ? 1 : 0.6) × sqrt(airLoad / max(1, trains)) × max(1, 1 / coolCap)`, where `trainsWorking = trains`.
  - `vacuum.coolingOutC` = `seawater.tempC + 6 × min(3, COOL_CAP_NOMINAL / coolCap)`.
  - `vacuum.ventAirKgH` = `10 × airLoad × (trains > 0 ? 1 : 0.4)`.
  - Each fault's pattern must match the spec's table (tested).
- **Standby ejectors:**
  - Command `standbyEjectors {on}` through `ok()`, with no refusals of its own.
  - Status `standbyEjectors: z.boolean().default(false)`.
  - The cost is charged per running tick while it is on, and reported hourly as one `accountChange` with cause `standbyEjectors`. Generalize `chargeStandbySteam` rather than copying it.
  - `startShift` resets `ejectors` to `{ coolCap: 2, standby: false, unbilledTicks: 0 }`, as Plan 8 does for `steam`.
- **Fault mix:**
  - `PROFILES.normal`: `vacuumTrainChance = 0.2`, `vacuumTrainFromShift = 2`.
  - `PROFILES.hard`: `vacuumTrainChance = 0.4`, `vacuumTrainFromShift = 2`.
  - `VACUUM_TRAIN_SALT = 0x7a1c5`. The minute is drawn from `VACUUM_TRAIN_MINUTE = [60, 360]`.
  - The kind is `coolingLoss` if the third draw is < 0.5, else `airLeak`. At most one per shift, never in shift 1.
  - The params are drawn when the fault fires, on `(s.seed ^ VACUUM_TRAIN_SALT ^ s.tick) >>> 0`.
- **Director:**
  - `onOwnClock` adds `coolingLoss` and `airLeak`.
  - `isCleared`: `coolingLoss` → `f.coolingLoss === null ? 'crew' : null`. `airLeak` likewise.
  - vacuumLoss's clear is unchanged (crew only).
- **Texts:**
  - `eventMessage`:
    - coolingLoss: `Ejector condenser cooling falling: strainer fouling.`
    - airLeak: `Air leaking into stage 24: ejectors carrying ${load}x the air.`
  - `radioLine`:
    - coolingLoss: `"Control, the ejector condenser's running hot — strainer's choking!"`
    - airLeak: `"Control, we've got air getting into stage 24 — ejectors can't keep up!"`
  - KIND_TEXT: `coolingLoss: 'Condenser cooling loss'`, `airLeak: 'Air leak'`.
  - Leaderboard: `'condenser cooling loss'`, `'air leak'`.
  - AccountCause label: `standbyEjectors: 'the standby ejectors'`.
- **Hints** (FIX, Normal only):
  - `coolingLoss`: `{ text: 'Send the crew to clean the condenser cooling water strainer; cut load to slow the vacuum loss meanwhile.', hint: 'delay', delayMin: 6, underway: crewOn('cleanStrainer') }`.
  - `airLeak`: `{ text: 'Switch on the standby ejectors to hold the vacuum, and send the crew to seal the air leak.', hint: 'delay', delayMin: 6, underway: crewOn('sealLeak') }`.
  - `vacuumLoss`: the text becomes `Switch on the standby ejectors, then send the crew to repair the failed ejector.`, and `underway` stays `crewOn('repairEjector')`.
- **Flink:**
  - `Rules.GRADED` gains `coolingLoss` and `airLeak`.
  - `crewJobFor`: `coolingLoss → cleanStrainer`, `airLeak → sealLeak`.
  - `vacuumLoss` is responded to when the crew job is `repairEjector` **or** `StatusView.standbyEjectors` is true.
  - `StatusView.standbyEjectors` (boolean, default false).
  - `LeaderboardSql.GRADED_KINDS` gains both kinds.
  - New POJO fields have defaults. There is no `--allowNonRestoredState`.
- **Snapshot:**
  - `VERSION = 8`; `restore` accepts 3–8.
  - `migrateV7` sets `ejectors = { coolCap: 2, standby: false, unbilledTicks: 0 }`, `faults.coolingLoss = null` and `faults.airLeak = null`.
- **Determinism:**
  - The new faults never consume `s.seed`.
  - `test/fixtures/pending-plan-seed3.json` and `plans-pre-plan8.json` must pass unmodified, with `plan8determinism.test.ts` filtering the new kinds the same way it filters lowSteam if needed.
  - A new `plans-pre-plan9.json` pins that only the new kinds were added.
- **Commands to run:**
  - `pnpm -r typecheck` and `pnpm -r test` are green at the end of every task.
  - Flink: `services/flink/mvn.sh test`.
  - Optional: `scripts/e2e-flink.sh`.
- **Fixtures are regenerated, never hand-edited.** The simulator fixtures come from throwaway scripts run on the pre-change code, which are not committed.
- **Git:** plain single git commands only, one per call. Never bare `git stash`. Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A live v7 save restored mid-shift with `ejectorFailed` and lowSteam active.** It keeps today's behaviour: the rate-based fall, standby ejectors off, `coolCap` 2. It re-serializes as v8. Test in Task 1.
2. **Standby ejectors on with no fault.** The vacuum and its readings, other than vent air and the intercondenser, are identical to having it off: the capacity is capped at 1, so the switch is no free gain. The cost is $100 per plant hour. Test in Task 2.
3. **Faults stacked** (coolingLoss + airLeak + lowSteam + ejectorFailed together, and standby toggled).
   - No NaN or Infinity in the readings or the vacuum.
   - With coolingLoss at its floor, switching on the standby changes nothing.
   - With airLeak, the standby holds the vacuum above `VACUUM_TRIP`.

   Test in Task 2.
4. **A trip during coolingLoss.** The Auto restart's vacuum step cannot pass until the crew cleans the strainer, then it completes. Test in Task 3.
5. **Crew jobs with no matching fault.** `cleanStrainer` or `sealLeak` with no matching fault is refused with `nothing to repair`, and the web buttons follow the existing CrewButton enablement. Test in Task 3.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/schema/src/{commands,status,telemetry,events}.ts` | Modify | `standbyEjectors` command/status, 132 readings, kinds, crew jobs, AccountCause |
| `services/simulator/src/units/ejectors.ts` | Create | `stepEjectors`, `ejectorCapacity`, `ejectorReadings` |
| `services/simulator/src/scenario/vacuumTrain.ts` | Create | `drawVacuumTrainFault`, `vacuumTrainParamsAtFire` |
| `services/simulator/src/{constants,state,emit,commands,snapshot,shift,tick,economy}.ts` | Modify | state, wire, v8, reset, step order, cost |
| `services/simulator/src/units/stages.ts` | Modify | target × capacity, standby bypasses a failed ejector |
| `services/simulator/src/scenario/{difficulty,director,effects,library,orders,sharp}.ts` | Modify | mix, own clock, effect, params, texts, crew jobs |
| `services/simulator/test/...` | Create/Modify | `ejectors`, `vacuumTrain`, `plan9determinism`, fixtures |
| `services/gateway/test/{fixtures,frames.test}.ts` | Modify | status field, 132 readings |
| `apps/web/src/...` | Modify | StagesView block, commands, store, labels, hints, radio, ShiftView, limits, plantConstants, LeaderboardCard, demo |
| `services/flink/.../{Rules,StatusView,LeaderboardSql}.java` (+ tests, ShiftTracker comment) | Modify | grading |
| `docs/{streaming-notes,hosting}.md` | Modify | contract, deploy notes |

---

### Task 1: Wire contract, state and snapshot v8 (no behaviour change)

**Files:**
- Modify: `packages/schema/src/{commands,status}.ts`.
- Modify: `services/simulator/src/{state,emit,commands,snapshot}.ts`.
- Modify: `services/gateway/test/fixtures.ts`, `apps/web/src/demo.ts`.
- Create: `services/simulator/test/fixtures/snapshot-v7.json`, `services/simulator/test/fixtures/plans-pre-plan9.json`.
- Test: `packages/schema/test/{commands,status}.test.ts`, `services/simulator/test/{snapshot,commands,fuzz}.test.ts`.

**Interfaces:**
- Produces:
  - The command `{ type: 'standbyEjectors'; on: boolean }`.
  - `PlantStatus.standbyEjectors: boolean`, emitted from `s.ejectors.standby`.
  - `PlantState.ejectors: { coolCap: number; standby: boolean; unbilledTicks: number }`, initially `{ 2, false, 0 }`.
  - `PlantState.faults.coolingLoss: { floor: number } | null` and `faults.airLeak: { load: number } | null`, both null in `noFaults()`.
  - `COOL_CAP_NOMINAL = 2` in `constants.ts`.

- [ ] **Step 1: Freeze pre-change outputs.** Write throwaway scripts, not committed, as in Plan 8 Task 1 Step 1.
  - `snapshot-v7.json`:
    - Seed 3, played by the engaged bot to mid-shift 2.
    - Then set `faults.ejectorFailed = true`, `faults.ejectorRatePerMin = 0.012` and `faults.lowSteam = { floorBar: 10.5 }`.
    - Write `serialize(state)`.
  - `plans-pre-plan9.json`: the same matrix and record shape as `plans-pre-plan8.json` (seeds 1–10, both modes, shifts 1–8), run on current main.
  - Commit `test: freeze a v7 save and the pre-Plan-9 chaos plans`.
- [ ] **Step 2: Write failing tests.**
  - Schema: `standbyEjectors` needs a boolean `on`. A status without `standbyEjectors` parses to `false`.
  - Snapshot:
    - `version: 8`; `version: 9` is rejected.
    - **Review Focus 1:** the v7 fixture restores with `ejectors` `{2, false, 0}` and both new faults null.
    - 30 ticks of the restored v7 save give vacuum qualities identical to the same 30 ticks run on a state built from the fixture through the pre-change path. In practice: the quality falls by the rate each tick, with no trip before the fall reaches 0.6.
    - It round-trips.
    - The v3–v6 chains end at v8.
  - Commands: `standbyEjectors {on: true}` sets `ejectors.standby`, and is refused in handover with `not allowed during handover`.
  - Fuzz: the generator emits `standbyEjectors`.
- [ ] **Step 3: Run** `pnpm -r test`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - Schema, state and the `migrateV7` chain. The version comment: "8 = ejector train: standby ejectors, condenser cooling, coolingLoss and airLeak faults".
  - Emit the status field and add the command case.
  - The gateway fixture and the demo get `standbyEjectors: false`.
- [ ] **Step 5: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS (`callsign.test.ts` and `plan8determinism.test.ts` unchanged).
- [ ] **Step 6: Commit** `feat: standby ejectors and ejector-train state on the wire; snapshot v8`.

---

### Task 2: Ejector train physics, readings and the standby train's cost

**Files:**
- Create: `services/simulator/src/units/ejectors.ts`, `services/simulator/test/ejectors.test.ts`.
- Modify: `services/simulator/src/{constants,tick,shift,emit,economy}.ts`, `units/stages.ts`.
- Modify: `packages/schema/src/{telemetry,events}.ts`: 132 readings; `'standbyEjectors'` appended to `AccountCauseSchema`.
- Modify: `apps/web/src/expanded/labels.ts` (the AccountCause label only), `services/gateway/test/frames.test.ts` (132).
- Test: `services/simulator/test/{tick,economy,steam}.test.ts` where they count readings or causes.

**Interfaces:**
- Consumes: Task 1's state.
- Produces (`units/ejectors.ts`):
  - `export function ejectorTrains(s: PlantState): number`.
  - `export function ejectorCapacity(s: PlantState): number`.
  - `export function stepEjectors(s: PlantState, dtS: number): PlantState`, which ramps `coolCap`.
  - `export function ejectorReadings(s: PlantState): { lastStageMbar: number; intercondenserMbar: number; coolingOutC: number; ventAirKgH: number }`.
  - `stepPlant` calls `stepEjectors` right after `stepSteam` and before `stepStages`.
  - `stepStages` follows the Global Constraints (a failed ejector with standby on uses the target branch).
  - The constants are as in Global Constraints. `STANDBY_EJECTORS_COST_USD_PER_H = 100`.
  - The economy: a generalized standby charge, for example `chargeStandby(s, which: 'steam' | 'ejectors')`. The existing `standbySteam` behaviour and its tests are unchanged.
  - `startShift` resets `ejectors`.

- [ ] **Step 1: Write failing tests** (`ejectors.test.ts`).
  - Nominal: `ejectorCapacity === 1`.
  - 90 nominal ticks give the same vacuum quality as before. This is pinned by the existing balance suites staying green.
  - The readings at nominal (seawater 30):
    - `lastStageMbar` within 60–90;
    - `intercondenserMbar` exactly 250;
    - `coolingOutC` exactly 36;
    - `ventAirKgH` exactly 10.
  - **Patterns** (the spec's table), each vs nominal after the fault has developed:
    - an ejector failure (standby off): intercondenser ↓ and vent ↓;
    - `coolingLoss` at its floor: intercondenser ↑ to ≥ 2× and coolingOut ↑ by ≥ 6 °C;
    - `airLeak` 3.0: vent ↑ to 3× and intercondenser ↑;
    - lowSteam: none of the four move except stage 24.
  - **coolCap ramp:**
    - with `coolingLoss { floor: 0.3 }`, `coolCap` falls 0.2 per plant minute and stops at 0.3;
    - with the fault null, it is back to 2 on the next tick.
  - **Unattended trip windows** (load nominal, vacuum loop in Auto):
    - `coolingLoss` at floor 0.25 and at 0.40 each trip on `lossOfVacuum` within 15–40 plant minutes;
    - `airLeak` at 2.5 and at 3.5 each trip within 12–35 plant minutes.
    - Report the measured minutes in the commit message.
    - If an endpoint misses, stop and report the numbers to the controller. Do not retune the spec's ranges.
  - **Holding:**
    - `airLeak` 3.5 with standby on holds the vacuum ≥ 0.65 for 120 minutes;
    - `coolingLoss` 0.25 with standby on still trips;
    - `coolingLoss` 0.25 with firing cut to give `ejectorLoadFactor` ≤ 0.5 holds above 0.6 for 60 minutes.
  - **A failed ejector with standby on:** the quality stops falling, and recovers to ≥ 0.9 within 60 minutes.
  - **Review Focus 2:**
    - With standby on and no fault, the quality and `lastStageMbar` are identical to standby off over 90 ticks.
    - An hour of standby gives one `accountChange` of −100 with cause `standbyEjectors`.
    - Standby steam's charge is unaffected when both are on.
  - **Review Focus 3:** with all faults stacked and standby toggled each 10 ticks over 200 ticks, every reading and the quality are finite.
  - `startShift` resets `ejectors`.
  - `tick.test.ts`: the count is 132, and the four IDs follow `vacuum.motiveSteamBar` in the order given.
- [ ] **Step 2: Run** `pnpm --filter @desal/simulator test -- ejectors`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS, with the balance bands unchanged.
- [ ] **Step 5: Commit** `feat(simulator): ejector train capacity, condenser cooling, air load, standby ejectors and readings`.

---

### Task 3: The coolingLoss and airLeak faults and their crew jobs

**Files:**
- Modify: `packages/schema/src/{events,commands}.ts`:
  - append `'coolingLoss'` and `'airLeak'` to `ScenarioKindSchema` (not sharp, not disaster);
  - append `'cleanStrainer'` and `'sealLeak'` to `CrewJobSchema`.
- Create: `services/simulator/src/scenario/vacuumTrain.ts`.
- Modify: `services/simulator/src/{constants,shift}.ts` (shift.ts holds `drawPendingPlan`), `scenario/{difficulty,director,effects,library,orders,sharp}.ts`.
- Modify: `services/simulator/test/bot.ts`. The engaged bot sends:
  - `cleanStrainer` while a coolingLoss is uncleared;
  - `standbyEjectors on` and `sealLeak` while an airLeak is uncleared;
  - `standbyEjectors on` while a vacuumLoss is uncleared.

  It does this when the crew is free.
- Modify (kind and job tables only, so typecheck stays green):
  - `apps/web/src/expanded/labels.ts`: KIND_TEXT, and FIX per Global Constraints, including the new vacuumLoss text;
  - `apps/web/src/plantConstants.ts`: the crew jobs;
  - `apps/web/src/state/radio.ts`: `monitorFor` → `'stages'`;
  - `apps/web/src/screens/LeaderboardCard.tsx`.
- Create: `services/simulator/test/{vacuumTrain,plan9determinism}.test.ts`.
- Test: `services/simulator/test/scenario/director.test.ts`, `test/hardmode.test.ts`, `apps/web/test/hints.test.ts`.

**Interfaces:**
- Consumes: Task 2's model.
- Produces:
  - `drawVacuumTrainFault(s: PlantState, shiftNumber: number): QueuedEvent | null`, the same shape as `drawLowSteam`.
  - `vacuumTrainParamsAtFire(s: PlantState, kind: 'coolingLoss' | 'airLeak'): Params`.
  - `drawEvent`:
    - `coolingLoss` → `{ floor: range(s, 0.25, 0.40, 0.01) }`;
    - `airLeak` → `{ load: range(s, 2.5, 3.5, 0.1) }`.
  - `applyEffect` sets the fault.
  - `drawPendingPlan` inserts the entry with the existing timed-entry insertion, after lowSteam's, with the next eventId.

- [ ] **Step 1: Write failing tests.**
  - `vacuumTrain.test.ts`:
    - The draws are deterministic per (seed, shift); never in shift 1; the kind split is roughly 50/50 over seeds 1–200; Hard draws more than Normal.
    - The params at fire are on the grids and in range.
    - **Review Focus 4:** coolingLoss at floor 0.25 plus a manual trip plus an Auto `restart`. The vacuum step does not pass in 60 ticks. After `crew cleanStrainer` completes, the restart reaches `online`.
    - **Review Focus 5:** `crew cleanStrainer` and `crew sealLeak` with no matching fault are refused with `nothing to repair`. With the fault, they cost $400 / $600, take 30 / 60 min, clear the fault, and give one `eventCleared` with `how: 'crew'`.
  - `plan9determinism.test.ts`:
    - Each record in `plans-pre-plan9.json` gives the same `nextSeed` and the same pending once coolingLoss and airLeak are filtered out.
    - The fire-timing check is as Plan 8's: removing the entry leaves the other events' `atMinute`s and the final seed identical.
  - `director.test.ts`: both kinds fire on their minute regardless of the gap, don't move `lastFiredMinute`, don't count toward `MAX_EVENTS`, and leave `s.seed` unchanged.
  - `hardmode.test.ts`: both kinds are added to the forced-event list. The engaged bot ends shift 2 alive.
  - `hints.test.ts`: the three FIX texts exactly; `delayMin` 6 for both new kinds, and less than half of each fault's earliest trip window bound (12).
- [ ] **Step 2: Run** the new and changed tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS (`callsign.test.ts`, `plan8determinism.test.ts`; the balance bands).
- [ ] **Step 5: Commit** `feat(simulator): coolingLoss and airLeak faults with cleanStrainer and sealLeak crew jobs`.

---

### Task 4: Web: the Ejector train block, the standby switch and the crew buttons

**Files:**
- Modify: `apps/web/src/{commands,limits}.ts`, `expanded/{StagesView,ShiftView}.tsx`, `state/store.ts`.
- Test: `apps/web/test/{expanded.test.tsx,store.test.ts,commands.test.ts}`.

**Interfaces:**
- Produces:
  - `standbyEjectors(on: boolean): Command`.
  - `limits.STANDBY_EJECTORS_COST_USD_PER_H = 100`.
  - `store.confirmed`: `standbyEjectors` → `st.standbyEjectors === cmd.on`.

- [ ] **Step 1: Write failing tests** (`expanded.test.tsx`, StagesView).
  - An "Ejector train" section, after the motive steam rows, with four rows:
    - "Stage 24 pressure" (`N mbar`, 0 dp);
    - "Intercondenser" (`N mbar`);
    - "Condenser cooling out" (`N.N °C`);
    - "Vent air" (`N kg/h`).
  - Tones:
    - stage 24 `warn` ≥ 100 mbar;
    - intercondenser `warn` ≥ 350 or ≤ 160 (standby on alone reads about 177, a failed ejector 150);
    - cooling out `warn` ≥ the `intake.seawaterTempC` reading + 10;
    - vent air `warn` ≥ 18 or ≤ 6;
    - none at the demo's nominal values.
  - A one-line legend under the rows: `Hot cooling water → strainer. High vent air → air leak. Low intercondenser → failed ejector. Low motive steam → standby steam line.`
  - A "Standby ejectors" toggle with the note `$100/h while on` sends `standbyEjectors`.
  - CrewButtons for `cleanStrainer` and `sealLeak` next to `repairEjector`.
  - ShiftView: an "of which standby ejectors" row summing the `standbyEjectors` account changes, included in "Spent".
  - `store.test.ts`: a pending `standbyEjectors` is confirmed by the matching status.
- [ ] **Step 2: Run** `pnpm --filter @desal/web test`. Expected: FAIL.
- [ ] **Step 3: Implement.** The demo telemetry gets the four readings at nominal values.
- [ ] **Step 4: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): ejector train readings, standby ejectors switch and crew buttons`.

---

### Task 5: Flink grading, leaderboard and the docs

**Files:**
- Modify: `services/flink/src/main/java/org/desal/flink/reportcard/{Rules,StatusView,ShiftTracker}.java`, `leaderboard/LeaderboardSql.java`, and their tests.
- Modify: `packages/schema/src/flink.ts` (the comment), `docs/streaming-notes.md`, `docs/hosting.md`.

- [ ] **Step 1: Write failing tests.**
  - `RulesTest`:
    - both kinds are graded;
    - `crewJobFor` maps them;
    - `vacuumLossAcceptsStandbyEjectors`: true with `standbyEjectors` and no crew, true with `repairEjector`, false with neither.
  - `ReportCardFunctionTest`: an `airLeak` with `crewJob: sealLeak` at T+3 gives `quick`.
  - `LeaderboardSqlTest`: `normal|coolingLoss` and `normal|airLeak` appear in the stats.
  - `GameStateTest` still covers `StatusView`.
- [ ] **Step 2: Run** `services/flink/mvn.sh test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Also update the ShiftTracker comment that lists the jobs that fix one fault.
- [ ] **Step 4: Run** `services/flink/mvn.sh test`. Expected: PASS. Keep any regenerated contract fixtures as they are, then run `pnpm --filter @desal/schema test`.
- [ ] **Step 5: Docs.**
  - `streaming-notes.md`:
    - the kinds;
    - the crew jobs;
    - `standbyEjectors`: the status, command and account cause;
    - the four readings (132);
    - snapshot v8 with its v7 → v8 bullet.
  - `hosting.md`: a Plan 9 deploy note. An old tab needs a reload, because the old schema rejects the new kinds, crew jobs and AccountCause. Rolling back past v8 ends live games.
- [ ] **Step 6 (optional, Docker):** `scripts/e2e-flink.sh` passes.
- [ ] **Step 7: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(flink): grade coolingLoss and airLeak; standby ejectors answer vacuumLoss; contract notes`.

---

## Rulings (controller, for the reviewer)

- **The cooling header is sized for both trains** (`COOL_CAP_NOMINAL = 2`). This makes standby help an air leak but not a cooling loss, which is the spec's diagnosis split. Cost if wrong: one constant.
- **`coolCap` snaps back to nominal when the strainer is cleaned**, rather than recovering gradually. This is simpler and matches the other crew fixes. Cost if wrong: one ramp.
- **Reading formulas are illustrative, not plant data.** The spec only fixes the nominal values and the patterns. Cost if wrong: retune formulas; the patterns are pinned by tests.
- **The vacuumLoss hint text changes**, while its `underway` stays crew-only: standby holds the vacuum but does not fix the ejector.
