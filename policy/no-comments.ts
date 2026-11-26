import { basename } from "node:path";

type CommentStyle = "slash" | "hash" | "dash";

export type FileChange = { path: string; before: string; after: string };
type CommentHit = { path: string; added: string[] };

const HASH_EXTENSIONS = new Set(["py", "pyi", "sh", "bash", "zsh", "fish", "rb", "yaml", "yml", "toml", "r", "pl", "ps1", "tf", "nix", "mk"]);
const SLASH_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "java", "kt", "kts", "go", "rs", "c", "h", "cc",
	"cpp", "hpp", "cs", "swift", "scala", "dart", "php", "groovy", "proto", "css", "scss", "less"]);
const DASH_EXTENSIONS = new Set(["sql", "lua", "hs"]);
const HASH_FILENAMES = new Set(["makefile", "dockerfile", "justfile", "gemfile", "rakefile"]);

const TOOL_DIRECTIVE_RE = new RegExp(
	"^#!|eslint-|@ts-|prettier-ignore|biome-ignore|oxlint-|noqa|type:\\s*ignore|pyright:|mypy:|pylint:|" +
		"pragma|istanbul ignore|[cv]8 ignore|nolint|//go:|\\+build|#?\\s*(end)?region\\b|shellcheck|spdx-license|" +
		"@license|fmt:\\s*(off|on|skip)|isort:|-\\*-.*-\\*-|/// <reference|@jsx|@vitest-environment|" +
		"webpackChunkName|nosec|nosonar|swiftlint|ktlint|rubocop:|frozen_string_literal|coding[:=]",
	"i",
);
const BARE_BLOCK_MARKERS = new Set(["*", "*/", "/*", "/**"]);
const STAR_LINE_RE = /^\*(\s|\/|$)/;
const DOCSTRING_OPEN_RE = /^[rRuUbB]{0,2}("""|''')/;
const PYTHON_FILE_RE = /\.pyi?$/;
const LINE_BREAK_RE = /\r\n|\r|\n/;

function commentStyle(path: string): CommentStyle | undefined {
	const name = basename(path).toLowerCase();
	const extension = name.includes(".") ? name.split(".").pop()! : "";
	if (SLASH_EXTENSIONS.has(extension)) return "slash";
	if (HASH_EXTENSIONS.has(extension) || HASH_FILENAMES.has(name)) return "hash";
	if (DASH_EXTENSIONS.has(extension)) return "dash";
	return undefined;
}

const isOutsideQuotes = (code: string) => ["'", '"', "`"].every((quote) => code.split(quote).length % 2 === 1);

function commentOf(line: string, style: CommentStyle): string | undefined {
	const trimmed = line.trim();
	const [lineStarts, inlineRe] =
		style === "slash" ? [["//", "/*"], /\s(\/\/|\/\*)/] : style === "hash" ? [["#"], /\s#\s/] : [["--"], /\s--\s/];
	if (lineStarts.some((start) => trimmed.startsWith(start)) || (style === "slash" && STAR_LINE_RE.test(trimmed))) {
		return trimmed;
	}
	const inline = inlineRe.exec(line);
	if (inline && isOutsideQuotes(line.slice(0, inline.index))) return line.slice(inline.index).trim();
	return undefined;
}

function countComments(text: string, style: CommentStyle): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of text.split(LINE_BREAK_RE)) {
		const comment = commentOf(line, style);
		if (comment && !BARE_BLOCK_MARKERS.has(comment) && !TOOL_DIRECTIVE_RE.test(comment)) {
			counts.set(comment, (counts.get(comment) ?? 0) + 1);
		}
	}
	return counts;
}

function countDocstrings(text: string): Map<string, number> {
	const lines = text.split(LINE_BREAK_RE);
	const counts = new Map<string, number>();
	for (let i = 0; i < lines.length; ) {
		const trimmed = lines[i++].trim();
		const opening = DOCSTRING_OPEN_RE.exec(trimmed);
		if (!opening) {
			const openString = ['"""', "'''"].find((quote) => trimmed.split(quote).length % 2 === 0);
			while (openString && i < lines.length) {
				if (lines[i++].includes(openString)) break;
			}
			continue;
		}
		const body = [trimmed];
		if (!trimmed.slice(opening[0].length).includes(opening[1])) {
			while (i < lines.length) {
				body.push(lines[i++].trim());
				if (body[body.length - 1].includes(opening[1])) break;
			}
		}
		const docstring = body.join(" ");
		counts.set(docstring, (counts.get(docstring) ?? 0) + 1);
	}
	return counts;
}

function newEntries(before: Map<string, number>, after: Map<string, number>): string[] {
	const added: string[] = [];
	for (const [text, count] of after) {
		for (let i = before.get(text) ?? 0; i < count; i++) added.push(text);
	}
	return added;
}

function addedComments({ path, before, after }: FileChange): string[] {
	const style = commentStyle(path);
	if (!style) return [];
	const added = newEntries(countComments(before, style), countComments(after, style));
	if (PYTHON_FILE_RE.test(path)) added.push(...newEntries(countDocstrings(before), countDocstrings(after)));
	return added;
}

export function blockReasonForFileChanges(changes: FileChange[]): string | undefined {
	const hits: CommentHit[] = changes
		.map((change) => ({ path: change.path, added: addedComments(change) }))
		.filter((hit) => hit.added.length);
	if (!hits.length) return undefined;
	const total = hits.reduce((sum, hit) => sum + hit.added.length, 0);
	const shown = hits.flatMap((hit) => hit.added.map((text) => `  ${basename(hit.path)}: ${text.slice(0, 100)}`)).slice(0, 5);
	return (
		`No new code comments (${total} added):\n${shown.join("\n")}\n` +
		"Remove them and retry. Make the code say it instead (names, types, small functions). " +
		"A non-obvious decision goes in an ADR under docs/adr/. " +
		"Tool directives (eslint-disable, noqa, @ts-expect-error) are allowed."
	);
}
