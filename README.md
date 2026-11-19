# Desal Operator

A desalination-plant operator game. A deterministic plant simulator runs in real time and publishes its sensors, status and events to Apache Kafka; the operator sends commands back over Kafka. The project is also a vehicle for learning Kafka (now) and Flink (later), see [docs/streaming-notes.md](docs/streaming-notes.md).

Design: [docs/superpowers/specs/2026-11-18-desal-operator-game-design.md](docs/superpowers/specs/2026-11-18-desal-operator-game-design.md).

## Layout

- `packages/schema`: shared zod schemas, topic names (`TOPICS`) and the plant key (`PLANT_KEY`).
- `services/simulator` (`@desal/simulator`): the simulator, its Kafka wiring (`src/kafka/`) and two CLIs (`src/cli/`).
- `infra/docker-compose.yml`: single-node Kafka (KRaft) and Kafka UI.

## Prerequisites

- Node 22 or newer
- pnpm
- Docker (with Compose)

## Setup

```sh
pnpm i
docker compose -f infra/docker-compose.yml up -d
```

Kafka listens on `localhost:9092` and Kafka UI is at http://localhost:8080. Both bind to 127.0.0.1 only; nothing is exposed to the network.

Stop the stack:

```sh
docker compose -f infra/docker-compose.yml down        # keeps data
docker compose -f infra/docker-compose.yml down -v     # also wipes data, i.e. the career save
```

Kafka's data (`log.dirs`, set by `KAFKA_LOG_DIRS`, plus the KRaft metadata) lives in the named volume `desal-kafka-data` at `/var/lib/kafka/data`, so `down` / `up` and container recreates keep the career. Only `down -v` (or `docker volume rm desal-kafka-data`) deletes it.

## Tests

```sh
pnpm test                                 # unit tests, no Kafka needed
pnpm typecheck
pnpm --filter @desal/simulator test:int   # integration tests, need the Docker stack running
```

Integration tests set `DESAL_TOPIC_SUFFIX` to a unique value, so they create throwaway topics (and a consumer group `desal-sim<suffix>`) and never touch your real career.

## Running the simulator

```sh
pnpm --filter @desal/simulator start                 # resume the saved career, or start a fresh one
pnpm --filter @desal/simulator start --new-career    # discard the save and start over
```

One tick runs per second and is 40 plant seconds. Ctrl-C saves a final snapshot and exits.

The career save is the latest record (key `plant-1`) of the compacted `plant.state` topic. If the save is corrupt the simulator refuses to start and tells you to use `--new-career` (the old record stays in the topic history until compaction removes it).

If Kafka goes down mid-run, the plant freezes and retries the failed tick until Kafka acknowledges it again. Errors that retrying cannot fix halt the simulator instead: an exception inside the plant model, or a produce error the broker will never accept (message too large, invalid record, authorization or authentication failure). It logs `FATAL`, writes a final snapshot of the last good state, and exits with status 1.

An Auto (one-button) restart gives up on a step that makes no progress for 90 ticks (1 plant hour; in the ramp, progress means TBT still climbing): it emits `restartProgress` with `ok: false` and a reason, and the plant goes back to `tripped` without trip damage, so you can fix the cause and restart again. Putting the firing (`tbt`) loop in manual during an Auto ramp hands the firing to you, policed by the same ramp-rate limits as a Manual restart.

Each shift starts with fresh supply conditions and healthy controllers: gas back at 60 MW and the base price with no pending curtailment, and no loop faults. Physical damage (scale, pump and burner wear, bearing wear, the backup tank level) carries over. A restart still in progress at handover is abandoned when the next shift starts: the plant is back to `tripped` (no damage) and can be restarted in the new shift's mode.

Set `KAFKA_BROKERS` (comma-separated) to use a broker other than `localhost:9092`.

## CLI

Send a command (it is wrapped in an envelope addressed to the current shift, read from the latest `plant.status`; the simulator validates it and answers invalid ones with a `commandRejected` event):

```sh
pnpm --filter @desal/simulator send '{"type":"startShift","mode":"auto"}'
```

Live-tail a topic, pretty-printed (Ctrl-C to quit):

```sh
pnpm --filter @desal/simulator watch                          # events (default)
pnpm --filter @desal/simulator watch status
pnpm --filter @desal/simulator watch telemetry <sensorId>
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
