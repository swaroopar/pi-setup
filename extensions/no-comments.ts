import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readTextOrEmpty } from "../policy/files.ts";
import { blockReasonForFileChanges, type FileChange } from "../policy/no-comments.ts";
import { unifiedEditSections } from "./lib/pi-edit.ts";
import { failureReason, blockUnlessConfirmed, whenPiGuardsOn } from "./lib/pi-gate.ts";

function fileChanges(toolName: string, input: any, cwd: string): FileChange[] {
	if (toolName === "write") {
		const path = String(input?.path ?? "");
		return [{ path, before: readTextOrEmpty(path, cwd), after: String(input?.content ?? "") }];
	}
	if (toolName !== "edit") return [];
	if (typeof input?.text === "string") {
		return unifiedEditSections(input.text).map(({ path, removed, added }) => ({ path, before: removed.join("\n"), after: added.join("\n") }));
	}
	const edits: any[] = Array.isArray(input?.edits) ? input.edits : input?.oldText !== undefined ? [input] : [];
	return [{
		path: String(input?.path ?? ""),
		before: edits.map((edit) => edit?.oldText ?? "").join("\n"),
		after: edits.map((edit) => edit?.newText ?? "").join("\n"),
	}];
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", whenPiGuardsOn(async (event, ctx) => {
		try {
			const reason = blockReasonForFileChanges(fileChanges(event.toolName, event.input, ctx.cwd));
			if (reason) return { block: true, reason };
		} catch (error) {
			return blockUnlessConfirmed(ctx, "no-comments", failureReason("no-comments", error));
		}
	}));
}
