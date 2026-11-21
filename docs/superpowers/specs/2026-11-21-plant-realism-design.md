# Plant realism round: ejector motive steam and auto divert — design

Approved by the user 2026-11-21 ("yes go"). Small project, Plan 8.

## Why
Both items came from the user playing the live game:
- They asked how to set the ~14.5 bar steam for the vacuum ejector. The game has no such control: the vacuum loop's
  output is the ejector steam valve in effect, but nothing says so and steam pressure does not exist.
- They left Divert to drain on after plugging a tube leak and lost the rest of the shift's water. Divert is a manual
  latch, and salinity snaps back the instant a cause clears, which reads as fake.

## Goals
1. **Motive steam.**
   - A motive steam pressure reading, nominal **14.5 bar**, shown on the stages screen.
   - The vacuum loop's output is labelled **"Ejector steam valve"** (%).
   - Below **13 bar** the ejector's reach falls. The best vacuum the valve can pull scales down linearly to
     VACUUM_QUALITY_MIN at 10 bar (amended from 8 in Plan 8 ruling R1 so every 10–11 bar floor trips in ~20–30 min),
     so a fully open valve can still lose vacuum. Sag rate 0.25 bar/min.
2. **Low motive steam fault** (new scenario event kind `lowSteam`).
   - The steam pressure-reducing valve sticks and the pressure sags over a few plant minutes to **10–11 bar** (seeded).
   - The vacuum then drifts toward the loss-of-vacuum trip (VACUUM_TRIP 0.6) over roughly 20–30 plant minutes.
   - **The player fixes it, not the crew.** A **Standby steam line** switch on the stages screen restores 14.5 bar
     while it is on.
   - The event clears when the standby line is on, or when the fault ends.
   - The fault ends by itself only at the end of the shift. Turning the standby line off while the fault is active
     brings the sag back.
   - The standby line costs **$150 per plant hour while it is on** (user decision, 2026-11-21; it was free at first).
3. **Auto divert.**
   - A divert mode `auto | manual`, **auto by default**.
   - **Auto** diverts while salinity > limit, and returns to the tank once salinity < **0.9 × limit**. The gap between
     the two thresholds keeps it from flipping back and forth.
   - **Manual** is today's latch. Pressing the divert toggle selects Manual.
   - Every shift starts with divert back on Auto (user decision, 2026-11-21), so a Manual latch never outlives its shift.
   - The product screen shows the mode and the direction: "Auto — to tank", "Auto — diverting", or "Manual — …".
4. **Salinity lag.**
   - Product salinity lags toward the computed value.
   - Rising: **60 s** time constant.
   - Falling: **300 s** time constant, about 15 plant minutes to settle.
5. **Hint** (Normal mode only, alongside the existing Plan 7 radio hints): when divert is Manual and on, and salinity
   has been under the limit for 5 plant minutes, the radio says "Product's back in spec — put Divert back on Auto."

## Non-goals
- No steam boiler model.
- No fuel use for the standby line. (No running cost was the first plan; on 2026-11-21 the user chose a $150 per
  plant hour running cost while the line is on.)
- No change to how in-spec water is counted, beyond the routing decided above.

## Constraints
- The simulator stays deterministic, and seeds keep their meaning: the new fault draws its randomness only when it
  fires.
- **Snapshot v7**, migrated from v6:
  - divertMode defaults to `manual` for restored games, so an in-progress game keeps behaving as it did;
  - new games start in `auto`;
  - motive steam starts nominal;
  - the standby line starts off;
  - no lowSteam fault.
- A new event kind touches several places, and every one must handle it:
  - the schema's events enum;
  - the scenario library and director (Normal and Hard mixes);
  - the web labels ("What to do": "Switch on the standby steam line on the Stages screen.");
  - the Flink report card's clear rule (Java `Rules`), checked against the status' standby/steam fields;
  - the leaderboard's kind stats.
- The Flink jobs' state must stay restorable.
  - New POJO fields must have defaults.
  - If state turns out incompatible, the existing fresh-start fallback applies (no `--allowNonRestoredState`).
- New commands go through the existing `ok()` and refusal paths:
  - `setDivertMode {mode}`;
  - `standbySteam {on}`.

## Approaches considered (for the steam fix)
- **Standby steam line switch** (chosen). It is one obvious action, it matches real plant practice, and it reads
  clearly in the UI.
- **A pressure setpoint on the reducing valve** that the player raises. Rejected: it is fussier, and a stuck valve
  does not follow its setpoint anyway.

## Left to the builder
- Exact constants for the sag rate and the vacuum curve. They must stay within the numbers above.
- Where in the step order the steam pressure is computed. It must happen before the vacuum lag.
