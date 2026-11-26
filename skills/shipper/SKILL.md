---
name: shipper
description: Use for any actual coding task — implementing a feature, fixing a bug, making a real code change (not a quick exploratory edit or a read-only investigation). Ensures the work happens in an isolated git worktree on its own branch, loops on verification until the task's requirements genuinely pass, commits, opens an MR/PR, and monitors it until CI is green with no merge conflicts — never stopping partway and calling it done.
---

> **Cross-harness note:** this file names Claude Code's exact tools (`AskUserQuestion`,
> etc.) for precision. If you're running this under a different harness, substitute
> your own equivalent capability wherever one is named.

> **Shell-state note:** do not assume a `cd` in one command persists into your next
> tool call — some harnesses give every command a fresh shell, so a `cd` that isn't
> re-issued silently gets lost and the following command runs in whatever directory
> the harness defaults to (usually the primary checkout). Once you've entered the
> worktree in step 1, every subsequent shell command that must run there needs its
> own `cd <worktree-path> && ...` prefix in the same invocation — never a bare command
> that relies on an earlier `cd` having stuck. The same applies to file-tool paths
> (read/edit/write): pass the worktree's absolute path, never a bare relative one,
> since a relative path resolves against whatever directory that tool call actually
> starts in.

# Inputs

Whoever invokes this skill (you, working on a task directly, or another skill/agent
handing you a task) supplies, explicitly or by context:

- **The task's requirements** — what "done" means. This might be a formal
  acceptance-criteria list (e.g. from a tracked issue/bead), or it might just be
  what the user asked for in plain language plus the repo's own gates (its test
  suite, linters, type-checker, build). Either way, treat whatever requirements
  you were given as the literal, complete checklist — don't add checks nobody
  asked for, and don't skip ones that were named.
- **Whether interactive clarifying questions are allowed right now** (default:
  yes). Some callers — e.g. an orchestrator running several of these in parallel
  — may tell you not to ask interactively because concurrent questions from
  multiple workers would collide; if so, you fall back to reporting a blocker
  instead of asking. Absent that instruction, asking is the default.

- **An existing branch to continue on** (optional; default: none — cut a fresh
  branch). A caller re-invoking you to address review findings on work you
  already shipped supplies the feature branch, its worktree path if it still
  exists, and the MR/PR that's already open. When this is given you are
  *continuing* that task, not starting a new one: see step 1b.
- **Whether more rounds are expected** (optional; default: no). A caller that
  will review your output and may come back supplies this so you keep the
  worktree in place — see step 7.

If you weren't told what the requirements are and can't infer them from the
conversation, that's a blocker — go re-establish them (ask, per the rule above)
rather than guessing at scope.

### 1. Branch — worktree exists and you have `cd`'d into it *before* any edit

**If you were given an existing branch to continue on, skip to step 1b.**

This is a strict ordering gate, not a suggestion: **zero file edits happen
until you are physically inside the worktree directory.** Do these in this
exact order, in the primary checkout:

**Where the worktree goes:** always `~/.worktrees/<repo-name>/<feature-branch>`.
Never inside the repo — not `worktrees/`, not `.worktrees/`, not under
`.beads/`. A worktree is a full second copy of the codebase, so one placed
inside the repo gets indexed by the IDE, collected twice by `pytest` (duplicate
module basenames break collection), and scanned again by the linter and
type-checker. A dot prefix does not fix this. Never use `/tmp` either: macOS
purges entries not accessed for a few days, taking uncommitted work with them.

1. `git fetch origin` — just fetch, in the primary checkout. **Never
   `checkout`/`pull` the default branch in the primary checkout to do this** —
   that mutates shared state you don't own, and if any earlier run ever left
   stray local commits sitting on that branch (e.g. from a `cd`-persistence
   mistake — see the shell-state note above), checking it out and pulling
   inherits that contamination into every worktree branched from it afterward.
   Branch from the remote ref instead, never from local state.
