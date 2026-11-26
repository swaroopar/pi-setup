#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
from datetime import datetime

REQUIRED = ["codebase-design", "grill-me", "improve-codebase-architecture", "naming-analyzer", "code-review"]
REVIEW = "code-review"
GRILL = "grill-me"

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
EDIT_MCP_RE = re.compile(r"^mcp__.*__(apply_patch|create_new_file|replace_\w+|edit_\w+|write_\w+)$")
CMD_START = r"(?:^|[;&|\n(]\s*)(?:rtk\s+(?:proxy\s+)?)?(?:sudo\s+)?"
COMMIT_RE = re.compile(CMD_START + r"git(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b")
WRITE_CMD_RE = re.compile(
    CMD_START
    + r"(?:sed\s+(?:[^\s;&|]+\s+)*?-\w*i|perl\s+-\w*i|tee\b|mv\b|cp\b|rm\b|touch\b|mkdir\b|ln\b|truncate\b|patch\b|"
    r"git\s+(?:apply|checkout|restore|reset|stash|mv|rm|am|cherry-pick|merge|rebase|pull)\b)"
)
HEREDOC_RE = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n.*?\n\1(?=\n|$)", re.S)
QUOTED_RE = re.compile(r"'[^']*'|\"[^\"]*\"")
REDIRECT_RE = re.compile(r"(?<![0-9&>])>>?\s*(?!&|/dev/)([^\s;&|)]+)")
SCRATCH_PREFIXES = ("/tmp", "/private/tmp", "/var/folders")
SLASH_RE = re.compile(r"<command-name>/?([\w:.-]+)</command-name>")

GRILL_FIRST = (
    "No changes before grilling. Run the grill-me skill first and wait for the user's answers "
    "before changing any file in this repository."
)


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


def workspace_root(cwd):
    root = git(cwd, "rev-parse", "--show-toplevel")
    return (root or "").strip() or cwd or "."


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


def inside_workspace(path, cwd):
    root = os.path.realpath(workspace_root(cwd))
    target = os.path.realpath(os.path.join(cwd or ".", path))
    return target == root or target.startswith(root + os.sep)


def bash_writes(command):
    bare = QUOTED_RE.sub("''", HEREDOC_RE.sub("", command))
    if WRITE_CMD_RE.search(bare):
        return True
    return any(not t.startswith(SCRATCH_PREFIXES) for t in REDIRECT_RE.findall(bare))


def changes_workspace(tool, inp, cwd):
    if tool == "Bash":
        return bash_writes(inp.get("command", ""))
    path = inp.get("file_path") or inp.get("notebook_path") or ""
    return tool in EDIT_TOOLS and bool(path) and inside_workspace(path, cwd)


def entry_time(e):
    try:
        return datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError, AttributeError):
        return 0


def is_prompt(e, blocks):
    if e.get("type") != "user" or e.get("isMeta"):
        return False
    return not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks)


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
        if is_prompt(e, blocks):
            events.append((at, "prompt", None))
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


def grill_answered(events):
    grills = [i for i, (_, k, n) in enumerate(events) if k == "skill" and n == GRILL]
    return bool(grills) and any(k == "prompt" for _, k, _ in events[grills[0] + 1:])


def skill_ran_this_turn(events):
    prompts = [i for i, (_, k, _) in enumerate(events) if k == "prompt"]
    start = prompts[-1] + 1 if prompts else 0
    return any(k == "skill" for _, k, _ in events[start:])


def message(missing):
    return (
        "Changes are not done. Run these skills first, in this order: "
        + ", ".join(missing)
        + ". Required order: " + " -> ".join(REQUIRED) + ". "
        "If a skill can't be invoked by you (disable-model-invocation), ask the user to run /<skill>."
    )


def session_events(data):
    return read_events(data.get("transcript_path", ""), last_commit_time(data.get("cwd")))


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def main():
    data = json.load(sys.stdin)
    event = data.get("hook_event_name")
    cwd = data.get("cwd")

    if event == "PreToolUse":
        tool, inp = data.get("tool_name"), data.get("tool_input") or {}
        if tool == "Bash" and COMMIT_RE.search(inp.get("command", "")):
            missing = missing_skills(session_events(data), newest_uncommitted_change(cwd))
            if missing:
                deny(message(missing))
        elif changes_workspace(tool, inp, cwd) and not grill_answered(session_events(data)):
            deny(GRILL_FIRST)
        return

    if event == "Stop":
        if data.get("stop_hook_active"):
            return
        events = session_events(data)
        if skill_ran_this_turn(events):
            return
        missing = missing_skills(events, newest_uncommitted_change(cwd))
        if missing:
            print(json.dumps({"decision": "block", "reason": message(missing)}))


if __name__ == "__main__":
    main()
