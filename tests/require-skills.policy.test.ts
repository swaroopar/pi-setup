import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	blockReasonForStop,
	blockReasonForToolUse,
	GRILL_FIRST_MESSAGE,
	isCommitCommand,
	type SessionEvent,
	type ToolAction,
	writesFiles,
} from "../policy/require-skills.ts";
import type { Workspace } from "../policy/workspace.ts";

const WINDOW_START = 1000;
const prompt = (at: number): SessionEvent => ({ at, kind: "prompt" });
const edit = (at: number): SessionEvent => ({ at, kind: "edit" });
const skill = (at: number, name: string): SessionEvent => ({ at, kind: "skill", name });
const beforeCoding = (at: number) => [
	skill(at, "codebase-design"), skill(at + 1, "grill-me"), prompt(at + 2),
	skill(at + 3, "improve-codebase-architecture"), skill(at + 4, "naming-analyzer"),
];

const COMMIT: ToolAction = { kind: "shell", command: "rtk git commit -m x" };
const EDIT_FILE: ToolAction = { kind: "file-edit", paths: ["f.py"] };
const WRITE_SHELL: ToolAction = { kind: "shell", command: "echo x > f.py" };
const READ_SHELL: ToolAction = { kind: "shell", command: "grep x f.py | head" };

type Case = {
	name: string;
	action?: ToolAction;
	events: SessionEvent[];
	newestChange?: number;
	insideWorkspace?: boolean;
	expected: undefined | RegExp | string;
};

const cases: Case[] = [
	{ name: "commit: changes and no skills", action: COMMIT, events: [prompt(1100)], newestChange: 1150, expected: /codebase-design/ },
	{ name: "commit: nothing changed", action: COMMIT, events: [prompt(1100)], expected: undefined },
	{ name: "commit: all skills, review after the last change", action: COMMIT, events: [...beforeCoding(1100), skill(1300, "code-review")], newestChange: 1200, expected: undefined },
	{ name: "commit: change after review", action: COMMIT, events: [...beforeCoding(1100), skill(1150, "code-review"), edit(1200)], expected: /code-review \(again/ },
	{ name: "commit: skills before the window", action: COMMIT, events: [...beforeCoding(500), skill(600, "code-review"), edit(1200)], expected: /codebase-design/ },
	{ name: "commit: message names both skill commands", action: COMMIT, events: [edit(1200)], expected: /\/<skill> \(pi: \/skill:<skill>\)/ },
	{ name: "grill: edit before grill-me", action: EDIT_FILE, events: [prompt(1100)], expected: GRILL_FIRST_MESSAGE },
	{ name: "grill: started, no answer", action: EDIT_FILE, events: [prompt(1100), skill(1101, "grill-me")], expected: GRILL_FIRST_MESSAGE },
	{ name: "grill: answered", action: EDIT_FILE, events: [skill(1100, "grill-me"), prompt(1101)], expected: undefined },
	{ name: "grill: before the window", action: EDIT_FILE, events: [skill(500, "grill-me"), prompt(501), prompt(1100)], expected: GRILL_FIRST_MESSAGE },
	{ name: "grill: outside the workspace", action: EDIT_FILE, events: [prompt(1100)], insideWorkspace: false, expected: undefined },
	{ name: "grill: file-writing shell", action: WRITE_SHELL, events: [prompt(1100)], expected: GRILL_FIRST_MESSAGE },
	{ name: "grill: read-only shell", action: READ_SHELL, events: [prompt(1100)], expected: undefined },
	{ name: "stop: changes, no skill this turn", events: [prompt(1100)], newestChange: 1150, expected: /codebase-design/ },
	{ name: "stop: required skill waiting on the user", events: [prompt(1100), skill(1101, "grill-me")], newestChange: 1150, expected: undefined },
	{ name: "stop: grilling waiting on the user", events: [prompt(1100), skill(1101, "grilling")], newestChange: 1150, expected: undefined },
	{ name: "stop: other skills don't pause it", events: [prompt(1100), skill(1101, "simplify")], newestChange: 1150, expected: /codebase-design/ },
	{ name: "stop: skill from an earlier turn", events: [prompt(1100), skill(1101, "grill-me"), prompt(1102)], newestChange: 1150, expected: /improve-codebase-architecture/ },
];

describe("require-skills rules", () => {
	for (const { name, action, events, newestChange = 0, insideWorkspace = true, expected } of cases) {
		test(name, () => {
			const workspace: Workspace = { windowStart: () => WINDOW_START, newestChangeTime: () => newestChange, contains: () => insideWorkspace };
			const inputs = { events: () => events, workspace };
			const reason = action ? blockReasonForToolUse(action, inputs) : blockReasonForStop(inputs);
			if (expected instanceof RegExp) assert.match(reason ?? "", expected);
			else assert.equal(reason, expected);
		});
	}
});

describe("isCommitCommand", () => {
	const commands: [string, boolean][] = [
		["git commit -m x", true], ["rtk git commit -m x", true], ["cd a && rtk git commit", true],
		["rtk proxy git commit", true], ["git -c a=b commit", true], ['echo "git commit"', false],
		["rtk git log --grep commit", false], ["grep commit x", false],
	];
	for (const [command, expected] of commands) test(command, () => assert.equal(isCommitCommand(command), expected));
});

describe("writesFiles", () => {
	const commands: [string, boolean][] = [
		["sed -i '' 's/a/b/' f.py", true], ["rtk sed -i 's/a/b/' f.py", true], ["echo hi > out.txt", true],
		["echo hi >> out.txt", true], ["cat f | tee out.txt", true], ["cd x && rm f.py", true],
		["git checkout -b x", true], ["mkdir -p src", true], ["perl -pi -e 's/a/b/' f", true],
		["ls > /tmp/x", false], ["ls > /private/tmp/x", false], ["grep a f.py | head", false],
		["cmd 2>/dev/null", false], ["cmd 2>&1 | tail", false], ["git status", false], ["git log --oneline", false],
		['python3 -c "print(1 > 0)"', false], ["sed -n 1p f.py | grep -i x", false], ["echo 'a > b'", false],
		["cat <<'EOF' > /tmp/x.py\nif a > b:\n    rm = 1\nEOF", false], ["npm run test", false],
		["python3 - <<'EOF'\nopen('f.py','w').write('x')\nEOF", true],
		["python3 -c \"from pathlib import Path; Path('f').write_text('x')\"", true],
		["rtk python3 - <<'EOF'\nimport os; os.remove('f.py')\nEOF", true],
		["uv run python -c \"import shutil; shutil.rmtree('x')\"", true],
		["/usr/bin/python3 -c \"open('f','w')\"", true], [".venv/bin/python -c \"open('f','w')\"", true],
		["python3.12 -c \"import os; os.makedirs('d')\"", true],
		["python3 -c \"open(os.path.join(d,'f'), 'w').write('a')\"", true],
		["python3 -c \"open(Path('f'), mode='a')\"", true], ["python3 -c \"open('x', 'r+')\"", true],
		["python3 -c \"print(open('x').read())\"", false], ["python3 -c \"open('x','rb').read()\"", false],
		["python3 -c \"import json; json.load(open('a.json'))\"", false],
	];
	for (const [command, expected] of commands) test(command.split("\n")[0], () => assert.equal(writesFiles(command), expected));
});
