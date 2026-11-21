#!/usr/bin/env bash
# The image's entrypoint: the stock /docker-entrypoint.sh, plus, when this container is the
# jobmanager, a background run of `flink-jobs.sh submit-all` once the cluster is ready.
#
# The session cluster has no high availability: a jobmanager that restarts (host reboot, Docker
# restart, crash; compose's `restart: unless-stopped` brings it back) remembers no jobs. So each
# time it starts, this resubmits the report-card and leaderboard jobs from their newest state:
# a retained checkpoint of their last run, or their last savepoint (flink-jobs.sh picks). It does
# so only once the jobs have run here before (jobs.txt or the savepoint list exists); the first
# start is deploy.sh's to make. submit-all never submits a job that is already running and holds
# a lock, so deploy.sh's own submit-all after `docker compose up` stays harmless.
# DESAL_AUTO_SUBMIT=0 turns this off.
set -euo pipefail

LIST=/flink-data/savepoints/last.txt
JOBS_FILE=/flink-data/jobs.txt
REST=http://localhost:8081
# Both jobs need a slot each: submitting before the taskmanager has registered would leave a
# restore waiting for slots until flink-jobs.sh gives up on it.
SLOTS_NEEDED=2

log() { echo "$*"; }

slots_total() {
  curl -sf --max-time 5 "$REST/overview" | sed -nE 's/.*"slots-total":([0-9]+).*/\1/p'
}

auto_submit() {
  local waited=0 slots
  while :; do
    slots="$(slots_total || true)"
    [ "${slots:-0}" -ge "$SLOTS_NEEDED" ] && break
    # One line a minute while the taskmanager is missing; it may take a while after a reboot.
    if [ $((waited % 60)) -eq 0 ] && [ "$waited" -gt 0 ]; then
      log "waiting for $SLOTS_NEEDED task slots (have ${slots:-none}) before resubmitting the jobs"
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log "cluster ready: resubmitting the jobs (flink-jobs.sh submit-all $LIST)"
  if /opt/flink/bin/flink-jobs.sh submit-all "$LIST"; then
    log "jobs resubmitted"
  else
    log "!!! resubmitting failed; see above. Retry: docker exec desal-flink-jobmanager flink-jobs.sh submit-all $LIST"
  fi
}

if [ "${1:-}" = jobmanager ] && [ "${DESAL_AUTO_SUBMIT:-1}" != 0 ] && { [ -f "$JOBS_FILE" ] || [ -f "$LIST" ]; }; then
  auto_submit 2>&1 | sed -u 's/^/[auto-submit] /' &
fi
exec /docker-entrypoint.sh "$@"
