# 1. How require-skills decides which work counts

## Status

Accepted (2026-11-26)

## Context

The `require-skills` hooks (`hooks/require-skills.py` for Claude Code, `extensions/require-skills.ts`
for pi) force every change through `codebase-design` → `grill-me` → `improve-codebase-architecture`
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
- **Shell writes**: detected by command shape (`sed -i`, redirects, `tee`, `mv`, `cp`, `rm`, git
  write commands, inline Python with write calls). Redirects to `/tmp` are allowed; inline Python
  writes are blocked wherever they point; `python3 script.py` is not inspected.

## Consequences

- Committing in small steps on a branch is free: no re-grilling per commit.
- Working directly on `main` resets the cycle at each push, not each commit.
- Shell-write detection is a heuristic; the commit gate (`git status` based) is the backstop.
- Any uncommitted tracked change counts, including unrelated work in progress.
