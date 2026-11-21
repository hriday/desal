# Plant Realism (Motive Steam, Low-Steam Fault, Auto Divert, Salinity Lag) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the vacuum ejector a motive steam pressure, add a `lowSteam` fault the player fixes with a Standby steam line switch, make Divert to drain automatic by default with hysteresis, and lag product salinity so it no longer snaps.

**Architecture:**
- **State.** `PlantState` gains `steam: { motiveBar, standby }`, `product.divertMode` and `faults.lowSteam`. Snapshot v7 migrates v6 (and older saves through it) with the spec's restore defaults.
- **Physics.** A new `units/steam.ts` computes the motive pressure each tick, right before `stepStages`. `stepStages` scales the vacuum target by the ejector's reach. `stepProduct` lags salinity (asymmetric time constants) and, in Auto, sets `divertToDrain` from the lagged salinity with a 0.9 × limit return band.
- **Fault.** `lowSteam` is planned on its own salted substream, like a disaster. It never consumes the game seed, and the director runs it "on its own clock", so every existing kind, param and fire minute stays what it was. Its floor pressure is drawn when it fires, also from a substream.
- **Consumers.** The web shows the steam reading, the relabelled valve, the standby switch, the divert mode and direction, and a Normal-only divert hint. Flink grades `lowSteam` on the status' `standbySteam` and adds it to the leaderboard's kinds.

**Tech Stack:** TypeScript, zod 4, vitest 4, React 19 + Vite, pnpm monorepo; Java 17, Flink 2.2.1, Maven via `services/flink/mvn.sh` (Docker).

**Spec:** `docs/superpowers/specs/2026-11-21-plant-realism-design.md` (short; read all of it).

## Global Constraints

- **Motive steam (spec values):** `MOTIVE_STEAM_NOMINAL_BAR = 14.5`, `EJECTOR_FULL_REACH_BAR = 13`, `EJECTOR_NO_REACH_BAR = 8`.
  - `ejectorReach(bar) = clamp01((bar − 8) / (13 − 8))`.
  - Vacuum target = `VACUUM_QUALITY_MIN + (1 − VACUUM_QUALITY_MIN) × pct(vacuum.output) × reach`. At 14.5 bar, reach is 1 and the result is exactly today's value.
- **Builder constants (chosen here):**
  - `LOW_STEAM_SAG_BAR_PER_MIN = 1.0`: the pressure falls linearly from 14.5 and reaches the floor in 3.5–4.5 plant minutes.
  - The floor `floorBar` is drawn uniformly from 10.0–11.0 bar in 0.1 steps, when the event fires.
  - The standby line restores 14.5 bar on the same tick it is on. With the line off and the fault active, the pressure sags again from wherever it is, at the sag rate.
- **Low-steam mix:**
  - `PROFILES.normal`: `lowSteamChance = 0.15`, `lowSteamFromShift = 2`.
  - `PROFILES.hard`: `lowSteamChance = 0.3`, `lowSteamFromShift = 2`.
  - `LOW_STEAM_SALT = 0x57ea3`. The planned minute is drawn from `LOW_STEAM_MINUTE = [60, 360]`.
  - At most one per shift. Never in shift 1.
- **Clearing:** `lowSteam` clears with `how: 'player'` when `steam.standby` is on, or when `faults.lowSteam` is null. `startShift` resets the faults (`noFaults()`), which is "the fault ends at the end of the shift". The plant does not step during handover.
- **Shift start (ruling):** `startShift` also resets `steam` to `{ motiveBar: 14.5, standby: false }`, so the oncoming crew puts the standby line back on standby. Without this, a free switch left on would make the fault impossible after the first time.
- **Salinity lag:** `SALINITY_RISE_TAU_S = 60`, `SALINITY_FALL_TAU_S = 300`. It is an exact first-order lag, `x + (target − x)(1 − e^(−dt/τ))`, with τ chosen by `target > x`.
- **Auto divert:**
  - It diverts when the lagged salinity is > limit.
  - It returns to the tank when the lagged salinity is < `DIVERT_RETURN_FRACTION × limit` (`0.9`).
  - Between the two thresholds it keeps its last position. The limit is `shift.target.maxSalinityPpm`, else `DEFAULT_MAX_SALINITY_PPM`.
  - The divert decision and delivery use the same tick's salinity.
- **Divert mode:**
  - `DivertMode = 'auto' | 'manual'`. New games start `auto`; restored pre-v7 saves get `manual`.
  - `divertToDrain {on}` sets Manual and the latch.
  - `setDivertMode {mode}` changes only the mode. The valve keeps its position until Auto's next decision.
