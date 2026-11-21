# Hosting: desal.moosha.org

desal runs on one Ubuntu 24.04 server (DigitalOcean, `68.183.200.37`, 2 vCPU, 3.9 GB RAM plus a 2 GB swapfile).
`scripts/deploy/deploy.sh` puts it there from this machine. DNS: an A record for `desal.moosha.org` points at the server.

**https://desal.moosha.org is the public game**: the browser control room at `/`, talking to the gateway over
WebSocket at `wss://desal.moosha.org/ws` (no login; `/healthz` answers `ok`). The admin view, **Kafka UI, is at
https://desal.moosha.org/kafka behind basic auth**, so you can watch the live plant's topics, and the **Flink web UI is
at https://desal.moosha.org/flink/ behind the same basic auth**, showing the report-card and leaderboard jobs. Kafka UI can also
*produce* messages, which is a way to send operator commands to the simulator (see "Sending commands"). It can also
delete topics, and `plant.state` holds every game's save, so be careful.

| Path | Goes to | Auth |
| --- | --- | --- |
| `/ws`, `/healthz`, `/api/leaderboard` | gateway (`127.0.0.1:8081`) | none (public) |
| `/kafka` | Kafka UI (`127.0.0.1:8080`, context path `/kafka`) | basic auth, `X-Robots-Tag: noindex` |
| `/flink/` (`/flink` redirects there) | Flink jobmanager web UI and REST API (`127.0.0.1:8082`; Caddy strips `/flink`) | basic auth, `X-Robots-Tag: noindex` |
| everything else | static files in `/opt/desal/web`, with `index.html` as the SPA fallback | none |

Hashed files under `/assets/` are cached for a year (immutable); `index.html` is `no-cache`. Caddy sets
`X-Forwarded-For` to the client address, which the gateway uses for its per-client limits.

## What is on the server

Everything desal adds is named `desal*`. Nothing else runs on the server (the previous app, `reserve`, was removed on
2026-11-18; its backup is in `/root/backups/reserve-2026-11-18/` and on the laptop at `~/backups/reserve-2026-11-18/`).

| What | Where |
| --- | --- |
| The stack | compose project `desal` in `/opt/desal` (`compose.yml`, `.env` with `SIMULATOR_IMAGE`, `GATEWAY_IMAGE` and `FLINK_IMAGE`) |
| The web app | `/opt/desal/web-<commit>/` (built on the laptop, two newest kept); `/opt/desal/web` is a symlink to the live one |
| Source trees | `/opt/desal/src-<commit>/` (the two newest are kept; images are built from them) |
| Images | `desal-simulator:<commit>`, `desal-gateway:<commit>` and `desal-flink:<commit>` (two newest of each kept), `apache/kafka:4.1.1`, `kafbat/kafka-ui:v1.3.0` |
| Data | Docker volume `desal_kafka-data`: every topic, including the game saves (`plant.state`) |
| Flink state | Docker volume `desal_flink-checkpoints` at `/flink-data`: `checkpoints/`, `savepoints/`, `savepoints/last.txt` (the savepoints the last deploy took) and `jobs.txt` (the job ids submit-all started, to find their checkpoints) |
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
| `desal-flink-jobmanager` | 700 MB | Flink process 640 MB (heap 128 MB); `127.0.0.1:8082` (REST + web UI), served under `/flink`; `web.submit.enable: false` |
| `desal-flink-taskmanager` | 1100 MB | Flink process 1024 MB, 2 slots (task heap 192 MB, managed 64 MB); state on the heap (`hashmap`) |

Everything listens on `127.0.0.1` only; the internet reaches the gateway, Kafka UI, the Flink UI and the static files
only through Caddy (Kafka UI and Flink UI behind basic auth). Kafka is never exposed.

### Flink

