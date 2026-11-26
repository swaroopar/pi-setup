import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	blockReasonForStop,
	blockReasonForToolUse,
	type SessionEvent,
	type SessionInputs,
	type ToolAction,
} from "../policy/require-skills.ts";
import { gitWorkspace } from "../policy/workspace.ts";
import { blockFailure, unifiedEditSections } from "./lib/pi-edit.ts";

const EDIT_TOOLS = new Set(["edit", "write"]);
const SKILL_BLOCK_RE = /^<skill name="([^"]+)"/;
const SKILL_FILE_RE = /([^/\\]+)[/\\]SKILL\.md$/;

type HookContext = { cwd: string; sessionManager: { getBranch(): any[] } };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block: any) => (block?.type === "text" ? block.text ?? "" : "")).join("\n");
}

function failedToolIds(entries: any[]): Set<string> {
	const failed = new Set<string>();
	for (const entry of entries) {
		const message = entry?.message;
		if (entry?.type === "message" && message?.role === "toolResult" && message.isError) failed.add(message.toolCallId);
	}
	return failed;
}

function sessionEvents(entries: any[]): SessionEvent[] {
	const failed = failedToolIds(entries);
	const events: SessionEvent[] = [];
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const at = Date.parse(entry.timestamp) || 0;
		const message = entry.message ?? {};
		if (message.role === "user") {
			events.push({ at, kind: "prompt" });
			const skill = textOf(message.content).match(SKILL_BLOCK_RE);
			if (skill) events.push({ at, kind: "skill", name: skill[1] });
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block?.type !== "toolCall") continue;
				if (EDIT_TOOLS.has(block.name)) events.push({ at, kind: "edit" });
				else if (block.name === "read" && !failed.has(block.id)) {
					const skill = String(block.arguments?.path ?? "").match(SKILL_FILE_RE);
					if (skill) events.push({ at, kind: "skill", name: skill[1] });
				}
			}
		}
	}
	return events;
}

function toolAction(toolName: string, input: any): ToolAction {
	if (toolName === "bash") return { kind: "shell", command: String(input?.command ?? "") };
	if (toolName === "write") return { kind: "file-edit", paths: [String(input?.path ?? "")] };
	if (toolName !== "edit") return { kind: "other" };
	if (typeof input?.text === "string") return { kind: "file-edit", paths: unifiedEditSections(input.text).map((s) => s.path) };
	return { kind: "file-edit", paths: [String(input?.path ?? "")] };
}

function sessionInputs(ctx: HookContext): SessionInputs {
	return { events: () => sessionEvents(ctx.sessionManager.getBranch()), workspace: gitWorkspace(ctx.cwd) };
}

export default function (pi: ExtensionAPI) {
	let nudged = false;
	pi.on("input", async () => {
		nudged = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			const reason = blockReasonForToolUse(toolAction(event.toolName, event.input), sessionInputs(ctx));
			if (reason) return { block: true, reason };
		} catch (error) {
			return blockFailure("require-skills", error);
		}
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (nudged) return;
		let reason: string | undefined;
		try {
			reason = blockReasonForStop(sessionInputs(ctx));
		} catch (error) {
			reason = blockFailure("require-skills", error).reason;
		}
		if (!reason) return;
		nudged = true;
		return {
			entries: [...event.entries, { type: "custom_message", customType: "require-skills", content: reason, display: true }],
			continue: true,
		};
	});
}
