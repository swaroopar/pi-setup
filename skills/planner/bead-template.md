# Bead template

Fill this in for every bead. The result goes into `bd create --description` in full.

The implementing agent is not smart enough to fill a gap — it invents something wrong
rather than stopping. So specify **what the code looks like after the change**, never an
outcome to aim for.

---

## Template

```
<imperative title>

Goal: one sentence.

Files (N): exact/path/one.py (edit), exact/path/two.py (new)

Technical detail:
  <see "Technical detail" below — the exact shape of the change>

Steps:
  1. One action. Name the symbol and the full signature.
  2. One action.

Do not:
  - The obvious wrong turns for this bead.

Editing rules (mandatory):
  <copy the block below verbatim>

Tests (mandatory):
  <copy the block below verbatim, then list this bead's cases>

Verify:
  <exact commands; this bead's tests by node ID, then repo gates. Exit 0 == pass>

Green on its own: why the repo still builds and CI passes with only this bead merged.

Plan: ~/.claude/plans/<name>.md → <story heading>
```

---

## Technical detail — what to spell out

Whichever applies to this bead:

- **Table / schema** — table name; every column added or changed with type, nullability,
  default; indexes, constraints, keys; the migration file and its up/down statements.
- **Graph / Cypher** — node labels, relationship types, every property with its type, and
  the full Cypher statement, not a description of it.
- **Code change** — file, enclosing class or function, the exact current signature and the
  exact new one, parameter names and types, keyword-only `*` where required, return type,
  imports to add or remove, and where in the file the code goes (after which symbol).
- **Class / dataclass / enum** — every field with type and default, every enum member with
  its value, the decorators (`@dataclass(kw_only=True)` where required).
- **API / CLI** — exact route or flag string, method, request and response shapes, status
  codes, exact error message text.
- **Config** — exact key, type, default, the file it lives in, how it is read.

Show a before/after snippet wherever it beats prose. If you can't write detail at this
level, you don't understand the change well enough to hand it to a small agent — go read
the code.

---

## Editing rules — copy verbatim into every bead

No exceptions, not even for a single-file bead.

```
Editing rules (mandatory):
- Edit every file individually, by hand, reading it first.
- Do NOT write or run any script, one-liner, or command that edits code in bulk.
  No sed, awk, perl -pi, python -c rewrites, ex/ed, IDE structural search-and-replace,
  codemods, or global find-and-replace across files.
- Do NOT use editor "replace all" across a file or a project.
- Apply each change deliberately at the exact location named in this bead, and re-read
  the surrounding code to confirm the change fits it.
- If the change feels repetitive enough to want a script, that is a signal the bead is
  too big — stop and report it rather than scripting it.
```

A bulk rewrite silently hits matches nobody reviewed — the exact blast radius small beads
exist to prevent. If hand-editing is impractical, the split is wrong.

---

## Tests — you specify, the implementer writes

You decide what is tested and what it asserts. Never leave that to the implementing agent:
a small model writes a test asserting whatever its implementation already does, which
proves nothing.

Specify in **pseudo-test form** — precise about behaviour and values, silent about
framework mechanics:

```
test_ingest_rejects_empty_page_id   [tests/ingest/test_ingest.py]
  Given:  page_id = "", client = an in-memory fake with no pages
  When:   ingest_page(page_id="", client=fake)
  Then:   raises ValueError with message exactly "page_id must not be empty"
          and no Cypher statement is executed
```

- **Test name** — the exact function name the implementer must use.
- **File** — the exact path, following the repo's existing test layout.
- **Given** — starting state and input values, written literally.
- **When** — the exact call with its full signature.
- **Then** — the literal expected value, exact exception type and message string, exact
  counts, exact log line. Never "an error is raised" or "the result is correct".

Cover the happy path, every failure case the acceptance criteria name, and the boundaries
that matter (empty, zero, one, many, null).

**Awkward shapes:** when an expected value is hard to state in prose — a nested dict, a
Cypher row, a JSON body — show it as a literal block. The *expected value only*, never a
whole test with imports and fixtures; a half-written test invites the implementer to "fix"
it.

**Point at a test file that exists.** Search first (`rg -l "def test_" tests/`, Glob on the
module name) and read it, then name that real path: "match the style of
`tests/ingest/test_existing.py` — same fixtures, same parametrize style, same mocking."
A small model told to match a nonexistent file improvises its own conventions. If the area
has no tests, say so and name the closest real analogue.

Copy this block verbatim into every bead, followed by that bead's cases:

```
Tests (mandatory):
1. Write a test for every case listed below, in <exact test file path>, using the
   test function names given. Match the style of <existing test file>.
2. Assert exactly what the "Then" line says — the same values, the same exception
   type, the same message string. Do not weaken, broaden, or drop an assertion.
3. Run them and watch them fail for the right reason before implementing.
4. Implement the change until they pass.
5. Do not change an expected value to match what your code produces. If a case looks
   wrong or impossible, stop and report it — do not edit it to go green.
6. Do not add tests beyond these unless the change genuinely needs them.
```

If a bead's cases no longer fit a small context, the bead is too big — split it, and split
its cases with it.

---

---

## Before creating the bead

Check the description actually contains: the technical detail, the verbatim editing-rules
block, the verbatim tests block plus this bead's cases, the verify commands, and the plan
link. Missing any of them means the bead is not ready.

Say nothing about branching, worktrees, committing, MRs, CI or closing the bead —
`shipper` and `/beader` own all of that, and repeating it here only creates a second
source of truth that will drift.
