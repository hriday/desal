# Plan 1: Foundation and Plant Simulator. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless, fully tested MSF plant simulator that runs shifts, takes operator commands from Kafka, and publishes telemetry, status, events, and career snapshots to Kafka running locally in Docker.

**Architecture:** A pnpm monorepo. `packages/schema` holds the message contracts (zod schemas plus inferred TS types) that every later service shares. `services/simulator` has a **pure, deterministic core**: `tick(state, commands) → { state, telemetry, status, events }`, built from one small module per plant unit. A thin Kafka adapter drives the core at 1 Hz. Docker Compose runs Kafka (KRaft) and Kafka UI.

**Tech Stack:** Node ≥ 22, TypeScript 5.x (ESM), pnpm workspaces, zod 4, vitest 4, tsx, `@confluentinc/kafka-javascript` (KafkaJS-compatible API, `const { Kafka } = require(...).KafkaJS`), Docker Compose with `apache/kafka:4.1.1` and `kafbat/kafka-ui:v1.3.0`.

**Spec:** `docs/superpowers/specs/2026-11-18-desal-operator-game-design.md`

**Milestone map (later plans, not this one):** Plan 2 covers the gateway and control room UI (wall, zoom, controls, handover and debrief screens). Plan 3 covers the Flink jobs (alarms, scaling trend, KPI and score, shift reports) and wires them into the UI. Plan 4 covers scenario content, balancing, and polish. Phase 2 (a later spec) adds RO.

## Global Constraints

- 1 simulation tick = 1 real second = **40 plant seconds**. A shift is **8 plant hours = 720 ticks**.
- **20 flash stages**. Intake pumps **P-101 and P-102 duty, P-103 standby**.
- Two control modes, `auto` and `manual`, chosen when a shift starts. Stage level loops stay `auto` in Manual but can be overridden per loop.
- Safety interlocks live in the simulator and act in the same tick. Nothing in the simulator waits on Flink, and nothing flows from Flink back into the simulator.
- Snapshot to `plant.state` (compacted, key `plant-1`) **every 30 real seconds**, at shift end, and on trip. A snapshot contains the full `PlantState`, including scenario progress, pending deliveries, and RNG state.
- Fuel: natural gas by pipeline (supply cap in MW, price in $/GJ that can change mid-shift); backup liquid fuel in an on-site tank (`standard` or `offgrade`); the shift fuel budget is in **USD**.
- Shift IDs are monotonically increasing integers. `shiftStart` and `shiftEnd` events bracket each shift.
- No game over. A career resets only via an explicit "new career" action.
- The simulator core is deterministic: same state plus same commands gives the same output. All randomness goes through the seeded RNG stored in the state.
- Kafka/streaming concept comments: wherever a key, partition count, compaction setting, or consumer-group choice is made, write a 1–3 line comment explaining *why* (spec §8).

## Review Focus

1. **Malformed or out-of-range commands** (bad JSON, unknown type, NaN, a setpoint outside its range, a stale `shiftId`) must never crash the simulator or corrupt state. They are rejected with a `commandRejected` event. *Pinned in Task 10.*
2. **Commands that are invalid for the current phase** (setpoints during `handover`, `restartStep` out of order, a `selectFuel` changeover while one is already in progress, `acidClean` while online) are rejected with a reason, and state is unchanged. *Pinned in Tasks 9 and 10.*
3. **A corrupt or unknown-version snapshot** in `plant.state` must not silently wipe the career. The simulator refuses to start with a clear message and only starts fresh with `--new-career`. *Pinned in Tasks 13 and 15.*
4. **Restarting the simulator mid-shift** resumes at the same tick and shift without emitting a second `shiftStart`. *Pinned in Task 15.*
5. **No NaN or Infinity ever enters `PlantState`**, even under extreme sequences (all pumps stopped, every fuel source exhausted, setpoints at bounds). *Pinned in Task 12 (a fuzz test).*

---

## File Structure

```
package.json                     pnpm workspace root (scripts: test, typecheck)
pnpm-workspace.yaml
tsconfig.base.json
infra/docker-compose.yml         Kafka (KRaft) + Kafka UI
docs/streaming-notes.md          concept → code map (grows each plan)
packages/schema/
  src/index.ts                   re-exports
  src/commands.ts                Command union + CommandEnvelope
  src/telemetry.ts               TelemetryReading, SENSOR_IDS
  src/status.ts                  PlantStatus (discrete state per tick)
  src/events.ts                  PlantEvent union
  src/topics.ts                  topic names + keys
  test/*.test.ts
services/simulator/
  src/constants.ts               timing + physics constants (tunable)
  src/rng.ts                     seeded RNG
  src/state.ts                   PlantState types + createInitialState()
  src/control/pid.ts             PID step
  src/control/loops.ts           loop bank: auto/manual/faults
  src/units/intake.ts            seawater, screens, pumps, cavitation, wear, pretreatment
  src/units/fuel.ts              gas supply, backup tank, changeover, deliveries
  src/units/heater.ts            firing → TBT, burner condition
  src/units/stages.ts            cascade, distillate, levels, scale, ball cleaning, vacuum, brine
  src/units/product.ts           tank, salinity, divert
  src/safety/interlocks.ts       trip detection
  src/safety/restart.ts          restart sequence (auto + manual), acid clean
  src/commands.ts                validate + apply commands
  src/scenario/types.ts          scenario data types
  src/scenario/library.ts        scenarios for shifts 1–3 + procedural generator
  src/scenario/engine.ts         fires scheduled/random events
  src/shift.ts                   shift lifecycle + accumulators + summary
  src/tick.ts                    orchestrator
  src/emit.ts                    state → telemetry/status
  src/snapshot.ts                serialize / restore (versioned)
  src/kafka/client.ts            Kafka factory, topic admin
  src/kafka/runner.ts            1 Hz loop, consume/produce, persistence
  src/main.ts                    entry (flags: --new-career)
  src/cli/send.ts                send a command from the terminal
  src/cli/watch.ts               tail topics in the terminal
  test/...                       mirrors src/
```

