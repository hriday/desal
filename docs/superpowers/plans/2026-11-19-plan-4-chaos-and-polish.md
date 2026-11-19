# Plan 4: Chaos Director, Shift Orders, Quota Bar and Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every shift eventful (1–2 managed events; sometimes a hell shift), tell the player what to deliver and how they're doing, and make the control room look alive.

**Architecture:**
- **Simulator.** At shift end (and at game start) the simulator draws the *next* shift's chaos plan from the seed and stores it as `chaos.pending`, so the handover screen can show that shift's orders. `startShift` activates it. A director, run each tick, fires the queued events by the normal and hell timing rules and emits `scenario` / `eventCleared` pairs.
- **Sharp events and the crew.** Six new sharp events add small fault fields to `PlantState`. A single maintenance crew (the `dispatchCrew` command) clears them.
- **Web.** A quota bar, radio pop-ups, crew buttons and a shift-log handover, plus a visual-polish pass.

**Tech Stack:** pnpm monorepo, TypeScript ESM, zod 4, vitest 4, React 19 + Vite 8, Playwright. Existing packages: `packages/schema`, `services/simulator`, `services/gateway`, `apps/web`.

**Spec:** `docs/superpowers/specs/2026-11-19-chaos-director-design.md` (extends `docs/superpowers/specs/2026-11-18-desal-operator-game-design.md`).

## Global Constraints

- **Determinism.** `tick()` stays pure and deterministic. All randomness comes from `nextRandom(seed)` (`services/simulator/src/rng.ts`), threading `state.seed`. No `Math.random`, no wall clock.
- **Shift clock.** A shift is 720 ticks; 1 tick = 40 plant seconds (`TICK_PLANT_S`); a shift is 480 plant minutes. "Plant minute" = minutes since `shift.startTick` on that clock.
- **Hell chance** for shift n ≥ 2: `min(0.45, 0.10 + 0.04 × (n − 2))`. Shift 1 is never hell. The shift after a hell shift is never hell.
- **Event counts.**
  - Normal shift: 1–2 events, always including at least one sharp kind.
  - Hell shift: 4–6 drawn events.
  - Shift 1: exactly 1 gentle event, from `pumpTrip | sensorFailure | storm`.
  - The total fired per shift (including cascades) is ≤ 7.
- **Hell shifts:** 70 % are warned in the orders; the water target is × 0.85 (rounded).
- **Normal timing:**
  - The first event fires at plant minute 30–150.
  - Each later event fires only when the plant is settled, and ≥ 60 min after the previous event.
  - The 180-min override fires an event even if the plant is unsettled.
  - Nothing fires after minute 420 (480 − 60); unfired events are dropped.
- **Hell timing:**
  - The first event fires at minute 30–120.
  - Each next event fires 10–40 min after the previous one, regardless of whether the plant is settled.
  - Nothing fires after minute 420.
- **Cascades** (hell shifts only; each pushes a new queued event):
  - storm → bloom in 60–120 min (p 0.6);
  - powerDip → sensorFailure immediately (p 0.4);
  - pumpTrip → pumpBearing on the started standby (p 0.4).
- **New sharp kinds:** `pumpTrip`, `tubeLeak`, `vacuumLoss`, `powerDip`, `storm`, `sensorFailure`.
- **Crew jobs:** `plugTubes` $3,000 / 60 min; `repairEjector` $4,000 / 45 min; `replaceSensor` $1,500 / 30 min; `cleanScreens` $1,000 / 30 min.
  - There is one crew; a second dispatch is rejected.
  - A job is only accepted when its fault exists.
  - The new account cause is `crew`.
- **`pumpTrip` / `powerDip`** pick only a running pump, and only when another pump is neither running nor under overhaul. Otherwise the draw/director substitutes another sharp kind. Auto never starts the standby.
- **Sensor failures** only hit loop-feeding sensors. There is no "sensor failed" alarm or status field. The failure is visible only as the reading's behaviour.
- **Random hourly events (`randomPerHour`) are removed.** The hand-written shifts 2–3 are replaced by the draw.
- **The snapshot version becomes 3.** Version 2 saves are rejected and skipped, as v1 was.
- **Kafka ordering/seq/epoch rules are unchanged.** Every new event goes through the existing per-game `seq`.
- **UI.**
  - All animation is disabled under `prefers-reduced-motion: reduce`.
  - Keep the approved flat-schematic monitor style and the existing colour tokens.
  - Fonts load from Google Fonts only.
