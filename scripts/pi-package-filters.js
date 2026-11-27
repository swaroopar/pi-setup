'use strict'

const fs = require('fs')
const path = require('path')

const FILTER_KEYS = ['extensions', 'skills', 'prompts', 'themes']

const sourceOf = (entry) => (typeof entry === 'string' ? entry : entry.source)
const isRemoteSource = (source) => /^(npm|git):/.test(source)

function canonicalPath(dir) {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

function declaredFilters(declared) {
  const filters = {}
  for (const key of FILTER_KEYS) {
    if (declared[key] !== undefined) filters[key] = declared[key]
  }
  return filters
}

function packageEntriesWithFilters({ entries, declaredPackages, thisRepoFilters, thisRepoDir, settingsDir }) {
  const next = [...entries]
  const warnings = []
  const setFilters = (index, filters) => {
    next[index] = { source: sourceOf(next[index]), ...filters }
  }

  for (const declared of declaredPackages) {
    const filters = declaredFilters(declared)
    if (Object.keys(filters).length === 0) continue
    const index = next.findIndex((entry) => sourceOf(entry) === declared.source)
    if (index === -1) warnings.push(`${declared.source} has filters in packages.json but isn't installed in pi -- skipping`)
    else setFilters(index, filters)
  }

  const thisRepo = canonicalPath(thisRepoDir)
  const thisRepoIndex = next.findIndex((entry) => {
    const source = sourceOf(entry)
    return !isRemoteSource(source) && canonicalPath(path.resolve(settingsDir, source)) === thisRepo
  })
  if (thisRepoIndex === -1) warnings.push(`this repo (${thisRepoDir}) isn't installed in pi -- run \`pi install .\` first`)
  else setFilters(thisRepoIndex, thisRepoFilters)

  return { entries: next, warnings }
}

module.exports = { packageEntriesWithFilters }