- **Commands:** `setDivertMode {mode}` and `standbySteam {on}` go through `ok()`. They add no refusals of their own: the existing envelope refusals (invalid, game over, handover, stale shift) apply.
- **Status (wire):**
  - `divertMode: DivertModeSchema.default('manual')` and `standbySteam: z.boolean().default(false)`. Older simulators parse as today's behaviour.
  - `divertToDrain` stays: it is the valve's direction.
- **Telemetry:**
  - A new reading `vacuum.motiveSteamBar` (unitId `vacuum`, no loop), emitted right after `vacuum.quality`.
  - `TELEMETRY_SENSOR_COUNT` 127 → **128**.
- **Snapshot:**
  - `VERSION = 7`. `restore` accepts 3–7 (v3 → v4 → v5 → v6 → v7). Version 2 is still rejected.
  - `migrateV6`: `product.divertMode = 'manual'`, `steam = { motiveBar: 14.5, standby: false }`, `faults.lowSteam = null`.
- **Determinism:**
  - lowSteam never consumes `s.seed`, neither when it is planned nor when it fires.
  - The game seed sequence, every other queued event (kind, params, eventId, earliestMinute) and the other events' fire timing stay unchanged.
  - `test/fixtures/pending-plan-seed3.json` must pass unmodified. Shift 1 never draws lowSteam.
- **Hints (web, Normal only):**
  - The lowSteam FIX: `{ text: 'Switch on the standby steam line on the Stages screen.', hint: 'delay', underway: (st) => st.standbySteam === true }`.
  - Divert hint: when `divertMode === 'manual'` and `divertToDrain` is on, and salinity has been below the limit for `DIVERT_HINT_MIN = 5` plant minutes, the radio says `Hint: Product's back in spec — send it to the tank.` The `Hint: ` prefix is the Plan 7 radio convention. The hint shows once per in-spec stretch, on the Product monitor.
- **Labels:**
  - The vacuum loop's output reads **"Ejector steam valve"** (%).
  - The switch is **"Standby steam line"**.
  - The steam row is **"Motive steam"**, in bar to 1 decimal: `warn` below 13, `bad` below 11.
  - KIND_TEXT: `lowSteam: 'Low motive steam'`. Leaderboard: `'low steam'`.
- **Flink:**
  - `Rules`: `lowSteam` is graded. It is responded to when `StatusView.standbySteam` is true.
  - `LeaderboardSql.GRADED_KINDS` gains `'lowSteam'`.
  - New POJO fields have defaults. There is no `--allowNonRestoredState`.
- **Commands to run:**
  - `pnpm -r typecheck` and `pnpm -r test` are green at the end of every task.
  - Flink: `services/flink/mvn.sh test`.
  - Optional end-to-end check (Docker): `scripts/e2e-flink.sh`.
- **Fixtures are regenerated, never hand-edited.**
  - Flink contract fixtures (`packages/schema/test/fixtures/flink/*.json`) come from `services/flink/mvn.sh test`.
  - Simulator fixtures come from a throwaway script run on the pre-change code (Task 1 Step 1). The script is not committed.
