import { shellEffects } from "./shell.ts";
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

export type EditedPaths = string[] | "unknown";

export type SessionEvent =
	| { at: number; kind: "prompt" }
	| { at: number; kind: "edit"; paths: EditedPaths }
	| { at: number; kind: "skill"; name: string };

export type ToolAction =
	| { kind: "shell"; command: string; cwd: string }
	| { kind: "file-edit"; paths: EditedPaths }
	| { kind: "other" };

export type SessionInputs = {
	events: () => SessionEvent[];
	workspace: Workspace;
};

export const GRILL_FIRST_MESSAGE =
	"No changes before grilling. Run the grill-me skill first and wait for the user's answers " +
	"before changing any file in this repository.";

const WORKFLOW_NAME_RE = /\bmeta\s*(?::\s*\w+\s*)?=\s*(?=\{)[\s\S]*?[{,]\s*name\s*:\s*(['"`])((?:(?!\1)[^\n])+)\1/;
const normalizedLabel = (label: string) => label.trim().toLowerCase().replace(/[\s_-]+/g, "-");

export function delegatedSkill(input: { script?: unknown; description?: unknown }): string | undefined {
	const workflowName = typeof input?.script === "string" ? input.script.match(WORKFLOW_NAME_RE)?.[2] : undefined;
	const label = workflowName ?? (typeof input?.description === "string" ? input.description : "");
	const normalized = normalizedLabel(label);
	return REQUIRED_SKILLS.find((skill) => normalized === skill || normalized.startsWith(`${skill}-`));
}

function mayTouchWorkspace(paths: EditedPaths, workspace: Workspace): boolean {
	return paths === "unknown" || paths.some((path) => workspace.contains(path));
}

function relevantEventsSince(events: SessionEvent[], since: number, workspace: Workspace): SessionEvent[] {
	return events.filter((event) => event.at > since && (event.kind !== "edit" || mayTouchWorkspace(event.paths, workspace)));
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

function commitGateReason({ events, workspace }: SessionInputs): string | undefined {
	const since = workspace.windowStart();
	const missing = missingSkills(relevantEventsSince(events(), since, workspace), workspace.newestChangeTime(since));
	return missing.length ? missingSkillsMessage(missing) : undefined;
}

function grillGateReason({ events, workspace }: SessionInputs): string | undefined {
	return grillAnswered(relevantEventsSince(events(), workspace.windowStart(), workspace)) ? undefined : GRILL_FIRST_MESSAGE;
}

export function blockReasonForToolUse(action: ToolAction, inputs: SessionInputs): string | undefined {
	const { workspace } = inputs;
	if (action.kind === "shell") {
		const { commitDirs, writeTargets } = shellEffects(action.command, action.cwd);
		const commitReason = commitDirs.some((dir) => workspace.contains(dir)) ? commitGateReason(inputs) : undefined;
		return commitReason ?? (mayTouchWorkspace(writeTargets, workspace) ? grillGateReason(inputs) : undefined);
	}
	if (action.kind === "file-edit" && mayTouchWorkspace(action.paths, workspace)) return grillGateReason(inputs);
	return undefined;
}

export function blockReasonForStop({ events, workspace }: SessionInputs): string | undefined {
	const since = workspace.windowStart();
	const recent = relevantEventsSince(events(), since, workspace);
	if (interactiveSkillRanThisTurn(recent)) return undefined;
	const missing = missingSkills(recent, workspace.newestChangeTime(since));
	return missing.length ? missingSkillsMessage(missing) : undefined;
}
