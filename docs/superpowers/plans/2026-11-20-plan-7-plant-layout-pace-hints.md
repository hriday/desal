# 24-Stage Plant, Game Pace and Operator Hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plant a 24-stage brine-recirculation MSF plant with a seawater makeup loop, run calm shifts at 3× speed, and tell Normal players what to do (radio hints during the shift, "What to do" at handover).

**Architecture:**
- **Layout.** `STAGE_COUNT` becomes 24 (21 recovery + 3 reject). Stage 24 is the brine pool. Its level follows an inventory balance (makeup − distillate − blowdown), held by a new `loops.makeup`. There are 23 interstage level loops. The model stays lumped: only heat recovery (stages 1–21), the bottom temperature (stages 22–24) and the CF mass balance change. Snapshot v5 migrates v4 (and v3 through v4).
- **Pace.** `isBusy(state)` is a pure function. The runner steps every `1000 / FAST_PACE` ms. `GameHost` gives each game a due time and ticks a calm running game every step and every other game every third step. `tick()` is untouched, so determinism holds. `PlantStatus.pace` reports the cadence.
- **Hints.** They are browser-only. A `FIX` table in `labels.ts` (text, hint timing, optional `underway(status)`) feeds a pure `dueHints()` in the store, which pushes `Hint: …` radio calls on Normal, and the handover's debrief.

**Tech Stack:** TypeScript, zod 4, vitest 4, React 19 + Vite, pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-11-20-plant-layout-pace-hints-design.md` (read §2.2, §2.5, §3 and §4 in full).

## Global Constraints

- **Balance anti-goal (binding).** Nominal production, the Normal/Hard survival medians and the shift-1 passive results from Plan 6 must hold. They are pinned in Task 1 Step 1 and checked in Task 3, before any UI work.
  - Nominal: a calm shift's production is within 1 % of today's.
  - Passive Hard is broken by shift 3 in 20/20.
  - Engaged Hard median is within one shift of 6, engaged Normal within one of 8.5.
  - Passive Normal is alive after shift 1 at ≥ 0.95× target.
- **Layout constants:** `STAGE_COUNT = 24`, `RECOVERY_STAGES = 21` (stages 1–21), `REJECT_STAGES = 3` (stages 22–24). `loops.levels` holds **23** loops (`level1`…`level23`). Stage 24 has no level loop.
- **Fault shares, not stage counts:**
  - `TRIP_SCALE_STAGES` 5 → 6 (interlocks and restart ramp damage).
  - `TUBE_PLUG_DERATE` 0.6 → 0.52, so one plugged stage still costs 2 % of distillate: (1 − d)/24 = 0.4/20.
  - Tube leaks land in stages 1–21 only (0-based 0–20).
- **CF while not online** (tripped, restarting, acid cleaning): the target is frozen at its last online value.
- **Makeup ≤ intake flow**, always. There is no extra coupling of a single pump trip to makeup.
- **Pace:**
  - `FAST_PACE = 3` ticks per real second when calm, 1 when busy.
  - Busy = any fired event not cleared, or status `tripped`/`restarting`. Acid cleaning is calm.
  - It is the same in Normal and Hard, with no stored pace state and no hold time.
- **Hints:**
  - Normal only.
  - `HINT_DELAY_MIN = 20` plant minutes after the event fired, once per event, never while its fix is under way.
  - Earthquake: at once.
  - Informational/noted kinds: none.
  - Hard: none.
  - The radio text is exactly `Hint: <fix text>`.
- **Handover:** a `What to do: <fix text>` line under every event not cleared by shift end, in both modes.
- **Disaster FIX texts** (from the removed start-screen list, commit `a854abe`), verbatim:
  - fuelContamination: "Switch to the other fuel, then send the crew to flush it."
  - earthquake: "Everything breaks at once; fix what hurts most first."
  - tsunami: "When the siren sounds, run on your healthiest intake pump until the surge passes, then clean the screens."
- **Builder-tuned named constants:** the makeup gains, `MAKEUP_MAX_M3H`, `POOL_LEVEL_PER_M3H_S`, `RECIRC_SUCTION_MIN_M` and `BLOWDOWN_MAX_M3H`. Each one's test pins its behaviour. Record final values, and why, in the commit message.
- **Snapshots:** `VERSION = 5`. `restore` accepts 3, 4 and 5 (v3 → v4 → v5). Version 2 is still rejected.
- **Commands:** test with `pnpm -r test`, typecheck with `pnpm -r typecheck`. Both are green at the end of every task.
- **Git:** plain single git commands only (no `&&` chains of git commands). Never `git stash`.

## Review Focus

1. **A live v4 save restored mid-shift.** Say it has a tube leak on old stage 20, a plugged stage, a level loop in Manual and a controller fault on `level20`. It must restore as 24 stages and keep running: no `stageFlood` or other trip within 90 ticks, the leak in a recovery stage, and `level20`'s mode and fault kept. Test in Task 1.
2. **The makeup loop's PV fails, or its controller faults.** A frozen or noisy pool reading, or a stuck makeup controller, must behave like any loop fault:
   - telemetry shows the corrupted `stages.s24.levelM`;
   - `replaceSensor` is accepted and clears it;
   - putting the loop in Manual clears a controller fault;
   - the engaged bot survives it.

   Test in Task 2.
3. **A command sent to a busy game between its ticks, or a game that goes calm right after a tick.** The command applies exactly once on the next due tick. A game that was busy and is now calm gets its next tick one calm interval later, not a busy interval later. Paused and handover games keep 1 tick/s. Test in Task 4.
4. **A hint whose fix was under way at 20 minutes, but the crew finished without clearing it.** An example is `replaceSensor` finishing while another sensor event is still open. The hint must show later, once the check stops holding, and still only once. An event from the previous shift must never hint in the next one. Test in Task 7.
5. **Maximum load: TBT 112 °C with the blowdown wide open.** `MAKEUP_MAX_M3H` must still out-supply distillate plus blowdown, so the Auto makeup loop holds the pool. Test in Task 1.

---

## File Structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/schema/src/commands.ts` | Modify | `LoopId` gains `'makeup'`, levels 1–23 |
| `packages/schema/src/telemetry.ts` | Modify | `TELEMETRY_SENSOR_COUNT` 109 → 127 |
| `packages/schema/src/status.ts` | Modify | `PaceSchema`, `PlantStatus.pace` |
| `services/simulator/src/constants.ts` | Modify | layout, makeup, pool, pace and fault-share constants |
| `services/simulator/src/state.ts` | Modify | `loops.makeup`, `brine.{makeupM3h,distillateM3h,cfTargetHeld}`, `NOMINAL.makeupM3h`, `BALANCE.makeupPct` |
| `services/simulator/src/units/stages.ts` | Modify | pool, suction, sectioned heat recovery and bottom, CF balance |
| `services/simulator/src/{tick,sensors,emit,commands,shift,snapshot}.ts`, `control/loops.ts`, `safety/{interlocks,restart}.ts`, `scenario/{engine,effects,director,library}.ts`, `scenario/disaster/earthquake.ts` | Modify | wiring of the makeup loop and 24 stages |
| `services/simulator/src/pace.ts` | Create | `isBusy`, `paceOf`, `tickIntervalMs` |
| `services/simulator/src/host.ts`, `kafka/runner.ts` | Modify | per-game due times, step period |
| `services/simulator/test/fixtures/snapshot-v4.json` | Create | a frozen v4 save from the pre-change code |
| `services/simulator/test/{layout,pace,plan7balance}.test.ts` | Create | tests |
| `services/gateway/src/protocol.ts`, `test/*` | Modify | pace passthrough, 127-reading frames, 23-command burst |
| `apps/web/src/{plantConstants,limits,demo}.ts`, `equipment/FlashStages.tsx`, `expanded/StagesView.tsx`, `alarms/rules.ts` | Modify | 24-stage drawing, makeup control, brine pool |
| `apps/web/src/expanded/labels.ts`, `state/{hints.ts,radio.ts,store.ts}`, `screens/{TopBar,Handover}.tsx` | Modify / Create (`hints.ts`) | FIX table, hints, pace indicator, What to do |
| Plan 5 spec and plan | Modify | spec §6 amendments |

