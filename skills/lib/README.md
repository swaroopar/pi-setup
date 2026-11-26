# skills/lib

Shell scripts shared by more than one skill — not a skill itself (no
`SKILL.md`), so it's never offered as a slash command. `scripts/install-skills.sh`
still installs it alongside the real skills so the hardcoded paths the skills
reference (`~/.claude/skills/lib/...`, `~/.agents/skills/lib/...`) resolve.

- `monitor-mr-github.sh` / `monitor-mr-gitlab.sh` — poll an MR/PR for merge
  conflicts and CI/pipeline status, dumping failed-job logs on failure. Used
  by `shipper` (step 6) and `dependabot` (its whole CI-wait loop). See either
  skill's `SKILL.md` for the calling contract and exit codes.
