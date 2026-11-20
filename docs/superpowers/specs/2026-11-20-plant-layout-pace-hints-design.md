# Plan 7 design: 24-stage plant, game pace, and operator hints

Status: draft for approval, 2026-11-20. Extends the main spec (`2026-11-18-desal-operator-game-design.md`), Plan 4 (`2026-11-19-chaos-director-design.md`) and Plan 6 (`2026-11-20-hard-mode-disasters-design.md`). Plan 7 is built **before** Plan 5; §6 lists what Plan 5 must change.

## 1. Intent and why

The user asked for three things during Plan 5 setup, quoted:

- "I want it to be 24 stages and the sea water feed to be a top up for the final stages and the feedback ot the 21st stage etc." The plant should look like a real brine-recirculation MSF plant, not a single generic cascade.
- "I think time can move faster, until an event when we can slow down time a bit". A calm plant is boring at 12 real minutes per shift.
- "at the end of a bad shift there should be some report on what should have been done. Or maybe even during the shift when things happen, some hint on what the operator needs to do." New players don't know the fixes.

The user agreed ("ok") to my playback of the layout and of the pace proposal (3× when calm, today's speed during events, a ▶▶ indicator).

**Goals:** a recognisable MSF layout (21 heat-recovery stages, 3 heat-rejection stages, seawater makeup, brine recycle into stage 21's tubes), with one new control (makeup) that matters; shifts that pass quickly when nothing is happening; players who are told what to do when they are stuck.

**Non-goals:** a detailed per-stage thermodynamic model; a player-controlled speed knob; hints on Hard.

**Anti-goals:** a balance change. Nominal production, the Normal/Hard survival medians and the shift-1 passive results from Plan 6 must hold. A plant that plays the same as today but looks different is acceptable; a plant whose numbers silently shift is not.

## 2. The 24-stage layout

### 2.1 What the plant is

- `STAGE_COUNT` = 24. `RECOVERY_STAGES` = 21 (stages 1–21), `REJECT_STAGES` = 3 (stages 22–24).
- **Seawater path:** the intake pumps' flow (cooling water) runs through the tubes of stages 24 → 22, then splits: **makeup** goes into the stage-24 brine pool; the rest is **cooling water reject**, returned to sea. Makeup can never exceed intake flow.
- **Brine recycle path:** the recirculation pump draws brine from the stage-24 pool and sends it into the tubes of **stage 21**; it runs through the tubes of stages 21 → 1, picking up heat, to the brine heater; then it flashes down through stages 1 → 24.
- **Blowdown** is drawn from the stage-24 pool, as today.

### 2.2 Physics changes (simulator)

Keep the model lumped; change only what the layout makes true.

1. **Temperature cascade:** unchanged formula, over 24 stages (equal flash range per stage from TBT to the bottom temperature). Total distillate is `Σ massKgS·cp·ΔT/L·eff·derate` and stays independent of the stage count, so nominal production is unchanged.
2. **Heat recovery** (`recoveredTempC`) uses the mean effectiveness of **stages 1–21 only** (the recycle tubes). Scale in the reject stages no longer reduces heat recovery.
3. **Bottom temperature** (`bottomTempC`): the existing approach is divided by the mean effectiveness of **stages 22–24** (their tubes carry the cooling seawater). Clean tubes give today's value exactly.
4. **Concentration factor:** at steady state salt in equals salt out, so the CF target becomes `(D + B) / B`, where D is the **previous tick's raw distillate** (m³/h, before status gating) and B is blowdown (m³/h), clamped to [CF_MIN, CF_MAX], lagged with CF_TAU_S as today. The blowdown loop still steers CF. Check the nominal: the CF must come out close to today's nominal at nominal blowdown output; if it does not, retune `BLOWDOWN_MAX_M3H` (a named constant change, recorded) rather than the formula. **(my call)** While the plant is not online (tripped, restarting, acid cleaning), the CF target is frozen at its last online value, so trips do not swing the chemistry and move the Hard balance. The higher-TBT → higher-CF coupling while online is accepted; the blowdown loop's auto mode chases it.
5. **Makeup and the stage-24 pool:** new constant `MAKEUP_MAX_M3H` and a lagged actual flow `brine.makeupM3h` (like recirc). The stage-24 level changes with `makeup − distillate − blowdown` (inventory balance), scaled by a named constant so a full makeup failure empties the pool in about 30 plant minutes from nominal. Stages 1–23 keep today's level model (inflow vs interstage valve).
6. **Pool too low:** below `RECIRC_SUCTION_MIN_M`, the recirc pump's deliverable maximum falls linearly to zero at level 0 (it is losing suction). Production falls with it. **Pool too high:** the same carryover and stage-flood interlock as any stage.
7. **Makeup ≤ intake flow.** **(my call)** In practice only a near-total loss of intake reaches this limit (one pump alone still out-delivers nominal makeup), and that already trips `noIntakeFlow`. No extra mechanism ties a single pump trip to makeup: it would be a balance change.

### 2.3 Controls

- New loop `loops.makeup` (auto/manual, like the others), setpoint = nominal stage-24 level, PV = stage-24 level, output = makeup valve %. Gains in `LOOP_GAINS`, tuned so the auto loop holds the pool through a normal shift and through the existing events.
- `loops.levels` holds **23** loops (interstage valves 1→2 … 23→24). Stage 24 has no interstage valve; its level is the makeup loop's job.
- The new loop takes part in everything loops already do: manual mode, setpoint commands, `sensorFailure` (which may now pick the makeup PV), snapshot, status, telemetry.
- Initial state is balanced: at nominal, makeup output is set so makeup = D + B and the pool holds level.

### 2.4 Everything indexed by stage

`stageDerate`, tube-leak stage, scale arrays, sensors (`stages.s01` … `stages.s24`), and any random stage pick use `STAGE_COUNT` (24).

**(my call) Faults keep their share of the plant, not their stage count**, so each hurts as much as today:
- `TRIP_SCALE_STAGES` 5 → 6 (a quarter of the stages, as 5 of 20 was), applied to the hottest stages in interlocks and restart ramp damage alike;
- `TUBE_PLUG_DERATE` is rescaled so plugging one stage costs the same fraction of total distillate as today (one stage of 24 now carries 20/24 of what one of 20 did);
- tube leaks land only in **recovery stages 1–21**, where they matter as today (the reject section's tubes carry seawater, so a leak there would be nearly harmless and confusing).
Each changed constant is named in the plan with its old and new value.

### 2.5 Snapshot v5

`VERSION` = 5. `restore` accepts v3, v4 and v5 (v3 → v4 → v5). The v4 → v5 migration:

- stages resampled 20 → 24: new stage `j` copies old stage `floor(j·20/24)` (temperatures are recomputed on the next tick);
- `stageDerate` resampled the same way; `tubeLeak.stage` mapped to the new index of the same relative position;
- level loops: old loops 0–19 kept, three more cloned from the last; then truncated to 23;
- `loops.makeup` added in auto at the balanced output; `brine.makeupM3h` set to the balanced flow;
- the CF freeze value (§2.2.4) set to the snapshot's CF.

Pace (§3) has no persistent state, so there is nothing to migrate for it.

### 2.6 Web

- `plantConstants.ts` mirrors `STAGE_COUNT` 24 and the new constants it needs.
- The stages view shows two labelled groups, "Heat recovery 1–21" and "Heat rejection 22–24", with the flow drawn as in §2.1: seawater in → reject tubes → makeup / reject to sea; recycle pump from stage 24 → stage 21 tubes → … → stage 1 → heater. Makeup flow and cooling-water reject flow are shown in m³/h.
- The makeup loop gets the same control panel as the other loops. The stage-24 level is labelled "brine pool".
- The wall monitor and any 20-stage layout adapt to 24.

## 3. Game pace

- **Calm** plants run at `FAST_PACE` = 3 ticks per real second (a shift in about 4 real minutes). **Busy** plants run at today's 1 tick per second.
- A plant is **busy** while any fired scenario event is not cleared, or while the plant is tripped or restarting. Otherwise it is calm, **acid cleaning included** (2 plant hours of waiting pass in about a minute). Pace is the same in Normal and Hard. The test is a pure function of state (`isBusy(state)`) with no stored pace field and no hold time: the moment the last busy condition ends, the game is back at 3×. Determinism is unaffected, because pace changes only how often wall-clock time triggers `tick()`, never what a tick does.
- The runner steps every `1000 / FAST_PACE` ms. The host gives each game a wall-clock due time and ticks it only when due (every step when calm, every third step when busy). Commands are applied on the game's next tick, as today (at most 1 s of latency).
- Handover, paused and over phases are unchanged.
- `PlantStatus` gains `pace: 'calm' | 'busy'` (default 'calm'). The top bar shows **▶▶** when calm and **▶** when busy.
- Idle timeouts, heartbeats and liveness stay wall-clock and unchanged. Snapshots stay "every N ticks", so a calm game snapshots three times as often; that is fine.
- **Accepted trade-off:** the slowdown itself tells the player that something has happened, even for events meant to be found through alarms. Accepted: the user asked for it, and the radio already announces most events.

## 4. Hints during the shift

- Browser-only. Each scenario kind gets one imperative "what to do" line in a single table, `FIX` in `apps/web/src/expanded/labels.ts`, covering every kind, the disasters' children included (for example, "Start the standby intake pump", "Switch fuel, then send the crew to flush the contaminated tank", "Run the screen-cleaning job after the surge, and keep at least two intake pumps running").
- **Normal:** when a fired event is still not cleared `HINT_DELAY_MIN` = **20 plant minutes** after it fired (30 real seconds at busy pace; 5 plant minutes would be under 8 real seconds), and its fix is **not already under way**, the radio shows `Hint: <fix text>`, once per event. **Hard:** no hints (my call; the Hard start line already promises a harsh plant).
- **"Under way"** is a per-kind check in the same table as the text (entries carry `text` and an optional `underway(status)`): for kinds fixed by a crew job, that job is running; for kinds fixed by an action whose result shows in status (a standby pump started, a fuel changeover in progress), that state is present. Kinds with no such check always get the hint at the delay. Events that clear only with time (for example a tsunami surge still running) are hinted with what to do once it passes.
- Informational and noted kinds get no hint.
- **Start screen (user-approved, 2026-11-20):** the "When disaster strikes" list is removed; its three fixes become the `FIX` texts of `fuelContamination`, `earthquake` (shown at the handover only, since earthquake is noted) and `tsunami`. The line under "Start a Hard run" stays. The start screen's plant picture shows 24 stages (heat recovery and heat rejection), not 20.

## 5. End-of-shift "what to do"

- The handover's "Last shift" list (Plan 4's debrief) adds a "What to do: <fix text>" line under every event that was **not cleared by shift end**. This is in both modes: the shift is over, so it's teaching, not help.
- Plan 5's report card will extend this to "slow" verdicts (§6).

## 6. Impact on Plan 5

Plan 5 must be amended before it runs:

- Its snapshot bump becomes **v6** (migrating v5; the chain v3 → v4 → v5 → v6 keeps working).
- Telemetry has 24 stage sensors and new makeup/pool sensors; nothing in Plan 5's jobs depends on the stage count, but fixtures listing sensors must match.
- The report card's event rows show the same `FIX` text under every **slow** or **missed** verdict, and the "Last shift" list no longer repeats it when a report card is present.
- `pace` is in `PlantStatus`; Plan 5 ignores it.

## 7. Testing

- Balance: nominal production after a calm shift within 1 % of today's; Plan 6's `hardmode.test.ts` results hold (passive Hard broken by shift 3 in 20/20; engaged Hard and Normal medians within one shift of 6 and 8.5; passive Normal alive after shift 1 at ≥ 0.95× target).
- Makeup: auto holds the pool through a shift; makeup in manual at 0 % empties the pool and starves the recirc pump (production falls); makeup never exceeds intake flow; CF holds through a trip.
- Faults: trip damage hits the 6 hottest stages; one plugged stage costs the same share of distillate as before; tube leaks land only in stages 1–21.
- CF follows `(D+B)/B`; reject-stage scale raises the bottom temperature; recovery-stage scale lowers recovered temperature.
- Snapshot: v3, v4 and v5 restore; v4 → v5 maps 20 stages to 24 and adds a balanced makeup loop.
- Pace: `isBusy` truth table; the host ticks a calm game every step and a busy game every third step; commands are not lost while a game waits for its tick.
- Web: hints appear once after 20 plant minutes on Normal, not while the fix is under way, and never on Hard; every scenario kind has a `FIX` entry (a test enumerates the kinds); the handover shows "What to do" for uncleared events; the stages view renders 24 stages in two groups.

## 8. Left to the builder

Exact gains, `MAKEUP_MAX_M3H`, the pool-balance scale and `RECIRC_SUCTION_MIN_M` (named constants, tuned to the stated behaviour); the stages-view drawing; the exact wording of each `FIX` text (imperative, one line, names the control or crew job by its on-screen label).
