#!/usr/bin/env python3
import json
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOKS_DIR = os.path.join(ROOT, "hooks")
SETTINGS = os.path.expanduser("~/.claude/settings.json")

WANTED = {
    "PreToolUse": [
        ("Bash", "require-skills.py"),
        ("Edit|Write|MultiEdit", "no-comments.py"),
    ],
    "Stop": [
        (None, "require-skills.py"),
    ],
}


def hook_group(matcher, script):
    group = {"hooks": [{"type": "command", "command": f'python3 "{os.path.join(HOOKS_DIR, script)}"'}]}
    return {"matcher": matcher, **group} if matcher else group


def points_at_this_repo(group):
    return any(HOOKS_DIR + os.sep in h.get("command", "") for h in group.get("hooks", []))


def main():
    if not os.path.isdir(os.path.dirname(SETTINGS)):
        print(f"skip (Claude Code not installed): {os.path.dirname(SETTINGS)} does not exist")
        return
    settings = {}
    if os.path.exists(SETTINGS):
        settings = json.load(open(SETTINGS, encoding="utf-8"))
        shutil.copyfile(SETTINGS, SETTINGS + ".bak")
    hooks = settings.setdefault("hooks", {})
    for event, entries in WANTED.items():
        kept = [g for g in hooks.get(event, []) if not points_at_this_repo(g)]
        hooks[event] = kept + [hook_group(m, s) for m, s in entries]
    with open(SETTINGS, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    print(f"registered {HOOKS_DIR} hooks in {SETTINGS}")


if __name__ == "__main__":
    main()
