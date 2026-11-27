# 3. Each tool has its own guards switch

## Status

Accepted (2026-11-27). Supersedes [0002](0002-guards-switch.md).

## Context

ADR 0002 made one flag file turn the guards off in Claude Code and pi together. Running
`/guards off` in Claude Code then also turned them off in pi, which the user did not expect: a
command run in one tool should only change that tool.

## Decision

- One flag file per tool: `~/.config/agent-guards/off-claude` and `~/.config/agent-guards/off-pi`.
  No flag means on.
- `/guards off`, `/guards on` and `/guards` (state) only touch the tool they run in:
  - Claude Code: `~/.claude/commands/guards.md` runs `scripts/guards.ts`, which switches `claude`;
  - pi: `extensions/guards.ts` registers the command and switches `pi`.
- Claude Code checks its flag once per hook, in `runHook` (`hooks/lib/claude-io.ts`); pi checks its
  flag once per handler, through `whenPiGuardsOn` (`extensions/lib/pi-gate.ts`).
- The old shared flag `~/.config/agent-guards/off` is no longer read.
- `AGENT_GUARDS_DIR` overrides the flag folder (tests use it).
- The rest of ADR 0002 still holds: applies at once with no restart, no timer, the agent is not
  told, and an agent could create a flag itself.

## Consequences

- Turning the guards off everywhere takes `/guards off` in each tool.
- Still no way to turn off only one guard or only one repo.
