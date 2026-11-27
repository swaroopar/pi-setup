# AGENTS

## Required skills for every change

Every code change goes through these skills, **always in this order**:

1. `codebase-design` — before coding: shape the modules and interfaces.
2. `grill-me` — before coding: stress-test the plan.
3. `improve-codebase-architecture` — before coding: look for deepening opportunities.
4. Make the change.
5. `naming-analyzer` — after coding: check the names in the changed code. Apply renames.
6. `code-review` — after the last edit. Edit again → run `code-review` again.

Rules:

- A new branch (or a push to the default branch) resets the cycle. Within a branch, the
  before-coding skills count once; `code-review` must still run after every last edit.
- `grill-me` comes before **any** file change. Run it, then stop and wait for the user's answers.
- When a skill asks the user something, end your turn and wait. Don't start the next skill
  until the current one is finished.
- When you run a required skill through a workflow or sub-agents, name the run after the skill
  (e.g. `code-review-session-diff`), so the hooks count it.
- Load each skill yourself (Claude Code: the Skill tool; pi: read the skill's `SKILL.md`). Doing
  the steps without loading the skill doesn't count, and skills loaded before this branch started
  don't count. Only if loading fails, ask the user to run it (Claude Code: `/<skill>`, pi: `/skill:<skill>`).
- Hooks enforce this (rules in `policy/require-skills.ts`; adapters `hooks/require-skills.ts` for Claude Code, `extensions/require-skills.ts` for pi):
  - file edits and shell commands that write inside the repo are blocked until `grill-me` ran and the user answered;
  - `git commit` is blocked until all five ran;
  - a blocked call asks the user; one allow lets that one call through. Where no prompt is possible
    (pi print mode, Claude Code `bypassPermissions`) it is denied. A hook crash on a tool call asks too;
  - finishing a turn is pushed back once, unless a required skill or `grilling` ran in that turn
    (it may be waiting on you).

- The user can turn the guards off and on with `/guards off` / `/guards on`. Each tool has its own
  switch: the command only affects the tool it runs in (Claude Code or pi). Don't do it yourself.

## No code comments

- Don't write code comments. Make the code say it: clear names, types, small functions.
- A non-obvious decision goes in an ADR: `docs/adr/NNNN-short-title.md`.
- Allowed: tool directives only (`eslint-disable`, `@ts-expect-error`, `noqa`, `type: ignore`, shebangs).
- Hooks block edits that add comments, without asking
  (rules in `policy/no-comments.ts`; adapters `hooks/no-comments.ts` for Claude Code, `extensions/no-comments.ts` for pi).
- To clean up existing comments, the user runs `/delete-comments [path]`
  (pi: `/skill:delete-comments [path]`).
