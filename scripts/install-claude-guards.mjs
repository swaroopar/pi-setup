#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE = [23, 6];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = join(ROOT, "hooks");
const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const GUARDS_COMMAND_PATH = join(CLAUDE_DIR, "commands", "guards.md");

const HOOK_REGISTRATIONS = {
	PreToolUse: [
		["Bash|Edit|Write|MultiEdit|NotebookEdit", "require-skills.ts"],
		["Edit|Write|MultiEdit", "no-comments.ts"],
	],
	Stop: [[undefined, "require-skills.ts"]],
};

function nodeIsNewEnough() {
	const [major, minor] = process.versions.node.split(".").map(Number);
	return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

function hookGroup(matcher, script) {
	const group = { hooks: [{ type: "command", command: `"${process.execPath}" --no-warnings "${join(HOOKS_DIR, script)}" || exit 2` }] };
	return matcher ? { matcher, ...group } : group;
}

function guardsCommandMarkdown() {
	const script = `"${process.execPath}" --no-warnings "${join(ROOT, "scripts", "guards.ts")}" $ARGUMENTS`;
	return [
		"---",
		"description: Turn the agent guards (require-skills, no-comments) on or off",
		"argument-hint: on | off",
		"allowed-tools: Bash",
		"---",
		`!\`${script}\``,
		"",
		"Repeat the line above to the user, word for word, and do nothing else.",
		"",
	].join("\n");
}

const pointsAtThisRepo = (group) => (group.hooks ?? []).some((hook) => String(hook.command ?? "").includes(HOOKS_DIR + sep));

if (!existsSync(CLAUDE_DIR)) {
	console.log(`skip (Claude Code not installed): ${CLAUDE_DIR} does not exist`);
	process.exit(0);
}
if (!nodeIsNewEnough()) {
	console.error(`Claude hooks need Node >= ${MIN_NODE.join(".")} to run TypeScript; found ${process.versions.node}.`);
	process.exit(1);
}

const settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, "utf8")) : {};
if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.bak`);
settings.hooks ??= {};
for (const [event, entries] of Object.entries(HOOK_REGISTRATIONS)) {
	const kept = (settings.hooks[event] ?? []).filter((group) => !pointsAtThisRepo(group));
	settings.hooks[event] = [...kept, ...entries.map(([matcher, script]) => hookGroup(matcher, script))];
}
writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`registered ${HOOKS_DIR} hooks in ${SETTINGS}`);
mkdirSync(dirname(GUARDS_COMMAND_PATH), { recursive: true });
writeFileSync(GUARDS_COMMAND_PATH, guardsCommandMarkdown());
console.log(`installed /guards command at ${GUARDS_COMMAND_PATH}`);