---

### Task 1: 24 stages, the makeup loop, the brine pool and snapshot v5

**Files:**
- Modify: `packages/schema/src/{commands,telemetry}.ts`.
- Modify: `services/simulator/src/{constants,state,tick,sensors,emit,commands,shift,snapshot}.ts`, `units/stages.ts`, `scenario/{engine,effects,director}.ts`.
- Create: `services/simulator/test/fixtures/snapshot-v4.json`, `test/layout.test.ts`, `test/plan7balance.test.ts`.
- Test: `test/snapshot.test.ts`, `test/tick.test.ts`, `test/fuzz.test.ts`, `packages/schema/test/commands.test.ts`.

**Interfaces:**
- Produces:
  - `LoopId = 'tbt' | 'intakeFlow' | 'recirc' | 'blowdown' | 'vacuum' | 'makeup' | \`level${number}\``, with `LEVEL_RE = /^level([1-9]|1[0-9]|2[0-3])$/`.
  - Constants: `STAGE_COUNT = 24`, `RECOVERY_STAGES = 21`, `REJECT_STAGES = 3`, `LEVEL_LOOP_COUNT = STAGE_COUNT - 1`.
  - Builder-tuned constants: `MAKEUP_MAX_M3H`, `MAKEUP_TAU_S`, `POOL_LEVEL_PER_M3H_S`, `RECIRC_SUCTION_MIN_M`.
  - `LOOP_GAINS.makeup`, `LOOP_RANGES.makeup` (setpoints 0.15–0.6 m, output 0–100 %), `LOOP_ACTION.makeup = 'direct'`.
  - `PlantState.loops: Record<'tbt'|'intakeFlow'|'recirc'|'blowdown'|'vacuum'|'makeup', Loop> & { levels: Loop[] }` (23 levels).
  - `PlantState.brine` gains:
    - `makeupM3h: number`: the lagged actual flow;
    - `distillateM3h: number`: the last tick's raw distillate, set by `stepStages`;
    - `cfTargetHeld: number`: used by Task 2; set to `NOMINAL.concentrationFactor` here and not read yet.
  - `NOMINAL.makeupM3h = NOMINAL.productM3h + nominal blowdown flow`. `BALANCE.makeupPct = 100 × NOMINAL.makeupM3h / MAKEUP_MAX_M3H`.
  - `LoopSensorId` gains `'makeup'`. Its true value is `stages[23].levelM`.
  - Telemetry gains `brine.makeupM3h` and `brine.coolingRejectM3h` (intake flow − makeup). `stages.s24.levelM` carries `loop: 'makeup'`, so a failed pool sensor shows in telemetry. `TELEMETRY_SENSOR_COUNT = 127` (109 + 4 × 4 + 2).
  - `toStatus` reports `loops.makeup` and `level1`…`level23`.

