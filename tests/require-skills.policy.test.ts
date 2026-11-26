import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	blockReasonForStop,
	blockReasonForToolUse,
	delegatedSkill,
	GRILL_FIRST_MESSAGE,
	type SessionEvent,
	type ToolAction,
} from "../policy/require-skills.ts";
import type { Workspace } from "../policy/workspace.ts";

const WINDOW_START = 1000;
const REPO = "/repo";
const prompt = (at: number): SessionEvent => ({ at, kind: "prompt" });
const edit = (at: number, path = `${REPO}/f.py`): SessionEvent => ({ at, kind: "edit", paths: [path] });
const skill = (at: number, name: string): SessionEvent => ({ at, kind: "skill", name });
const beforeCoding = (at: number) => [
	skill(at, "codebase-design"), skill(at + 1, "grill-me"), prompt(at + 2),
	skill(at + 3, "improve-codebase-architecture"), skill(at + 4, "naming-analyzer"),
];
const shell = (command: string): ToolAction => ({ kind: "shell", command, cwd: REPO });

const COMMIT = shell("rtk git commit -m x");
const EDIT_FILE: ToolAction = { kind: "file-edit", paths: [`${REPO}/f.py`] };

type Case = { name: string; action?: ToolAction; events: SessionEvent[]; newestChange?: number; expected: undefined | RegExp | string };

