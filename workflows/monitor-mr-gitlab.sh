#!/usr/bin/env bash
# Check an MR for merge conflicts, then poll its pipeline until it finishes;
# on failure, dump failed-job logs.
#
# Usage:
#   monitor-mr.sh <mr-iid> [poll-interval-seconds]
#   monitor-mr.sh more <log-file> [extra-lines]
#
# The first form checks has_conflicts up front (and again each poll cycle,
# since the target branch can move while a long pipeline runs), then polls
# until the pipeline finishes and, on failure, prints the tail of each failed
# job's log plus the full log's path. If that tail doesn't include enough
# context, use the second form to walk further back in the same log file
# without re-printing what was already shown.
#
# Exit codes:
#   0 - pipeline succeeded (first form) / lines printed (second form)
#   1 - pipeline failed (failed job logs are printed to stdout)
#   2 - usage/lookup error
#   3 - MR has merge conflicts with its target branch (checked before/independent
#       of pipeline status — a green pipeline can still be unmergeable)
#   4 - no pipeline ever registered for this MR after polling (e.g. the
#       project's CI only triggers on a different branch, or there is no CI
#       at all) -- this is NOT a failure, there is simply nothing to verify

set -euo pipefail

# GitLab job logs wrap the actual job script's output (where real failures
# live) between `section_start:<ts>:step_script` / `section_end:<ts>:step_script`
# markers, sandwiched between setup noise (docker pull, git clone, apt-get,
# uv sync) *and* teardown noise (artifact upload, cleanup) that can each run
# to hundreds of lines. Naively tailing the raw log lands on teardown, not
# the error. Isolate step_script first, strip its per-line timestamp/stream
# prefix and ANSI codes, then tail *that*.
TAIL_LINES="${TAIL_LINES:-150}"

extract_step_script() {
  # $1 = raw trace file. Prints the cleaned step_script section, or the whole
  # cleaned log if no step_script section was found (e.g. failure happened
  # during setup/teardown instead of the job's own script).
  local raw="$1" isolated
  isolated=$(awk '
    /section_start:[0-9]+:step_script/ { capture=1; next }
    /section_end:[0-9]+:step_script/   { capture=0 }
    capture { print }
  ' "$raw")
  [ -z "$isolated" ] && isolated=$(cat "$raw")
  printf '%s\n' "$isolated" | sed -E '
    s/\x1b\[[0-9;]*[a-zA-Z]//g
    s/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z [0-9]+O\+?[[:space:]]*//
  '
}

if [ "${1:-}" = "more" ]; then
  log_file="${2:?usage: monitor-mr.sh more <log-file> [extra-lines]}"
  extra="${3:-150}"

  [ -f "$log_file" ] || { echo "monitor-mr: no such log file: $log_file" >&2; exit 2; }

  total=$(wc -l < "$log_file")
  end=$(( total - TAIL_LINES ))
  [ "$end" -lt 1 ] && { echo "monitor-mr: nothing further above what was already shown ($total total lines)" >&2; exit 0; }
  start=$(( end - extra + 1 ))
  [ "$start" -lt 1 ] && start=1

  echo "===== $log_file: lines $start-$end (of $total total; already-shown tail excluded) ====="
  sed -n "${start},${end}p" "$log_file"
  exit 0
fi

mr_iid="${1:?usage: monitor-mr.sh <mr-iid> [poll-interval-seconds]}"
interval="${2:-30}"
max_no_pipeline_polls="${MAX_NO_CHECKS_POLLS:-5}"

check_conflicts() {
  # GitLab computes mergeability async; give it one retry if the check hasn't
  # settled yet ("checking"/"unchecked") rather than trusting a stale read.
  local mr_json has_conflicts detailed_status
  for _ in 1 2; do
    mr_json=$(glab mr view "$mr_iid" --output json)
    has_conflicts=$(printf '%s' "$mr_json" | jq -r '.has_conflicts // false')
    detailed_status=$(printf '%s' "$mr_json" | jq -r '.detailed_merge_status // empty')
    case "$detailed_status" in
      checking | unchecked) sleep 5 ;;
      *) break ;;
    esac
  done

  if [ "$has_conflicts" = "true" ]; then
    echo "monitor-mr: MR !$mr_iid has merge conflicts with its target branch (detailed_merge_status=$detailed_status)" >&2
    echo "monitor-mr: rebase onto the target branch, resolve conflicts, and force-push before continuing" >&2
    return 1
  fi
  return 0
}

check_conflicts || exit 3

no_pipeline_count=0
while :; do
  status=$(glab ci get --merge-request="$mr_iid" --output json | jq -r '.status // empty')

  if [ -z "$status" ]; then
    no_pipeline_count=$(( no_pipeline_count + 1 ))
    if [ "$no_pipeline_count" -ge "$max_no_pipeline_polls" ]; then
      echo "monitor-mr: no pipeline ever registered for MR !$mr_iid after $no_pipeline_count polls -- " \
        "this project's CI most likely does not trigger for this MR's branch/event, or has no CI at all. " \
        "Treating as nothing-to-verify, not a failure." >&2
      exit 4
    fi
    echo "monitor-mr: could not read pipeline status for MR !$mr_iid (poll $no_pipeline_count/$max_no_pipeline_polls) -- retrying" >&2
    sleep "$interval"
    continue
  fi
  no_pipeline_count=0

  case "$status" in
    success)
      echo "monitor-mr: pipeline succeeded for MR !$mr_iid"
      exit 0
      ;;
    failed)
      echo "monitor-mr: pipeline FAILED for MR !$mr_iid — dumping failed job logs" >&2
      failed_jobs=$(glab ci get --merge-request="$mr_iid" --status=failed --with-job-details --output json \
        | jq -r '.jobs[]?.id // empty')

      if [ -z "$failed_jobs" ]; then
        echo "monitor-mr: pipeline failed but no failed job details were returned; inspect manually with 'glab ci get --merge-request=$mr_iid --output json'" >&2
        exit 1
      fi

      for job_id in $failed_jobs; do
        raw_file=$(mktemp)
        if ! glab ci trace "$job_id" >"$raw_file" 2>&1; then
          echo "monitor-mr: could not fetch trace for job $job_id" >&2
          rm -f "$raw_file"
          continue
        fi

        log_file=$(mktemp)
        extract_step_script "$raw_file" >"$log_file"
        rm -f "$raw_file"

        echo "===== job $job_id: last $TAIL_LINES lines of its script output (full: $log_file) ====="
        tail -n "$TAIL_LINES" "$log_file"
        echo
      done
      exit 1
      ;;
    canceled | skipped)
      echo "monitor-mr: pipeline ended with status '$status' for MR !$mr_iid" >&2
      exit 1
      ;;
    *)
      # running, pending, created, preparing, waiting_for_resource, scheduled, etc.
      # Re-check mergeability each cycle too — the target branch can move
      # while a long pipeline is still running.
      check_conflicts || exit 3
      sleep "$interval"
      ;;
  esac
done
