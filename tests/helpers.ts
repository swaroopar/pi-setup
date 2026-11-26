import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NOW_SECONDS = Math.floor(Date.now() / 1000);
export const BASE_COMMIT = NOW_SECONDS - 2000;
export const WORK_COMMIT = NOW_SECONDS - 1000;
export const BEFORE_BRANCH = BASE_COMMIT - 100;
export const ON_BRANCH = BASE_COMMIT + 100;
export const AFTER_COMMIT = WORK_COMMIT + 100;

export const isoAt = (seconds: number) => new Date(seconds * 1000).toISOString();

function git(repo: string, args: string[], atSeconds?: number) {
	const dates = atSeconds ? { GIT_COMMITTER_DATE: `${atSeconds} +0000`, GIT_AUTHOR_DATE: `${atSeconds} +0000` } : {};
	execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		env: { ...process.env, ...dates },
		stdio: "ignore",
	});
}

export type RepoOptions = { withOrigin?: boolean; modifiedAt?: number; untracked?: [string, number][] };

export function makeRepo({ withOrigin = true, modifiedAt, untracked = [] }: RepoOptions = {}): string {
	const repo = mkdtempSync(join(tmpdir(), "pi-setup-test-"));
	execFileSync("git", ["init", "-q", repo]);
	writeFileSync(join(repo, "f.py"), "x = 1\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "base"], BASE_COMMIT);
	if (withOrigin) git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	writeFileSync(join(repo, "f.py"), "x = 2\n");
	git(repo, ["commit", "-q", "-am", "work"], WORK_COMMIT);
	if (modifiedAt) {
		writeFileSync(join(repo, "f.py"), "x = 3\n");
		utimesSync(join(repo, "f.py"), modifiedAt, modifiedAt);
	}
	for (const [name, mtime] of untracked) {
		writeFileSync(join(repo, name), "junk\n");
		utimesSync(join(repo, name), mtime, mtime);
	}
	return repo;
}

export function runClaudeHook(script: string, input: object): string {
	const result = spawnSync("node", ["--no-warnings", join(REPO_ROOT, "hooks", script)], {
		input: JSON.stringify(input),
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

export function writeTranscript(entries: object[]): string {
	const path = join(mkdtempSync(join(tmpdir(), "pi-setup-transcript-")), "session.jsonl");
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
	return path;
}

export type PiHandlers = Record<string, (event: any, ctx: any) => Promise<any>>;

export async function loadPiExtension(file: string): Promise<PiHandlers> {
	const handlers: PiHandlers = {};
	const extension = await import(join(REPO_ROOT, "extensions", file));
	extension.default({ on: (name: string, handler: PiHandlers[string]) => (handlers[name] = handler) });
	return handlers;
}
