import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { blockReasonForFileChanges } from "../policy/no-comments.ts";
import { loadPiExtension, REPO_ROOT, runClaudeHook } from "./helpers.ts";

type Case = { name: string; path: string; before: string; after: string; blocked: boolean };
const cases: Case[] = JSON.parse(readFileSync(join(REPO_ROOT, "tests", "no-comments.cases.json"), "utf8"));

describe("no-comments policy", () => {
	for (const { name, path, before, after, blocked } of cases) {
		test(name, () => assert.equal(blockReasonForFileChanges([{ path, before, after }]) !== undefined, blocked));
	}
});

describe("no-comments Claude Code adapter", () => {
	const run = (tool_name: string, tool_input: object) => runClaudeHook("no-comments.ts", { hook_event_name: "PreToolUse", tool_name, tool_input });
	const existingFile = () => {
		const path = join(mkdtempSync(join(tmpdir(), "pi-setup-nc-")), "x.py");
		writeFileSync(path, "# keep\nx = 1\n");
		return path;
	};

	test("Edit adding a comment is denied", () => {
		assert.match(run("Edit", { file_path: "/a/b.ts", old_string: "a", new_string: "// c\na" }), /deny/);
	});
	test("Write keeping existing comments is allowed", () => {
		assert.equal(run("Write", { file_path: existingFile(), content: "# keep\nx = 2\n" }), "");
	});
	test("Write adding a comment is denied", () => {
		assert.match(run("Write", { file_path: existingFile(), content: "# keep\n# new\nx = 2\n" }), /deny/);
	});
	test("Write with a relative path compares against the file in cwd", () => {
		const path = existingFile();
		const cwd = path.slice(0, -"/x.py".length);
		assert.equal(runClaudeHook("no-comments.ts", { hook_event_name: "PreToolUse", cwd, tool_name: "Write", tool_input: { file_path: "x.py", content: "# keep\nx = 2\n" } }), "");
	});
	test("CRLF line endings are split correctly", () => {
		assert.match(run("Edit", { file_path: "/a/b.py", old_string: "x = 1\r\n", new_string: "x = 1\r\n# new\r\n" }), /# new/);
	});
	test("MultiEdit adding an inline comment is denied", () => {
		assert.match(run("MultiEdit", { file_path: "/a/x.py", edits: [{ old_string: "x = 1", new_string: "x = 2  # two" }] }), /deny/);
	});
});

describe("no-comments pi adapter", async () => {
	const handlers = await loadPiExtension("no-comments.ts");
	const cwd = mkdtempSync(join(tmpdir(), "pi-setup-nc-"));
	writeFileSync(join(cwd, "x.py"), "# keep\nx = 1\n");
	const blocked = async (toolName: string, input: object) => Boolean(await handlers.tool_call({ toolName, input }, { cwd }));

	test("built-in edit", async () => {
		assert.equal(await blocked("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "// c\na" }] }), true);
	});
	test("unified-edit row script", async () => {
		assert.equal(await blocked("edit", { text: "[a.ts]\n@REPLACE\n-a\n+// c\n+a" }), true);
	});
	test("apply_patch style add file", async () => {
		assert.equal(await blocked("edit", { text: "*** Begin Patch\n*** Add File: n.ts\n+// hi\n+const a = 1;\n*** End Patch" }), true);
	});
	test("write compares against the file on disk", async () => {
		assert.equal(await blocked("write", { path: "x.py", content: "# keep\nx = 2\n" }), false);
		assert.equal(await blocked("write", { path: "x.py", content: "# keep\n# new\nx = 2\n" }), true);
	});
	test("other tools are ignored", async () => {
		assert.equal(await blocked("bash", { command: "echo '# x' > a.py" }), false);
	});
});