- **Git:** plain single git commands only (no `&&` chains of git commands), one command per call. Never bare `git stash`. Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A live v6 save restored mid-shift with Divert on and an open tube leak.** It keeps behaving as before: Manual latch on, steam 14.5, standby off, no lowSteam. It ticks 90 times without a trip and re-serializes as v7. Test in Task 1.
2. **Standby switched off again while lowSteam is still active.** The pressure sags again from 14.5. The event, already cleared, stays cleared with no second `eventCleared`, and the vacuum falls again. Switching it back on restores 14.5 at once. Test in Task 3.
3. **A trip during lowSteam.** The restart's vacuum step cannot reach `RESTART_VACUUM_MIN` (0.85 needs about 11.9 bar) until standby is on. Once it is on, the Auto restart completes. Test in Task 3.
4. **Toggling divert by hand while Auto is diverting, then going back to Auto while salinity sits between 0.9 × limit and the limit.** The press selects Manual with the asked position. Back on Auto, the valve holds its position until salinity crosses a threshold. It never flips back and forth in the band. Test in Task 2.
5. **The divert hint after a reload, on Hard, in Auto, or with a short or empty salinity trend.** It shows at most once per in-spec stretch. It never shows on Hard, in Auto or with the valve to the tank. It needs 5 plant minutes of points under the limit. Test in Task 4.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/schema/src/commands.ts` | Modify | `DivertModeSchema`; `setDivertMode`, `standbySteam` commands |
| `packages/schema/src/status.ts` | Modify | `divertMode`, `standbySteam` (defaulted) |
| `packages/schema/src/telemetry.ts` | Modify | `TELEMETRY_SENSOR_COUNT = 128` |
| `packages/schema/src/events.ts` | Modify | `'lowSteam'` appended to `ScenarioKindSchema` (Task 3) |
| `services/simulator/src/{constants,state,emit,commands,snapshot,shift,tick}.ts` | Modify | new state, wire fields, commands, v7, shift reset, step order |
| `services/simulator/src/units/lag.ts` | Create | the shared exact first-order `lag` (moved from `units/stages.ts`) |
| `services/simulator/src/units/product.ts` | Modify | `rawSalinityPpm`, lag, auto divert |
| `services/simulator/src/units/steam.ts` | Create | `ejectorReach`, `stepSteam` |
| `services/simulator/src/units/stages.ts` | Modify | vacuum target × reach |
| `services/simulator/src/scenario/lowSteam.ts` | Create | `drawLowSteam`, `lowSteamFloorAtFire` |
| `services/simulator/src/scenario/{difficulty,director,effects,library,orders}.ts` | Modify | mix, own-clock scheduling, effect, params, radio line |
| `services/simulator/test/fixtures/{snapshot-v6,plans-pre-plan8}.json` | Create | frozen pre-change outputs |
| `services/simulator/test/{steam,divert,plan8determinism}.test.ts` | Create | new tests |
| `services/gateway/test/{fixtures,frames.test}.ts` | Modify | status fields, 128 readings |
| `apps/web/src/{commands,demo}.ts`, `state/{store,hints,radio}.ts`, `expanded/{ProductView,StagesView,labels}.tsx/.ts`, `controls/Setpoint.tsx`, `screens/LeaderboardCard.tsx` | Modify | UI |
| `services/flink/src/main/java/org/desal/flink/{reportcard/Rules,reportcard/StatusView,leaderboard/LeaderboardSql}.java` | Modify | grading, kinds |
| `docs/streaming-notes.md` | Modify | contract |

---

### Task 1: Wire contract, state and snapshot v7 (no behaviour change)

**Files:**
- Modify: `packages/schema/src/{commands,status,telemetry}.ts`.
- Modify: `services/simulator/src/{constants,state,emit,commands,snapshot}.ts`.
- Modify: `services/gateway/test/fixtures.ts`, `services/gateway/test/frames.test.ts`, `apps/web/src/demo.ts`.
- Create: `services/simulator/test/fixtures/snapshot-v6.json`, `services/simulator/test/fixtures/plans-pre-plan8.json`.
- Test: `packages/schema/test/{commands,status}.test.ts`, `services/simulator/test/{snapshot,commands,tick,fuzz}.test.ts`.

**Interfaces:**
- Produces:
  - `DivertModeSchema = z.enum(['auto', 'manual'])` and `type DivertMode` (schema `commands.ts`).
  - Commands `{ type: 'setDivertMode'; mode: DivertMode }` and `{ type: 'standbySteam'; on: boolean }`.
  - `PlantStatus.divertMode: DivertMode` and `PlantStatus.standbySteam: boolean`.
  - `PlantState.product: { flowM3h; salinityPpm; divertToDrain: boolean; divertMode: DivertMode }`.
  - `PlantState.steam: { motiveBar: number; standby: boolean }`.
  - `PlantState.faults.lowSteam: { floorBar: number } | null`. `noFaults()` sets it to null.
  - Constants: `MOTIVE_STEAM_NOMINAL_BAR = 14.5` (in `constants.ts`). `createInitialState` sets `steam = { motiveBar: 14.5, standby: false }` and `divertMode: 'auto'`.
  - The telemetry reading `vacuum.motiveSteamBar` reads `s.steam.motiveBar`.

- [ ] **Step 1: Freeze pre-change outputs (before touching code).** Write two throwaway scripts (not committed) and run them with `pnpm --filter @desal/simulator exec tsx <script>`:
  - `test/fixtures/snapshot-v6.json`:
    - Seed 3, played by the engaged bot (`test/bot.ts` `playFrom`) to mid-shift 2 with at least one fired event.
    - Then set `product.divertToDrain = true` and `faults.tubeLeak = { stage: 5, ppm: 6 }`.
    - Write `serialize(state)`.
  - `test/fixtures/plans-pre-plan8.json`: for seeds 1–10, modes `normal` and `hard`, and shift numbers 1–8:
    - Take `createInitialState(seed, 0, GAME_ID)` with `run.mode` set, `run.shiftNumber = n − 1` and `chaos.lastHadDisaster = false`.
    - Run `drawPendingPlan`.
    - Record `{ seed, mode, n, nextSeed: state.seed, pending: state.chaos.pending }`.
  - Commit them: `test: freeze a v6 save and the pre-Plan-8 chaos plans`.
- [ ] **Step 2: Write failing tests**
  - Schema:
    - `setDivertMode` accepts `auto` and `manual` and rejects `off`.
    - `standbySteam` needs a boolean `on`.
    - A status object without `divertMode`/`standbySteam` parses to `'manual'`/`false`.
  - `snapshot.test.ts`:
    - `serialize` writes `version: 7`.
    - `wrap(s, { version: 8 })` is rejected as an unknown version, which replaces the existing `version: 7` rejection case.
    - **The v6 fixture restores** (Review Focus 1):
      - `ok`;
      - `product.divertMode === 'manual'` and `product.divertToDrain === true`;
      - `steam` is `{ motiveBar: 14.5, standby: false }` and `faults.lowSteam === null`;
      - 90 ticks give no trip event, and every tick's `product.divertToDrain` stays `true`;
      - `serialize` → `restore` round-trips equal.
    - The v3/v4/v5 chains end at v7 with the same defaults. Update the existing migration tests' expectations from 6 to 7.
  - `commands.test.ts`:
    - `setDivertMode auto` sets `product.divertMode` and leaves `divertToDrain` as it was.
    - `divertToDrain {on: true}` from Auto gives `divertMode === 'manual'` and the latch on.
    - `standbySteam {on: true}` sets `steam.standby`.
    - All three are rejected in handover with `not allowed during handover`.
    - `createInitialState(...).product.divertMode === 'auto'`.
  - `tick.test.ts`: `TELEMETRY_SENSOR_COUNT` is 128, and `SENSOR_IDS` includes `vacuum.motiveSteamBar` right after `vacuum.quality`. The status passes `PlantStatusSchema` with `divertMode` and `standbySteam` present.
  - `fuzz.test.ts`: the command generator also emits `setDivertMode` (random mode) and `standbySteam` (random on).
  - Gateway `frames.test.ts`: expect 128.
- [ ] **Step 3: Run** `pnpm -r test`. Expected: FAIL on the new assertions.
- [ ] **Step 4: Implement.**
  - The schema additions above.
  - `state.ts`: the types and initial values.
  - `snapshot.ts`:
    - `PlantStateSchema` gains `product.divertMode`, `steam` and `faults.lowSteam` (nullable `{ floorBar }`).
    - Add `migrateV6(state: unknown): unknown`, which fills the defaults.
    - `restore` chains it for any version below 7.
    - Update the version comment: "7 = divert mode, motive steam, standby line, lowSteam fault".
  - `emit.ts`: the status fields and the telemetry sensor.
  - `commands.ts`: the three cases via `ok(...)`.
  - Gateway fixture and `demo.ts`: `divertMode: 'auto'`, `standbySteam: false`, and the demo reading `'vacuum.motiveSteamBar': 14.5`.
- [ ] **Step 5: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS, with `callsign.test.ts` (the seed-3 plan fixture) unchanged and green.
- [ ] **Step 6: Commit** `feat: divert mode, standby steam and motive steam on the wire; snapshot v7`.

---

### Task 2: Salinity lag and auto divert

**Files:**
- Create: `services/simulator/src/units/lag.ts`.
- Modify: `services/simulator/src/units/{product,stages}.ts`, `constants.ts`.
- Create: `services/simulator/test/divert.test.ts`.
- Test: `services/simulator/test/units/product.test.ts`, plus whichever existing simulator tests assert an instant salinity jump (likely `test/scenario/sharp.test.ts`, `tick.test.ts`, `balance.test.ts`). Update them to tick to steady state or to assert `rawSalinityPpm`. Do not loosen their meaning.

**Interfaces:**
- Consumes: `product.divertMode` (Task 1).
- Produces:
  - `export const lag = (x: number, target: number, dtS: number, tauS: number): number` in `units/lag.ts`. `stages.ts` imports it.
  - `export function rawSalinityPpm(s: PlantState, carryover: number): number`: today's formula, unchanged.
  - `stepProduct(s, distillateM3h, carryover, dtS)`: same signature and return.
    - `salinityPpm` is lagged with `SALINITY_RISE_TAU_S = 60` or `SALINITY_FALL_TAU_S = 300`.
    - In `auto`, `product.divertToDrain` comes from the hysteresis rule (Global Constraints), using `DIVERT_RETURN_FRACTION = 0.9`.
    - `deliveredM3` and `offSpec` use the new `divertToDrain`.

- [ ] **Step 1: Write failing tests** (`divert.test.ts` and `units/product.test.ts`).
  - The raw value at nominal equals `BASE_SALINITY_PPM`, and `stepProduct` at nominal keeps it exactly.
  - **Rising:** from raw 10 to raw 40 ppm with `dtS = 60`, one step gives `10 + 30 × (1 − e^−1)` ± 1e-9.
  - **Falling:** from 40 to 10 ppm, one 300 s step gives `40 − 30 × (1 − e^−1)`. After 15 plant minutes (`dtS = 40`, 23 steps) it is within 5 % of the gap from 10.
  - **Auto band** (limit 25):
    - lagged 25.1 → diverts, delivered 0, `offSpec` false;
    - then 23.0 (in the band) → still diverts;
    - then 22.4 (< 22.5) → to the tank;
    - then 24.0 → stays to the tank.
  - **Manual:** a latch on with salinity 5 ppm stays diverted. A latch off with 40 ppm delivers and is `offSpec`.
  - **Review Focus 4:**
    - In Auto, salinity at 30 → diverting.
    - `divertToDrain {on: false}` → Manual, delivering off-spec.
    - `setDivertMode auto` with salinity forced to 23 (in the band): it keeps delivering (it holds the position the latch left) until salinity exceeds 25.
    - Over 30 ticks with salinity oscillating between 22.6 and 24.9, `divertToDrain` never changes.
  - **Tick level:** a tube leak that pushes raw salinity over the limit in a new (Auto) game loses no in-spec water to `offSpecM3`. `shift.acc.offSpecM3` stays 0 while the product is diverted, and in-spec delivery resumes only after salinity < 0.9 × limit.
- [ ] **Step 2: Run** `pnpm --filter @desal/simulator test -- divert product`. Expected: FAIL.
- [ ] **Step 3: Implement** `lag.ts`, then `rawSalinityPpm` and the new `stepProduct` in `units/product.ts`. Add the constants to `constants.ts` with one-line doc comments.
- [ ] **Step 4: Run** `pnpm -r typecheck` and `pnpm -r test`. Fix the existing tests that assumed instant salinity (see Files).
  - The balance suites (`hardmode`, `balance`, `plan7balance`) must stay green.
  - If a band breaks, stop and report the numbers to the controller rather than tuning the spec's constants.
- [ ] **Step 5: Commit** `feat(simulator): lagged product salinity and auto divert with a 0.9x return band`.

---

### Task 3: Motive steam, the standby line and the lowSteam fault

**Files:**
- Modify: `packages/schema/src/events.ts`: append `'lowSteam'` to `ScenarioKindSchema`. Not in `SHARP_KINDS` and not in `DISASTER_KINDS`.
- Create: `services/simulator/src/units/steam.ts`, `services/simulator/src/scenario/lowSteam.ts`.
- Modify: `services/simulator/src/{constants,tick,shift}.ts`, `units/stages.ts`, `scenario/{difficulty,director,effects,library,orders}.ts`.
- Modify (kind tables only, so typecheck stays green):
  - `apps/web/src/expanded/labels.ts`: `KIND_TEXT` and `FIX` entries as in Global Constraints;
  - `apps/web/src/state/radio.ts`: `monitorFor('lowSteam') = 'stages'`;
  - `apps/web/src/screens/LeaderboardCard.tsx`: `'low steam'`.
- Modify: `services/simulator/test/bot.ts`. The engaged bot sends `standbySteam {on: true}` while a fired lowSteam is uncleared.
- Create: `services/simulator/test/steam.test.ts`, `services/simulator/test/plan8determinism.test.ts`.
- Test: `services/simulator/test/scenario/director.test.ts`, `test/hardmode.test.ts`, `apps/web/test/hints.test.ts` (the FIX table).

**Interfaces:**
- Consumes: `steam`, `faults.lowSteam` and `standbySteam` (Task 1); `lag` (Task 2).
- Produces:
  - `units/steam.ts`:
    - `export function ejectorReach(bar: number): number`.
    - `export function stepSteam(s: PlantState, dtS: number): PlantState`:
      - standby on, or no fault → `motiveBar = 14.5`;
      - otherwise → `max(floorBar, motiveBar − LOW_STEAM_SAG_BAR_PER_MIN × dtS / 60)`.
  - Constants: `EJECTOR_FULL_REACH_BAR = 13`, `EJECTOR_NO_REACH_BAR = 8`, `LOW_STEAM_SAG_BAR_PER_MIN = 1.0`, `LOW_STEAM_FLOOR_BAR = [10, 11] as const`.
  - `stepStages`: the non-failed-ejector branch's target becomes the Global Constraints formula, using `ejectorReach(s.steam.motiveBar)`. The failed-ejector branch is unchanged.
  - `stepPlant` calls `stepSteam(s, dt)` immediately before `stepStages`.
  - `startShift` resets `steam` (Global Constraints ruling).
  - `difficulty.ts`:
    - `DifficultyProfile` gains `lowSteamChance: number` and `lowSteamFromShift: number`;
    - add `LOW_STEAM_SALT = 0x57ea3` and `LOW_STEAM_MINUTE = [60, 360] as const`.
  - `scenario/lowSteam.ts`:
    - `export function drawLowSteam(s: PlantState, shiftNumber: number): QueuedEvent | null`:
      - substream `(s.seed ^ LOW_STEAM_SALT ^ shiftNumber) >>> 0`;
      - roll `< profile.lowSteamChance`, else null; null before `lowSteamFromShift`;
      - then draw `earliestMinute` in `LOW_STEAM_MINUTE`;
      - returns `params: {}`, `cascade: false`, `disaster: false`, `eventId: 0`.
    - `export function lowSteamParamsAtFire(s: PlantState): { floorBar: number }`: `drawEvent('lowSteam', …)` on the substream `(s.seed ^ LOW_STEAM_SALT ^ s.tick) >>> 0`.
  - `drawPendingPlan` inserts the lowSteam entry after any disaster, by `earliestMinute` order, with the next eventId. Reuse `withDisaster`'s insertion; rename it `withTimedEntry`.
  - `library.drawEvent('lowSteam', …)` draws `floorBar` with `range(s, 10, 11, 0.1)`. `eventMessage` gives `Motive steam pressure falling toward ${floorBar} bar.`.
  - `orders.radioLine('lowSteam')` gives `"Control, motive steam's sagging — the reducing valve looks stuck!"`.
  - `effects.applyEffect('lowSteam', p)` sets `faults.lowSteam = { floorBar: Number(p.floorBar) }`.
  - `director.ts`:
    - `isCleared('lowSteam')` gives `s.steam.standby || f.lowSteam === null ? 'player' : null`;
    - `const onOwnClock = (e: { disaster: boolean; kind: ScenarioKind }) => e.disaster || e.kind === 'lowSteam'` replaces the `e.disaster` tests that decide scheduling: the first-event index, `dueDisaster`, `countsTowardCap`, the "next other event" index, the `lastFiredMinute` keep, and the gap scheduling `!head.disaster`;
    - `lastHadDisaster` and the cascade check keep reading `disaster` itself;
    - `resolve` returns `['lowSteam', lowSteamParamsAtFire(s), seed]`, passing the game seed through unchanged.

- [ ] **Step 1: Write failing tests**
  - `steam.test.ts`:
    - `ejectorReach` gives 1 at 13 and 14.5, 0.6 at 11, 0 at 8 and 5.
    - Nominal ticking (no fault) keeps `motiveBar === 14.5` and the vacuum quality identical to the pre-change value over 90 ticks (`plan7balance` calm shift also unchanged).
    - With `faults.lowSteam = { floorBar: 10 }`, the pressure is 14.5 − 0.667 after one tick, at the floor by tick 7, and never below it.
    - Ignored at floor 10.0 → `lossOfVacuum` trip between 25 and 45 plant minutes after the fault starts (modelled: about 33).
    - At floor 11.0 the vacuum settles at 0.72 ± 0.01 and does not trip within 360 ticks.
    - Standby on → 14.5 on the same tick, and the vacuum recovers toward 0.95.
    - **Review Focus 2:**
      - the event fires, standby goes on, then off;
      - the sag resumes from 14.5;
      - exactly one `eventCleared` for that eventId;
      - standby back on restores 14.5 at once.
    - **Review Focus 3:**
      - lowSteam at floor 10, plus a manual trip, plus an Auto `restart`;
      - the vacuum step does not pass in 60 ticks;
      - after `standbySteam on`, the restart reaches `online`.
    - `startShift` resets `steam` and clears `faults.lowSteam`.
  - `plan8determinism.test.ts`:
    - For every record in `plans-pre-plan8.json`, `drawPendingPlan` on the same input gives `state.seed === nextSeed`.
    - Its `pending` equals the record's once lowSteam entries are filtered from the queue (`toEqual`).
    - Across the matrix: no lowSteam when `n === 1`; at least one lowSteam in each mode; at most one per plan; and Hard draws more than Normal in total.
    - **Fire timing is untouched:**
      - take one seed whose plan has lowSteam plus another event, in two copies: one as drawn, one with the lowSteam entry removed;
      - run both with `standbySteam on` sent at shift start;
      - the other events' `atMinute`s and the final `s.seed` are identical.
  - `director.test.ts`:
    - lowSteam fires at its minute regardless of `NORMAL_GAP_MIN`;
    - it does not move `lastFiredMinute`;
    - it does not count toward `MAX_EVENTS`;
    - its params hold a `floorBar` in [10, 11] on a 0.1 grid;
    - firing it leaves `s.seed` unchanged.
  - `hardmode.test.ts`: add `lowSteam` to the forced-event list (`params: {}`). The engaged bot ends shift 2 alive.
- [ ] **Step 2: Run** `pnpm --filter @desal/simulator test -- steam plan8determinism director hardmode`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `pnpm -r typecheck` and `pnpm -r test`.
  - Expected: PASS, including `callsign.test.ts` unmodified and the balance suites' bands.
  - If a band moves outside its test, report the numbers instead of retuning.
- [ ] **Step 5: Commit** `feat(simulator): motive steam, standby steam line and the lowSteam fault`. The message records the sag rate, the floor grid and the mix chances.

---

### Task 4: Web UI: divert mode, steam controls and the divert hint

**Files:**
- Modify: `apps/web/src/commands.ts`, `controls/Setpoint.tsx`, `expanded/{ProductView,StagesView}.tsx`, `expanded/labels.ts`, `state/{hints,radio,store}.ts`, `plantConstants.ts`.
- Test: `apps/web/test/{expanded.test.tsx,hints.test.ts,store.test.ts,radio.test.ts,commands.test.ts}`.

**Interfaces:**
- Consumes: the status fields, the reading `vacuum.motiveSteamBar` (Task 1) and `FIX.lowSteam` (Task 3).
- Produces:
  - `divertMode(mode: DivertMode): Command` and `standbySteam(on: boolean): Command` in `commands.ts`.
  - `LoopSetpointProps.outputName?: string`. In output mode the label is `outputName ?? \`${name} output\``.
  - `store.confirmed`:
    - `setDivertMode` → `st.divertMode === cmd.mode`;
    - `standbySteam` → `st.standbySteam === cmd.on`;
    - `divertToDrain` → `st.divertMode === 'manual' && st.divertToDrain === cmd.on`.
  - `export const DIVERT_HINT_MIN = 5` and `export function divertHint(status: PlantStatus, salinity: TrendPoint[] | undefined, hinted: ReadonlySet<string>): { key: string; text: string } | null` in `state/hints.ts`.
    - It returns null unless Normal, running, `divertMode === 'manual'` and `divertToDrain === true`.
    - `since` is the `t` of the first point after the last point with `v > salinityLimit(status.shiftTarget)`, or the first point's `t` if none.
    - It is due when `last.t − since ≥ DIVERT_HINT_MIN × 60_000`.
    - The key is `${shiftId}:divert:${since}`, and the hint is skipped if that key is in `hinted`.
    - The text is exactly `Hint: Product's back in spec — send it to the tank.`
  - `radio.ts`:
    - `RadioMsg.kind: ScenarioKind | null`;
    - the push action takes `kind: ScenarioKind | null` and an optional `monitor?: MonitorId`, used in place of `monitorFor`;
    - a null kind requires `monitor`.
  - `withHints` also pushes `divertHint(...)` with `monitor: 'product'`, `eventId: 0` and `kind: null`, and records its key in `hinted`.
  - `labels.ts`: `FIX.tubeLeak.text` becomes `` `Leave Divert on Auto so off-spec water goes to drain, and ${sendCrew('plugTubes')}.` ``
  - `plantConstants.ts`: `EJECTOR_FULL_REACH_BAR = 13` and `STEAM_BAD_BAR = 11`, for the row tones.

