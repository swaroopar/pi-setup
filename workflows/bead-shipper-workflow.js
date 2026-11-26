export const meta = {
  name: 'bead_shipper',
  description:
    'Ship a bead: implement -> verify -> commit -> MR, with deterministic gating (quality-gate checks, a completeness check, and a functional review against the bead spec). The completeness check judges against both the bead\'s derived acceptanceCriteria list and its full verbatim requirements text -- an inline "Verify:" shell/code snippet in a criterion is a command to actually run and check the output/exit code of, never a claim that a separate script file must exist in the repo. Runs directly in the checkout the workflow was launched in -- point it at a dedicated clone/checkout, not your main working copy. MRs/PRs target `targetBranch` (default "main"; pass a different value to redirect all MRs/PRs this run opens to that branch). Env setup defaults to this repo\'s `uv sync --extra dev` convention but is independently overridable via setupCommand. If the actual project (pyproject.toml/package.json/etc.) lives in a subdirectory of the checkout rather than at its root (e.g. a monorepo), pass `projectSubdir` (a relative path, e.g. "Agents/app/FlakyTestAgent") -- setupCommand and every `checks[].command` then run as `cd <projectSubdir> && <command>` instead of at the repo root; git/bd/MR operations (branch, push, MR target) are unaffected and always operate on the whole checkout. The pre-ship quality gates are a required, project/language-neutral `checks` array of `{name, command}` objects (each command must exit 0 to pass) -- no default is assumed, every run must pass its own array (e.g. Python: `[{name:"lintCheck",command:"uv run ruff check src tests"},{name:"lintFormat",command:"uv run ruff format --check src tests"},{name:"typeCheck",command:"uv run mypy src"},{name:"test",command:"uv run pytest"}]`, Node: `[{name:"lint",command:"npm run lint"},{name:"test",command:"npm test"}]`). Config/tooling files whose edits need independent bead-scope justification are matched via `configFilePatterns` (an array of regex fragments, default matches ruff.toml/pyproject.toml/mypy.ini/setup.cfg). No model name is ever assumed by default -- every model used by this workflow must come from the input JSON. Either pass `model` (e.g. "claude-sonnet-4.6") to pin every step in this run onto one specific remote model/provider, or pass both `implementModel` (used for the implement step) and `otherStepsModel` (used for every other step: fetch-bead/prepare-repo/env-setup/the 3 judge checks/ship/monitor) -- missing either of those that `model` doesn\'t cover throws immediately rather than silently picking a model. `implementFallbackModel` (the model the implement step switches to after `implementFallbackAfterAttempts` failed attempts on `implementModel`, default 5 attempts) is optional and defaults to `implementModel` itself when not given (so the fallback switch becomes a no-op, not a crash); this entire fallback mechanism is skipped when `model` is set, since that already pins every step to one model. If the ship step fails at the commit/push/open-MR mechanics themselves (status "blocked": auth/tool/network error, transient push rejection, etc, NOT a real CI/code failure), it is retried on its own (up to `maxShipRetries`, default 5) with the exact same already-approved code -- only a real "ci_failed"/"merge_conflict" result triggers a full re-implementation. The returned result already reflects this verification (see alreadyVerified/verificationNote) -- do not re-verify the ship/MR independently. By default `bd show` is run with no directory override, so bd auto-discovers `.beads/*.db` from this checkout; pass `beadsDir` (an absolute path) when the beads database actually lives elsewhere -- e.g. a dedicated bead-workspace checked out under the user\'s home directory rather than inside this checkout -- and it is appended as `bd`\'s own `-C <beadsDir>` flag to that lookup. Commits must never be attributed to whatever ambient git identity the harness/agent process happens to have -- pass `commitUserName`/`commitUserEmail` to pin the exact identity the ship step sets (local `git config`, no --global, no --author override) before every commit; if omitted, the ship step instead reads the operator\'s own `git config --global user.name`/`user.email` first and uses that, falling back to deriving an identity from the authenticated `gh`/`glab` account (GitHub: `gh api user`, name + `<id>+<login>@users.noreply.github.com`; GitLab: `glab api user`, name + public/real email or a noreply fallback) only if the global git config is empty too, and refuses to commit (reports "blocked") if none of those resolve. A monitor-script exit code of 4 (no CI checks/pipeline ever registered for the MR/PR after its own polling -- e.g. this repo\'s CI only triggers on a different branch, or there is no CI at all) is mapped to ship status "success" with ciStatus "no_ci_configured", not "blocked" or "ci_failed" -- there is genuinely nothing to verify, so this must not loop forever waiting for a signal that will never arrive.',
  phases: [
    { title: 'Bead Lookup' },
    { title: 'Repo Setup' },
    { title: 'Implementation & Ship Loop' },
    { title: 'Task Close' },
  ],
}

const rawArgsTextUnnormalized =
  typeof args === 'object' && args !== null && typeof args._raw === 'string' ? args._raw.trim() : ''
const rawArgsText = rawArgsTextUnnormalized.replace(/[\u2018\u2019\u201a]/g, "'").replace(/[\u201c\u201d\u201e]/g, '"')
let resolvedArgs = args
if (rawArgsText.startsWith('{') && rawArgsText.endsWith('}')) {
  try {
    const parsedArgs = JSON.parse(rawArgsText)
    if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) {
      resolvedArgs = parsedArgs
      log(
        rawArgsText === rawArgsTextUnnormalized
          ? 'Parsed a JSON object from the raw command text -- using it as this run\'s args.'
          : 'Parsed a JSON object from the raw command text (after normalizing curly/smart quotes to straight ' +
              'quotes) -- using it as this run\'s args.',
      )
    }
  } catch (err) {
    log(`Raw command text looked like JSON but failed to parse (${err.message}) -- falling back to key=value/positional args.`)
  }
}

const beadId =
  typeof resolvedArgs === 'string'
    ? resolvedArgs
    : resolvedArgs?.beadId ||
      resolvedArgs?.id ||
      (typeof resolvedArgs?._ === 'string' && resolvedArgs._.trim() ? resolvedArgs._.trim() : undefined)
if (!beadId) {
  throw new Error(
    'bead-shipper workflow requires a beadId -- pass it as `/bead_shipper <beadId>` or ' +
      '`/bead_shipper beadId=<beadId>` (or a JSON object like `/bead_shipper {"beadId": "<id>"}`, ' +
      'or via args: { beadId: "<id>" } when run programmatically)',
  )
}

const taskId = resolvedArgs?.taskId

const beadsDir =
  typeof resolvedArgs?.beadsDir === 'string' && resolvedArgs.beadsDir.trim() ? resolvedArgs.beadsDir.trim() : undefined

const BD_DIR_FLAG = beadsDir ? ` -C ${beadsDir}` : ''

const targetBranch =
  typeof resolvedArgs?.targetBranch === 'string' && resolvedArgs.targetBranch.trim() ? resolvedArgs.targetBranch.trim() : 'main'

// Relative path (from the repo root this workflow runs in) to the actual project root, for repos where
// pyproject.toml/package.json/etc. lives in a subdirectory rather than at the top of the checkout (e.g. a
// monorepo). When set, every setupCommand/checks[].command runs as `cd <projectSubdir> && <command>` instead
// of at the repo root. Never affects git/bd/MR operations (branch, push, MR target) -- those always operate
// on the whole repo checkout regardless of where the project itself lives inside it.
const projectSubdir =
  typeof resolvedArgs?.projectSubdir === 'string' && resolvedArgs.projectSubdir.trim()
    ? resolvedArgs.projectSubdir.trim().replace(/^\/+|\/+$/g, '')
    : undefined

function scopeToProjectSubdir(command) {
  return projectSubdir ? `cd "${projectSubdir}" && ${command}` : command
}

const PROJECT_SUBDIR_NOTE = projectSubdir
  ? `Project subdirectory: ${projectSubdir} (the actual project root inside this checkout -- setupCommand and ` +
    `every checks[] command already run as \`cd "${projectSubdir}" && ...\`; when editing files, reading ` +
    `context, or running your own exploratory commands, operate relative to this subdirectory, not the repo ` +
    `root, unless the bead explicitly says otherwise)\n`
  : ''

// Commits must be attributed to the actual human operator's real forge account, never to whatever ambient
// git identity the harness/agent process happens to have (e.g. a global ~/.gitconfig or GIT_AUTHOR_* env var
// naming the agent/runtime itself). Pass these explicitly to pin it; if omitted, the ship step is instructed
// to derive the real identity itself from the authenticated `gh`/`glab` account instead of trusting whatever
// git config is already sitting in the environment.
const commitUserName =
  typeof resolvedArgs?.commitUserName === 'string' && resolvedArgs.commitUserName.trim()
    ? resolvedArgs.commitUserName.trim()
    : undefined
const commitUserEmail =
  typeof resolvedArgs?.commitUserEmail === 'string' && resolvedArgs.commitUserEmail.trim()
    ? resolvedArgs.commitUserEmail.trim()
    : undefined

const GIT_IDENTITY_NOTE = commitUserName && commitUserEmail
  ? `Before committing, run \`git config user.name "${commitUserName}"\` and \`git config user.email ` +
    `"${commitUserEmail}"\` in THIS repo (local config, not --global) -- do this every time, unconditionally, ` +
    `even if some other identity is already configured (a global ~/.gitconfig or an ambient GIT_AUTHOR_*/` +
    `GIT_COMMITTER_* environment variable may otherwise attribute the commit to the harness/agent itself, ` +
    `not to the real operator). Never use --author or any other override instead of this.\n`
  : `Before committing, determine the real operator's identity and set it as this repo's LOCAL git identity ` +
    `(\`git config user.name "..."\` / \`git config user.email "..."\`, no --author override) before the ` +
    `commit, every time, unconditionally -- do NOT just commit with whatever identity is already active (an ` +
    `ambient GIT_AUTHOR_*/GIT_COMMITTER_* environment variable, or a repo-local config left over from a prior ` +
    `run, can silently attribute the commit to the harness/agent itself instead of the actual operator):\n` +
    `   1. Run \`git config --global user.name\` and \`git config --global user.email\` -- this is the ` +
    `operator's own real, machine-wide git identity and is the correct source of truth whenever it is set. If ` +
    `both are non-empty, use them verbatim as this repo's local user.name/user.email and skip step 2.\n` +
    `   2. Only if the global config is missing/empty, fall back to deriving it from the authenticated forge ` +
    `account instead: GitHub -- run \`gh api user --jq '{login,name,id}'\`, use \`.name\` if non-null else ` +
    `\`.login\` as user.name, and \`<id>+<login>@users.noreply.github.com\` as user.email; GitLab -- run ` +
    `\`glab api user --output json | jq '{username,name,email,public_email}'\`, use \`.name\` as user.name, ` +
    `and \`.public_email\` if non-empty else \`.email\` else \`<username>@users.noreply.gitlab.com\` as ` +
    `user.email. If the global git config is empty AND neither \`gh\` nor \`glab\` is authenticated/reachable, ` +
    `stop and report status "blocked" with notes explaining that the real operator identity could not be ` +
    `determined -- do NOT fall back to committing with whatever identity happens to already be configured.\n`

