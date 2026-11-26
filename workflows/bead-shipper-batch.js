export const meta = {
  name: 'bead_shipper_batch',
  description:
    'Ships every bead currently returned by `bd ready` (checked once at the start of this run, not re-checked mid-batch), one after another, by calling the existing bead-shipper-workflow saved workflow (loaded by its saved name `bead_shipper`) once per bead (unmodified -- this workflow only wraps it). Pass the exact same args you would give bead_shipper (targetBranch, setupCommand, checks, configFilePatterns, model/otherStepsModel/implementModel/implementFallbackModel/implementFallbackAfterAttempts, maxIterations, maxPendingRechecks, maxShipRetries, shipTimeoutMs, taskId, etc.) -- every field is passed through to each child run UNCHANGED except beadId, which is ignored if given and instead taken per-bead from `bd ready --json`. No model name is ever assumed by default: this workflow\'s own bd-ready/bd-show/bd-reopen query steps require `model` or `otherStepsModel` in the input JSON (same rule bead_shipper enforces for its own steps), and throw immediately if neither is given. Batch-only args: `maxBeads` (caps how many ready beads this run ships, default unlimited) and `stopOnFirstFailure` (default false -- when true, a child workflow throwing aborts the whole batch instead of continuing to the next bead). After each child run, this workflow independently re-checks the bead\'s status via `bd show` and, if it comes back "closed" (bead_shipper never closes bd beads itself -- it only ever leaves the MR open for human review, so a closed bead means something closed it out-of-band, most likely an implement-step agent proactively running `bd close`), immediately runs `bd reopen` on it and logs a loud warning to investigate -- this never aborts the batch, reopening is always attempted best-effort and the batch simply continues. By default every `bd` call this workflow makes (and the ones it passes through to each `bead_shipper` child run) auto-discovers `.beads/*.db` from this checkout; pass `beadsDir` (an absolute path) when the beads database actually lives elsewhere -- e.g. a dedicated bead-workspace checked out under the user\'s home directory -- and it is appended as `bd`\'s own `-C <beadsDir>` flag everywhere, including the child runs (it passes through unchanged in passthroughArgs).',
  phases: [{ title: 'Discover Ready Beads' }, { title: 'Ship Each Bead' }],
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
      log('Parsed a JSON object from the raw command text -- using it as this run\'s args.')
    }
  } catch (err) {
    log(`Raw command text looked like JSON but failed to parse (${err.message}) -- falling back to key=value args.`)
  }
}
if (typeof resolvedArgs !== 'object' || resolvedArgs === null || Array.isArray(resolvedArgs)) {
  resolvedArgs = {}
}

if (resolvedArgs.beadId) {
  log(`Ignoring beadId="${resolvedArgs.beadId}" passed to bead_shipper_batch -- beadId is taken per-bead from ` + '\`bd ready\`, not from args, for a batch run.')
}

const maxBeads = Number.isInteger(resolvedArgs.maxBeads) ? Math.max(1, resolvedArgs.maxBeads) : null
const stopOnFirstFailure = resolvedArgs.stopOnFirstFailure === true

const beadsDir =
  typeof resolvedArgs.beadsDir === 'string' && resolvedArgs.beadsDir.trim() ? resolvedArgs.beadsDir.trim() : undefined
const BD_DIR_FLAG = beadsDir ? ` -C ${beadsDir}` : ''

const { beadId: _ignoredBeadId, maxBeads: _ignoredMaxBeads, stopOnFirstFailure: _ignoredStop, _raw: _ignoredRaw, ...passthroughArgs } =
  resolvedArgs

const QUERY_TIMEOUT_MS = 5 * 60 * 1000
const queryModel =
  (typeof resolvedArgs.model === 'string' && resolvedArgs.model.trim()) ||
  (typeof resolvedArgs.otherStepsModel === 'string' && resolvedArgs.otherStepsModel.trim()) ||
  undefined
if (!queryModel) {
  throw new Error(
    'Either `model` or `otherStepsModel` is required (no default model name is assumed) -- pass one of them ' +
      'so the bd-ready/bd-show/bd-reopen query steps this workflow runs itself have a model to use.',
  )
}

const readyBeadsSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['id', 'title', 'status'],
      },
    },
  },
  required: ['items'],
}

const beadStatusSchema = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    raw: { type: 'string' },
  },
  required: ['status', 'raw'],
}

async function checkBeadStatus(beadId, label) {
  const result = await agent(
    `Run bd${BD_DIR_FLAG} show ${beadId} --json and report the exact "status" field value from the first/only issue in ` +
      `the output (e.g. "open", "in_progress", "closed", "blocked"), plus the complete raw command output.`,
    {
      label,
      schema: beadStatusSchema,
      disallowedToolNames: ['edit', 'write'],
      retries: 2,
      timeoutMs: QUERY_TIMEOUT_MS,
      model: queryModel,
    },
  )
  if (!result) {
    throw new Error(`Failed to check the status of bead ${beadId} via \`bd show\` -- aborting (cannot verify it wasn't closed).`)
  }
  return result.status
}

