import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { guardsEnabled, runGuardsCommand } from "../policy/guards-switch.ts";
import { AFTER_COMMIT, isoAt, loadPiExtension, makeRepo, REPO_ROOT, runClaudeHook, writeTranscript } from "./helpers.ts";

describe("guards switch", async () => {
	afterEach(() => {
		runGuardsCommand("claude", "on");
		runGuardsCommand("pi", "on");
	});
	const requireSkillsHandlers = await loadPiExtension("require-skills.ts");
	const noCommentsHandlers = await loadPiExtension("no-comments.ts");
	const guardsHandlers = await loadPiExtension("guards.ts");
	const prompt = { timestamp: isoAt(AFTER_COMMIT), type: "user", message: { content: "go" } };

	test("off, on and status", () => {
		assert.match(runGuardsCommand("claude", "off"), /OFF in Claude Code.*pi is not affected/);
		assert.equal(guardsEnabled("claude"), false);
		assert.match(runGuardsCommand("claude", ""), /OFF/);
		assert.match(runGuardsCommand("claude", " ON "), /ON in Claude Code/);
		assert.equal(guardsEnabled("claude"), true);
		assert.match(runGuardsCommand("claude", ""), /ON/);
		assert.match(runGuardsCommand("claude", "maybe"), /Unknown argument "maybe"/);
	});
	test("each tool has its own switch", () => {
		runGuardsCommand("claude", "off");
		assert.equal(guardsEnabled("claude"), false);
		assert.equal(guardsEnabled("pi"), true);
		runGuardsCommand("pi", "off");
		runGuardsCommand("claude", "on");
		assert.equal(guardsEnabled("claude"), true);
		assert.equal(guardsEnabled("pi"), false);
	});
	test("the guards script used by the Claude /guards command switches and reports", () => {
		const run = (argument: string) => execFileSync(process.execPath, ["--no-warnings", join(REPO_ROOT, "scripts", "guards.ts"), argument], { encoding: "utf8" });
		assert.match(run("off"), /OFF in Claude Code/);
		assert.equal(guardsEnabled("claude"), false);
		assert.equal(guardsEnabled("pi"), true);
		assert.match(run("on"), /ON in Claude Code/);
		assert.equal(guardsEnabled("claude"), true);
	});
	test("Claude hooks allow everything while off and enforce again when on", () => {
		const repo = makeRepo();
		const file = join(repo, "f.py");
		const editedFile = { timestamp: isoAt(AFTER_COMMIT + 1), type: "assistant", message: { content: [{ type: "tool_use", id: "e", name: "Edit", input: { file_path: file } }] } };
		const edit = { hook_event_name: "PreToolUse", cwd: repo, tool_name: "Edit", transcript_path: writeTranscript([prompt]) };
		const calls = () => [
			runClaudeHook("require-skills.ts", { ...edit, tool_input: { file_path: file } }),
			runClaudeHook("no-comments.ts", { ...edit, tool_input: { file_path: file, old_string: "a", new_string: "a  # note" } }),
			runClaudeHook("require-skills.ts", { hook_event_name: "Stop", cwd: repo, transcript_path: writeTranscript([prompt, editedFile]) }),
		];
		const [editOutput, commentOutput, stopOutput] = calls();
		assert.match(editOutput, /"permissionDecision":"ask"/);
		assert.match(commentOutput, /"permissionDecision":"deny"/);
		assert.match(stopOutput, /"decision":"block"/);
		runGuardsCommand("pi", "off");
		const [editWhilePiOff, commentWhilePiOff, stopWhilePiOff] = calls();
		assert.match(editWhilePiOff, /"permissionDecision":"ask"/);
		assert.match(commentWhilePiOff, /"permissionDecision":"deny"/);
		assert.match(stopWhilePiOff, /"decision":"block"/);
		runGuardsCommand("claude", "off");
		assert.deepEqual(calls(), ["", "", ""]);
	});
	test("pi extensions allow everything while off, and /guards switches", async () => {
		const notes: string[] = [];
		await guardsHandlers["/guards"]("off", { ui: { notify: (message: string) => notes.push(message) } });
		assert.match(notes[0], /OFF in pi/);
		assert.equal(guardsEnabled("claude"), true);
		const repo = makeRepo();
		const piPrompt = { type: "message", timestamp: isoAt(AFTER_COMMIT), message: { role: "user", content: [{ type: "text", text: "go" }] } };
		const piWrite = { type: "message", timestamp: isoAt(AFTER_COMMIT + 1), message: { role: "assistant", content: [{ type: "toolCall", id: "w", name: "write", arguments: { path: join(repo, "f.py"), content: "" } }] } };
		const ctx = { cwd: repo, sessionManager: { getBranch: () => [piPrompt, piWrite] } };
		assert.equal(await requireSkillsHandlers.tool_call({ toolName: "edit", input: { path: "f.py", edits: [] } }, ctx), undefined);
		await requireSkillsHandlers.input({}, {});
		assert.equal(await requireSkillsHandlers.agent_before_settle({ entries: [] }, ctx), undefined);
		assert.equal(await noCommentsHandlers.tool_call({ toolName: "write", input: { path: "x.py", content: "# note\n" } }, ctx), undefined);
		await guardsHandlers["/guards"]("on", { ui: { notify: (message: string) => notes.push(message) } });
		assert.ok(await requireSkillsHandlers.tool_call({ toolName: "edit", input: { path: "f.py", edits: [] } }, ctx));
		await requireSkillsHandlers.input({}, {});
		assert.ok(await requireSkillsHandlers.agent_before_settle({ entries: [] }, ctx));
		assert.ok(await noCommentsHandlers.tool_call({ toolName: "write", input: { path: "x.py", content: "# note\n" } }, ctx));
		assert.match(notes[1], /ON in pi/);
	});
});
