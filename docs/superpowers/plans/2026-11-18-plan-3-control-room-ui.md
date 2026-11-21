# Plan 3: Control Room UI. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public browser game at https://desal.moosha.org. A visitor starts a run, plays shifts on a wall of monitors that open into detailed views, sees a handover between shifts and a final score at game over. Kafka UI moves to `/kafka` behind the password.

**Architecture:** A static single-page app in `apps/web` (React + TypeScript + Vite) talks only to the gateway over WebSocket, using the `ws.ts` protocol from `@desal/schema` (Plan 2).
- **Game state:** one reducer holds the latest status, the latest frame of readings, a short trend history per sensor, the event log and the session phase.
- **Drawing:** equipment is drawn as SVG components in the approved flat-schematic style.
- **Alarms:** until Flink exists (Plan 4), they are derived client-side from status and readings with simple threshold rules in one module. Plan 4 replaces that module's input with Flink's alarm stream.
- **Serving:** Caddy serves the built files.

**Tech Stack:** React 19, Vite 8, TypeScript, vitest with @testing-library/react (logic and components), Playwright (end-to-end smoke). No UI framework. Styling is plain CSS with design tokens.

**Spec:** `docs/superpowers/specs/2026-11-18-desal-operator-game-design.md`, mainly §3 (gameplay and controls) and §4 (control room).

**Approved look:** `docs/design/monitor-wall-v2.html`. Use it as the reference for layout, palette and equipment drawings: a wall of six monitors, equipment drawn on each, click to expand, Esc to return, flat schematic style.

**Starts from:** Plan 2 merged. The gateway is live at `wss://desal.moosha.org/ws`, and the `ws.ts`, status, events and telemetry schemas carry gameId.

## Global Constraints

- **Screens:**
  - **Start:** "Start a run", plus how to play in a few lines.
  - **Handover:** before each shift. It shows the last shift's summary, equipment condition, the next target and conditions, and the Auto or Manual choice.
  - **Control room:** during a shift.
  - **Game over:** the reason, the score (shifts completed, then water delivered, then balance), and "Play again".
- **The wall** is six monitors, in order: Intake, Brine Heater, Flash Stages, Product Water, Fuel, Shift & Account.
  - Each shows its equipment drawing with live values.
  - The border and status light are green, amber or red from that monitor's worst active alarm.
  - Clicking a monitor expands it to full size with detail, trends and its controls. Esc or a Back button returns to the wall.
  - While a monitor is expanded, a slim **alarm strip** along the top lists every active alarm, and clicking one opens its monitor.
- **Controls follow the mode** (spec §3.3):
  - In Auto, a control sets a setpoint (`setSetpoint`).
  - In Manual, a control sets the output (`setOutput`). Stage levels stay setpoint-driven in both modes.
  - Each loop has an Auto/Manual toggle (`setLoopMode`) in Auto mode only.
  - Restart in Auto is one button (`restart`). In Manual it is four step buttons (`restartStep`), enabled in order.
  - Every control shows the value the plant reports, not just what was sent. A pending command shows as a subtle "sending…" until the next status confirms it or a `commandRejected` arrives; a rejection is shown as a toast with its reason.
- **Colour** is reserved for status (green ok, amber warning, red alarm) on a dark background, with line-art equipment. Body text has at least 4.5:1 contrast. Everything works with the keyboard: monitors are buttons, and Esc closes.
- **Connection:**
  - The `gameId` is kept in `sessionStorage`, so reloading the tab resumes within the 90 s window.
  - If the socket drops, show a "Reconnecting…" overlay and retry with backoff (1, 2, 4, 8 s, then every 10 s) using `{t:'resume'}`.
  - On `{t:'error', reason:'game ended'}`, show the game-over screen from the last known score if there is one, else the start screen.
  - On `capacity`, show "The plant is at capacity, try again in a minute" with a retry button.
- **The page never sends** `startGame` or `heartbeat`. The gateway owns them.
- **Layout:** the target is a desktop browser at least 1280 px wide (spec non-goal: mobile). Below 900 px, show a "best on a larger screen" note but still render.
- **Performance:** the wall stays responsive while receiving one frame per second (108 readings) plus status. Keep 10 minutes of per-sensor trend history (600 points) in a ring buffer.
- **Bundle:** under 300 KB gzipped. No external fonts or CDN scripts; everything is bundled and self-hosted.

## Review Focus