2. `mkdir -p ~/.worktrees/<repo-name>` then
   `git worktree add ~/.worktrees/<repo-name>/<feature-branch> -b <feature-branch> origin/<default-branch>`
   — creates the worktree *and* the feature branch together, from
   `origin/<default-branch>` specifically (not local `<default-branch>`), all
   without ever changing what the primary checkout has checked out.
3. Confirm you're actually there and on the right branch, in one chained
   command per the shell-state note above:
   `cd ~/.worktrees/<repo-name>/<feature-branch> && git rev-parse --show-toplevel && git branch --show-current`
   — the first line should print the worktree path, not the primary
   checkout's, and the second should print the feature branch.

Only after step 3 confirms both do you proceed to implementing, and every
command/file-tool call after this point must target the worktree path
explicitly (per the shell-state note) rather than assuming you're "still cd'd
in" from here. If you notice partway through implementing that an edit landed
in the primary checkout — or that you created the worktree *after* already
editing files — stop, this is the exact mistake this gate exists to prevent:
discard or stash whatever you changed in the primary checkout, restore it to
a clean state, and redo steps 1–3 properly before touching any file again.
Never commit directly to main/master, and never make the worktree
"retroactively" by creating it and then moving already-made edits into it.

### 1b. Continue on an existing branch

Only when the caller supplied one. You are adding to work already shipped, so
**never cut a new branch and never open a second MR/PR** — the existing one is
the one being updated.

1. If the worktree path still exists, use it. Otherwise recreate it at
   `~/.worktrees/<repo-name>/<feature-branch>` against the *existing* branch —
   `git fetch origin && git worktree add ~/.worktrees/<repo-name>/<feature-branch>
   <feature-branch>`, with **no `-b`**, since the branch already exists. This
   only touches the branch's own ref, never the primary checkout's HEAD. Re-run
   step 1c if you recreated it.
2. Confirm before editing anything, in one chained command per the
   shell-state note above:
   `cd ~/.worktrees/<repo-name>/<feature-branch> && git rev-parse --show-toplevel && git branch --show-current`
   — first line prints the worktree path, second prints the supplied feature
   branch — not the default branch, and not a new name.
3. `cd ~/.worktrees/<repo-name>/<feature-branch> && git pull --ff-only origin <feature-branch>`
   if it has a remote counterpart, so you're amending the real tip rather than
   a stale local copy.

Then proceed to step 2 as normal. Everything downstream is unchanged except:
step 5 is skipped (the MR/PR already exists), and step 6's rule that the branch
stays exactly one commit ahead of its base still applies — fold this round's fix
into that single commit with `git commit --amend` and
`git push --force-with-lease`, then re-run the monitor script on the existing
MR/PR.

### 1c. Make the worktree runnable

A fresh worktree contains only tracked files, so anything gitignored that the
repo's checks depend on — a `.venv`, `node_modules`, a local `.env` — is absent.
Running a test command that assumes it (`.venv/bin/pytest`, and similar) fails
with a confusing missing-interpreter error that looks like a code problem.

Before verifying anything, set the environment up the way the repo documents it
(`uv sync`, `npm ci`, whatever its README or `AGENTS.md` prescribes), and prefer
commands that resolve their own environment (`uv run pytest`) over hardcoded
interpreter paths. If a required gitignored file genuinely can't be recreated,
that's a blocker to report — not something to work around by editing in the
primary checkout.

### 2. Implement

Do the real work the task describes, from inside the worktree confirmed in
step 1. Read the relevant code first; make the change fit what's actually
there.

### 3–6 form one loop — do not stop until every part of it is green

Steps 3 through 6 below are not a one-pass checklist; they are a loop. The
task is not done, and you do not stop working, until **all three** of these
hold true at the same time:

1. Every one of the task's requirements passes when you run its exact
   verification command locally, right now (not "passed once earlier").
2. An MR/PR exists for this branch (or the documented push-only fallback, if
   MR/PR creation is genuinely impossible for this repo/forge) — **unless
   the "no-change-needed" case in step 3 applies**, in which case there must
   be no MR/PR and no branch pushed at all, since there's nothing to
   propose.
