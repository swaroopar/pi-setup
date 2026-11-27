import { readFileSync } from "node:fs";
import { guardsEnabled } from "../../policy/guards-switch.ts";

const BLOCKING_EXIT_CODE = 2;

export type HookInput = {
	hook_event_name?: string;
	cwd?: string;
	transcript_path?: string;
	tool_name?: string;
	tool_input?: any;
	stop_hook_active?: boolean;
	permission_mode?: string;
};

type ToolUseDecision = "deny" | "ask";

function decideToolUse(decision: ToolUseDecision, reason: string): void {
	const additionalContext = decision === "ask" ? reason : undefined;
	console.log(JSON.stringify({
		hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason, additionalContext },
	}));
}

export const denyToolUse = (reason: string) => decideToolUse("deny", reason);

export function askUserOrDeny(input: HookInput | undefined, reason: string): void {
	decideToolUse(input?.permission_mode === "bypassPermissions" ? "deny" : "ask", reason);
}

export function blockStop(reason: string): void {
	console.log(JSON.stringify({ decision: "block", reason }));
}

export function runHook(name: string, handle: (input: HookInput) => void): void {
	if (!guardsEnabled("claude")) return;
	let input: HookInput | undefined;
	try {
		const parsed: HookInput = JSON.parse(readFileSync(0, "utf8"));
		input = parsed;
		handle(parsed);
	} catch (error) {
		const reason = `${name} hook failed, so it can't check this call: ${error instanceof Error ? error.message : error}`;
		if (input?.hook_event_name === "PreToolUse") return askUserOrDeny(input, reason);
		console.error(reason);
		process.exit(BLOCKING_EXIT_CODE);
	}
}