- **No new services. No Flink** (that's Plan 5).

## Review Focus

1. **The plan must survive a crash.** It's drawn at handover, and the server can restart mid-handover or mid-shift. The pending/active plan, director cursor and crew job must be in the snapshot and replay identically (Task 2 round-trip test, Task 5 replay test).
2. **No unwinnable trip.** A pump trip is drawn while P-103 is under overhaul or already running. The expected behaviour is substitution, never a trip that leaves fewer than two pumps available (Task 3 test, Task 6 test).
3. **Crew job raced by the fault ending.** The player dispatches `replaceSensor` and the shift ends mid-job. The job must not carry into the next shift's faults or charge twice. Shift start clears the crew and per-shift faults (Task 8 test).
4. **Trip while an event is queued.** The plant trips and restarts during a normal shift. The director must not fire the next event during the trip (not settled) unless the 180-min override passes (Task 5 test).
5. **Quota-bar maths at the edges.** At 0 ticks remaining, with target 0 or the shift not running, the bar must not divide by zero or show NaN; it's hidden outside a running shift (Task 9 test).

---

### Task 1: Schema additions

**Files:**
- Modify: `packages/schema/src/events.ts`, `packages/schema/src/commands.ts`, `packages/schema/src/status.ts`
- Test: `packages/schema/src/*.test.ts` (extend the existing files)

**Interfaces — Produces:**
- `ScenarioKindSchema` gains `'pumpTrip' | 'tubeLeak' | 'vacuumLoss' | 'powerDip' | 'storm' | 'sensorFailure'`. Export `SHARP_KINDS: readonly ScenarioKind[]` with those six.
- `CrewJobSchema = z.enum(['plugTubes','repairEjector','replaceSensor','cleanScreens'])`, `type CrewJob`.
- Command `{ type: 'dispatchCrew', job: CrewJob }`.
- `AccountCauseSchema` gains `'crew'`.
- The `scenario` event gains `eventId: z.number().int().min(1)` and `radio: z.string()`.
- New event `{ ...base, type: 'eventCleared', eventId, kind: ScenarioKind, how: z.enum(['player','crew','expired','noted']) }`.
- `shiftStart` gains `hell: z.boolean()` and `orders: ShiftOrdersSchema`.
- `ShiftOrdersSchema = z.object({ targetM3: num, maxSalinityPpm: num, budgetUsd: num, lines: z.array(z.string()), briefing: z.array(z.string()) })`. `briefing` is non-empty only on shift 1.
- `ShiftSummarySchema` gains `hell: z.boolean()` and `events: z.array(z.object({ eventId, kind: ScenarioKind, atMinute: num, cleared: z.boolean(), how: <same enum>.nullable() }))`.
- `PlantStatusSchema` gains:
  - `shiftProductM3: num`, `shiftOffSpecM3: num`, `productFlowM3h: num`;
  - `crew: z.object({ job: CrewJob, remainingTicks: num }).nullable()`;
  - `orders: ShiftOrdersSchema.nullable()` (the pending orders during handover, the active ones while running, null otherwise);
  - `hell: z.boolean().nullable()` (the active shift's flag; null in handover so the player can't peek at an unwarned hell).

- [ ] **Step 1: Write failing tests.** In the existing schema tests:
  - `CommandSchema.parse({type:'dispatchCrew', job:'plugTubes'})` succeeds, and `job:'nope'` fails.
  - An `eventCleared` event round-trips through `PlantEventSchema`.
  - A `scenario` event without `eventId` fails.
  - A status fixture with the new fields parses, and the same fixture without `crew` fails.
  - `SHARP_KINDS` has length 6 and every entry parses as a `ScenarioKind`.
- [ ] **Step 2:** Run `pnpm --filter @desal/schema test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the schema changes above.** Then run `pnpm -r typecheck`. It will fail in the simulator, gateway and web where fixtures and emitters lack the new fields. **Fix only fixtures and type errors** with minimal placeholder values in this task:
  - the status emitter sets `crew: null`, `orders: null`, `hell: null`, the shift accumulators from `shift.acc`, and `productFlowM3h` from `product.flowM3h`;
  - `scenario` events get a temporary `eventId` from a counter and `radio = message`;
  - `shiftStart` gets `hell:false` and orders built from the target with empty lines;
  - the summary gets `hell:false, events:[]`.

  Later tasks replace these placeholders.
- [ ] **Step 4:** Run `pnpm -r typecheck && pnpm -r test`. Expected: all PASS.
- [ ] **Step 5:** Commit `feat(schema): chaos events, crew command, orders, quota status fields`.

### Task 2: Simulator state for chaos, faults and crew; snapshot v3

**Files:**
- Modify: `services/simulator/src/state.ts`, `services/simulator/src/snapshot.ts`
- Create: `services/simulator/src/scenario/chaosTypes.ts`
- Test: `services/simulator/src/snapshot.test.ts`, `services/simulator/src/state.test.ts`

**Interfaces — Produces** (in `chaosTypes.ts`):
```ts
export interface QueuedEvent { eventId: number; kind: ScenarioKind; params: Record<string, number|string>; earliestMinute: number; cascade: boolean }
export interface ChaosPlan { shiftNumber: number; hell: boolean; warned: boolean; targetM3: number; orders: ShiftOrders; queue: QueuedEvent[] }
export interface FiredEvent { eventId: number; kind: ScenarioKind; atMinute: number; cleared: boolean; how: 'player'|'crew'|'expired'|'noted'|null }
export interface ActiveChaos { plan: ChaosPlan; fired: FiredEvent[]; lastFiredMinute: number | null; nextEventId: number }
export type SensorFault = { kind: 'freeze'; value: number } | { kind: 'noise'; amplitude: number };
```

`PlantState` gains:
- `chaos: { pending: ChaosPlan | null; active: ActiveChaos | null; lastWasHell: boolean }`
- `crew: { job: CrewJob; remainingTicks: number } | null`
- `faults`, with these fields:
  - `tubeLeak: { stage: number; ppm: number } | null`;
  - `ejectorFailed: boolean`;
  - `powerDipRemainingTicks: number`;
  - `stormRemainingTicks: number`;
  - `sensors: Partial<Record<LoopSensorId, SensorFault>>`;
  - `stageDerate: number[]` (20 entries, 1 = healthy).
- `LoopSensorId = 'tbt' | 'intakeFlow' | 'recirc' | 'blowdown' | 'vacuum'`. These are the loops' process values; reuse the `LoopId` names.

`createInitialState` sets these empty or healthy. The snapshot zod `PlantStateSchema` is extended to match, and `VERSION = 3`.

- [ ] **Step 1: Failing tests:**
  - `createInitialState(...)` has `chaos.pending === null`, `crew === null`, and `faults.stageDerate` with length 20, all 1.
  - A state with a populated `chaos.active`, a `crew` job and a sensor fault survives `serialize` → `deserialize` deep-equal.
  - A saved document with `version: 2` is rejected with reason `unknown version: 2`.
- [ ] **Step 2:** Run `pnpm --filter @desal/simulator test snapshot state`. Expected: FAIL.
- [ ] **Step 3:** Implement. Update the doc comment above `VERSION` with "3 = chaos plan, crew and fault fields".
- [ ] **Step 4:** Run `pnpm --filter @desal/simulator test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(sim): chaos, crew and fault state; snapshot v3`.

### Task 3: The shift draw and the orders text

**Files:**
- Create: `services/simulator/src/scenario/draw.ts`, `services/simulator/src/scenario/orders.ts`
- Modify: `services/simulator/src/scenario/library.ts` (keep `drawEvent`, `eventMessage`, `shiftTargetM3`, `difficulty`; add messages for the new kinds; delete the hand-written shifts and `randomPerHour` from `scenarioForShift`, which now only supplies `initial` conditions and the base target)
- Test: `services/simulator/src/scenario/draw.test.ts`, `services/simulator/src/scenario/orders.test.ts`

**Interfaces — Produces:**
- `drawChaosPlan(input: { shiftNumber: number; seed: number; lastWasHell: boolean; state: PlantState }): [ChaosPlan, number]`. It returns the plan and the next seed. It uses `state` only to check pump availability and equipment condition for the orders lines.
- `hellChance(n: number): number`.
- `radioLine(kind: ScenarioKind, params): string`, in the plant's voice. Example: pumpTrip → `"Control, P-101 just tripped — she's coasting down!"`.
- `buildOrders(plan: Omit<ChaosPlan,'orders'>, state: PlantState, budgetUsd: number): ShiftOrders`. Lines:
  - one condition line for seawater (temperature, chlorophyll);
  - one per pump at ≥ 50 % wear ("P-102 is running rough");
  - on a warned hell shift, 1–2 hint lines derived from the queued kinds (storm → "Storm forecast later in the shift.", powerDip → "Grid is unstable today.", vacuumLoss/tubeLeak → "Maintenance flagged the evaporator — keep an eye on it.", pumpTrip/pumpBearing → "Intake pumps have been noisy.", gas kinds → "Gas supplier is unreliable today.").
  - Shift 1 `briefing` has exactly three lines: deliver the target water; keep salt under the limit (product diverted or off-spec doesn't count); click a monitor to act, and watch the budget.

  Each kind's params are drawn by `drawEvent`, extended for the new kinds:
  - pumpTrip: `{ pumpId }`
  - tubeLeak: `{ stage, ppm }`
  - vacuumLoss: `{ ratePerMin }`
  - powerDip: `{ pumpId, recircFactor, minutes }`
  - storm: `{ fouling, deltaC, minutes }`
  - sensorFailure: `{ loop, mode: 'freeze'|'noise' }`

  Magnitudes scale with `difficulty(n)`; shift 1 uses the mild end.

- [ ] **Step 1: Failing tests** in `draw.test.ts`:
  - `hellChance(2) === 0.10`, `hellChance(4) ≈ 0.18`, and `hellChance(50) === 0.45`.
  - Shift 1 over 500 seeds: never hell; exactly 1 event, of kind `pumpTrip|sensorFailure|storm`.
  - n = 6 over 5,000 seeds with `lastWasHell:false`: the hell rate is within ±0.03 of `hellChance(6)`.
  - `lastWasHell:true` → never hell (over 500 seeds).
  - Normal plans: 1–2 events with ≥ 1 in `SHARP_KINDS`. Hell plans: 4–6 events.
  - A hell plan's target is `Math.round(shiftTargetM3(n) * 0.85)`; a normal plan's target is `shiftTargetM3(n)`.
  - Warned rate across hell plans (2,000 samples) is within ±0.05 of 0.70.
  - With P-103 under overhaul (`overhaulRemainingTicks > 0`), no plan over 500 seeds contains `pumpTrip` or `powerDip`.
  - Same seed and input → deep-equal plan (determinism).
- [ ] **Step 2: Failing tests** in `orders.test.ts`:
  - Shift 1 orders have 3 briefing lines and contain the target.
  - A warned hell plan with a storm has a line matching `/storm/i`.
  - An unwarned hell plan's lines equal what a normal plan with the same state would produce (no hint).
  - A pump at 0.6 wear produces a line naming it.
- [ ] **Step 3:** Run `pnpm --filter @desal/simulator test draw orders`. Expected: FAIL.
- [ ] **Step 4:** Implement. Event ids are assigned 1..k in queue order. `earliestMinute` is set by the director (Task 5), so the draw sets 0.
- [ ] **Step 5:** Run the full simulator tests. Existing `library` tests for the hand-written shifts 2–3 and `randomPerHour` are deleted or rewritten to match the spec. Expected: PASS.
- [ ] **Step 6:** Commit `feat(sim): chaos plan draw and shift orders`.

### Task 4: Shift lifecycle wiring

**Files:**
- Modify: `services/simulator/src/shift.ts`, `services/simulator/src/host.ts` (game start), `services/simulator/src/emit.ts` (status `orders`/`hell`/`crew`), `services/simulator/src/scenario/engine.ts` (`loadScenario` no longer handles events; `randomPerHour` loop removed)
- Test: `services/simulator/src/shift.test.ts`, `services/simulator/src/emit.test.ts`

**Interfaces:**
- **Consumes:** `drawChaosPlan`, `buildOrders` (Task 3).
- **Produces:**
  - At game creation and at every shift end, the simulator calls `drawChaosPlan` for shift `shiftNumber + 1` (game creation draws shift 1) and stores it in `chaos.pending`.
  - `startShift` moves `pending` → `active` (`fired: []`, `lastFiredMinute: null`, `nextEventId` = queue length + 1), sets `shift.target.productM3 = plan.targetM3`, sets `chaos.lastWasHell = plan.hell`, and clears `crew` and every per-shift fault (all `faults` fields reset; `stageDerate` all 1).
  - The `shiftStart` event carries `hell` and `orders`.
  - At shift end, the summary's `events` come from `active.fired`; never-fired queue entries are omitted. `hell` = `plan.hell`. Then `active = null`.
  - Status: `orders` = `pending.orders` in handover, `active.plan.orders` while running or paused, else null. `hell` = `active.plan.hell` while running, else null.

- [ ] **Step 1: Failing tests:**
  - A new game has `chaos.pending.shiftNumber === 1`.
  - After `startShift`, `pending === null`, `active.plan.shiftNumber === 1` and `shift.target.productM3 === active.plan.targetM3`.
  - After a full shift (720 ticks), `pending.shiftNumber === 2` and the `shiftEnd` summary has `hell` and an `events` array.
  - A state with a running crew job and a tube leak, after shift end and `startShift`: `crew === null` and `faults.tubeLeak === null` (Review Focus 3).
  - Handover status `orders` is non-null and `hell` is null.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the simulator tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(sim): draw next shift's plan at handover; activate at shift start`.

### Task 5: The director

**Files:**
- Create: `services/simulator/src/scenario/director.ts`
- Modify: `services/simulator/src/scenario/engine.ts` (`stepScenario` calls `stepDirector` and keeps the chlorophyll ramp), `services/simulator/src/scenario/engine.ts` `applyEffect` (dispatch for the new kinds via a `applySharpEffect` hook that Tasks 6–7 fill; until then the new kinds only set the fired record)
- Test: `services/simulator/src/scenario/director.test.ts`

**Interfaces — Produces:**
- `stepDirector(s: PlantState): { state: PlantState; events: SimEvent[] }`. It does nothing unless `phase === 'running'` and `chaos.active`.
- `isSettled(s: PlantState): boolean`. True when:
  - every fired event is `cleared`;
  - `status === 'online'`;
  - `product.salinityPpm <= shift.target.maxSalinityPpm`.
- `isCleared(s: PlantState, e: FiredEvent): 'player' | 'crew' | null`. It returns the condition per spec §4.3/§4.10:
  - pumpTrip/powerDip: ≥ 2 pumps running (and for powerDip `powerDipRemainingTicks === 0`) → `'player'`;
  - tubeLeak, vacuumLoss and sensorFailure → `'crew'` when their fault field is cleared;
  - storm → `'crew'` when `stormRemainingTicks === 0` and screen fouling is back under the storm's added amount, or the cleanScreens job completed;
  - controllerFault → `'player'` when that loop is in manual;
  - bloom → `'player'` when chlorophyll < the bloom alarm level or the chlorine dose has risen since firing.

  Informational kinds are marked `cleared:true, how:'noted'` on firing, and an `eventCleared` is emitted in the same tick.

**Timing algorithm** (the spec values are in Global Constraints). At the first tick of the shift the director draws the first fire minute (normal 30–150, hell 30–120) into `queue[0].earliestMinute`. Each tick:

1. Mark newly cleared fired events and emit `eventCleared` for each.
2. If `elapsedMin > 420`, drop the remaining queue (no event) and return.
3. Take the head of the queue.
   - **Fire if** `elapsedMin >= head.earliestMinute` and:
     - hell, or
     - normal and (`lastFiredMinute === null` or `isSettled` or `elapsedMin - lastFiredMinute >= 180`).
   - For a normal shift, a fire also requires `elapsedMin - lastFiredMinute >= 60`.
   - Firing a `pumpTrip`/`powerDip` re-checks pump availability. If none is available, substitute the next sharp kind in `SHARP_KINDS` order that is valid, with params from `drawEvent`.
4. **On fire:**
   - apply the effect;
   - push to `fired`;
   - emit `scenario` with `eventId`, `message` and `radio`;
   - set `lastFiredMinute`;
   - set the next head's `earliestMinute` (hell: now + 10–40; normal: now + 60);
   - in a hell shift, roll the cascades and append them (respecting the cap of 7 fired + queued, with new ids from `nextEventId`).

- [ ] **Step 1: Failing tests** (use a helper that builds a running state with a hand-made `active` plan and advances ticks with `tick()`):
  - A normal plan with 2 events: the first fires at minute 30–150; the second doesn't fire while the first is uncleared until minute ≥ first + 180; after clearing, it fires at ≥ first + 60.
  - A hell plan with 5 events: consecutive fires are 10–40 min apart, regardless of clearing.
  - An event whose `earliestMinute` falls after 420 never fires, and the summary omits it.
  - **Trip held** (Review Focus 4): force a trip right after the first event clears in a normal shift. The second event doesn't fire while `status !== 'online'` unless 180 min have passed since the last fire.
  - A cascade from a hell storm (seed chosen so p passes) queues a `bloom`, and the total never exceeds 7 across 2,000 seeds.
  - Informational kinds emit `scenario` then `eventCleared{how:'noted'}` in the same tick.
  - **Replay:** snapshot mid-shift, deserialize, and continue 200 ticks. Events deep-equal an uninterrupted run (Review Focus 1).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the simulator tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(sim): chaos director with normal/hell timing and cascades`.

### Task 6: Sharp events — pumpTrip, powerDip, storm

**Files:**
- Create: `services/simulator/src/scenario/sharp.ts` (`applySharpEffect(s, kind, params): PlantState` and `stepFaults(s, dt): PlantState`)
- Modify: `services/simulator/src/units/intake.ts` (storm fouling and recirculation factor read from `faults`), `services/simulator/src/tick.ts` (call `stepFaults` after the scenario), `services/simulator/src/constants.ts` (named magnitudes)
- Test: `services/simulator/src/scenario/sharp.test.ts`

**Behaviour:**
- **pumpTrip** sets `pumps[pumpId].running = false` and adds `PUMP_TRIP_WEAR` (0.1) to its wear.
- **powerDip** does the same without the wear, and sets `powerDipRemainingTicks = minutes*60/40`. While it's > 0, the recirculation flow is capped at `recircFactor` × its normal max (0.6 by default).
- **storm:**
  - adds `fouling` to `intake.screenFouling` at once;
  - drops seawater temperature by `deltaC`;
  - sets `stormRemainingTicks`;
  - while active, screen fouling grows by `STORM_FOULING_PER_TICK`.

  Fouling stays after the storm until `cleanScreens` (Task 8) removes the storm-added amount.
- Auto never starts a pump: assert that no loop or Auto code path sets `running = true`.
- Magnitudes: one duty pump lost halves intake. The `noIntakeFlow` interlock must not trip from a single-pump loss with the other duty pump running (assert it).

- [ ] **Step 1: Failing tests:**
  - After pumpTrip on P-101 at nominal: P-101 is stopped, intake flow is ≤ 60 % of before within 3 ticks, and the plant hasn't tripped after 20 ticks. Starting P-103 restores ≥ 95 % of the flow within 10 ticks.
  - powerDip caps recirculation and expires after its ticks.
  - storm raises screen fouling, and after `stormRemainingTicks` reaches 0 the fouling stops growing.
  - In Auto with no player action for 60 ticks after pumpTrip, P-103 stays stopped.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the simulator tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(sim): pump trip, power dip and storm events`.

### Task 7: Sharp events — tubeLeak, vacuumLoss, sensorFailure

**Files:**
- Modify: `services/simulator/src/scenario/sharp.ts`, `services/simulator/src/units/product.ts` (adds `faults.tubeLeak.ppm` to salinity), `services/simulator/src/units/stages.ts` (multiplies stage distillate by `stageDerate`; ejector failure lowers vacuum quality by `ratePerMin` per plant minute, offset by load), `services/simulator/src/tick.ts` (`stepLoops` reads each loop's process value through `measured(s, loopId, trueValue)`), `services/simulator/src/emit.ts` (telemetry for faulted loop sensors goes through `measured`)
- Create: `services/simulator/src/sensors.ts` exporting `measured(s: PlantState, loop: LoopSensorId, trueValue: number): number`
- Test: `services/simulator/src/scenario/sharp.test.ts`, `services/simulator/src/sensors.test.ts`

**Behaviour:**
- **tubeLeak:** salinity gets `+ppm` at once, growing by `TUBE_LEAK_GROWTH_PPM_PER_MIN` while unplugged. Completing `plugTubes` (Task 8) clears it and sets `stageDerate[stage] = TUBE_PLUG_DERATE` (0.6).
- **vacuumLoss:**
  - Set `ejectorFailed = true`. Vacuum quality falls each tick, so with no action a `lossOfVacuum` trip follows in 20–30 plant minutes at nominal load.
  - Lowering TBT by ≥ 5 °C or firing by ≥ 20 % roughly halves the fall rate.
  - Completing `repairEjector` clears the failure.
- **sensorFailure:**
  - freeze stores the true value at failure as `value`;
  - noise uses `amplitude` (a fraction of the reading's span) with deterministic noise from the seed;
  - `measured` returns the faulted value, and both the PID and the telemetry use it;
  - there is no status field or alarm.

- [ ] **Step 1: Failing tests:**
  - A tube leak of 15 ppm on a plant at 8 ppm gives ≥ 23 ppm on the next tick.
  - Vacuum loss with no action trips `lossOfVacuum` between 30 and 45 ticks (20–30 plant minutes). With TBT lowered 5 °C at the fault, it doesn't trip within 45 ticks.
  - A frozen `tbt` sensor keeps the telemetry `heater.tbtC` constant while the true TBT moves. The Auto TBT loop then drives the true TBT away from setpoint by > 2 °C within 60 ticks. Switching the loop to Manual stops the drift.
  - `measured` with no fault returns `trueValue` exactly.
  - Determinism: the same seed gives identical noise sequences.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the simulator tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(sim): tube leak, vacuum loss and sensor failure events`.

### Task 8: Maintenance crew command

**Files:**
- Modify: `services/simulator/src/commands.ts`, `services/simulator/src/economy.ts` (charge with cause `crew`), `services/simulator/src/scenario/sharp.ts` (`stepCrew` counts down and clears on completion), `services/simulator/src/emit.ts` (status `crew`)
- Test: `services/simulator/src/commands.test.ts`, `services/simulator/src/scenario/sharp.test.ts`

**Behaviour:**
- `dispatchCrew {job}` is accepted only while running, with no crew busy, and with the job's fault present:
  - plugTubes needs `tubeLeak`;
  - repairEjector needs `ejectorFailed`;
  - replaceSensor needs any sensor fault (the job fixes all sensor faults at once);
  - cleanScreens needs `stormRemainingTicks > 0` or storm-added fouling > 0.
- Otherwise it's rejected with a `commandRejected` reason, exactly one of:
  - `"crew busy"`;
  - `"nothing to repair"`;
  - `"not running"`.
- On acceptance the cost is charged immediately (an `accountChange` with cause `crew`), and `crew = { job, remainingTicks: minutes*60/40 }`. The crew counts down in plant time; a paused game doesn't tick.
- On completion the fault is cleared and `crew = null`. The director's `isCleared` then reports `'crew'`.
- **Storm-added fouling:** track it in `faults.stormFouling: number` (added in this task) so cleanScreens removes exactly that amount.

- [ ] **Step 1: Failing tests:**
  - With no faults, dispatch → rejected "nothing to repair".
  - With a tube leak, dispatch plugTubes → balance −3,000, `crew.remainingTicks === 90`; after 90 ticks, `tubeLeak === null`, `stageDerate[stage] === 0.6` and `crew === null`.
  - A second dispatch while busy → "crew busy".
  - replaceSensor clears all sensor faults.
  - A dispatch during handover → "not running".
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @desal/simulator test` and `pnpm --filter @desal/simulator test:int`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(sim): maintenance crew command`.

### Task 9: Web — quota bar and radio pop-ups

**Files:**
- Create: `apps/web/src/screens/QuotaBar.tsx`, `apps/web/src/screens/quota.ts` (pure maths), `apps/web/src/screens/Radio.tsx`, `apps/web/src/state/radio.ts` (queue reducer)
- Modify: `apps/web/src/screens/ControlRoom.tsx` (mount both; a radio click opens the monitor), `apps/web/src/plantConstants.ts` (export `DESIGN_PRODUCT_M3H`, mirroring the simulator's design product flow; the implementer reads the value from the simulator constants)
- Test: `apps/web/src/screens/quota.test.ts`, `apps/web/src/screens/QuotaBar.test.tsx`, `apps/web/src/state/radio.test.ts`

**Interfaces — Produces:**
- `paceState(input: { productM3: number; targetM3: number; flowM3h: number; ticksRemaining: number }): 'done' | 'onPace' | 'behind' | 'outOfReach'`. Hours left = `ticksRemaining * 40 / 3600`.
  - `done` when productM3 ≥ target;
  - `outOfReach` when productM3 + DESIGN_PRODUCT_M3H × hoursLeft < target;
  - `onPace` when productM3 + flowM3h × hoursLeft ≥ target;
  - otherwise `behind`.
- Radio queue:
  - `radioReducer(state, action)` with actions `{type:'push', eventId, kind, text}` and `{type:'expire'}` / `{type:'dismiss'}`;
  - one message is shown at a time and later ones queue;
  - a message shows for 6 s;
  - de-duplicate by eventId.
- Which monitor a kind opens:
  - Intake: pumpTrip, powerDip, storm, bloom, seawaterTemp, pumpBearing;
  - Product: tubeLeak;
  - Flash stages: vacuumLoss;
  - the faulted loop's monitor: sensorFailure, controllerFault (tbt → Heater, intakeFlow → Intake, recirc/blowdown/vacuum → Stages);
  - Fuel: gas and delivery kinds;
  - Shift: demandChange.

  `sensorFailure`'s radio line must not name the faulted loop, so it opens the Shift monitor.
- QuotaBar shows:
  - a progress bar;
  - `shiftProductM3 / target m³`;
  - the pace label (`ON PACE`, `BEHIND`, `OUT OF REACH`, `TARGET MET`) with tones ok/warn/bad/ok;
  - time left;
  - the balance;
  - `+N m³ off-spec, not counted` when `shiftOffSpecM3 > 0`;
  - the crew job with minutes left when `crew` is set.

  It renders nothing unless `phase === 'running' || phase === 'paused'`.

- [ ] **Step 1: Failing tests:**
  - `paceState` cases: done; onPace; behind; outOfReach; `ticksRemaining 0` with product < target → `outOfReach` (no NaN); `targetM3 0` → `done` (Review Focus 5).
  - The radio reducer queues three pushes and shows one at a time, ignores a duplicate eventId, and moves to the next on expire.
  - QuotaBar renders "BEHIND" for a behind fixture, shows an off-spec note when `shiftOffSpecM3 = 120`, and renders nothing in handover.
- [ ] **Step 2:** Run `pnpm --filter @desal/web test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Push radio messages from `scenario` events in the store's event handling, using `radio`. Only push events newer than the session's start, so a resume doesn't replay them.
- [ ] **Step 4:** Run the web tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): quota bar and radio pop-ups`.

### Task 10: Web — crew controls, shift-log handover, debrief events

**Files:**
- Modify: `apps/web/src/expanded/ProductView.tsx` (Plug tubes), `apps/web/src/expanded/StagesView.tsx` (Repair ejector), `apps/web/src/expanded/IntakeView.tsx` (Clean screens), `apps/web/src/expanded/ShiftView.tsx` (Replace instrument, with the crew status), `apps/web/src/commands.ts` (`dispatchCrew` pending key `dispatchCrew`), `apps/web/src/screens/Handover.tsx` (orders + briefing), `apps/web/src/expanded/eventText.ts` (`eventCleared`, new kinds), `apps/web/src/screens/GameOver.tsx` / the handover summary (event list)
- Test: the existing tests beside each file

**Behaviour:**
- **Crew buttons** use `ActionButton` with the job's cost and duration in the label ("Send crew: plug tubes — $3,000, 60 min").
  - They're always enabled while running. The simulator's rejection reason shows through the existing pending/rejection UI. **Don't hide buttons based on fault state**: the player must diagnose the fault, and sensor faults aren't in status.
  - They're disabled while `status.crew` is set, with "Crew busy: <job>".
- **Handover:**
  - shows `status.orders`: target, salinity limit, budget, the `lines` as a bulleted "Supervisor's notes" list, and the `briefing` on shift 1;
  - falls back to `nextTargetEstimateM3` only when `orders` is null.
- **The last shift's summary** lists each event: "02:10 Pump trip — cleared by you", "05:40 Tube leak — fixed by crew", "Gas price spike — noted", "Vacuum loss — not cleared". It adds a "HELL SHIFT" tag when `summary.hell`.

- [ ] **Step 1: Failing tests:**
  - ProductView sends `{type:'dispatchCrew', job:'plugTubes'}` on click.
  - The buttons are disabled when the status has `crew` set.
  - Handover renders 3 briefing lines and a supervisor note from a fixture.
  - The summary renders "HELL SHIFT" and "fixed by crew" for a fixture.
  - `eventText` for `eventCleared` returns a sentence containing the kind's label.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @desal/web test && pnpm --filter @desal/web typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): crew controls, shift orders handover, event debrief`.

### Task 11: Visual polish — wall, monitors, animation

**Files:**
- Modify: `apps/web/src/wall/wall.css`, `apps/web/src/wall/Monitor.tsx`, `apps/web/src/wall/AlarmStrip.tsx`, `apps/web/src/screens/room.css`, `apps/web/src/equipment/*` (SVG animation hooks)
- Create: `apps/web/src/ui/motion.css` (keyframes and the reduced-motion override)
- Test: the existing equipment/wall tests, plus new assertions below

**Behaviour** (spec §4.11):
- **Layout.** The wall grid fills the viewport height below the top bar and quota bar (`grid-template-rows: repeat(2, 1fr)`; monitors `min-height: 0`), and the SVGs scale with `viewBox` and `preserveAspectRatio="xMidYMid meet"`.
- **Monitor look.** Monitors get a bezel with an inset glow and a scanline overlay (`::after` repeating-linear-gradient at ≤ 4 % opacity), plus a status LED that pulses for that monitor's worst alarm.
- **Flow animation.** Pipes use `stroke-dasharray` with an animated `stroke-dashoffset`. Duration is derived from flow via a CSS variable `--flow-speed`; a zero flow sets `animation-play-state: paused`.
- **Equipment animation:**
  - running pump rotors rotate;
  - the flame scales with `firingPct` and flickers;
  - the sea surface path translates;
  - stage levels get a 1–2 px wobble.
- **Tripped units.** When a unit is tripped or offline, its monitor gets `data-down="true"`, which pauses the animations and dims it to 60 %.
- **New alarms.** The alarm strip flashes once on a new alarm id. Unacknowledged high alarms pulse the monitor frame until that monitor is opened (track "seen" in the store per alarm id).
- **Reduced motion.** `@media (prefers-reduced-motion: reduce)` sets `animation: none` on everything in motion.css.

- [ ] **Step 1: Failing tests:**
  - A pump drawing with `running=true` has class `is-running`; with false, it doesn't.
  - A pipe with `flow=0` has `data-flowing="false"`.
  - A Monitor with a high unseen alarm has `data-alert="high"`; after `onOpen`, the alarm is marked seen and the attribute is gone.
  - Monitor gets `data-down="true"` when status is `tripped`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the web tests and `pnpm --filter @desal/web build`. Expected: PASS. Then take Playwright screenshots of the local dev build (`pnpm --filter @desal/web dev`, demo mode at `/?demo`) at 1440×900 and 390×844. Check that the wall fills the screen, nothing overflows horizontally, and text is readable.
- [ ] **Step 5:** Commit `feat(web): living control-room wall`.

### Task 12: Visual polish — start, handover, game over, typography

**Files:**
- Modify: `apps/web/index.html` (Google Fonts link for **Barlow Semi Condensed** 500/600/700), `apps/web/src/ui/*.css` (a `--font-display` token), `apps/web/src/screens/Start.tsx`, `apps/web/src/screens/Handover.tsx`, `apps/web/src/screens/GameOver.tsx`, `apps/web/src/screens/screens.css`
- Test: the existing screen tests (text/roles unchanged except the additions below)

**Behaviour:**
- **Headings, monitor titles, buttons and labels** use `--font-display`; numbers stay monospace.
- **Start screen:** the title "Desal Operator", a two-line pitch ("You run a thermal desalination plant. Deliver the water, shift after shift — until the money, the fuel or the plant gives out."), a small animated plant strip reusing the Intake → Heater → Stages → Product drawings at fixed demo values, and the Start button.
- **Handover:** a clipboard-sheet card (light paper tone in light mode and a dimmed paper tone in dark, ruled lines, a clip graphic at the top). It holds the orders, the last shift's debrief, the plant condition, the mode choice, and a large "Start shift N" button.
- **Game over:** the same card style as the "Final report", with the score figures large.
- **Layout** works at 390 px wide with no horizontal scroll.

- [ ] **Step 1: Failing tests:**
  - Start renders a heading "Desal Operator" and the Start button.
  - Handover's Start button has accessible name `Start shift 1` for a shift-1 fixture.
  - GameOver renders a heading "Final report".
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the web tests, the build and the e2e (`pnpm --filter @desal/web e2e`; update selectors only where the text changed). Take Playwright screenshots of all three screens at 1440×900 and 390×844 and check them. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): start, shift log and final report screens`.

### Task 13: Docs, full verification, deploy

**Files:**
- Modify:
  - `docs/streaming-notes.md`: the new `scenario` fields `eventId`/`radio`, `eventCleared`, shiftStart `hell`/`orders`, the summary `events`, and the account cause `crew`. These are the contract Plan 5's Flink jobs will read.
  - `README.md`: one paragraph on events, hell shifts and the crew.
  - `docs/hosting.md`: only if anything changed.

- [ ] **Step 1:** Update the docs.
- [ ] **Step 2:** Run `pnpm -r typecheck && pnpm -r test && pnpm --filter @desal/simulator test:int && pnpm --filter @desal/gateway test:int && pnpm --filter @desal/web e2e`. Expected: all PASS.
- [ ] **Step 3:** Commit `docs: chaos events contract for consumers`.
- [ ] **Step 4:** Deploy with `scripts/deploy/deploy.sh` (clean tree required). Old v2 snapshots on prod are skipped by design: in-flight games end, which is acceptable.
- [ ] **Step 5:** Check live at https://desal.moosha.org with Playwright:
  1. Start a run; the handover shows the orders and the briefing.
  2. Start shift 1; the quota bar is visible.
  3. Within 150 plant minutes (≤ 4 real minutes) a radio message appears and the matching monitor opens on click.
  4. Quit.

  Screenshot the wall and the handover for the report.