- [ ] **Step 1: Pin the baseline before touching code.**
  - Run `pnpm --filter @desal/simulator test -- hardmode balance` and copy the logged lines (passive Hard broken count, engaged Hard and Normal shift lists and medians) into the header comment of a new `test/plan7balance.test.ts`.
  - In that file, add `it('a calm shift makes today\'s water')`:
    - Seed 1: `createInitialState`, empty the pending plan's queue at handover, start the shift in Auto, tick `SHIFT_TICKS`.
    - Assert that `shiftEnds[0].productM3` is within 1 % of a `BASELINE_CALM_SHIFT_M3` constant, printed and pasted from this pre-change run.
  - Generate `test/fixtures/snapshot-v4.json` with a throwaway script (not committed), using today's code:
    - Play seed 3 with the engaged bot to mid-shift 2 (shift 2 running, at least one fired event).
    - Then set `faults.tubeLeak = { stage: 19, ppm: 5 }`, `faults.stageDerate[4] = 0.6`, `loops.levels[19].mode = 'manual'` and `loops.levels[19].fault = { kind: 'stuck', bias: 0 }`.
    - Write `serialize(state)`.
  - Run `pnpm -r test`. Expected: PASS. Commit `test: pin the Plan 7 balance baseline and a v4 save`.
- [ ] **Step 2: Write failing tests**
  - `packages/schema/test/commands.test.ts`: `level23` and `makeup` are valid loop ids; `level24` is not.
  - `test/layout.test.ts`:
    - `createInitialState` has 24 stages, 23 level loops and `loops.makeup` in Auto at `BALANCE.makeupPct`.
    - Ticking a nominal running shift with no events keeps `stages[23].levelM` within ±0.02 m of `NOMINAL.levelM` and `brine.makeupM3h` within 1 % of `NOMINAL.makeupM3h` for `SHIFT_TICKS`. Over the last 360 ticks the pool level's standard deviation is < 0.005 m, so it doesn't oscillate.
    - The Auto makeup loop holds the pool within ±0.05 m through a manual trip and an Auto restart, and through a forced `powerDip`.
    - **Makeup in Manual at 0 %, from nominal:**
      - after 45 ticks (30 plant min), `stages[23].levelM ≤ 0.1`;
      - after 90 ticks, `brine.distillateM3h < 0.5 × NOMINAL.productM3h` and `brine.recircM3h < 0.5 × NOMINAL.recircM3h` (starved suction).
    - With every intake pump stopped, `brine.makeupM3h ≤ intake.flowM3h` on every tick.
    - **Max load** (Review Focus 5):
      - `MAKEUP_MAX_M3H ≥ PLANT_MAX_PRODUCT_M3H + BLOWDOWN_MAX_M3H`;
      - at TBT setpoint 112 and recirc 6500, the Auto makeup loop holds the pool within ±0.05 m for 360 ticks.
    - A pool at `LEVEL_FLOOD_M` trips `stageFlood`.
    - `setSetpoint`/`setLoopMode`/`setOutput` on `makeup` are accepted and echoed in status. `startShift` in Manual leaves `makeup` and the levels in Auto, and puts the other five loops in Manual.
  - `test/snapshot.test.ts`:
    - `serialize` writes `version: 5`.
    - **The fixture restores** (Review Focus 1):
      - `ok: true`, 24 stages, where new stage `j` has old stage `floor(j·20/24)`'s level and scale;
      - `stageDerate` is resampled the same way;
      - `tubeLeak.stage === 20` (old 19 → `floor(19.5·24/20) = 23`, clamped to the last recovery stage);
      - 23 levels, `levels[19]` keeps Manual and its fault, and `levels[20..22]` are clones of `levels[19]`;
      - `loops.makeup` is in Auto at `BALANCE.makeupPct` and `brine.makeupM3h === NOMINAL.makeupM3h`;
      - `brine.cfTargetHeld` and `brine.distillateM3h` are set as Step 3 says.
    - Ticking the restored fixture 90 times trips nothing.
    - A v3 doc, built from the fixture by deleting the v4 fields as the existing v3 test does, also restores to 24 stages.
    - Version 2 is still rejected.
  - Update the existing tests that assume 20:
    - `tick.test.ts` sensor count;
    - `fuzz.test.ts` `LOOPS`: add `'makeup'` and `'level23'`, and keep `level99` invalid;
    - the snapshot "wrong stage count" case.
