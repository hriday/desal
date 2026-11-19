# Desal Operator: Chaos Director, Shift Orders and Quota Bar (Plan 4)

Status: draft for approval, 2026-11-19. Extends `2026-11-18-desal-operator-game-design.md` (the "main spec"); where this document and the main spec disagree, this one wins for the areas it covers. Flink moves to Plan 5.

## 1. Intent and why

After playing the live game, the user found it boring: "It's kind of boring if nothing happens." In the code, the cause is clear. Shift 1 has no events. Shift 2 has one slow algal bloom. Most events (price spikes, curtailment notices, demand changes) never show on the plant's dials. Auto mode absorbs the rest, so a player can watch a 12-minute shift go by without touching anything.

The user also could not see what they were meant to achieve: "I don't recall seeing the output water levels and the quota needs … the operator has to be instructed that they need to deliver this much water." The target exists, but it only appears on the handover screen and inside two zoomed monitors.

The user's definition of a good game, in their words:
- **A good shift** has "at least 1-2 events that are managed."
- **A shift from hell** has "several events that overwhelm an operator."

## 2. Goals, non-goals, anti-goals

**Goals**
- Every shift has at least one event the operator must act on. A normal shift has 1–2 events; shift 1 has exactly one gentle event as a teaching moment.
- Hell shifts happen sometimes and get more likely as the run goes on. They stack 4–6 events close together, some of which set each other off.
- Events are things that go *bang* as well as slow creep: trips, leaks, loss of vacuum, power dips, storms, failed sensors.
- The operator always knows what they must deliver, how they are doing against it, and what just happened.

**Non-goals**
- No Flink in this plan. Plan 5 adds Flink on the resized server and reads the events this plan produces.
- No new plant units (RO stays in Phase 2).
- No difficulty settings or tutorial mode.

**Anti-goals** (failure even if it technically works)
- An event that Auto quietly absorbs, so the player never notices it. Every event must need a player action, or at least a decision.
- A run ended by pure bad luck. No single event, and no hell shift on its own, may end the run without the player making mistakes. A hell shift may cause a trip or a missed target.
- Chaos that makes the game non-deterministic. Everything still comes from the game's seed, so tests and crash recovery replay exactly.
- Spam: radio messages or alarms so frequent that they stop meaning anything.

## 3. Approaches considered

- **A. Scripted chaos per shift.** At shift start the simulator draws a fixed list of events with fixed times. It's simple and testable, but blind to the player, so even a "good" shift can stack two events on someone still fighting the first.
- **B. Scripted chaos plus a director (chosen by the user, 2026-11-19).** The same draw decides *which* events a shift has. A small director decides *when* each one fires, based on how the plant is doing: in a normal shift it waits until the last event is under control; in a hell shift it stacks them on purpose. It delivers both feelings the user described instead of leaving them to chance.
- **C. Flink decides the chaos.** Flink watches the plant and sends events back. Rejected: the game would break whenever Flink is down, and the main spec deliberately never lets Flink drive the plant (§6, "Nothing flows from Flink back into the simulator").

## 4. Design

### 4.1 The shift draw

At shift start (the `startShift` command), the simulator draws the shift's **chaos plan** from the game's seed and the shift number:

- **Kind of shift.**
  - Shift 1: always normal, with exactly one gentle event.
  - From shift 2, hell chance = min(0.45, 0.10 + 0.04 × (n − 2)): about 1 in 10 at shift 2, about 1 in 6 at shift 4, capped at 45 %.
  - Two hell shifts in a row are not allowed; a shift after a hell shift is always normal.
- **Event count.**
  - Normal shift: 1 or 2, with 2 more likely as n grows.
  - Hell shift: 4 to 6.
- **Severity** scales with n, as `drawEvent` already does.
- **Which events** are drawn from the pool in §4.3. Shift 1's gentle event comes from a fixed short list (pump trip, sensor failure, or small storm), each mild.
- **Warning.** Each hell shift has a 70 % chance of being hinted at in the shift orders (§4.5). The user picked "sometimes warn".
- **Hell-shift fairness.** A hell shift's water target is cut by 15 %, so a good operator can still meet it.

