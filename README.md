# pi-setup

Personal [pi](https://buildwithpi.ai/) coding agent setup: skills, extensions, workflows, and
project instructions, structured so a vanilla pi install can pick them all up in one shot.

Modeled on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (published as the
`mitsupi` npm package), which uses the same `package.json` `"pi"` field convention.

## Layout

- `skills/` — slash-command skills (`SKILL.md` + supporting files), installed via the `"pi"` field
  in `package.json`. Currently: `planner`, `beader`, `shipper`, `dependabot`, `delete-comments`, `naming-analyzer` (vendored from softaworks/agent-toolkit), `grill-me`,
  `grilling`, `improve-codebase-architecture` (vendored from mattpocock/skills, see each `SOURCE.md`; `shipper` and `dependabot` share
  `skills/lib/monitor-mr-github.sh`/`monitor-mr-gitlab.sh` for watching MR/PR CI status — see
  `skills/lib/README.md`). `scripts/install-skills.sh` additionally copies `skills/` into the flat,
  non-package skill directories `~/.claude/skills/` (Claude Code) and `~/.agents/skills/` (the
  cross-harness convention `pi` also live-loads) — see `scripts/README.md`.
- `policy/` — the agent guard rules, written once in TypeScript and shared by both harnesses:
  - `require-skills.ts` — stops `git commit`, pushes back on finishing a turn until the required
    skills (listed in `AGENTS.md`) ran on the current branch, and stops changes before `grill-me`
    (see below). A stopped call asks the user, who can allow it once;
  - `no-comments.ts` — refuses (no prompt) edits that add new code comments (existing ones stay; tool
    directives like `eslint-disable` are allowed);
  - `workspace.ts` — the git facts the rules need (branch window start, newest change, repo root);
  - `files.ts` — reading the current file content for comparisons.
- `extensions/` — custom extension **source ported into this repo**, also declared via the `"pi"`
  field (`./extensions/*.ts`). Currently: `require-skills.ts`, `no-comments.ts` — thin pi adapters over
  `policy/`; `extensions/lib/` holds their shared edit-input parsing and the confirm gate, and is not loaded as
  an extension.
- `hooks/` — thin Claude Code adapters over `policy/` (`require-skills.ts`, `no-comments.ts`), run as
  `node hooks/<name>.ts` (Node >= 23.6 runs TypeScript directly; `hooks/lib/` holds the shared
  Claude hook I/O). Registered **globally** in `~/.claude/settings.json` by
  `scripts/install-claude-hooks.mjs` (part of `npm run setup`), pointing at this checkout and pinned
  to the Node binary that ran the installer. A hook that crashes on a tool call asks the user
  with the error; a crash elsewhere (or a hook that fails to load) blocks.
- `tests/` — `npm test` (`node --test`): rule tests as case tables, plus adapter tests against
  temporary git repos.
- `extensions/packages.json` / `scripts/install-packages.js` — extensions that are **installed
  as-is** from npm/GitHub (not vendored here), bulk-installed via `pi install <source>`.
- `themes/` — pi themes, also declared via the `"pi"` field. Currently: `nightowl` (copied from
  [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/main/themes/nightowl.json)).
- `workflows/` — `Workflow` tool scripts. **Not** part of the `"pi"` package field — pi loads saved
  workflows from `~/.pi/workflows/saved/*.json` at the user level, so these are materialized there
  by `scripts/generate-workflow-json.js` instead of being declared in `package.json`.
- `AGENTS.md` — project-level instructions pi auto-loads (`CLAUDE.md` imports it for Claude Code).
  Holds the required-skills order.
- `docs/adr/` — architecture decision records.

### How `require-skills` decides

- Window start: where the branch split from the remote default branch (`git merge-base HEAD
  origin/HEAD`, then `origin/main`, `origin/master`; else HEAD's commit time). Commits and amends
  inside the task keep the history; a new branch or a push to the default branch resets it.
- "Changed" = tracked files with uncommitted changes, untracked files modified after the window
  start (old `.DS_Store`-style leftovers are ignored), or edit-tool calls on files inside the repo
  (edits elsewhere, like `~/.pi/agent/settings.json`, don't count).
- Last edit time = newest mtime of those files / last edit-tool call.
- Skill calls that errored or were refused don't count.
- A workflow or sub-agent named after a required skill counts as that skill
  (`code-review-session-diff` → `code-review`).
- Pass when every required skill ran inside the window **and** `code-review` ran after the
  last edit.
- Blocks `git commit` (also `rtk git commit`) and pushes back once per prompt when finishing.
- A blocked tool call asks you first (Claude Code permission prompt, pi confirm dialog). One allow
  lets that one call through. Where nobody would see a prompt (pi without a UI, Claude Code in
  `bypassPermissions` mode) it denies. A no-comments rule hit never asks; a crash of either guard does.
- Finishing is **not** pushed back when a required skill or `grilling` ran in that turn: it may
  be waiting on the user's answers.
- Before any change: edit tools on files inside the repo, and shell commands that write inside the
  repo, are blocked until `grill-me` ran **and** the user replied after it. `policy/shell.ts` works
  out each command's targets (redirects, `tee`, `mv`, `cp`, `rm`, `touch`, `mkdir`, `ln`, `sed -i`,
  `perl -i`, git write commands), following `cd <dir> &&`, `git -C <dir>`, `~` and `$HOME`. Writes
  that only touch paths outside the repo are allowed. When targets can't be known (other
  variables, `patch`, inline Python with write calls), the command counts as writing the repo.
  `python3 script.py` is not inspected.
- Commits are gated only when they target this repo; `cd ../other && git commit` is not.
- Any uncommitted tracked file counts, including your own unrelated work in progress.
- Why it works this way: `docs/adr/0001-require-skills-window.md`.

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
- [x] Skills (`planner`, `beader`, `shipper`, `dependabot`, `delete-comments`, `naming-analyzer`, `grill-me`, `grilling`, `improve-codebase-architecture`)
- [x] Extensions installed from npm/GitHub (`extensions/packages.json` + `install-packages.js`)
- [x] Extensions ported into this repo (`require-skills.ts`, `no-comments.ts`)
- [x] Theme (`nightowl`)
- [x] `AGENTS.md` (required-skills order)
