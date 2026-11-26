import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export function readTextOrEmpty(path: string, cwd: string): string {
	try {
		return readFileSync(isAbsolute(path) ? path : resolve(cwd, path), "utf8");
	} catch {
		return "";
	}
}
