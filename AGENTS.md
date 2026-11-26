# AGENTS

## Required skills for every change

Every code change goes through these skills, **always in this order**:

1. `codebase-design` — before coding: shape the modules and interfaces.
2. `grill-me` — before coding: stress-test the plan.
3. `improve-codebase-architecture` — before coding: look for deepening opportunities.
4. Make the change.
5. `code-review` — after the last edit. Edit again → run `code-review` again.

Rules:

- A commit resets the cycle. The next change needs all four again.
- If you can't invoke a skill yourself, ask the user to run it
  (Claude Code: `/<skill>`, pi: `/skill:<skill>`).
- Hooks enforce this: `git commit` is blocked and finishing a turn is
  pushed back until the skills have run
  (`hooks/require-skills.py` for Claude Code, `extensions/require-skills.ts` for pi).