A Flink 2.2.1 session cluster: `desal-flink-jobmanager` schedules jobs, coordinates checkpoints and serves the REST API
and web UI; `desal-flink-taskmanager` runs the jobs in its 2 slots. Both run the `desal-flink:<commit>` image
(`services/flink/Dockerfile`: `flink:2.2.1-java17` plus the jobs' jar at `/opt/flink/usrlib/desal-flink.jar` and
`/opt/flink/bin/flink-jobs.sh`). Two jobs run on it, both reading and writing Kafka at `kafka:29092`:

- `report-card` (`org.desal.flink.reportcard.ReportCardJob`): `plant.events` + `plant.status` into `shift.reports` and `run.results`;
- `leaderboard` (`org.desal.flink.leaderboard.LeaderboardJob`): `run.results` + `plant.status` into `leaderboard` and `run.ranks`.

The game never needs Flink: with it down, handover shows the plain debrief and the start screen "Leaderboard offline".
Each job checkpoints every minute to `/flink-data/checkpoints/<jobId>/chk-<n>` (the shared volume), so a crashed task
or taskmanager restarts from its last checkpoint by itself.

**Jobmanager restarts.** The session cluster has no high availability: a jobmanager that restarts (host reboot, Docker
restart, crash; `restart: unless-stopped` brings it back) comes back with no jobs. Checkpoints are retained when a job
is cancelled or the jobmanager goes away (`execution.checkpointing.externalized-checkpoint-retention:
RETAIN_ON_CANCELLATION`), and the image's entrypoint (`/opt/flink/bin/desal-entrypoint.sh`) runs
`flink-jobs.sh submit-all /flink-data/savepoints/last.txt` in the background each time the jobmanager starts, once
both task slots have registered (and only if the jobs have run there before). `submit-all` restores each job from its
newest state: the newest complete checkpoint (`chk-<n>` with a `_metadata` file) of its last run, if that is newer
than its savepoint in `last.txt`, else that savepoint. It finds a run's checkpoints through `/flink-data/jobs.txt`,
where every submit records `name=jobId` (the last two per job). So after a reboot both jobs come back by themselves,
at most a minute behind; `docker logs desal-flink-jobmanager | grep auto-submit` shows what it did. If it printed
`!!!`, rerun `docker exec desal-flink-jobmanager flink-jobs.sh submit-all /flink-data/savepoints/last.txt` by hand.
After submitting, `submit-all` deletes the checkpoint directories of jobs that are neither running nor recorded in
`jobs.txt`, and keeps only the newest complete checkpoint of a recorded job that is not running.

**Flink memory.** Container caps above; what they really use (`docker stats --no-stream` on the server, filled in at the
first deploy):

| Container | Cap | Used, idle | Used, with games running |
| --- | --- | --- | --- |
| `desal-flink-jobmanager` | 700 MB | 332 MB | 336 MB |
| `desal-flink-taskmanager` | 1100 MB | 389 MB | 433 MB |

(Measured 2026-11-21 just after the first Flink deploy, with one game running; the host then had 1.55 GB available
and 22 MB of swap in use. Re-measure with several games if the server ever feels tight.)

(On the laptop, both jobs running and no games: jobmanager 409 MB, taskmanager 546 MB.)

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

**Flink on deploy.** It also builds `desal-flink:<commit>` on the server (Maven runs inside the image build). Before
`docker compose up`, if the jobmanager is running, it stops both jobs with savepoints
(`flink-jobs.sh stop-all /flink-data/savepoints/last.txt`: `flink stop` takes a savepoint, a snapshot of the job's
state, then stops the job; the paths go to `last.txt`). A session cluster forgets its jobs when it restarts, so after
`up` it waits (up to 120 s) for `127.0.0.1:8082/overview` to show a taskmanager and resubmits both
(`flink-jobs.sh submit-all /flink-data/savepoints/last.txt`), each from its savepoint, so open shifts and the boards
carry over. (The new jobmanager's entrypoint runs the same `submit-all` as it starts; a lock makes the two take turns
and the second finds both jobs running.) If a savepoint no longer fits the new job (the leaderboard's SQL operators get their ids from the query,
so changing a query can do this), the script prints `!!! leaderboard: savepoint incompatible, starting fresh` and
submits it without one: the board rebuilds from the compacted `run.results` topic. It never skips state with
`--allowNonRestoredState`. A job already running is never submitted twice. A job that was not running at
`stop-all` (or whose stop failed) keeps its line from the previous `last.txt`, so it resumes from its last savepoint.
Every savepoint `last.txt` names is kept, plus the previous deploy's; older ones are deleted.