Hand-written shifts 2 and 3 are replaced by the draw. Their content (bloom, gas notices) becomes part of the pool. Shift targets still follow `shiftTargetM3(n)`, except for the hell-shift cut.

### 4.2 The director

The director runs every tick during a running shift. It holds the shift's queue of drawn events, each with an earliest plant minute.

- **Normal shift:**
  - The first event fires at a random point between plant minute 30 and 150 of the 8-hour shift.
  - Each later event waits until the plant is **settled** and at least 60 plant minutes have passed since the last one.
  - **Settled** means:
    - the previous event's own condition has cleared (e.g. the tripped pump is running again or replaced, or the leak is plugged);
    - no plant trip is in progress;
    - product salinity is in spec.
  - If the plant never settles, a later event still fires after 180 plant minutes, so a struggling player isn't spared forever.
  - Any event still unfired with 60 plant minutes left is dropped. Shifts don't end with a surprise the player can't respond to.
- **Hell shift:**
  - Events fire in a burst. The first comes between plant minutes 30 and 120, and each later one comes 10–40 plant minutes after the previous one, regardless of whether the plant has settled.
  - Cascades (§4.4) can add events beyond the drawn count. The total is capped at 7.
- **Determinism.** All timing comes from the seeded RNG and the plant state, so replays and crash recovery stay exact. The director's queue and RNG position are part of `PlantState` and the snapshot. That means a snapshot schema bump, v3; v2 saves are skipped as before.

### 4.3 Event catalogue

Existing kinds stay (bloom, seawaterTemp, pumpBearing, gasCurtailNotice, gasPriceSpike, offgradeOnly, deliveryDelay, demandChange, controllerFault). New **sharp** kinds are added. Each one has a visible symptom, a required response, and a "cleared" condition the director uses. Exact magnitudes are left to the builder as named constants, tuned so each event is survivable with a correct response.

| Kind | What happens | Player response | Cleared when |
|---|---|---|---|
| `pumpTrip` | A running intake pump stops suddenly (motor or bearing), and its wear jumps. Intake flow drops by about half. **Auto does not start the standby.** | Start the standby pump; consider an overhaul. | Two intake pumps are running. |
| `tubeLeak` | A tube leak in one stage's condenser. Product salinity steps up and keeps growing slowly. | Divert to drain if off spec, and send the crew to plug tubes (§4.6). The stage then runs at reduced output for the rest of the shift. | Crew job done. |
| `vacuumLoss` | The vent ejector fails, and vacuum quality falls steadily. The Auto vacuum loop saturates. A `lossOfVacuum` trip follows in about 20–30 plant minutes if nothing is done. | Cut load (lower TBT or firing) to slow the fall, and send the crew to repair the ejector. | Crew job done. |
| `powerDip` | A grid sag. One duty intake pump trips (as in `pumpTrip`, without the extra wear), and the recirculation pump runs at reduced capacity for about 30 plant minutes. | Restart the pump and ride out the reduced recirculation. | The pump is restarted and the dip is over. |
| `storm` | Intake screens foul fast, seawater cools 1–3 °C, and the intake is churned up. | Run screen wash / intake checks via crew, adjust intake. | Crew job `cleanScreens` done, or the storm passes after about 90 plant minutes (fouling stays until cleaned). |
| `sensorFailure` | One instrument freezes at its last value or reads noise. If it feeds a loop, that loop in Auto starts doing the wrong thing. **No alarm says "sensor failed".** The player must spot the disagreement. | Put the affected loop in Manual and send the crew to replace the instrument. | Crew job done. |

Existing slow events still count toward a shift's event count. A shift's draw always includes at least one sharp event, so every shift has something that goes bang.

**Existing `controllerFault`:** it stays. It's resolved by Manual mode as today, and it counts as cleared once the loop is in Manual.

