/**
 * pi extension: block new code comments on edit/write.
 *
 * Only comments the edit ADDS are blocked; existing ones stay (ratchet).
 * Tool directives (eslint-disable, noqa, @ts-expect-error, ...) are allowed.
 * Handles the built-in edit ({path, edits[]}), agent-stuff's unified-edit ({text}), and write.
 * Mirror of ../hooks/no-comments.py (Claude Code). Keep both in sync.
 */
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Kind = "slash" | "hash" | "dash";

const HASH = new Set(["py", "pyi", "sh", "bash", "zsh", "fish", "rb", "yaml", "yml", "toml", "r", "pl", "ps1", "tf", "nix", "mk"]);
const SLASH = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "java", "kt", "kts", "go", "rs", "c", "h", "cc",
	"cpp", "hpp", "cs", "swift", "scala", "dart", "php", "groovy", "proto", "css", "scss", "less"]);
const DASH = new Set(["sql", "lua", "hs"]);
const HASH_NAMES = new Set(["makefile", "dockerfile", "justfile", "gemfile", "rakefile"]);

const ALLOWED = new RegExp(
	"^#!|eslint-|@ts-|prettier-ignore|biome-ignore|oxlint-|noqa|type:\\s*ignore|pyright:|mypy:|pylint:|" +
		"pragma|istanbul ignore|[cv]8 ignore|nolint|//go:|\\+build|#?\\s*(end)?region\\b|shellcheck|spdx-license|" +
		"@license|fmt:\\s*(off|on|skip)|isort:|-\\*-.*-\\*-|/// <reference|@jsx|@vitest-environment|" +
		"webpackChunkName|nosec|nosonar|swiftlint|ktlint|rubocop:|frozen_string_literal|coding[:=]",
	"i",
);
const NOISE = new Set(["*", "*/", "/*", "/**"]);

function style(path: string): Kind | undefined {
	const name = basename(path).toLowerCase();
	const ext = name.includes(".") ? name.split(".").pop()! : "";
	if (SLASH.has(ext)) return "slash";
	if (HASH.has(ext) || HASH_NAMES.has(name)) return "hash";
	if (DASH.has(ext)) return "dash";
}

const outsideQuotes = (code: string) => ["'", '"', "`"].every((q) => code.split(q).length % 2 === 1);

function commentOf(line: string, kind: Kind): string | undefined {
	const s = line.trim();
	const [starts, inline] =
		kind === "slash" ? [["//", "/*", "*"], /\s(\/\/|\/\*)/] : kind === "hash" ? [["#"], /\s#\s/] : [["--"], /\s--\s/];
	if (starts.some((p) => s.startsWith(p))) return s;
	const m = inline.exec(line);
	if (m && outsideQuotes(line.slice(0, m.index))) return line.slice(m.index).trim();
}

function comments(text: string, kind: Kind): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of (text ?? "").split("\n")) {
		const c = commentOf(line, kind);
		if (c && !NOISE.has(c) && !ALLOWED.test(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	return counts;
}

function addedComments(path: string, oldText: string, newText: string): string[] {
	const kind = style(path);
	if (!kind) return [];
	const before = comments(oldText, kind);
	const added: string[] = [];
	for (const [c, n] of comments(newText, kind)) {
		for (let i = before.get(c) ?? 0; i < n; i++) added.push(c);
	}
	return added;
}

function readSafe(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function unifiedEditFiles(text: string): Map<string, { old: string[]; add: string[] }> {
	const files = new Map<string, { old: string[]; add: string[] }>();
	let cur: { old: string[]; add: string[] } | undefined;
	for (const line of text.split("\n")) {
		const header = line.match(/^\[(.+)\]$/) ?? line.match(/^\*\*\* (?:Add|Update) File: (.+)$/);
		if (header) {
			const path = header[1].trim();
			cur = files.get(path) ?? { old: [], add: [] };
			files.set(path, cur);
		} else if (cur && line.startsWith("+")) cur.add.push(line.slice(1));
		else if (cur && line.startsWith("-")) cur.old.push(line.slice(1));
	}
	return files;
}

function findAdded(toolName: string, input: any, cwd: string): { path: string; added: string[] }[] {
	const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
	if (toolName === "write") {
		return [{ path: input.path, added: addedComments(input.path, readSafe(abs(input.path)), input.content) }];
	}
	if (toolName !== "edit") return [];
	if (typeof input.text === "string") {
		return [...unifiedEditFiles(input.text)].map(([path, f]) => ({
			path,
			added: addedComments(path, f.old.join("\n"), f.add.join("\n")),
		}));
	}
	const edits: any[] = input.edits ?? (input.oldText !== undefined ? [input] : []);
	return [{
		path: input.path,
		added: addedComments(input.path, edits.map((e) => e.oldText ?? "").join("\n"), edits.map((e) => e.newText ?? "").join("\n")),
	}];
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const hits = findAdded(event.toolName, event.input, ctx.cwd).filter((h) => h.added.length);
		if (!hits.length) return;
		const total = hits.reduce((n, h) => n + h.added.length, 0);
		const shown = hits.flatMap((h) => h.added.map((c) => `  ${basename(h.path)}: ${c.slice(0, 100)}`)).slice(0, 5);
		return {
			block: true,
			reason:
				`No new code comments (${total} added):\n${shown.join("\n")}\n` +
				"Remove them and retry. Make the code say it instead (names, types, small functions). " +
				"A non-obvious decision goes in an ADR under docs/adr/. " +
				"Tool directives (eslint-disable, noqa, @ts-expect-error) are allowed.",
		};
	});
}
