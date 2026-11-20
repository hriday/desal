# Desal Operator: Hard Mode and Disasters (Plan 6)

Status: draft for approval. Comes **before** Plan 5 (Flink report card and leaderboard), which must then learn about modes (§7).

## 1. Intent and why

The user played a whole first shift on the live game and "nothing happened": one storm passed harmlessly and Auto beat the target untouched. They want a mode where "shit hits the fan a lot", with new disasters: "fuel gets contaminated, tsunami, earthquake whatever".

So this plan adds a player-chosen **Hard** mode and three **disasters**, and makes Normal's first shift less dull.

Success: a Hard shift is never quiet. A player who reacts well survives, and a passive player does not. Normal stays learnable.

## 2. Goals, non-goals, anti-goals

**Goals**
- Normal / Hard is chosen when the game starts and is fixed for the run.
- On Hard, every shift is a hell shift (4–6 overlapping events, cascades), plus a disaster every 2–3 shifts on average.
- Three new disasters: contaminated fuel, earthquake, tsunami. Each has a visible symptom, a response that works, and a way it gets worse if ignored.
- Disasters also appear on Normal, rarely and later, so both modes share one world.
- Normal's shift 1 gets a second event.
- Every record that ends a run says which mode it was, so Plan 5 can rank the two modes separately.

**Non-goals**
- More than two modes, or a difficulty slider.
- Changing mode mid-run.
- Other disasters (grid blackout, heatwave). They are easy to add later on the same pattern.
- Plan 5 itself (the leaderboard): this plan only makes the mode available to it.

**Anti-goals** (a failure even if it works)
- A disaster that ends the run by itself, with nothing the player could have done. A disaster only ends a run through the existing game-over paths (burner failed, no intake pumps, bankrupt, out of fuel), and only when the player neglects it.
- Hard being just "the same events, bigger numbers". The disasters are the point.
- Breaking determinism. A game with the same seed and the same commands must still replay identically.

## 3. Approaches considered

1. **Picked: extend the existing chaos director.** A difficulty profile (Normal / Hard) feeds the shift draw: hell-shift chance, disaster chance, and the gating that applies. The disasters become new `ScenarioKind`s that fire through the same queue, are cleared the same way, and appear in the same `scenario` / `eventCleared` events and debrief. They reuse existing faults where they can.
2. *Rejected: a separate disaster layer beside the director.* It would duplicate the firing, clearing and reporting logic, and Plan 5's report card would need to understand two event systems.
3. *Rejected: Hard as bigger numbers only.* It is cheap, but it isn't what the user asked for.

## 4. Design

### 4.1 Mode

