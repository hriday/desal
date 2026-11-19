#!/usr/bin/env bash
# Deploy desal to the server from this machine (docs/hosting.md).
#   scripts/deploy/deploy.sh            # deploys HEAD
#   DESAL_SERVER=root@1.2.3.4 DESAL_HOST=example.org scripts/deploy/deploy.sh
# It ships the committed tree (git archive, so uncommitted changes are NOT
# deployed), builds the simulator image on the server, installs the Caddy site,
# and runs `docker compose up -d` in /opt/desal. Safe to re-run.
set -euo pipefail

SERVER="${DESAL_SERVER:-root@68.183.200.37}"
HOST="${DESAL_HOST:-desal.moosha.org}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
IMAGE="desal-simulator:$COMMIT"

if ! git -C "$REPO_ROOT" diff --quiet HEAD; then
  echo "note: uncommitted changes are not deployed (deploying $COMMIT)" >&2
fi

echo "==> shipping $COMMIT to $SERVER:/opt/desal/src-$COMMIT"
git -C "$REPO_ROOT" archive --format=tar HEAD \
  | ssh "$SERVER" "rm -rf /opt/desal/src-$COMMIT && mkdir -p /opt/desal/src-$COMMIT && tar -x -C /opt/desal/src-$COMMIT"

echo "==> building $IMAGE on the server"
ssh "$SERVER" "docker build -q -f /opt/desal/src-$COMMIT/services/simulator/Dockerfile -t $IMAGE /opt/desal/src-$COMMIT"

echo "==> installing compose project and Caddy site"
ssh "$SERVER" HOST="$HOST" IMAGE="$IMAGE" COMMIT="$COMMIT" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/desal
cp "src-$COMMIT/deploy/compose.yml" compose.yml
printf 'SIMULATOR_IMAGE=%s\n' "$IMAGE" > .env
chmod 600 .env

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

# Keep the two newest simulator images and source trees.
docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
  | awk '$1 ~ /^desal-simulator:/' | sort -k2 -r | awk 'NR>2 {print $1}' \
  | xargs -r docker rmi >/dev/null 2>&1 || true
ls -dt /opt/desal/src-* 2>/dev/null | tail -n +3 | xargs -r rm -rf
REMOTE

echo "==> waiting for the simulator"
for _ in $(seq 1 30); do
  if ssh "$SERVER" "docker logs desal-simulator 2>&1 | grep -qE 'resuming career|starting a fresh|fresh career'"; then break; fi
  sleep 3
done
ssh "$SERVER" "docker compose -f /opt/desal/compose.yml ps --format 'table {{.Name}}\t{{.Status}}'; docker logs --tail 5 desal-simulator 2>&1"
echo "==> done: https://$HOST (credentials: ssh $SERVER cat /opt/desal/basic-auth.txt)"