---

### Task 1: Monorepo scaffold and message schemas

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `packages/schema/{package.json,tsconfig.json,vitest.config.ts}`, `packages/schema/src/{index,commands,telemetry,status,events,topics}.ts`
- Test: `packages/schema/test/commands.test.ts`, `packages/schema/test/events.test.ts`

**Interfaces:**
- Produces (package `@desal/schema`):
  - `CommandSchema` (zod discriminated union on `type`) and `type Command`. Members:
    `startShift{mode:'auto'|'manual'}` · `setSetpoint{loop:LoopId, value:number}` · `setOutput{loop:LoopId, value:number}` · `setLoopMode{loop:LoopId, mode}` · `pump{pumpId:PumpId, action:'start'|'stop'}` · `setDose{chemical:'chlorine'|'antiscalant', mgL:number}` · `ballCleaning{on:boolean}` · `divertToDrain{on:boolean}` · `selectFuel{fuel:'gas'|'backup'}` · `orderFuel{tonnes:number}` · `manualTrip{}` · `restart{}` · `restartStep{step:RestartStep}` · `acidClean{}` · `pause{}` · `resume{}` · `newCareer{}`
  - `type LoopId = 'tbt'|'intakeFlow'|'recirc'|'blowdown'|'vacuum'|\`level${number}\`` (level1..level20; the schema validates 1–20)
  - `type PumpId = 'P-101'|'P-102'|'P-103'`
  - `type RestartStep = 'vacuum'|'recirc'|'ignition'|'ramp'`
  - `CommandEnvelopeSchema` = `{ commandId: string(uuid), issuedAt: number, shiftId: number|null, command: Command }`
  - `TelemetryReadingSchema` = `{ sensorId: string, unitId: UnitId, shiftId: number, tick: number, plantTime: number, value: number }`
  - `type UnitId = 'intake'|'pretreat'|'heater'|'stages'|'brine'|'vacuum'|'product'|'fuel'`
  - `PlantStatusSchema` = discrete per-tick state: `{ tick, plantTime, shiftId, phase, status, controlMode, tripCause|null, restartStep|null, loops: Record<LoopId,{mode, setpoint, output}>, pumps: Record<PumpId,{running}>, fuel:{active, changeoverTo|null, backupGrade, gasCurtailmentNotice|null}, ballCleaning, divertToDrain, shiftTicksRemaining }`
  - `PlantEventSchema` (union on `type`): `shiftStart{shiftId, scenarioId, mode, target}` · `shiftEnd{shiftId, summary:ShiftSummary}` · `trip{cause:TripCause}` · `restartProgress{step, ok:boolean, reason?}` · `online{}` · `scenario{kind, message}` · `fuelChangeover{from,to,phase:'started'|'done'|'flameOut'}` · `deliveryArrived{tonnes, grade}` · `commandRejected{commandId, reason}` · `damage{component, value}`. Every event also has `{ tick, plantTime, shiftId }`.
  - `type TripCause = 'tbtHighHigh'|'stageFlood'|'lossOfVacuum'|'noIntakeFlow'|'noFuel'|'flameOut'|'manual'`
  - `ShiftSummary = { productM3, targetM3, offSpecMinutes, fuelCostUsd, fuelBudgetUsd, trips:number, damage:{ maxHardScaleMm, pumpWear:Record<PumpId,number>, burnerCondition } }`
  - `TOPICS = { telemetry:'plant.telemetry', commands:'plant.commands', events:'plant.events', status:'plant.status', state:'plant.state' }` and `PLANT_KEY = 'plant-1'`

`plant.status` is a topic the spec doesn't list. It carries the discrete state the UI needs every tick (modes, steps, active fuel), which doesn't fit the numeric telemetry stream. It's keyed by `PLANT_KEY` and uses 1 partition.

