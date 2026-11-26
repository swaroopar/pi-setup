import { readFileSync } from "node:fs";
import {
	blockReasonForStop,
	blockReasonForToolUse,
	delegatedSkill,
	type EditedPaths,
	type SessionEvent,
	type SessionInputs,
	type ToolAction,
} from "../policy/require-skills.ts";
import { gitWorkspace } from "../policy/workspace.ts";
import { askUserOrDeny, blockStop, runHook } from "./lib/claude-io.ts";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DELEGATION_TOOLS = new Set(["Agent", "Workflow"]);
const EDIT_MCP_RE = /^mcp__.*__(apply_patch|create_new_file|replace_\w+|edit_\w+|write_\w+)$/;
const SLASH_COMMAND_RE = /<command-name>\/?([\w:.-]+)<\/command-name>/g;

type ContentBlock = { type?: string; text?: string; id?: string; name?: string; input?: any; tool_use_id?: string; is_error?: boolean };
type TranscriptEntry = { type?: string; isMeta?: boolean; isSidechain?: boolean; timestamp?: string; message?: { content?: unknown } };

const skillName = (name: string) => name.split(":").pop() ?? name;
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

function blocksOf(entry: TranscriptEntry): ContentBlock[] {
	const content = entry.message?.content;
	if (Array.isArray(content)) return content.filter(isObject);
	return [{ type: "text", text: typeof content === "string" ? content : "" }];
}

function parseTranscript(path: string): TranscriptEntry[] {
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	return text.split("\n").flatMap((line) => {
		try {
			const entry: unknown = JSON.parse(line);
			return isObject(entry) && !(entry as TranscriptEntry).isSidechain ? [entry as TranscriptEntry] : [];
		} catch {
			return [];
		}
	});
}

function failedToolIds(entries: TranscriptEntry[]): Set<string | undefined> {
	const failed = new Set<string | undefined>();
	for (const entry of entries) {
		if (entry.type !== "user") continue;
		for (const block of blocksOf(entry)) {
			if (block.type === "tool_result" && block.is_error) failed.add(block.tool_use_id);
		}
	}
	return failed;
}

function editedPaths(input: any): EditedPaths {
	const path = input?.file_path ?? input?.notebook_path ?? input?.path;
	return typeof path === "string" && path ? [path] : "unknown";
}

function isPrompt(entry: TranscriptEntry, blocks: ContentBlock[]): boolean {
	return entry.type === "user" && !entry.isMeta && !blocks.some((block) => block.type === "tool_result");
}

function transcriptEvents(path: string): SessionEvent[] {
	const entries = parseTranscript(path);
	const failed = failedToolIds(entries);
	const events: SessionEvent[] = [];
	for (const entry of entries) {
		const at = Date.parse(entry.timestamp ?? "") || 0;
		const blocks = blocksOf(entry);
		if (isPrompt(entry, blocks)) events.push({ at, kind: "prompt" });
		for (const block of blocks) {
			if (entry.type === "user" && block.type === "text") {
				for (const match of String(block.text ?? "").matchAll(SLASH_COMMAND_RE)) {
					events.push({ at, kind: "skill", name: skillName(match[1]) });
				}
			} else if (entry.type === "assistant" && block.type === "tool_use") {
				const name = String(block.name ?? "");
				if (EDIT_TOOLS.has(name) || EDIT_MCP_RE.test(name)) events.push({ at, kind: "edit", paths: editedPaths(block.input) });
				else if (name === "Skill" && !failed.has(block.id)) {
					events.push({ at, kind: "skill", name: skillName(String(block.input?.skill ?? "")) });
				} else if (DELEGATION_TOOLS.has(name) && !failed.has(block.id)) {
					const skill = delegatedSkill(block.input);
					if (skill) events.push({ at, kind: "skill", name: skill });
				}
			}
		}
	}
	return events;
}

function toolAction(toolName: string | undefined, input: any, cwd: string): ToolAction {
	if (toolName === "Bash") return { kind: "shell", command: String(input?.command ?? ""), cwd };
	if (toolName && EDIT_TOOLS.has(toolName)) return { kind: "file-edit", paths: editedPaths(input) };
	return { kind: "other" };
}

runHook("require-skills", (hookInput) => {
	const cwd = hookInput.cwd ?? process.cwd();
	const session: SessionInputs = {
		events: () => transcriptEvents(hookInput.transcript_path ?? ""),
		workspace: gitWorkspace(cwd),
	};
	if (hookInput.hook_event_name === "PreToolUse") {
		const reason = blockReasonForToolUse(toolAction(hookInput.tool_name, hookInput.tool_input, cwd), session);
		if (reason) askUserOrDeny(hookInput, reason);
	} else if (hookInput.hook_event_name === "Stop" && !hookInput.stop_hook_active) {
		const reason = blockReasonForStop(session);
		if (reason) blockStop(reason);
	}
});
