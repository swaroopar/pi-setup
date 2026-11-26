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

- A commit resets the cycle. The next change needs all five again.
- If you can't invoke a skill yourself, ask the user to run it
  (Claude Code: `/<skill>`, pi: `/skill:<skill>`).
- Hooks enforce this: `git commit` is blocked and finishing a turn is
  pushed back until the skills have run
  (`hooks/require-skills.py` for Claude Code, `extensions/require-skills.ts` for pi).

## No code comments

- Don't write code comments. Make the code say it: clear names, types, small functions.
- A non-obvious decision goes in an ADR: `docs/adr/NNNN-short-title.md`.
- Allowed: tool directives only (`eslint-disable`, `@ts-expect-error`, `noqa`, `type: ignore`, shebangs).
- Hooks block edits that add comments
  (`hooks/no-comments.py` for Claude Code, `extensions/no-comments.ts` for pi).
- To clean up existing comments, the user runs `/delete-comments [path]`
  (pi: `/skill:delete-comments [path]`).
