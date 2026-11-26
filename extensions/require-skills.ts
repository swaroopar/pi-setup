import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUIRED = ["codebase-design", "grill-me", "improve-codebase-architecture", "naming-analyzer", "code-review"];
const REVIEW = "code-review";
const GRILL = "grill-me";
const INTERACTIVE_SKILLS = new Set([...REQUIRED, "grilling"]);
const DEFAULT_BRANCH_REFS = ["origin/HEAD", "origin/main", "origin/master"];

const EDIT_TOOLS = new Set(["edit", "write"]);
const CMD_START = String.raw`(?:^|[;&|\n(]\s*)(?:rtk\s+(?:proxy\s+)?)?(?:sudo\s+)?`;
const COMMIT_RE = new RegExp(CMD_START + String.raw`git(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b`);
const WRITE_CMD_RE = new RegExp(
	CMD_START +
		String.raw`(?:sed\s+(?:[^\s;&|]+\s+)*?-\w*i|perl\s+-\w*i|tee\b|mv\b|cp\b|rm\b|touch\b|mkdir\b|ln\b|truncate\b|patch\b|` +
		String.raw`git\s+(?:apply|checkout|restore|reset|stash|mv|rm|am|cherry-pick|merge|rebase|pull)\b)`,
);
const PYTHON_RE = new RegExp(CMD_START + String.raw`(?:uv\s+run\s+)?(?:\S*/)?python3?(?:\.\d+)?\b`);
const PYTHON_WRITE_RE =
	/open\(.*?,\s*(?:mode\s*=\s*)?['"](?:[wax]|r\+)[bt+]*['"]|\.write_text\(|\.write_bytes\(|os\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir)\(|\.unlink\(|shutil\./;
const HEREDOC_RE = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1(?=\n|$)/g;
const QUOTED_RE = /'[^']*'|"[^"]*"/g;
const REDIRECT_RE = /(?<![0-9&>])>>?\s*(?!&|\/dev\/)([^\s;&|)]+)/g;
const SCRATCH_PREFIXES = ["/tmp", "/private/tmp", "/var/folders"];
const SKILL_BLOCK_RE = /^<skill name="([^"]+)"/;
const SKILL_FILE_RE = /([^/\\]+)[/\\]SKILL\.md$/;

type SessionEvent = { at: number; kind: "edit" | "skill" | "prompt"; name?: string };

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

function commitTime(cwd: string, rev: string): number {
	return (Number(git(cwd, "show", "-s", "--format=%ct", rev)?.trim()) || 0) * 1000;
}

function windowStart(cwd: string): number {
	for (const ref of DEFAULT_BRANCH_REFS) {
		const base = git(cwd, "merge-base", "HEAD", ref)?.trim();
		if (base) return commitTime(cwd, base);
	}
	return commitTime(cwd, "HEAD");
}

function workspaceRoot(cwd: string): string {
	return git(cwd, "rev-parse", "--show-toplevel")?.trim() || cwd;
}

function changedFiles(status: string): { code: string; path: string }[] {
	const records = status.split("\0");
	const files: { code: string; path: string }[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.length < 4) continue;
		const code = record.slice(0, 2);
		files.push({ code, path: record.slice(3) });
		if ("RC".includes(code[0])) i++;
	}
	return files;
}

function newestChangeTime(cwd: string, since: number): number {
	const root = git(cwd, "rev-parse", "--show-toplevel")?.trim();
	const status = git(cwd, "status", "--porcelain", "-z", "--untracked-files=all");
	if (!root || status === undefined) return 0;
	let newest = 0;
	for (const { code, path: rel } of changedFiles(status)) {
		const path = join(root, rel);
		if (!existsSync(path) || !statSync(path).isFile()) continue;
		const mtime = statSync(path).mtimeMs;
		if (code === "??" && mtime <= since) continue;
		newest = Math.max(newest, mtime);
	}
	return newest;
}

