import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	AFTER_COMMIT,
	BEFORE_BRANCH,
	isoAt,
	loadPiExtension,
	makeRepo,
	ON_BRANCH,
	runClaudeHook,
	writeTranscript,
} from "./helpers.ts";

describe("Claude Code adapter", () => {
	const prompt = (at: number, text = "go") => ({ timestamp: isoAt(at), type: "user", message: { content: text } });
	const meta = (at: number) => ({ timestamp: isoAt(at), type: "user", isMeta: true, message: { content: "Stop hook feedback" } });
	const toolUse = (at: number, name: string, input: object, id = "t") => ({
		timestamp: isoAt(at), type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] },
	});
	const toolError = (at: number, id: string) => ({
		timestamp: isoAt(at), type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true }] },
	});
	const slash = (at: number, name: string) => ({ timestamp: isoAt(at), type: "user", message: { content: `<command-name>/${name}</command-name>` } });
	const skill = (at: number, name: string, id = "s") => toolUse(at, "Skill", { skill: name }, id);
	const allSkills = (at: number) => [skill(at, "codebase-design"), skill(at + 1, "grill-me"), prompt(at + 2), skill(at + 3, "improve-codebase-architecture"), skill(at + 4, "naming-analyzer")];

	const editHook = (repo: string, entries: object[]) => runClaudeHook("require-skills.ts", {
		hook_event_name: "PreToolUse", cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "f.py") }, transcript_path: writeTranscript(entries),
	});
	const commitHook = (repo: string, entries: object[]) => runClaudeHook("require-skills.ts", {
		hook_event_name: "PreToolUse", cwd: repo, tool_name: "Bash", tool_input: { command: "rtk git commit -m y" }, transcript_path: writeTranscript(entries),
	});
	const stopHook = (repo: string, entries: object[], stopHookActive = false) => runClaudeHook("require-skills.ts", {
		hook_event_name: "Stop", cwd: repo, stop_hook_active: stopHookActive, transcript_path: writeTranscript(entries),
	});

	test("grilling before the agent's own commit still unlocks edits", () => {
		assert.equal(editHook(makeRepo(), [skill(ON_BRANCH, "grill-me"), prompt(ON_BRANCH + 1)]), "");
	});
	test("grilling before the branch point does not count", () => {
		assert.match(editHook(makeRepo(), [skill(BEFORE_BRANCH, "grill-me"), prompt(BEFORE_BRANCH + 1), prompt(AFTER_COMMIT)]), /deny/);
	});
	test("without a remote the window starts at HEAD", () => {
		assert.match(editHook(makeRepo({ withOrigin: false }), [skill(ON_BRANCH, "grill-me"), prompt(ON_BRANCH + 1)]), /deny/);
	});
	test("a typed /grill-me plus an answer unlocks edits", () => {
		assert.equal(editHook(makeRepo(), [slash(AFTER_COMMIT, "grill-me"), prompt(AFTER_COMMIT + 1)]), "");
	});
	test("a failed grill-me call does not unlock edits", () => {
		assert.match(editHook(makeRepo(), [skill(AFTER_COMMIT, "grill-me", "g"), toolError(AFTER_COMMIT + 1, "g"), prompt(AFTER_COMMIT + 2)]), /deny/);
	});
	test("stop feedback is not an answer", () => {
		assert.match(editHook(makeRepo(), [skill(AFTER_COMMIT, "grill-me"), meta(AFTER_COMMIT + 1)]), /deny/);
	});
	test("old untracked files do not count as changes", () => {
		const repo = makeRepo({ untracked: [[".DS_Store", BEFORE_BRANCH], ["request.json", BEFORE_BRANCH]] });
		assert.equal(stopHook(repo, [prompt(AFTER_COMMIT)]), "");
		assert.equal(commitHook(repo, [prompt(AFTER_COMMIT)]), "");
	});
	test("new untracked files count as changes", () => {
		assert.match(stopHook(makeRepo({ untracked: [["new.py", AFTER_COMMIT + 50]] }), [prompt(AFTER_COMMIT)]), /block/);
	});
	test("commit passes when every skill ran and code-review came last", () => {
		assert.equal(commitHook(makeRepo({ modifiedAt: AFTER_COMMIT + 50 }), [...allSkills(ON_BRANCH), skill(AFTER_COMMIT + 60, "code-review")]), "");
	});
	test("a failed skill call does not count for the commit", () => {
		const entries = [...allSkills(AFTER_COMMIT).slice(0, -1), skill(AFTER_COMMIT + 4, "naming-analyzer", "n"), toolError(AFTER_COMMIT + 5, "n"), skill(AFTER_COMMIT + 60, "code-review")];
		assert.match(commitHook(makeRepo({ modifiedAt: AFTER_COMMIT + 50 }), entries), /naming-analyzer/);
	});
	test("stop pauses while a required skill waits on the user", () => {
		assert.equal(stopHook(makeRepo({ modifiedAt: AFTER_COMMIT + 50 }), [prompt(AFTER_COMMIT), skill(AFTER_COMMIT + 1, "grill-me")]), "");
	});
	test("a malformed session log still blocks instead of crashing", () => {
		const broken = { timestamp: isoAt(AFTER_COMMIT + 1), type: "assistant", message: { content: [null, 42, { type: "text", text: "x" }] } };
		assert.match(stopHook(makeRepo({ modifiedAt: AFTER_COMMIT + 50 }), [prompt(AFTER_COMMIT), broken, "not an object"]), /block/);
	});
	test("edits outside the repo do not trigger the stop check", () => {
		const outside = toolUse(AFTER_COMMIT + 1, "Write", { file_path: "/tmp/scratch/notes.md" });
		assert.equal(stopHook(makeRepo(), [prompt(AFTER_COMMIT), outside]), "");
	});
	test("an edit tool call without a path is gated before grilling", () => {
		const result = runClaudeHook("require-skills.ts", {
			hook_event_name: "PreToolUse", cwd: makeRepo(), tool_name: "Edit", tool_input: {}, transcript_path: writeTranscript([prompt(AFTER_COMMIT)]),
		});
		assert.match(result, /deny/);
	});
	test("a workflow named after code-review counts as the review", () => {
		const workflow = toolUse(AFTER_COMMIT + 60, "Workflow", { script: "export const meta = { name: 'code-review-session-diff' }\n" }, "w");
		assert.equal(commitHook(makeRepo({ modifiedAt: AFTER_COMMIT + 50 }), [...allSkills(ON_BRANCH), workflow]), "");
	});
	test("a failed sub-agent run does not count as the review", () => {
		const agent = toolUse(AFTER_COMMIT + 60, "Agent", { description: "Code review: standards" }, "a");
		assert.match(commitHook(makeRepo({ modifiedAt: AFTER_COMMIT + 50 }), [...allSkills(ON_BRANCH), agent, toolError(AFTER_COMMIT + 61, "a")]), /code-review/);
	});
	test("stop_hook_active never blocks twice", () => {
		assert.equal(stopHook(makeRepo({ modifiedAt: AFTER_COMMIT + 50 }), [prompt(AFTER_COMMIT)], true), "");
	});
});

