# Hosting: desal.moosha.org

desal runs on one Ubuntu 24.04 server (DigitalOcean, `68.183.200.37`, 1 vCPU, 2 GB RAM plus a 2 GB swapfile).
`scripts/deploy/deploy.sh` puts it there from this machine. DNS: an A record for `desal.moosha.org` points at the server.

**https://desal.moosha.org is the public game**: the browser control room at `/`, talking to the gateway over
WebSocket at `wss://desal.moosha.org/ws` (no login; `/healthz` answers `ok`). The admin view, **Kafka UI, is at
https://desal.moosha.org/kafka behind basic auth**, so you can watch the live plant's topics. Kafka UI can also
*produce* messages, which is a way to send operator commands to the simulator (see "Sending commands"). It can also
delete topics, and `plant.state` holds every game's save, so be careful.

| Path | Goes to | Auth |
| --- | --- | --- |
| `/ws`, `/healthz` | gateway (`127.0.0.1:8081`) | none (public) |
| `/kafka` | Kafka UI (`127.0.0.1:8080`, context path `/kafka`) | basic auth, `X-Robots-Tag: noindex` |
| everything else | static files in `/opt/desal/web`, with `index.html` as the SPA fallback | none |

Hashed files under `/assets/` are cached for a year (immutable); `index.html` is `no-cache`. Caddy sets
`X-Forwarded-For` to the client address, which the gateway uses for its per-client limits.

## What is on the server

Everything desal adds is named `desal*`. Nothing else runs on the server (the previous app, `reserve`, was removed on
2026-11-18; its backup is in `/root/backups/reserve-2026-11-18/` and on the laptop at `~/backups/reserve-2026-11-18/`).

| What | Where |
| --- | --- |
| The stack | compose project `desal` in `/opt/desal` (`compose.yml`, `.env` with `SIMULATOR_IMAGE` and `GATEWAY_IMAGE`) |
| The web app | `/opt/desal/web-<commit>/` (built on the laptop, two newest kept); `/opt/desal/web` is a symlink to the live one |
| Source trees | `/opt/desal/src-<commit>/` (the two newest are kept; images are built from them) |
| Images | `desal-simulator:<commit>` and `desal-gateway:<commit>` (two newest of each kept), `apache/kafka:4.1.1`, `kafbat/kafka-ui:v1.3.0` |
| Data | Docker volume `desal_kafka-data`: every topic, including the game saves (`plant.state`) |
| Basic-auth credentials | `/opt/desal/basic-auth.txt` (mode 600; user `operator`) |
| Caddy | `/etc/caddy/sites/desal.caddy`, imported by `import /etc/caddy/sites/*.caddy` in `/etc/caddy/Caddyfile`. Caddy runs on the host, holds ports 80 and 443, and gets the TLS certificate itself |
| Swap | `/swapfile` (2 GB, in `/etc/fstab`), `vm.swappiness=10` in `/etc/sysctl.d/99-desal-swap.conf` |

Containers and their caps:

| Container | Memory cap | Notes |
| --- | --- | --- |
| `desal-kafka` | 768 MB | heap 384 MB; `127.0.0.1:9092` |
| `desal-simulator` | 256 MB | 30 s stop grace (final snapshots) |
| `desal-gateway` | 192 MB | `127.0.0.1:8081`; 15 s stop grace; `ALLOWED_ORIGINS=https://desal.moosha.org` |
| `desal-kafka-ui` | 384 MB | heap 192 MB; `127.0.0.1:8080`, served under `/kafka` |

Everything listens on `127.0.0.1` only; the internet reaches the gateway, Kafka UI and the static files only through
Caddy (Kafka UI behind basic auth). Kafka is never exposed.

## Deploying

```bash
scripts/deploy/deploy.sh          # deploys the committed HEAD
```

It needs `pnpm` and installed dependencies on this machine. It builds the web app locally
(`VITE_WS_URL=wss://<host>/ws pnpm --filter @desal/web build`) and ships `apps/web/dist` to `/opt/desal/web-<commit>/`,
then ships `git archive HEAD` (uncommitted changes are not deployed), builds the simulator and gateway images on the
server, writes `/opt/desal/compose.yml` and `.env`, atomically repoints the `/opt/desal/web` symlink, installs the Caddy
site (generating credentials the first time), reloads Caddy and runs `docker compose up -d`. It then waits for
`curl http://127.0.0.1:8081/healthz` to return `ok` on the server and prints the URL. The simulator gets SIGTERM on
redeploy and writes final snapshots first (30 s grace), so a redeploy resumes every game where it was.

