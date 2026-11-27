# 2. One global switch turns the agent guards off

## Status

Superseded by [0003](0003-per-tool-guards-switch.md) (2026-11-27)

## Context

The guards (require-skills, no-comments) are sometimes in the way: quick experiments, repos where
the rules don't fit, or a guard that is wrong. Uninstalling them means editing
`~/.claude/settings.json`, removing the pi package and restarting, which can't be done from inside
a running session.

## Decision

- One flag file, `~/.config/agent-guards/off`, turns every guard off: require-skills and
  no-comments, in Claude Code and pi, in every repo and session. No flag means on.
- `/guards off`, `/guards on` and `/guards` (state) work inside a session:
  - pi: a command registered by `extensions/require-skills.ts`;
  - Claude Code: `~/.claude/commands/guards.md`, written by `scripts/install-claude-guards.mjs`,
    runs `scripts/guards.ts`.
- Every hook and extension handler checks the flag on each call, so the switch applies at once,
  with no restart. Off lasts until `/guards on`; there is no timer.
- While off, nothing is enforced and the agent is not told; AGENTS.md still describes the rules.
- `AGENT_GUARDS_OFF_FILE` overrides the flag path (tests use it).

## Consequences

- One switch for everything: no way to turn off only one guard or only one repo.
- An agent could create the flag file itself. The guards exist to steer a cooperative agent, not
  to stop a hostile one, so this is accepted.
