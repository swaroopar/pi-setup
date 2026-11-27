import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const { packageEntriesWithFilters } = createRequire(import.meta.url)("../scripts/pi-package-filters.js");

describe("pi package filters", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-home-"));
	const settingsDir = join(home, ".pi", "agent");
	const thisRepoDir = join(home, "repositories", "pi-setup");
	mkdirSync(settingsDir, { recursive: true });
	mkdirSync(thisRepoDir, { recursive: true });
	const run = (entries: unknown[], declaredPackages: object[] = []) =>
		packageEntriesWithFilters({ entries, declaredPackages, thisRepoFilters: { skills: [] }, thisRepoDir, settingsDir });

	test("sets the skills filter on this repo's own entry", () => {
		const { entries, warnings } = run(["npm:a", "../../repositories/pi-setup"]);
		assert.deepEqual(entries, ["npm:a", { source: "../../repositories/pi-setup", skills: [] }]);
		assert.deepEqual(warnings, []);
	});
	test("keeps an existing object entry's source and replaces its filters", () => {
		const { entries } = run([{ source: "../../repositories/pi-setup", extensions: ["x"] }]);
		assert.deepEqual(entries, [{ source: "../../repositories/pi-setup", skills: [] }]);
	});
	test("applies declared filters to remote packages", () => {
		const { entries } = run(["npm:a", "../../repositories/pi-setup"], [{ source: "npm:a", description: "d", extensions: ["-x.ts"] }]);
		assert.deepEqual(entries[0], { source: "npm:a", extensions: ["-x.ts"] });
	});
	test("warns when this repo or a declared package isn't installed", () => {
		const { entries, warnings } = run(["npm:a"], [{ source: "npm:b", skills: [] }]);
		assert.deepEqual(entries, ["npm:a"]);
		assert.equal(warnings.length, 2);
		assert.match(warnings[1], /pi install \./);
	});
	test("running it again on its own output changes nothing", () => {
		const declared = [{ source: "npm:a", extensions: ["-x.ts"] }];
		const once = run(["npm:a", "../../repositories/pi-setup"], declared).entries;
		assert.deepEqual(run(once, declared).entries, once);
	});
	test("an unrelated local package is left alone", () => {
		mkdirSync(join(home, "other"), { recursive: true });
		const { entries } = run(["../../other", "../../repositories/pi-setup"]);
		assert.equal(entries[0], "../../other");
	});
});