1. **Dropped connection mid-shift.** The operator sees the reconnect overlay, the game resumes with no duplicated event-log entries (de-duplicate by `seq`), and nothing can be sent while disconnected. *Pinned in Task 2.*
2. **A rejected command** (wrong phase, insufficient funds, out of range) shows the reason and reverts the control to the plant's reported value. It never leaves the UI showing a value the plant doesn't have. *Pinned in Task 5.*
3. **Game over arriving mid-shift**, from out of fuel or a burner failure, switches to the game-over screen at once with the right reason and score, even while a monitor is expanded. *Pinned in Task 7.*
4. **Values the UI doesn't expect:** a missing sensor in a frame, NaN converted to null, an unknown event type, or an unknown fault kind. These render as "—" and are ignored, never as a crash or a blank screen. An error boundary shows "Something went wrong, reload" with the game still resumable. *Pinned in Tasks 3 and 4.*
5. **Manual-mode restart buttons** are enabled only in order, matching what the simulator accepts. Pressing one out of order is impossible, not merely rejected. *Pinned in Task 5.*

---

## File Structure

```
apps/web/
  package.json (@desal/web), vite.config.ts, tsconfig.json, index.html, vitest.config.ts, playwright.config.ts
  src/main.tsx, src/App.tsx           screen router (start / handover / room / over)
  src/net/socket.ts                    WebSocket client: connect, resume, backoff, send
  src/state/store.ts                   reducer + context: session, status, frame, trends, events(seq de-dup), pending
  src/state/trends.ts                  ring buffers per sensor
  src/alarms/rules.ts                  client-side alarm rules → Alarm[] per monitor
  src/commands.ts                      builders for every Command the UI sends
  src/screens/{Start,Handover,ControlRoom,GameOver}.tsx
  src/wall/{Wall,Monitor,AlarmStrip}.tsx
  src/equipment/{Intake,BrineHeater,FlashStages,ProductWater,Fuel,ShiftAccount}.tsx   SVG drawings (wall size)
  src/expanded/{IntakeView,HeaterView,StagesView,ProductView,FuelView,ShiftView}.tsx  detail + controls
  src/controls/{Setpoint,Toggle,Stepper,ActionButton,Trend}.tsx
  src/ui/{tokens.css,app.css,Toast.tsx,Overlay.tsx}
  test/** (vitest), e2e/play.spec.ts (Playwright)
deploy/desal.caddy, deploy/compose.yml, scripts/deploy/deploy.sh, docs/hosting.md
```

---

### Task 1: Web app scaffold, tokens, and the command builders

**Files:** Create the `apps/web` package files listed above (config, `index.html`, `main.tsx`, `App.tsx` with placeholder screens), `src/ui/tokens.css`, `src/commands.ts`, and `test/commands.test.ts`. Add `apps/*` to `pnpm-workspace.yaml`.

**Interfaces:**
- `commands.ts` exports a pure function per command, returning a `Command` from `@desal/schema`:
  - `setpoint(loop, value)`, `output(loop, value)`, `loopMode(loop, mode)`
  - `pump(id, action)`, `dose(chemical, mgL)`, `ballCleaning(on)`, `divert(on)`
  - `selectFuel(fuel)`, `orderFuel(tonnes)`
  - `restart()`, `restartStep(step)`, `acidClean()`, `overhaul(pumpId)`, `manualTrip()`
  - `pause()`, `resume()`, `startShift(mode)`, `quit()`
  - `controlFor(mode, loop, value)` returns a setpoint in Auto and an output in Manual, except for level loops, which always get a setpoint.
- `tokens.css` defines CSS variables taken from the mockup's palette: bg `#0b1016`, panel `#0f1822`, line `#23364a`, text `#e6edf3`, muted `#9fb3c8`, ok `#3fb950`, warn `#d29922`, bad `#f85149`, water `#388bfd`, flame `#f0883e`.

- [ ] **Step 1: Failing tests.**
  - Every builder output parses with `CommandSchema`.
  - `controlFor('manual','tbt',70)` gives `setOutput`, and `controlFor('manual','level3',0.3)` gives `setSetpoint`.
- [ ] **Step 2: Run** `pnpm --filter @desal/web test`. Expected: FAIL.
- [ ] **Step 3: Implement**, including `pnpm --filter @desal/web dev` and `build` scripts.
- [ ] **Step 4: Run the tests and `build`.** Expected: PASS. `build` writes `apps/web/dist`.
- [ ] **Step 5: Commit** `feat(web): scaffold, design tokens, command builders`

---

### Task 2: Socket client and game store

**Files:** Create `src/net/socket.ts`, `src/state/{store,trends}.ts`, `test/store.test.ts`, `test/socket.test.ts`.