- [ ] **Step 1: Scaffold the workspace.** Root `package.json` with `"private": true`, `"type": "module"`, `"engines": {"node": ">=22"}`, scripts `test` = `pnpm -r test`, `typecheck` = `pnpm -r typecheck`. `pnpm-workspace.yaml` lists `packages/*` and `services/*`. `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `module`/`moduleResolution` `NodeNext`, `target` `ES2023`. The schema package depends on `zod@^4` and has dev deps `vitest`, `typescript`.

- [ ] **Step 2: Write failing tests**

```ts
// packages/schema/test/commands.test.ts
import { CommandEnvelopeSchema, CommandSchema } from '../src/index.js';
test('accepts a valid setSetpoint', () => {
  expect(CommandSchema.parse({ type: 'setSetpoint', loop: 'tbt', value: 108 })).toEqual({ type: 'setSetpoint', loop: 'tbt', value: 108 });
});
test('accepts level loops 1..20 only', () => {
  expect(CommandSchema.safeParse({ type: 'setLoopMode', loop: 'level20', mode: 'manual' }).success).toBe(true);
  expect(CommandSchema.safeParse({ type: 'setLoopMode', loop: 'level21', mode: 'manual' }).success).toBe(false);
});
test('rejects NaN and unknown types', () => {
  expect(CommandSchema.safeParse({ type: 'setSetpoint', loop: 'tbt', value: NaN }).success).toBe(false);
  expect(CommandSchema.safeParse({ type: 'selfDestruct' }).success).toBe(false);
});
test('envelope requires uuid commandId', () => {
  expect(CommandEnvelopeSchema.safeParse({ commandId: 'x', issuedAt: 1, shiftId: 1, command: { type: 'pause' } }).success).toBe(false);
});
```
```ts
// packages/schema/test/events.test.ts. Round-trip one of each event type through JSON + PlantEventSchema.parse; assert deep equality.
```

- [ ] **Step 3: Run** `pnpm --filter @desal/schema test`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** the schemas listed under Interfaces. Use `z.number().finite()` for every numeric field (this rejects NaN and Infinity). Range checks belong to the simulator (Task 10), not the schema.
- [ ] **Step 5: Run** `pnpm --filter @desal/schema test && pnpm --filter @desal/schema typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(schema): monorepo scaffold and message contracts`

---

### Task 2: Simulator scaffold, RNG, constants, plant state

**Files:**
- Create: `services/simulator/{package.json,tsconfig.json,vitest.config.ts}`, `src/constants.ts`, `src/rng.ts`, `src/state.ts`
- Test: `test/rng.test.ts`, `test/state.test.ts`

**Interfaces:**
- Produces:
  - `constants.ts`: `TICK_PLANT_S = 40`, `SHIFT_TICKS = 720`, `STAGE_COUNT = 20`, `SNAPSHOT_EVERY_TICKS = 30`, plus the physics constants named in Tasks 4–8 (each defined where first used and exported from here).
  - `rng.ts`: `nextRandom(seed: number): [value: number, nextSeed: number]` (mulberry32; value in [0,1)). It is pure, so the seed lives in the state.
  - `state.ts`: `PlantState` (below) and `createInitialState(seed: number, startPlantTime: number): PlantState`

```ts
export interface Loop { mode: 'auto'|'manual'; setpoint: number; output: number; integral: number; prevError: number; fault: LoopFault|null }
export type LoopFault = { kind: 'stuck'|'drift'|'oscillate'; bias: number };
export interface Pump { running: boolean; wear: number /*0..1*/; cavitation: number /*0..1*/; bearingWearMult: number }
export interface Stage { tempC: number; levelM: number; softScaleMm: number; hardScaleMm: number }
export interface Delivery { arrivesAtTick: number; tonnes: number; grade: 'standard'|'offgrade' }
export interface PlantState {
  version: 1; seed: number; tick: number; plantTime: number;
  phase: 'handover'|'running'|'paused';
  controlMode: 'auto'|'manual';
  status: 'online'|'tripped'|'restarting'|'acidCleaning';
  trip: { cause: TripCause; atTick: number }|null;
  restart: { step: RestartStep; stepStartedTick: number; auto: boolean }|null;
  acidCleanRemainingTicks: number;
  loops: Record<'tbt'|'intakeFlow'|'recirc'|'blowdown'|'vacuum', Loop> & { levels: Loop[] };
  seawater: { tempC: number; salinityGL: number; chlorophyllUgL: number };
  intake: { pumps: Record<PumpId, Pump>; screenFouling: number; flowM3h: number; requiredM3h: number };
  pretreat: { chlorineMgL: number; antiscalantMgL: number; biofouling: number };
  heater: { tbtC: number; firingPct: number; burnerCondition: number; heatMW: number };
  stages: Stage[];
  brine: { recircM3h: number; concentrationFactor: number; blowdownM3h: number };
  vacuum: { quality: number };
  product: { flowM3h: number; salinityPpm: number; divertToDrain: boolean };
  fuel: { active: 'gas'|'backup'; changeover: { to: 'gas'|'backup'; remainingTicks: number }|null;
          gas: { capMW: number; priceUsdPerGJ: number; curtailmentNotice: { atTick: number; capMW: number }|null };
          backup: { tonnes: number; grade: 'standard'|'offgrade'; priceUsdPerGJ: number };
          deliveries: Delivery[]; burnMW: number };
  ballCleaning: boolean;
  shift: ShiftState|null;   // defined in Task 12; declare the type here
  scenario: { id: string; nextEventIndex: number; effects: ScenarioEffects };  // types from Task 11; declare here
  careerShiftCount: number;
}
```
Initial state (a new career): `phase:'handover'`, `status:'online'`, TBT 108 °C, P-101 and P-102 running, P-103 stopped, the plant at the nominal steady state (Task 12 calibrates it), zero scale, wear 0, burnerCondition 1, gas cap 60 MW at 8 $/GJ, backup 200 t `standard` at 14 $/GJ, `careerShiftCount: 0`.

- [ ] **Step 1: Failing tests:** the RNG is deterministic (`nextRandom(42)` gives the same pair twice; 10k draws all in [0,1)); `createInitialState(1, 0)` has 20 stages, 3 pumps, 20 level loops, and every numeric leaf finite (write a `allFinite(obj)` helper in `test/helpers.ts` and reuse it in later tasks).
- [ ] **Step 2: Run** `pnpm --filter simulator test`. Expected: FAIL.
- [ ] **Step 3: Implement** `rng.ts`, `constants.ts`, `state.ts`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sim): state model, constants, seeded rng`

---

### Task 3: PID and loop bank (auto, manual, faults)

**Files:** Create `src/control/pid.ts`, `src/control/loops.ts`. Test: `test/control/loops.test.ts`

**Interfaces:**
- `pidStep(loop: Loop, measured: number, gains: {kp:number; ki:number; kd:number}, outMin: number, outMax: number, dtS: number): Loop`. In `auto`, it computes the output with anti-windup (stop integrating while saturated). In `manual`, it returns the loop unchanged except that `integral` is reset to make the switch back to auto bumpless.
- Fault behaviour inside `pidStep`: `stuck` means the output is frozen; `drift` means `measured += bias` before computing, with the bias growing by `LOOP_DRIFT_PER_TICK` each tick; `oscillate` means the gains are multiplied by `LOOP_OSC_GAIN_MULT = 4`.
- `LOOP_GAINS: Record<'tbt'|'intakeFlow'|'recirc'|'blowdown'|'vacuum'|'level', {kp,ki,kd}>` and `LOOP_RANGES` (setpoint min/max, output min/max) in `constants.ts`. Setpoint ranges: tbt 90–118 °C; intakeFlow 0–7000 m³/h; recirc 2000–5000 m³/h; blowdown concentration factor 1.2–1.8; vacuum quality 0.5–1.0; level 0.15–0.6 m. Outputs are 0–100 %.

