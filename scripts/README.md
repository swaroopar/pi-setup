# generate-workflow-json.js

Generates saved-workflow JSON files from every workflow `.js` source file in `workflows/`, and
writes them directly into the pi user-level saved-workflows directory (`~/.pi/workflows/saved/`) —
the same directory a pi session loads saved workflows from. No JSON is kept in this repo.

It also copies `skills/lib/monitor-mr-gitlab.sh` and `monitor-mr-github.sh` into that same
`~/.pi/workflows/saved/` directory: `bead-shipper-workflow.js` tells the user to run those scripts
from `~/.pi/workflows/saved/`, so they need to live there too, not just in `skills/lib/` (the
directory shared by `shipper` and `dependabot`, see `skills/lib/README.md`).

## Usage

```bash
node scripts/generate-workflow-json.js
```

Takes no arguments: it scans every `.js` file in `workflows/`, extracts each one's `meta.name`/`meta.description`,
and writes `~/.pi/workflows/saved/<meta.name>.json` (overwriting any existing file with the same name),
then copies the two `monitor-mr-*.sh` scripts from `skills/lib/` into the same directory
(overwriting any existing copies, executable bit preserved).

## Example

```bash
node scripts/generate-workflow-json.js
# Wrote /Users/you/.pi/workflows/saved/bead_shipper_v2.json (name="bead_shipper_v2")
# Wrote /Users/you/.pi/workflows/saved/bead_shipper_batch.json (name="bead_shipper_batch")
# Wrote /Users/you/.pi/workflows/saved/monitor-mr-gitlab.sh
# Wrote /Users/you/.pi/workflows/saved/monitor-mr-github.sh
```

# install-skills.sh

Copies every entry under this repo's `skills/` (each skill directory, plus the shared non-skill
`skills/lib/` helper directory — see `skills/lib/README.md`) into the plain, flat skill directories
that harnesses actually read skills from on this machine — **not** a `"pi"`-field/package
mechanism, just directories full of files:

- `~/.claude/skills/` — Claude Code's own live skill directory.
- `~/.agents/skills/` — the cross-harness convention `pi` live-loads unconditionally every session
  (confirmed by reading its bundled source), on equal footing with its own `~/.pi/agent/skills/`.
  This directory is separately owned by a skill-installer tool on this machine (see its sibling
  `~/.agents/.skill-lock.json`, which tracks installed skills by source/hash) — this script writes
  plain directories into it rather than going through that tool, so entries copied here won't
  appear in its lock file.

The `~/.claude/skills/` target is only touched if `~/.claude` already exists, so this never creates
a config directory for a harness that isn't installed on the machine; `~/.agents/skills/` has no
single owning tool, so it's always created. Existing entries with the same name are overwritten;
nothing already in a target that doesn't correspond to a directory under this repo's `skills/` is
touched or removed (e.g. third-party skills that aren't part of this repo, or that other
skill-installer tool's own managed skills).

## Usage

```bash
scripts/install-skills.sh
```

Plain bash — no JSON parsing or JS object-literal extraction needed here (unlike the two scripts
above), so it doesn't need a JS runtime. Takes no arguments. Safe to re-run any time after
adding/editing a skill — that's how `npm run setup` picks up changes.

## Example

```bash
scripts/install-skills.sh
# /Users/you/.claude/skills/beader
# /Users/you/.claude/skills/lib
# /Users/you/.claude/skills/planner
# /Users/you/.claude/skills/shipper
# /Users/you/.claude/skills/dependabot
# /Users/you/.agents/skills/beader
# /Users/you/.agents/skills/lib
# /Users/you/.agents/skills/planner
# /Users/you/.agents/skills/shipper
# /Users/you/.agents/skills/dependabot
```