const setupCommand = scopeToProjectSubdir(
  typeof resolvedArgs?.setupCommand === 'string' && resolvedArgs.setupCommand.trim() ? resolvedArgs.setupCommand.trim() : 'uv sync --extra dev',
)

function resolveChecks(rawChecks) {
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    throw new Error(
      '`checks` is required -- a non-empty array of {name, command} objects (e.g. ' +
        '[{"name":"lint","command":"npm run lint"},{"name":"test","command":"npm test"}]). No default checks are assumed.',
    )
  }
  const seenNames = new Set()
  return rawChecks.map((entry, i) => {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    const command = typeof entry?.command === 'string' ? entry.command.trim() : ''
    if (!name || !command) {
      throw new Error(`checks[${i}] must be an object with non-empty string "name" and "command" fields.`)
    }
    if (seenNames.has(name)) {
      throw new Error(`checks[${i}] has a duplicate name "${name}" -- every check name must be unique.`)
    }
    seenNames.add(name)
    return { name, command: scopeToProjectSubdir(command) }
  })
}

const checks = resolveChecks(resolvedArgs?.checks)

const DEFAULT_CONFIG_FILE_PATTERNS = ['\\.?ruff\\.toml', 'pyproject\\.toml', '\\.?mypy\\.ini', 'setup\\.cfg']

const configFilePatterns =
  Array.isArray(resolvedArgs?.configFilePatterns) &&
  resolvedArgs.configFilePatterns.length > 0 &&
  resolvedArgs.configFilePatterns.every((p) => typeof p === 'string' && p.trim())
    ? resolvedArgs.configFilePatterns.map((p) => p.trim())
    : DEFAULT_CONFIG_FILE_PATTERNS

const CONFIG_FILE_PATTERN = new RegExp(`(^|/)(${configFilePatterns.join('|')})$`, 'i')
const CONFIG_FILE_PATTERNS_DESCRIPTION = configFilePatterns.join(', ')

const modelOverride = typeof resolvedArgs?.model === 'string' && resolvedArgs.model.trim() ? resolvedArgs.model.trim() : undefined

function requireModel(argName, purpose) {
  const value =
    typeof resolvedArgs?.[argName] === 'string' && resolvedArgs[argName].trim() ? resolvedArgs[argName].trim() : undefined
  if (!modelOverride && !value) {
    throw new Error(
      `\`${argName}\` is required (no default model name is assumed) -- pass it explicitly, or pass \`model\` ` +
        `to pin every step, including ${purpose}, to one model.`,
    )
  }
  return modelOverride || value
}

const defaultOtherStepsModel = requireModel(
  'otherStepsModel',
  'fetch-bead/prepare-repo/env-setup/the 3 judge checks/ship/monitor',
)

const defaultImplementModel = requireModel('implementModel', 'the implement step')

const implementFallbackAfterAttempts =
  resolvedArgs && Number.isInteger(resolvedArgs.implementFallbackAfterAttempts)
    ? Math.max(1, resolvedArgs.implementFallbackAfterAttempts)
    : 5

// Unlike otherStepsModel/implementModel, implementFallbackModel has no separate required-input gate --
// it reuses an already-explicit value (implementModel, or model) instead of demanding yet another field
// for a fallback that may never trigger. This still introduces no hardcoded model name of its own.
const implementFallbackModel =
  typeof resolvedArgs?.implementFallbackModel === 'string' && resolvedArgs.implementFallbackModel.trim()
    ? resolvedArgs.implementFallbackModel.trim()
    : defaultImplementModel

const featureBranch = `feature/${beadId
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')}`

const maxIterations =
  resolvedArgs && Number.isInteger(resolvedArgs.maxIterations) ? Math.max(1, Math.min(resolvedArgs.maxIterations, 100)) : 20

const maxPendingRechecks =
  resolvedArgs && Number.isInteger(resolvedArgs.maxPendingRechecks) ? Math.max(1, Math.min(resolvedArgs.maxPendingRechecks, 500)) : 40

const maxShipRetries =
  resolvedArgs && Number.isInteger(resolvedArgs.maxShipRetries) ? Math.max(1, Math.min(resolvedArgs.maxShipRetries, 20)) : 5

const AGENT_TIMEOUT_MS =
  resolvedArgs && (resolvedArgs.agentTimeoutMs === null || resolvedArgs.agentTimeoutMs === 0)
    ? null
    : resolvedArgs && Number.isFinite(Number(resolvedArgs.agentTimeoutMs)) && Number(resolvedArgs.agentTimeoutMs) > 0
      ? Number(resolvedArgs.agentTimeoutMs)
      : 2 * 60 * 60 * 1000

const JUDGE_TIMEOUT_MS = AGENT_TIMEOUT_MS === null ? null : Math.min(AGENT_TIMEOUT_MS, 20 * 60 * 1000)
const VERIFY_TIMEOUT_MS = AGENT_TIMEOUT_MS === null ? null : Math.min(AGENT_TIMEOUT_MS, 45 * 60 * 1000)

const SHIP_TIMEOUT_MS =
  AGENT_TIMEOUT_MS === null
    ? null
    : resolvedArgs && Number.isFinite(Number(resolvedArgs.shipTimeoutMs)) && Number(resolvedArgs.shipTimeoutMs) > 0
      ? Number(resolvedArgs.shipTimeoutMs)
      : Math.max(AGENT_TIMEOUT_MS, 60 * 60 * 1000)

const GLAB_SKILL_PATH = '~/.pi/agent/skills/glab/SKILL.md'
const GH_CLI_SKILL_PATH = '~/.pi/agent/skills/gh-cli/SKILL.md'

function reasonPreview(text) {
  if (!text) return '(no reasoning provided)'
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine
}

const beadSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    requirements: { type: 'string' },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    labels: { type: 'array', items: { type: 'string' } },
    raw: { type: 'string' },
  },
  required: ['title', 'description', 'requirements', 'acceptanceCriteria', 'raw'],
}

const prepareRepoSchema = {
  type: 'object',
  properties: {
    gitClean: { type: 'boolean' },
    gitStatusOutput: { type: 'string' },
    defaultBranch: { type: 'string' },
    branchCreated: { type: 'boolean' },
    branchName: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['gitClean', 'gitStatusOutput', 'defaultBranch', 'branchCreated', 'branchName', 'notes'],
}

const envSetupSchema = {
  type: 'object',
  properties: {
    exitCode: { type: ['number', 'null'] },
    output: { type: 'string' },
  },
  required: ['exitCode', 'output'],
}

const implementSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    linterChangeRequested: { type: 'boolean' },

    linterChangeDescription: { type: 'string' },

    reasoningSummary: { type: 'string' },
  },

  required: ['summary', 'linterChangeRequested'],
}

const checkResultSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    passed: { type: 'boolean' },
    exitCode: { type: ['number', 'null'] },
    output: { type: 'string' },
  },
  required: ['name', 'passed', 'exitCode', 'output'],
}

const verifyChecksSchema = {
  type: 'object',
  properties: {
    gitTop: { type: 'string' },
    gitStatusOutput: { type: 'string' },
    commitsAheadOutput: { type: 'string' },
    results: { type: 'array', items: checkResultSchema },
    allPassed: { type: 'boolean' },
    reasoningSummary: { type: 'string' },
  },

  required: ['gitTop', 'gitStatusOutput', 'commitsAheadOutput', 'results', 'allPassed'],
}

const shipSchema = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['success', 'no_change', 'ci_failed', 'merge_conflict', 'pending', 'blocked'],
    },
    monitorExitCode: { type: ['number', 'null'] },
    branch: { type: 'string' },
    mrUrl: { type: 'string' },
    headCommitSha: { type: 'string' },
    ciStatus: { type: 'string' },
    notes: { type: 'string' },
    reasoningSummary: { type: 'string' },
  },

  required: ['status', 'notes', 'monitorExitCode', 'branch', 'mrUrl', 'headCommitSha'],
}

const completenessSchema = {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    missing: { type: 'array', items: { type: 'string' } },
  },
  required: ['complete'],
}

const NO_PROSE_COMMENTARY_FOOTER =
  `IMPORTANT: do not write any prose commentary between tool calls -- gather all the evidence you need ` +
  `first via back-to-back tool calls, and call structured_output exactly once, as your last action, only ` +
  `after you've checked everything.`

