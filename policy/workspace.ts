import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export type Workspace = {
	windowStart(): number;
	newestChangeTime(since: number): number;
	contains(path: string): boolean;
};

const DEFAULT_BRANCH_REFS = ["origin/HEAD", "origin/main", "origin/master"];
const UNTRACKED = "??";

type StatusEntry = { code: string; path: string };

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

function branchWindowStart(cwd: string): number {
	for (const ref of DEFAULT_BRANCH_REFS) {
		const base = git(cwd, "merge-base", "HEAD", ref)?.trim();
		if (base) return commitTime(cwd, base);
	}
	return commitTime(cwd, "HEAD");
}

function parseStatus(status: string): StatusEntry[] {
	const records = status.split("\0");
	const entries: StatusEntry[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.length < 4) continue;
		const code = record.slice(0, 2);
		entries.push({ code, path: record.slice(3) });
		if ("RC".includes(code[0])) i++;
	}
	return entries;
}

function newestChangeTime(cwd: string, since: number): number {
	const root = git(cwd, "rev-parse", "--show-toplevel")?.trim();
	const status = git(cwd, "status", "--porcelain", "-z", "--untracked-files=all");
	if (!root || status === undefined) return 0;
	let newest = 0;
	for (const { code, path } of parseStatus(status)) {
		const fullPath = join(root, path);
		if (!existsSync(fullPath) || !statSync(fullPath).isFile()) continue;
		const mtime = statSync(fullPath).mtimeMs;
		if (code === UNTRACKED && mtime <= since) continue;
		newest = Math.max(newest, mtime);
	}
	return newest;
}

function realPathOfNearestExisting(path: string): string {
	let existing = path;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	return join(realpathSync(existing), path.slice(existing.length));
}

function contains(cwd: string, path: string): boolean {
	const root = realPathOfNearestExisting(git(cwd, "rev-parse", "--show-toplevel")?.trim() || cwd);
	const target = realPathOfNearestExisting(isAbsolute(path) ? path : resolve(cwd, path));
	return target === root || target.startsWith(root + sep);
}

export function gitWorkspace(cwd: string): Workspace {
	let windowStart: number | undefined;
	return {
		windowStart: () => (windowStart ??= branchWindowStart(cwd)),
		newestChangeTime: (since) => newestChangeTime(cwd, since),
		contains: (path) => contains(cwd, path),
	};
}
