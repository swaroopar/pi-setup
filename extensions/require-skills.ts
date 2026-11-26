/**
 * pi extension: every change must go through the required skills.
 *
 * - tool_call (bash): blocks `git commit` until the skills have run.
 * - agent_before_settle: stops pi from finishing with unreviewed changes
 *   (sends one nudge per user prompt, so it can't loop).
 *
 * Scope: only what happened after the latest git commit (HEAD's commit time)
 * counts. Skill runs before that are ignored. Using git, not the session log,
 * means commits made anywhere (agent, `!` prompt, another terminal) reset it.
 *
 * Rules (when files were edited since that commit):
 *   1. Every skill in REQUIRED must have run since that commit.
 *   2. code-review must have run after the last edit.
 *
 * A skill counts if the user typed /skill:<name> (expands to <skill name="...">)
 * or the model read <name>/SKILL.md with the read tool.
 *
 * Mirror of ../hooks/require-skills.py (Claude Code). Keep both in sync.
 */
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUIRED = ["codebase-design", "grill-me", "improve-codebase-architecture", "naming-analyzer", "code-review"];
const REVIEW = "code-review";

const EDIT_TOOLS = new Set(["edit", "write"]);
// `git` must be the command itself (start of line or after ; & | && ||), not text inside a string.
const COMMIT_RE = /(?:^|[;&|\n(]\s*)git(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/;
const SKILL_BLOCK_RE = /^<skill name="([^"]+)"/;
const SKILL_FILE_RE = /([^/\\]+)[/\\]SKILL\.md$/;

type Ev = { kind: "edit" | "skill"; name?: string };

/** Unix ms of HEAD's commit, or 0 when not in a git repo / no commits. */
function lastCommitTime(cwd: string): number {
	try {
		const out = execFileSync("git", ["-C", cwd, "log", "-1", "--format=%ct"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		return (Number(out.trim()) || 0) * 1000;
	} catch {
		return 0;
	}
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
		if ((Date.parse(entry.timestamp) || 0) <= since) continue;
		const msg = entry.message ?? {};
		if (msg.role === "user") {
			const m = textOf(msg.content).match(SKILL_BLOCK_RE);
			if (m) events.push({ kind: "skill", name: m[1] });
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if (b?.type !== "toolCall") continue;
				if (EDIT_TOOLS.has(b.name)) events.push({ kind: "edit" });
				else if (b.name === "read") {
					const m = String(b.arguments?.path ?? "").match(SKILL_FILE_RE);
					if (m) events.push({ kind: "skill", name: m[1] });
				}
			}
		}
	}
	return events;
}

function missingSkills(events: Ev[]): string[] {
	let lastEdit = -1;
	events.forEach((e, i) => e.kind === "edit" && (lastEdit = i));
	if (lastEdit < 0) return [];
	const ran = new Set(events.filter((e) => e.kind === "skill").map((e) => e.name));
	const missing = REQUIRED.filter((s) => !ran.has(s));
	const reviewedAfterEdit = events.slice(lastEdit + 1).some((e) => e.kind === "skill" && e.name === REVIEW);
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
	return missingSkills(readEvents(ctx.sessionManager.getBranch(), lastCommitTime(ctx.cwd)));
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