function completenessPrompt(implementResult) {
  return (
    `Judge whether every acceptance criterion for this bead has actually been addressed by inspecting ` +
    `the REAL code -- do not trust the implementer's own summary at face value.\n\n` +
    `Repo path: ${cwd}\nBranch: ${featureBranch}\n` +
    PROJECT_SUBDIR_NOTE +
    `\n` +
    `Acceptance criteria:\n- ${beadInfo.acceptanceCriteria.join('\n- ')}\n\n` +
    `Full functional/technical requirements (verbatim, from the bead itself -- the authoritative source if a ` +
    `criterion above looks vague, garbled, or ambiguous; a criterion is a derived summary of this, not a ` +
    `replacement for it):\n${beadInfo.requirements}\n\n` +
    `Implementer's self-reported summary (verify this against the actual diff, don't just trust it): ` +
    `${implementResult.summary}\n` +
    `Files it claims changed: ${(implementResult.filesChanged ?? []).join(', ') || '(none reported)'}\n\n` +
    `Set complete: true only if every criterion is genuinely satisfied by what you find in the working tree. ` +
    `Otherwise set complete: false and list the specific missing/unaddressed criteria in "missing".\n\n` +
    `If a criterion references an inline shell/code snippet (e.g. a bead's own "Verify:" block, such as a ` +
    `\`uv run python -c "...; print('OK')"\` one-liner), that is a command to actually RUN yourself right now ` +
    `(in ${projectSubdir ? `\`${projectSubdir}\`` : 'the repo root'}) and check the real output/exit code of -- ` +
    `it is never a claim that a separate, persistently-saved script file must exist somewhere in the repo. ` +
    `Do not mark such a criterion missing just because no matching script FILE exists; run the literal snippet ` +
    `from the requirements above and judge it by its actual result.\n\n` +
    `Scope note: this check only judges whether the required file/logic exists in the CURRENT working tree ` +
    `(committed, staged, or unstaged/untracked all count equally) -- it does NOT judge git commit/push state. ` +
    `Committing and pushing happen later in a separate ship step; do not run git log/git status to check ` +
    `commit history, and never mark a criterion missing solely because a file is uncommitted or untracked -- ` +
    `only check whether its content is present and correct in the working tree right now.\n\n` +
    NO_PROSE_COMMENTARY_FOOTER
  )
}

const functionalReviewSchema = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    reasoning: { type: 'string' },
  },
  required: ['approved', 'issues'],
}

function functionalReviewPrompt(implementResult) {
  return (
    `You are an independent functional/code reviewer -- your job is DIFFERENT from the completeness check ` +
    `and the lint/type/test verification, both of which already ran or will run separately. Those only check ` +
    `a checklist and tooling output; they do NOT confirm the code actually does what the bead describes. ` +
    `Your job is to read the bead's full technical requirements below and the ACTUAL diff in the working ` +
    `tree, line by line, and judge whether the implementation genuinely, faithfully matches what was ` +
    `specifically asked for -- correct file(s), correct field/function names, correct location in the code, ` +
    `correct logic -- not just "something plausible was changed and tests still pass."\n\n` +
    `Repo path: ${cwd}\nBranch: ${featureBranch}\n` +
    PROJECT_SUBDIR_NOTE +
    `\n` +
    `Bead title: ${beadInfo.title}\n` +
    `Bead description (verbatim): ${beadInfo.description}\n\n` +
    `Full functional/technical requirements (verbatim -- this is the actual spec to check the code against): ` +
    `${beadInfo.requirements}\n\n` +
    `Implementer's self-reported summary (do not trust this, verify independently against the real diff): ` +
    `${implementResult.summary}\n` +
    `Files it claims changed: ${(implementResult.filesChanged ?? []).join(', ') || '(none reported)'}\n\n` +
    `Check specifically:\n` +
    `- Every file/field/function the requirements name explicitly was actually touched as described.\n` +
    `- The code pattern/logic matches what was specified (not just superficially similar).\n` +
    `- Nothing required was skipped, half-done, or silently substituted with an easier alternative.\n` +
    `- No functionality was removed/broken that the requirements did not ask to remove.\n\n` +
    `Set approved: true only if the real diff genuinely and fully satisfies the requirements above. ` +
    `Otherwise set approved: false and list each specific, concrete discrepancy in "issues" (precise enough ` +
    `that the implementer can act on it directly -- name the exact file/field/line and what is wrong or missing). ` +
    `In "reasoning", summarize what you found in the diff and why you reached this verdict.\n\n` +
    NO_PROSE_COMMENTARY_FOOTER
  )
}

