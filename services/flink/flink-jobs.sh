#!/usr/bin/env bash
# Stops and resubmits desal's two Flink jobs on the session cluster. Runs inside the jobmanager
# container (the image puts it in /opt/flink/bin), e.g. from deploy.sh:
#   docker exec desal-flink-jobmanager flink-jobs.sh stop-all /flink-data/savepoints/last.txt
#   docker exec desal-flink-jobmanager flink-jobs.sh submit-all /flink-data/savepoints/last.txt
#
#   stop-all <list-file>                      stop each running job with a savepoint; write
#                                             `name=path` lines (one per job stopped) to <list-file>
#   submit-all <list-file> [--topic-suffix S] submit each job that is not running, from its
#                                             savepoint in <list-file> when it has one
#
# A savepoint is a snapshot of a job's state taken on purpose: `flink stop` takes one and then
# stops the job, and `flink run -s <path>` starts the (possibly new) job from it, so a redeploy
# carries every open shift and every board over. State is matched to operators by uid. The
# report-card job fixes every uid; the leaderboard job's SQL operators get theirs from the
# planner, so a changed query can stop matching its savepoint. Then the submit fails, and this
# script starts that job fresh (no -s): the board rebuilds from the compacted run.results topic
# (spec 4.6). It never passes the CLI's allow-non-restored-state flag (-n), which would
# silently drop the state it cannot map instead.
set -euo pipefail

FLINK=/opt/flink/bin/flink
JAR=/opt/flink/usrlib/desal-flink.jar
SAVEPOINT_DIR=/flink-data/savepoints
JOBS=(report-card leaderboard)
# How long a submitted job may take to reach RUNNING (or fail restoring) before we give up.
SUBMIT_WAIT_S=90

job_class() {
  case "$1" in
    report-card) echo org.desal.flink.reportcard.ReportCardJob ;;
    leaderboard) echo org.desal.flink.leaderboard.LeaderboardJob ;;
    *) echo "unknown job $1" >&2; return 1 ;;
  esac
}

# Runs the Flink CLI, dropping the JRE's harmless "Unknown module: jdk.compiler" warnings.
# Prints the rest of its output and returns the CLI's exit status.
flink_cli() {
  local out status=0
  out="$("$FLINK" "$@" 2>&1)" || status=$?
  grep -v 'Unknown module: jdk.compiler' <<<"$out" || true
  return "$status"
}

# The root cause in a CLI failure's output (its last "Caused by:" line), or else its last line:
# the full Java stack trace would bury the deploy's own output.
reason() {
  local line
  line="$(grep -E '^Caused by: ' <<<"$1" | tail -n 1)"
  [ -n "$line" ] || line="$(grep -v '^[[:space:]]*$' <<<"$1" | tail -n 1)"
  echo "${line#Caused by: }"
}

# One line per job the cluster knows, from the REST API's /jobs/overview, as
# "<jobId> <name> <STATE> <running tasks> <total tasks>". The image has curl but no JSON tool;
# the overview's field order is fixed, so each job object is matched by one sed expression.
REST=http://localhost:8081
list_jobs() {
  curl -sf --max-time 10 "$REST/jobs/overview" | sed 's/{"jid":/\n/g' | sed -nE \
    's/^"([0-9a-f]{32})","name":"([^"]*)".*"state":"([A-Z_]+)".*"tasks":\{"running":([0-9]+),.*"total":([0-9]+),.*/\1 \2 \3 \4 \5/p'
}

# Ids of the jobs called $1 that have not reached a terminal state (FINISHED, CANCELED, FAILED).
active_ids() {
  list_jobs | awk -v n="$1" '$2 == n && $3 !~ /^(FINISHED|CANCELED|FAILED)$/ {print $1}'
}

# "<STATE> <running tasks> <total tasks>" of job $1.
progress_of() {
  list_jobs | awk -v id="$1" '$1 == id {print $3, $4, $5}'
}