const cases: Case[] = [
	{ name: "commit: changes and no skills", action: COMMIT, events: [prompt(1100)], newestChange: 1150, expected: /codebase-design/ },
	{ name: "commit: nothing changed", action: COMMIT, events: [prompt(1100)], expected: undefined },
	{ name: "commit: all skills, review after the last change", action: COMMIT, events: [...beforeCoding(1100), skill(1300, "code-review")], newestChange: 1200, expected: undefined },
	{ name: "commit: change after review", action: COMMIT, events: [...beforeCoding(1100), skill(1150, "code-review"), edit(1200)], expected: /code-review \(again/ },
	{ name: "commit: skills before the window", action: COMMIT, events: [...beforeCoding(500), skill(600, "code-review"), edit(1200)], expected: /codebase-design/ },
	{ name: "commit: message names both skill commands", action: COMMIT, events: [edit(1200)], expected: /\/<skill> \(pi: \/skill:<skill>\)/ },
	{ name: "commit: edits outside the repo don't count", action: COMMIT, events: [prompt(1100), edit(1200, "/Users/me/.pi/agent/settings.json")], expected: undefined },
	{ name: "commit: edit without a known path counts", action: COMMIT, events: [{ at: 1200, kind: "edit", paths: "unknown" }], expected: /codebase-design/ },
	{ name: "commit + write in one command: commit gate decides first", action: shell("git commit -m x && rm src/a.py"), events: [edit(1200)], expected: /codebase-design/ },
	{ name: "commit + write in one command: write still needs grilling", action: shell("git commit -m x && rm src/a.py"), events: [prompt(1100)], expected: GRILL_FIRST_MESSAGE },
	{ name: "commit: in another repo is not gated", action: shell("cd ../other && git commit -m x"), events: [edit(1200)], expected: undefined },
	{ name: "grill: edit before grill-me", action: EDIT_FILE, events: [prompt(1100)], expected: GRILL_FIRST_MESSAGE },
	{ name: "grill: started, no answer", action: EDIT_FILE, events: [prompt(1100), skill(1101, "grill-me")], expected: GRILL_FIRST_MESSAGE },
	{ name: "grill: answered", action: EDIT_FILE, events: [skill(1100, "grill-me"), prompt(1101)], expected: undefined },
	{ name: "grill: before the window", action: EDIT_FILE, events: [skill(500, "grill-me"), prompt(501), prompt(1100)], expected: GRILL_FIRST_MESSAGE },
	{ name: "grill: edit outside the repo", action: { kind: "file-edit", paths: ["/tmp/x.py"] }, events: [prompt(1100)], expected: undefined },
	{ name: "grill: edit with an unknown path", action: { kind: "file-edit", paths: "unknown" }, events: [prompt(1100)], expected: GRILL_FIRST_MESSAGE },
	{ name: "grill: subshell cd does not hide a repo write", action: shell("(cd /tmp && rm x) && rm src/a.py"), events: [prompt(1100)], expected: GRILL_FIRST_MESSAGE },
	{ name: "grill: shell write inside the repo", action: shell("echo x > f.py"), events: [prompt(1100)], expected: GRILL_FIRST_MESSAGE },
	{ name: "grill: shell write outside the repo", action: shell("mkdir -p /tmp/x && mv ~/a ~/b"), events: [prompt(1100)], expected: undefined },
	{ name: "grill: shell write with unknown targets", action: shell("rm $FILE"), events: [prompt(1100)], expected: GRILL_FIRST_MESSAGE },
	{ name: "grill: read-only shell", action: shell("grep x f.py | head"), events: [prompt(1100)], expected: undefined },
	{ name: "stop: changes, no skill this turn", events: [prompt(1100)], newestChange: 1150, expected: /codebase-design/ },
	{ name: "stop: only edits outside the repo", events: [prompt(1100), edit(1200, "/tmp/scratch.md")], expected: undefined },
	{ name: "stop: required skill waiting on the user", events: [prompt(1100), skill(1101, "grill-me")], newestChange: 1150, expected: undefined },
	{ name: "stop: grilling waiting on the user", events: [prompt(1100), skill(1101, "grilling")], newestChange: 1150, expected: undefined },
	{ name: "stop: other skills don't pause it", events: [prompt(1100), skill(1101, "simplify")], newestChange: 1150, expected: /codebase-design/ },
	{ name: "stop: skill from an earlier turn", events: [prompt(1100), skill(1101, "grill-me"), prompt(1102)], newestChange: 1150, expected: /improve-codebase-architecture/ },
];

describe("require-skills rules", () => {
	for (const { name, action, events, newestChange = 0, expected } of cases) {
		test(name, () => {
			const workspace: Workspace = {
				windowStart: () => WINDOW_START,
				newestChangeTime: () => newestChange,
				contains: (path) => path === REPO || path.startsWith(`${REPO}/`),
			};
			const inputs = { events: () => events, workspace };
			const reason = action ? blockReasonForToolUse(action, inputs) : blockReasonForStop(inputs);
			if (expected instanceof RegExp) assert.match(reason ?? "", expected);
			else assert.equal(reason, expected);
		});
	}
});

describe("delegatedSkill", () => {
	const cases: [input: object, expected: string | undefined][] = [
		[{ script: "export const meta = { name: 'code-review-session-diff' }" }, "code-review"],
		[{ script: "export const meta = {\n  name: \"naming-analyzer\",\n}" }, "naming-analyzer"],
		[{ script: "export const meta = { name: 'arch-review' }", description: "code-review" }, undefined],
		[{ description: "Code review standards" }, "code-review"],
		[{ description: "code_review" }, "code-review"],
		[{ description: "Code review: standards" }, undefined],
		[{ description: "code-reviewer pass" }, undefined],
		[{ description: "grill-me" }, "grill-me"],
		[{ description: "Fix the parser" }, undefined],
		[{ script: "meta = { description: \"run name: 'code-review' later\", name: 'deploy' }" }, undefined],
		[{ script: "meta = { phases: [{ title: 'a' }], name: 'code-review' }" }, "code-review"],
		[{ script: "const meta: WorkflowMeta = { name: 'code-review' }" }, "code-review"],
		[{ script: "meta = { name: \"code-review 'x'\" }" }, "code-review"],
		[{}, undefined],
	];
	for (const [input, expected] of cases) {
		test(JSON.stringify(input), () => assert.equal(delegatedSkill(input), expected));
	}
});
