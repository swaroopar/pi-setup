import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, test } from "node:test";
import { shellEffects } from "../policy/shell.ts";

const REPO = "/repo";
const insideRepo = (path: string) => path === REPO || path.startsWith(`${REPO}/`);

type Case = [command: string, commitsInRepo: boolean, writesInRepo: boolean | "unknown"];

const cases: Case[] = [
	["git commit -m x", true, false],
	["rtk git commit -m x", true, false],
	["cd a && rtk git commit", true, false],
	["rtk proxy git commit", true, false],
	["git -c a=b commit", true, false],
	["cd ../other && git commit -m x", false, false],
	["git -C ../other commit -m x", false, false],
	["git -C /repo/sub commit -m x", true, false],
	["git -C/tmp commit -m x", false, false],
	["git --git-dir /elsewhere/.git status", false, false],
	["git --git-dir /elsewhere/.git -C /repo commit -m x", true, false],
	["git -C $X commit", true, false],
	["env A=1 git commit -m x", true, false],
	["bash -c 'git commit -m x'", true, false],
	["sh -c \"cd /tmp && git commit\"", false, false],
	["cd /tmp || git commit", true, false],
	["cd /tmp && cd - && git commit", true, false],
	["cd ~ && git commit", false, false],
	['echo "git commit"', false, false],
	["rtk git log --grep commit", false, false],
	["git log --oneline", false, false],
	["grep commit x", false, false],
	["sed -i '' 's/a/b/' f.py", false, true],
	["rtk sed -i 's/a/b/' f.py", false, true],
	["sed -i -e 's/a/b/' -e 's/c/d/' f.py", false, true],
	["sed -n 1p f.py | grep -i x", false, false],
	["perl -pi -e 's/a/b/' f", false, true],
	["echo hi > out.txt", false, true],
	["echo hi >out.txt", false, true],
	["echo hi >> out.txt", false, true],
	["echo hi >| out.txt", false, true],
	["echo hi &> out.txt", false, true],
	["echo hi >& out.txt", false, true],
	["> f.py", false, true],
	["cat f | tee out.txt", false, true],
	["cat f | tee -a out.txt", false, true],
	["cd x && rm f.py", false, true],
	["rm -rf ./src", false, true],
	["rm -- -f", false, true],
	["touch src/new.ts", false, true],
	["touch -d 2020-01-01 /tmp/a", false, false],
	["ln -s /tmp/a src/link", false, true],
	["truncate -s 0 /tmp/f", false, false],
	["truncate -s 0 f.py", false, true],
	["git checkout -b x", false, true],
	["git -C /elsewhere checkout main", false, false],
	["git --work-tree=/tmp checkout .", false, false],
	["mkdir -p src", false, true],
	["mkdir -p /tmp/x", false, false],
	["mv ~/.pi/agent/skills/a ~/backup/", false, false],
	["cp src/a.py /tmp/", false, false],
	["cp /tmp/a src/a.py", false, true],
	["cp -t /tmp a b", false, false],
	["mv -t /tmp a", false, true],
	["rsync -a src/ /tmp/backup/", false, false],
	["rsync -a /tmp/x/ src/", false, true],
	["dd if=/dev/zero of=f.bin bs=1 count=1", false, true],
	["dd if=f.bin of=/tmp/x", false, false],
	["find . -delete", false, "unknown"],
	["find . -name '*.pyc' -exec rm {} +", false, "unknown"],
	["find . -name '*.py' -exec grep -l x {} +", false, false],
	["ls | xargs rm", false, "unknown"],
	["ls | xargs grep x", false, false],
	["env X=1 rm f", false, true],
	["sudo -u me rm f", false, true],
	["bash -c 'rm f.py'", false, true],
	["bash script.sh", false, "unknown"],
	["ls > /tmp/x", false, false],
	["ls > /private/tmp/x", false, false],
	["grep a f.py | head", false, false],
	["cmd 2>/dev/null", false, false],
	["cmd 2>&1 | tail", false, false],
	["cmd >&2", false, false],
	["git status", false, false],
	["echo 'a > b'", false, false],
	['echo "a\\" b" > f.py', false, true],
	["echo '$HOME' > x", false, true],
	["cat <<'EOF' > /tmp/x.py\nif a > b:\n    rm = 1\nEOF", false, false],
	["cat <<'EOF' > notes.md\nhello\nEOF", false, true],
	["cat <<'EOF' | tee notes.md\nhello\nEOF", false, true],
	["cat <<EOF > /tmp/x\n  EOF\nrm src/a\nEOF", false, false],
	["npm run test", false, false],
	["rm $FILE", false, "unknown"],
	["cd $DIR && rm f.py", false, "unknown"],
	["rm $HOME/x", false, false],
	["rm \"$HOME/x\"", false, false],
	["(cd /tmp && rm x) && rm src/a.py", false, true],
	["(cd /tmp); echo x > f.py", false, true],
	["cd /tmp | true; rm f.py", false, true],
	["cd /tmp; rm x", false, false],
	["cd /tmp && rm x", false, false],
	["mkdir /tmp/a \\\n  /tmp/b", false, false],
	["patch -p1 < fix.diff", false, "unknown"],
	["python3 - <<'EOF'\nopen('f.py','w').write('x')\nEOF", false, "unknown"],
	["python3 -c \"from pathlib import Path; Path('f').write_text('x')\"", false, "unknown"],
	["rtk python3 - <<'EOF'\nimport os; os.remove('f.py')\nEOF", false, "unknown"],
	["uv run python -c \"import shutil; shutil.rmtree('x')\"", false, "unknown"],
	["uv run --with rich python -c \"open('f','w')\"", false, "unknown"],
	["/usr/bin/python3 -c \"open('f','w')\"", false, "unknown"],
	[".venv/bin/python -c \"open('f','w')\"", false, "unknown"],
	["python3.12 -c \"import os; os.makedirs('d')\"", false, "unknown"],
	["python3 -c \"open(os.path.join(d,'f'), 'w').write('a')\"", false, "unknown"],
	["python3 -c \"open(Path('f'), mode='a')\"", false, "unknown"],
	["python3 -c \"open('x', 'r+')\"", false, "unknown"],
	["python3 -c \"print(1 > 0)\"", false, false],
	["python3 -c \"print(open('x').read())\"", false, false],
	["python3 -c \"open('x','rb').read()\"", false, false],
	["python3 -c \"import json; json.load(open('a.json'))\"", false, false],
];

describe("shellEffects", () => {
	for (const [command, commitsInRepo, writesInRepo] of cases) {
		test(command.replace(/\n/g, "⏎"), () => {
			const { commitDirs, writeTargets } = shellEffects(command, REPO);
			assert.equal(commitDirs.some(insideRepo), commitsInRepo, `commit dirs: ${JSON.stringify(commitDirs)}`);
			const actualWrites = writeTargets === "unknown" ? "unknown" : writeTargets.some(insideRepo);
			assert.equal(actualWrites, writesInRepo, `writes: ${JSON.stringify(writeTargets)}`);
		});
	}

	test("expands ~ and $HOME when unquoted", () => {
		assert.deepEqual(shellEffects("mkdir ~/a $HOME/b", REPO).writeTargets, [`${homedir()}/a`, `${homedir()}/b`]);
	});
	test("does not expand a quoted ~", () => {
		assert.deepEqual(shellEffects("mkdir '~/a'", REPO).writeTargets, [`${REPO}/~/a`]);
	});
});
