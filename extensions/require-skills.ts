/**
 * pi extension: every change must go through the required skills.
 *
 * - tool_call (bash): blocks `git commit` until the skills have run.
 * - agent_before_settle: stops pi from finishing with unreviewed changes
 *   (sends one nudge per user prompt, so it can't loop).
 *
 * Scope: only what happened since the last successful `git commit` on the
 * current session branch counts. Skill runs before that commit are ignored.
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUIRED = ["codebase-design", "grill-me", "improve-codebase-architecture", "code-review"];
const REVIEW = "code-review";

const EDIT_TOOLS = new Set(["edit", "write"]);
// `git` must be the command itself (start of line or after ; & | && ||), not text inside a string.
const COMMIT_RE = /(?:^|[;&|\n(]\s*)git(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/;
const SKILL_BLOCK_RE = /^<skill name="([^"]+)"/;
const SKILL_FILE_RE = /([^/\\]+)[/\\]SKILL\.md$/;

type Ev = { kind: "edit" | "skill" | "commit"; name?: string };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: any) => (b?.type === "text" ? b.text ?? "" : "")).join("\n");
}

function readEvents(entries: any[]): Ev[] {
	const events: Ev[] = [];
	const commitIds = new Set<string>();
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const msg = entry.message ?? {};
		if (msg.role === "user") {
			const m = textOf(msg.content).match(SKILL_BLOCK_RE);
			if (m) events.push({ kind: "skill", name: m[1] });
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if (b?.type !== "toolCall") continue;
				const args = b.arguments ?? {};
				if (EDIT_TOOLS.has(b.name)) events.push({ kind: "edit" });
				else if (b.name === "read") {
					const m = String(args.path ?? "").match(SKILL_FILE_RE);
					if (m) events.push({ kind: "skill", name: m[1] });
				} else if (b.name === "bash" && COMMIT_RE.test(String(args.command ?? ""))) {
					commitIds.add(b.id);
				}
			}
		} else if (msg.role === "toolResult" && commitIds.has(msg.toolCallId) && !msg.isError) {
			events.push({ kind: "commit" });
		}
	}
	return events;
}

function missingSkills(events: Ev[]): string[] {
	let lastCommit = -1;
	events.forEach((e, i) => e.kind === "commit" && (lastCommit = i));
	const since = events.slice(lastCommit + 1);
	let lastEdit = -1;
	since.forEach((e, i) => e.kind === "edit" && (lastEdit = i));
	if (lastEdit < 0) return [];
	const ran = new Set(since.filter((e) => e.kind === "skill").map((e) => e.name));
	const missing = REQUIRED.filter((s) => !ran.has(s));
	const reviewedAfterEdit = since.slice(lastEdit + 1).some((e) => e.kind === "skill" && e.name === REVIEW);
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

export default function (pi: ExtensionAPI) {
	let nudged = false;
	pi.on("input", async () => {
		nudged = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		if (!COMMIT_RE.test(String((event.input as any)?.command ?? ""))) return;
		const missing = missingSkills(readEvents(ctx.sessionManager.getBranch()));
		if (missing.length) return { block: true, reason: message(missing) };
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (nudged) return;
		const missing = missingSkills(readEvents(ctx.sessionManager.getBranch()));
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