# Stops each job with a savepoint and rewrites <list-file> with one `name=path` line per job.
# A job that is not running, or whose stop fails, keeps its line from the previous list: its
# last savepoint is still the best state there is, and the next submit-all resumes from it.
stop_all() {
  local file="$1" failed=0 name id out path old
  local previous=""
  if [ -f "$file" ]; then previous="$(cat "$file")"; fi
  : >"$file.tmp"
  for name in "${JOBS[@]}"; do
    old="$(sed -n "s/^$name=//p" <<<"$previous" | tail -n 1)"
    id="$(active_ids "$name" | head -n 1)"
    if [ -z "$id" ]; then
      if [ -n "$old" ]; then
        echo "$name=$old" >>"$file.tmp"
        echo "    $name: not running; keeping its previous savepoint $old"
      else
        echo "    $name: not running, no savepoint"
      fi
      continue
    fi
    echo "    $name: stopping $id with a savepoint"
    if out="$(flink_cli stop --savepointPath "$SAVEPOINT_DIR" "$id")"; then
      # "Savepoint completed. Path: file:/flink-data/savepoints/savepoint-5f0c1e-0123456789ab"
      path="$(sed -nE 's/^Savepoint completed\. Path: (.*)$/\1/p' <<<"$out" | tail -n 1)"
    else
      path=""
    fi
    if [ -n "$path" ]; then
      echo "$name=$path" >>"$file.tmp"
      echo "    $name: savepoint $path"
    else
      echo "!!! $name: stop with savepoint failed; it may still be running: $(reason "$out")" >&2
      if [ -n "$old" ]; then
        echo "$name=$old" >>"$file.tmp"
        echo "    $name: keeping its previous savepoint $old"
      fi
      failed=1
    fi
  done
  mv "$file.tmp" "$file"
  # Keep every savepoint the new list names (carried-over ones included) and the previous list's
  # (a manual way back); delete the rest.
  local dir
  for dir in "$SAVEPOINT_DIR"/savepoint-*; do
    [ -e "$dir" ] || continue
    if ! grep -qF "/$(basename "$dir")" <<<"$(cat "$file")"$'\n'"$previous"; then rm -rf "$dir"; fi
  done
  return "$failed"
}

# Submits job $1 detached, from savepoint $2 if given, and waits until all its tasks run.
# Returns 0 when they do; 1 when the submit or the restore failed (a job still not running after
# SUBMIT_WAIT_S, e.g. restarting over and over because its state does not fit, is cancelled
# first); 2 when a fresh job (no savepoint) is still not running, which is left to keep retrying.
submit() {
  local name="$1" savepoint="${2:-}" class out id progress state running total waited=0
  class="$(job_class "$name")"
  local cmd=(run -d -c "$class")
  [ -n "$savepoint" ] && cmd+=(-s "$savepoint")
  cmd+=("$JAR" ${JOB_ARGS[@]+"${JOB_ARGS[@]}"})
  echo "    $name: flink ${cmd[*]}"
  if ! out="$(flink_cli "${cmd[@]}")"; then
    echo "    $name: submit failed: $(reason "$out")"
    return 1
  fi
  id="$(sed -nE 's/.*Job has been submitted with JobID ([0-9a-f]{32}).*/\1/p' <<<"$out" | head -n 1)"
  [ -n "$id" ] || { echo "    $name: submit printed no job id: $(reason "$out")"; return 1; }
  # A savepoint whose state has no operator to go to in the new program fails the submit itself
  # (above). State that maps but does not fit is found when each task restores it as it starts:
  # the task fails and the job restarts, over and over. So wait for every task to be running.
  while [ "$waited" -lt "$SUBMIT_WAIT_S" ]; do
    progress="$(progress_of "$id")"
    read -r state running total <<<"${progress:-UNKNOWN 0 1}"
    case "$state" in
      RUNNING)
        if [ "$running" = "$total" ]; then echo "    $name: RUNNING as $id ($total tasks)"; return 0; fi ;;
      FAILED | CANCELED | FINISHED)
        echo "    $name: $id ended $state" >&2
        return 1 ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  echo "!!! $name: $id is $state with $running/$total tasks running after ${SUBMIT_WAIT_S}s" >&2
  [ -z "$savepoint" ] && return 2
  flink_cli cancel "$id" >/dev/null || true
  return 1
}

submit_all() {
  local file="$1" failed=0 name savepoint status
  shift
  JOB_ARGS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --topic-suffix) JOB_ARGS+=(--topic-suffix "$2"); shift 2 ;;
      *) echo "unknown option $1" >&2; exit 64 ;;
    esac
  done
  for name in "${JOBS[@]}"; do
    if [ -n "$(active_ids "$name")" ]; then
      echo "!!! $name: already running ($(active_ids "$name" | tr '\n' ' ')), not submitting it again" >&2
      continue
    fi
    savepoint=""
    [ -f "$file" ] && savepoint="$(sed -n "s/^$name=//p" "$file" | tail -n 1)"
    if [ -z "$savepoint" ]; then
      echo "    $name: no savepoint, starting fresh"
      submit "$name" || failed=1
      continue
    fi
    status=0
    submit "$name" "$savepoint" || status=$?
    if [ "$status" -eq 1 ]; then
      echo "!!! $name: savepoint incompatible, starting fresh"
      submit "$name" || failed=1
    elif [ "$status" -ne 0 ]; then
      failed=1
    fi
  done
  return "$failed"
}

usage() {
  echo "usage: flink-jobs.sh stop-all <list-file> | submit-all <list-file> [--topic-suffix S]" >&2
  exit 64
}

[ $# -ge 2 ] || usage
case "$1" in
  stop-all) stop_all "$2" ;;
  submit-all) cmd_file="$2"; shift 2; submit_all "$cmd_file" "$@" ;;
  *) usage ;;
esac
