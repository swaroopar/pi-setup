#!/usr/bin/env python3
"""Claude Code hook: every change must go through the required skills.

Wired to two events (see .claude/settings.json):
  - PreToolUse (Bash): blocks `git commit` until the skills have run.
  - Stop: stops Claude from ending its turn with unreviewed changes.

Scope: only what happened after the latest git commit (HEAD's commit time)
counts. Skill runs before that are ignored. Using git, not the session log,
means commits made anywhere (agent, `!` prompt, another terminal) reset it.

Rules (when files were edited since that commit):
  1. Every skill in REQUIRED must have run since that commit.
  2. code-review must have run after the last edit.

A skill counts if Claude called the Skill tool, or the user typed /<skill>.
"""
import json
import re
import subprocess
import sys
from datetime import datetime

REQUIRED = ["codebase-design", "grill-me", "improve-codebase-architecture", "code-review"]
REVIEW = "code-review"

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
EDIT_MCP_RE = re.compile(r"^mcp__.*__(apply_patch|create_new_file|replace_\w+|edit_\w+|write_\w+)$")
# `git` must be the command itself (start of line or after ; & | && ||), not text inside a string.
COMMIT_RE = re.compile(r"(?:^|[;&|\n(]\s*)git(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b")
SLASH_RE = re.compile(r"<command-name>/?([\w:.-]+)</command-name>")


def short(name):
    return name.split(":")[-1]


def last_commit_time(cwd):
    """Unix time of HEAD's commit, or 0 when not in a git repo / no commits."""
    try:
        out = subprocess.run(["git", "-C", cwd or ".", "log", "-1", "--format=%ct"],
                             capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip() or 0)
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def entry_time(e):
    try:
        return datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError, AttributeError):
        return 0


def read_events(path, since):
    """Ordered events after `since`: ("edit", None) | ("skill", name)."""
    events = []
    try:
        lines = open(path, encoding="utf-8").read().splitlines()
    except OSError:
        return events
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("isSidechain") or entry_time(e) <= since:
            continue
        content = (e.get("message") or {}).get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content or ""}]
        for b in blocks:
            if not isinstance(b, dict):
                continue
            if e.get("type") == "user" and b.get("type") == "text":
                for m in SLASH_RE.findall(b.get("text") or ""):
                    events.append(("skill", short(m)))
            elif e.get("type") == "assistant" and b.get("type") == "tool_use":
                name, inp = b.get("name", ""), b.get("input") or {}
                if name in EDIT_TOOLS or EDIT_MCP_RE.match(name):
                    events.append(("edit", None))
                elif name == "Skill":
                    events.append(("skill", short(inp.get("skill", ""))))
    return events


def missing_skills(events):
    edits = [i for i, (k, _) in enumerate(events) if k == "edit"]
    if not edits:
        return []
    ran = {n for k, n in events if k == "skill"}
    missing = [s for s in REQUIRED if s not in ran]
    if REVIEW in ran and not any(k == "skill" and n == REVIEW for k, n in events[edits[-1] + 1:]):
        missing.append(f"{REVIEW} (again: files changed after the last review)")
    return missing


def message(missing):
    return (
        "Changes are not done. Run these skills first, in this order: "
        + ", ".join(missing)
        + ". Required order: " + " -> ".join(REQUIRED) + ". "
        "If a skill can't be invoked by you (disable-model-invocation), ask the user to run /<skill>."
    )


def check(data):
    since = last_commit_time(data.get("cwd"))
    return missing_skills(read_events(data.get("transcript_path", ""), since))


def main():
    data = json.load(sys.stdin)
    event = data.get("hook_event_name")

    if event == "PreToolUse":
        if not COMMIT_RE.search((data.get("tool_input") or {}).get("command", "")):
            return
        missing = check(data)
        if missing:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": message(missing),
            }}))
        return

    if event == "Stop":
        if data.get("stop_hook_active"):
            return  # already nudged once; don't loop
        missing = check(data)
        if missing:
            print(json.dumps({"decision": "block", "reason": message(missing)}))


if __name__ == "__main__":
    main()
