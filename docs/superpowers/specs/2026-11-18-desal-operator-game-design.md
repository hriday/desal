# Desal Operator: Design

Date: 2026-11-18
Status: awaiting approval

## 1. Intent

A web-based game where the player is the control-room operator of a thermal desalination plant (multi-stage flash, MSF). They run the plant shift after shift, balancing intake, pretreatment, the brine heater, the flash stages, fuel, and product quality against a production target, while problems such as scaling and algal blooms push the plant off balance.

The project is also a vehicle for learning Apache Kafka and Apache Flink. **The game comes first.** Kafka and Flink play the roles they would play in a real plant (telemetry backbone, monitoring and analytics), and they are in the live game loop, but gameplay decisions are never compromised to show off a streaming feature.

A later phase adds a reverse osmosis (RO) unit.

## 2. Goals, non-goals, anti-goals

**Goals**
- A tense, readable operator experience: notice the problem, diagnose it, act, and see the consequence.
- A simulation that follows real cause-and-effect relationships, so a desalination engineer would nod along, without requiring textbook knowledge to play.
- Consequences within a game: trips and damage carry over from shift to shift, and the player inherits their own plant in the next shift. A game is played in one sitting; it can't be saved and resumed later (§3.1).
- Kafka and Flink doing real work in the loop: telemetry, commands, alarms, trends, scoring, handover reports, persisted plant state.

**Non-goals (for now)**
- The RO unit (phase 2; the design should make it pluggable, see §10).
- Multiplayer *within* a plant, user accounts, saving a game to continue later. (It is public on a Linux server, see §7; each visitor runs their own plant.)
- A tycoon economy or upgrade shop. The player is an operator, not a manager: the operating budget only constrains the run (allocated per shift, spent on fuel and repairs); it buys no upgrades.
- High-fidelity engineering accuracy (no CFD, no full heat and mass balance solver).
- Mobile layouts. The target is a desktop browser.

**Anti-goals (failure even if it technically works)**
- Controls that feel laggy or disconnected because of the streaming pipeline.
- Realism that makes the game opaque: the player must always be able to see *why* something is happening.
- Kafka and Flink reduced to decoration that the game would work identically without.
- The game silently breaking when a backend piece is down. Missing telemetry must be visible to the player (for example, a "TELEMETRY LOST" monitor state).

## 3. Gameplay

