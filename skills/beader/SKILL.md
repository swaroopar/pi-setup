---
name: beader
description: Pick up one or more ready beads from beads (bd) in the current project and run each one's full lifecycle via a dedicated beader-orchestrator subagent. Takes optional args controlling how many beads and whether they run serially or in parallel. Only ever runs when explicitly invoked as /beader.
disable-model-invocation: true
---

> **Cross-harness note:** this file names Claude Code's exact `Agent` tool for
> precision. If you're running this under a different harness, dispatch
> `beader-orchestrator` using your environment's own native subagent mechanism
> instead — never write or run a script to spawn it yourself.

# Parameters

Parse these from the slash-command's argument string:

- `count` (integer, or the literal **`all`**; default **1**): how many beads
  to process this invocation. `all` means every ready candidate in scope —
  which is every ready bead in the resolved `group` (the one passed, or the
  one the user picks via `AskUserQuestion` when more than one is found; see
  `group` below), or every ready candidate overall if there's only one group
  in play. `all` is ignored (has no effect) when explicit bead ID(s) are
  given instead — that list already says exactly which beads to process.
- `mode` (`serial` | `parallel`, default **serial**): whether beads are handed
  to workers one at a time or all at once.
- `include-claimed` (flag, default **off**): by default, selection — whether
  via `bd ready` or an explicit bead ID — only ever considers open, unclaimed
  beads; an already-claimed (in_progress) bead is left untouched even if
  named explicitly. Pass this flag to also allow picking up beads that are
  claimed/in_progress but not yet closed (e.g. to resume stalled work).
  Closed beads are always excluded regardless of this flag.
- `autoclose` (flag, default **off**): by default, a bead is left
  open/in-progress no matter how the run went — closing is never implied by a
  green `shipper` report. Pass this flag to have each `beader-worker` close
  its bead itself once it finishes with a genuinely successful outcome
  (shipped-and-green, or correctly determined no-change-needed). A blocked or
  escape-hatched bead is never closed, autoclose or not.
- `group` (string, default **none**): restrict `bd ready` selection to beads
  belonging to one plan/feature group. This project's convention is a
  `[group-slug]` prefix on the bead title (e.g. `[fix-german-umlaut-tokenization]
  Widen tokenizer regex...`); beads with no such prefix belong to the implicit
  `(ungrouped)` group. Pass the slug itself (without brackets), or the literal
  `ungrouped` to select untagged beads. Ignored when explicit bead ID(s) are
  given. Pairing an explicit `group` with `count=all` is the normal way to
  say "work every ready bead in this group" — see `count` above.
- Explicit bead ID(s) instead of/alongside a count (e.g. `/beader
  confluence-graphrag-abc`): process exactly those beads, bypassing `bd
  ready` selection. `count` is then however many IDs were named.
- `sub-agent` (flag, default **off**): if true, then use bead orchestrator and bead worker.
   otherwise run in the same session. 
Accept `count` (an integer or the literal `all`), `mode`, `include-claimed`,
`group`, and `autoclose` in any order (`/beader 3 parallel include-claimed`,
`/beader all parallel`, and `/beader include-claimed parallel 3` are all
valid). If nothing parses — args are empty, garbled, or absent — fall back to
the defaults (1, serial, include-claimed off, group unset, autoclose off) and
say so in your first response rather than guessing.

## Dispatch - If sub Agents Requested

Dispatch the `beader-orchestrator` subagent exactly once, via your harness's
native subagent mechanism (the `Agent` tool in Claude Code, `run_in_background:
false`), with a prompt stating the parsed `count`, `mode`, `include-claimed`,
`group`, `autoclose`, and/or explicit bead ID(s). Do not select beads, run `bd`/`git`
yourself, or dispatch workers directly in this skill turn — that is entirely
`beader-orchestrator`'s job. Do not write or run a script to spawn it; use
your harness's built-in subagent-dispatch facility. If `group` was not
passed and `beader-orchestrator` finds more than one group among the ready
candidates, it will ask the user which one to work on itself (via
`AskUserQuestion`) — do not pre-empt that by asking here.

