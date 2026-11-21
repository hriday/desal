#!/usr/bin/env bash
# End-to-end test through a local Flink: simulator -> Kafka -> the report-card and leaderboard jobs
# -> gateway -> a test client (services/gateway/test/flink.int.test.ts). Local Docker only.
#
#   scripts/e2e-flink.sh
#
# Brings up Kafka and the Flink session cluster (infra/docker-compose.yml), creates a throwaway set
# of suffixed topics, submits a second copy of both jobs on them, runs the test, and on exit
# cancels those jobs and deletes the topics. The cluster has 2 task slots, one per job: if jobs
# already hold them (the unsuffixed ones), they are stopped with a savepoint first (flink-jobs.sh
# stop-all) and resubmitted from it on exit (flink-jobs.sh submit-all).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/infra/docker-compose.yml")
JM=desal-flink-jobmanager
REST=http://localhost:8082
JAR=/opt/flink/usrlib/desal-flink.jar
LIST=/flink-data/savepoints/last.txt
SUFFIX=".e2e-$(date +%s)"
JOB_IDS=()
STOPPED_UNSUFFIXED=0

log() { echo "[e2e-flink] $*"; }

# "<jobId> <name> <STATE> <running tasks> <total tasks>" per job the cluster knows.
jobs_overview() {
  curl -sf --max-time 10 "$REST/jobs/overview" |
    jq -r '.jobs[] | "\(.jid) \(.name) \(.state) \(.tasks.running) \(.tasks.total)"'
}
slots_available() { curl -sf --max-time 10 "$REST/overview" | jq -r '."slots-available"'; }
state_of() { jobs_overview | awk -v id="$1" '$1 == id {print $3}'; }

# Waits (up to $2 s) until $1 succeeds.
wait_for() {
  local cmd="$1" limit="$2" waited=0
  until eval "$cmd" >/dev/null 2>&1; do
    [ "$waited" -lt "$limit" ] || { log "timed out after ${limit}s: $cmd"; return 1; }
    sleep 2
    waited=$((waited + 2))
  done
}

cleanup() {
  local status=$? id
  set +e
  for id in ${JOB_IDS[@]+"${JOB_IDS[@]}"}; do
    log "cancelling $id"
    docker exec "$JM" flink cancel "$id" 2>&1 | grep -v 'Unknown module: jdk.compiler' | tail -n 1
  done
  for id in ${JOB_IDS[@]+"${JOB_IDS[@]}"}; do
    wait_for "[ \"\$(state_of $id)\" = CANCELED ]" 60
  done
  log "deleting topics *$SUFFIX"
  docker exec desal-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
    --delete --topic ".*${SUFFIX//./\\.}" 2>&1 | tail -n 1
  if [ "$STOPPED_UNSUFFIXED" = 1 ]; then
    log "resubmitting the unsuffixed jobs from their savepoints"
    docker exec "$JM" flink-jobs.sh submit-all "$LIST"
  fi
  if [ "$status" -eq 0 ]; then log "PASS"; else log "FAIL (exit $status)"; fi
  exit "$status"
}
trap cleanup EXIT

log "bringing up Kafka and Flink"
# No --build: a rebuilt image recreates the Flink containers, and a session cluster loses its
# running jobs with them. After changing the jobs, run `up -d --build` yourself first.
"${COMPOSE[@]}" up -d kafka flink-jobmanager flink-taskmanager
wait_for "[ \"\$(docker inspect -f '{{.State.Health.Status}}' desal-kafka)\" = healthy ]" 120
wait_for "[ \"\$(curl -sf --max-time 5 $REST/overview | jq -r '.\"slots-total\"')\" -ge 2 ]" 120

log "topic suffix $SUFFIX: creating topics"
(cd "$ROOT/services/gateway" && DESAL_TOPIC_SUFFIX="$SUFFIX" pnpm exec tsx --input-type=module --eval "
  const c = await import('@desal/simulator/kafka/client');
  const kafka = c.createKafka();
  await c.ensureTopics(kafka);
  await c.waitForTopics(kafka);
")

if [ "$(slots_available)" -lt 2 ]; then
  log "no free slots: stopping the running jobs with savepoints (resubmitted on exit)"
  STOPPED_UNSUFFIXED=1
  docker exec "$JM" flink-jobs.sh stop-all "$LIST"
  wait_for "[ \"\$(slots_available)\" -ge 2 ]" 60
fi

for class in org.desal.flink.reportcard.ReportCardJob org.desal.flink.leaderboard.LeaderboardJob; do
  out="$(docker exec "$JM" flink run -d -c "$class" "$JAR" --brokers kafka:29092 --topic-suffix "$SUFFIX" 2>&1)"
  id="$(sed -nE 's/.*Job has been submitted with JobID ([0-9a-f]{32}).*/\1/p' <<<"$out" | head -n 1)"
  [ -n "$id" ] || { echo "$out" >&2; log "submit of $class failed"; exit 1; }
  JOB_IDS+=("$id")
  log "$class submitted as $id"
done
for id in "${JOB_IDS[@]}"; do
  wait_for "jobs_overview | awk -v id=$id '\$1 == id && \$3 == \"RUNNING\" && \$4 == \$5' | grep -q ." 90
  log "$id RUNNING"
done

log "running the test"
(cd "$ROOT" && DESAL_E2E_FLINK=1 DESAL_TOPIC_SUFFIX="$SUFFIX" pnpm --filter @desal/gateway test:int flink.int)