const linterValidationSchema = {
  type: 'object',
  properties: {
    justified: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['justified', 'reasoning'],
}

function linterValidationPrompt(implementResult) {
  return (
    `An implementation attempt for this bead wants to modify a config/tooling file matching one of ` +
    `this run's configFilePatterns (${CONFIG_FILE_PATTERNS_DESCRIPTION}). ` +
    `Decide whether the BEAD ITSELF genuinely calls for this -- do not rubber-stamp the implementer's ` +
    `own justification; independently check it against the bead's actual scope.\n\n` +
    `Bead title: ${beadInfo.title}\nBead description: ${beadInfo.description}\n` +
    `Full requirements: ${beadInfo.requirements}\n` +
    `Acceptance criteria:\n- ${beadInfo.acceptanceCriteria.join('\n- ')}\n\n` +
    `Requested linter/config change: ${implementResult.linterChangeDescription ?? '(no description provided)'}\n\n` +
    `Set justified: true ONLY if the bead's description, requirements, or acceptance criteria explicitly require or ` +
    `unavoidably necessitate this specific linter/config change to be satisfied. If the change is merely ` +
    `convenient, unrelated, or a workaround the implementer chose on its own, set justified: false.\n\n` +
    `In "reasoning", give a specific, concrete explanation the implementer can act on -- if unjustified, ` +
    `explain precisely why this bead does not call for it and what the implementer should do instead ` +
    `(e.g. revert the linter/config edit and find a workaround that respects the existing configuration).\n\n` +
    NO_PROSE_COMMENTARY_FOOTER
  )
}

class LinterChangeExhaustedError extends Error {}

let beadInfo

function implementPrompt(feedback, attempt) {
  return (
    `Implement the work described in this bead in the current repo checkout (iteration ${attempt + 1}).\n\n` +
    `Bead:\nTitle: ${beadInfo.title}\nDescription: ${beadInfo.description}\n\n` +
    `Full functional/technical requirements (this is the actual spec -- implement exactly this, not a ` +
    `paraphrase or a simplified version of it):\n${beadInfo.requirements}\n\n` +
    `Acceptance criteria:\n- ${beadInfo.acceptanceCriteria.join('\n- ')}\n\n` +
    `Repo path: ${cwd}\nBranch: ${featureBranch}\n` +
    PROJECT_SUBDIR_NOTE +
    `\n` +
    (feedback ? `Feedback from the previous attempt to address:\n${feedback}\n\n` : '') +
    `CRITICAL RULES:\n` +
    `1. DO NOT COMMIT, PUSH, OR OPEN ANY MR/PR HERE. Leave every change as plain, uncommitted working-tree ` +
    `modifications (\`git status --porcelain\` should show them as unstaged/untracked when you finish, not as ` +
    `a commit). Committing, pushing, and opening the MR are done exclusively by a separate, later ship step ` +
    `that runs only after independent review of your diff -- if you commit here, that step (and the ` +
    `verification step before it) can no longer tell "nothing changed" apart from "changes were already ` +
    `committed", which silently breaks the pipeline. Do not run \`git add\` for the purpose of committing, ` +
    `\`git commit\`, \`git push\`, \`glab\`, or \`gh\` at all in this step.\n` +
    `2. CONFIG/TOOLING CHANGES NEED VALIDATION: if this change touches a config/tooling file matching ` +
    `one of this run's configFilePatterns (${CONFIG_FILE_PATTERNS_DESCRIPTION}), ` +
    `set linterChangeRequested: true and describe exactly what and why in linterChangeDescription. ` +
    `Do NOT assume it is warranted -- a separate validator agent independently checks this change against ` +
    `the bead's own scope before it is allowed to proceed, not you.\n` +
    `3. AMBIGUITIES OR TRADE-OFFS: this workflow has no reliable live human-Q&A channel mid-implementation ` +
    `(ask_user_question is not a supported workflow primitive and is not guaranteed to reach a human here) -- ` +
    `make the most reasonable, conservative choice yourself, explicitly document the assumption and the ` +
    `alternatives you considered in reasoningSummary, and keep the change easy to revert/adjust in a later ` +
    `iteration if the assumption turns out wrong.\n` +
    `4. Keep changes focused -- no unrelated files, no debug prints left behind.\n` +
    `5. FOLLOW THE ACTUAL SPEC: an independent functional reviewer will check the real diff against the ` +
    `full requirements verbatim afterward -- do not simplify, generalize, or substitute an easier approach ` +
    `for what was specifically asked (exact fields, exact files, exact patterns named in the requirements).\n` +
    `6. REASONING: in reasoningSummary, explain your actual reasoning -- why you chose this approach ` +
    `over alternatives, what trade-offs you considered, and why you believe it satisfies the acceptance ` +
    `criteria. This is the only place your reasoning becomes visible in the workflow's output (native ` +
    `model thinking/reasoning is not captured or displayed by the harness), so write it out explicitly.\n\n` +
    `Steps: a) Read the relevant code first. b) Make the change that satisfies the requirements and ` +
    `acceptance criteria. c) Report a structured summary of what changed and why.`
  )
}

function verifyChecksPrompt(implementResult, attempt) {
  return (
    `Run pre-ship verification for this bead's implementation (iteration ${attempt + 1}). ` +
    `Do ONLY the checks below -- do not commit, push, or open an MR.\n\n` +
    `Repo path: ${cwd}\nBranch: ${featureBranch}\n` +
    PROJECT_SUBDIR_NOTE +
    `Implementation summary across ALL implement attempts so far: ${combinedImplementSummary()}\n\n` +
    `0. Run \`git rev-parse --show-toplevel\` FIRST and report its raw stdout verbatim as gitTop -- this is a ` +
    `sanity check that you are actually operating in the intended repo checkout.\n` +
    `1. Run \`git status --porcelain\` and report its raw stdout verbatim as gitStatusOutput (empty string if ` +
    `there is none). Do NOT use \`git diff\` alone for this -- it only covers already-tracked files and will ` +
    `silently miss brand-new untracked files, which is a real and common case (e.g. a newly created test or ` +
    `source file). \`git status --porcelain\` is the only command that reports staged, unstaged, AND untracked ` +
    `changes together, so it is the only correct source for this field.\n` +
    `1b. Run \`git rev-list --count origin/${prepareRepo.defaultBranch}..HEAD\` and report its raw stdout ` +
    `verbatim as commitsAheadOutput (just the number git prints, e.g. "0" or "2"). This exists because the ` +
    `implementer is NOT supposed to commit -- but if it did anyway, \`git status --porcelain\` alone would be ` +
    `empty (clean tree) and wrongly look like "nothing changed", even though real, uncommitted-to-base work ` +
    `exists as commit(s) on this branch. This command catches that case regardless of working-tree state.\n` +
    `2. Run exactly these ${checks.length} command(s), in order, capturing each one's exit code and a ` +
    `truncated tail of output. Report one entry per command in the "results" array, using the exact "name" ` +
    `given for each (do not rename, reorder, skip, or add any):\n` +
    checks.map((c, i) => `   ${String.fromCharCode(97 + i)}. \`${c.command}\` -> name: "${c.name}"\n`).join('') +
    `\n` +
    `Report passed: true only when the command's exit code is exactly 0. Set allPassed: true only ` +
    `if every entry in results passed. Do not soften, summarize away, or reinterpret a nonzero exit code as a pass.\n\n` +
    `In reasoningSummary, explain how you interpreted each result -- especially any judgment calls on ` +
    `ambiguous or partial output.\n\n` +
    NO_PROSE_COMMENTARY_FOOTER
  )
}

function shipPrompt(implementResult, attempt) {
  return (
    `Ship the already-verified work for this bead (iteration ${attempt + 1}). ` +
    `Verification already passed in a separate step -- do not re-run the lint/type/test suite here.\n\n` +
    `Repo path: ${cwd}\nBranch: ${featureBranch}\n` +
    PROJECT_SUBDIR_NOTE +
    `Raw log across ALL implement attempts so far (${implementHistory.length} total -- background context ` +
    `only, NOT a template for the MR body: most later "attempts" are just fixes for test/lint failures found ` +
    `in an earlier attempt, not separate features):\n${combinedImplementSummary()}\n` +
    `Files changed across all attempts: ${combinedFilesChanged().join(', ') || '(none reported)'}\n\n` +
    `Steps -- run ALL of these; do not stop partway:\n\n` +
    `1. GATE CHECK -- review git diff/status: no extra files, no debug prints, every acceptance ` +
    `criterion satisfied by the diff.\n\n` +
    `2. COMMIT -- ` +
    GIT_IDENTITY_NOTE +
    `Then run \`git status --porcelain\`: if it is non-empty, commit those changes (no --author override -- the ` +
    `identity set above is what must show up as both author and committer). If it is EMPTY, an earlier step ` +
    `already committed the work despite being told not to -- that is fine, do NOT create an empty/duplicate ` +
    `commit, just proceed with ` +
    `the existing HEAD commit as-is. Either way, immediately after this step (and again after any ` +
    `push/rebase/force-push), capture the exact head commit SHA with git rev-parse HEAD -- this is the one ` +
    `and only commit whose pipeline matters below.\n\n` +
    `3. PUSH -- run \`GIT_TERMINAL_PROMPT=0 git push -u origin ${featureBranch}\` (add \`--force-with-lease\` ` +
    `only if you amended/rebased an already-pushed commit). The remote branch name MUST be exactly ` +
    `\`${featureBranch}\` -- never let git push create or push to any other name (e.g. from a detached HEAD, ` +
    `a mistyped refspec, or a stale upstream tracking a different branch); if \`git branch --show-current\` ` +
    `does not print exactly \`${featureBranch}\` before you push, fix that first. Confirm afterwards with ` +
    `\`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}\`, which must report \`origin/${featureBranch}\`.\n\n` +
    `4. OPEN MR -- when creating the MR/PR, pass the source/head branch explicitly and make sure it is exactly ` +
    `\`${featureBranch}\` (glab: \`--source-branch ${featureBranch}\`, gh: \`--head ${featureBranch}\`) -- do ` +
    `NOT let the tool infer it from a detached HEAD or a differently-named local branch, which silently opens ` +
    `the MR/PR against the wrong branch. The MR/PR description must describe the FINAL state of the change as ONE coherent whole, ` +
    `written as if it had been implemented correctly in a single pass -- NOT a chronological changelog of ` +
    `implement attempts ("attempt 1 did X, attempt 2 fixed Y", "iteration 3: fixed failing test", etc). Do ` +
    `not mention attempt/iteration numbers, retries, or "fixed test failures from a previous attempt" in the ` +
    `MR body at all -- a reviewer reading it should not be able to tell this took multiple attempts. Derive ` +
    `the actual content primarily from \`git diff origin/${targetBranch}...HEAD\` and \`git log\` on this ` +
    `branch (the real, final end-state of the code), using the raw attempt log above only as background ` +
    `orientation for what the change is about, never as source text to summarize or copy from. The target/base ` +
    `branch for this MR/PR is FIXED at \`${targetBranch}\` -- do NOT let the ` +
    `tool default to its own idea of the default branch (which may not be ${targetBranch}); always pass it ` +
    `explicitly (glab: \`--target-branch ${targetBranch}\`, gh: \`--base ${targetBranch}\`). Detect the forge ` +
    `from git remote get-url origin -- it can be either GitLab or GitHub, ` +
    `neither is the default. MANDATORY, NOT OPTIONAL: before running the FIRST glab or gh command of any ` +
    `kind, your very next tool call MUST be your read tool on the exact skill file path for the detected ` +
    `forge below -- do this even if you already believe you know the correct flags from general knowledge. ` +
    `glab's command syntax diverges from gh's in ways that look plausible but are wrong (e.g. MR subcommands, ` +
    `flag names), and guessing from memory instead of reading this file is a known, repeated failure mode. ` +
    `Do not rely on it merely being summarized in <available_skills> -- actually call read on the file:\n` +
    `   - GitLab -> ${GLAB_SKILL_PATH}\n` +
    `   - GitHub -> ${GH_CLI_SKILL_PATH}\n` +
    `   CRITICAL either way: every git/glab/gh command here MUST be fully non-interactive -- there is no ` +
    `TTY/stdin available to answer any prompt, editor, or confirmation these tools may otherwise open, and ` +
    `a command that opens one will hang forever with no error or output (this HAS happened before). Prefix ` +
    `every git push/fetch/clone command with GIT_TERMINAL_PROMPT=0 as well, so a credential prompt fails ` +
    `fast with a clear error instead of hanging.\n\n` +
    `5. MONITOR -- run the matching script and capture its exit code (these live right next to the ` +
    `saved workflow file, in the same directory as bead_shipper.json). The script itself polls until the ` +
    `pipeline reaches a final state (success/failed/canceled) or the MR has conflicts -- it does NOT return ` +
    `early just because the pipeline is still queued/pending. DO NOT wrap it in your own short bash timeout ` +
    `(e.g. a 60-120s \`timeout\` on the bash tool call) -- a pipeline can legitimately sit queued for several ` +
    `minutes before a runner picks it up, and cutting the script off early during "pending"/"created"/ ` +
    `"waiting_for_resource" is a real, previously-observed failure mode that wrongly aborts a healthy ship. ` +
    `Let the script run to completion; only impose a timeout if you are close to running out of your own ` +
    `overall time budget for this step, and even then prefer a generous one (many minutes), not seconds:\n` +
    `   - GitLab: ~/.pi/workflows/saved/monitor-mr-gitlab.sh <mr-iid>\n` +
    `   - GitHub: ~/.pi/workflows/saved/monitor-mr-github.sh <pr-number>\n\n` +
    `6. MAP the outcome to the structured "status" field exactly -- this mapping directly controls what the ` +
    `harness does next, so get it right: "ci_failed"/"merge_conflict" trigger a full re-implementation ` +
    `(a real code fix is needed), while "blocked" instead retries JUST this ship step again with the exact ` +
    `same code (no re-implementation) -- so never report "blocked" for a real code/CI problem, and never ` +
    `report "ci_failed"/"merge_conflict" for a mechanical failure that has nothing to do with the code:\n` +
    `   - exit 0 -> status: "success"\n   - exit 1 (CI failed) -> status: "ci_failed"\n` +
    `   - exit 3 (merge conflicts) -> status: "merge_conflict"\n` +
    `   - exit 4 (no checks/pipeline ever registered for this MR/PR after the script's own polling, e.g. ` +
    `this repo's CI only triggers on a different branch/event, or there is no CI configured at all) -> ` +
    `status: "success", with ciStatus set to something like "no_ci_configured" and notes explaining exactly ` +
    `what the monitor script reported -- there is genuinely nothing to verify here, so this does NOT block ` +
    `shipping and must NOT be reported as "blocked" (which would retry forever against a condition that will ` +
    `never change) or as "ci_failed" (no pipeline ever ran, so nothing failed).\n` +
    `   - the monitor script was cut short (by your own timeout) or you otherwise had to stop WHILE the ` +
    `pipeline was still in a non-final state (pending/created/running/waiting_for_resource/queued, etc, per ` +
    `\`glab ci get\`/\`gh run view\`) -> status: "pending" -- this is NOT a failure and NOT your fault, ` +
    `report it plainly with whatever ciStatus you last observed. Do NOT report "blocked" for this case.\n` +
    `   - reserve "blocked" for failures in the SHIP MECHANICS ITSELF, before/without ever reaching a real ` +
    `CI/code signal: \`git commit\`/\`git push\` failing (auth, network, rejected push, pre-commit hook ` +
    `error unrelated to the actual diff, etc), \`glab\`/\`gh\` failing to open the MR/PR (auth failure, API ` +
    `error, tool crash, unparseable output), or the MR/PR ending up not found/unreachable when you go to ` +
    `monitor it. These are tooling/infra problems, NOT evidence the implementation itself is wrong -- do not ` +
    `use "blocked" for a pipeline that ran and genuinely failed (that is "ci_failed").\n\n` +
    `monitorExitCode, branch, mrUrl, and headCommitSha are ALL REQUIRED fields -- you must always include them:\n` +
    `   - monitorExitCode: the literal integer exit code from the monitor script, or null if it did not ` +
    `finish (pending) or genuinely could not be reached (explain why in notes).\n` +
    `   - branch: the real branch name, always.\n` +
    `   - mrUrl: the real MR/PR URL, or "" ONLY if no MR was opened (explain why in notes).\n` +
    `   - headCommitSha: the exact commit SHA from git rev-parse HEAD that the monitored pipeline actually ` +
    `ran against (the branch's tip at the time you ran the monitor script). If you pushed again after an ` +
    `earlier monitor run, re-capture this and re-monitor -- never report a SHA from an earlier, stale push.\n\n` +
    `IMPORTANT -- what "success" means here: the MR/PR being MERGEABLE (no merge conflicts, latest pipeline ` +
    `for headCommitSha green) is the bar. The MR/PR is NOT expected to be merged or closed by this workflow -- ` +
    `it is deliberately left open for human review. Do not treat an open MR/PR as a problem or as evidence ` +
    `against success; only merge conflicts or a failing/missing pipeline for headCommitSha count against it.\n\n` +
    `NEVER report status: "success" unless you actually ran the monitor script and it exited 0 -- a ` +
    `"success" claim with a missing/nonzero monitorExitCode will be rejected and retried. ` +
    `Do not soften or  reinterpret a failing status -- report it exactly as observed.\n\n` +
    `In reasoningSummary, explain your reasoning at each step -- forge detection, the exact headCommitSha ` +
    `monitored, any conflicts or CI failures encountered, and why you mapped the outcome to this particular status.`
  )
}

function monitorExistingMrPrompt(openMr, attempt) {
  return (
    `A previous iteration in this same run already opened an MR/PR that never reached a verified ` +
    `success -- do NOT create a new commit or a new MR/PR here, there is no new diff to ship.\n\n` +
    `Branch: ${openMr.branch}\nMR/PR URL: ${openMr.mrUrl}\n\n` +
    `Re-check on that existing MR/PR (iteration ${attempt + 1}):\n` +
    `1. Confirm it still exists and get its identifier (MR iid / PR number) from the URL. This can be ` +
    `either a GitLab or GitHub repo -- detect which from the URL/git remote. MANDATORY, NOT OPTIONAL: before ` +
    `running the FIRST glab or gh command of any kind, call your read tool on the exact skill file path for ` +
    `the detected forge below -- do this even if you already believe you know the correct flags. Do not rely ` +
    `on <available_skills> summarizing it for you; actually read the file:\n` +
    `   - GitLab -> ${GLAB_SKILL_PATH}\n` +
    `   - GitHub -> ${GH_CLI_SKILL_PATH}\n` +
    `   Capture its current head commit SHA (the branch tip on the forge).\n` +
    `2. Run the matching monitor script and capture its exit code (these live right next to the saved ` +
    `workflow file, in the same directory as bead_shipper.json). The script polls until the pipeline ` +
    `reaches a final state -- it does NOT return early just because the pipeline is still queued/pending. ` +
    `DO NOT wrap it in your own short bash timeout (e.g. 60-120s) -- a queued pipeline can legitimately take ` +
    `several minutes before a runner picks it up; cutting it off early during "pending"/"created"/ ` +
    `"waiting_for_resource" is a real, previously-observed failure mode. Let it run to completion; only use ` +
    `a timeout if you're close to running out of your own time budget, and make it generous (minutes, not ` +
    `seconds):\n` +
    `   - GitLab: ~/.pi/workflows/saved/monitor-mr-gitlab.sh <mr-iid>\n` +
    `   - GitHub: ~/.pi/workflows/saved/monitor-mr-github.sh <pr-number>\n` +
    `   If the monitor script is missing/unreachable, report that explicitly in notes and set ` +
    `monitorExitCode: null -- do not guess a result.\n` +
    `3. Map the outcome to the structured "status" field exactly, same rules as before: 0->success, ` +
    `1->ci_failed, 3->merge_conflict, 4->success (no checks/pipeline ever registered after the script's own ` +
    `polling -- this repo's CI most likely doesn't trigger for this branch/event, or has none at all; set ` +
    `ciStatus to something like "no_ci_configured" and explain in notes -- this is genuinely nothing to verify, ` +
    `never "blocked" or "ci_failed"). If you had to stop while the pipeline was still in a non-final state ` +
    `(pending/created/running/waiting_for_resource, per \`glab ci get\`/\`gh run view\`), that is status: ` +
    `"pending" -- NOT "blocked" and NOT a reason to change any code; it just needs to be re-checked again ` +
    `later. Reserve "blocked" for mechanical failures only (the recheck itself failed: script/tool crash, ` +
    `auth failure, MR/PR genuinely not found/unreachable) -- this is not evidence of a code problem either, ` +
    `so this too just gets rechecked again, never routed into a re-implementation.\n\n` +
    `monitorExitCode, branch, mrUrl, and headCommitSha are ALL REQUIRED fields. NEVER report status: "success" ` +
    `unless you actually ran the monitor script and it exited 0 or 4.\n\n` +
    `IMPORTANT -- what "success" means here: the MR/PR being MERGEABLE (no conflicts, latest pipeline for ` +
    `headCommitSha green) is the bar; it is NOT expected to be merged/closed -- do not treat an open MR/PR ` +
    `as a problem.\n\n` +
    `In reasoningSummary, explain what you found and why you mapped it to this status.`
  )
}

phase('Bead Lookup')

log(
  `Per-agent timeout: ${AGENT_TIMEOUT_MS === null ? 'disabled (no hard timeout)' : `${AGENT_TIMEOUT_MS}ms (${AGENT_TIMEOUT_MS / 3600000}h)`}`,
  `Judge-step timeout (completeness/functional-review/linter-validation): ${JUDGE_TIMEOUT_MS === null ? 'disabled' : `${JUDGE_TIMEOUT_MS}ms (${JUDGE_TIMEOUT_MS / 60000}min)`}`,
  `Verify-checks timeout: ${VERIFY_TIMEOUT_MS === null ? 'disabled' : `${VERIFY_TIMEOUT_MS}ms (${VERIFY_TIMEOUT_MS / 60000}min)`}`,
)

log(`Token budget: total=${budget.total ?? 'unlimited'}, spent so far=${budget.spent()}`)

beadInfo = await agent(
  `Run bd${BD_DIR_FLAG} show ${beadId} to get the full bead/issue details.\n\n` +
    `Extract these fields precisely:\n` +
    `- title: the bead's title.\n` +
    `- description: the bead's own description, verbatim, not summarized.\n` +
    `- requirements: the COMPLETE functional/technical specification exactly as written -- every file to ` +
    `change, every exact code snippet/pattern given, every specific step listed. Copy this verbatim/near-verbatim; ` +
    `do NOT compress it down to generic statements. This is what the implementer and reviewers will use to judge ` +
    `whether the actual functional change was made, not just whether tests pass.\n` +
    `- acceptanceCriteria: discrete, checkable statements. If the bead itself lists explicit acceptance criteria, ` +
    `use exactly those. If it does NOT, derive checkable statements from the actual functional requirements ` +
    `above (e.g. "mcp_progress_notifications field added to Config dataclass", "config.yaml.example documents ` +
    `the new key") -- do NOT invent generic placeholders like "tests pass" or "lint passes" as a substitute for ` +
    `real functional criteria; those are verified separately and are not what this bead is asking for. If a ` +
    `criterion is itself an inline shell/code snippet to run (e.g. a "Verify:" block with a literal command), ` +
    `preserve that command close to verbatim as the criterion text -- do NOT paraphrase it into a vaguer claim ` +
    `like "a script exists/prints X"; it describes a command to actually run and check the output/exit code of, ` +
    `never a demand that a separate script file be created in the repo.\n` +
    `- labels: any labels on the bead.\n` +
    `- raw: the complete unmodified command output.`,
  { label: 'fetch-bead', schema: beadSchema, retries: 1, timeoutMs: AGENT_TIMEOUT_MS, model: modelOverride || defaultOtherStepsModel },
)

if (!beadInfo) {
  throw new Error(
    `Failed to fetch bead ${beadId} -- check the ID and that bd is configured` +
      (beadsDir ? ` at beadsDir="${beadsDir}".` : '.'),
  )
}

log(`Bead ${beadId} loaded: ${beadInfo.title}`)

phase('Repo Setup')

const prepareRepo = await agent(
  `Prepare this checkout for implementing a bead DIRECTLY here -- there is no worktree or isolation, this IS ` +
    `the working copy to use for this task.

1. Run \`git status --porcelain\` FIRST, before touching anything else, and report its raw output verbatim as ` +
    `gitStatusOutput (empty string if there is none). Set gitClean: true only if that output is completely ` +
    `empty (no staged, unstaged, or untracked changes).
   If NOT clean: STOP HERE. Do not fetch or branch -- report gitClean: false and the exact output, and set ` +
    `defaultBranch to your best-effort read of it anyway, branchCreated: false, branchName: "", notes: ` +
    `"working tree not clean".

2. Only if gitClean is true, continue:
   a. git fetch origin -- if this fails (e.g. remote unreachable, DNS failure, auth error), STOP HERE -- report ` +
    `gitClean: true, defaultBranch: "${targetBranch}", branchCreated: false, branchName: "", and put the exact ` +
    `fetch error text verbatim in notes (this is a real environment/connectivity problem, not a missing branch -- ` +
    `do not conflate the two).
   b. The base/target branch for this run is FIXED, not auto-detected -- it is exactly \`${targetBranch}\`. ` +
    `Verify it exists on the remote with \`git ls-remote --exit-code --heads origin ${targetBranch}\`; if that ` +
    `fails (branch does not exist on origin), STOP HERE -- report gitClean: true, defaultBranch: "${targetBranch}", ` +
    `branchCreated: false, branchName: "" (do not fall back to guessing a different branch), and note in notes ` +
    `whether this was a genuinely missing branch vs. a network/connectivity error (paste the real output). ` +
    `Otherwise set defaultBranch: "${targetBranch}" and continue.
   c. Ensure the feature branch is fresh and unclaimed before checking it out -- the branch name is fixed and ` +
    `already decided, use exactly this: ${featureBranch}. A leftover branch/worktree from a prior run (including ` +
    `an older worktree-based version of this workflow) can still exist and can even have the branch checked out ` +
    `in ANOTHER worktree, which makes a plain \`git checkout -B\` fail with "branch already checked out" -- ` +
    `clear that unconditionally first, tolerating "nothing to clean up", in ONE idempotent chained command:
      \`git worktree list --porcelain | awk -v b="${featureBranch}" '/^worktree /{p=$2} /^branch refs\\/heads\\//{if ($2=="refs/heads/"b) print p}' | xargs -r -n1 git worktree remove --force; git worktree prune; git branch -D ${featureBranch} 2>/dev/null; true\`
   d. THEN create and check out the feature branch in ONE chained command: ` +
    `\`git checkout -B ${featureBranch} origin/${targetBranch}\` (the -B form resets the branch to the remote ` +
    `tip whether or not it already existed locally). Confirm success via \`git branch --show-current\` reporting ` +
    `exactly ${featureBranch}; set branchCreated accordingly. If checkout still fails after step c's cleanup, ` +
    `report the real error output and set branchCreated: false -- do not retry with a different branch name.

Return gitClean, gitStatusOutput, defaultBranch, branchCreated, and branchName (the real current branch per ` +
    `git branch --show-current, whatever it ended up being). notes is REQUIRED: if anything failed (fetch, ` +
    `ls-remote, checkout), paste the exact command and its real stderr/stdout output verbatim (e.g. remote ` +
    `unreachable/DNS/auth failures are common and look very different from a real missing branch -- do not ` +
    `paraphrase, quote the actual error text) -- this is the only way a human debugging a failed run later can ` +
    `tell those apart without re-running everything. If everything succeeded, put a short confirmation instead. ` +
    `Do NOT set up the environment (uv/npm/etc.) here -- that happens in a separate, dedicated step right after ` +
    `this one.`,
  { label: 'prepare-repo', schema: prepareRepoSchema, retries: 1, timeoutMs: AGENT_TIMEOUT_MS, model: modelOverride || defaultOtherStepsModel },
)

if (!prepareRepo) {
  throw new Error('Failed to prepare the repo -- aborting before any implementation work.')
}

if (!prepareRepo.gitClean) {
  throw new Error(
    `Repo is not clean before starting -- refusing to proceed (this workflow must be run against a dedicated, ` +
      `otherwise-idle checkout). \`git status --porcelain\` output:\n${prepareRepo.gitStatusOutput || '(none captured)'}`,
  )
}

if (!prepareRepo.branchCreated || prepareRepo.branchName !== featureBranch) {
  throw new Error(
    `Failed to create/check out feature branch ${featureBranch} (branchCreated=${prepareRepo.branchCreated}, ` +
      `actual branch reported: ${prepareRepo.branchName}). Notes: ${prepareRepo.notes || '(none captured)'}. ` +
      `Aborting before any implementation work.`,
  )
}

log(`Repo prepared: ${cwd} on branch ${featureBranch} (default branch: ${prepareRepo.defaultBranch})`)

const envSetup = await agent(
  `Run exactly this command and nothing else: \`${setupCommand}\`. Do not substitute a different command, ` +
    `do not attempt to fix a failure by editing files, do not run any other tool calls. Report its exact exit ` +
    `code and a truncated tail of its combined stdout/stderr, then call structured_output.`,
  {
    label: 'env-setup',
    schema: envSetupSchema,
    toolNames: ['bash'],
    retries: 1,
    timeoutMs: VERIFY_TIMEOUT_MS,
    model: modelOverride || defaultOtherStepsModel,
  },
)

if (!envSetup || envSetup.exitCode !== 0) {
  throw new Error(
    `'${setupCommand}' failed (exitCode=${envSetup?.exitCode ?? 'unknown'}): ` +
      `${envSetup?.output || '(no output captured)'}. Aborting before any implementation work.`,
  )
}

log(`Environment ready: ${setupCommand} exited 0 in ${cwd}`)

phase('Implementation & Ship Loop')

const attemptLedger = []

const implementHistory = []

function combinedImplementSummary() {
  if (implementHistory.length === 0) return '(no implement attempts recorded)'
  if (implementHistory.length === 1) return implementHistory[0].summary
  return implementHistory
    .map((entry) => `Attempt ${entry.attempt}: ${entry.summary}`)
    .join('\n')
}

function combinedFilesChanged() {
  const files = new Set()
  for (const entry of implementHistory) {
    for (const file of entry.filesChanged ?? []) files.add(file)
  }
  return [...files]
}

let lastOpenMr = null

let linterRejectionCount = 0

let implementAttemptCount = 0
let pendingRecheckCount = 0

let pendingShipRetry = null
let shipRetryCount = 0

function evaluateShipOutcome(ship) {
  if (ship === null) {
    return {
      ok: false,
      feedback: 'Verification passed but the ship step produced no usable result. Retry the commit/MR/monitor step.',
    }
  }

  if (ship.status === 'success' && ship.monitorExitCode !== 0 && ship.monitorExitCode !== 4) {
    return {
      ok: false,
      feedback:
        `Ship reported status "success" but monitorExitCode was ${ship.monitorExitCode} (expected 0, or 4 for ` +
        `"no CI ever registered for this MR/PR"). This is inconsistent -- the CI monitor script must actually ` +
        `be run and its real exit code reported. Re-run the monitor step against the real MR/PR and report ` +
        `the true status. Do not report success without a genuine monitorExitCode of 0 or 4.`,
    }
  }
  if (ship.status === 'success' && (!ship.mrUrl || !ship.branch)) {
    return {
      ok: false,
      feedback:
        `Ship reported status "success" but did not report an mrUrl and/or branch. A genuine success must ` +
        `include the real MR/PR URL and branch name. Re-run the commit/MR/monitor steps and report them.`,
    }
  }
  if (ship.status === 'success' && !ship.headCommitSha) {
    return {
      ok: false,
      feedback:
        `Ship reported status "success" but did not report headCommitSha. A genuine success must include ` +
        `the exact commit SHA (git rev-parse HEAD) that the monitored pipeline actually ran against, so it ` +
        `can be verified against the correct commit and not confused with any other commit in this repo's ` +
        `history. Re-run the commit/MR/monitor steps and report the real headCommitSha.`,
    }
  }
  if (ship.status === 'success' || ship.status === 'no_change') {
    return { ok: true }
  }
  if (ship.status === 'pending') {
    return {
      ok: false,
      feedback:
        `Pipeline for MR/PR ${ship.mrUrl} is still pending/running -- nothing to fix, no code change ` +
        `needed. The next attempt will re-check it directly (this does not consume a real implementation ` +
        `attempt).`,
    }
  }
  if (ship.status === 'blocked') {
    return {
      ok: false,
      feedback:
        `Ship failed at the commit/push/open-MR mechanics (not a CI/code problem): ${ship.notes}. ` +
        `The next attempt will retry just the ship step with the same already-approved code, not re-implement.`,
    }
  }
  return {
    ok: false,
    feedback:
      `Ship attempt reported status "${ship.status}" (monitor exit ${ship.monitorExitCode}). ` +
      `Details: ${ship.notes}. Fix the issue locally, amend the commit, force-push, and re-monitor.`,
  }
}

let gateOutcome
try {
  gateOutcome = await gate(
  async (feedback, attempt) => {

  try {

    if (lastOpenMr) {
      pendingRecheckCount += 1
      if (pendingRecheckCount > maxPendingRechecks) {
        const stuckShip = {
          status: 'blocked',
          monitorExitCode: null,
          branch: lastOpenMr.branch,
          mrUrl: lastOpenMr.mrUrl,
          headCommitSha: '',
          notes:
            `Exceeded maxPendingRechecks (${maxPendingRechecks}) while the pipeline for this MR/PR never ` +
            `reached a final state (success/failed/canceled). This looks like a stuck CI runner or queue, ` +
            `not something a code change can fix -- needs human attention.`,
          reasoningSummary: 'Deterministic pending-recheck budget exhausted, not an agent judgment.',
        }
        log(
          `[attempt ${attempt + 1}] pending-recheck budget exhausted (${maxPendingRechecks}) for MR ` +
            `${lastOpenMr.mrUrl} -- marking blocked`,
        )
        attemptLedger.push({ attempt: attempt + 1, stage: 'ship', status: 'blocked', ship: stuckShip })
        lastOpenMr = null
        return {
          implement: null,
          completeness: null,
          functionalReview: null,
          verifyChecks: null,
          ship: stuckShip,
          linterApproved: true,
        }
      }
      log(
        `[implement ${implementAttemptCount}/${maxIterations}, pending-recheck ${pendingRecheckCount}/${maxPendingRechecks}] ` +
          `MR ${lastOpenMr.mrUrl} from an earlier attempt is still unresolved -- skipping implement/review/verify, ` +
          `re-checking it directly`,
      )
      const monitorResult = await agent(monitorExistingMrPrompt(lastOpenMr, attempt), {
        label: `ship:${attempt + 1}`,
        schema: shipSchema,
        retries: 1,
        timeoutMs: SHIP_TIMEOUT_MS,
        model: modelOverride || defaultOtherStepsModel,
      })
      attemptLedger.push({
        attempt: attempt + 1,
        stage: 'ship',
        status: monitorResult ? monitorResult.status : 'missing',
        ship: monitorResult,
      })
      if (monitorResult && monitorResult.mrUrl && (monitorResult.status === 'pending' || monitorResult.status === 'blocked')) {
        lastOpenMr = { mrUrl: monitorResult.mrUrl, branch: monitorResult.branch }
      } else {
        lastOpenMr = null
      }
      return {
        implement: null,
        completeness: null,
        functionalReview: null,
        verifyChecks: null,
        ship: monitorResult,
        linterApproved: true,
      }
    }

    if (pendingShipRetry) {
      shipRetryCount += 1
      if (shipRetryCount > maxShipRetries) {
        const stuckShip = {
          status: 'blocked',
          monitorExitCode: null,
          branch: featureBranch,
          mrUrl: '',
          headCommitSha: '',
          notes:
            `Exceeded maxShipRetries (${maxShipRetries}) retrying the ship step's commit/push/open-MR ` +
            `mechanics with no CI/code failure involved -- this looks like a persistent tool/auth/network ` +
            `problem with the ship step itself, not something a code change can fix. Needs human attention.`,
          reasoningSummary: 'Deterministic ship-retry budget exhausted, not an agent judgment.',
        }
        log(`[ship-retry] budget exhausted (${maxShipRetries}) -- marking blocked`)
        attemptLedger.push({ attempt: attempt + 1, stage: 'ship-retry', status: 'blocked', ship: stuckShip })
        const exhaustedContext = pendingShipRetry
        pendingShipRetry = null
        return { implement: exhaustedContext.implement, completeness: exhaustedContext.completeness, functionalReview: exhaustedContext.functionalReview, verifyChecks: exhaustedContext.verifyChecks, ship: stuckShip, linterApproved: true }
      }

      log(
        `[ship-retry ${shipRetryCount}/${maxShipRetries}] previous ship attempt failed to commit/push/open ` +
          `the MR (not a CI/code failure) -- retrying ship only, no re-implementation`,
      )
      const { implement: implementResult, completeness, functionalReview, verifyChecks } = pendingShipRetry
      const shipRetryResult = await agent(shipPrompt(implementResult, attempt), {
        label: `ship:${attempt + 1}`,
        schema: shipSchema,
        retries: 1,
        timeoutMs: SHIP_TIMEOUT_MS,
        model: modelOverride || defaultOtherStepsModel,
      })
      attemptLedger.push({
        attempt: attempt + 1,
        stage: 'ship-retry',
        status: shipRetryResult ? shipRetryResult.status : 'missing',
        ship: shipRetryResult,
      })
      log(`[ship-retry ${shipRetryCount}/${maxShipRetries}] result: ${shipRetryResult ? shipRetryResult.status : 'missing'}`)

      if (shipRetryResult && shipRetryResult.status === 'blocked') {
      } else {
        pendingShipRetry = null
        if (shipRetryResult && shipRetryResult.status === 'pending' && shipRetryResult.mrUrl) {
          lastOpenMr = { mrUrl: shipRetryResult.mrUrl, branch: shipRetryResult.branch }
        }
      }
      return { implement: implementResult, completeness, functionalReview, verifyChecks, ship: shipRetryResult, linterApproved: true }
    }

    implementAttemptCount += 1
    if (implementAttemptCount > maxIterations) {
      const exhausted = {
        status: 'blocked',
        monitorExitCode: null,
        branch: featureBranch,
        mrUrl: '',
        headCommitSha: '',
        notes: `Exceeded maxIterations (${maxIterations}) real implementation attempts without a passing ship.`,
        reasoningSummary: 'Deterministic implement-attempt budget exhausted, not an agent judgment.',
      }
      attemptLedger.push({ attempt: attempt + 1, stage: 'implement', status: 'exhausted', ship: exhausted })
      return {
        implement: null,
        completeness: null,
        functionalReview: null,
        verifyChecks: null,
        ship: exhausted,
        linterApproved: true,
      }
    }

    const implementModelForThisAttempt = modelOverride
      ? modelOverride
      : implementAttemptCount > implementFallbackAfterAttempts
        ? implementFallbackModel
        : defaultImplementModel
    if (!modelOverride && implementAttemptCount === implementFallbackAfterAttempts + 1) {
      log(
        `[implement ${implementAttemptCount}/${maxIterations}] switching to fallback model ` +
          `'${implementFallbackModel}' after ${implementFallbackAfterAttempts} attempts on ${defaultImplementModel}`,
      )
    }
    log(`[implement ${implementAttemptCount}/${maxIterations}] implementing (model: ${implementModelForThisAttempt})...`)

    const implementResult = await agent(implementPrompt(feedback, attempt), {
      label: `implement:${attempt + 1}`,
      schema: implementSchema,
      retries: 10,
      timeoutMs: AGENT_TIMEOUT_MS,
      model: implementModelForThisAttempt,
    })

    if (implementResult === null) {
      log(`[implement ${implementAttemptCount}/${maxIterations}] implement produced no usable result`)
      attemptLedger.push({ attempt: attempt + 1, stage: 'implement', status: 'missing' })
      return { implement: null, completeness: null, functionalReview: null, verifyChecks: null, ship: null, linterApproved: null }
    }
    log(`[implement ${implementAttemptCount}/${maxIterations}] implement done: ${implementResult.summary}`)
    log(`[implement ${implementAttemptCount}/${maxIterations}] implement reasoning: ${reasonPreview(implementResult.reasoningSummary)}`)
    log(`[implement ${implementAttemptCount}/${maxIterations}] budget: spent=${budget.spent()}, remaining=${budget.remaining()}`)
    implementHistory.push({
      attempt: attempt + 1,
      summary: implementResult.summary,
      filesChanged: implementResult.filesChanged ?? [],
    })

    let linterApproved = true
    let linterReasoning = null
    const filesChanged = implementResult.filesChanged ?? []
    const linterFileDetected = filesChanged.some((f) => CONFIG_FILE_PATTERN.test(f))
    if (linterFileDetected && !implementResult.linterChangeRequested) {
      log(
        `[implement ${implementAttemptCount}/${maxIterations}] implementer reported filesChanged touching a ` +
          `linter/config file (${filesChanged.filter((f) => CONFIG_FILE_PATTERN.test(f)).join(', ')}) ` +
          `but did not set linterChangeRequested -- forcing validation anyway (self-report cannot be trusted alone)`,
      )
    }
    if (implementResult.linterChangeRequested || linterFileDetected) {
      log(`[implement ${implementAttemptCount}/${maxIterations}] linter/config change requested -- validating against the bead...`)
      const linterValidation = await agent(linterValidationPrompt(implementResult), {
        label: `linter-validation:${attempt + 1}`,
        schema: linterValidationSchema,
        disallowedToolNames: ['edit', 'write'],
        maxSchemaRetries: 4,
        model: modelOverride || defaultOtherStepsModel,
        retries: 1,
        timeoutMs: JUDGE_TIMEOUT_MS,
      })
      const justified = linterValidation?.justified === true
      linterReasoning = linterValidation?.reasoning ?? '(no reasoning provided)'
      log(
        `[implement ${implementAttemptCount}/${maxIterations}] linter validation: ${
          justified ? 'justified' : 'NOT justified'
        } -- ${reasonPreview(linterReasoning)}`,
      )
      if (!justified) {
        linterApproved = false
        linterRejectionCount += 1
        if (linterRejectionCount > 2) {
          throw new LinterChangeExhaustedError(
            `Linter/config change was judged NOT justified by the bead ${linterRejectionCount} times in a row ` +
              `(iteration ${attempt + 1}). Last reasoning: ${linterReasoning}. Aborting the workflow instead of ` +
              `continuing to retry the same rejected change.`,
          )
        }
      }
    }
    if (!linterApproved) {
      log(`[implement ${implementAttemptCount}/${maxIterations}] linter/config change judged unjustified -- re-implementing without it`)
      attemptLedger.push({
        attempt: attempt + 1,
        stage: 'linter-validation',
        status: 'rejected',
        rejectionCount: linterRejectionCount,
        reasoning: linterReasoning,
        implement: implementResult,
      })
      return {
        implement: implementResult,
        completeness: null,
        functionalReview: null,
        verifyChecks: null,
        ship: null,
        linterApproved: false,
        linterReasoning,
      }
    }

    log(`[implement ${implementAttemptCount}/${maxIterations}] running completeness check...`)

    const completeness = await agent(completenessPrompt(implementResult), {
      label: `completeness:${attempt + 1}`,
      schema: completenessSchema,
      disallowedToolNames: ['edit', 'write'],
      maxSchemaRetries: 4,
      model: modelOverride || defaultOtherStepsModel,
      retries: 1,
      timeoutMs: JUDGE_TIMEOUT_MS,
    })
    attemptLedger.push({
      attempt: attempt + 1,
      stage: 'completeness-check',
      status: completeness ? (completeness.complete ? 'complete' : 'incomplete') : 'advisory-unavailable',
      completeness,
    })
    log(
      `[implement ${implementAttemptCount}/${maxIterations}] completeness: ${
        completeness ? (completeness.complete ? 'complete' : `incomplete (${(completeness.missing ?? []).join(', ')})`) : 'unavailable'
      }`,
    )

    if (completeness && completeness.complete === false) {
      log(`[implement ${implementAttemptCount}/${maxIterations}] blocked before verify-checks/ship: acceptance criteria incomplete`)
      return { implement: implementResult, completeness, functionalReview: null, verifyChecks: null, ship: null, linterApproved: true }
    }

    log(`[implement ${implementAttemptCount}/${maxIterations}] running functional review (does the real diff match the actual spec)...`)

    const functionalReview = await agent(functionalReviewPrompt(implementResult), {
      label: `functional-review:${attempt + 1}`,
      schema: functionalReviewSchema,
      disallowedToolNames: ['edit', 'write'],
      maxSchemaRetries: 4,
      model: modelOverride || defaultOtherStepsModel,
      retries: 1,
      timeoutMs: JUDGE_TIMEOUT_MS,
    })
    attemptLedger.push({
      attempt: attempt + 1,
      stage: 'functional-review',
      status: functionalReview ? (functionalReview.approved ? 'approved' : 'rejected') : 'advisory-unavailable',
      functionalReview,
    })
    log(
      `[implement ${implementAttemptCount}/${maxIterations}] functional review: ${
        functionalReview
          ? functionalReview.approved
            ? 'approved'
            : `rejected (${(functionalReview.issues ?? []).join(', ')})`
          : 'unavailable'
      }`,
    )

    if (!functionalReview || functionalReview.approved === false) {
      log(`[implement ${implementAttemptCount}/${maxIterations}] blocked before verify-checks/ship: functional review did not approve the implementation`)
      return {
        implement: implementResult,
        completeness,
        functionalReview,
        verifyChecks: null,
        ship: null,
        linterApproved: true,
      }
    }

    log(`[implement ${implementAttemptCount}/${maxIterations}] running verify-checks (${checks.map((c) => c.name).join('/')})...`)

    const verifyChecks = await agent(verifyChecksPrompt(implementResult, attempt), {
      label: `verify-checks:${attempt + 1}`,
      schema: verifyChecksSchema,
      disallowedToolNames: ['edit', 'write'],
      maxSchemaRetries: 4,
      model: modelOverride || defaultOtherStepsModel,
      retries: 1,
      timeoutMs: VERIFY_TIMEOUT_MS,
    })

    if (verifyChecks === null) {
      log(`[implement ${implementAttemptCount}/${maxIterations}] verify-checks produced no usable result`)
      attemptLedger.push({ attempt: attempt + 1, stage: 'verify-checks', status: 'missing' })
      return { implement: implementResult, completeness, functionalReview, verifyChecks: null, ship: null, linterApproved: true }
    }

    const reportedGitTop = verifyChecks.gitTop.trim().replace(/\/+$/, '')
    const cwdNormalized = cwd.replace(/\/+$/, '')
    const gitTopMatchesCwd = reportedGitTop === cwdNormalized || cwdNormalized.startsWith(`${reportedGitTop}/`)
    if (!gitTopMatchesCwd) {
      throw new Error(
        `verify-checks ran against the wrong checkout -- expected ${cwd} (or a git repo containing it), but ` +
          `git rev-parse --show-toplevel reported ${verifyChecks.gitTop}. Aborting instead of shipping ` +
          `results verified against the wrong directory.`,
      )
    }

    const workingTreeClean = verifyChecks.gitStatusOutput.trim().length === 0
    const commitsAhead = Number.parseInt(verifyChecks.commitsAheadOutput.trim(), 10) || 0
    const diffEmpty = workingTreeClean && commitsAhead === 0
    if (workingTreeClean && commitsAhead > 0) {
      log(
        `[implement ${implementAttemptCount}/${maxIterations}] WARNING: working tree is clean but branch is ${commitsAhead} ` +
          `commit(s) ahead of origin/${prepareRepo.defaultBranch} -- the implementer committed despite being told ` +
          `not to. Proceeding to ship anyway since real work exists; this is a policy violation to flag, not a ` +
          `reason to skip shipping it.`,
      )
    }

    attemptLedger.push({
      attempt: attempt + 1,
      stage: 'verify-checks',
      status: diffEmpty ? 'no_change' : verifyChecks.allPassed ? 'passed' : 'failed',
      verifyChecks,
    })
    log(
      `[implement ${implementAttemptCount}/${maxIterations}] verify-checks: ${
        diffEmpty ? 'no diff' : verifyChecks.allPassed ? 'all passed' : 'failed'
      }`,
    )
    log(`[implement ${implementAttemptCount}/${maxIterations}] verify-checks reasoning: ${reasonPreview(verifyChecks.reasoningSummary)}`)
    log(`[implement ${implementAttemptCount}/${maxIterations}] budget: spent=${budget.spent()}, remaining=${budget.remaining()}`)

    if (diffEmpty && !verifyChecks.allPassed) {
      log(
        `[implement ${implementAttemptCount}/${maxIterations}] git diff was empty but some checks are still failing -- ` +
          `this is a pre-existing broken state in the repo, not a real "nothing to do"; blocking ship`,
      )
      return { implement: implementResult, completeness, functionalReview, verifyChecks, ship: null, linterApproved: true }
    }

    if (diffEmpty) {
      return {
        implement: implementResult,
        completeness,
        functionalReview,
        verifyChecks,
        ship: { status: 'no_change', notes: 'git diff was empty; no MR opened.' },
        linterApproved: true,
      }
    }

    if (!verifyChecks.allPassed) {
      return { implement: implementResult, completeness, functionalReview, verifyChecks, ship: null, linterApproved: true }
    }

    log(`[implement ${implementAttemptCount}/${maxIterations}] shipping (commit/MR/monitor)...`)

    const shipResult = await agent(shipPrompt(implementResult, attempt), {
      label: `ship:${attempt + 1}`,
      schema: shipSchema,
      retries: 1,
      timeoutMs: SHIP_TIMEOUT_MS,
      model: modelOverride || defaultOtherStepsModel,
    })

    attemptLedger.push({
      attempt: attempt + 1,
      stage: 'ship',
      status: shipResult ? shipResult.status : 'missing',
      ship: shipResult,
    })
    log(`[implement ${implementAttemptCount}/${maxIterations}] ship result: ${shipResult ? shipResult.status : 'missing'}`)
    if (shipResult) {
      log(`[implement ${implementAttemptCount}/${maxIterations}] ship reasoning: ${reasonPreview(shipResult.reasoningSummary)}`)
    }
    log(`[implement ${implementAttemptCount}/${maxIterations}] budget: spent=${budget.spent()}, remaining=${budget.remaining()}`)

    if (shipResult && shipResult.status === 'pending' && shipResult.mrUrl) {
      lastOpenMr = { mrUrl: shipResult.mrUrl, branch: shipResult.branch }
      pendingShipRetry = null
    } else if (shipResult && shipResult.status === 'blocked') {
      log(
        `[implement ${implementAttemptCount}/${maxIterations}] ship blocked on mechanics (not CI/code) -- ` +
          `will retry ship only on the next iteration`,
      )
      pendingShipRetry = { implement: implementResult, completeness, functionalReview, verifyChecks }
      lastOpenMr = null
    } else {
      lastOpenMr = null
      pendingShipRetry = null
    }

    return { implement: implementResult, completeness, functionalReview, verifyChecks, ship: shipResult, linterApproved: true }
  } catch (err) {
    if (err instanceof LinterChangeExhaustedError) {

      log(`[implement ${implementAttemptCount}/${maxIterations}] FATAL: ${err.message}`)
      attemptLedger.push({ attempt: attempt + 1, stage: 'linter-validation', status: 'exhausted', error: err.message })
      throw err
    }

    const message = err instanceof Error ? err.message : String(err)
    log(`[implement ${implementAttemptCount}/${maxIterations}] attempt threw and was caught: ${message}`)
    attemptLedger.push({ attempt: attempt + 1, stage: 'thunk-error', status: 'error', error: message })
    return {
      implement: null,
      completeness: null,
      functionalReview: null,
      verifyChecks: null,
      ship: null,
      linterApproved: null,
      thunkError: message,
    }
  }
  },

  (value) => {
    if (value.thunkError) {
      return {
        ok: false,
        feedback: `Previous attempt failed with an error and produced no result: ${value.thunkError}. Retry the implementation from scratch for this bead, making sure to call structured_output with every required field filled in before finishing.`,
      }
    }
    if (value.linterApproved === false) {
      return {
        ok: false,
        feedback:
          `The linter/config change was judged NOT justified by this bead. Reasoning: ${value.linterReasoning ?? '(none provided)'}. ` +
          `Revert the linter/config edit and re-implement the bead without touching linter/config files -- ` +
          `find an approach that respects the existing configuration.`,
      }
    }
    if (value.implement === null) {
      return evaluateShipOutcome(value.ship)
    }
    if (value.completeness && value.completeness.complete === false) {
      const missing = (value.completeness.missing ?? []).join(', ') || '(no specific list provided)'
      return {
        ok: false,
        feedback:
          `Acceptance criteria not yet complete -- missing: ${missing}. Continue implementing; ` +
          `do not stop until every acceptance criterion is addressed. Verification/shipping was ` +
          `intentionally skipped this attempt because the work is not done yet.`,
      }
    }
    if (!value.functionalReview || value.functionalReview.approved === false) {
      const issues =
        value.functionalReview && (value.functionalReview.issues ?? []).length > 0
          ? value.functionalReview.issues.join('\n- ')
          : '(functional reviewer produced no usable result)'
      return {
        ok: false,
        feedback:
          `Independent functional review found the real diff does NOT genuinely match the bead's actual ` +
          `requirements (this checks actual functional correctness, not just the acceptance-criteria checklist ` +
          `or lint/type/test tooling):\n- ${issues}\n\n` +
          `Fix these specific discrepancies against the real requirements. Verification/shipping was ` +
          `intentionally skipped this attempt because the functional review did not approve the implementation.`,
      }
    }
    if (value.verifyChecks === null) {
      return {
        ok: false,
        feedback: 'Pre-ship verification produced no usable result. Re-implement and ensure the checks can run.',
      }
    }
    if (!value.verifyChecks.allPassed) {
      const failing = (value.verifyChecks.results ?? [])
        .filter((r) => !r.passed)
        .map((r) => `${r.name} (exit ${r.exitCode}): ${r.output}`)
      const missingCriteria =
        value.completeness && value.completeness.complete === false && value.completeness.missing
          ? ` Also flagged as possibly incomplete: ${value.completeness.missing.join(', ')}.`
          : ''
      const noRealChange =
        (value.verifyChecks.gitStatusOutput ?? '').trim().length === 0 &&
        (Number.parseInt((value.verifyChecks.commitsAheadOutput ?? '').trim(), 10) || 0) === 0
      const emptyDiffNote = noRealChange
        ? ` NOTE: the diff was reported empty, but these checks still fail -- this is a pre-existing broken ` +
          `state in the repo (e.g. bad lint/type config or a failing test unrelated to your diff) that must ` +
          `be fixed before this bead can be considered done; an empty diff does not excuse failing checks.`
        : ''
      return {
        ok: false,
        feedback: `Pre-ship verification failed:\n${failing.join('\n')}${missingCriteria}${emptyDiffNote} Fix these and try again.`,
      }
    }
    return evaluateShipOutcome(value.ship)
  },

  { attempts: maxIterations + maxPendingRechecks + maxShipRetries },
  )
} catch (err) {
  if (err instanceof LinterChangeExhaustedError) {

    log(`Workflow FAILED: ${err.message}`)
    phase('Task Close')
    if (taskId) {
      log(`Task ${taskId} left open -- workflow aborted due to repeated unjustified linter/config changes.`)
    }
    return {
      beadId,
      beadInfo,
      repoPath: cwd,
      featureBranch,
      attemptLedger,
      iterations: attemptLedger.length,
      shipOk: false,
      ship: null,
      failureReason: err.message,
      alreadyVerified: false,
      verificationNote: `NOT verified -- workflow aborted before shipping: ${err.message}`,
    }
  }
  throw err
}

log(
  `Ship loop finished after ${gateOutcome.attempts} attempt(s): ok=${gateOutcome.ok}, ` +
    `final status=${gateOutcome.value?.ship?.status ?? 'unknown'}`,
)

if (!gateOutcome.ok) {
  log(`Ship loop exhausted after ${maxIterations} attempts without reaching success/no_change.`)
}

phase('Task Close')

if (taskId && gateOutcome.ok) {
  await agent(
    `Run TaskUpdate to mark the task complete. Command: TaskUpdate(taskId: "${taskId}", status: "completed")`,
    { label: 'close-task', retries: 1, timeoutMs: AGENT_TIMEOUT_MS },
  )
  log(`Task ${taskId} marked completed.`)
} else if (taskId) {
  log(`Task ${taskId} left open -- ship loop did not reach a verified success.`)
}

log(`Workflow complete. Token spend: ${budget.spent()}, remaining: ${budget.remaining()}`)

return {
  beadId,
  beadInfo,
  repoPath: cwd,
  featureBranch,
  attemptLedger,
  iterations: gateOutcome.attempts,
  shipOk: gateOutcome.ok,
  ship: gateOutcome.value?.ship ?? null,
  alreadyVerified: gateOutcome.ok,
  verificationNote: gateOutcome.ok
    ? 'Already verified by this workflow (lint/type/test gates + a green, mergeable CI pipeline for the shipped ' +
      'commit). Do not re-verify independently -- trust the ship field above.'
    : 'NOT verified -- shipOk is false. Inspect ship/attemptLedger before treating this as done.',
}
