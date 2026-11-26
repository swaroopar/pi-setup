#!/usr/bin/env bash
# GitHub counterpart to monitor-mr-gitlab.sh: check a PR for merge conflicts,
# then poll its checks until they finish; on failure, dump the failing
# workflow run(s)' failed-step logs via `gh run view --log-failed` (GitHub
# already isolates failed steps for us, unlike GitLab's raw job trace).
#
# Usage:
#   monitor-mr-github.sh <pr-number> [poll-interval-seconds]
#   monitor-mr-github.sh more <log-file> [extra-lines]
#
# Exit codes:
#   0 - checks passed (first form) / lines printed (second form)
#   1 - checks failed (failed step logs are printed to stdout)
#   2 - usage/lookup error
#   3 - PR has merge conflicts with its base branch (checked before/independent
#       of check status — green checks can still be unmergeable)

set -euo pipefail

TAIL_LINES="${TAIL_LINES:-150}"

if [ "${1:-}" = "more" ]; then
  log_file="${2:?usage: monitor-mr-github.sh more <log-file> [extra-lines]}"
  extra="${3:-150}"

  [ -f "$log_file" ] || { echo "monitor-mr-github: no such log file: $log_file" >&2; exit 2; }

  total=$(wc -l < "$log_file")
  end=$(( total - TAIL_LINES ))
  [ "$end" -lt 1 ] && { echo "monitor-mr-github: nothing further above what was already shown ($total total lines)" >&2; exit 0; }
  start=$(( end - extra + 1 ))
  [ "$start" -lt 1 ] && start=1

  echo "===== $log_file: lines $start-$end (of $total total; already-shown tail excluded) ====="
  sed -n "${start},${end}p" "$log_file"
  exit 0
fi

pr_number="${1:?usage: monitor-mr-github.sh <pr-number> [poll-interval-seconds]}"
interval="${2:-30}"

# `gh` defaults to a fork's *parent* repo for commands like `pr checks`/`repo
# view` when `origin` has an `upstream` remote set — silently querying the
# wrong repo's PR numbering. Resolve `origin` explicitly and pass -R to every
# call instead of trusting gh's own repo auto-detection.
origin_url=$(git remote get-url origin)
repo_slug=$(printf '%s' "$origin_url" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
[ -n "$repo_slug" ] || { echo "monitor-mr-github: could not resolve owner/repo from origin remote '$origin_url'" >&2; exit 2; }

check_conflicts() {
  # GitHub computes mergeability async; give it one retry if it hasn't
  # settled yet ("UNKNOWN") rather than trusting a stale read.
  local pr_json mergeable
  for _ in 1 2; do
    pr_json=$(gh pr view "$pr_number" -R "$repo_slug" --json mergeable,mergeStateStatus)
    mergeable=$(printf '%s' "$pr_json" | jq -r '.mergeable // "UNKNOWN"')
    [ "$mergeable" = "UNKNOWN" ] && sleep 5 || break
  done

  if [ "$mergeable" = "CONFLICTING" ]; then
    local state
    state=$(printf '%s' "$pr_json" | jq -r '.mergeStateStatus // empty')
    echo "monitor-mr-github: PR #$pr_number has merge conflicts with its base branch (mergeStateStatus=$state)" >&2
    echo "monitor-mr-github: rebase onto the base branch, resolve conflicts, and force-push before continuing" >&2
    return 1
  fi
  return 0
}

check_conflicts || exit 3

while :; do
  checks_json=$(gh pr checks "$pr_number" -R "$repo_slug" --json bucket,name,link 2>/dev/null || echo '[]')

  if [ "$checks_json" = "[]" ] || [ -z "$checks_json" ]; then
    echo "monitor-mr-github: could not read checks for PR #$pr_number (none registered yet?)" >&2
    exit 2
  fi

  # A failure is decisive even while other checks are still pending — report
  # it immediately rather than waiting out the rest of the suite.
  if printf '%s' "$checks_json" | jq -e 'any(.[]; .bucket == "fail" or .bucket == "cancel")' >/dev/null 2>&1; then
    echo "monitor-mr-github: checks FAILED for PR #$pr_number — dumping failed step logs" >&2

    run_ids=$(printf '%s' "$checks_json" \
      | jq -r '.[] | select(.bucket == "fail" or .bucket == "cancel") | .link' \
      | grep -oE '/actions/runs/[0-9]+' | grep -oE '[0-9]+' | sort -u)

    if [ -z "$run_ids" ]; then
      echo "monitor-mr-github: checks failed but no workflow run IDs could be parsed from check links; inspect manually with 'gh pr checks $pr_number'" >&2
      exit 1
    fi

    for run_id in $run_ids; do
      log_file=$(mktemp)
      if ! gh run view "$run_id" -R "$repo_slug" --log-failed >"$log_file" 2>&1; then
        echo "monitor-mr-github: could not fetch failed-step log for run $run_id" >&2
        rm -f "$log_file"
        continue
      fi

      echo "===== run $run_id: last $TAIL_LINES lines of failed steps (full: $log_file) ====="
      tail -n "$TAIL_LINES" "$log_file"
      echo
    done
    exit 1
  fi

  if printf '%s' "$checks_json" | jq -e 'any(.[]; .bucket == "pending")' >/dev/null 2>&1; then
    check_conflicts || exit 3
    sleep "$interval"
    continue
  fi

  echo "monitor-mr-github: checks passed for PR #$pr_number"
  exit 0
done
