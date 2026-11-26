import { readTextOrEmpty } from "../policy/files.ts";
import { blockReasonForFileChanges, type FileChange } from "../policy/no-comments.ts";
import { denyToolUse, runHook } from "./lib/claude-io.ts";

function fileChanges(toolName: string | undefined, input: any, cwd: string): FileChange[] {
	const path = String(input?.file_path ?? "");
	if (toolName === "Edit") return [{ path, before: String(input?.old_string ?? ""), after: String(input?.new_string ?? "") }];
	if (toolName === "MultiEdit") {
		const edits: any[] = Array.isArray(input?.edits) ? input.edits : [];
		return [{
			path,
			before: edits.map((edit) => edit?.old_string ?? "").join("\n"),
			after: edits.map((edit) => edit?.new_string ?? "").join("\n"),
		}];
	}
	if (toolName === "Write") return [{ path, before: readTextOrEmpty(path, cwd), after: String(input?.content ?? "") }];
	return [];
}

runHook("no-comments", (hookInput) => {
	const reason = blockReasonForFileChanges(fileChanges(hookInput.tool_name, hookInput.tool_input, hookInput.cwd ?? process.cwd()));
	if (reason) denyToolUse(reason);
});