- [ ] **Step 1: Failing tests:** with a first-order test plant (`y += (u - y) * 0.1`) in `auto`, the loop settles within 2 % of the setpoint in ≤ 200 steps without overshooting more than 10 %; `manual` leaves the output where the operator set it; `stuck` freezes the output; `drift` makes the true value deviate steadily from the setpoint; `oscillate` makes a settled loop's output change sign of slope ≥ 6 times in 100 steps; switching from manual to auto doesn't jump the output by more than 5 %.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(sim): PID loop bank with faults`

---

### Task 4: Intake and pretreatment

**Files:** Create `src/units/intake.ts`. Test: `test/units/intake.test.ts`

**Interfaces:**
- `stepIntake(s: PlantState, dtS: number): PlantState`. It updates `seawater`-driven biofouling and screen fouling, pump flows, cavitation, wear, and `intake.flowM3h`.
- Relationships (constants in `constants.ts`, tunable):
  - Max flow per running pump = `PUMP_RATED_M3H = 3500 × (1 − 0.5·wear) × (1 − screenFouling)`. The flow is the intakeFlow loop's output share of the summed max.
  - `requiredM3h` = recirc make-up + reject cooling, nominally ≈ 5,500 m³/h.
  - Biofouling grows with `chlorophyllUgL` and shrinks with `chlorineMgL`: `dBio/dt = k1·chl − k2·chlorine·bio`. Screen fouling follows biofouling with a lag.
  - Cavitation rises when `screenFouling > 0.5` and the pump's speed > 80 %. Wear increments by `base + cavitation·k` per tick × `bearingWearMult`.

- [ ] **Step 1: Failing tests:**
  - At nominal (chl 1 µg/L, chlorine 1 mg/L, two pumps) the flow is ≥ the required flow and stays stable over 720 ticks.
  - Ramping chl to 8 µg/L with no extra chlorine raises screenFouling > 0.4 within 360 ticks, and the flow falls below the required flow.
  - The same bloom with chlorine at 3 mg/L keeps screenFouling < 0.25.
  - A pump running with cavitation > 0.5 wears ≥ 5× faster than a clean pump.
  - Stopping all pumps gives a flow of exactly 0, with nothing NaN.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): intake, blooms, pump wear`

---

### Task 5: Fuel system

**Files:** Create `src/units/fuel.ts`. Test: `test/units/fuel.test.ts`

**Interfaces:**
- `stepFuel(s: PlantState, demandMW: number, dtS: number): { state: PlantState; deliveredMW: number; costUsd: number; events: PlantEvent[] }`
- Rules:
  - On gas, `deliveredMW = min(demandMW, gas.capMW)`.
  - On backup, the tank burns at `demandMW / LHV`, with `LHV_STANDARD_MJkg = 42.5` and `LHV_OFFGRADE_MJkg = 38`. Off-grade fuel is capped at 85 % of `BURNER_MAX_MW = 60`. An empty tank delivers 0.
  - Cost per tick = `deliveredMW × dtS / 1000 × priceUsdPerGJ`.
  - A changeover lasts `CHANGEOVER_TICKS = 8`, during which delivery is capped at 50 % of `BURNER_MAX_MW`. In `manual` mode, if `heater.firingPct > 60` while a changeover is in progress, the burner flames out: it emits `fuelChangeover{phase:'flameOut'}` and sets `trip` with cause `flameOut` (Task 9 handles the trip mechanics; this unit only reports it via the event).
  - When a delivery's `arrivesAtTick` comes due, it adds tonnes to the tank, sets `grade` to the delivery's grade (an off-grade delivery downgrades the whole tank), and emits `deliveryArrived`.
  - A gas `curtailmentNotice` whose tick comes due sets `capMW` to the notice's cap and clears the notice.

- [ ] **Step 1: Failing tests:**
  - Gas with cap 60 and demand 40 delivers 40 at a cost of `40×40/1000×8 = 12.8` USD per tick.
  - A curtailment to 20 MW limits delivery to 20.
  - A changeover caps delivery at 30 MW for 8 ticks, then switches `active`.
  - A Manual changeover with firingPct 80 produces a `flameOut` event; the same in Auto does not.
  - Off-grade backup at 60 MW demand delivers 51 MW and drains the tank faster than standard fuel.
  - A delivery arrives on its tick and emits exactly one event.
  - An empty backup tank with gas cap 0 delivers 0 with no NaN.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): gas supply, backup fuel, changeover`

---

### Task 6: Brine heater

**Files:** Create `src/units/heater.ts`. Test: `test/units/heater.test.ts`

**Interfaces:**
- `heaterDemandMW(s: PlantState): number`. It returns `BURNER_MAX_MW × firingPct/100 × burnerCondition`, where firingPct is the tbt loop output in auto or the operator's value in manual.
- `stepHeater(s: PlantState, deliveredMW: number, recoveredTempC: number, dtS: number): PlantState`
- Relationships:
  - Steady-state outlet temperature = `recoveredTempC + deliveredMW·1e6 / (ṁ_recirc · CP_BRINE)`, with `CP_BRINE = 4000` J/kg·K and ṁ from `brine.recircM3h × 1025 / 3600`.
  - TBT approaches the steady-state value with a first-order lag `HEATER_TAU_S = 600`.
  - Burner condition degrades per tick at `BURNER_WEAR_GAS`, ×3 on standard backup and ×6 on off-grade.
  - `heatMW = deliveredMW`.

- [ ] **Step 1: Failing tests:**
  - With recovered 100 °C, recirc 4,180 m³/h, and 38 MW delivered, TBT converges to 108 ± 1 °C.
  - Halving the delivered heat lowers the steady TBT.
  - Burner wear on off-grade fuel is 6× the wear on gas over 100 ticks.
  - Zero recirc flow doesn't divide by zero: guard ṁ with a floor and assert finite.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): brine heater`

