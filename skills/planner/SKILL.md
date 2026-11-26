---
name: planner
description: Turn a raw requirement into a written plan and a set of beads small enough for a small model to implement, each specifying exactly what to build and how it is verified. Only ever runs when explicitly invoked as /planner.
disable-model-invocation: true
---

Turn one requirement into a plan, then into beads.

**Your entire job is the contents of each bead: the implementation detail, and how that
implementation is verified.** Everything about *handling* beads — claiming, branching,
implementing, committing, MRs, CI, closing — belongs to `/beader` and `shipper`. Do not
specify any of it. A bead you write is consumed by `shipper` as its requirements list, so
what you put in it is exactly what gets built and checked.

`/planner` plans only. It never implements. It authorises `bd create` and `bd dep add` —
no commits, no pushes, no `bd dolt push`.

## 1. Orient

- `bd prime` — this project's live bd context; don't trust memorised flags.
- Read `AGENTS.md` / `CLAUDE.md`. Its conventions constrain the plan, and the beads must
  quote the ones that apply to them.
- Explore the code the requirement touches. Any question the codebase can answer is not a
  question for the user.
- Find the repo's tests — where they live, naming, framework, fixtures. Beads must point
  at real test files by path, so locate them now.

## 2. Grill

Run a `grilling` session (`~/.claude/skills/SKILL.md`): interview the user relentlessly,
walking down each branch of the design tree. **One question at a time**, each with your
recommended answer. Explore the codebase instead of asking whenever that's possible.

Do not move on until the user confirms shared understanding.

## 3. Ask: is it a good idea?

Argue the case **against** the requirement, honestly: what it costs to maintain, what it
risks breaking, the simplest alternative that captures most of the value, and what
actually goes wrong if nothing is done.

Then ask with AskUserQuestion whether to proceed. This blocks — do not write the plan
first. "No" ends the run. "Yes" — record the argument and the verdict in the plan.

## 4. Choose the group name

One kebab-case name, 2–5 words. It becomes the `[<name>]` prefix on every bead title,
which is how `/beader` selects a plan's beads as a group — so every bead gets it.

It must say exactly what is being implemented — `cypher-batch-ingest`, not `refactor`,
`phase-2`, `fixes`, a date or a ticket number. It must not already be in use, or two
unrelated plans merge into one group:

```bash
bd search "<name>" --status all     # must return nothing
```

On a hit, narrow the name to what this plan actually does — never `-v2`, `-new` or a
trailing number.

## 5. Write the plan

Write to `~/.plans/<name>.md`. Never into the target repo. Sections:

- **Context** — the problem, what prompted it, the intended outcome.
- **Is it a good idea?** — the step-3 argument and the user's verdict.
- **Constraints** — repo conventions the implementation must obey, quoted.
- **Architecture** — files and modules touched; existing functions and utilities to
  reuse, each with its path. Prefer reuse over new code and say so.
- **Work** — `### <Story title>` headings grouping related beads, each bead written out
  underneath. A story is only a heading; all detail lives in its beads.
- **Verification** — every bead's verify commands concatenated, repo gates last, for
  checking the finished plan in one paste.
- **Out of scope**.

## 6. Split the work into the smallest possible beads

A bead is implemented by a small, less intelligent model with a small context window.
Bead size is the biggest lever on whether that succeeds. Bias hard toward too-small:
three trivially correct beads beat one plausible-looking one.

1. **Fewest files possible.** One is the target, two or three normal, **ten a hard
   ceiling, not a budget** — at five, look again for a split. State the count.
2. **One coherent change.** If the title needs "and", split it. If the steps switch
   between unrelated concerns, split it.
3. **Fits a small context.** Too big if implementing it means reading files the bead does
   not name.
4. **Individually mergeable with CI green.** Each bead becomes its own MR. So on its own
   it must leave the repo building and green, ship its tests with its code, and leave no
   half-finished state — no call to a function a later bead adds, no test asserting
   behaviour that arrives later. New code is wired up in the same bead, or gated behind a
   default-off flag a later bead flips.

If a split would break CI standalone, it's the wrong split. Re-cut it — typically:
introduce the new thing alongside the old, migrate callers, delete the old. Three beads,
each green.

**Every bead must deliver a piece of the requirement the user asked for.** Never a bead
whose only output is scaffolding — a verify script, a runner, a helper, a checklist file,
a README about the plan. If the user didn't ask for the artifact, it isn't a bead.

Write each bead by filling in **`bead-template.md`** from this skill directory. It defines
every required field, including the two blocks that go into each bead verbatim. Read it
before writing the first bead.

## 7. Verification: commands, not artifacts

Every bead ends with the exact commands that prove it — its own tests by node ID, then
the repo's gates:

```bash
uv run pytest tests/ingest/test_ingest.py::test_rejects_empty_page_id -q
uv run pytest && uv run ruff check . && uv run mypy src
```

`shipper` runs these as the bead's literal requirements checklist, so a criterion with no
command behind it will not be checked at all. Name tests by node ID: that catches a test
silently renamed or never written, which a bare `pytest` run reports as green.

Never verify behaviour by grepping for a literal line of source — it proves a line exists,
breaks on reformatting, and passes on code that doesn't work. Assert through the tests.

## 8. Create the beads

Only after the user approves the plan. One `bd create` per bead:

```bash
bd create --title="[<name>] <bead title>" \
          --labels="<name>" \
          --description="<the filled-in bead-template.md, in full>" \
          --acceptance="<each criterion with the exact test or command proving it>" \
          --type=feature|task|bug --priority=2
```

The description must stand alone — the bead is the spec, and nothing in the plan file is
visible to whoever implements it. Before each create, confirm the description still holds
the technical detail, the editing-rules block, the test cases and the verify commands.

Run creates in parallel with subagents when there are many, passing the group name to each
explicitly.

**Then wire dependencies:** `bd dep add <issue> <depends-on>` — the bead that comes second
is the first argument. Every bead is either genuinely startable now or blocked by the bead
that unblocks it; if it needs a symbol another bead introduces, that's an edge, not an
assumption. Don't invent edges either — beads over disjoint files with no shared symbol
are parallel work.

**Then check the graph:**

```bash
bd ready      # only beads with no unmet dependency
bd blocked    # each blocked by the right bead
bd dep cycles # empty
```

`ready ∪ blocked` must equal every bead you created. Fix the graph before reporting.

Finish by reporting the bead IDs, the edges, and what's ready versus blocked. Then
**stop** — do not implement, and do not invoke `/beader`.
