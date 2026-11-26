---
name: dependabot
description: Triage every open Dependabot PR on the current repo's GitHub remote one at a time — approve and merge the ones whose CI is green, leave failing ones alone, and nudge conflicting ones with an "@dependabot rebase" comment before re-checking. Only runs when explicitly invoked as /dependabot.
disable-model-invocation: true
---

> **Cross-harness note:** this file names Claude Code's exact tools
> (`AskUserQuestion`, etc.) for precision. If you're running this under a
> different harness, substitute your own equivalent capability wherever one
> is named.

> **GitHub only.** Dependabot is a GitHub-native feature, so this skill only
> ever deals with `gh`, never `glab`. If `git remote get-url origin` isn't a
> `github.com` URL, stop and report that this skill doesn't apply here.

> **No re-confirmation.** Being invoked as `/dependabot` at all is already the
> explicit go-ahead this skill requires — approving and merging PRs on the
> user's behalf is exactly what they asked for by running it. Don't pause to
> ask "should I run this?" or "want me to proceed?" before step 1; go straight
> to listing PRs. The only things worth stopping for mid-run are the ones
> already called out below (a non-GitHub remote, a PR blocked after a failed
> rebase wait, etc.) — not the decision to start.

This skill reuses the exact same CI/conflict-polling script `shipper` uses
(step 6 of `../shipper/SKILL.md`) — see `../lib/README.md`. Read that script's
contract once; it's not repeated in full here.

# Inputs

- **The repo to triage** — the one whose `origin` remote you're currently
  in. Confirm with `git remote get-url origin` before doing anything else; if
  it's not a `github.com` remote, stop per the note above.
- **Whether interactive clarifying questions are allowed right now** (default:
  yes), same convention as `shipper`.

# Resolve the repo slug once

Same reasoning as `monitor-mr-github.sh`: `gh`'s own repo auto-detection picks
a fork's *parent* repo when `origin` has an `upstream` remote configured, so
resolve it yourself and pass `-R` to every `gh` call from here on, never bare:

```bash
origin_url=$(git remote get-url origin)
repo_slug=$(printf '%s' "$origin_url" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
```

# 1. List every open Dependabot PR

```bash
gh pr list -R "$repo_slug" --state open --author "app/dependabot" \
  --json number,title,headRefName --jq '.[] | "\(.number)\t\(.title)"'
```

If this returns nothing, report that there's nothing to do and stop — don't
invent work.

Otherwise you have a queue of PR numbers. **Process them one at a time, start
to finish, in the order returned** — never in parallel, and never start the
next one until the current one has reached a terminal outcome (merged,
ignored, or blocked — see below). Keep a running tally per PR for the final
report.

# 2. Per PR: check, then act on the result

For **each** PR number in the queue, run the shared monitor script — the
same one `shipper` uses, just pointed at this PR:

```bash
~/.claude/skills/lib/monitor-mr-github.sh <pr-number>
```

(Substitute `~/.agents/skills/lib/monitor-mr-github.sh` if you're running
under `pi` rather than Claude Code — see `scripts/install-skills.sh` in the
`pi-setup` repo for why both exist.)

This call blocks until a verdict, checking for conflicts first and then
polling CI to completion exactly as documented in `shipper`'s step 6. Branch
on its exit code:

## Exit 0 — CI passed, no conflicts: approve and merge

```bash
gh pr review <pr-number> -R "$repo_slug" --approve --body "Automated approval: CI green, no conflicts."
```