---

### Task 7: Flash stages, vacuum, brine

**Files:** Create `src/units/stages.ts`. Test: `test/units/stages.test.ts`

**Interfaces:**
- `stageEffectiveness(stage: Stage): number`. Returns `1 / (1 + (soft + hard) / SCALE_REF_MM)`, with `SCALE_REF_MM = 1.0`.
- `recoveredTempC(s: PlantState): number`. Returns `TBT − HEATER_DT0_C / mean(effectiveness)`, with `HEATER_DT0_C = 8`. Scaled tubes recover less heat, so the heater must do more.
- `bottomTempC(s: PlantState): number`. Returns `seawater.tempC + 6 + (1 − vacuum.quality)·20 + max(0, 1 − flow/required)·15`.
- `stepStages(s: PlantState, dtS: number): { state: PlantState; distillateM3h: number; carryover: number }`
- Rules:
  - **Cascade:** stage `i` has temperature `TBT − (TBT − bottom)·(i + 0.5)/N`.
  - **Distillate per stage:** `ṁ·CP_BRINE·ΔT_stage / LATENT_J_kg × eff_i`, with `LATENT_J_kg = 2.33e6`. Sum it and convert to m³/h.
  - **Scale:** soft scale grows at `SCALE_K · exp((T_i − 110)/5) · (1 − min(0.9, antiscalantMgL/4)) · max(1, (CF − 1.5)·4 + 1)`. Soft scale converts to hard at `SOFT_TO_HARD_PER_S`. Ball cleaning removes soft scale at `BALL_CLEAN_RATE` and reduces distillate 5 % while on.
  - **Levels:** each level loop drives its interstage valve. The level moves according to the loop output against a recirc-proportional inflow, plus a disturbance when recirc changes quickly. `carryover = Σ max(0, level − 0.6)` is fed to the product unit.
  - **Vacuum:** quality follows the vacuum loop output with a lag. With no steam (output 0), it decays toward 0.3.
  - **Brine:** CF follows the blowdown loop. Less blowdown raises the CF toward 1.8, and more lowers it toward 1.2.

- [ ] **Step 1: Failing tests:**
  - Clean tubes at TBT 108, seawater 30 °C, vacuum 0.95, and recirc 4,180 m³/h produce distillate in **480–540 m³/h**, and the bottom stage reads 35–40 °C.
  - At TBT 114, soft scale in stage 1 grows ≥ 3× faster than at 108.
  - Antiscalant at 4 mg/L cuts the scaling rate by ≥ 80 %.
  - 0.5 mm of hard scale in every stage lowers distillate and lowers `recoveredTempC`.
  - Ball cleaning reduces soft scale but not hard scale.
  - Forcing level1 to manual with its valve closed floods stage 1 above 0.6 m within 30 ticks, and carryover > 0.
  - Vacuum steam at 0 makes the quality fall below 0.6 within 60 ticks.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): flash stages, scale, levels, vacuum, brine`

---

### Task 8: Product water

**Files:** Create `src/units/product.ts`. Test: `test/units/product.test.ts`

**Interfaces:**
- `stepProduct(s: PlantState, distillateM3h: number, carryover: number, dtS: number): { state: PlantState; deliveredM3: number; offSpec: boolean }`
- Rules:
  - Salinity = `BASE_SALINITY_PPM = 8 + carryover × 400 + (brine CF − 1.5) × 10 when CF > 1.5`.
  - The limit comes from `shift.target.maxSalinityPpm` (default 25).
  - `divertToDrain` sends the tick's water to drain, so `deliveredM3` = 0. Diverted water is never off-spec.
  - Delivered water that is over the limit counts as off-spec and still counts as delivered. The penalty is in scoring.

- [ ] **Step 1: Failing tests:**
  - Nominal conditions give salinity < 25 ppm and delivered = distillate × 40/3600.
  - Carryover 0.1 gives ≥ 40 ppm and offSpec.
  - Divert gives delivered 0 and offSpec false.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): product water`

---

### Task 9: Interlocks, trips, restart, acid clean

**Files:** Create `src/safety/interlocks.ts`, `src/safety/restart.ts`. Test: `test/safety/interlocks.test.ts`, `test/safety/restart.test.ts`

**Interfaces:**
- `checkInterlocks(s: PlantState): TripCause | null`. Trips on: TBT ≥ `TBT_HH_C = 118`; any stage level ≥ `LEVEL_FLOOD_M = 0.8`; vacuum quality < `VACUUM_TRIP = 0.6`; intake flow < 20 % of required; delivered fuel = 0 while online (`noFuel`).
- `applyTrip(s: PlantState, cause: TripCause): { state: PlantState; events: PlantEvent[] }`
  - Sets `status: 'tripped'` and the firing output to 0.
  - Adds thermal-cycling damage: hard scale +0.02 mm in stages 1–5 and burnerCondition −0.01.
  - Emits `trip` and `damage` events.
- `beginRestart(s): Result` (one-button, Auto mode) and `restartStep(s, step): Result` (Manual mode), with `type Result = { state: PlantState; events: PlantEvent[] } | { rejected: string }`.
- `stepRestart(s: PlantState): { state; events }` runs each tick while `status === 'restarting'`. The sequence and its preconditions:
  1. `vacuum`: vacuum quality must reach ≥ 0.85.
  2. `recirc`: requires vacuum ≥ 0.85; recirc flow must reach ≥ 80 % of its setpoint.
  3. `ignition`: requires recirc ≥ 80 %; needs a fuel source with > 0 available.
  4. `ramp`: TBT rises toward its setpoint. In Manual, a ramp > 2 °C per plant minute adds burner wear and a hard scale penalty; > 4 °C per plant minute re-trips (`tbtHighHigh` is not the cause; use `flameOut`).
  5. Reaching setpoint −2 °C emits `online`.

  In Auto, the steps advance themselves when their preconditions are met. In Manual, the operator issues each `restartStep`; an out-of-order step is rejected with the reason "step X requires Y".
