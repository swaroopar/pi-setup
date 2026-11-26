import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const offFlagPath = () => process.env.AGENT_GUARDS_OFF_FILE ?? join(homedir(), ".config", "agent-guards", "off");

export function guardsEnabled(): boolean {
	return !existsSync(offFlagPath());
}

export function runGuardsCommand(argument: string): string {
	const choice = argument.trim().toLowerCase();
	const flag = offFlagPath();
	if (choice === "off") {
		mkdirSync(dirname(flag), { recursive: true });
		writeFileSync(flag, "");
	} else if (choice === "on") {
		rmSync(flag, { force: true });
	} else if (choice !== "") {
		return `Unknown argument "${argument.trim()}". Use /guards on, /guards off, or /guards to see the state.`;
	}
	return guardsEnabled()
		? "Guards are ON: require-skills and no-comments are enforced in every Claude Code and pi session."
		: "Guards are OFF: require-skills and no-comments allow everything in every Claude Code and pi session until /guards on.";
}
