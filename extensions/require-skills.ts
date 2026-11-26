import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUIRED = ["codebase-design", "grill-me", "improve-codebase-architecture", "naming-analyzer", "code-review"];
const REVIEW = "code-review";
const GRILL = "grill-me";

const EDIT_TOOLS = new Set(["edit", "write"]);
const CMD_START = String.raw`(?:^|[;&|\n(]\s*)(?:rtk\s+(?:proxy\s+)?)?(?:sudo\s+)?`;
const COMMIT_RE = new RegExp(CMD_START + String.raw`git(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b`);
const WRITE_CMD_RE = new RegExp(
	CMD_START +
		String.raw`(?:sed\s+(?:[^\s;&|]+\s+)*?-\w*i|perl\s+-\w*i|tee\b|mv\b|cp\b|rm\b|touch\b|mkdir\b|ln\b|truncate\b|patch\b|` +
		String.raw`git\s+(?:apply|checkout|restore|reset|stash|mv|rm|am|cherry-pick|merge|rebase|pull)\b)`,
);
const HEREDOC_RE = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1(?=\n|$)/g;
const QUOTED_RE = /'[^']*'|"[^"]*"/g;
const REDIRECT_RE = /(?<![0-9&>])>>?\s*(?!&|\/dev\/)([^\s;&|)]+)/g;
const SCRATCH_PREFIXES = ["/tmp", "/private/tmp", "/var/folders"];
const SKILL_BLOCK_RE = /^<skill name="([^"]+)"/;
const SKILL_FILE_RE = /([^/\\]+)[/\\]SKILL\.md$/;

type Ev = { at: number; kind: "edit" | "skill" | "prompt"; name?: string };

function git(cwd: string, ...args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
	} catch {
		return undefined;
	}
}

function lastCommitTime(cwd: string): number {
	return (Number(git(cwd, "log", "-1", "--format=%ct")?.trim()) || 0) * 1000;
}

function workspaceRoot(cwd: string): string {
	return git(cwd, "rev-parse", "--show-toplevel")?.trim() || cwd;
}

function newestUncommittedChange(cwd: string): number {
	const root = git(cwd, "rev-parse", "--show-toplevel")?.trim();
	const status = git(cwd, "status", "--porcelain", "-z", "--untracked-files=all");
	if (!root || status === undefined) return 0;
	let newest = 0;
	for (const record of status.split("\0")) {
		const path = join(root, record.slice(3));
		if (record.length > 3 && existsSync(path) && statSync(path).isFile()) {
			newest = Math.max(newest, statSync(path).mtimeMs);
		}
	}
	return newest;
}

function realish(path: string): string {
	let dir = path;
	while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
	return join(realpathSync(dir), path.slice(dir.length));
}

function insideWorkspace(path: string, cwd: string): boolean {
	const root = realish(workspaceRoot(cwd));
	const target = realish(isAbsolute(path) ? path : resolve(cwd, path));
	return target === root || target.startsWith(root + sep);
}

function bashWrites(command: string): boolean {
	const bare = command.replace(HEREDOC_RE, "").replace(QUOTED_RE, "''");
	if (WRITE_CMD_RE.test(bare)) return true;
	return [...bare.matchAll(REDIRECT_RE)].some((m) => !SCRATCH_PREFIXES.some((p) => m[1].startsWith(p)));
}

function editedPaths(toolName: string, input: any): string[] {
	if (toolName === "write") return [String(input?.path ?? "")];
	if (toolName !== "edit") return [];
	if (typeof input?.text === "string") {
		return [...input.text.matchAll(/^(?:\[(.+)\]|\*\*\* (?:Add|Update|Delete) File: (.+))$/gm)].map((m) => (m[1] ?? m[2]).trim());
	}
	return [String(input?.path ?? "")];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: any) => (b?.type === "text" ? b.text ?? "" : "")).join("\n");
}