Flink problems print lines starting `!!!` but never fail the deploy. If the Flink image does not build, the previous
one keeps running (on a first deploy, the stack starts without Flink). To redo the Flink step by hand:

```bash
docker exec desal-flink-jobmanager flink-jobs.sh stop-all /flink-data/savepoints/last.txt
docker exec desal-flink-jobmanager flink-jobs.sh submit-all /flink-data/savepoints/last.txt
```

To start a job with no state at all, cancel it in the UI (or `docker exec desal-flink-jobmanager flink cancel <jobId>`),
remove its lines from `/flink-data/savepoints/last.txt` and from `/flink-data/jobs.txt` (a cancelled job's checkpoints
are retained, and `submit-all` would otherwise restore from them), and run `submit-all`.

A redeploy that changes the snapshot version (it is 7 since Plan 8's divert mode, motive steam and standby line) migrates v3 to v6 saves, so their games resume; saves older than v3 are skipped, so such games in flight at that deploy end.

**Plan 8 (plant realism) deploy notes.**

- Browser tabs left open across this deploy need a reload: their bundled schemas are strict: `ScenarioKindSchema`
  rejects the new `lowSteam` kind and `AccountCauseSchema` the new `standbySteam` account cause, so an old tab drops those messages.
- Rolling the simulator back past this version (snapshot v7) rejects every version-7 save, so every live game ends
  on the rollback. Roll back only if that is acceptable.

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

**Rolling back:** check out the earlier commit and run `deploy.sh` again, or on the server set `SIMULATOR_IMAGE`,
`GATEWAY_IMAGE` and `FLINK_IMAGE` in `/opt/desal/.env` to the previous `<commit>` tags (run `stop-all` first and
`submit-all` after, as above), repoint the symlink
(`ln -sfn web-<commit> web.new && mv -T web.new web` in `/opt/desal`) and run `docker compose up -d`.

## Operating

```bash
ssh root@68.183.200.37
cd /opt/desal
docker compose ps
docker logs -f desal-simulator
docker logs -f desal-gateway
curl -s http://127.0.0.1:8081/healthz   # ok
cat basic-auth.txt                      # Kafka UI (/kafka) and Flink UI (/flink) login
curl -s http://127.0.0.1:8082/jobs/overview   # Flink jobs and their states
docker logs -f desal-flink-taskmanager
```

**Flink UI.** Open https://desal.moosha.org/flink/ (basic auth as for `/kafka`). It shows both jobs, their checkpoints
and exceptions; uploading and running jars is turned off (`web.submit.enable: false`), and Flink's REST port is only on
the server's `127.0.0.1:8082`. If the UI under `/flink` ever misbehaves, use the SSH tunnel instead (no basic auth, UI
at the root): `ssh -N -L 8082:127.0.0.1:8082 root@68.183.200.37`, then http://localhost:8082.

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
(no basic auth on the tunnel; the UI is served under `/kafka` everywhere), and
`ssh -N -L 8082:127.0.0.1:8082 root@68.183.200.37` then http://localhost:8082 for Flink.

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
cd /opt/desal && docker compose down -v --rmi all     # -v deletes every save and Flink's state
rm -rf /opt/desal /etc/caddy/sites/desal.caddy && systemctl reload caddy
```