- [ ] **Step 1: Write failing tests**
  - `expanded.test.tsx`, ProductView:
    - the Routing row reads `Auto — to tank`, `Auto — diverting`, `Manual — to tank` or `Manual — diverting` for the four status combinations;
    - a "Divert mode" toggle (on = Auto) sends `setDivertMode`;
    - the "Divert to drain" toggle sends `divertToDrain`.
  - `expanded.test.tsx`, StagesView:
    - a "Motive steam" row shows `14.5 bar`, `warn` at 12.9 and `bad` at 10.9;
    - an "Ejector steam valve" row shows `status.loops.vacuum.output` as a whole %;
    - in Manual the vacuum control's label is "Ejector steam valve" (not "Vacuum output");
    - a "Standby steam line" toggle sends `standbySteam`;
    - a "Motive steam" trend is drawn from `trends['vacuum.motiveSteamBar']`.
  - `store.test.ts`:
    - a pending `divertToDrain {on: true}` is not confirmed by a status with `divertMode: 'auto'` and `divertToDrain: true`;
    - it is confirmed once Manual is reported.
  - `hints.test.ts`: `divertHint` cases, Review Focus 5:
    - due after 5 min under the limit, not at 4.9;
    - null on Hard, in Auto, with the valve to the tank, outside running, with an empty or undefined trend;
    - an off-spec point resets `since`, so a second stretch gives a new key;
    - a key already in `hinted` gives null.
  - `hints.test.ts`: `FIX.lowSteam.text` is exactly `Switch on the standby steam line on the Stages screen.`, and its hint is held back while `standbySteam` is true.
  - `radio.test.ts`: a push with `kind: null, monitor: 'product'` opens the product monitor.
  - `store.test.ts`: a status stream that meets the divert-hint condition puts the hint on the radio once across two further statuses.
