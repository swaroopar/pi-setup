import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type GuardedTool = "claude" | "pi";

const TOOL_DISPLAY_NAMES: Record<GuardedTool, string> = { claude: "Claude Code", pi: "pi" };

const flagDir = () => process.env.AGENT_GUARDS_DIR ?? join(homedir(), ".config", "agent-guards");
const offFlagPath = (tool: GuardedTool) => join(flagDir(), `off-${tool}`);

export function guardsEnabled(tool: GuardedTool): boolean {
	return !existsSync(offFlagPath(tool));
}

function stateMessage(tool: GuardedTool): string {
	const name = TOOL_DISPLAY_NAMES[tool];
	const otherName = TOOL_DISPLAY_NAMES[tool === "claude" ? "pi" : "claude"];
	return guardsEnabled(tool)
		? `Guards are ON in ${name}: require-skills and no-comments are enforced in every ${name} session. ${otherName} is not affected.`
		: `Guards are OFF in ${name}: require-skills and no-comments allow everything in every ${name} session until /guards on. ${otherName} is not affected.`;
}

export function runGuardsCommand(tool: GuardedTool, argument: string): string {
	const choice = argument.trim().toLowerCase();
	const flag = offFlagPath(tool);
	if (choice === "off") {
		mkdirSync(flagDir(), { recursive: true });
		writeFileSync(flag, "");
	} else if (choice === "on") {
		rmSync(flag, { force: true });
	} else if (choice !== "") {
		return `Unknown argument "${argument.trim()}". Use /guards on, /guards off, or /guards to see the state.`;
	}
	return stateMessage(tool);
}