function readEvents(entries: any[], since: number): Ev[] {
	const events: Ev[] = [];
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const at = Date.parse(entry.timestamp) || 0;
		if (at <= since) continue;
		const msg = entry.message ?? {};
		if (msg.role === "user") {
			events.push({ at, kind: "prompt" });
			const m = textOf(msg.content).match(SKILL_BLOCK_RE);
			if (m) events.push({ at, kind: "skill", name: m[1] });
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if (b?.type !== "toolCall") continue;
				if (EDIT_TOOLS.has(b.name)) events.push({ at, kind: "edit" });
				else if (b.name === "read") {
					const m = String(b.arguments?.path ?? "").match(SKILL_FILE_RE);
					if (m) events.push({ at, kind: "skill", name: m[1] });
				}
			}
		}
	}
	return events;
}

function missingSkills(events: Ev[], lastFileChange = 0): string[] {
	const lastEdit = Math.max(lastFileChange, ...events.filter((e) => e.kind === "edit").map((e) => e.at));
	if (!lastEdit) return [];
	const skillRuns = events.filter((e) => e.kind === "skill");
	const ran = new Set(skillRuns.map((e) => e.name));
	const missing = REQUIRED.filter((s) => !ran.has(s));
	const reviewedAfterEdit = skillRuns.some((e) => e.name === REVIEW && e.at >= lastEdit);
	if (ran.has(REVIEW) && !reviewedAfterEdit) missing.push(`${REVIEW} (again: files changed after the last review)`);
	return missing;
}

function grillAnswered(events: Ev[]): boolean {
	const firstGrill = events.findIndex((e) => e.kind === "skill" && e.name === GRILL);
	return firstGrill >= 0 && events.slice(firstGrill + 1).some((e) => e.kind === "prompt");
}

function skillRanThisTurn(events: Ev[]): boolean {
	const lastPrompt = events.map((e) => e.kind).lastIndexOf("prompt");
	return events.slice(lastPrompt + 1).some((e) => e.kind === "skill");
}

function message(missing: string[]): string {
	return (
		`Changes are not done. Run these skills first, in this order: ${missing.join(", ")}. ` +
		`Required order: ${REQUIRED.join(" -> ")}. ` +
		"If you can't load a skill yourself, ask the user to run /skill:<name>."
	);
}

const GRILL_FIRST =
	"No changes before grilling. Run the grill-me skill first and wait for the user's answers " +
	"before changing any file in this repository.";

type Ctx = { cwd: string; sessionManager: { getBranch(): any[] } };

function sessionEvents(ctx: Ctx): Ev[] {
	return readEvents(ctx.sessionManager.getBranch(), lastCommitTime(ctx.cwd));
}

function changesWorkspace(toolName: string, input: any, cwd: string): boolean {
	if (toolName === "bash") return bashWrites(String(input?.command ?? ""));
	return editedPaths(toolName, input).some((p) => p && insideWorkspace(p, cwd));
}

export default function (pi: ExtensionAPI) {
	let nudged = false;
	pi.on("input", async () => {
		nudged = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as any;
		if (event.toolName === "bash" && COMMIT_RE.test(String(input?.command ?? ""))) {
			const missing = missingSkills(sessionEvents(ctx), newestUncommittedChange(ctx.cwd));
			if (missing.length) return { block: true, reason: message(missing) };
			return;
		}
		if (changesWorkspace(event.toolName, input, ctx.cwd) && !grillAnswered(sessionEvents(ctx))) {
			return { block: true, reason: GRILL_FIRST };
		}
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (nudged) return;
		const events = sessionEvents(ctx);
		if (skillRanThisTurn(events)) return;
		const missing = missingSkills(events, newestUncommittedChange(ctx.cwd));
		if (!missing.length) return;
		nudged = true;
		return {
			entries: [
				...event.entries,
				{ type: "custom_message", customType: "require-skills", content: message(missing), display: true },
			],
			continue: true,
		};
	});
}