- `beginAcidClean(s): Result`. Allowed only when `status === 'tripped'`. Sets `acidCleanRemainingTicks = 180` (2 plant hours); on completion, all hard scale is 0 and the status stays `tripped` (the operator then restarts).

- [ ] **Step 1: Failing tests:**
  - Each interlock fires at its threshold and not just below it.
  - A trip zeroes firing and adds damage.
  - An Auto restart from tripped reaches `online` within 120 ticks under nominal conditions, emitting `restartProgress` for each step in order.
  - In Manual, `restartStep('ignition')` before `recirc` is rejected and the state is unchanged.
  - In Manual, a fast ramp re-trips.
  - `acidClean` while online is rejected; while tripped it zeroes hard scale after 180 ticks.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): interlocks, restart sequence, acid clean`

---

### Task 10: Command validation and application

**Files:** Create `src/commands.ts`. Test: `test/commands.test.ts`

**Interfaces:**
- `applyCommand(s: PlantState, env: unknown): { state: PlantState; events: PlantEvent[] }`
  1. Parse with `CommandEnvelopeSchema`. On failure, emit `commandRejected{commandId: (env as any)?.commandId ?? 'unknown', reason: 'invalid: <zod message>'}`.
  2. Reject a stale shift: if `env.shiftId !== s.shift?.id`, the reason is `'stale shift'`. Two command types are exempt and may carry `null`: `startShift` and `newCareer`.
  3. Enforce ranges with `LOOP_RANGES` (doses 0–10 mg/L; `orderFuel` 1–500 t). Out of range → reject, never clamp silently.
  4. Enforce the phase rules:
     - In `handover`, only `startShift` and `newCareer` are allowed.
     - `startShift` is allowed only in `handover`.
     - `setOutput` is allowed only for loops in `manual`. `setSetpoint` is allowed only in `auto`, except for level loops, which take setpoints in either mode.
     - In `controlMode: 'auto'`, `setLoopMode` may switch any loop. In `manual`, all non-level loops are already manual.
     - `selectFuel` during a changeover, or selecting the already-active fuel, is rejected.
     - `orderFuel` creates a delivery arriving in `DELIVERY_TICKS = 90` ticks. The grade is `offgrade` if `scenario.effects.offgradeOnly`, otherwise `standard`.
     - `restart` and `restartStep` are delegated to Task 9 per `controlMode` (`restart` in auto only, `restartStep` in manual only).
     - `pause` and `resume` toggle `phase` between running and paused.
     - `newCareer` returns `createInitialState(newSeed, s.plantTime)`, with the seed drawn from the RNG.
  5. A rejected command leaves the state reference-equal to the input.

- [ ] **Step 1: Failing tests** (one per rule; table-driven where possible):
  - Malformed JSON objects, NaN, and an unknown type are rejected with an event and no throw.
  - A stale shiftId is rejected.
  - TBT setpoint 130 is rejected; 112 is accepted.
  - `setOutput` on tbt in Auto is rejected; the same in Manual is accepted.
  - Level setpoints are accepted in Manual.
  - A setpoint during handover is rejected.
  - Double `selectFuel` is rejected.
  - `orderFuel` with `offgradeOnly` schedules an off-grade delivery at tick + 90.
  - `pause` then `resume` round-trips.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): command validation and application`

---

### Task 11: Scenario engine and library

**Files:** Create `src/scenario/{types,library,engine}.ts`. Test: `test/scenario/engine.test.ts`

**Interfaces:**
- `types.ts`:
  - `ScenarioEvent = { atMinute: number; kind: ScenarioKind; params: Record<string, number|string>; message: string }`, where `ScenarioKind = 'bloom'|'seawaterTemp'|'pumpBearing'|'gasCurtailNotice'|'gasPriceSpike'|'offgradeOnly'|'deliveryDelay'|'demandChange'|'controllerFault'`. `atMinute` is plant minutes from the shift start.
  - `Scenario = { id; target: { productM3; maxSalinityPpm; fuelBudgetUsd }; initial: { seawaterTempC; chlorophyllUgL }; events: ScenarioEvent[]; randomPerHour: { kind: ScenarioKind; p: number }[] }`
  - `ScenarioEffects = { offgradeOnly: boolean; deliveryDelayTicks: number; chlorophyllTarget: number; chlorophyllRampPerTick: number }`
- `library.ts`: `scenarioForShift(shiftNumber: number, rngSeed: number): Scenario`
  - **Shift 1, "Calm Seas":** target 3,900 m³, 25 ppm, $12,000 (nominal burn is about 38 MW × 8 h × 8 $/GJ ≈ $8,800); no scheduled events.
  - **Shift 2, "Green Water":** a bloom at minute 90 ramping chl to 8 over 120 minutes; target 3,900 m³.
  - **Shift 3, "Pipeline Notice":** a gas curtailment notice at minute 60 for 25 MW effective at minute 180; a price spike ×1.8 at minute 240; `offgradeOnly` from minute 0; target 3,700 m³, $16,000.
  - **Shift ≥ 4:** procedural, built from the seeded RNG. It picks 2–4 kinds, and the target scales with `min(1.15, 1 + 0.02·(n−3))`.
- `engine.ts`: `stepScenario(s: PlantState): { state: PlantState; events: PlantEvent[] }`. It fires due scheduled events once (advancing `nextEventIndex`), rolls the random events using `p × TICK_PLANT_S/3600` per tick, applies each effect to the state, and emits `scenario{kind, message}`.

