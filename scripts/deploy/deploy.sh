#!/usr/bin/env bash
# Deploy desal to the server from this machine (docs/hosting.md).
#   scripts/deploy/deploy.sh            # deploys HEAD
#   DESAL_SERVER=root@1.2.3.4 DESAL_HOST=example.org scripts/deploy/deploy.sh
# It refuses to run on a dirty tree, then ships the committed tree (git archive
# of HEAD), builds the web app locally and ships it to /opt/desal/web-<commit>,
# builds the simulator and gateway images on the server, installs the Caddy site,
# and runs `docker compose up -d` in /opt/desal. Safe to re-run.
# Needs pnpm and installed dependencies (pnpm install) on this machine.
set -euo pipefail

SERVER="${DESAL_SERVER:-root@68.183.200.37}"
HOST="${DESAL_HOST:-desal.moosha.org}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
SIMULATOR_IMAGE="desal-simulator:$COMMIT"
GATEWAY_IMAGE="desal-gateway:$COMMIT"

# A dirty tree would deploy something nobody committed: the web app is built from the working
# tree while the images come from HEAD. Refuse, untracked files included.
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "error: uncommitted changes in $REPO_ROOT; commit or stash them first (HEAD is $COMMIT)" >&2
  git -C "$REPO_ROOT" status --short >&2
  exit 1
fi

echo "==> building the web app (wss://$HOST/ws)"
(cd "$REPO_ROOT" && VITE_WS_URL="wss://$HOST/ws" pnpm --filter @desal/web build)
[ -f "$REPO_ROOT/apps/web/dist/index.html" ] || { echo "web build produced no dist/index.html" >&2; exit 1; }

echo "==> shipping the web build to $SERVER:/opt/desal/web-$COMMIT"
tar -c -C "$REPO_ROOT/apps/web/dist" . \
  | ssh "$SERVER" "mkdir -p /opt/desal && rm -rf /opt/desal/web-$COMMIT && mkdir -p /opt/desal/web-$COMMIT && tar -x -C /opt/desal/web-$COMMIT"

echo "==> shipping $COMMIT to $SERVER:/opt/desal/src-$COMMIT"
git -C "$REPO_ROOT" archive --format=tar HEAD \
  | ssh "$SERVER" "rm -rf /opt/desal/src-$COMMIT && mkdir -p /opt/desal/src-$COMMIT && tar -x -C /opt/desal/src-$COMMIT"

echo "==> building $SIMULATOR_IMAGE and $GATEWAY_IMAGE on the server"
ssh "$SERVER" "docker build -q -f /opt/desal/src-$COMMIT/services/simulator/Dockerfile -t $SIMULATOR_IMAGE /opt/desal/src-$COMMIT"
ssh "$SERVER" "docker build -q -f /opt/desal/src-$COMMIT/services/gateway/Dockerfile -t $GATEWAY_IMAGE /opt/desal/src-$COMMIT"

echo "==> installing compose project and Caddy site"
ssh "$SERVER" HOST="$HOST" SIMULATOR_IMAGE="$SIMULATOR_IMAGE" GATEWAY_IMAGE="$GATEWAY_IMAGE" COMMIT="$COMMIT" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/desal
cp "src-$COMMIT/deploy/compose.yml" compose.yml
printf 'SIMULATOR_IMAGE=%s\nGATEWAY_IMAGE=%s\n' "$SIMULATOR_IMAGE" "$GATEWAY_IMAGE" > .env
chmod 600 .env

# Web build: point /opt/desal/web at it atomically (rename over the symlink), so
# Caddy never sees a missing directory. Caddy (user caddy) must be able to read it.
chmod -R a+rX "web-$COMMIT"
chmod a+x /opt/desal
ln -sfn "web-$COMMIT" web.new
mv -T web.new web
ls -dt /opt/desal/web-* 2>/dev/null | tail -n +3 | xargs -r rm -rf

# Basic-auth credentials: generated once, kept in basic-auth.txt (mode 600).
if [ ! -f basic-auth.txt ]; then
  pass="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  printf 'user=operator\npassword=%s\n' "$pass" > basic-auth.txt
  chmod 600 basic-auth.txt
  echo "    generated basic-auth credentials in /opt/desal/basic-auth.txt"
fi
user="$(sed -n 's/^user=//p' basic-auth.txt)"
pass="$(sed -n 's/^password=//p' basic-auth.txt)"
hash="$(caddy hash-password --plaintext "$pass")"

mkdir -p /etc/caddy/sites
sed -e "s|__HOST__|$HOST|" -e "s|__AUTH_USER__|$user|" -e "s|__AUTH_HASH__|$hash|" \
  "src-$COMMIT/deploy/desal.caddy" > /etc/caddy/sites/desal.caddy.new
chmod 640 /etc/caddy/sites/desal.caddy.new
chgrp caddy /etc/caddy/sites/desal.caddy.new 2>/dev/null || true
mv /etc/caddy/sites/desal.caddy.new /etc/caddy/sites/desal.caddy
grep -q '^import /etc/caddy/sites/\*.caddy' /etc/caddy/Caddyfile \
  || printf '\nimport /etc/caddy/sites/*.caddy\n' >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy

docker compose up -d --remove-orphans

# Keep the two newest images of each service, and the two newest source trees.
for repo in desal-simulator desal-gateway; do
  docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
    | awk -v r="^$repo:" '$1 ~ r' | sort -k2 -r | awk 'NR>2 {print $1}' \
    | xargs -r docker rmi >/dev/null 2>&1 || true
done
ls -dt /opt/desal/src-* 2>/dev/null | tail -n +3 | xargs -r rm -rf
REMOTE

echo "==> waiting for the simulator and the gateway"
for _ in $(seq 1 30); do
  if ssh "$SERVER" "docker logs desal-simulator 2>&1 | grep -qE 'running with [0-9]+ live game'"; then break; fi
  sleep 3
done
healthy=""
for _ in $(seq 1 40); do
  if [ "$(ssh "$SERVER" "curl -s http://127.0.0.1:8081/healthz" || true)" = "ok" ]; then healthy=1; break; fi
  sleep 3
done
[ -n "$healthy" ] || { echo "gateway /healthz did not return ok" >&2; ssh "$SERVER" "docker logs --tail 20 desal-gateway 2>&1" >&2 || true; exit 1; }
ssh "$SERVER" "docker compose -f /opt/desal/compose.yml ps --format 'table {{.Name}}\t{{.Status}}'; docker logs --tail 5 desal-simulator 2>&1; docker logs --tail 5 desal-gateway 2>&1"
echo "==> done: https://$HOST (game); https://$HOST/kafka (Kafka UI, credentials: ssh $SERVER cat /opt/desal/basic-auth.txt)"
