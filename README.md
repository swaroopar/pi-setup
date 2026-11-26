# pi-setup

Personal [pi](https://buildwithpi.ai/) coding agent setup: skills, extensions, workflows, and
project instructions, structured so a vanilla pi install can pick them all up in one shot.

Modeled on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (published as the
`mitsupi` npm package), which uses the same `package.json` `"pi"` field convention.

## Layout

- `skills/` — slash-command skills (`SKILL.md` + supporting files), installed via the `"pi"` field
  in `package.json`. Currently: `planner`, `beader`, `shipper`, `dependabot`, `delete-comments` (`shipper` and `dependabot` share
  `skills/lib/monitor-mr-github.sh`/`monitor-mr-gitlab.sh` for watching MR/PR CI status — see
  `skills/lib/README.md`). `scripts/install-skills.sh` additionally copies `skills/` into the flat,
  non-package skill directories `~/.claude/skills/` (Claude Code) and `~/.agents/skills/` (the
  cross-harness convention `pi` also live-loads) — see `scripts/README.md`.
- `extensions/` — custom extension **source ported into this repo**, also declared via the `"pi"`
  field. Currently: `require-skills.ts`, `no-comments.ts` (see `hooks/` below).
- `hooks/require-skills.py` + `.claude/settings.json` — Claude Code twin of
  `extensions/require-skills.ts`. Both block `git commit` and push back on finishing a turn until
  the required skills (listed in `AGENTS.md`) ran since the last commit.
- `hooks/no-comments.py` — Claude Code twin of `extensions/no-comments.ts`. Both block edits that
  add new code comments (existing ones stay; tool directives like `eslint-disable` are allowed).
- `extensions/packages.json` / `scripts/install-packages.js` — extensions that are **installed
  as-is** from npm/GitHub (not vendored here), bulk-installed via `pi install <source>`.
- `themes/` — pi themes, also declared via the `"pi"` field. Currently: `nightowl` (copied from
  [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/themes/nightowl.json)).
- `workflows/` — `Workflow` tool scripts. **Not** part of the `"pi"` package field — pi loads saved
  workflows from `~/.pi/workflows/saved/*.json` at the user level, so these are materialized there
  by `scripts/generate-workflow-json.js` instead of being declared in `package.json`.
- `AGENTS.md` — project-level instructions pi auto-loads (`CLAUDE.md` imports it for Claude Code).
  Holds the required-skills order.

## Install on a vanilla pi setup

Clone this repo, then run the one command:

```bash
npm run setup
```

That's `package.json`'s `scripts.setup`, which chains all four underlying steps:

```bash
# 1. Register this repo's skills + ported extensions as a pi package
pi install .

# 2. Bulk-install the extensions that just come from npm/GitHub as-is
node scripts/install-packages.js

# 3. Materialize the saved workflows (separate mechanism, see workflows/README.md)
node scripts/generate-workflow-json.js

# 4. Copy skills/ into the flat skill directories Claude Code / pi load from directly
scripts/install-skills.sh
```

Step 1 registers this checkout's path in the `packages` array in `~/.pi/agent/settings.json` —
the same way `git:github.com/DietrichGebert/ponytail` shows up there today (use `pi install
git:github.com/<your-github-user>/pi-setup` instead if you'd rather pi manage its own clone under
`~/.pi/agent/git/` than point at this working copy). From then on, every pi session discovers
`skills/` and `extensions/` from this repo automatically. `pi update` pulls future changes; `pi
remove <source>` uninstalls it; `pi config` opens a TUI to toggle individual resources on/off.

Step 2 loops over `extensions/packages.json` (currently a snapshot of this machine's own
`~/.pi/agent/settings.json` `packages` array — prune it to taste), runs `pi install <source>` for
each npm:/git: source not already installed, then applies any per-package resource filters
declared there (e.g. `git:github.com/mitsuhiko/agent-stuff` is installed in full for `pi update`
but filtered down to 6 of its 18 extensions and 4 of its 19 skills) by writing pi's documented
filter object form straight into `~/.pi/agent/settings.json` — see `extensions/README.md`. No `pi
config` TUI step needed; it's all file-based and idempotent.

Step 3 is separate because saved `Workflow` definitions aren't a `"pi"`-field resource type — no
installed package declares a `"workflows"` key; `~/.pi/workflows/saved/` is user state, not
package content. See `scripts/README.md` for details.

Step 4 is also separate from the `"pi"` field: registering this repo as a package (step 1) is
enough for a `pi` session run *against this checkout's path*, but Claude Code has no package
mechanism at all. `scripts/install-skills.sh` instead copies every entry under `skills/` (including
the non-skill `lib/` helper directory) into `~/.claude/skills/` and `~/.agents/skills/` — the latter
a cross-harness convention `pi` live-loads unconditionally every session alongside its own package
mechanism, and one that's also managed by a separate skill-installer tool on this machine (it has
its own `~/.agents/.skill-lock.json`); this script writes plain directories there rather than going
through that tool, so these entries won't show up in its lock file. See `scripts/README.md` for
details.

`npm run setup` is idempotent — re-run it any time to pick up new skills, new entries in
`extensions/packages.json`, or new/changed workflow files.

## Status

- [x] Workflows (`bead_shipper`, `bead_shipper_batch`)
- [x] Skills (`planner`, `beader`, `shipper`, `dependabot`, `delete-comments`)
- [x] Extensions installed from npm/GitHub (`extensions/packages.json` + `install-packages.js`)
- [x] Extensions ported into this repo (`require-skills.ts`, `no-comments.ts`)
- [x] Theme (`nightowl`)
- [x] `AGENTS.md` (required-skills order)
