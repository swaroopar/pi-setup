# 1. How require-skills decides which work counts

## Status

Accepted (2026-11-26)

## Context

The `require-skills` rules (`policy/require-skills.ts`, used by `hooks/require-skills.ts` for Claude Code
and `extensions/require-skills.ts` for pi) force every change through `codebase-design` → `grill-me` → `improve-codebase-architecture`
→ `naming-analyzer` → `code-review`, and block file changes until `grill-me` has been answered.

Earlier versions measured everything from HEAD's commit time. A commit or amend in the middle of a
task wiped the history, so skills that had already run (and the user's grilling answers) stopped
counting and the agent got stuck. Old untracked files (`.DS_Store`, scratch JSON) also made the
tree look "changed" forever, and refused skill calls were counted as runs.

## Decision

- **Window start** is the commit where the branch split from the remote default branch:
  `git merge-base HEAD <ref>` for the first of `origin/HEAD`, `origin/main`, `origin/master` that
  resolves, using that commit's committer time. Without a remote: HEAD's commit time.
- **Cycle**: before-coding skills count once per branch; `code-review` must run after the last
  edit. A new branch, or a push when working directly on the default branch, starts a new cycle.
- **Changed files**: tracked files with uncommitted changes always count; untracked files only
  when modified after the window start.
- **Failed calls**: a skill call whose result is an error (refused, denied, failed) doesn't count.
- **Grill gate**: unlocked only by a successful `grill-me` run followed by a real user reply.
- **Stop / settle**: not pushed back in a turn where a required skill or `grilling` ran, because
  the agent may be waiting on the user.
- **Paths decide, not command shapes**: `policy/shell.ts` turns a shell command into the
  directories it commits and the paths it writes (following `cd`, `git -C`, `~`, `$HOME`). Only
  writes inside the repo hit the grill gate, and only commits targeting the repo hit the commit
  gate. Edit-tool calls on files outside the repo don't count as changes. Anything whose targets
  can't be known (other variables, `patch`, inline Python with write calls) counts as the repo.
  `python3 script.py` is not inspected.

- **Lazy inputs**: the rules receive session events as a function and git facts through a small
  `Workspace` interface (`policy/workspace.ts`), not precomputed values. Most hook calls (reads,
  read-only shell) never need them, so they never parse the session log or run git.
- **Fail safe**: if a hook or extension throws, it blocks with an explanation instead of allowing.
  Claude hooks are registered as `node … || exit 2`, so even a hook that fails to load (exit 1,
  which Claude Code treats as non-blocking) blocks.
- **Unknown always means "this repo"**: an unknown commit target falls back to the current
  directory and an unknown write target makes the command count as writing the repo. Both are
  gated; they differ only in shape because a commit needs a directory to compare.
- **Shell scope**: `cd` inside `( … )` or a pipeline doesn't carry over; `cd X || …` and `cd -`
  make the directory unknown. `env`, `sudo`, `rtk`, `uv run` prefixes are stripped, and
  `bash -c '…'` scripts are analysed too.
- **Known gaps** (heuristic, not a sandbox): `python3 script.py`, `node -e`, `make`, `npm run …`
  and other programs that write files internally are not inspected; the `git status`-based
  commit gate is the backstop.

## Consequences

- Committing in small steps on a branch is free: no re-grilling per commit.
- Working directly on `main` resets the cycle at each push, not each commit.
- Shell-write detection is a heuristic; the commit gate (`git status` based) is the backstop.
- Any uncommitted tracked change counts, including unrelated work in progress.