### 3.1 Structure: shifts with targets
- One session is one **shift**: 8 hours of plant time played in about 12 real minutes. *(My call: 1 Hz simulation tick, 1 real second = 40 plant seconds. Tune during playtesting.)*
- Each shift has a **target**: product volume (m³), maximum salinity (ppm), and a **fuel cost budget** in money (fuel prices move, so the budget is in $, not tonnes).
- Each shift has a **scenario**: starting conditions plus scheduled and random events (algal bloom onset, seawater temperature rise, pump bearing wear, gas supply curtailment, gas price spike, backup-fuel delivery delay, demand change mid-shift). Scenarios get harder over the career.
- At the end of the shift, the player gets a **score and debrief**.
- **A game is a run of shifts in one sitting** (the user's decision, 2026-11-18). A visitor starts a fresh plant and plays shift after shift. Damage, scale, wear and backup fuel carry over within the run. The game ends when they quit or close the tab (after a short reconnect grace period, my call: 60 s), and they get a **final score for the whole run**. **A game can't be saved and continued later.** There is no career across visits.
- **Each shift is harder than the last, and the run ends when the plant can't go on** (the user's direction, 2026-11-18: "at some point the money has run out, or the fuel has, or something else"). The details are my calls:
  - **The point is water** (the user's direction, 2026-11-18: "water revenue isn't the point. Quantity of water output is."). The plant is a utility, not a business: water earns nothing.
  - **Operating budget** (numbers are my calls):
    - The run starts with $15,000.
    - At each shift start the utility adds an allocation: `$10,000 × (1 − 0.03 × (n − 1))` for shift `n`, multiplied for shift ≥ 2 by `min(1, previous shift's in-spec water ÷ its target)`. So missing the target cuts the next shift's funding.
    - The budget pays for gas as it burns, backup-fuel deliveries (on order), acid cleaning ($6,000) and pump overhauls ($8,000).
    - There is no revenue and no fines. Off-spec water simply doesn't count toward the target or the score.
  - **Game over** comes from any of:
    - **Bankrupt:** the account is below $0 at a shift end.
    - **Out of fuel:** no gas is available, the backup tank is empty, and the account can't pay for a delivery.
    - **Plant failure:** the burner condition reaches 0, or no intake pump is usable (wear at 1).
  - When game over is reached mid-shift (fuel or failure), the run ends at once with the reason shown.
  - **Difficulty:** each shift raises the target and draws more and harsher scenario events (blooms, curtailments, price spikes, off-grade fuel, controller faults, warmer seawater), so a run always ends eventually.
  - **Final score:** total in-spec water delivered over the run (the headline), then shifts completed.
- **Shift handover report:** shown at the start of each shift after the first, like a real operator's handover log. It covers equipment condition, trips and incidents last shift, open alarms, and this shift's target and conditions. Flink generates it from the previous shift's events.
- Pause is allowed, but it counts toward the reconnect grace: a paused, disconnected game still ends.

### 3.2 Plant model (MSF, brine recirculation)
The units, in flow order:
1. **Seawater intake:** intake pumps (2 duty plus 1 standby, *my call*), screens, intake water quality (temperature, turbidity, chlorophyll-a for blooms).
2. **Pretreatment:** chlorination and antiscalant dosing. Blooms raise fouling load and can reduce intake flow.
3. **Brine heater ("boiler"):** fuel-fired steam heats recycle brine to the **top brine temperature (TBT)**. Fuel burn tracks heat duty.
4. **Flash stages (20, my call):** brine flashes in successive stages at falling pressure and temperature. Vapour condenses on the condenser tubes, which carry the recycle brine and preheat it, and is collected as distillate.
5. **Brine recirculation and blowdown:** recirculation pump, blowdown to the sea, make-up feed.
6. **Vacuum system:** ejectors holding stage pressures.
7. **Product water:** product tank, salinity, delivery.
8. **Fuel** (the user's direction, details my call):
   - **Natural gas** by pipeline is the normal fuel. It has no on-site storage: the constraints are available supply (a flow cap) and a **price that can change mid-shift**.
   - **Geopolitical or supply events** can curtail gas (lower the cap or cut it entirely) or spike its price. The scenario announces these as events, sometimes with warning ("supplier notice: curtailment in 2 plant-hours").
   - A **backup liquid fuel** (diesel or fuel oil) is stored in an on-site tank, delivered by truck after a delay, and priced differently. Sometimes the only delivery on offer is an off-grade fuel, with a lower heating value and more burner fouling.
   - **Switching fuel** is an operator action (burner changeover). It causes a brief dip in firing and, in Manual mode, has to be done carefully or it risks a flame-out trip. Liquid fuel wears the burner faster. Running out of every available fuel trips the plant.

**Core relationships the simulation must honour** (simplified, not solved from first principles):
- Higher TBT gives more distillate and better efficiency (gained output ratio, GOR) but a sharply higher scaling rate above about 110 to 112 °C. Antiscalant dosing reduces the scaling rate.
- Scale on the tubes lowers heat transfer, which lowers the temperature drop across a stage and its output. More fuel is then needed for the same production.
- Stage temperatures cascade down from TBT to the last stage (about 35 to 40 °C). Seawater temperature affects the bottom of the cascade.
- Brine levels must stay in band. Flooding a stage carries brine over into the distillate, so salinity rises. Too low a level lets vapour blow through to the next stage.
- Loss of vacuum collapses the temperature cascade and output.
- Blooms raise pretreatment load, foul the intake, and can cut intake flow. Responses include higher chlorination and reduced intake.
- Too much concentration in the recirculating brine (too little blowdown) raises the scaling risk.
- Equipment wear accumulates with run hours and abuse (cavitation, overspeed, thermal cycling from trips).

Exact formulas are left to the builder (§11), provided the relationships above hold and are tunable via constants.

### 3.3 Control modes: Auto and Manual
The player's decision: there are two levels of control. The player picks one at each shift's handover (my call: per shift, not locked per career).
- **Auto:** the plant's automatic controllers (PID loops) hold setpoints the operator chooses: TBT, intake flow, stage levels, blowdown, vacuum. Any single loop can be switched to manual when its controller misbehaves, and controller faults (stuck, drifting, oscillating) are a failure mode. A **restart after a trip** is one button that runs the start-up sequence automatically while the player watches. It can still fail if a precondition isn't met.
- **Manual:** the player drives the actuators directly: burner firing rate, pump speeds, valve positions, chemical dosing. **Stage brine levels stay on automatic even in Manual** (my call: 20 levels by hand at 40× time is unplayable), though they can be overridden one by one. A restart is a procedure the player works through in order: pull vacuum, start recirculation, light the burner, ramp to TBT. Doing a step out of order or too fast causes alarms, wear, or a re-trip.
- Manual shifts score with a multiplier (weight is the builder's call).
- The simulator always models the controllers. Auto and Manual decide which inputs the operator commands (setpoints or outputs), so the command schema carries both.

### 3.4 Operator controls (from each zoomed monitor)
Each control is a setpoint in Auto and a direct output in Manual.
- Intake: pump start/stop, pump speed, intake flow setpoint.
- Pretreatment: chlorine dose, antiscalant dose.
- Brine heater: TBT setpoint (Auto) or burner firing rate (Manual).
- Stages: recirculation flow, stage level setpoints, sponge-ball tube cleaning (removes soft scale and costs some output while it runs).
- Brine: blowdown rate, make-up flow.
- Vacuum: ejector steam.
- Product: divert off-spec water to drain.
- Fuel: choose the active fuel (gas or backup; changeover per §3.2), order a backup-fuel delivery (arrives after a delay; sometimes only off-grade fuel is available).
- Plant: manual trip, and restart after a trip (see §3.3).

### 3.5 Trips, damage, recovery
- **Safety interlocks run inside the simulation** and act immediately, never waiting on Flink. Examples: TBT high-high, stage flood, intake pump dry-run or cavitation, loss of vacuum, fuel exhausted.
- A trip stops production. A **restart** takes plant time (a heat-up ramp) and adds thermal-cycling wear.
- **Damage persists between shifts:** tube scale thickness per stage, pump wear, burner condition, plus any equipment out of service.
- **Recovery** (my call): acid cleaning, which takes the plant offline for part of a shift and removes hard scale, and a pump swap to standby. Both are operator actions with a production cost. A between-shifts maintenance choice is left for later.

### 3.6 Scoring
Per shift: in-spec water against target, off-spec water, spending (fuel, deliveries, repairs), the next shift's allocation, trips and damage added. These are shown in the debrief. The run's final score is total in-spec water, then shifts completed (§3.1). The simulator owns the account and the game-over checks (they are game rules, not analytics). Flink computes the running KPIs, the debrief and the handover report.

## 4. UI: the control room

Approved via mockup (`.superpowers/brainstorm/.../monitor-wall-v2.html`).

- **Wall of monitors**, a grid of six: Intake, Brine Heater, Flash Stages, Product Water, Fuel & Power, Shift & Alarms.
- Each monitor shows a **drawing of its equipment** with live readings overlaid: tanks fill, flames scale with firing, stage chambers show brine levels, the scaled stage is tinted.
- **Click a monitor to expand** it to full size. The expanded view shows detail (for stages: each chamber with demister, brine level, temperature, and scale thickness; condenser tubes; distillate trough), trends, and the **controls** for that system. Escape returns to the wall.
- **Style: flat industrial schematic** (SCADA-like): dark background, line-art equipment, and colour reserved for status (green ok, amber warning, red alarm). *(My call; a shaded semi-3D style may come later as polish.)*
- **Alarms stay visible while zoomed** (my call): each monitor's border and status light reflect its alarm state, and the expanded view has a slim alarm strip along the top.
- The **Fuel & Power** monitor is renamed **Fuel**. It shows the gas supply (available cap, current price, any curtailment notice), the backup fuel tank level and grade, the active fuel, burn rate, runtime remaining on backup, and cost per m³. Electrical power is not modelled in phase 1 (my call); it becomes relevant with RO in phase 2.
- Screens: handover report (shift start), control room (in shift), debrief (shift end).

## 5. Approaches considered

1. **Simulation on the server, Kafka and Flink in the loop (chosen).** A simulation service publishes telemetry to Kafka. Flink computes alarms, trends, KPIs, the score, and handover reports. A gateway bridges to the browser over WebSocket, and player commands flow back through Kafka. Interlocks stay in the simulation. Trade-off: the most moving parts, plus pipeline delay (tens of milliseconds locally, negligible at 1 Hz). Chosen because it keeps Kafka and Flink genuinely load-bearing while the game stays responsive.
2. **Simulation in the browser, Kafka and Flink on the side.** Simplest, and the game works without Docker, but Kafka and Flink would be decorative, which conflicts with the learning goal.
3. **Flink job as the physics engine.** It teaches advanced Flink, but it fights the tool: tick-based physics is awkward in Flink, harder to debug, and adds latency. Rejected.

## 6. Architecture

**Many games at once** (the user's decision, 2026-11-18: each concurrent player gets their own plant). Every game has a `gameId` (a UUID created when the visitor starts). Every message (command, telemetry, status, event, report) carries it, and it is the Kafka message key, so one game's records stay ordered on one partition and Flink keys all per-game state by `gameId`. The simulator hosts many plants, each its own `PlantState` stepped by the same deterministic `tick()`. There is a concurrency cap for the 2 GB server (my call: 10 games; extra visitors see "the plant is at capacity, try again shortly"). When a game ends, its plant is dropped and a `gameEnd` event with the final score is published. Plan 1 built the single-plant version; **Plan 2 starts by making the simulator and schema multi-game** (this also settles the final review's career-identity and shift-id-uniqueness findings, since `gameId` plus shift number is unique).

```
 Browser (React, SVG)
     │  WebSocket (JSON)
     ▼
 Gateway (Node/TS) ──produce──▶ plant.commands ──▶ Simulator (Node/TS)
     ▲                                                │
     │ consume                                        │ produce (1 Hz)
     │                                                ▼
     ├──── plant.telemetry ◀──────────────────────────┤
     ├──── plant.events    ◀──────────────────────────┘  (trips, scenario events, shift start/end)
     │
     │            Flink jobs (Java) consume telemetry + events + commands
     ├──── plant.alarms    ◀── alarm job
     ├──── plant.kpis      ◀── KPI / score job
     └──── shift.reports   ◀── handover / debrief job

 plant.state (compacted): simulator snapshots the plant at shift end and on trips;
                          reads the latest snapshot at startup to resume the career.
```

**Components**
- **Frontend:** React + TypeScript + Vite. Equipment drawn as SVG components. *(My call.)*
- **Gateway:** Node/TypeScript. WebSocket server and Kafka client. Relays commands into Kafka, and fans telemetry, alarms, KPIs, and reports out to the browser. Holds no game logic.
- **Simulator:** Node/TypeScript. Owns the plant model, the tick loop, the scenario engine, interlocks, and damage. It consumes commands and produces telemetry and events. It is the single source of truth for plant state.
- **Flink jobs (Java):**
  - *Alarm job:* threshold alarms plus rate-of-change and persistence alarms ("S2 temperature drop sustained for 10 plant-minutes"), using keyed state per sensor. Raise and clear semantics.
  - *Scaling and trend job:* windowed trend per stage (fouling rate, heat transfer degradation), feeding "HI scaling rate" alarms and the debrief.
  - *KPI and score job:* windowed aggregates (production, GOR, fuel cost per m³, off-spec time) and the running shift score.
  - *Shift report job:* on shift-end events, builds the debrief and the next shift's handover report.
  - Flink uses **event time = plant time** (each record carries its plant timestamp), with watermarks. This matters because the game can pause and time is compressed.
- **Kafka:** a single broker in KRaft mode. Topics are listed below; keys are chosen so per-unit and per-sensor ordering holds.
- **Shared types:** one TypeScript package of message schemas (telemetry, command, event, alarm, KPI, report) used by the frontend, gateway, and simulator. The Java Flink side mirrors them. JSON over the wire *(my call; schema registry and Avro are a possible later learning step)*.

**Topics (initial)**

| Topic | Key | Producer | Notes |
|---|---|---|---|
| `plant.telemetry` | sensor id | simulator | ~1 Hz per sensor, plant-time stamped |
| `plant.commands` | unit id | gateway | operator actions |
| `plant.events` | unit id | simulator | trips, interlocks, scenario events, shift start/end |
| `plant.alarms` | alarm id | Flink | raise/clear/ack state |
| `plant.kpis` | shift id | Flink | running KPIs and score |
| `shift.reports` | shift id | Flink | debrief and handover; unlimited retention (career history) |
| `plant.state` | game id | simulator | **compacted**; latest snapshot per live game, for crash recovery only (a simulator restart may resume games that were running, but a visitor can never resume a game they left). Tombstoned when the game ends |

**Responsiveness:** the browser shows the simulator's telemetry as soon as it arrives. Flink output (alarms, trends, score) can arrive slightly later without hurting the feel. Commands are acknowledged in the UI immediately and confirmed by the next telemetry.

**Shift boundary** (my call): at shift end the UI waits up to about 10 seconds for the Flink debrief. If it doesn't arrive, the simulator's own minimal summary is shown (production, trips, damage) and the score is marked "pending"; Flink publishes it when it catches up. The next shift can start without a handover report. Score history lives in `shift.reports`, which uses unlimited retention. Nothing flows from Flink back into the simulator: the scenario is chosen by shift number, so the simulator never depends on Flink.

**Degradation:** if Flink is down, monitors still show raw telemetry, and the alarm and score panels show "MONITORING OFFLINE". If the simulator is down, the monitors show "TELEMETRY LOST".

## 7. Runtime: local development and the Linux server

**Local development:** Docker Compose runs Kafka (KRaft), Flink JobManager and TaskManager, and Kafka UI. The simulator, gateway, and frontend run as Node processes. One command brings up the infrastructure and one starts the app.

**Production** (the user's direction: "this will run on a Linux server, similar to all our other projects"). It follows the convention of the user's other projects, for example `compliance_platform/docs/hosting.md`:
- An Ubuntu 24.04 server (DigitalOcean, 68.183.200.37). desal is now the only application on it, but it still follows the shared-server convention: everything it adds is named `desal*`.
- **Compose project `desal`** in `/opt/desal` (`compose.yml`, `.env`). Every service runs as a container: kafka, flink-jobmanager, flink-taskmanager, simulator, gateway. Images are tagged `desal-<service>:<commit>`, and the two newest of each are kept.
- **Caddy on the host** already holds ports 80 and 443. desal adds `/etc/caddy/desal.caddy`, imported from the main Caddyfile. Caddy serves the built frontend's static files and reverse-proxies the WebSocket to the gateway, which listens on `127.0.0.1` only. Kafka, Flink, and Kafka UI are never exposed publicly. Kafka UI and the Flink dashboard are reached over an SSH tunnel when needed.
- **Every container is capped** (memory, CPU, processes). The server is a 2 GB DigitalOcean droplet with a 2 GB swapfile; the previous app on it (`reserve`) was removed at the user's direction, 2026-11-18. Current caps: Kafka 768 MB, Kafka UI 384 MB, simulator 256 MB. **Flink (Plan 3) will not fit in 2 GB alongside these.** Before Plan 3, resize the droplet or run Flink in a slim configuration; decide then.
- **Persistent data** lives in the Docker volume `desal_kafka-data` (topics, including crash-recovery snapshots of live games). Flink checkpoints go in `desal_flink-checkpoints`.
- **`scripts/deploy/deploy.sh`** builds images from this machine (for `linux/amd64` unless the server says otherwise), ships them, writes `/opt/desal`, installs the Caddy site, and runs `docker compose up -d`. **`docs/hosting.md`** documents what lives where, how to deploy, roll back, back up the Kafka volume, and remove desal.
- **Access:** the game is public, no password (the user's decision, 2026-11-18). Kafka UI is an admin tool that can delete topics, so it stays behind Caddy basic auth (my call). Until the game UI exists (Plan 2), Kafka UI is what https://desal.moosha.org serves; after that it moves to a path or subdomain behind the password.
- Deployment is its own milestone plan, after the gateway and UI exist.

## 8. Learning support (my call, light-touch)
Since the game comes first, there are no tutorial mode or lessons. Code comments explain the Kafka or Flink concept at the point it is used (for example, why a key was chosen, what a watermark does, why `plant.state` is compacted), and a short `docs/streaming-notes.md` maps each concept to where it lives in the code.

## 9. Testing expectations
- Simulator physics and interlocks: unit-tested deterministically (seeded randomness, fixed tick inputs), including "TBT above threshold trips the plant" and "scale persists across a save and load".
- Flink jobs: tested with Flink's test harnesses or mini-cluster on fixed event sequences.
- End-to-end smoke test: bring up Compose, run a short accelerated shift, and assert that alarms and a shift report are produced.

## 10. Phase 2: RO unit (not in scope now)
The plant model is organised as units with defined inputs and outputs, so an RO train (high-pressure pump, membranes, energy recovery, membrane fouling, permeate salinity) can be added as another unit, monitor, and set of topics and alarms without reworking the core. Hybrid MSF and RO blending of product water is the likely gameplay hook.

## 11. Left to the builder
- Exact physics formulas and constants (within §3.2).
- Score weights, scenario content, and difficulty curve.
- Monorepo layout, Kafka client library choice, build tooling, and test frameworks.
- Exact alarm list and thresholds beyond the examples.
- Visual details of each equipment drawing within the approved style.