- `startGame` gains `mode: 'normal' | 'hard'`, optional, defaulting to `'normal'` so old clients still work.
- `Run.mode` holds it. The snapshot schema carries it, and the snapshot version increments. Restoring an older snapshot gives `'normal'`.
- The mode is visible in:
  - `gameStart` (new field `mode`);
  - `gameEnd` (new field `mode`, which Plan 5 needs);
  - `PlantStatus` (`run.mode` or similar; the builder's call where);
  - the debrief.
- Difficulty profiles live in one place, as a `DifficultyProfile` per mode.

| Knob | Normal | Hard |
|---|---|---|
| Hell shift | As today: from shift 2, `hellChance(n)`, never two in a row | Every shift, shift 1 included (two in a row is allowed) |
| Hell warned in orders | As today (p 0.7) | As today |
| Disaster chance per shift | From shift 3: 0.08 | From shift 2: 0.4 |
| Disaster two shifts running | Never | Never |
| Shift 1 events | One gentle sharp event plus a second (§4.6) | Hell rules, shift-1 gentle pool **not** used |
| Water target | As today (hell factor 0.85 on hell shifts) | As today |

The numbers are starting values, named constants in one place, to tune in the balance pass (§4.8).

### 4.2 Disasters in the draw

- A disaster is drawn **in addition to** the shift's other events, at most one per shift.
- It is queued with `earliestMinute` drawn from plant minutes 90–300, so it lands in the middle of the shift rather than at the start or near the end.
- Pick weights between the three are equal, subject to viability:
  - **contaminated fuel** needs a fuel that can be switched away from;
  - **tsunami** needs at least one usable intake pump.
- Earthquake is always viable.
- `MAX_EVENTS` (7) caps the shift's other events only. A disaster and its consequences don't count toward it (§4.9.3).
- The orders sheet does **not** warn of disasters. The tsunami gives its own warning on the radio.

### 4.3 Contaminated fuel (`fuelContamination`)

**What happens.** The fuel the burner is on gets contaminated: water and sediment in the backup tank, or liquids carried over in the gas line. Until the player acts:
- the burner delivers less heat (the delivered MW is cut by a factor, about 0.7), so TBT sags and product falls;
- burner wear runs at a large multiplier (about 40× gas wear). Ignored, this takes a healthy burner to failure within about 2–3 plant hours. That ends the game through the existing `burnerFailed` path;
- each tick there is a small chance of a `flameOut` trip, through the existing flame-out trip path.

**Response.** Switch to the other fuel. The existing changeover stops the damage once it completes. Then send the crew on a new job, **`flushFuel`**, which clears the contamination from the affected fuel so it can be used again. Switching back to the contaminated fuel before the flush restarts the damage.

**Cleared when.** The flush is done (`how: 'crew'`). Switching away without flushing stops the damage but does not clear the event.

**Viability.** On gas, the alternative is backup, which needs fuel in the tank. On backup, the alternative is gas, which needs the cap above 0. If neither fuel can be switched to, the event is not drawn.

**Radio.** A fuel-lab call naming which fuel is contaminated.

### 4.4 Earthquake (`earthquake`)

**What happens.** There is no warning. The earthquake itself is noted (`how: 'noted'`), like an informational kind, and at once queues its consequences as ordinary child events (`cascade: true`), through the same mechanism as hell-shift cascades but with p = 1 and delay 0:
- a `powerDip`;
- one `tubeLeak`, or two on different stages (p 0.4 for two);
- two `sensorFailure`s on different instruments.

Then, with p 0.5, an **aftershock**: one more `powerDip` 20–60 plant minutes later.

**Response.** Respond to each child as you would to that event alone. The point is that it all happens at once, and the crew can only do one job at a time, so the player has to prioritise.

**Cleared.** Each child clears on its own condition. The earthquake shows as noted.

**Radio.** "Earthquake, everyone OK? Check your plant." The children's own radio lines follow.

**Edge.** Child kinds that are unviable are dropped, without substitutes (for example a power dip with no running pump).

### 4.5 Tsunami (`tsunami`)

**What happens: two phases.**
1. **Warning.** The event fires with a siren on the radio, saying the surge arrives in about 20 plant minutes (`warnMinutes`, drawn 15–25, shown in the message).
2. **Surge.** It lasts about 30 plant minutes. During it:
   - screen fouling jumps far beyond a storm's (debris);
   - every intake pump **running** during the surge takes heavy wear per tick. Running through the whole surge pushes a healthy pump's wear to 1, which makes it unusable;
   - seawater cools 1–2 °C.

   Pumps that are stopped take no damage.

**Response.**
- In the warning window, stop all but one intake pump. One pump (3,500 m³/h rated) is far above the `noIntakeFlow` trip line (20% of the required flow), so the plant keeps running on it at reduced output. The player sacrifices that one pump instead of two.
- Stopping every pump trips the plant (`noIntakeFlow`), with the usual trip damage and a long restart. That choice is legal, but it is the worse one.
- A full surge adds about 0.7 wear to each pump running through it. Two healthy pumps left running both come out badly worn. A pump that was already worn reaches 1 and becomes unusable. If every pump ends up unusable, the game ends through the existing `noIntakePumps` path.
- After the surge, send the crew to `cleanScreens`, then start the spare to get back to two pumps.

**Cleared when.** The surge is over, the crew's `cleanScreens` job has finished after the surge, and at least two intake pumps are running (`how: 'player'`). If the shift ends first, the event is not cleared.

**Edge.** Any surge left when the shift ends is dropped, the same as other per-shift faults (`noFaults()` at shift start).

### 4.6 Normal shift 1

Shift 1 on Normal draws **two** events from the gentle shift-1 pool (`SHIFT_ONE_KINDS`), different kinds, at least 90 plant minutes apart. Everything else about shift 1 stays: no hell, no disasters, no controller faults.

### 4.7 Web

**Start screen.** Two buttons: **Start (Normal)** and **Start (Hard)**. Hard's button carries one line: "Every shift is a bad one, and disasters strike." Hard is not the default.

```
  DESAL OPERATOR
  [ Start shift (Normal) ]   [ Start shift (Hard) ]
                              Every shift is a bad one, and disasters strike.
```

**In the game.**
- The top bar shows a small **HARD** tag on Hard runs.
- The game-over and debrief screens show the mode.
- `HOW_TEXT` gains a short Hard-mode paragraph and one line per disaster saying what saves you.
- The crew panel gains `flushFuel`.
- The tsunami's warning appears on the radio like any other line. A countdown to the surge in the radio or alarm strip is the builder's call; at minimum, the message states the minutes.

### 4.8 Balance test

Add a seeded headless test that runs a fixed set of seeds with **no player input** (Auto, `startShift` only) and checks:

| Scenario | What the test must show |
|---|---|
| Hard | Most passive runs end, or miss the target, by shift 3. |
| Normal | A passive run still meets shift 1's target. |
| Each disaster, forced into a shift | With a scripted correct response (switch and flush; dispatch the crew for each child; stop the pumps before the surge, then clean and restart), the run survives the shift. |
| Each disaster, forced into a shift, no response | Contaminated fuel ends the run (`burnerFailed`), or the tsunami ruins the pumps it hit. |

The tuning constants are adjusted until these hold.

### 4.9 Clarifications (from the builder check)

1. **Auto does nothing about disasters.** Auto only runs the control loops. It never switches fuel, starts pumps or sends the crew, and the spec's "Auto does not start the standby" still holds. "Passive" in the balance test means `startGame` and then `startShift` with mode auto each shift, and no other commands. Pass thresholds:
   - Hard: at least 70% of 20 fixed seeds end, or miss a shift's target, by the end of shift 3.
   - Normal: all 20 seeds meet shift 1's target.
2. **`flushFuel`** is a new crew job.

   | Property | Value |
   |---|---|
   | Cost | about $1,500 |
   | Duration | about 60 plant minutes |
   | Precondition | contamination exists, and the contaminated fuel is **not** the active one (or an active changeover away from it is in progress). Otherwise it is rejected, with a reason. |

   **Fuel margin.** The draw is viable only if the alternative fuel can carry the plant:
   - gas contaminated: the backup tank holds at least 2 plant hours at nominal burn;
   - backup contaminated: the gas cap is at least 70% of nominal burn.

   This is the guarantee behind the anti-goal.
3. **The cap and disasters.** A disaster and every event it causes (the earthquake's children and aftershock) do **not** count toward `MAX_EVENTS`. The cap of 7 applies to the shift's other events only, so no trimming is needed for the disaster. The earthquake's own `eventId` is a real event, noted at once.
4. **RNG substream.** The disaster roll and its params come from a separate stream seeded from `(state.seed ^ DISASTER_SALT ^ shiftNumber) >>> 0`. That is the same trick as Plan 5's call sign, and it does not consume `state.seed`. So Normal's draws for shifts 2+ are byte-identical to today's, except where a disaster is added on top. Hard's draws differ (forced hell), which is expected.
5. **Hard shift 1.** Hell rules apply in full: 4–6 events, cascades, the 0.85 target factor, and orders warned with p 0.7. The existing gate on controller faults (`CONTROLLER_FAULTS_FROM_SHIFT`) stays. No disaster can come on shift 1 (disasters start from shift 2). Hard is opt-in, so it may be rough on a newcomer.
6. **Snapshots.** All new state lives in fields that default when missing:
   - the contamination fault, the tsunami phase and timers (in `faults`);
   - `Run.mode` (defaults to `'normal'`);
   - the disaster-shift flag, so a disaster can't come two shifts running (in `chaos`).

   An older snapshot loads with those defaults. Its queues hold no new kinds, so no queue migration is needed.
7. **Gateway and resume.** `mode` is sent only on `startGame`. A reconnect or resume uses the gameId as today. The mode lives in the simulator's state and reaches the client in every status, so a resumed client always knows its mode.

## 5. Constraints

- **Determinism.** All randomness comes from the game seed through `nextRandom`. The disaster draw uses its own substream (§4.9.4), so Normal's draw for shifts 2+ is unchanged except for an added disaster. Shift 1's draw changes (§4.6), and existing seeded tests that pin shift 1 are updated, not worked around.
- **Schemas.** New kinds are added to `ScenarioKindSchema`. `flushFuel` is added to `CrewJobSchema`. `mode` is added to `startGame`, `gameStart`, `gameEnd`, status and the snapshot. Zod 4, as the rest of `@desal/schema`.
- **Snapshots.** The version increments, and older snapshots still load as Normal.
- **Gateway.**
  - The gateway passes `mode` through from the client's start request (validated).
  - It enforces nothing else. Its per-client limits stay as they are.
- **Copy.** Plain operator English, no jargon in radio lines. Metric units.
- **No new services, and no infra changes.**

## 6. Left to the builder

- Exact magnitudes (heat factor, wear rates, surge fouling, flame-out chance, crew job durations for `flushFuel`), within the behaviours and targets in §4 and the balance test.
- Where `mode` sits in `PlantStatus`, and the exact radio wording.
- Whether the tsunami countdown gets its own UI element.

## 7. Impact on Plan 5 (Flink report card and leaderboard)

Plan 5's design and plan were written before modes existed. After this plan lands, they need these changes before Plan 5 executes:
- `RunResult` gains `mode`.
- The leaderboard Top-N, the stats and "today" are computed **per mode**. The public `GET /api/leaderboard` returns both boards, and the start screen shows both.
- The report card shows the mode, and its event verdicts cover the new kinds:
  - `earthquake` is noted;
  - `fuelContamination` and `tsunami` are graded on time-to-clear like the other sharp kinds.
- Plan 5's snapshot version bump moves up by one.

## 8. My calls (to check)

- Hard makes **every** shift a hell shift, shift 1 included.
- Disaster chances: Normal 0.08 from shift 3, Hard 0.4 from shift 2, never two shifts in a row.
- The earthquake is noted itself, and its damage comes as ordinary child events.
- The tsunami warning is about 20 plant minutes. Each pump running through the surge takes about 0.7 wear. The best response is to run on one pump, not to trip.
- `flushFuel` costs about $1,500 and takes about 60 minutes. Contaminated fuel is only drawn when the other fuel can carry the plant.
- Disasters don't count toward the 7-event cap, and they use their own random stream, so Normal's later shifts are unchanged.
- Contaminated fuel needs a new crew job, `flushFuel`.
- The orders sheet never warns of disasters.
- Normal's shift 1 gets a second gentle event.