- [ ] **Step 3: Run** `pnpm -r test`. Expected: FAIL on the new tests.
- [ ] **Step 4: Implement.**
  - **`stepStages`:**
    - The makeup actual is `lag(prev, min(MAKEUP_MAX_M3H·pct(makeup.output), s.intake.flowM3h), dtS, MAKEUP_TAU_S)`.
    - Stage 24's level is `clamp(level + POOL_LEVEL_PER_M3H_S·(makeup − rawDistillate − blowdown)·dtS, 0, LEVEL_MAX_M)`, using this tick's raw distillate.
    - Stages 1–23 keep today's model against `levels[i]`.
    - Below `RECIRC_SUCTION_MIN_M`, `recircCapM3h` is multiplied by `poolLevel / RECIRC_SUCTION_MIN_M` (zero at level 0).
    - Store `brine.distillateM3h`.
    - Starting points: `POOL_LEVEL_PER_M3H_S ≈ NOMINAL.levelM / (1800 × NOMINAL.makeupM3h)`, so the pool empties in about 30 plant minutes from nominal; `RECIRC_SUCTION_MIN_M = 0.1`.
  - **`stepLoops`:** steps `makeup` on `measured(s, 'makeup', stages[23].levelM)`, every status.
  - **`sensors.ts`:** `LOOP_SALT.makeup = 6`. Noise uses `LOOP_RANGES.makeup`.
  - **Wiring for the makeup loop:** `effects.setLoopFault`, `director.loopMode`, `engine.clearFault` and `shift.withModes` handle `makeup` like a level loop: Auto in both control modes.
  - **`snapshot.ts`:**
    - Add `migrateV4(state)`, which applies spec §2.5 (stages and derate copy `floor(j·20/24)`, tube leak mapped and clamped to 20, levels padded to 23, makeup loop and flows balanced).
    - Set `cfTargetHeld` to the save's CF, and `distillateM3h` to `NOMINAL.productM3h`.
    - `restore` chains `migrateV3` → `migrateV4` by version.
    - The schema has `levels` of length `LEVEL_LOOP_COUNT` and the new brine fields.
    - Update the version comment.
- [ ] **Step 5: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS, including `plan7balance.test.ts` (nominal unchanged).
- [ ] **Step 6:** Commit `feat(simulator): 24-stage MSF layout, makeup loop and brine pool, snapshot v5`. List the chosen makeup gains, `MAKEUP_MAX_M3H`, `MAKEUP_TAU_S`, `POOL_LEVEL_PER_M3H_S` and `RECIRC_SUCTION_MIN_M`.

### Task 2: Sectioned heat transfer, the CF mass balance and fault shares

**Files:**
- Modify: `services/simulator/src/{constants,state}.ts`, `units/stages.ts`, `safety/{interlocks,restart}.ts`, `scenario/library.ts`, `scenario/disaster/earthquake.ts`.
- Test: `test/units/stages.test.ts`, `test/safety/interlocks.test.ts`, `test/safety/restart.test.ts`, `test/scenario/sharp.test.ts`, `test/scenario/draw.test.ts`.

