# Workflows

## bead_shipper

Ship a bead: implement -> verify -> commit -> MR. Source: `bead-shipper-workflow.js` (saved workflow name `bead_shipper`).

Quality gates are a required `checks` array of `{name, command}` objects (each command must exit 0 to pass) --
there is no default, every invocation must pass its own array, so any project/language can define its own gates.

No model name is ever assumed by default either: pass `model` to pin every step to one model, or pass both
`implementModel` and `otherStepsModel` -- whichever of those `model` doesn't cover is required and the
workflow throws immediately if it's missing. `implementFallbackModel` is optional and defaults to
`implementModel` when not given.

By default `bd` commands auto-discover `.beads/*.db` from the checkout the workflow runs in. Pass `beadsDir`
(an absolute path) when the beads database actually lives elsewhere -- e.g. a dedicated `bead-workspace`
checked out under the user's home directory rather than inside this checkout -- and it's appended as `bd`'s
own `-C <beadsDir>` flag to every `bd` call this workflow makes.

### Example invocation

Old way:
```
/bead_shipper_v2 {"beadId": "confluence-graphrag-2ai", "targetBranch": "feature/attachmentExportChange", "implementModel": "Qwen3.6-35B-A3B-4bit", "otherStepsModel": "Qwen3.6-35B-A3B-4bit", "setupCommand": "uv sync", "lintCheckCommand": "uv run ruff check src tests", "lintFormatCommand": "uv run ruff format --check src tests", "typeCheckCommand": "uv run mypy src", "testCommand": "uv run pytest --junitxml=reports/pytest.xml"}
```

New way:
```
/bead_shipper {"beadId": "confluence-graphrag-2ai", "targetBranch": "feature/attachmentExportChange", "implementModel": "Qwen3.6-35B-A3B-4bit", "otherStepsModel": "Qwen3.6-35B-A3B-4bit", "setupCommand": "uv sync", "checks": [{"name": "lintCheck", "command": "uv run ruff check src tests"}, {"name": "lintFormat", "command": "uv run ruff format --check src tests"}, {"name": "typeCheck", "command": "uv run mypy src"}, {"name": "test", "command": "uv run pytest --junitxml=reports/pytest.xml"}]}
```

For a different project/language, pass your own `checks`, e.g. Node:
```
"checks": [{"name": "lint", "command": "npm run lint"}, {"name": "test", "command": "npm test"}]
```

If the beads database lives outside this checkout, add `beadsDir`:
```
"beadsDir": "/Users/you/bead-workspace"
```

If the actual project (pyproject.toml/package.json/etc.) lives in a subdirectory of the checkout rather than
at its root (e.g. a monorepo), add `projectSubdir` -- `setupCommand` and every `checks[].command` then run as
`cd <projectSubdir> && <command>` instead of at the repo root. Git/bd/MR operations are unaffected. Only set
this when the workflow's own working directory is the *outer* repo root -- if it's already launched from
inside the project subdirectory, leave `projectSubdir` unset (it would otherwise `cd` into a nested, nonexistent
copy of that same path):
```
"projectSubdir": "Agents/app/FlakyTestAgent"
```

Commits are never attributed to whatever ambient git identity the harness/agent process happens to have. Pass
`commitUserName`/`commitUserEmail` to pin the exact identity the ship step sets (local `git config`, no
`--global`, no `--author` override) before every commit:
```
"commitUserName": "Jane Doe", "commitUserEmail": "jane@example.com"
```
If omitted, the ship step derives the real identity itself from the authenticated `gh`/`glab` account instead
(GitHub: name + `<id>+<login>@users.noreply.github.com`; GitLab: name + real/public email or a noreply
fallback), and reports a `blocked` status rather than committing under an unverified identity if neither is
authenticated.

A monitor-script exit code of `4` (no CI checks/pipeline ever registered for the MR/PR after its own polling --
e.g. this repo's CI only triggers on a different branch, or there's no CI at all) is treated as ship status
`"success"` with `ciStatus: "no_ci_configured"`, not `"blocked"`/`"ci_failed"` -- there's nothing to verify, so
it won't loop forever waiting on a signal that will never arrive.

## bead_shipper_batch

Ships every bead returned by `bd ready`, calling `bead_shipper` once per bead. Source: `bead-shipper-batch.js`.
Accepts the same args as `bead_shipper` (passed through unchanged to each child run, `checks` and `beadsDir`
included -- still required/applied the same way) plus `maxBeads` and `stopOnFirstFailure`. `beadsDir`, if
given, is also applied to this workflow's own `bd ready`/`bd show`/`bd reopen` calls, and this workflow's own
query steps require `model` or `otherStepsModel` in the input JSON (no default model name is assumed).

### Example invocation

```
/bead_shipper_batch {"targetBranch": "feature/attachmentExportChange", "implementModel": "Qwen3.6-35B-A3B-4bit", "otherStepsModel": "Qwen3.6-35B-A3B-4bit", "setupCommand": "uv sync", "checks": [{"name": "lintCheck", "command": "uv run ruff check src tests"}, {"name": "lintFormat", "command": "uv run ruff format --check src tests"}, {"name": "typeCheck", "command": "uv run mypy src"}, {"name": "test", "command": "uv run pytest --junitxml=reports/pytest.xml"}], "maxBeads": 5, "stopOnFirstFailure": true}
```

`beadId` is omitted (and ignored if given) -- each ready bead is picked up from `bd ready --json`
in turn. `maxBeads` caps this run to 5 beads (default: unlimited); `stopOnFirstFailure` aborts the
whole batch on the first child failure instead of continuing to the next bead (default: `false`).