### 4.4 Cascades

Cascades happen in hell shifts only. When a trigger event fires, the director may add a follow-up to the queue:
- `storm` → `bloom` 60–120 plant minutes later (p 0.6).
- `powerDip` → `sensorFailure` on a random instrument (p 0.4).
- `tubeLeak` → off-spec water. This isn't a new event; it follows from the physics.
- `pumpTrip` → `pumpBearing` on the standby pump once it's started (p 0.4).

Total events in a shift are capped at 7.

### 4.5 Shift orders

Every shift starts with **orders**: a short note from the shift supervisor. It replaces today's bare target line on the handover screen.

- Content:
  - the water target (m³, salinity limit);
  - the budget for the shift;
  - one or two lines on known conditions (e.g. gas supply, seawater, equipment condition carried over from damage);
  - on a warned hell shift, a hint drawn from the shift's actual events ("storm forecast after midday", "grid is unstable today", "P-102 is running rough").
- Hints are true but vague. Never list every event. Unwarned hell shifts read like normal ones.
- **Shift 1's orders** add a three-line briefing on the job: deliver the water, keep salt under the limit, watch the budget; click a monitor to act.
- The simulator writes the orders. They're carried on the `shiftStart` event (and a new `orders` field on handover status), so the gateway and UI just display them. Text is assembled from templates, not free-form.

### 4.6 Maintenance crew (new command)

Several new events need a repair that isn't a pump overhaul or acid clean. There's one new command, `dispatchCrew { job }`. Jobs:

| Job | Cost | Duration (plant minutes) |
|---|---|---|
| `plugTubes` | $3,000 | 60 |
| `repairEjector` | $4,000 | 45 |
| `replaceSensor` | $1,500 | 30 |
| `cleanScreens` | $1,000 | 30 |

- One crew: only one job at a time, and a second dispatch is rejected with a clear reason.
- A job is only accepted when its fault exists. It's charged to the account like other spending (a new account cause, `crew`).
- These numbers are starting values to tune.
- The crew is offered from the relevant zoomed monitor (Shift/Overview monitor for sensors).

### 4.7 Quota bar

A strip across the top of the control room, always visible, above or merged into the existing top bar:

```
WATER  ████████░░░░░░░░  1,840 / 4,370 m³   ON PACE ▲   3h 10m left   $6,240   ⚠ CREW: plugging tubes (25 min)
```

- **Progress** is in-spec water this shift against the target.
- **Pace** is shown in three states:
  - green "on pace" when the current rate × time left would meet the target;
  - amber "behind" when it wouldn't;
  - red "target out of reach" when even the plant's maximum rate can't make it.
- **Off-spec water** is shown separately when there's any ("+120 m³ off-spec, not counted").
- **Crew status** shows while a job runs.
- Pace is computed in the browser from status. It needs the in-spec total so far, the target, the time left, and the current product flow, all already in status or added there.

### 4.8 Radio messages

When an event fires, a **radio message** pops up over the wall for about 6 seconds:

> **FIELD → CONTROL:** "P-101 just tripped, she's coasting down!"

- It's in the plant's voice, not a log line.
- Clicking it opens the relevant monitor.
- Messages queue rather than overlap, and at most one shows at a time.
- They also go into the existing event log as today.
- Message text comes from the simulator's event (a new `radio` string alongside the existing `message`), so wording stays in one place.

### 4.9 Debrief

The existing shift-end summary gains a list of the shift's events, each with its time and whether the player cleared it, plus "hell shift" when it was one. Plan 5's Flink debrief builds on this; this plan only needs the simulator's summary.

### 4.10 Clarifications (from the builder check)

