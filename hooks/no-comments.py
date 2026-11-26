#!/usr/bin/env python3
"""Claude Code hook (PreToolUse on Edit|Write|MultiEdit): block new code comments.

Only comments the edit ADDS are blocked; existing ones stay (ratchet).
Tool directives (eslint-disable, noqa, @ts-expect-error, ...) are allowed.
Mirror of ../extensions/no-comments.ts (pi). Keep both in sync.
"""
import json
import os
import re
import sys
from collections import Counter

HASH = {"py", "pyi", "sh", "bash", "zsh", "fish", "rb", "yaml", "yml", "toml", "r", "pl", "ps1", "tf", "nix", "mk"}
SLASH = {"js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "java", "kt", "kts", "go", "rs", "c", "h", "cc",
         "cpp", "hpp", "cs", "swift", "scala", "dart", "php", "groovy", "proto", "css", "scss", "less"}
DASH = {"sql", "lua", "hs"}
HASH_NAMES = {"makefile", "dockerfile", "justfile", "gemfile", "rakefile"}

ALLOWED = re.compile(
    r"^#!|eslint-|@ts-|prettier-ignore|biome-ignore|oxlint-|noqa|type:\s*ignore|pyright:|mypy:|pylint:|"
    r"pragma|istanbul ignore|[cv]8 ignore|nolint|//go:|\+build|#?\s*(end)?region\b|shellcheck|spdx-license|"
    r"@license|fmt:\s*(off|on|skip)|isort:|-\*-.*-\*-|/// <reference|@jsx|@vitest-environment|"
    r"webpackChunkName|nosec|nosonar|swiftlint|ktlint|rubocop:|frozen_string_literal|coding[:=]",
    re.I,
)


def style(path):
    name = os.path.basename(path).lower()
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    if ext in SLASH:
        return "slash"
    if ext in HASH or name in HASH_NAMES:
        return "hash"
    if ext in DASH:
        return "dash"
    return None


def outside_quotes(code):
    return all(code.count(q) % 2 == 0 for q in ("'", '"', "`"))


def comment_of(line, kind):
    s = line.strip()
    if kind == "slash":
        if s.startswith(("//", "/*", "*")):
            return s
        m = re.search(r"\s(//|/\*)", line)
    elif kind == "hash":
        if s.startswith("#"):
            return s
        m = re.search(r"\s#\s", line)
    else:
        if s.startswith("--"):
            return s
        m = re.search(r"\s--\s", line)
    if m and outside_quotes(line[: m.start()]):
        return line[m.start():].strip()
    return None


def comments(text, kind):
    found = (comment_of(l, kind) for l in (text or "").splitlines())
    return Counter(c for c in found if c and c not in {"*", "*/", "/*", "/**"} and not ALLOWED.search(c))


def added_comments(path, old, new):
    kind = style(path)
    if not kind:
        return []
    return list((comments(new, kind) - comments(old, kind)).elements())


def read(path):
    try:
        return open(path, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError):
        return ""


def main():
    data = json.load(sys.stdin)
    tool, inp = data.get("tool_name"), data.get("tool_input") or {}
    path = inp.get("file_path", "")
    if tool == "Edit":
        added = added_comments(path, inp.get("old_string"), inp.get("new_string"))
    elif tool == "MultiEdit":
        edits = inp.get("edits") or []
        added = added_comments(path, "\n".join(e.get("old_string", "") for e in edits),
                               "\n".join(e.get("new_string", "") for e in edits))
    elif tool == "Write":
        added = added_comments(path, read(path), inp.get("content"))
    else:
        return
    if added:
        shown = "\n".join(f"  {c[:100]}" for c in added[:5])
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                f"No new code comments ({len(added)} added in {os.path.basename(path)}):\n{shown}\n"
                "Remove them and retry. Make the code say it instead (names, types, small functions). "
                "A non-obvious decision goes in an ADR under docs/adr/. "
                "Tool directives (eslint-disable, noqa, @ts-expect-error) are allowed."
            ),
        }}))


if __name__ == "__main__":
    main()
