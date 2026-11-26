import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUIRED = ["codebase-design", "grill-me", "improve-codebase-architecture", "naming-analyzer", "code-review"];
const REVIEW = "code-review";

const EDIT_TOOLS = new Set(["edit", "write"]);
const COMMIT_RE =
	/(?:^|[;&|\n(]\s*)(?:rtk\s+(?:proxy\s+)?)?git(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/;
const SKILL_BLOCK_RE = /^<skill name="([^"]+)"/;
const SKILL_FILE_RE = /([^/\\]+)[/\\]SKILL\.md$/;

type Ev = { at: number; kind: "edit" | "skill"; name?: string };

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

function message(missing: string[]): string {
	return (
		`Changes are not done. Run these skills first, in this order: ${missing.join(", ")}. ` +
		`Required order: ${REQUIRED.join(" -> ")}. ` +
		"If you can't load a skill yourself, ask the user to run /skill:<name>."
	);
}

function check(ctx: { cwd: string; sessionManager: { getBranch(): any[] } }): string[] {
	const events = readEvents(ctx.sessionManager.getBranch(), lastCommitTime(ctx.cwd));
	return missingSkills(events, newestUncommittedChange(ctx.cwd));
}

export default function (pi: ExtensionAPI) {
	let nudged = false;
	pi.on("input", async () => {
		nudged = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		if (!COMMIT_RE.test(String((event.input as any)?.command ?? ""))) return;
		const missing = check(ctx);
		if (missing.length) return { block: true, reason: message(missing) };
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (nudged) return;
		const missing = check(ctx);
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
