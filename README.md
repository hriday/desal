# Desal Operator

A desalination-plant operator game. One simulator process runs many games at once (up to 10) in real time and publishes each game's sensors, status and events to Apache Kafka; players send commands back over Kafka, through a WebSocket gateway. The public game is at https://desal.moosha.org (hosting: [docs/hosting.md](docs/hosting.md)). The project is also a vehicle for learning Kafka (now) and Flink (later), see [docs/streaming-notes.md](docs/streaming-notes.md).

Design: [docs/superpowers/specs/2026-11-18-desal-operator-game-design.md](docs/superpowers/specs/2026-11-18-desal-operator-game-design.md).

## Layout

- `packages/schema`: shared zod schemas (commands, events, status, telemetry, the WebSocket protocol in `ws.ts`) and topic names (`TOPICS`).
- `services/simulator` (`@desal/simulator`): the multi-game host, its Kafka wiring (`src/kafka/`) and two CLIs (`src/cli/`: `send`, `watch`).
- `services/gateway` (`@desal/gateway`): WebSocket gateway between players and Kafka, plus a terminal game client (`play`).
- `apps/web` (`@desal/web`): the browser control room.
- `infra/docker-compose.yml`: single-node Kafka (KRaft), Kafka UI and a Flink session cluster for local development. `deploy/` and `scripts/deploy/`: the production stack, see [docs/hosting.md](docs/hosting.md).

Every record on every topic is keyed by `gameId`, which is how many games share one set of topics.

## Prerequisites

- Node 22 or newer
- pnpm
- Docker (with Compose)

## Setup

```sh
pnpm i
docker compose -f infra/docker-compose.yml up -d
```

Kafka listens on `localhost:9092`, Kafka UI is at http://localhost:8080 and the Flink web UI at http://localhost:8082. All bind to 127.0.0.1 only; nothing is exposed to the network. The first `up` builds the Flink image (`services/flink/Dockerfile`, Maven inside the build); after changing the jobs, use `up -d --build`. `up -d kafka kafka-ui` starts Kafka without Flink (about 1.8 GB less memory).

The Flink cluster starts with no jobs. Once the simulator has run once (it creates the topics the jobs read and write), submit both:

```sh
docker exec desal-flink-jobmanager flink-jobs.sh submit-all /flink-data/savepoints/last.txt
docker exec desal-flink-jobmanager flink-jobs.sh stop-all /flink-data/savepoints/last.txt   # stop both with savepoints; submit-all resumes from them
```

`submit-all` takes `--topic-suffix S` to run the jobs on suffixed topics. Flink's checkpoints and savepoints live in the volume `desal-flink-checkpoints`.

Stop the stack:

```sh
docker compose -f infra/docker-compose.yml down        # keeps data
docker compose -f infra/docker-compose.yml down -v     # also wipes data, i.e. every game's save
```

Kafka's data (`log.dirs`, set by `KAFKA_LOG_DIRS`, plus the KRaft metadata) lives in the named volume `desal-kafka-data` at `/var/lib/kafka/data`, so `down` / `up` and container recreates keep the saves. Only `down -v` (or `docker volume rm desal-kafka-data`) deletes it.

## Tests

```sh
pnpm test                                 # unit tests, no Kafka needed
pnpm typecheck
pnpm --filter @desal/simulator test:int   # integration tests, need the Docker stack running
pnpm --filter @desal/gateway test:int
pnpm --filter @desal/web e2e              # browser tests (Playwright); needs the simulator + gateway running, see apps/web/e2e/README.md
```

Integration tests set `DESAL_TOPIC_SUFFIX` to a unique value, so they create throwaway topics (and consumer groups such as `desal-sim<suffix>`) and never touch your real games.

