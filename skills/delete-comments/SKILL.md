---
name: delete-comments
description: Audit every code comment in a scope (whole repo or a path), sort each one into Tautology / Stale / Excuse / Decision Record, delete or relocate it, file issues for hacks, and add a ratchet so the comment count can only go down. Use when the user asks to clean up, audit, or delete code comments.
disable-model-invocation: true
---

# Delete comments

Comments rot, repeat the code, or excuse hacks. This skill removes them and keeps the
real decisions as ADRs.

Input: a scope. Default is the whole repo. The user may pass a path, e.g. `/delete-comments src/api`.

## 1. Find every comment

- List all comments in the scope (line, block, inline, docstrings/JSDoc).
- Skip tool directives: `eslint-disable`, `@ts-expect-error`, `noqa`, `type: ignore`,
  `prettier-ignore`, `//go:`, shebangs, license headers, encoding lines.
- Skip generated and vendored code (`node_modules`, `dist`, `vendor`, lock files, `*.gen.*`).

## 2. Sort each comment

| Type | Means |
|---|---|
| **Tautology** | Repeats what the code already shows. |
| **Stale** | Refers to code or behaviour that is no longer true. |
| **Excuse** | Lets a hacky implementation slide ("temporary", "workaround", "TODO: fix", "hack"). |
| **Decision Record** | Records an important, non-obvious decision about the code. |

When unsure between Tautology and Decision Record, ask: would a new teammate make a wrong
change without it? Yes → Decision Record.

## 3. Act on each comment

- **Tautology / Stale** → delete it. If the code is unclear without it, rename or extract
  instead — make the code say it.
- **Excuse** → delete it and file an issue to fix the hack.
  Use the repo's tracker: `bd create` if `.beads/` exists, else `glab issue create` for
  GitLab remotes, else `gh issue create`. If none works, list the issues in the report.
  One issue per hack; quote the old comment and link the file/line.
- **Decision Record** → move it into an ADR, then delete the comment.
  - Location: `docs/adr/NNNN-short-title.md` (create `docs/adr/` if missing; next free number).
  - Format: `# Title`, `## Status` (Accepted), `## Context`, `## Decision`, `## Consequences`.
  - Group related comments into one ADR.

Show the full categorised list to the user and get a yes before deleting anything.

## 4. Add a ratchet

Not every comment will go in one PR, so the count may only go down from here.

- Prefer the project's linter if it can ban comments for the scope. Otherwise add a small
  check script (e.g. `scripts/check-comment-budget`) that:
  - counts comments in the scope (same rules as step 1),
  - compares against a committed baseline file (e.g. `.comment-budget`),
  - fails if the count went up, and rewrites the baseline when it went down.
- Wire it into CI and the project's existing check/lint command.

## 5. Report

- Counts per type, and what was done.
- ADRs created, issues filed.
- Lines removed so far, and an estimate of lines shed if every remaining comment goes.