Then merge. Respect the repo's actual allowed merge methods instead of
guessing — check once per run (it doesn't change PR to PR):

```bash
gh repo view -R "$repo_slug" --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
```

Prefer `--squash` if allowed (the common choice for dependency-bump PRs since
they're almost always a single logical change), else `--merge`, else
`--rebase`:

```bash
gh pr merge <pr-number> -R "$repo_slug" --squash --delete-branch --auto
```

`--auto` matters even here: branch protection may require the PR to be
up-to-date/re-checked at merge time, and `--auto` lets GitHub complete the
merge itself the instant that settles instead of the command failing outright
because of a race with the base branch. If the merge command itself errors
(e.g. protection rule you don't have permission to satisfy), record that PR as
**blocked** with the exact error and move on to the next PR — don't retry
indefinitely.

Record this PR as **merged** and move to the next PR in the queue.

## Exit 1 — CI failed: ignore

Do nothing to the PR — no approval, no comment, no merge. Record it as
**ignored (CI failed)** for the final report and move to the next PR in the
queue. Don't investigate the failure or try to fix it; that's out of scope
for this skill (a human should look at why a dependency bump broke CI).

## Exit 3 — merge conflicts: nudge Dependabot, then re-check

Post the standard Dependabot rebase-request comment instead of resolving the
conflict yourself — Dependabot owns its own branches, so pushing to one
directly (as `shipper`'s own conflict-resolution step would) isn't yours to
do here:

```bash
gh pr comment <pr-number> -R "$repo_slug" --body "@dependabot rebase"
```

Then wait for Dependabot to actually push the rebase before re-checking —
polling CI immediately would just re-observe the same conflict. Poll the
PR's head commit until it changes from what it was right before the comment,
capping the wait so a Dependabot that never responds (rate-limited, disabled,
etc.) doesn't hang this skill forever:

```bash
before_sha=$(gh pr view <pr-number> -R "$repo_slug" --json headRefOid --jq .headRefOid)
gh pr comment <pr-number> -R "$repo_slug" --body "@dependabot rebase"

attempt=0
max_attempts=20      # ~10 minutes at the default 30s interval
after_sha="$before_sha"
while [ "$after_sha" = "$before_sha" ] && [ "$attempt" -lt "$max_attempts" ]; do
  sleep 30
  after_sha=$(gh pr view <pr-number> -R "$repo_slug" --json headRefOid --jq .headRefOid)
  attempt=$((attempt + 1))
done
```

- **If the head commit changed** (Dependabot pushed a rebase): go back to the
  top of step 2 for this same PR — re-run the monitor script and branch on
  its exit code again. This may cycle a couple of times in principle, but in
  practice a single rebase resolves it; there's no separate retry cap on the
  monitor-script cycle itself, only on this wait-for-push step, so a PR that
  keeps landing back on exit 3 after a real rebase attempt is unusual enough
  to just let play out rather than special-casing it.
- **If it timed out with no new commit**: record this PR as **blocked
  (Dependabot didn't rebase within the wait window)** and move to the next PR
  in the queue. Don't loop the comment again — a second identical comment
  doesn't help if the first one didn't get a response.

## Exit 2 — usage/lookup error

Record this PR as **errored** with whatever the script printed to stderr, and
move to the next PR in the queue. This is a tooling problem (bad PR number,
`gh` auth issue, etc.), not something to retry blindly.

# Report back

Once every PR in the original queue has reached a terminal state, report a
per-PR table: PR number, title, and outcome (`merged` / `ignored — CI
failed` / `blocked — <reason>` / `errored — <reason>`). Don't report success
for a run that merged nothing if the queue was non-empty — state plainly how
many were merged vs. left alone vs. blocked.

# Rules

- Never process more than one PR at a time — finish the current one's
  terminal state before starting the next.
- Never merge a PR whose CI hasn't actually passed, and never merge one that
  still has conflicts (exit 3 must resolve to a fresh exit 0 first).
- Never push directly to a Dependabot-owned branch to resolve a conflict —
  ask Dependabot to rebase via the `@dependabot rebase` comment instead, and
  wait for it to act before re-checking.
- Never re-post the `@dependabot rebase` comment a second time for the same
  PR in one run if the first wait already timed out — record it blocked and
  move on instead.
- Never investigate or attempt to fix a CI failure on a Dependabot PR —
  that's out of scope; just leave it alone and report it.
- Always resolve `repo_slug` explicitly (never bare `gh` repo auto-detection)
  for the same fork/`upstream`-remote reason `monitor-mr-github.sh` does.