- [ ] **Step 2: Run** `pnpm --filter @desal/web test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The StagesView detail gains "Motive steam" and "Ejector steam valve" after "Vacuum quality".
  - Controls: `LoopSetpoint loop="vacuum" name="Vacuum" outputName="Ejector steam valve"`, and the Standby toggle next to the `repairEjector` CrewButton.
  - ProductView: the routing text is `${MODE_TEXT[divertMode]} — ${divertToDrain ? 'diverting' : 'to tank'}`, with `warn` when diverting.
- [ ] **Step 4: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): divert mode and direction, motive steam, standby steam line, divert hint`.

---

### Task 5: Flink report card and leaderboard, and the contract docs

**Files:**
- Modify: `services/flink/src/main/java/org/desal/flink/reportcard/{Rules,StatusView}.java`, `leaderboard/LeaderboardSql.java`.
- Test: `services/flink/src/test/java/org/desal/flink/reportcard/{RulesTest,ReportCardFunctionTest,GameStateTest}.java`, `leaderboard/LeaderboardSqlTest.java`.
- Modify: `packages/schema/src/flink.ts` (the comment on graded kinds) and `docs/streaming-notes.md`.

**Interfaces:**
- Consumes: the `plant.status` field `standbySteam` and the event kind `lowSteam`.
- Produces:
  - `StatusView.standbySteam` (a `boolean`, default `false`), read with `status.path("standbySteam").asBoolean(false)`.
  - `Rules.GRADED` gains `"lowSteam"`, and `Rules.responded` handles `case "lowSteam": return s.standbySteam;`. `crewJobFor("lowSteam")` stays null.
  - `LeaderboardSql.GRADED_KINDS` gains `'lowSteam'`. Update the Javadoc on both lists.

