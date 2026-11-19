# Hosting: desal.moosha.org

desal runs on one Ubuntu 24.04 server (DigitalOcean, `68.183.200.37`, 1 vCPU, 2 GB RAM plus a 2 GB swapfile).
`scripts/deploy/deploy.sh` puts it there from this machine. DNS: an A record for `desal.moosha.org` points at the server.

Until the game UI exists (Plan 2), **https://desal.moosha.org serves Kafka UI behind basic auth**, so you can watch
the live plant's topics. Kafka UI can also *produce* messages, which is a way to send operator commands to the
simulator (see "Sending commands"). It can also delete topics, and `plant.state` is the career save, so be careful.

## What is on the server

Everything desal adds is named `desal*`. Nothing else runs on the server (the previous app, `reserve`, was removed on
2026-11-18; its backup is in `/root/backups/reserve-2026-11-18/` and on the laptop at `~/backups/reserve-2026-11-18/`).

| What | Where |
| --- | --- |
| The stack | compose project `desal` in `/opt/desal` (`compose.yml`, `.env` with `SIMULATOR_IMAGE`) |
| Source trees | `/opt/desal/src-<commit>/` (the two newest are kept; images are built from them) |
| Images | `desal-simulator:<commit>` (two newest kept), `apache/kafka:4.1.1`, `kafbat/kafka-ui:v1.3.0` |
| Data | Docker volume `desal_kafka-data`: every topic, including the career save (`plant.state`) |
| Basic-auth credentials | `/opt/desal/basic-auth.txt` (mode 600; user `operator`) |
| Caddy | `/etc/caddy/sites/desal.caddy`, imported by `import /etc/caddy/sites/*.caddy` in `/etc/caddy/Caddyfile`. Caddy runs on the host, holds ports 80 and 443, and gets the TLS certificate itself |
| Swap | `/swapfile` (2 GB, in `/etc/fstab`), `vm.swappiness=10` in `/etc/sysctl.d/99-desal-swap.conf` |

Containers and their caps: `desal-kafka` (768 MB, heap 384 MB), `desal-simulator` (256 MB), `desal-kafka-ui`
(384 MB, heap 192 MB). Kafka UI listens on `127.0.0.1:8080` only, and Kafka on `127.0.0.1:9092` only; neither is
reachable from the internet except through Caddy (UI only).

## Deploying

```bash
scripts/deploy/deploy.sh          # deploys the committed HEAD
```

It ships `git archive HEAD` (uncommitted changes are not deployed), builds the simulator image on the server, writes
`/opt/desal/compose.yml` and `.env`, installs the Caddy site (generating credentials the first time), reloads Caddy and
runs `docker compose up -d`. The simulator gets SIGTERM on redeploy and writes a final snapshot first (30 s grace), so a
redeploy resumes the career where it was.

Override the target with `DESAL_SERVER=root@host` and `DESAL_HOST=name`.

**Rolling back:** check out the earlier commit and run `deploy.sh` again, or on the server set `SIMULATOR_IMAGE` in
`/opt/desal/.env` to the previous `desal-simulator:<commit>` and run `docker compose up -d` in `/opt/desal`.

## Operating

```bash
ssh root@68.183.200.37
cd /opt/desal
docker compose ps
docker logs -f desal-simulator
cat basic-auth.txt                      # Kafka UI login
```

**Sending commands.** Run the CLIs over an SSH tunnel from the laptop:

```bash
ssh -N -L 9092:localhost:9092 root@68.183.200.37 &
pnpm --filter @desal/simulator send '{"type":"startShift","mode":"auto"}'
pnpm --filter @desal/simulator watch events
```

Or, in Kafka UI, produce to `plant.commands` with key `plant-1` and a value like
`{"commandId":"<uuid>","issuedAt":0,"shiftId":null,"command":{"type":"startShift","mode":"auto"}}`.
`shiftId` must be the current shift's id for everything except `startShift` and `newCareer`. Read it from the latest
`plant.status` message.

**Kafka/Flink dashboards over SSH:** `ssh -N -L 8080:localhost:8080 root@68.183.200.37` then http://localhost:8080
(no basic auth on the tunnel).

## Backups

The career is the latest record in the compacted `plant.state` topic, inside the `desal_kafka-data` volume. To copy the
whole volume:

```bash
ssh root@68.183.200.37 'cd /opt/desal && docker compose stop simulator kafka \
  && docker run --rm -v desal_kafka-data:/d -v /root/backups:/b alpine tar czf /b/desal-kafka-$(date +%F).tgz -C /d . \
  && docker compose start kafka simulator'
```

The simulator writes a final snapshot when stopped, so stop it before Kafka.

## Removing desal

```bash
cd /opt/desal && docker compose down -v --rmi all     # -v deletes the career
rm -rf /opt/desal /etc/caddy/sites/desal.caddy && systemctl reload caddy
```