phase('Discover Ready Beads')

const readyBeads = await agent(
  `Run bd${BD_DIR_FLAG} ready --json and report every ready issue as items: [{id, title, status}], taken directly from ` +
    `that command's JSON output. If it returns an empty JSON array, report items: [].`,
  {
    label: 'list-ready-beads',
    schema: readyBeadsSchema,
    disallowedToolNames: ['edit', 'write'],
    retries: 2,
    timeoutMs: QUERY_TIMEOUT_MS,
    model: queryModel,
  },
)

if (!readyBeads) {
  throw new Error(
    'Failed to list ready beads via `bd ready` -- check that bd is configured' +
      (beadsDir ? ` at beadsDir="${beadsDir}".` : ' in this checkout.'),
  )
}

let beadsToShip = readyBeads.items
if (maxBeads !== null) {
  beadsToShip = beadsToShip.slice(0, maxBeads)
}

log(
  `Found ${readyBeads.items.length} ready bead(s)` +
    (maxBeads !== null ? `, shipping up to ${maxBeads} this run.` : ', shipping all of them this run.'),
)

phase('Ship Each Bead')

const results = []
for (const bead of beadsToShip) {
  log(`--- Shipping bead ${bead.id}: ${bead.title} ---`)

  const statusBefore = await checkBeadStatus(bead.id, `bead-status-before:${bead.id}`)
  if (statusBefore === 'closed') {
    log(`Bead ${bead.id} is already closed -- skipping without shipping.`)
    results.push({ beadId: bead.id, skipped: true, reason: 'already closed before shipping' })
    continue
  }

  let childResult
  try {
    childResult = await workflow('bead_shipper', { ...passthroughArgs, beadId: bead.id })
  } catch (err) {
    log(`Bead ${bead.id}: child workflow threw: ${err.message}`)
    results.push({ beadId: bead.id, shipOk: false, error: err.message })
    if (stopOnFirstFailure) {
      throw new Error(`Aborting batch after bead ${bead.id} failed (stopOnFirstFailure=true): ${err.message}`)
    }
    continue
  }

  const statusAfter = await checkBeadStatus(bead.id, `bead-status-after:${bead.id}`)
  let closedAndReopened = false
  let finalStatus = statusAfter
  if (statusAfter === 'closed') {
    log(
      `CRITICAL: bead ${bead.id} was closed during shipping (status went from "${statusBefore}" to "closed") ` +
        `even though bead-shipper-workflow never closes bd beads itself. Reopening it now via \`bd reopen\`.`,
    )
    const reopenResult = await agent(
      `Run bd${BD_DIR_FLAG} reopen ${bead.id} and then bd${BD_DIR_FLAG} show ${bead.id} --json to confirm it worked. Report the exact ` +
        `"status" field value after reopening, plus the complete raw command output of both commands.`,
      {
        label: `bead-reopen:${bead.id}`,
        schema: beadStatusSchema,
        disallowedToolNames: ['edit', 'write'],
        retries: 2,
        timeoutMs: QUERY_TIMEOUT_MS,
        model: queryModel,
      },
    )
    finalStatus = reopenResult?.status ?? 'unknown'
    closedAndReopened = true
    if (!reopenResult || finalStatus === 'closed') {
      log(
        `WARNING: reopen attempt for bead ${bead.id} did not confirm success (status now "${finalStatus}") -- ` +
          `continuing the batch anyway; check \`bd show ${bead.id}\` manually.`,
      )
    } else {
      log(
        `Bead ${bead.id} reopened successfully (status now "${finalStatus}"). Continuing the batch, but this ` +
          `still indicates a real bug -- investigate what closed it before relying on this again.`,
      )
    }
  }

  results.push({
    beadId: bead.id,
    shipOk: childResult?.shipOk ?? false,
    ship: childResult?.ship ?? null,
    statusAfter: finalStatus,
    closedAndReopened,
  })
  log(
    `Bead ${bead.id} done: shipOk=${childResult?.shipOk ?? false}, status "${finalStatus}"` +
      (closedAndReopened ? ' (was closed, reopened -- investigate).' : ' (confirmed not closed).'),
  )
}

log(`Batch complete: ${results.length}/${beadsToShip.length} ready bead(s) processed.`)

const closedAndReopenedBeadIds = results.filter((r) => r.closedAndReopened).map((r) => r.beadId)
if (closedAndReopenedBeadIds.length > 0) {
  log(
    `WARNING: ${closedAndReopenedBeadIds.length} bead(s) were unexpectedly closed during shipping and had to ` +
      `be reopened: ${closedAndReopenedBeadIds.join(', ')}. This is not expected behavior -- investigate.`,
  )
}

return {
  totalReady: readyBeads.items.length,
  shippedCount: results.length,
  closedAndReopenedBeadIds,
  results,
}