**Interfaces:**
- **Socket:** `createSocket(url, onMsg: (m: ServerMsg) => void, onConn: (c: 'connecting'|'open'|'closed') => void)` returns `{ send(m: ClientMsg): boolean; close() }`.
  - Every incoming message is validated with `ServerMsgSchema`; invalid ones are dropped and logged.
  - Reconnects with backoff (Global Constraints). On reopen, it sends `resume` if a gameId is stored.
  - `send` returns false while not open.
- **Store:** `reducer(state, action)`.
  - State:
    - `session: 'start'|'starting'|'handover'|'room'|'over'`
    - `gameId: string|null`
    - `status: PlantStatus|null`
    - `readings: Record<string, number>`
    - `trends: Trends`
    - `events: PlantEvent[]` (the last 200, unique by `seq`)
    - `pending: Map<commandKey, value>`
    - `toast`, `score`, `endReason`, `conn`
  - Actions: `server(msg)`, `conn(c)`, `startClicked`, `sent(commandKey, value)`, `dismissToast`.
  - The session is derived from status: phase `handover` → handover, `running` or `paused` → room, `over` or a `gameEnd` event → over.
- **Trends:** `Trends` is a ring buffer of 600 points per sensor id.

- [ ] **Step 1: Failing tests (Review Focus 1, 4).**
  - Frames update readings and trends.
  - Duplicate events (same `seq`) are kept once.
  - Status phases drive the session.
  - `gameEnd` mid-room switches to `over` with its score.
  - `commandRejected` sets a toast and clears that pending entry.
  - The socket stub reconnects with the backoff sequence and sends `resume` with the stored id.
  - `send` while closed returns false.
  - An invalid server message is ignored.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): socket client with resume and game store`

---

### Task 3: Equipment drawings and the wall

**Files:** Create `src/equipment/*.tsx`, `src/wall/{Wall,Monitor,AlarmStrip}.tsx`, `src/alarms/rules.ts`, `test/alarms.test.ts`, `test/wall.test.tsx`.

**Interfaces:**
- **Equipment components:** `<Intake status readings/>` and the other five. Each is a pure SVG drawing following the mockup, with live values bound to readings and status:
  - Brine levels and tank levels fill.
  - The flame scales with firing.
  - A stage's tint shows its scale thickness (amber at 0.3 mm or more, red at 0.6 mm or more).
  - Pumps show running or stopped and wear.
  - An algae density drawing follows chlorophyll.
  - A missing reading renders "—" (Review Focus 4).
- **Alarm rules:** `rules.ts` exports `alarmsFor(status, readings): Alarm[]`, where `Alarm = { id, monitor: MonitorId, level: 'warn'|'bad', text }`. The client-side rules:
  - TBT ≥ 112 is warn and ≥ 116 is bad.
  - Any stage level ≥ 0.5 is warn and ≥ 0.65 is bad.
  - Vacuum < 0.8 is warn and < 0.7 is bad.
  - Intake flow below required is bad, and within 5 % of it is warn.
  - Screen fouling ≥ 0.3 is warn and ≥ 0.5 is bad.
  - Chlorophyll ≥ 4 is warn.
  - Max hard scale ≥ 0.3 mm is warn and ≥ 0.6 mm is bad.
  - Salinity ≥ 80 % of the limit is warn, and above the limit is bad.
  - Backup tank < 40 t is warn and < 10 t is bad.
  - A gas curtailment notice is warn.
  - Status `tripped` is bad, on the Shift monitor.
  - Balance < $5,000 is warn and < $0 is bad.
  - Any controller-fault hint is warn.
- **Wall:** `<Wall/>` lays out the six `<Monitor id onOpen>` in a 3 × 2 grid, each with a border and light from its worst alarm. `<AlarmStrip alarms onOpen/>`.

- [ ] **Step 1: Failing tests.**
  - Each alarm rule triggers at its threshold and not below it.
  - A monitor's border class follows its worst alarm.
  - Each equipment component renders without throwing with empty readings (Review Focus 4), and with a sample frame shows the key values (e.g. "108.0 °C").
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS). Then check visually with `pnpm --filter @desal/web dev` against the local stack (Plan 2's simulator and gateway) and compare with `docs/design/monitor-wall-v2.html`.
- [ ] **Step 5: Commit** `feat(web): equipment drawings, monitor wall, client-side alarms`

---

### Task 4: Expanded views with trends

**Files:** Create `src/expanded/*.tsx`, `src/controls/Trend.tsx`, `test/expanded.test.tsx`.

**Interfaces:**
- **Common behaviour:** each expanded view shows a large version of its equipment drawing with detail and two or three trends (`<Trend data/>`, an SVG sparkline over the last 10 minutes), plus its controls region (filled in Task 5). Esc and Back return to the wall. The view keeps rendering if a status or reading is missing.
- **Per view:**
  - **StagesView:** all 20 stages in two rows of 10. Each stage shows its temperature, level and soft and hard scale. It also shows the condenser line, the distillate trough, ball-cleaning state, and CF.
  - **IntakeView:** three pumps (running, wear, cavitation), screen fouling, chlorophyll, intake flow against required, and seawater temperature.
  - **HeaterView:** TBT against setpoint, firing, heat MW, burner condition, active fuel, and changeover progress.
  - **ProductView:** flow, salinity against the limit, divert state, and this shift's water against target.
  - **FuelView:** gas cap and price, the curtailment notice, backup tonnes and offered grade, deliveries in transit (tonnes, arrives in N plant-minutes), and cost per m³.
  - **ShiftView:** shift number, time left, target progress, balance, this shift's revenue, fuel cost and fines, mode, plant status and restart step, trip cause, and the event log (the last 20 events in plain language, e.g. "Bloom: chlorophyll rising toward 8 µg/L").

- [ ] **Step 1: Failing tests.**
  - Each view renders with a sample status and frame and shows its key values.
  - Each renders with null status without throwing.
  - The event log maps every `PlantEvent` type to a plain sentence; unknown types are skipped (Review Focus 4).
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): expanded monitor views with trends and event log`

---

### Task 5: Controls

**Files:** Create `src/controls/{Setpoint,Toggle,Stepper,ActionButton}.tsx`. Modify `src/expanded/*.tsx`. Test: `test/controls.test.tsx`.

**Interfaces:**
- **Control widgets:**
  - `<Setpoint label loop value reported min max step unit onCommit/>` is a number field with − and + buttons and Enter to send. It shows the reported value, a pending "sending…" and range limits from `LOOP_RANGES`. Mirror those ranges in `src/limits.ts` with a comment pointing at the simulator.
  - `<Toggle>` is for on/off controls.
  - `<ActionButton confirm?>` is for actions with cost or risk, and shows the cost when one applies.
- **Controls per view:**
  - **IntakeView:**
    - Intake flow (`controlFor`).
    - Pump start and stop for each pump.
    - Overhaul for each pump, shown when the pump is stopped, with cost $8,000.
    - Chlorine and antiscalant doses.
  - **HeaterView:** TBT or firing (`controlFor`) and the tbt loop mode toggle.
  - **StagesView:**
    - Recirculation (`controlFor`).
    - Level setpoints, either all at once or per stage.
    - Ball cleaning, and blowdown CF (`controlFor`).
    - Vacuum (`controlFor`).
    - Loop-mode toggles (Auto mode only).
    - Acid clean, shown when tripped, with cost $6,000.
  - **ProductView:** divert to drain.
  - **FuelView:** select gas or backup (disabled during a changeover) and order backup fuel (tonnes field, with the live cost shown as `tonnes × LHV × price`; disabled when unaffordable).
  - **ShiftView:**
    - Restart: Auto shows one button. Manual shows four step buttons, and only the next valid step is enabled (Review Focus 5).
    - Manual trip, with a confirm.
    - Pause and resume.
    - Quit run, with a confirm.
- **Pending and rejection:** every send records a pending entry. The next status that reports the new value clears it. A `commandRejected` clears it and shows a toast with the reason, and the control reverts to the reported value (Review Focus 2).

- [ ] **Step 1: Failing tests.**
  - In Auto, a setpoint control sends `setSetpoint`; in Manual it sends `setOutput`.
  - Only the next Manual restart step button is enabled.
  - The order button is disabled when unaffordable.
  - A rejection shows a toast and reverts the control.
  - The overhaul button is hidden while the pump runs.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): operator controls with pending and rejection handling`

---

### Task 6: Start, handover and game-over screens

**Files:** Create `src/screens/{Start,Handover,GameOver}.tsx`. Modify `App.tsx`. Test: `test/screens.test.tsx`.

**Interfaces:**
- **Start:** a title, three lines on what you're doing ("You run a seawater desalination plant. Hit each shift's water target without running out of money or breaking the plant. Each shift gets harder."), and a "Start a run" button. A capacity error shows a retry button.
- **Handover**, before shift 1 and after each shift:
  - The last shift's summary from its `shiftEnd` event: water against target, revenue, fines, fuel, trips and damage.
  - The plant's condition: worst stage scale, pump wear, burner condition, and backup fuel.
  - The next shift's target, shown when known. Status carries the target only once the shift starts, so before the first shift show "Target: ~3,900 m³" from the formula in `src/limits.ts`, with a comment.
  - The balance, a mode choice (Auto or Manual, with one line on each), and "Start shift N".
  - "Quit run" is always there.
- **GameOver:** the reason in plain words ("The account ran dry", "No fuel left and no money to buy more", "The burner gave out", "No working intake pumps", "You ended the run", "Connection lost", "Something went wrong"). The score: shifts completed (big), water delivered, balance. Then "Play again", which clears `sessionStorage` and returns to start.

- [ ] **Step 1: Failing tests.** Each screen renders from sample state. Play again clears the stored gameId. Every `GameEndReason` has a sentence.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): start, handover and game-over screens`

---

### Task 7: Control room assembly and end-to-end smoke

**Files:** Create `src/screens/ControlRoom.tsx`, `src/ui/{Toast,Overlay}.tsx`, an error boundary in `App.tsx`, and `e2e/play.spec.ts`.

**Interfaces:**
- **ControlRoom:** shows the wall, or one expanded view, with the alarm strip and a top bar. The top bar shows shift N, plant time, time left in the shift, balance, mode, and the connection light.
  - Esc closes the expanded view.
  - The reconnect overlay appears while the connection is not open.
  - A `gameEnd` switches the app to GameOver at once, even when a monitor is expanded (Review Focus 3).
- **Error boundary:** it shows "Something went wrong, reload", and the game stays resumable because `sessionStorage` still holds the gameId.
- **Playwright:** `e2e/play.spec.ts` runs against the local stack: Kafka, the simulator and gateway from Plan 2, and `vite preview` with `VITE_WS_URL`. It:
  1. starts a run and starts shift 1 in Auto;
  2. sees the wall with six monitors and a non-empty TBT reading;
  3. opens Flash Stages and closes it with Esc;
  4. raises the TBT setpoint and sees the reported setpoint change;
  5. reloads the page and is back in the same game (same gameId shown in a `data-game-id` attribute);
  6. quits and sees the game-over screen.

- [ ] **Step 1: Write** the Playwright spec. **Step 2:** Run it (FAIL). **Step 3:** Implement. **Step 4:** Run it (PASS), plus `pnpm --filter @desal/web test` and `build`, and check the bundle size (under 300 KB gzipped).
- [ ] **Step 5: Commit** `feat(web): control room assembly, overlays and end-to-end smoke`

---

### Task 8: Deploy the game publicly; Kafka UI moves to /kafka

**Files:** Modify `deploy/desal.caddy`, `deploy/compose.yml`, `scripts/deploy/deploy.sh`, `docs/hosting.md`, `README.md`.

**Interfaces:**
- **Build and ship:** `deploy.sh` builds `apps/web` locally with `VITE_WS_URL=wss://<host>/ws`, ships `dist/` to `/opt/desal/web-<commit>/`, points the symlink `/opt/desal/web` at it, and keeps the two newest.
- **Caddy:**
  - `/ws*` and `/healthz` go to the gateway, publicly.
  - `/kafka*` goes to Kafka UI, behind basic auth. Kafka UI gets `SERVER_SERVLET_CONTEXT_PATH: /kafka` in compose.
  - Everything else is a `file_server` from `/opt/desal/web`, with the SPA fallback `try_files {path} /index.html`. Assets under `/assets/*` are cached for a year (immutable); `index.html` is served `no-cache`.
  - The `X-Robots-Tag` noindex header is removed from the game paths.
- **Docs:** `docs/hosting.md` and `README.md` describe the public game, `/kafka` for the admin view, and the deploy steps.

- [ ] **Step 1:** Run `scripts/deploy/deploy.sh`.
- [ ] **Step 2: Verify.**
  - `curl -s https://desal.moosha.org/ | grep -q '<div id="root">'`
  - `curl -s -o /dev/null -w '%{http_code}' https://desal.moosha.org/kafka/` gives 401.
  - `/healthz` gives `ok`.
  - Run the Playwright spec against production with `BASE_URL=https://desal.moosha.org`, then quit the run.
  - `docker stats` shows every container under its cap.
- [ ] **Step 3: Commit** `feat(deploy): public control room at desal.moosha.org, Kafka UI at /kafka`