End to end through Flink (simulator -> Kafka -> both Flink jobs -> gateway -> a test client; checks a real report card, rank and per-mode leaderboard arrive and that no runId or other game's gameId reaches the client):

```sh
scripts/e2e-flink.sh    # needs Docker, pnpm and jq; about a minute once the stack is up
```

It brings up Kafka and Flink, creates topics with a fresh `.e2e-<time>-<pid>` suffix, submits a second copy of both jobs on them and runs `services/gateway/test/flink.int.test.ts` (which `test:int` skips unless `DESAL_E2E_FLINK=1`). The cluster has two task slots, one per job, so if jobs are running it first stops them with savepoints (`flink-jobs.sh stop-all`) and resubmits them from those on exit (a failed resubmit is reported with `!!!` and fails the script); it also cancels its own jobs and deletes its topics on exit. It never rebuilds or recreates the Flink containers (`up -d --no-recreate`; a recreated container drops its running jobs): after changing the jobs, run `up -d --build` and resubmit first.

The Flink jobs (`services/flink`, Java 17 + Maven) need only Docker: `services/flink/mvn.sh` runs Maven in the `maven:3.9.11-eclipse-temurin-17` image with the repo mounted and dependencies cached in the `desal-m2` volume, so no JDK or Maven is installed on the host. `services/flink/mvn.sh test` runs the Java tests, which also rewrite the contract fixtures in `packages/schema/test/fixtures/flink/` that `pnpm --filter @desal/schema test` then validates with the zod schemas. `services/flink/mvn.sh package` builds `services/flink/target/desal-flink.jar`.

## Running it locally

With Kafka up (see Setup), in separate terminals:

```sh
pnpm --filter @desal/simulator start    # the simulator: creates topics, resumes saved games, ticks once per second
pnpm --filter @desal/gateway start      # WebSocket gateway on :8081 (/ws, /healthz); env PORT, KAFKA_BROKERS, ALLOWED_ORIGINS
pnpm --filter @desal/gateway play       # terminal game: starts a new game, prints a status line per second, type commands (optional --url ws://host/ws)
VITE_WS_URL=ws://localhost:8081/ws pnpm --filter @desal/web dev   # browser control room
```

Set `KAFKA_BROKERS` (comma-separated) to use a broker other than `localhost:9092`.

### The simulator

One tick runs per second per game and is 40 plant seconds. The simulator runs at most 10 games at once; a game is created by a `startGame` command and ended by a `quitGame`, a game over, or 90 s without a heartbeat (the gateway sends heartbeats for each connected game). Ctrl-C writes a final snapshot of every live game and exits.

Saves live in the compacted `plant.state` topic, keyed by `gameId`: each game's latest record is its save. On start the simulator reads the topic to the end and resumes every game whose newest save restores (`loadGames`/`pickGames`). Every snapshot is validated before it is written; a state that would not restore (e.g. a NaN) is never written for that game (a warning is logged), so its previous save stays. If a game's newest save is invalid, the simulator falls back to its newest valid one and logs which saves it skipped. When a game ends, a tombstone (null value) is written for its key, so it is not resumed and compaction later removes its saves. Old single-career (v1) saves are keyed `plant-1` and have save version 1; they are skipped with a log line, never loaded, as are version 2 saves (the current version is 3).

If Kafka goes down mid-run, all games freeze and the failed tick is retried until Kafka acknowledges it again. Errors that retrying cannot fix halt the simulator instead: an exception inside the host itself, or a produce error the broker will never accept (message too large, invalid record, authorization or authentication failure). It logs `FATAL`, writes a final snapshot of every game, and exits with status 1. An exception inside one game's plant model only ends that game.

An Auto (one-button) restart gives up on a step that makes no progress for 90 ticks (1 plant hour; in the ramp, progress means TBT still climbing): it emits `restartProgress` with `ok: false` and a reason, and the plant goes back to `tripped` without trip damage, so you can fix the cause and restart again. Putting the firing (`tbt`) loop in manual during an Auto ramp hands the firing to you, policed by the same ramp-rate limits as a Manual restart.

Each shift starts with fresh supply conditions and healthy controllers: gas back at 60 MW and the base price with no pending curtailment, and no loop faults. Physical damage (scale, pump and burner wear, bearing wear, the backup tank level) carries over. A restart still in progress at handover is abandoned when the next shift starts: the plant is back to `tripped` (no damage) and can be restarted in the new shift's mode.

### Events, hell shifts and the crew

Each shift's plan is drawn from the game's seed when the previous shift ends (shift 1's when the game is created), so the orders at handover can hint at it, and `startShift` activates it: 1 or 2 events in a normal shift (shift 1 has one gentle one), always including a sharp one (pump trip, tube leak, vacuum loss, power dip, storm or sensor failure). A director fires them: in a normal shift it waits until the plant has settled from the last one. From shift 2 a shift can be a hell shift (10 % at first, up to 45 %): 4 to 6 events close together, some setting each other off, with the water target cut by 15 %. Hell shifts are warned in the orders 70 % of the time, and never come twice in a row. The shift orders (target, fuel budget, a few lines) are shown at handover. Each event arrives as a radio message. Some are fixed by the player (restart a pump, put a loop in Manual), others need the one maintenance crew: `dispatchCrew` with a job (`plugTubes`, `repairEjector`, `replaceSensor`, `cleanScreens`) costs $300 to $1,000 and takes 30 to 60 plant minutes, and is only accepted when its fault exists. Staff and standby cost $90 per plant hour whatever the plant is doing. The operating point is a 93.5 °C top brine temperature (TBT) with a setpoint range of 85 to 112 °C; scale grows severely above 105 °C, where hard scale starts, and TBT trips the plant at 115 °C. The events and their fields are the contract in [docs/streaming-notes.md](docs/streaming-notes.md).

### The gateway

Each gateway process consumes telemetry, status and events for all games with its own consumer group (`desal-gateway-<random id>`, deleted on exit), forwards each game's records to the sockets bound to it, and produces client commands to `plant.commands`. Per client (IP address) it allows one new game per 10 s and 3 live games.

## CLI (talking to Kafka directly)

Start a game (prints the new game id), then send commands to it. A command is wrapped in an envelope addressed to the game's current shift, read from its latest `plant.status`; the simulator validates it and answers invalid ones with a `commandRejected` event:

```sh
pnpm --filter @desal/simulator send --new
pnpm --filter @desal/simulator send --game <gameId> '{"type":"startShift","mode":"auto"}'
```

Live-tail a topic, pretty-printed, optionally for one game (Ctrl-C to quit):

```sh
pnpm --filter @desal/simulator watch                                  # events of all games (default)
pnpm --filter @desal/simulator watch status --game <gameId>
pnpm --filter @desal/simulator watch telemetry <sensorId> --game <gameId>
```

## Troubleshooting

### `pnpm i` hangs on `@confluentinc/kafka-javascript`

At install the package downloads a prebuilt native binary from github.com. On a network where that is blocked the install hangs. Build the binding from source instead, from inside the package directory under `node_modules/.pnpm`:

```sh
CKJS_LINKING=dynamic PKG_CONFIG_PATH=/opt/homebrew/opt/openssl@3/lib/pkgconfig \
  node-pre-gyp rebuild --build-from-source --nodedir=~/Library/Caches/node-gyp/<node-version>
```

Notes from the machine where this was needed:

- `CKJS_LINKING=dynamic` is required: the default static build downloads zlib, which hits the same blocked network.
- `PKG_CONFIG_PATH` points at Homebrew's OpenSSL 3 (macOS, Apple Silicon path); adjust for your system.
- `node-pre-gyp` needed a `node-gyp` available on `PATH` (a small shim was used), and `--nodedir` points at the Node headers that node-gyp cached for your Node version.
- After the binary exists, `pnpm i` is a no-op.

### A topic has the wrong config

`ensureTopics` only creates missing topics; it does not change existing ones, and the JS admin client cannot alter configs. Use the broker CLI, see the comment above `ensureTopics` in `services/simulator/src/kafka/client.ts` for the exact `kafka-configs.sh --alter` command.
