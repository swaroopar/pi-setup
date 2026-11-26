import type { Workspace } from "./workspace.ts";

const REQUIRED_SKILLS = [
	"codebase-design",
	"grill-me",
	"improve-codebase-architecture",
	"naming-analyzer",
	"code-review",
];
const REVIEW_SKILL = "code-review";
const GRILL_SKILL = "grill-me";
const INTERACTIVE_SKILLS = new Set([...REQUIRED_SKILLS, "grilling"]);

export type SessionEvent =
	| { at: number; kind: "prompt" }
	| { at: number; kind: "edit" }
	| { at: number; kind: "skill"; name: string };

export type ToolAction =
	| { kind: "shell"; command: string }
	| { kind: "file-edit"; paths: string[] }
	| { kind: "other" };

export type SessionInputs = {
	events: () => SessionEvent[];
	workspace: Workspace;
};

const COMMAND_START = String.raw`(?:^|[;&|\n(]\s*)(?:rtk\s+(?:proxy\s+)?)?(?:sudo\s+)?`;
const COMMIT_RE = new RegExp(COMMAND_START + String.raw`git(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b`);
const WRITE_COMMAND_RE = new RegExp(
	COMMAND_START +
		String.raw`(?:sed\s+(?:[^\s;&|]+\s+)*?-\w*i|perl\s+-\w*i|tee\b|mv\b|cp\b|rm\b|touch\b|mkdir\b|ln\b|truncate\b|patch\b|` +
		String.raw`git\s+(?:apply|checkout|restore|reset|stash|mv|rm|am|cherry-pick|merge|rebase|pull)\b)`,
);
const PYTHON_RE = new RegExp(COMMAND_START + String.raw`(?:uv\s+run\s+)?(?:\S*\/)?python3?(?:\.\d+)?\b`);
const PYTHON_WRITE_RE =
	/open\(.*?,\s*(?:mode\s*=\s*)?['"](?:[wax]|r\+)[bt+]*['"]|\.write_text\(|\.write_bytes\(|os\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir)\(|\.unlink\(|shutil\./;
const HEREDOC_RE = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1(?=\n|$)/g;
const QUOTED_RE = /'[^']*'|"[^"]*"/g;
const REDIRECT_RE = /(?<![0-9&>])>>?\s*(?!&|\/dev\/)([^\s;&|)]+)/g;
const SCRATCH_PREFIXES = ["/tmp", "/private/tmp", "/var/folders"];

export const GRILL_FIRST_MESSAGE =
	"No changes before grilling. Run the grill-me skill first and wait for the user's answers " +
	"before changing any file in this repository.";

export function isCommitCommand(command: string): boolean {
	return COMMIT_RE.test(command);
}

export function writesFiles(command: string): boolean {
	if (PYTHON_RE.test(command) && PYTHON_WRITE_RE.test(command)) return true;
	const bare = command.replace(HEREDOC_RE, "").replace(QUOTED_RE, "''");
	if (WRITE_COMMAND_RE.test(bare)) return true;
	return [...bare.matchAll(REDIRECT_RE)].some((m) => !SCRATCH_PREFIXES.some((prefix) => m[1].startsWith(prefix)));
}

function eventsSince(events: SessionEvent[], since: number): SessionEvent[] {
	return events.filter((event) => event.at > since);
}

function missingSkills(events: SessionEvent[], newestChange = 0): string[] {
	const lastEdit = Math.max(newestChange, ...events.filter((e) => e.kind === "edit").map((e) => e.at));
	if (!lastEdit) return [];
	const skillRuns = events.filter((e) => e.kind === "skill");
	const ran = new Set(skillRuns.map((e) => e.name));
	const missing = REQUIRED_SKILLS.filter((skill) => !ran.has(skill));
	const reviewedAfterEdit = skillRuns.some((e) => e.name === REVIEW_SKILL && e.at >= lastEdit);
	if (ran.has(REVIEW_SKILL) && !reviewedAfterEdit) {
		missing.push(`${REVIEW_SKILL} (again: files changed after the last review)`);
	}
	return missing;
}

function grillAnswered(events: SessionEvent[]): boolean {
	const firstGrill = events.findIndex((e) => e.kind === "skill" && e.name === GRILL_SKILL);
	return firstGrill >= 0 && events.slice(firstGrill + 1).some((e) => e.kind === "prompt");
}

function interactiveSkillRanThisTurn(events: SessionEvent[]): boolean {
	const lastPrompt = events.map((e) => e.kind).lastIndexOf("prompt");
	return events.slice(lastPrompt + 1).some((e) => e.kind === "skill" && INTERACTIVE_SKILLS.has(e.name));
}

function missingSkillsMessage(missing: string[]): string {
	return (
		`Changes are not done. Run these skills first, in this order: ${missing.join(", ")}. ` +
		`Required order: ${REQUIRED_SKILLS.join(" -> ")}. ` +
		"If you can't invoke a skill yourself, ask the user to run /<skill> (pi: /skill:<skill>)."
	);
}

function changesWorkspace(action: ToolAction, workspace: Workspace): boolean {
	if (action.kind === "shell") return writesFiles(action.command);
	if (action.kind === "file-edit") return action.paths.some((path) => path && workspace.contains(path));
	return false;
}

export function blockReasonForToolUse(action: ToolAction, { events, workspace }: SessionInputs): string | undefined {
	if (action.kind === "shell" && isCommitCommand(action.command)) {
		const since = workspace.windowStart();
		const missing = missingSkills(eventsSince(events(), since), workspace.newestChangeTime(since));
		return missing.length ? missingSkillsMessage(missing) : undefined;
	}
	if (changesWorkspace(action, workspace) && !grillAnswered(eventsSince(events(), workspace.windowStart()))) {
		return GRILL_FIRST_MESSAGE;
	}
	return undefined;
}

export function blockReasonForStop({ events, workspace }: SessionInputs): string | undefined {
	const since = workspace.windowStart();
	const recent = eventsSince(events(), since);
	if (interactiveSkillRanThisTurn(recent)) return undefined;
	const missing = missingSkills(recent, workspace.newestChangeTime(since));
	return missing.length ? missingSkillsMessage(missing) : undefined;
}