- **Shift clock.** A shift is 720 ticks × 40 s = 480 plant minutes (8 plant hours, 12 real minutes). All "plant minute" times in this document are minutes from the shift start on that clock. Today's procedural draw uses 0–360 minutes; the director replaces it.
- **Pumps.** There are three intake pumps. P-101 and P-102 are duty, and P-103 is standby; two must run for full flow. **My call:** `pumpTrip` and `powerDip` pick only a running pump, and only when another pump is available to start (not running and not under overhaul). Otherwise the draw substitutes a different event, so a trip is always recoverable. The "cleared" condition is "two intake pumps running".
- **The crew is a deliberate squeeze in hell shifts.** This is my call, from the user's "several events that overwhelm an operator". The single crew can't fix everything at once. Every crew-fixed event therefore has a stopgap that needs no crew:
  - leak: divert to drain and/or reduce load;
  - vacuum: cut load;
  - sensor: put the loop in Manual;
  - storm: raise the intake pump speed.

  Choosing what to fix first is the hell shift's puzzle. Crew time runs in plant time and pauses with the game.
- **Tube-leak derate.** After plugging, the affected stage (drawn at random) gives reduced distillate for the rest of the shift. It's restored at the next shift start (the tubes are properly repaired between shifts). It's held as a per-stage field in `PlantState`.
- **Sensor model (my call: a small fault-override layer, not a full measured-vs-true model).**
  - `PlantState` gains `sensorFaults: Record<sensorId, { kind: 'freeze' | 'noise', frozenValue?, … }>`.
  - Telemetry applies it to the emitted reading.
  - The loop whose process value comes from that sensor (TBT, intake flow, recirculation flow, blowdown/concentration, vacuum) reads the faulted value.
  - `sensorFailure` only draws from those loop-feeding sensors, so the failure matters.
- **Random hourly events are removed.** Today's random gas price spikes and controller faults are retired. Every event goes through the draw and the director and counts toward the cap of 7.
- **"Cleared" for the slow kinds:**
  - `controllerFault`: cleared when that loop is in Manual (or at shift end).
  - `bloom`: cleared when chlorophyll is back under the alarm level, or when chlorine dosing has been raised at least once since it fired.
  - `seawaterTemp`, `gasCurtailNotice`, `gasPriceSpike`, `offgradeOnly`, `deliveryDelay`, `demandChange`, `pumpBearing`: informational. They count as cleared as soon as they fire, so they never hold up the director. The debrief lists them as "noted".
  - Because these slow kinds clear instantly, the rule in §4.3 (at least one sharp event per shift) is what guarantees action.
- **The gentle shift-1 event follows the same rules.** Auto does not start the standby on shift 1 either; that's the lesson. Its magnitude is mild (a storm with light fouling, a sensor that freezes rather than goes noisy).
- **Quota-bar data.**
  - Status gains `shiftProductM3` and `shiftOffSpecM3` (from `shift.acc`), `productFlowM3h`, `crew: { job, remainingTicks } | null`, and `orders` (handover only).
  - It already has `shiftTarget` and `shiftTicksRemaining`.
  - The maximum rate for "out of reach" is a constant: the plant's design product flow.

### 4.11 Visual polish

The user asked to "make the overall game a little more pretty" (2026-11-19). In the live game (1440×900):
- The wall uses only the top two-thirds of the screen.
- Nothing moves except numbers.
- The handover and start screens are plain forms.
- There is no sense of place.

These are my calls, keeping the approved flat-schematic monitor style (main spec §4) and its colours:
- **Fill the room.** The wall's 3×2 grid stretches to the viewport height, and the drawings scale with their monitors.
- **Monitors look like monitors.** Each gets a thin bezel with a slight inner glow and a faint scanline texture, and a status LED that pulses amber/red with that monitor's worst alarm. The texture is subtle and must not reduce text contrast.
- **Things move:**
  - pipes show flow as moving dashes, with speed proportional to flow and stopped when there's none;
  - running pump rotors spin;
  - the burner flame flickers with its size following the firing rate;
  - the intake sea surface ripples;
  - flash stage levels wobble slightly;
  - a tripped unit's drawing goes still and dims.

  All of this is CSS/SVG animation driven by the existing props. Under `prefers-reduced-motion` it is turned off.