- [ ] **Step 1: Write failing tests**
  - `RulesTest.whichKindsGetAVerdict` includes `lowSteam`.
  - A new `lowSteamNeedsTheStandbyLine`: false with `standbySteam = false` or a crew job running, true with it on.
  - `ReportCardFunctionTest`:
    - a `lowSteam` scenario at tick T, then a status at T+3 with `standbySteam: true`, gives a `quick` verdict at 2 plant minutes;
    - with no such status the verdict is `missed`.
  - `GameStateTest`: the existing POJO-without-Kryo check covers `StatusView` with the new field. Confirm it still runs over `StatusView.class`.
  - `LeaderboardSqlTest.statsCountOperatorsAndFirstHandledWellPerModeAndGradedKind`: add a run with `kind("lowSteam", true)`, and expect `normal|lowSteam` in the stats set.
- [ ] **Step 2: Run** `services/flink/mvn.sh test`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** the interfaces.
- [ ] **Step 4: Run** `services/flink/mvn.sh test`. Expected: PASS.
  - If `ContractFixturesTest` rewrote any `packages/schema/test/fixtures/flink/*.json`, keep the regenerated files as they are (no hand edits).
  - Run `pnpm --filter @desal/schema test` (`flink.test.ts` parses them).
- [ ] **Step 5: Docs.** Update `docs/streaming-notes.md`:
  - The kind list adds `lowSteam`, described as player-fixed, not sharp, and planned on its own substream from shift 2.
  - `how: 'player'` adds "the standby steam line switched on".
  - "Status fields" adds `divertMode` (`auto`/`manual`; `divertToDrain` is now the valve's direction) and `standbySteam`.
  - New commands `setDivertMode {mode}` and `standbySteam {on}`, with no refusals of their own.
  - Telemetry gains `vacuum.motiveSteamBar` (128 readings per tick).
  - "Snapshots": version 7, with a bullet "v6 -> v7: divert mode `manual` (restored games keep the latch), motive steam 14.5 bar, standby line off, no lowSteam fault".
- [ ] **Step 6 (optional, Docker):** run `scripts/e2e-flink.sh`. Expected: it passes. Restored job state is accepted (the POJO field is added, not removed). If restore is refused, the existing fresh-start fallback applies. Never add `--allowNonRestoredState`.
- [ ] **Step 7: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(flink): grade lowSteam on the standby line; leaderboard kind; contract notes`.

---

## Spec notes and rulings (for the reviewer)

- **The trip timing and the 10–11 bar floor cannot both hold.** With the spec's curve (linear from 13 bar to `VACUUM_QUALITY_MIN` at 8 bar) and `VACUUM_TAU_S = 600`, a fully open valve holds 0.58 at 10 bar and 0.72 at 11 bar.
  - Only floors of 10.1 bar or less go below `VACUUM_TRIP`, and they trip about 33–44 plant minutes after the fault starts.
  - Floors of 10.2 bar and up settle at 0.61–0.72. That is alarmed on the web (< 0.7), with a hotter bottom stage and less distillate, but no trip.
  - The plan keeps every spec number and pins the actual behaviour in Task 3's tests. Changing the knee, the floor or the lag is a user decision.
- **Standby reset at shift start** is a ruling the spec leaves open (see Global Constraints).
- **The divert hint text** carries the Plan 7 `Hint: ` prefix.
- **lowSteam is planned on a salted substream**, not added to `SHARP_KINDS`. Adding it to the drawn pool would change every seed's draws. That breaks the spec's "seeds keep their meaning".