- [ ] **Step 1: Failing tests:**
  - The shift 2 bloom fires at tick 135 (90 min × 60 / 40) exactly once.
  - The chlorophyll ramp reaches 8 µg/L by tick 315.
  - The shift 3 notice sets `gas.curtailmentNotice` and the cap changes at tick 270.
  - `scenarioForShift(7, seed)` is deterministic for the same seed and differs across seeds.
  - The random events use `state.seed`, and the advanced seed is stored.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): scenario engine and first scenarios`

---

### Task 12: Shift lifecycle, tick orchestrator, emission, calibration

**Files:** Create `src/shift.ts`, `src/tick.ts`, `src/emit.ts`. Test: `test/tick.test.ts`, `test/calibration.test.ts`, `test/fuzz.test.ts`

**Interfaces:**
- `shift.ts`:
  - `ShiftState = { id: number; startTick: number; mode: 'auto'|'manual'; target: Scenario['target']; acc: { productM3: number; offSpecTicks: number; fuelCostUsd: number; trips: number } }`
  - `startShift(s, mode): { state; events }`. It increments `careerShiftCount`, loads `scenarioForShift`, sets seawater from the scenario's `initial`, sets `phase: 'running'`, and emits `shiftStart`.
  - `endShift(s): { state; events }`. It emits `shiftEnd` with a `ShiftSummary` and returns to `phase: 'handover'`, keeping all plant state.
- `tick.ts`: `tick(s: PlantState, commands: unknown[]): { state: PlantState; telemetry: TelemetryReading[]; status: PlantStatus; events: PlantEvent[]; snapshotDue: boolean }`
  - **Order:** apply commands → if not `running`, emit status only and return → scenario → loops (each loop's measured value from the state) → intake → fuel (demand from the heater) → heater → stages → product → restart/acid-clean step → interlocks (`applyTrip` on hit) → accumulators → advance tick and plantTime → `endShift` if `tick − startTick ≥ SHIFT_TICKS`.
  - **Production** is 0 unless the status is `online`.
  - `snapshotDue` = `tick % SNAPSHOT_EVERY_TICKS === 0` || shiftEnd || trip happened this tick.
- `emit.ts`:
  - `toTelemetry(s): TelemetryReading[]`. Exports `SENSOR_IDS`, about 90 readings: per-pump flow, wear, and cavitation; screenFouling; chl; seawater temperature; TBT; firing; heatMW; burnerCondition; per-stage temperature, level, softScale, and hardScale; recirc; CF; blowdown; vacuum; product flow and salinity; gas cap and price; backup tonnes; burnMW; cumulative shift product and cost.
  - Sensor ids use dotted form, e.g. `stages.s02.levelM` and `intake.P-101.wear`.
  - `toStatus(s): PlantStatus`

- [ ] **Step 1: Failing tests:**
  - `calibration.test.ts`: from the initial state, `startShift('auto')` on shift 1 and run 720 ticks with no commands. Product is between 3,900 and 4,300 m³ (meets the target), salinity stays < 25 ppm, there are no trips, and fuel cost is under budget. It also asserts that GOR (distillate kg / steam-equivalent kg, with steam latent 2.33e6) is in 7–9.
  - `tick.test.ts`:
    - In handover, ticks don't advance the plant time.
    - A paused game doesn't advance.
    - The shift ends at exactly tick 720 with one `shiftEnd`, then waits for `startShift`.
    - Raising the TBT setpoint to 118 with no antiscalant eventually trips with `tbtHighHigh`, or else visibly increases the stage 1 scaling rate (assert whichever comes first, and that the trip increments `acc.trips`).
    - `snapshotDue` is true on ticks 30 and 60.
    - Telemetry contains every `SENSOR_IDS` entry exactly once per tick.
  - `fuzz.test.ts` (Review Focus 5): with a seeded RNG, run 20 sequences of 2,000 ticks each, issuing random valid commands (including extremes at range bounds, all pumps stopped, and fuel exhausted). Assert `allFinite(state)` after every tick and that `tick()` never throws.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, then tune the constants in `constants.ts` until calibration passes. Only constants change, never the relationships asserted in Tasks 4–8.
- [ ] **Step 4: Run** `pnpm --filter simulator test`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(sim): tick orchestrator, shift lifecycle, calibration`

---

### Task 13: Snapshots

**Files:** Create `src/snapshot.ts`. Test: `test/snapshot.test.ts`

**Interfaces:**
- `serialize(s: PlantState): string`. JSON of `{ format: 'desal-snapshot', version: 1, savedAt: number, state }`.
- `restore(json: string): { ok: true; state: PlantState } | { ok: false; reason: string }`. It rejects invalid JSON, a wrong `format`, an unknown `version`, and any non-finite numeric leaf.

