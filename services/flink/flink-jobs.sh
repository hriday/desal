#!/usr/bin/env bash
# Stops and resubmits desal's two Flink jobs on the session cluster. Runs inside the jobmanager
# container (the image puts it in /opt/flink/bin), e.g. from deploy.sh:
#   docker exec desal-flink-jobmanager flink-jobs.sh stop-all /flink-data/savepoints/last.txt
#   docker exec desal-flink-jobmanager flink-jobs.sh submit-all /flink-data/savepoints/last.txt
#
#   stop-all <list-file>                      stop each running job with a savepoint; write
#                                             `name=path` lines (one per job stopped) to <list-file>
#   submit-all <list-file> [--topic-suffix S] submit each job that is not running, from its
#                                             newest state: its savepoint in <list-file>, or its
#                                             last run's newest retained checkpoint if that is newer
#
# The image's entrypoint (desal-entrypoint.sh) also runs submit-all whenever the jobmanager
# starts: the session cluster has no HA, so a restarted jobmanager comes back with no jobs.
#
# A savepoint is a snapshot of a job's state taken on purpose: `flink stop` takes one and then
# stops the job, and `flink run -s <path>` starts the (possibly new) job from it, so a redeploy
# carries every open shift and every board over. State is matched to operators by uid. The
# report-card job fixes every uid; the leaderboard job's SQL operators get theirs from the
# planner, so a changed query can stop matching its savepoint. Then the submit fails, and this
# script starts that job fresh (no -s): the board rebuilds from the compacted run.results topic
# (spec 4.6). It never passes the CLI's allow-non-restored-state flag (-n), which would
# silently drop the state it cannot map instead.
#
# A checkpoint is retained when its job is cancelled or the jobmanager goes away
# (execution.checkpointing.externalized-checkpoint-retention: RETAIN_ON_CANCELLATION), in
# /flink-data/checkpoints/<jobId>/chk-<n>; it is complete once it has a _metadata file. So that
# submit-all can find a job's checkpoints, it records each job it submits as `name=jobId` in
# JOBS_FILE, keeping the last two per name (the newest, and the one it was restored from).
set -euo pipefail

FLINK=/opt/flink/bin/flink
JAR=/opt/flink/usrlib/desal-flink.jar
SAVEPOINT_DIR=/flink-data/savepoints
CHECKPOINT_DIR=/flink-data/checkpoints
JOBS_FILE=/flink-data/jobs.txt
# submit-all holds this lock, so the entrypoint's run and deploy.sh's never submit a job twice.
LOCK_FILE=/flink-data/submit.lock
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

# Appends `name=jobId` to JOBS_FILE and keeps only the last two lines per job name.
record_job() {
  local name="$1" id="$2" tmp="$JOBS_FILE.tmp"
  { [ -f "$JOBS_FILE" ] && cat "$JOBS_FILE"; echo "$name=$id"; } | awk -F= '
    { line[NR] = $0; name[NR] = $1 }
    END {
      for (i = NR; i >= 1; i--) if (++seen[name[i]] <= 2) keep[i] = 1
      for (i = 1; i <= NR; i++) if (keep[i]) print line[i]
    }' >"$tmp"
  mv "$tmp" "$JOBS_FILE"
}

# The job ids recorded for job $1, newest last.
recorded_ids() {
  [ -f "$JOBS_FILE" ] || return 0
  sed -n "s/^$1=//p" "$JOBS_FILE"
}

# The newest complete checkpoint (chk-<n> with a _metadata file) of job id $1, if any.
latest_checkpoint() {
  local dir="$CHECKPOINT_DIR/$1" n
  [ -d "$dir" ] || return 0
  for n in $(find "$dir" -mindepth 1 -maxdepth 1 -name 'chk-*' -printf '%f\n' | sed 's/^chk-//' | sort -rn); do
    if [ -f "$dir/chk-$n/_metadata" ]; then echo "$dir/chk-$n"; return 0; fi
  done
}

