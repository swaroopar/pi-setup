import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

export type ShellEffects = { commitDirs: string[]; writeTargets: string[] | "unknown" };

type Word = { kind: "word"; text: string; dynamic: boolean; tildeExpandable: boolean };
type Operator = { kind: "op"; text: string };
type Token = Word | Operator;
type Target = string | undefined;
type CommandEffects = { commitDirs: string[]; targets: Target[] };

const OPERATORS = ["<<<", "&>>", "&&", "||", ">>", ">|", "&>", ">&", "<<", ";", "|", "&", "(", ")", ">", "<", "\n"];
const SEQUENCE_SEPARATORS = new Set(["&&", "||", ";", "&", "\n"]);
const FILE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
const INPUT_REDIRECTS = new Set(["<", "<<<"]);
const FD_DUPLICATE_RE = /^(\d+|-)$/;

const PLAIN_PREFIXES = new Set(["rtk", "proxy", "command", "exec", "nohup", "time", "builtin"]);
const SUDO_OPTIONS_WITH_VALUE = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-U", "-r", "-t"]);
const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir"]);
const UV_RUN_OPTIONS_WITH_VALUE = new Set(["--with", "--python", "-p", "--project", "--directory", "--package"]);
const XARGS_OPTIONS_WITH_VALUE = new Set(["-n", "-I", "-L", "-P", "-d", "-s", "-E", "-a"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

const WRITES_EVERY_ARGUMENT = new Set(["rm", "rmdir", "touch", "mkdir", "truncate", "tee", "mv"]);
const WRITES_LAST_ARGUMENT = new Set(["cp", "ln", "install", "rsync"]);
const IN_PLACE_EDITORS = new Set(["sed", "perl"]);
const OPAQUE_WRITERS = new Set(["patch", "dd"]);
const OPTIONS_WITH_VALUE: Record<string, Set<string>> = {
	truncate: new Set(["-s", "--size", "-r", "--reference"]),
	touch: new Set(["-t", "-d", "-r", "--reference", "--date"]),
	mkdir: new Set(["-m", "--mode"]),
	install: new Set(["-m", "-o", "-g", "--mode", "--owner", "--group"]),
	cp: new Set(["-t", "--target-directory"]),
	mv: new Set(["-t", "--target-directory"]),
	sed: new Set(["-e", "-f", "-E", "--expression", "--file"]),
	perl: new Set(["-e", "-E", "-I", "-M"]),
};
const TARGET_DIRECTORY_OPTIONS = new Set(["-t", "--target-directory"]);
const SCRIPT_OPTIONS = new Set(["-e", "-f", "-E", "--expression", "--file"]);
const IN_PLACE_FLAG_RE = /^-\w*i|^--in-place/;
const ENV_ASSIGNMENT_RE = /^\w+=/;

const GIT_WRITE_SUBCOMMANDS = new Set(["apply", "checkout", "restore", "reset", "stash", "mv", "rm", "am", "cherry-pick", "merge", "rebase", "pull", "switch", "clean"]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

const PYTHON_RE = /^(?:\S*\/)?python3?(?:\.\d+)?$/;
const PYTHON_WRITE_RE =
	/open\(.*?,\s*(?:mode\s*=\s*)?['"](?:[wax]|r\+)[bt+]*['"]|\.write_text\(|\.write_bytes\(|os\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir)\(|\.unlink\(|shutil\./;
const HOME_VARIABLE_RE = /^\$(?:HOME|\{HOME\})(?=\/|$)/;
const DYNAMIC_RE = /[$`]/;
const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', "\\", "$", "`"]);

function readHeredocDelimiter(command: string, start: number): { delimiter: string; allowsTabs: boolean; end: number } {
	const match = /^(-?)\s*(['"]?)(\w+)\2/.exec(command.slice(start));
	if (!match) return { delimiter: "", allowsTabs: false, end: start };
	return { delimiter: match[3], allowsTabs: match[1] === "-", end: start + match[0].length };
}

function skipHeredocBodies(command: string, start: number, heredocs: { delimiter: string; allowsTabs: boolean }[]): number {
	let position = start;
	for (const { delimiter, allowsTabs } of heredocs) {
		const closing = new RegExp(`^${allowsTabs ? "\\t*" : ""}${delimiter}$`, "m").exec(command.slice(position));
		position = closing ? position + closing.index + closing[0].length + 1 : command.length;
	}
	return position;
}

function tokenize(command: string): Token[] {
	const tokens: Token[] = [];
	const pendingHeredocs: { delimiter: string; allowsTabs: boolean }[] = [];
	let word = "";
	let inWord = false;
	let dynamic = false;
	let tildeExpandable = false;
	const startWord = (unquoted: boolean) => {
		if (!inWord) tildeExpandable = unquoted;
		inWord = true;
	};
	const flush = () => {
		if (inWord) tokens.push({ kind: "word", text: word, dynamic, tildeExpandable });
		word = "";
		inWord = false;
		dynamic = false;
		tildeExpandable = false;
	};
	let i = 0;
	while (i < command.length) {
		const char = command[i];
		if (char === " " || char === "\t") {
			flush();
			i++;
		} else if (char === "\\" && command[i + 1] === "\n") {
			i += 2;
		} else if (char === "\\") {
			startWord(false);
			word += command[i + 1] ?? "";
			i += 2;
		} else if (char === "'") {
			startWord(false);
			const end = command.indexOf("'", i + 1);
			word += command.slice(i + 1, end < 0 ? undefined : end);
			i = end < 0 ? command.length : end + 1;
		} else if (char === '"') {
			startWord(false);
			i++;
			while (i < command.length && command[i] !== '"') {
				if (command[i] === "\\" && DOUBLE_QUOTE_ESCAPABLE.has(command[i + 1])) {
					word += command[i + 1];
					i += 2;
				} else {
					dynamic ||= DYNAMIC_RE.test(command[i]);
					word += command[i++];
				}
			}
			i++;
		} else {
			const operator = OPERATORS.find((op) => command.startsWith(op, i));
			if (!operator) {
				startWord(true);
				dynamic ||= DYNAMIC_RE.test(char);
				word += char;
				i++;
				continue;
			}
			if ((operator.startsWith(">") || operator.startsWith("&>")) && /^\d+$/.test(word)) {
				word = "";
				inWord = false;
			}
			flush();
			tokens.push({ kind: "op", text: operator });
			i += operator.length;
			if (operator === "<<") {
				const heredoc = readHeredocDelimiter(command, i);
				if (heredoc.delimiter) pendingHeredocs.push(heredoc);
				i = heredoc.end;
			} else if (operator === "\n" && pendingHeredocs.length) {
				i = skipHeredocBodies(command, i, pendingHeredocs.splice(0));
			}
		}
	}
	flush();
	return tokens;
}

function expandPath(word: Word | undefined, dir: string | undefined): Target {
	if (!word) return undefined;
	let text = word.text;
	if (word.tildeExpandable && (text === "~" || text.startsWith("~/"))) text = homedir() + text.slice(1);
	if (word.dynamic) text = text.replace(HOME_VARIABLE_RE, homedir());
	if (word.dynamic && DYNAMIC_RE.test(text)) return undefined;
	if (isAbsolute(text)) return text;
	return dir === undefined ? undefined : resolve(dir, text);
}

function splitOptions(args: Word[], optionsWithValue: Set<string> = new Set()) {
	const positional: Word[] = [];
	const values = new Map<string, Word>();
	for (let i = 0; i < args.length; i++) {
		const text = args[i].text;
		if (text === "--") {
			positional.push(...args.slice(i + 1));
			break;
		}
		const [flag, attached] = text.startsWith("--") ? text.split("=", 2) : [text, undefined];
		if (optionsWithValue.has(flag)) {
			const value = attached !== undefined ? { ...args[i], text: attached } : args[++i];
			if (value) values.set(flag, value);
		} else if (!text.startsWith("-") || text === "-") positional.push(args[i]);
	}
	return { positional, values };
}

function stripPrefixes(words: Word[]): Word[] {
	let rest = words;
	for (;;) {
		const name = rest[0]?.text;
		if (name === undefined) return rest;
		if (PLAIN_PREFIXES.has(name) || ENV_ASSIGNMENT_RE.test(name)) rest = rest.slice(1);
		else if (name === "sudo" || name === "env") {
			const optionsWithValue = name === "sudo" ? SUDO_OPTIONS_WITH_VALUE : ENV_OPTIONS_WITH_VALUE;
			let i = 1;
			while (i < rest.length && (rest[i].text.startsWith("-") || (name === "env" && ENV_ASSIGNMENT_RE.test(rest[i].text)))) {
				i += optionsWithValue.has(rest[i].text) ? 2 : 1;
			}
			rest = rest.slice(i);
		} else if (name === "uv" && rest[1]?.text === "run") {
			let i = 2;
			while (i < rest.length && rest[i].text.startsWith("-")) i += UV_RUN_OPTIONS_WITH_VALUE.has(rest[i].text) ? 2 : 1;
			rest = rest.slice(i);
		} else return rest;
	}
}

function gitEffects(args: Word[], dir: string | undefined, cwd: string): CommandEffects {
	let gitDir = dir;
	let workTree: Target | null = null;
	let i = 0;
	while (i < args.length && args[i].text.startsWith("-")) {
		const text = args[i].text;
		if (text === "-C") gitDir = expandPath(args[i + 1], gitDir);
		else if (text.startsWith("-C")) gitDir = expandPath({ ...args[i], text: text.slice(2) }, gitDir);
		else if (text === "--work-tree") workTree = expandPath(args[i + 1], gitDir);
		else if (text.startsWith("--work-tree=")) workTree = expandPath({ ...args[i], text: text.slice(12) }, gitDir);
		i += GIT_OPTIONS_WITH_VALUE.has(text) ? 2 : 1;
	}
	const subcommand = args[i]?.text ?? "";
	if (subcommand === "commit") return { commitDirs: [gitDir ?? cwd], targets: [] };
	if (GIT_WRITE_SUBCOMMANDS.has(subcommand)) return { commitDirs: [], targets: [workTree === null ? gitDir : workTree] };
	return { commitDirs: [], targets: [] };
}

function inPlaceTargets(name: string, args: Word[], dir: string | undefined): Target[] {
	if (!args.some((arg) => IN_PLACE_FLAG_RE.test(arg.text))) return [];
	const files = splitOptions(args, OPTIONS_WITH_VALUE[name]).positional.filter((arg) => arg.text !== "");
	const hasScriptOption = args.some((arg) => SCRIPT_OPTIONS.has(arg.text));
	return (hasScriptOption ? files : files.slice(1)).map((arg) => expandPath(arg, dir));
}

function delegatedCommandWrites(words: Word[]): boolean {
	const name = basename(words[0]?.text ?? "");
	return WRITES_EVERY_ARGUMENT.has(name) || WRITES_LAST_ARGUMENT.has(name) || OPAQUE_WRITERS.has(name) ||
		IN_PLACE_EDITORS.has(name) || name === "git" || SHELLS.has(name) || PYTHON_RE.test(name);
}

function commandEffects(words: Word[], dir: string | undefined, cwd: string, fullCommand: string): CommandEffects {
	const none: CommandEffects = { commitDirs: [], targets: [] };
	const unknown: CommandEffects = { commitDirs: [], targets: [undefined] };
	const name = basename(words[0].text);
	const args = words.slice(1);

	if (name === "git") return gitEffects(args, dir, cwd);
	if (SHELLS.has(name)) {
		const script = args[args.findIndex((arg) => arg.text === "-c") + 1];
		if (!args.some((arg) => arg.text === "-c")) return args.length ? unknown : none;
		if (!script || script.dynamic) return { commitDirs: [cwd], targets: [undefined] };
		const nested = analyze(script.text, dir, cwd);
		return { commitDirs: nested.commitDirs, targets: nested.targets };
	}
	if (name === "xargs") {
		const { positional } = splitOptions(args, XARGS_OPTIONS_WITH_VALUE);
		return delegatedCommandWrites(positional) ? unknown : none;
	}
	if (name === "find") {
		const execIndex = args.findIndex((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg.text));
		if (args.some((arg) => arg.text === "-delete")) return unknown;
		return execIndex >= 0 && delegatedCommandWrites(args.slice(execIndex + 1)) ? unknown : none;
	}
	if (name === "dd") {
		const output = args.find((arg) => arg.text.startsWith("of="));
		return output ? { commitDirs: [], targets: [expandPath({ ...output, text: output.text.slice(3) }, dir)] } : none;
	}
	if (OPAQUE_WRITERS.has(name)) return unknown;
	if (PYTHON_RE.test(name)) return PYTHON_WRITE_RE.test(fullCommand) ? unknown : none;
	if (IN_PLACE_EDITORS.has(name)) return { commitDirs: [], targets: inPlaceTargets(name, args, dir) };

	const { positional, values } = splitOptions(args, OPTIONS_WITH_VALUE[name]);
	const targetDirectory = [...TARGET_DIRECTORY_OPTIONS].map((option) => values.get(option)).find(Boolean);
	if (WRITES_EVERY_ARGUMENT.has(name)) {
		return { commitDirs: [], targets: [...positional, ...(targetDirectory ? [targetDirectory] : [])].map((arg) => expandPath(arg, dir)) };
	}
	if (WRITES_LAST_ARGUMENT.has(name)) {
		const destination = targetDirectory ?? positional.at(-1);
		return { commitDirs: [], targets: destination ? [expandPath(destination, dir)] : [] };
	}
	return none;
}

function analyze(command: string, startDir: string | undefined, cwd: string): { commitDirs: string[]; targets: Target[] } {
	const commitDirs: string[] = [];
	const targets: Target[] = [];
	const dirStack: (string | undefined)[] = [];
	let dir = startDir;
	let words: Word[] = [];
	let previousSeparator = "";
	const tokens = tokenize(command);

	const finishCommand = (nextSeparator: string) => {
		const current = stripPrefixes(words);
		words = [];
		if (!current.length) return;
		if (basename(current[0].text) === "cd") {
			const inPipeline = previousSeparator === "|" || nextSeparator === "|";
			if (inPipeline) return;
			const destination = current[1];
			const changedTo = !destination ? homedir() : destination.text === "-" ? undefined : expandPath(destination, dir);
			dir = nextSeparator === "||" ? undefined : changedTo;
			return;
		}
		const effects = commandEffects(current, dir, cwd, command);
		commitDirs.push(...effects.commitDirs);
		targets.push(...effects.targets);
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.kind === "word") {
			words.push(token);
		} else if (FILE_REDIRECTS.has(token.text) || token.text === ">&") {
			const target = tokens[i + 1];
			if (target?.kind !== "word") continue;
			i++;
			if (token.text === ">&" && FD_DUPLICATE_RE.test(target.text)) continue;
			if (!target.text.startsWith("/dev/")) targets.push(expandPath(target, dir));
		} else if (INPUT_REDIRECTS.has(token.text)) {
			i++;
		} else if (token.text === "(") {
			finishCommand("(");
			dirStack.push(dir);
			previousSeparator = "(";
		} else if (token.text === ")") {
			finishCommand(")");
			if (dirStack.length) dir = dirStack.pop();
			previousSeparator = ")";
		} else if (token.text === "|" || SEQUENCE_SEPARATORS.has(token.text)) {
			finishCommand(token.text);
			previousSeparator = token.text;
		}
	}
	finishCommand("");
	return { commitDirs, targets };
}

export function shellEffects(command: string, cwd: string): ShellEffects {
	const { commitDirs, targets } = analyze(command, cwd, cwd);
	return { commitDirs, writeTargets: targets.includes(undefined) ? "unknown" : (targets as string[]) };
}
