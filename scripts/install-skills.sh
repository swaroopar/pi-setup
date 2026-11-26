#!/usr/bin/env bash
# Copies every entry under this repo's skills/ (each skill directory, plus the shared non-skill
# skills/lib/ helper directory) into the plain, flat skill directories two things actually load
# skills from directly:
#
#   - ~/.claude/skills/ -- Claude Code's own live skill directory.
#   - ~/.agents/skills/ -- the cross-harness convention `pi` live-loads unconditionally every
#     session (confirmed in its bundled source), alongside its own ~/.pi/agent/skills/. This
#     directory is also owned by a separate skill-installer tool (see its sibling
#     ~/.agents/.skill-lock.json) -- we deliberately write plain directories into it rather than
#     going through that tool, so entries copied here won't show up in its lock file.
#
# Neither is a package cache pi/Claude Code manage for us via `pi install .` -- they're plain
# directories that were being kept in sync by hand before this script existed. Skips the Claude
# Code target if ~/.claude doesn't exist, so this never creates it for a machine that doesn't have
# Claude Code installed; ~/.agents has no single owning tool, so it's always created. Safe to
# re-run.
#
# Usage: scripts/install-skills.sh (no arguments)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="$ROOT_DIR/skills"

install_to() {
  local target_skills_dir="$1"
  mkdir -p "$target_skills_dir"
  for entry in "$SKILLS_DIR"/*; do
    [ -d "$entry" ] || continue
    local name dest
    name="$(basename "$entry")"
    dest="$target_skills_dir/$name"
    # Remove-then-copy (not just an overwrite) so a file deleted/moved out of a skill in this repo
    # (e.g. skills/shipper/monitor-mr-*.sh moving to skills/lib/) actually disappears from the
    # target too, instead of lingering as a stale copy forever.
    rm -rf "$dest"
    cp -R "$entry" "$dest"
    echo "$dest"
  done
}

if [ -d "$HOME/.claude" ]; then
  install_to "$HOME/.claude/skills"
else
  echo "skip (harness not installed): $HOME/.claude does not exist"
fi

install_to "$HOME/.agents/skills"
