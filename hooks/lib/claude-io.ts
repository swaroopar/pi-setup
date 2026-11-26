import { readFileSync } from "node:fs";

const BLOCKING_EXIT_CODE = 2;

export type HookInput = {
	hook_event_name?: string;
	cwd?: string;
	transcript_path?: string;
	tool_name?: string;
	tool_input?: any;
	stop_hook_active?: boolean;
};

export function denyToolUse(reason: string): void {
	console.log(JSON.stringify({
		hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
	}));
}

export function blockStop(reason: string): void {
	console.log(JSON.stringify({ decision: "block", reason }));
}

export function runHook(name: string, handle: (input: HookInput) => void): void {
	try {
		handle(JSON.parse(readFileSync(0, "utf8")));
	} catch (error) {
		console.error(`${name} hook failed, so it blocked to stay safe: ${error instanceof Error ? error.message : error}`);
		process.exit(BLOCKING_EXIT_CODE);
	}
}