- [ ] **Step 1: Failing tests:**
  - Mid-shift round-trip: run 300 ticks of shift 2, then `restore(serialize(s))` deep-equals `s`. Continuing 100 ticks from each yields identical telemetry (determinism includes the RNG and pending deliveries).
  - Garbage, `version: 2`, and an injected `NaN` (written as `null` in a numeric field) each fail with a reason.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(sim): versioned snapshots`

---

### Task 14: Local Kafka and topic admin

**Files:** Create `infra/docker-compose.yml`, `services/simulator/src/kafka/client.ts`. Test: `test/kafka/topics.int.test.ts`

**Interfaces:**
- Compose services:
  - `kafka`: `apache/kafka:4.1.1`, a single-node KRaft combined broker and controller. The host listener is `localhost:9092`; an internal listener `kafka:29092` serves Kafka UI. Auto topic creation is off.
  - `kafka-ui`: `kafbat/kafka-ui:v1.3.0` on `localhost:8080`.
- `client.ts`:
  - `createKafka(brokers = process.env.KAFKA_BROKERS ?? 'localhost:9092')` uses the KafkaJS-compatible API from `@confluentinc/kafka-javascript`: `new Kafka({ kafkaJS: { brokers, clientId: 'desal-sim' } })`.
  - `ensureTopics(kafka): Promise<void>` creates the topics if missing:
    - `plant.telemetry`: 6 partitions, key = sensorId (the comment explains per-sensor ordering and parallelism for Flink).
    - `plant.commands`: 1 partition (total order of operator actions).
    - `plant.events`: 1 partition.
    - `plant.status`: 1 partition, `retention.ms = 3600000`.
    - `plant.state`: 1 partition, `cleanup.policy=compact` (the comment explains that the latest value per key is the career save).
- Integration tests are named `*.int.test.ts` and run by `pnpm --filter simulator test:int` (a separate vitest config). The default `test` excludes them.

- [ ] **Step 1: Write** `topics.int.test.ts`: `ensureTopics` twice (idempotent), then admin `fetchTopicMetadata` shows the 5 topics with the partition counts above, and `describeConfigs` shows `cleanup.policy=compact` on `plant.state`.
- [ ] **Step 2: Run** `docker compose -f infra/docker-compose.yml up -d && pnpm --filter simulator test:int`. Expected: FAIL (no client). If `@confluentinc/kafka-javascript` fails to install on the local Node version, switch to Node 22 LTS via `.nvmrc` and note it in the README.
- [ ] **Step 3: Implement.** **Step 4: Run.** Expected: PASS. Open `http://localhost:8080` and confirm the topics are visible.
- [ ] **Step 5: Commit** `feat(infra): local kafka, kafka-ui, topic admin`

---

### Task 15: Kafka runner, resume, CLI

**Files:** Create `src/kafka/runner.ts`, `src/main.ts`, `src/cli/send.ts`, `src/cli/watch.ts`. Test: `test/kafka/runner.int.test.ts`

**Interfaces:**
- `loadCareer(kafka): Promise<{ kind: 'found'; state } | { kind: 'none' } | { kind: 'corrupt'; reason }>`. It reads `plant.state` from the beginning with a throwaway consumer group, up to the high-water mark captured at start, keeping the last value for `PLANT_KEY`.
- `class SimRunner { constructor(kafka, initial: PlantState); start(): Promise<void>; stop(): Promise<void> }`
  - A command consumer (group `desal-sim`) queues envelopes.
  - A 1,000 ms interval calls `tick(state, drained queue)`.
  - Each tick, it produces telemetry (key sensorId, Kafka message timestamp = `plantTime`), status (key `PLANT_KEY`), and events (key `PLANT_KEY`), and a snapshot when `snapshotDue`.
  - If a produce fails, it sets an in-memory `kafkaDown` flag, stops ticking (the plant freezes, so the operator never flies blind), retries every 2 s, and resumes when a send succeeds. Each transition is logged.
- `main.ts`: `loadCareer` then:
  - `found` → `SimRunner(state)`.
  - `none` → a new career.
  - `corrupt` → print the reason plus "run with --new-career to start over (your old save stays in the topic history)", and exit with code 1.
  - `--new-career` → always a new state.
- `cli/send.ts`: `pnpm --filter simulator send '<command json>'` wraps the command in an envelope (uuid, now, current shiftId read from the latest `plant.status`) and produces it.
- `cli/watch.ts`: `pnpm --filter simulator watch [events|status|telemetry <sensorId>]` pretty-prints a topic.

- [ ] **Step 1: Write** `runner.int.test.ts`:
  - **Fresh start:** `startShift auto` → within 5 s, `plant.status` shows `phase: 'running'`, `plant.telemetry` has readings for `heater.tbtC`, and `plant.events` has one `shiftStart`.
  - **Resume (Review Focus 4):** run 40 ticks, stop the runner, start a new runner via `loadCareer`. The tick continues from the last snapshot (≥ 30), the shiftId is unchanged, and no second `shiftStart` is emitted.
  - **Corrupt (Review Focus 3):** produce garbage to `plant.state` for `PLANT_KEY`; `loadCareer` returns `corrupt`.
  - **Bad command (Review Focus 1):** produce `{"nonsense":true}` to `plant.commands`; a `commandRejected` event appears and the runner keeps ticking.
- [ ] **Step 2: Run** `pnpm --filter simulator test:int`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `topicName(base: string): string` to `client.ts`. It appends `process.env.DESAL_TOPIC_SUFFIX ?? ''`, and every simulator produce, consume, and `ensureTopics` call goes through it. The integration tests set a unique suffix per run so they never touch the real career.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Manual smoke.** Run `pnpm --filter simulator start`, then `pnpm --filter simulator send '{"type":"startShift","mode":"auto"}'`, then `pnpm --filter simulator watch events`. A `shiftStart` appears. Kafka UI shows `plant.telemetry` growing about 90 messages/s.
- [ ] **Step 6: Commit** `feat(sim): kafka runner, career resume, CLI tools`

---

### Task 16: README and streaming notes

**Files:** Create `README.md`, `docs/streaming-notes.md`

- [ ] **Step 1:** `README.md` covers prerequisites (Node 22+, pnpm, Docker), `docker compose -f infra/docker-compose.yml up -d`, `pnpm i`, `pnpm test`, `pnpm --filter simulator test:int`, starting the simulator, and the CLI commands from Task 15.
- [ ] **Step 2:** `docs/streaming-notes.md` is a table of concept → where it is in the code → one-line why. It covers: topics and partitions, message keys and ordering, consumer groups, log compaction (career save), message timestamps as plant time (Plan 3 Flink event time builds on this), and idempotent topic creation.
- [ ] **Step 3:** Run `pnpm test && pnpm typecheck` (the docs task must not leave the build red). Expected: PASS.
- [ ] **Step 4: Commit** `docs: readme and streaming notes`
