# extensions

Two kinds of extension live here:

- **Ported source** -- custom extension code vendored directly into this folder, declared via
  `package.json`'s `"pi.extensions"` field (same mechanism as `skills/`). Currently: `require-skills.ts`, `no-comments.ts` (thin adapters; the rules live in `../policy/`).
- **Installed as-is** -- extensions pulled straight from npm/GitHub, listed in `packages.json` and
  bulk-installed via `../scripts/install-packages.js` (`pi install <source>` per entry).

## Partial packages: only using some resources from a package

`pi` doesn't support installing a package partially -- the whole checkout is what `pi update`
keeps in sync -- but `packages.json` entries can carry `extensions`/`skills`/`prompts`/`themes`
filter arrays, matching the "Package Filtering" object form for a `packages` entry documented in
pi's own `docs/packages.md`. `scripts/install-packages.js` installs the source, then writes that
filtered object form straight into `~/.pi/agent/settings.json` for you -- no `pi config` TUI
needed, and it's idempotent (re-running only rewrites the entry if the filter actually changed).

Rules, from pi's docs:
- Omit a key to load all of that type; use `[]` to load none.
- Array entries are glob patterns (exact paths work too) that narrow the manifest's resources.
- `!pattern` excludes a match; `+path`/`-path` force include/exclude an exact path.

### `git:github.com/mitsuhiko/agent-stuff`

Sourced via `git:`, not `npm:mitsupi` -- the last npm publish (`mitsupi@1.6.0`, 2026-04-17) lags
behind the repo's `main` branch (missing `no-sleep.ts`, `continue.ts`, `goal.ts`, `subagent.ts`,
`trust-github-repos.ts`, `unified-edit.ts`, and a `dayowl`/`modern-dark` theme; still has the
older `loop.ts`/`multi-edit.ts` names that `main` renamed to `continue.ts`/`unified-edit.ts`).
Tracking git gets upstream changes without waiting on the next npm release.

Installed in full (so `pi update` keeps pulling upstream changes), but filtered via `packages.json`
to only these resources -- each key (`extensions`, `skills`) is filtered independently; everything
else of that type from the package is disabled:

Extensions (7 of 18):
- `answer.ts` -- interactive TUI for answering questions one by one
- `continue.ts` -- prompt loop for rapid iterative coding with optional auto-continue
- `no-sleep.ts` -- prevents macOS from sleeping (via `caffeinate`) while the agent is running
- `unified-edit.ts` -- replaces the built-in edit tool with batch/patch support
- `notify.ts` -- native desktop notifications when the agent finishes
- `prompt-editor.ts` -- in-editor prompt mode selector
- `uv.ts` -- helpers for uv-based Python workflows

Skills (4 of 19):
- `github` -- interact with GitHub using the `gh` CLI (issues, PRs, runs, APIs)
- `native-web-search` -- trigger native web search with concise summaries and source URLs
- `uv` -- use `uv` for Python dependency management and script execution
- `web-browser` -- browser automation via Chrome/Chromium CDP

Its prompts/themes are unfiltered (all load) since neither key is set on the entry -- add a
`"prompts": [...]`/`"themes": [...]` key to also narrow those.