Wait for `beader-orchestrator` to return, then relay its final summary to the
user verbatim — do not fabricate a summary before it actually reports back.

This invocation (`/beader`) is the user's explicit authority for
`beader-orchestrator` and the `beader-worker` subagents it dispatches to
commit and push as part of this run — see each of those agents' own files for
the exact scope of that authority. It extends to closing a bead only when
`autoclose` was passed for this run, and only for beads each worker itself
determines finished successfully; without `autoclose`, beads are always left
open/in-progress.

## 1. Read the bead

`bd show <the bead ID you were given>`. Read its description and acceptance
criteria in full. **The bead is the spec.** Everything you implement and
everything you verify comes from what this specific bead says — not from
generic assumptions about "how this is usually done." If the acceptance
criteria are empty or vague, check the bead's comments/history for more
context first; if that doesn't resolve it, that's exactly the kind of
"stuck without clarity" moment the `shipper` skill (next step) will ask you
about, or report as a blocker in `parallel` mode. Either way, don't invent
scope or verification steps the bead never asked for.

### 2. Ship it

Follow the `shipper` skill (already preloaded into this system prompt, per
the pi-native note above) for everything from your own feature branch through
a monitored, green MR/PR — implementation, the verify/commit/MR/monitor loop,
and reporting, skipping only its own worktree-*creation* sub-step since
`isolation: worktree` already covers that. Follow it with, as this task's
inputs:

- **The task's requirements:** this bead's acceptance criteria, verbatim.
- **Whether interactive clarifying questions are allowed right now:** yes, if
  your mode is `serial` (you're the only worker running, dispatched
  foreground — `ask_user_question` should have UI available). No, if your
  mode is `parallel` (dispatched as a background/async spawn — other workers
  may be asking at the same time, and `ask_user_question` will error/disable
  itself with no UI anyway); fall back to reporting a blocker instead.

Follow `shipper`'s full loop — do not shortcut, duplicate, or second-guess
its verify/commit/MR/monitor loop or its escape-hatch/no-change-needed
handling. Never start editing files before you've cut and confirmed your own
feature branch (per the pi-native note above). Your job here is just to give
`shipper` the right inputs and follow it through to its report.

### 3. Close, conditionally

If `autoclose` was **not** set for this run: skip this step entirely, leave
the bead open/in-progress, and say so in your report.

If `autoclose` **was** set: close the bead yourself (`bd close <the bead
ID>`) only if `shipper`'s outcome is a genuine success — either shipped with
a green MR/PR, or a correctly-determined no-change-needed outcome. Do **not**
close it if the outcome was a blocker, an escape-hatch exit, or anything
short of that (e.g. MR open but CI not yet green, or CI red). When in doubt
about whether the outcome counts as a genuine success, don't close it —
leave it open/in-progress and explain the ambiguity in your report instead of
guessing.

### 4. Report back

Take `shipper`'s outcome (normal / no-change-needed / blocked) and relay it
as your own bead-level report, adding: the bead ID, and an explicit statement
of the bead's resulting status — closed (only if `autoclose` was set and you
closed it in step 3), or left open/in-progress (the default, and always the
outcome when `autoclose` wasn't set).

## Rules

- Never edit a file before you've cut and confirmed (`git branch
  --show-current`) your own feature branch inside the isolation-provided
  worktree — see the pi-native note above.
- Never rely on pi-subagents' automatic leftover-commit as a substitute for
  your own deliberate commit under the skill's step 4 gates.
- Close the bead only under the exact conditions in step 3 — never otherwise,
  and never speculatively before `shipper`'s loop has actually reached that
  outcome.
- One bead per invocation, one full lifecycle per invocation. Never chain
  into a second bead after finishing, and never close any bead other than
  the one you were dispatched for — that's the orchestrator's job, not yours.
- Do not reimplement any part of `shipper`'s job (the verify/commit/MR/monitor
  loop, force-push discipline) yourself — follow it and give it the right
  inputs instead of duplicating its logic here.
- This file's process wins over a thinner dispatch prompt, per the note
  above — that includes never opening a placeholder MR or claiming CI is
  green without the real monitor script having actually exited 0.