A redeploy that changes the snapshot version (it is 3 since the chaos events) is the exception: older saves are skipped, so games in flight at that deploy end.

**One-off, after the first deploy of this version:** `plant.state` may still hold single-career (v1) records from before
games existed. The simulator's `loadGames` skips records it does not recognise, so this is harmless. Also run once on
the server, so snapshots and tombstones in `plant.state` compact within about an hour (the simulator only sets these
configs when it creates the topic, and the existing topic predates them):

```bash
docker exec desal-kafka /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:9092 \
  --entity-type topics --entity-name plant.state --alter \
  --add-config segment.ms=3600000,min.cleanable.dirty.ratio=0.1
```

**One-off, retention bounds for `plant.commands` and `plant.events`.** Players write to `plant.commands` (through the
gateway), and every rejected command adds a `commandRejected` to `plant.events`, so both topics are capped by size as
well as time. The simulator sets this only when it creates a topic (`ensureTopics` cannot alter an existing one), so on
a server whose topics predate it, run once:

```bash
docker exec desal-kafka /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:9092 \
  --entity-type topics --entity-name plant.commands --alter \
  --add-config retention.ms=86400000,retention.bytes=268435456
docker exec desal-kafka /opt/kafka/bin/kafka-configs.sh --bootstrap-server localhost:9092 \
  --entity-type topics --entity-name plant.events --alter \
  --add-config retention.ms=604800000,retention.bytes=268435456
```

`plant.commands` keeps 24 h and at most 256 MiB; `plant.events` keeps its 7-day time retention (so Flink jobs can replay
a week) and at most 256 MiB per partition. Check with `--describe` instead of `--alter ...`.

Override the target with `DESAL_SERVER=root@host` and `DESAL_HOST=name`.

**Rolling back:** check out the earlier commit and run `deploy.sh` again, or on the server set `SIMULATOR_IMAGE` and
`GATEWAY_IMAGE` in `/opt/desal/.env` to the previous `<commit>` tags, repoint the symlink
(`ln -sfn web-<commit> web.new && mv -T web.new web` in `/opt/desal`) and run `docker compose up -d`.

## Operating

```bash
ssh root@68.183.200.37
cd /opt/desal
docker compose ps
docker logs -f desal-simulator
docker logs -f desal-gateway
curl -s http://127.0.0.1:8081/healthz   # ok
cat basic-auth.txt                      # Kafka UI (/kafka) login
```

**Playing.** Normally just open https://desal.moosha.org. From a terminal, the CLI client talks to the public gateway:

```bash
pnpm --filter @desal/gateway play --url wss://desal.moosha.org/ws
```

**Admin: talking to Kafka directly.** Run the CLIs over an SSH tunnel from the laptop:

```bash
ssh -N -L 9092:localhost:9092 root@68.183.200.37 &
pnpm --filter @desal/simulator send --new                                   # starts a game, prints its id
pnpm --filter @desal/simulator send --game <gameId> '{"type":"startShift","mode":"auto"}'
pnpm --filter @desal/simulator watch events --game <gameId>
```

Or, in Kafka UI, produce to `plant.commands` with key `<gameId>` and a value like
`{"commandId":"<uuid>","issuedAt":0,"gameId":"<gameId>","shiftId":null,"command":{"type":"startShift","mode":"auto"}}`.
`gameId` in the value must match the key. `shiftId` must be the game's current shift id for everything except
`startGame` (which takes `null`); read it from the latest `plant.status` message with that key. A new game is
`startGame` with a fresh UUID as `gameId`.

**Kafka/Flink dashboards over SSH:** `ssh -N -L 8080:localhost:8080 root@68.183.200.37` then http://localhost:8080/kafka
(no basic auth on the tunnel; the UI is served under `/kafka` everywhere).

## Backups

Each game's save is the latest record for its game id in the compacted `plant.state` topic, inside the
`desal_kafka-data` volume. To copy the
whole volume:

```bash
ssh root@68.183.200.37 'cd /opt/desal && docker compose stop simulator kafka \
  && docker run --rm -v desal_kafka-data:/d -v /root/backups:/b alpine tar czf /b/desal-kafka-$(date +%F).tgz -C /d . \
  && docker compose start kafka simulator'
```

The simulator writes a final snapshot when stopped, so stop it before Kafka.

## Removing desal

```bash
cd /opt/desal && docker compose down -v --rmi all     # -v deletes every save
rm -rf /opt/desal /etc/caddy/sites/desal.caddy && systemctl reload caddy
```