**Interfaces:**
- Consumes: `brine.distillateM3h` and `brine.cfTargetHeld` (Task 1).
- Produces:
  - `recoveredTempC(s)`, which uses the mean effectiveness of `stages[0..RECOVERY_STAGES-1]`.
  - `bottomTempC(s)`: `seawater + (approach + vacuum penalty + flow penalty) / meanEff(stages[RECOVERY_STAGES..])`. **Ruling:** the "approach" divided is everything above seawater, matching the function's doc. Clean tubes give today's value.
  - `cfTarget(s, blowdownM3h): number`. While `status === 'online'` it returns `clamp((s.brine.distillateM3h + B) / B, CF_MIN, CF_MAX)`, with B = 0 giving `CF_MAX`. Otherwise it returns `s.brine.cfTargetHeld`. `stepStages` lags CF toward it with `CF_TAU_S` and stores the target into `cfTargetHeld` while online.
  - `BLOWDOWN_MAX_M3H` 1800 → 2026, so that `(NOMINAL.productM3h + B) / B = 1.45` at `BALANCE.blowdownPct` (58.33 %, kept as today's numeric value, so the blowdown integral preset is unchanged).
  - `BALANCE.blowdownPct` keeps its value. Re-derive it, or comment why it stays.
  - `TRIP_SCALE_STAGES = 6` and `TUBE_PLUG_DERATE = 0.52`.
  - `drawEvent('tubeLeak')` draws its stage from `range(s, 0, RECOVERY_STAGES - 1)`.
  - `FAULT_LOOPS` (library) and earthquake `SENSOR_LOOPS` gain `'makeup'`. `SHIFT_ONE_SENSOR_LOOPS` is unchanged.

- [ ] **Step 1: Failing tests**
  - **Stages:**
    - The nominal state's CF target equals 1.45 ± 0.002.
    - With B halved, the CF target rises toward `(D+B)/B`, as computed in the test.
    - Tripping the plant and ticking 90 times leaves CF within 0.005 of its value at the trip.
    - 0.5 mm of scale on stages 22–24 only: `recoveredTempC` is unchanged and `bottomTempC` rises by `approach × (1/eff − 1)`.
    - 0.5 mm on stages 1–21 only: `recoveredTempC` falls, and `bottomTempC` is unchanged.
    - A clean plant gives today's bottom and recovered temperatures exactly.
  - **Fault shares:**
    - `applyTrip` adds `TRIP_SCALE_MM` to stages 1–6 and not 7.
    - An over-fast manual ramp scales stages 1–6.
    - Plugging one stage of a clean nominal plant cuts raw distillate by 2.0 % ± 0.05 %.
    - Over 500 seeds, `drawEvent('tubeLeak')` stages are all in 0–20 and include 20.
  - **Makeup faults** (Review Focus 2):
    - `sensorFailure {loop:'makeup', mode:'freeze'}` freezes `stages.s24.levelM` in telemetry while the true level moves.
    - `dispatchCrew replaceSensor` is accepted, and on completion the event clears `how:'crew'`.
    - `controllerFault {loop:'makeup'}` clears `how:'player'` after `setLoopMode makeup manual`.
    - The engaged bot, given each of these forced into shift 2 (as `hardmode.test.ts`'s `forceIntoShift2`), ends shift 2 alive on seeds 1–20.
  - **`draw.test.ts`:** re-pin the `PINNED` digests. Before re-pinning, check that the only differences from the old output are tubeLeak `stage` values and loop picks that now include `makeup`: diff the JSON of seed 1 old vs new for one case. Quote that check in the commit message.
- [ ] **Step 2: Run** `pnpm --filter @desal/simulator test`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. Update the comments on `TRIP_SCALE_STAGES`, `TUBE_PLUG_DERATE`, `BLOWDOWN_MAX_M3H` and the `LOOP_GAINS.blowdown` process-gain note, each with its old and new value.
- [ ] **Step 4: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS. If `hardmode`/`balance` fail here, go on to Task 3 rather than tuning ad hoc.
- [ ] **Step 5:** Commit `feat(simulator): MSF heat-transfer sections, CF from the salt balance, fault shares for 24 stages`.

### Task 3: Balance gate

**Files:**
- Modify: `services/simulator/test/{plan7balance,hardmode,balance}.test.ts`. Constants only if needed.

**Interfaces:**
- Consumes: the Task 1 Step 1 baseline.
- Tuning knobs allowed: the Plan 7 constants (makeup gains, `MAKEUP_MAX_M3H`, `MAKEUP_TAU_S`, `POOL_LEVEL_PER_M3H_S`, `RECIRC_SUCTION_MIN_M`, `BLOWDOWN_MAX_M3H`, `TUBE_PLUG_DERATE`), and whether `makeup` is in `FAULT_LOOPS` and `SENSOR_LOOPS`. Changing any Plan 6 or earlier constant needs the user's approval: stop and report instead.

- [ ] **Step 1: Write the guard assertions** (spec §7):
  - `hardmode.test.ts`: passive Hard broken by shift 3 is `=== 20`, if the Step-1 baseline was 20/20 (otherwise `≥` the baseline). Engaged Hard median is within [5, 7].
  - `balance.test.ts`: engaged Normal median is within [7.5, 9.5].
  - `plan7balance.test.ts` keeps the calm-shift 1 % check. Also assert that `maxproduct.test.ts`'s `PLANT_MAX_PRODUCT_M3H` (857) is unchanged; it is stage-count independent.
- [ ] **Step 2: Run** `pnpm --filter @desal/simulator test -- hardmode balance plan7balance maxproduct calibration`. Compare the logged lines with the Step-1 baseline. Expected: PASS.
- [ ] **Step 3: If anything fails,** tune only the allowed knobs and rerun. If it is still out of band, stop and report the numbers to the user (the anti-goal is binding).
- [ ] **Step 4: Run** `pnpm -r test`. Expected: PASS.
- [ ] **Step 5:** Commit `test(simulator): Plan 7 balance guard`. Put the before/after logged medians in the message.

### Task 4: Game pace (simulator)

**Files:**
- Create: `services/simulator/src/pace.ts`, `test/pace.test.ts`.
- Modify: `packages/schema/src/status.ts`, `services/simulator/src/{constants,emit,host}.ts`, `kafka/runner.ts`.
- Test: `test/host.test.ts`, `test/kafka/runner.test.ts`, `packages/schema/test/status.test.ts`.

**Interfaces:**
- Produces:
  - `PaceSchema = z.enum(['calm','busy'])`, `type Pace`, and `PlantStatusSchema.pace: PaceSchema.default('calm')`.
  - `FAST_PACE = 3` (constants).
  - In `pace.ts`:
    - `isBusy(s: PlantState): boolean`: any `chaos.active.fired` entry with `cleared === false`, or `status` is `tripped` or `restarting`.
    - `paceOf(s): Pace`: `'calm'` iff `phase === 'running' && !isBusy(s)`. **Ruling:** handover, paused and over keep today's 1 tick/s ("unchanged"), so they report `'busy'`. The web shows the indicator only while running.
    - `BUSY_TICK_MS = 1000`, `CALM_TICK_MS = 1000 / FAST_PACE`, `DUE_SLACK_MS = CALM_TICK_MS / 2`.
    - `tickIntervalMs(s) = paceOf(s) === 'calm' ? CALM_TICK_MS : BUSY_TICK_MS`.
  - `toStatus(s).pace = paceOf(s)`.
  - `GameHostOptions.paced?: boolean` (default `true`).
  - `Entry` gains `dueMs: number` and `queued: unknown[]`.
  - A game is ticked in `step(_, nowMs)` when `!paced || nowMs >= dueMs - DUE_SLACK_MS`. After the tick, `dueMs = nowMs + tickIntervalMs(newState)`. A not-due game keeps its envelopes in `queued` (liveness clocks still update on receipt), runs its idle check, and emits nothing.
  - New and restored games are due at once.
  - `RunnerOptions.tickMs` defaults to `CALM_TICK_MS`. Its doc becomes "real ms per host step".

- [ ] **Step 1: Failing tests**
  - **`pace.test.ts`, the `isBusy` truth table:**
    - nothing fired → false;
    - an uncleared fired event → true;
    - all fired events cleared → false;
    - tripped → true;
    - restarting → true;
    - acid cleaning with no open events → false;
    - Hard and Normal give the same answer.
  - **`paceOf`:** handover, paused and over → `'busy'`.
  - **`host.test.ts`:**
    - Step a host at `nowMs = k·1000/3` for k = 0…8.
    - A calm running game ticks 9 times; a busy one (a forced uncleared event) ticks on k = 0, 3, 6 only.
    - The output for a skipped game is absent from `perGame`.
    - **Waiting commands** (Review Focus 3):
      - A `setSetpoint` sent to a busy game at k = 1 is applied exactly once, on the tick at k = 3.
      - A game that becomes calm on a tick ticks again on the next step.
      - A paused game ticks at k = 0, 3, 6.
    - The idle checks abandon a not-due game on time.
  - Existing host tests that step twice at the same `nowMs` and expect two ticks construct the host with `{ paced: false }`. Don't weaken their assertions.
  - **`runner.test.ts`:** with the default options the runner schedules steps `CALM_TICK_MS` apart.
  - **`status.test.ts`:** a status without `pace` parses with `'calm'`; `pace: 'fast'` fails.
- [ ] **Step 2: Run** `pnpm --filter @desal/schema test` and `pnpm --filter @desal/simulator test`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. `tick()` and its callers in tests are unchanged, so determinism holds: pace only chooses which steps call `tick()`.
- [ ] **Step 4: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(simulator): 3x pace while the plant is calm`.

### Task 5: Gateway carries pace and the 24-stage frames

**Files:**
- Modify: `services/gateway/src/protocol.ts` (burst comment).
- Test: `services/gateway/test/{sessions,frames,kafka}.test.ts`, `test/fixtures.ts`.

**Interfaces:**
- Consumes: `PlantStatus.pace` (Task 4), `TELEMETRY_SENSOR_COUNT = 127` (Task 1).

- [ ] **Step 1: Failing tests**
  - A consumed status with `pace: 'busy'` reaches the socket as `{t:'status'}` with `pace: 'busy'`. A pre-pace status record (no `pace`) reaches it with `'calm'`.
  - A frame closes after 127 readings, not 109.
  - 23 `setSetpoint` messages in one burst (the UI's "All stage levels") all pass the token bucket, with `RATE_BURST = 25`.
  - Statuses at 3 per second for one game are all forwarded (no throttling).
  - Update `fixtures.ts` statuses to carry `pace`.
- [ ] **Step 2: Run** `pnpm --filter @desal/gateway test`. Expected: the new ones FAIL. If they already pass because the schema changes flow through, record that in the commit and keep the tests.
- [ ] **Step 3: Implement** whatever the tests show is missing. Update the `protocol.ts` comment ("23 commands at once").
- [ ] **Step 4: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(gateway): pass pace and 24-stage frames through`.

### Task 6: Web: the 24-stage plant and the makeup control

**Files:**
- Modify: `apps/web/src/{plantConstants,limits,demo}.ts`, `equipment/FlashStages.tsx`, `expanded/StagesView.tsx`, `alarms/rules.ts`, `wall/Monitor.tsx` (only if it lays out 20), `expanded/expanded.css`, `wall/wall.css`.
- Test: `apps/web/test/{expanded,controls,wall,alarms,screens}.test.tsx`.

**Interfaces:**
- Consumes: the sensor ids `stages.s01`…`s24`, `brine.makeupM3h`, `brine.coolingRejectM3h`, and the loop ids `makeup` and `level1`…`level23`.
- Produces:
  - `plantConstants`: `STAGE_COUNT = 24`, `RECOVERY_STAGES = 21`, `LEVEL_LOOP_COUNT = 23`, `RECIRC_SUCTION_MIN_M` and `MAKEUP_NOMINAL_M3H`, each with its source comment.
  - `limits.LOOP_RANGES.makeup`.
  - `faultMonitor('…loop makeup…') === 'stages'`.
  - `demo.ts` has 24 stages, 23 levels, `makeup`, and the two new readings.

- [ ] **Step 1: Failing tests**
  - **StagesView:**
    - It renders 24 stage cells in two labelled groups, "Heat recovery 1–21" and "Heat rejection 22–24".
    - S24 is labelled "Brine pool".
    - It shows makeup and cooling-water reject flows in m³/h.
    - It has a makeup `LoopSetpoint` (setpoint in m) and, in Auto control mode, a makeup `LoopModeToggle`.
    - "All stage levels" sends exactly 23 commands, including `level23` and never `level24` or `makeup`.
    - The stage picker lists S1–S23.
    - The brine pool row has tone `bad` below `RECIRC_SUCTION_MIN_M`.
  - **FlashStages:**
    - 24 `data-stage` groups, with the reject section (22–24) visibly separate (`data-section="reject"`).
    - Pipes named `seawater`, `makeup`, `coolingReject` and `recycle` (stage 24 → stage 21's tubes → stage 1).
    - The caption reads "24 stages".
    - The wall test list is updated.
  - **The start screen** (spec §4) renders `FlashStages` with 24 stages (`[data-stage]` count 24 inside `.start__plant`).
  - **Alarms:** a `controllerFault` message naming `makeup` opens Stages, and the stage-level alarm covers S24.
- [ ] **Step 2: Run** `pnpm --filter @desal/web test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The drawing is the builder's call, within the viewBox and §2.1's flow order: seawater in → reject tubes → split to makeup into S24 / reject to sea; recycle pump from S24 → S21 tubes → … → S1 → heater.
  - Keep the 16px gutter and no horizontal scroll at phone width.
- [ ] **Step 4: Run** `pnpm -r typecheck`, `pnpm -r test` and `pnpm --filter @desal/web build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): 24-stage MSF drawing, brine pool and makeup control`.

### Task 7: Web: pace indicator, the FIX table and radio hints

**Files:**
- Create: `apps/web/src/state/hints.ts`.
- Modify: `apps/web/src/expanded/labels.ts`, `state/{radio,store}.ts`, `screens/TopBar.tsx`, `screens/room.css`.
- Test: `apps/web/test/{hints.test.ts,radio.test.ts,store.test.ts,room.test.tsx}`.

**Interfaces:**
- Consumes: `PlantStatus.pace`, `PlantStatus.mode`, and the `scenario`/`eventCleared` events (`eventId`, `kind`, `shiftId`, `plantTime`).
- Produces:
  - In `labels.ts`:
    - `interface FixEntry { text: string; hint: 'delay' | 'atOnce' | 'none'; underway?: (st: PlantStatus) => boolean }`;
    - `FIX: Record<ScenarioKind, FixEntry>`.
  - `HINT_DELAY_MIN = 20` in `hints.ts`.
  - `dueHints(events: PlantEvent[], status: PlantStatus, hinted: ReadonlySet<string>): { key: string; eventId: number; kind: ScenarioKind; text: string }[]`. It is pure. It returns nothing when `status.mode === 'hard'` or `status.phase !== 'running'`. It considers only `scenario` events with `shiftId === status.shiftId` and no `eventCleared` for the same `(shiftId, eventId)`, except `atOnce` kinds, which hint at fire time whether or not they were noted.
    - `delay` kinds are due once `status.plantTime − e.plantTime ≥ HINT_DELAY_MIN·60 000` and `!underway?.(status)`.
    - `key = \`${shiftId}:${eventId}:hint\``.
    - `text = \`Hint: ${FIX[kind].text}\``.
  - `State.hinted: ReadonlySet<string>`. On each status, the reducer pushes each due hint to the radio and adds its key.
  - `RadioAction push` gains an optional `key`, so a hint doesn't collide with the event's own `shift:eventId` key.
  - **`FIX` entries:**
    - `hint: 'none'` for seawaterTemp, gasCurtailNotice, gasPriceSpike, offgradeOnly, deliveryDelay, demandChange and pumpBearing;
    - `'atOnce'` for earthquake;
    - `'delay'` for the rest.
  - **`underway` checks:**
    - tubeLeak: crew `plugTubes`;
    - vacuumLoss: `repairEjector`;
    - sensorFailure: `replaceSensor`;
    - storm and tsunami: `cleanScreens`;
    - fuelContamination: `fuel.changeoverTo !== null` or crew `flushFuel`;
    - pumpTrip and powerDip: none (the event clears when two pumps run);
    - controllerFault and bloom: none (they clear on the action).
  - The three disaster texts are as Global Constraints. The other texts are the builder's wording: imperative, one line, naming the control or crew job by its on-screen label (for example `CREW_JOBS[...].plain`). The tsunami text says what to do once the surge passes.
  - TopBar shows `▶▶` (title "Fast: all quiet") when `pace === 'calm'` and `▶` (title "Normal speed: something needs you") when `'busy'`, only while `phase === 'running'`.

- [ ] **Step 1: Failing tests**
  - `hints.test.ts`:
    - Every `ScenarioKindSchema.options` kind has a `FIX` entry with non-empty text.
    - The three disaster texts are exact.
    - A tubeLeak fired at plantTime T gives no hint at T + 19 min and one hint at T + 20 min on Normal. The returned key, once in `hinted`, is not returned again.
    - The same leak on Hard → none.
    - With crew `plugTubes` running at T + 20 → none. **Review Focus 4:** when the crew finishes and the event is still open at T + 45 → exactly one.
    - A cleared event → none.
    - An earthquake → a hint at T + 0 on Normal, none on Hard.
    - gasPriceSpike → never.
    - An event from shift 2 with `status.shiftId === 3` → none.
  - `store.test.ts`: a status after the delay puts `Hint: <text>` on the radio once; a second status doesn't repeat it.
  - `room.test.tsx`: TopBar shows `▶▶` for calm running, `▶` for busy running, and neither in paused.
- [ ] **Step 2: Run** `pnpm --filter @desal/web test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Hint radio calls use the event's monitor (`monitorFor`).
- [ ] **Step 4: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): pace indicator and operator hints`.

### Task 8: Web: "What to do" at handover

**Files:**
- Modify: `apps/web/src/screens/Handover.tsx`, `screens/screens.css`.
- Test: `apps/web/test/screens.test.tsx`.

**Interfaces:**
- Consumes: `FIX` (Task 7) and `ShiftSummary.events`.
- Produces: `whatToDo(e: ShiftSummary['events'][number]): string | null`. It returns `What to do: ${FIX[e.kind].text}` when `!e.cleared`, else null.

- [ ] **Step 1: Failing tests**
  - A summary with an uncleared tubeLeak and a cleared pumpTrip renders `What to do: <tubeLeak fix>` under the tubeLeak line only.
  - It renders the same in Hard (`status.mode === 'hard'`).
  - A noted earthquake gets no line.
- [ ] **Step 2: Run** `pnpm --filter @desal/web test`. Expected: FAIL.
- [ ] **Step 3: Implement** `whatToDo` and render it as a secondary line inside the event's `<li>`.
- [ ] **Step 4: Run** `pnpm -r typecheck` and `pnpm -r test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): what to do for uncleared events at handover`.

### Task 9: Plan 5 amendments and the full gate

**Files:**
- Modify: `docs/superpowers/specs/2026-11-19-flink-report-card-leaderboard-design.md`, `docs/superpowers/plans/2026-11-19-plan-5-flink-report-card-leaderboard.md`.

- [ ] **Step 1: Amend Plan 5** per spec §6:
  - its snapshot bump becomes v6 (migrating v5; the chain v3 → v4 → v5 → v6 keeps working);
  - the sensor fixtures list 24 stages and `brine.makeupM3h` / `brine.coolingRejectM3h` (127 readings);
  - the report card shows `FIX` text under every slow or missed verdict, and "Last shift" no longer repeats it when a report card is present;
  - `pace` is ignored.

  Commit `docs: Plan 5 follows Plan 7`.
- [ ] **Step 2: Full gate.** Run `pnpm -r typecheck`, `pnpm -r test` and `pnpm --filter @desal/web build`. Expected: all pass, and the `hardmode`/`balance` logged medians are within the Task 3 bands.
- [ ] **Step 3: Local check.**
  - Bring up the infra, simulator, gateway and web, as in earlier plans' e2e steps. Start a Normal game.
  - Confirm the following:
    - the top bar shows `▶▶` and the clock runs about 3× while calm;
    - a fired event drops it to `▶`;
    - a hint appears about 30 real seconds after an ignored event;
    - the stages view shows two groups and a brine pool;
    - the handover lists "What to do" for an ignored event.
- [ ] **Step 4: Deploy readiness (note only, not a plan task).** Deploying is a separate step the user approves. When asked, run `scripts/deploy/deploy.sh`, then confirm:
  - the simulator log shows live v4 games restored (not skipped);
  - games run at the new pace.

---

## Execution notes

- Branch `plan-4-chaos`, in the worktree `/Users/hriday/code/desal/.claude/worktrees/plan-2-games`. BASE is the commit after this plan.
- Tasks run in order. Task 1 Step 1 must run on the unchanged code. Task 3 must pass before Task 4 starts. Tasks 6–8 depend on Task 1's ids and Task 4's `pace`.
