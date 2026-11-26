#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
from datetime import datetime

REQUIRED = ["codebase-design", "grill-me", "improve-codebase-architecture", "naming-analyzer", "code-review"]
REVIEW = "code-review"

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
EDIT_MCP_RE = re.compile(r"^mcp__.*__(apply_patch|create_new_file|replace_\w+|edit_\w+|write_\w+)$")
COMMIT_RE = re.compile(
    r"(?:^|[;&|\n(]\s*)(?:rtk\s+(?:proxy\s+)?)?git(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b"
)
SLASH_RE = re.compile(r"<command-name>/?([\w:.-]+)</command-name>")


def short(name):
    return name.split(":")[-1]


def git(cwd, *args):
    try:
        out = subprocess.run(["git", "-C", cwd or ".", *args], capture_output=True, text=True, timeout=5)
        return out.stdout if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def last_commit_time(cwd):
    out = git(cwd, "log", "-1", "--format=%ct")
    return int(out.strip()) if out and out.strip().isdigit() else 0


def newest_uncommitted_change(cwd):
    root = git(cwd, "rev-parse", "--show-toplevel")
    status = git(cwd, "status", "--porcelain", "-z", "--untracked-files=all")
    if not root or status is None:
        return 0
    newest = 0
    for record in status.split("\0"):
        path = os.path.join(root.strip(), record[3:])
        if len(record) > 3 and os.path.isfile(path):
            newest = max(newest, os.path.getmtime(path))
    return newest


def entry_time(e):
    try:
        return datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError, AttributeError):
        return 0


def read_events(path, since):
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
        at = entry_time(e)
        if e.get("isSidechain") or at <= since:
            continue
        content = (e.get("message") or {}).get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content or ""}]
        for b in blocks:
            if not isinstance(b, dict):
                continue
            if e.get("type") == "user" and b.get("type") == "text":
                for m in SLASH_RE.findall(b.get("text") or ""):
                    events.append((at, "skill", short(m)))
            elif e.get("type") == "assistant" and b.get("type") == "tool_use":
                name, inp = b.get("name", ""), b.get("input") or {}
                if name in EDIT_TOOLS or EDIT_MCP_RE.match(name):
                    events.append((at, "edit", None))
                elif name == "Skill":
                    events.append((at, "skill", short(inp.get("skill", ""))))
    return events


def missing_skills(events, last_file_change=0):
    last_edit = max([t for t, k, _ in events if k == "edit"] + [last_file_change])
    if not last_edit:
        return []
    skill_runs = [(t, n) for t, k, n in events if k == "skill"]
    ran = {n for _, n in skill_runs}
    missing = [s for s in REQUIRED if s not in ran]
    if REVIEW in ran and not any(n == REVIEW and t >= last_edit for t, n in skill_runs):
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
    cwd = data.get("cwd")
    since = last_commit_time(cwd)
    events = read_events(data.get("transcript_path", ""), since)
    return missing_skills(events, newest_uncommitted_change(cwd))


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
            return
        missing = check(data)
        if missing:
            print(json.dumps({"decision": "block", "reason": message(missing)}))


if __name__ == "__main__":
    main()