describe("pi adapter", async () => {
	const handlers = await loadPiExtension("require-skills.ts");
	const prompt = (at: number, text = "go") => ({ type: "message", timestamp: isoAt(at), message: { role: "user", content: [{ type: "text", text }] } });
	const call = (at: number, name: string, args: object, id = "t") => ({
		type: "message", timestamp: isoAt(at), message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
	});
	const toolError = (at: number, id: string) => ({ type: "message", timestamp: isoAt(at), message: { role: "toolResult", toolCallId: id, isError: true } });
	const readSkill = (at: number, name: string, id = "r") => call(at, "read", { path: `/h/.pi/agent/skills/${name}/SKILL.md` }, id);
	const typedSkill = (at: number, name: string) => prompt(at, `<skill name="${name}" location="/x">\nbody\n</skill>`);
	const ctx = (cwd: string, entries: object[]) => ({ cwd, sessionManager: { getBranch: () => entries } });
	const toolCall = (cwd: string, entries: object[], toolName: string, input: object) => handlers.tool_call({ toolName, input }, ctx(cwd, entries));
	const settle = async (cwd: string, entries: object[]) => {
		await handlers.input({}, {});
		return handlers.agent_before_settle({ entries: [] }, ctx(cwd, entries));
	};

	test("blocks edits before grilling and allows them after an answer", async () => {
		const repo = makeRepo();
		assert.ok(await toolCall(repo, [prompt(AFTER_COMMIT)], "edit", { path: "f.py", edits: [] }));
		assert.equal(await toolCall(repo, [readSkill(ON_BRANCH, "grill-me"), prompt(ON_BRANCH + 1)], "edit", { path: "f.py", edits: [] }), undefined);
		assert.equal(await toolCall(repo, [typedSkill(AFTER_COMMIT, "grill-me"), prompt(AFTER_COMMIT + 1)], "write", { path: "f.py", content: "" }), undefined);
	});
	test("unified-edit scripts are checked by their file headers", async () => {
		assert.ok(await toolCall(makeRepo(), [prompt(AFTER_COMMIT)], "edit", { text: "[f.py]\n@APPEND\n+y = 1" }));
		assert.ok(await toolCall(makeRepo(), [prompt(AFTER_COMMIT)], "edit", { text: "*** Begin Patch\n*** Delete File: f.py\n*** End Patch" }));
	});
	test("an internal error blocks instead of allowing", async () => {
		const broken = { cwd: makeRepo(), sessionManager: { getBranch: () => { throw new Error("boom"); } } };
		const result = await handlers.tool_call({ toolName: "edit", input: { path: "f.py", edits: [] } }, broken);
		assert.match(result?.reason ?? "", /failed, so it blocked/);
	});
	test("a failed SKILL.md read does not unlock edits", async () => {
		const entries = [readSkill(AFTER_COMMIT, "grill-me", "g"), toolError(AFTER_COMMIT + 1, "g"), prompt(AFTER_COMMIT + 2)];
		assert.ok(await toolCall(makeRepo(), entries, "edit", { path: "f.py", edits: [] }));
	});
	test("commit gate and settle nudge", async () => {
		const repo = makeRepo({ modifiedAt: AFTER_COMMIT + 50 });
		assert.ok(await toolCall(repo, [prompt(AFTER_COMMIT)], "bash", { command: "git commit -m y" }));
		assert.ok(await settle(repo, [prompt(AFTER_COMMIT)]));
		assert.equal(await settle(repo, [prompt(AFTER_COMMIT), readSkill(AFTER_COMMIT + 1, "grill-me")]), undefined);
	});
	test("edits outside the repo do not trigger the settle nudge", async () => {
		const outside = call(AFTER_COMMIT + 1, "write", { path: "/tmp/scratch/notes.md", content: "" });
		assert.equal(await settle(makeRepo(), [prompt(AFTER_COMMIT), outside]), undefined);
		const unifiedOutside = call(AFTER_COMMIT + 1, "edit", { text: "[/tmp/scratch/a.ts]\n@APPEND\n+x" });
		assert.equal(await settle(makeRepo(), [prompt(AFTER_COMMIT), unifiedOutside]), undefined);
	});
	test("shell writes outside the repo are allowed before grilling", async () => {
		assert.equal(await toolCall(makeRepo(), [prompt(AFTER_COMMIT)], "bash", { command: "mkdir -p /tmp/pi-setup-x && mv ~/a ~/b" }), undefined);
	});
	test("a workflow named after code-review counts as the review", async () => {
		const read = (at: number, name: string) => readSkill(at, name, name);
		const before = [read(ON_BRANCH, "codebase-design"), read(ON_BRANCH + 1, "grill-me"), prompt(ON_BRANCH + 2), read(ON_BRANCH + 3, "improve-codebase-architecture"), read(ON_BRANCH + 4, "naming-analyzer"), read(ON_BRANCH + 5, "code-review")];
		const edit = call(AFTER_COMMIT + 40, "edit", { path: "f.py", edits: [] }, "e");
		const workflow = call(AFTER_COMMIT + 60, "workflow", { script: "export const meta = { name: 'code-review-session-diff', description: 'x' }" }, "w");
		const repo = makeRepo({ modifiedAt: AFTER_COMMIT + 50 });
		assert.ok(await toolCall(repo, [...before, edit], "bash", { command: "git commit -m y" }));
		assert.equal(await toolCall(repo, [...before, edit, workflow], "bash", { command: "git commit -m y" }), undefined);
	});
	test("settle nudges only once per prompt", async () => {
		const repo = makeRepo({ modifiedAt: AFTER_COMMIT + 50 });
		assert.ok(await settle(repo, [prompt(AFTER_COMMIT)]));
		assert.equal(await handlers.agent_before_settle({ entries: [] }, ctx(repo, [prompt(AFTER_COMMIT)])), undefined);
	});
});
