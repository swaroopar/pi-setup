const UNIFIED_HEADER_RE = /^\[(.+)\]$|^\*\*\* (?:Add|Update|Delete) File: (.+)$/;

export type EditSection = { path: string; removed: string[]; added: string[] };

export function unifiedEditSections(script: string): EditSection[] {
	const sections = new Map<string, EditSection>();
	let current: EditSection | undefined;
	for (const line of script.split("\n")) {
		const header = UNIFIED_HEADER_RE.exec(line);
		if (header) {
			const path = (header[1] ?? header[2]).trim();
			current = sections.get(path) ?? { path, removed: [], added: [] };
			sections.set(path, current);
		} else if (current && line.startsWith("+")) current.added.push(line.slice(1));
		else if (current && line.startsWith("-")) current.removed.push(line.slice(1));
	}
	return [...sections.values()];
}

export function blockFailure(name: string, error: unknown) {
	return { block: true, reason: `${name} extension failed, so it blocked to stay safe: ${error instanceof Error ? error.message : error}` };
}