3. The forge-monitor script (step 6) exits **0** for that MR/PR — no merge
   conflicts, no failing CI. (Not applicable if step 3 found no change was
   needed — there's no MR/PR for the script to check.)

If any of the three isn't true, the fix belongs in step 2/3 (implement or
correct), not in retrying the same push and hoping. Go back, fix the actual
cause, then re-run steps 3 through 6 in order again.

**Escape hatch:** if the exact same check keeps failing after 3 consecutive
genuine fix attempts (not 3 re-runs of the same unchanged commit — 3 times
you changed something and it still failed the same way), stop looping.
Report precisely which check still fails, what you tried, and why you
believe it's stuck, rather than continuing indefinitely or fabricating a
passing result. If interactive questions are allowed (per Inputs above), ask
the user directly with `AskUserQuestion` before giving up — state your best
guess at the cause and what you'd try next, and let them decide whether to
keep going. If questions aren't allowed right now, report this as a blocker
for whoever invoked you to relay. This is the only condition under which you
stop before all three points above are true.

### 3. Verify against every requirement — nothing else

Treat the task's requirements as the literal, complete checklist. For each
one, run the exact command or check that proves it and confirm it passes. Do
not substitute your own idea of "what verification should include" — don't
add checks nobody asked for, and don't skip ones that were named.

Do not stop at "looks right" — actually execute each check. If one can't be
verified (e.g. it requires infra you don't have), say so explicitly rather
than marking it done. Only once every requirement has passed, move on.

**No-change-needed case:** once every requirement passes, check `git status`
/ `git diff` against the base branch. If it's genuinely empty — the
requirements were already satisfied before you touched anything, or your
investigation concluded no code change is required to satisfy them — **do
not proceed to step 4 or step 5.** Do not commit, do not push, and do not
open an MR/PR for zero files touched. Instead, go straight to reporting
(final section) that this task needed no code change, with the evidence
(which verification commands you ran and their passing output). This
satisfies the loop's exit condition without an MR/PR. If the diff is
non-empty, continue to step 4 as normal.

### 4. Commit

Before running `git commit` or any `git push`, run this two-gate check and
state the answer to each gate out loud (in your response), not just silently
to yourself. Do not run the command until both gates are answered.

- **Gate 1 — diff review.** Run `git diff` / `git status` against what's
  staged. State explicitly: what changed, and confirm none of the following
  are true — extra files pulled in by a broad `git add`, debug prints/
  commented-out code left behind, changes unrelated to this task's scope. If
  any of those are true, fix the staging before continuing.
- **Gate 2 — requirements review.** Re-read the task's requirements from
  step 3 and state, requirement by requirement, why this diff satisfies it —
  not "looks right" or "probably." If you can't state a concrete reason for
  one of them, you're not done; go back and close that gap first.

Only commit/push once both gates have a stated, specific answer.

Commit with the repo's real git identity — never override author/committer.
Do not pass `--author`, `-c user.name=`, `-c user.email=`, or any
Co-Authored-By line unless the user explicitly asks for one in this session;
git's own `user.name`/`user.email` resolution (local repo config wins over
global) is authoritative and must not be second-guessed.

### 5. Detect the forge and open an MR

**Skip this step entirely if you came through step 1b** — the MR/PR already
exists and your amended force-push has already updated it. Go straight to
step 6 and monitor that same MR/PR. Never open a second one for a branch that
already has one.

You only reach this step if step 3's no-change-needed check found a
non-empty diff. If you somehow arrive here with nothing committed or nothing
different from the base branch, that's a bug in how you got here — go back
to step 3, do not open an MR/PR for an empty diff.

Determine which forge hosts this repo from `git remote get-url origin` —
don't guess or ask, the URL tells you: a `gitlab.` host (or a GitLab-style
group/subgroup path) means GitLab; a `github.com` host means GitHub. Every
step from here on branches on this decision.