function realPathOfNearestExisting(path: string): string {
	let dir = path;
	while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
	return join(realpathSync(dir), path.slice(dir.length));
}

function insideWorkspace(path: string, cwd: string): boolean {
	const root = realPathOfNearestExisting(workspaceRoot(cwd));
	const target = realPathOfNearestExisting(isAbsolute(path) ? path : resolve(cwd, path));
	return target === root || target.startsWith(root + sep);
}

function writesFiles(command: string): boolean {
	if (PYTHON_RE.test(command) && PYTHON_WRITE_RE.test(command)) return true;
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

function failedToolIds(entries: any[]): Set<string> {
	const failed = new Set<string>();
	for (const entry of entries) {
		const msg = entry?.message;
		if (entry?.type === "message" && msg?.role === "toolResult" && msg.isError) failed.add(msg.toolCallId);
	}
	return failed;
}

function readEvents(entries: any[], since: number): SessionEvent[] {
	const failed = failedToolIds(entries);
	const events: SessionEvent[] = [];
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
				else if (b.name === "read" && !failed.has(b.id)) {
					const m = String(b.arguments?.path ?? "").match(SKILL_FILE_RE);
					if (m) events.push({ at, kind: "skill", name: m[1] });
				}
			}
		}
	}
	return events;
}

function missingSkills(events: SessionEvent[], lastFileChange = 0): string[] {
	const lastEdit = Math.max(lastFileChange, ...events.filter((e) => e.kind === "edit").map((e) => e.at));
	if (!lastEdit) return [];
	const skillRuns = events.filter((e) => e.kind === "skill");
	const ran = new Set(skillRuns.map((e) => e.name));
	const missing = REQUIRED.filter((s) => !ran.has(s));
	const reviewedAfterEdit = skillRuns.some((e) => e.name === REVIEW && e.at >= lastEdit);
	if (ran.has(REVIEW) && !reviewedAfterEdit) missing.push(`${REVIEW} (again: files changed after the last review)`);
	return missing;
}

function grillAnswered(events: SessionEvent[]): boolean {
	const firstGrill = events.findIndex((e) => e.kind === "skill" && e.name === GRILL);
	return firstGrill >= 0 && events.slice(firstGrill + 1).some((e) => e.kind === "prompt");
}

function interactiveSkillRanThisTurn(events: SessionEvent[]): boolean {
	const lastPrompt = events.map((e) => e.kind).lastIndexOf("prompt");
	return events.slice(lastPrompt + 1).some((e) => e.kind === "skill" && INTERACTIVE_SKILLS.has(e.name ?? ""));
}

function missingSkillsMessage(missing: string[]): string {
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

function sessionEvents(ctx: Ctx, since: number): SessionEvent[] {
	return readEvents(ctx.sessionManager.getBranch(), since);
}

function changesWorkspace(toolName: string, input: any, cwd: string): boolean {
	if (toolName === "bash") return writesFiles(String(input?.command ?? ""));
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
			const since = windowStart(ctx.cwd);
			const missing = missingSkills(sessionEvents(ctx, since), newestChangeTime(ctx.cwd, since));
			if (missing.length) return { block: true, reason: missingSkillsMessage(missing) };
			return;
		}
		if (changesWorkspace(event.toolName, input, ctx.cwd) && !grillAnswered(sessionEvents(ctx, windowStart(ctx.cwd)))) {
			return { block: true, reason: GRILL_FIRST };
		}
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (nudged) return;
		const since = windowStart(ctx.cwd);
		const events = sessionEvents(ctx, since);
		if (interactiveSkillRanThisTurn(events)) return;
		const missing = missingSkills(events, newestChangeTime(ctx.cwd, since));
		if (!missing.length) return;
		nudged = true;
		return {
			entries: [
				...event.entries,
				{ type: "custom_message", customType: "require-skills", content: missingSkillsMessage(missing), display: true },
			],
			continue: true,
		};
	});
}
