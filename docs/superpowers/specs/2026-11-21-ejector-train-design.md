# Ejector train: two-stage ejectors, condensers and air — design

Plan 9. 2026-11-21. Started from the user's whiteboard drawing of the plant's vacuum system. The user
said "dive in", so every choice below is the builder's call unless marked as the user's.

## Why
The user (an MSF operator) drew the real ejector train and asked for it in the game "because this will
help the vacuum dropping to be managed". Today the vacuum is one number fed by one valve and the motive
steam. When it drops, the player can't tell why, and has almost nothing to do but wait for the crew.

Success: when the vacuum drops, the player can **read the ejector train to find the cause** and has
**a real action for each cause**. Some actions hold the vacuum now, and some fix the cause.

## The real system (from the user's drawing)
- Boiler HP steam at 14.5 bar feeds the nozzles of both ejectors (the motive steam from Plan 8).
- **1st-stage ejector:** draws vapour and air from stage 24. It discharges into the **intercondenser**,
  where the steam condenses.
- **2nd-stage ejector:** draws the air left in the intercondenser. It discharges into the
  **after-condenser**, which vents to the outside air.
- **Cooling water** runs through both condensers, entering at the after-condenser end of the drawing.
  The builder's call: it is seawater from the intake.

## Goals
1. **Ejector train model.** The vacuum the ejectors can pull now depends on three things:
   - the number of working trains;
   - the condenser cooling;
   - how much air they must remove, relative to the load.

   The nominal plant must be unchanged: the same vacuum, and the vacuum valve still in balance at
   today's BALANCE.vacuumPct.
2. **Standby ejector train (B).** It is a 2×100 % set, as real plants have.
   - A **Standby ejectors** switch on the Stages screen.
   - It costs **$100 per plant hour while on**.
   - Every shift starts with it off.
   - It bypasses a failed train-A ejector and doubles the air-handling capacity.
   - It does **not** help when the condenser cooling is short, because both trains share the cooling
     water header.
3. **Two new faults**, on their own clock like lowSteam, from shift 2:
   - **`coolingLoss`: condenser cooling water strainer fouling.**
     - The cooling capacity falls over about 10 plant minutes to a floor drawn when the fault fires.
     - Left alone, the vacuum trips in about 20–35 plant minutes.
     - Fix: a new crew job **`cleanStrainer`** ($400, 30 min).
     - To buy time: cut the load. Standby ejectors do not help.
   - **`airLeak`: air in-leakage into stage 24** (a gland, manhole or sight glass).
     - The air load steps up to 2.5–3.5× normal, drawn when the fault fires.
     - Left alone, the vacuum trips in about 15–25 plant minutes.
     - Fix: a new crew job **`sealLeak`** ($600, 60 min).
     - To hold it: switch on the standby ejectors, which keeps the vacuum above the trip but below
       nominal. Cutting the load also helps.
4. **The existing `vacuumLoss`** is now named as the 1st-stage ejector of train A failing.
   - Its fall rate and its crew repair (`repairEjector`) are unchanged.
   - New: with the standby ejectors on, train B takes over. The fall stops and the vacuum recovers
     toward nominal.
   - The event still clears only on the crew repair.
5. **Diagnosis readings** (telemetry unit `vacuum`, shown on the Stages screen under "Ejector train"):

   | Reading | Unit | Nominal (builder's call) |
   |---|---|---|
   | `vacuum.lastStageMbar`: stage 24 pressure | mbar abs | about 63 at 30 °C seawater (saturation pressure at the bottom-stage temperature; follows seawater) |
   | `vacuum.intercondenserMbar` | mbar abs | about 250 |
   | `vacuum.coolingOutC`: condenser cooling water out | °C | seawater + about 6 |
   | `vacuum.ventAirKgH`: air vented from the after-condenser | kg/h | about 10 |

   Each fault must show its own pattern (↑ rises, ↓ falls, – about nominal):

   | Fault | Stage 24 | Intercondenser | Cooling out | Vent air | Motive steam |
   |---|---|---|---|---|---|
   | vacuumLoss (1st ejector) | ↑ | ↓ | – | ↓ | – |
   | coolingLoss | ↑ | ↑↑ | ↑↑ | – | – |
   | airLeak | ↑ | ↑ | – | ↑↑ | – |
   | lowSteam | ↑ | – | – | – | ↓ |
6. **Hints** (Normal mode only, as in Plan 7/8). They come at a delay well under the fault's earliest
   unattended trip: at most half of it. The builder's call is 6 plant minutes for both new kinds.
   - coolingLoss: "Send the crew to clean the condenser cooling water strainer; cut load to slow the
     vacuum loss meanwhile."
   - airLeak: "Switch on the standby ejectors to hold the vacuum, and send the crew to seal the air
     leak."
   - vacuumLoss gets a new text: "Switch on the standby ejectors, then send the crew to repair the
     failed ejector."
7. **Flink.**
   - The report card grades both new kinds. The response is the matching crew job.
   - vacuumLoss also counts the standby ejectors being on as a response, the way lowSteam counts the
     standby steam line.
   - The leaderboard counts both new kinds.

## Non-goals
- No separate model of the 2nd-stage ejector failing, no hogging (start-up) ejector, and no condensate
  drains.
- No modelled cooling water flow or pump. The cooling capacity is one number.
- No new player valves beyond the Standby ejectors switch.

## Constraints
- **Determinism, as Plan 8:**
  - The new faults are planned on one new salted substream: the vacuum-train roll, which picks the
    shift, the minute and the kind.
  - Their params are drawn on that substream when the fault fires.
  - They never consume `s.seed`, so existing seeds keep their meaning.
  - They sit outside the MAX_EVENTS cap.
- **Chances per shift:** Normal 0.20 and Hard 0.40, from shift 2. The minute is between 60 and 360,
  and the kind is coolingLoss or airLeak, 50/50.
- **Snapshot v8**, migrated from v7: no new faults, and the standby ejectors off.
- **Every place an event kind, crew job, AccountCause or reading is listed must handle the new ones:**
  - the schema enums;
  - the web labels and FIX table;
  - the leaderboard names ("condenser cooling loss", "air leak");
  - Flink `Rules`, `StatusView` (`standbyEjectors`, default false) and `LeaderboardSql.GRADED_KINDS`;
  - the readings count.
- **Flink state stays restorable.** New POJO fields need defaults.
- **The new command `standbyEjectors {on}`** goes through the existing `ok()` and refusal paths, as
  `standbySteam`. Its cost is charged hourly under AccountCause `standbyEjectors`.

## Model (the builder's call, inside the goals above)
- `trains` is the number of working trains:
  - train A counts 1 unless the ejector has failed;
  - the standby switch adds 1.
- `coolCap` is the cooling capacity. It is nominal 2, because the header is sized for both trains. A
  coolingLoss drives it to a floor.
- `airLoad` is 1 normally, and the fault's multiple during an airLeak.
- Effective capacity = min(trains, coolCap) / (airLoad × ejectorLoadFactor(TBT, firing)), capped at 1.
  - At nominal, this is 1, so the nominal plant is unchanged.
  - The vacuum target is `VACUUM_QUALITY_MIN + (1 − MIN) × pct(valve) × reach × capacity`.
  - When train A's ejector has failed and the standby is off, today's rate-based fall applies instead.
- The constants, ramps and reading formulas are the builder's. They must meet the timings and
  patterns above, and be checked by tests.