- **GitLab:** `glab mr create --fill` (or with an explicit title/description).
- **GitHub:** `gh pr create --fill` (or with an explicit title/body).

If MR/PR creation isn't possible (no forge CLI auth, no supported remote,
creation fails for any reason), fall back to just pushing the feature
branch. Report which of the two outcomes actually happened — don't silently
swallow a creation failure and claim success.

### 6. Monitor the MR/PR for conflicts and pipeline failures

Once it exists, watch it with the bundled script matching the forge detected
in step 5 — never guess at raw `glab`/`gh` invocations by hand. These scripts
live in the shared `skills/lib/` directory (not inside `skills/shipper/`) so
other skills — e.g. `dependabot` — can call the same ones; installed under
`~/.claude/skills/lib/` or `~/.agents/skills/lib/` depending on harness (see
`scripts/install-skills.sh`):

```bash
# GitLab — argument is the MR IID
~/.claude/skills/lib/monitor-mr-gitlab.sh <mr-iid>

# GitHub — argument is the PR number
~/.claude/skills/lib/monitor-mr-github.sh <pr-number>
```

Both scripts share the same contract:

- They first check for merge conflicts against the target/base branch
  (rechecked every poll cycle too, since that branch can move while a long
  pipeline/check-suite runs) — **exit 3** means it's unmergeable. Resolve
  that before caring about pipeline/check status at all:

  ```bash
  git fetch origin && git rebase origin/<default-branch>
  # resolve conflicts, then:
  git push --force-with-lease
  ```

- They then poll until CI finishes: **exit 0** means it passed; **exit 1**
  means it failed and the script has already printed, for each failing
  job/run, the last ~150 lines of the relevant log plus that log's file path
  (the GitLab script isolates the job's own script output from setup/teardown
  noise first; the GitHub script uses `gh run view --log-failed`, which
  GitHub itself limits to failed steps).

- If that tail doesn't contain enough context, pull more lines from the same
  saved log instead of re-running the job or the whole script (same
  sub-command on both scripts):

  ```bash
  ~/.claude/skills/lib/monitor-mr-<gitlab|github>.sh more <log-file> [extra-lines]
  ```

  This prints the block of lines immediately above what was already shown
  (default 150 more), without repeating anything already printed. Repeat
  with a larger `extra-lines` if still not enough.

On failure, read the printed logs and fix the actual cause in the worktree.
Then, before pushing anything:

1. Re-run every requirement and the failed job/run(s) exercise, locally, and
   confirm they pass — don't push speculatively and let CI re-tell you.
2. Fold the fix into the branch's existing history as **one single commit**,
   not an additional "fix" commit on top: `git commit --amend` if the fix is
   the only change since the last commit, or `git reset --soft <branch-point>`
   + one fresh commit / `git rebase -i` + squash if there were several. The
   branch must always be exactly one commit ahead of its base.
3. Push that rewritten branch with `git push --force-with-lease` (never plain
   `--force`) and re-run the same monitor script.

Repeat this whole cycle — fix, re-verify locally (step 3), commit (step 4),
re-push, re-monitor — until the script exits 0 **and** every requirement
still passes locally. That combination, per the "3–6 form one loop" section
above, is what actually ends the loop; a green monitor run alone isn't enough
if a local requirement has regressed since. Don't just retry the
pipeline/checks without a code change unless the log shows a transient
infra failure (network blip, runner/runner-image timeout) rather than a real
check failing — and remember the 3-genuine-attempts escape hatch above if
the same failure won't resolve.

### 7. Clean up the worktree

**If the caller said more rounds are expected, keep the worktree** and report
its path along with the branch and MR/PR — a reviewer may send you back with
findings, and recreating the worktree each round is wasted work. Skip the rest
of this step.

Otherwise, once the loop above has actually ended (green MR/PR, confirmed
no-change-needed, or the escape hatch), decide whether to remove the
worktree created in step 1 — this decision hinges only on whether an MR/PR
exists for this task, not on which of those three endings you hit:

- **An MR/PR was opened** (the normal case, including an escape-hatch exit
  that happened after an MR/PR already existed): remove the worktree. `cd`
  back to the primary checkout first, then `git worktree remove <path>` (add
  `--force` only if it reports uncommitted changes you've already confirmed
  are safe to discard — everything meaningful should already be committed
  and pushed by this point). Leave the remote branch and MR/PR themselves
  alone; only the local worktree is being cleaned up.
- **No MR/PR exists** (the no-change-needed case, or a blocked/escape-hatch
  exit that happened before ever reaching step 5): do **not** remove the
  worktree. Leave it in place — for no-change-needed there's nothing to
  clean up anyway (no commits happened), and for a pre-MR block it may still
  hold the state needed to diagnose what went wrong.

If removal fails for a reason other than uncommitted changes (e.g. the
worktree path is already gone), don't treat that as a task failure — note it
in your report and move on.

## Report back

End with a concrete, structured report for whoever invoked you, including
whether the worktree was removed or left in place per step 7:
- **Normal case:** branch name, MR/PR link (or "pushed, no MR" and why),
  final CI status.
- **No-change-needed case:** which verification commands you ran and
  confirmed passing, explicit confirmation no files were touched and no
  branch/MR/PR was created.
- **Blocked case:** say so plainly and lead with that, not with a
  success-shaped summary — what's unclear or what check won't resolve, what
  you tried, and (if interactive questions weren't allowed) the specific
  question you would have asked.

Never report success while the monitor script still exits 3 (merge
conflicts) — an unmergeable MR/PR is not a finished one, regardless of
pipeline/check color. Never open an MR/PR just to have something to report.
This skill never closes any tracked issue/task on your behalf — if the work
you're doing is tied to one (e.g. a bead, a ticket), that's the calling
context's responsibility to close explicitly, never implied by this skill
finishing.

## Rules

- The worktree must exist and be `cd`'d into *before* any file is edited —
  never create it after the fact to house edits already made in the primary
  checkout.
- Never `checkout`/`pull` the default branch in the primary checkout to cut a
  worktree — branch straight off `origin/<default-branch>` so the primary
  checkout's HEAD never moves and stray local commits can never leak into a
  "fresh" worktree.
- Never assume a `cd` from an earlier command has stuck — chain `cd
  <worktree-path> && ...` into the same command every time, and use absolute
  worktree paths for file-tool calls. A command or file edit that silently
  lands in the primary checkout instead of the worktree is the single most
  common way this skill's isolation guarantee breaks in practice.
- Worktrees live at `~/.worktrees/<repo-name>/<branch>`. Never inside the repo
  (it pollutes IDE search, test collection and linting), never in `/tmp` (it
  gets purged).
- Given an existing branch to continue on (step 1b), never cut a new branch and
  never open a second MR/PR — you are updating the one that already exists.
- Never open an MR/PR (or push a branch) for a task where nothing actually
  needed to change — if the requirements pass with an empty `git diff`,
  that's the no-change-needed case: report it and stop, don't manufacture a
  diff or open an empty MR/PR just to have something to point at.
- Never report a task's MR/PR as done/ready while its monitor script still
  exits 3 (merge conflicts).
- This is a loop, not a checklist: keep fixing and re-verifying until local
  requirements pass, an MR/PR exists, and its monitor script exits 0, all at
  once. Absent the no-change-needed case, the only sanctioned early exit is
  the 3-genuine-attempts escape hatch — reported as a blocker (or asked about
  interactively, if allowed), never as quiet success.
- Never fabricate or relax requirements to make them easier to satisfy.
- Remove the worktree (step 7) if and only if an MR/PR exists for this task
  by the time the loop ends. No MR/PR (no-change-needed, or a block that
  happened before one was opened) means the worktree stays — never delete it
  in that case.
- Never push to main/master directly. Force-push only ever targets this
  task's own feature branch (`--force-with-lease`, never plain `--force`,
  never on main/master) — used specifically to keep pipeline-fix commits
  squashed into one, per step 6.