# The newest complete checkpoint across the recorded runs of job $1, if any.
newest_checkpoint() {
  local id chk best=""
  for id in $(recorded_ids "$1"); do
    chk="$(latest_checkpoint "$id")"
    [ -n "$chk" ] || continue
    if [ -z "$best" ] || [ "$chk/_metadata" -nt "$best/_metadata" ]; then best="$chk"; fi
  done
  echo "$best"
}

# The state to restore job $1 from: savepoint $2 (from the list file, may be empty) or the job's
# newest retained checkpoint, whichever was written last. Empty when there is neither.
restore_point() {
  local name="$1" savepoint="${2:-}" chk
  chk="$(newest_checkpoint "$name")"
  if [ -n "$chk" ] && { [ -z "$savepoint" ] || [ ! -f "${savepoint#file:}/_metadata" ] \
    || [ "$chk/_metadata" -nt "${savepoint#file:}/_metadata" ]; }; then
    echo "$chk"
  else
    echo "$savepoint"
  fi
}

# Deletes the checkpoints no submit-all can use any more: every job directory that is neither
# recorded in JOBS_FILE nor a job the cluster is still running, and in a recorded job that is not
# running, every chk-<n> but its newest complete one. Running jobs' directories are Flink's own.
prune_checkpoints() {
  local overview keep active dir id newest chk
  # Without the cluster's job list, a running job's directory could look unused: skip.
  overview="$(list_jobs)" || return 0
  [ -n "$overview" ] || return 0
  active="$(awk '$3 !~ /^(FINISHED|CANCELED|FAILED)$/ {print $1}' <<<"$overview")"
  keep="$active"
  if [ -f "$JOBS_FILE" ]; then keep+=$'\n'"$(sed 's/^[^=]*=//' "$JOBS_FILE")"; fi
  for dir in "$CHECKPOINT_DIR"/*; do
    [ -d "$dir" ] || continue
    id="$(basename "$dir")"
    if ! grep -qxF "$id" <<<"$keep"; then rm -rf "$dir"; continue; fi
    grep -qxF "$id" <<<"$active" && continue
    newest="$(latest_checkpoint "$id")"
    for chk in "$dir"/chk-*; do
      [ -e "$chk" ] || continue
      [ "$chk" = "$newest" ] || rm -rf "$chk"
    done
  done
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
  # Recorded at once: from its first checkpoint on, this run's state is the newest there is.
  record_job "$name" "$id"
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
  local file="$1" failed=0 name savepoint from status
  shift
  exec 9>"$LOCK_FILE"
  if ! flock -w 600 9; then
    echo "!!! another submit-all has held $LOCK_FILE for 600 s; not submitting" >&2
    return 1
  fi
  JOB_ARGS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --topic-suffix) JOB_ARGS+=(--topic-suffix "$2"); shift 2 ;;
      *) echo "unknown option $1" >&2; exit 64 ;;
    esac
  done
  for name in "${JOBS[@]}"; do
    if [ -n "$(active_ids "$name")" ]; then
      echo "    $name: already running ($(active_ids "$name" | tr '\n' ' ')), not submitting it again"
      continue
    fi
    savepoint=""
    [ -f "$file" ] && savepoint="$(sed -n "s/^$name=//p" "$file" | tail -n 1)"
    from="$(restore_point "$name" "$savepoint")"
    if [ -z "$from" ]; then
      echo "    $name: no savepoint or checkpoint, starting fresh"
      submit "$name" || failed=1
      continue
    fi
    if [ "$from" != "$savepoint" ]; then
      echo "    $name: restoring from checkpoint $from (newer than savepoint ${savepoint:-none})"
    fi
    status=0
    submit "$name" "$from" || status=$?
    if [ "$status" -eq 1 ]; then
      echo "!!! $name: savepoint incompatible, starting fresh"
      submit "$name" || failed=1
    elif [ "$status" -ne 0 ]; then
      failed=1
    fi
  done
  prune_checkpoints
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