- **Alarms feel urgent.** On a new alarm the alarm strip flashes once and the monitor frame pulses. Unacknowledged high alarms keep pulsing until the monitor is opened. There's no sound in this plan.
- **Handover becomes a shift log.** A card styled like a paper clipboard sheet holds:
  - the shift orders (§4.5);
  - the plant condition (as today);
  - the mode choice;
  - a large Start button.
- **Start screen.** It gets a title, a small animated plant illustration reusing the equipment drawings, a two-line pitch, and the Start button.
- **Game over.** It's shown as a final report card in the same style as the shift log.
- **Typography.** One display face for headings and labels (a technical sans from Google Fonts, e.g. Rajdhani or Barlow Semi Condensed), with numbers kept in the monospace.
- **Tests.** Existing component tests keep passing. There are no pixel tests; I check the result visually on the live site.

### 4.12 Operating temperature (user input, 2026-11-19)

"at 108C the scaling is very high. It is better to be at 93-94C".
- The plant's nominal top brine temperature becomes 93.5 °C, and it is recalibrated so the shift targets are met at 93–94 °C.
- Scaling is low at ≤ 95 °C, rises above 100 °C and is severe above 105 °C. Above 105 °C, hard CaSO4 scale deposits directly, so it cannot be ball-cleaned away.
- Running hotter still makes more water, so pushing TBT up is a real trade-off for catching up on quota, paid for in scale.
- The TBT setpoint range is 85–112 °C, and the high-high trip moves from 118 to 115 °C.
- An untouched game should end on its own within about 40 shifts (Ruling R12b; with real chaos events it had stretched to 66).

## 5. Constraints

- **The simulator stays deterministic and pure.** The director, draw, crew and new events live in `tick()` and the seeded RNG. Interlocks still act immediately.
- **Kafka contracts:**
  - New event kinds and the new command extend the schema package.
  - `ScenarioKind` gains the new kinds, `AccountCause` gains `crew`, and the new `dispatchCrew` command is added.
  - The ordering and seq/epoch rules in `docs/streaming-notes.md` are unchanged.
  - The new `PlantEvent` fields (`radio`, director "cleared" events) are documented there for Plan 5.
- **Every new event emits a `scenario` event when it fires** and a new `eventCleared` event when its cleared condition is met. Plan 5's Flink jobs and the debrief rely on that pair.
- **Snapshot v3.**
- **The existing 10-game cap and server memory are unchanged.** This plan adds no services.
- **Tests:**
  - Unit tests for the draw (hell frequency over many seeds, no back-to-back hells, shift 1 always one gentle event) and the director (normal shifts wait for settled; hell shifts burst; nothing fires in the last 60 minutes).
  - Unit tests for each new event's physics and its cleared condition, and for the crew command.
  - UI component tests for the quota bar states and the radio queue.
  - The e2e test still plays a shift.

## 6. Left to the builder

- Exact magnitudes for each new event, tuned so the correct response saves the shift and doing nothing costs water or causes a trip.
- How sensor noise and freeze look.
- Which instrument feeds which loop. The loops already have process values.
- Template wording for orders and radio lines, within the tone in §4.5 and §4.8.
- Visual design of the quota bar and radio pop-up, matching the existing wall styles in `apps/web/src/wall/wall.css` and `screens/room.css`.
- Whether the quota bar replaces or sits above `TopBar`.

## 7. My calls (to check)

- The hell chance formula and its 45 % cap; never two hells in a row; 70 % warned; −15 % target on hell shifts.
- Normal-shift timing: first event at plant minutes 30–150, 60 minutes minimum spacing, 180-minute override, nothing in the last 60.
- Hand-written shifts 2 and 3 replaced by the draw.
- Auto never starts the standby pump.
- A single maintenance crew; the job costs and durations above.
- Sensor failures give no alarm.
- Radio pop-ups last 6 seconds, one at a time, and are clickable.
