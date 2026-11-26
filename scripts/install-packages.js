#!/usr/bin/env node
'use strict'

// Bulk-installs the npm:/git: pi packages listed in extensions/packages.json via `pi install
// <source>`, then applies any resource filters (extensions/skills/prompts/themes) declared there
// by writing pi's documented object form for a `packages` entry directly into
// ~/.pi/agent/settings.json -- see "Package Filtering" in `pi`'s docs/packages.md. This replaces
// having to open `pi config`'s TUI by hand.
// Skips sources `pi list` already reports as installed, so it's safe to re-run.

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT_DIR = path.join(__dirname, '..')
const SETTINGS_PATH = path.join(os.homedir(), '.pi', 'agent', 'settings.json')
const FILTER_KEYS = ['extensions', 'skills', 'prompts', 'themes']

const packages = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'extensions', 'packages.json'), 'utf8'))

function installedSources() {
  const output = execFileSync('pi', ['list'], { encoding: 'utf8' })
  return new Set(
    output
      .split('\n')
      .map((line) => line.match(/^\s{2}(npm:|git:)\S+/)?.[0]?.trim())
      .filter(Boolean)
  )
}

const installed = installedSources()

for (const { source, description } of packages) {
  if (installed.has(source)) {
    console.log(`skip (already installed): ${source}`)
    continue
  }
  console.log(`installing: ${source} -- ${description}`)
  execFileSync('pi', ['install', source], { stdio: 'inherit' })
}

const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
let settingsChanged = false

for (const entry of packages) {
  const filters = {}
  for (const key of FILTER_KEYS) {
    if (entry[key] !== undefined) filters[key] = entry[key]
  }
  if (Object.keys(filters).length === 0) continue

  const idx = settings.packages.findIndex((p) => (typeof p === 'string' ? p : p.source) === entry.source)
  if (idx === -1) {
    console.warn(`warning: ${entry.source} has filters in packages.json but isn't in ${SETTINGS_PATH} -- skipping`)
    continue
  }

  const next = { source: entry.source, ...filters }
  if (JSON.stringify(settings.packages[idx]) !== JSON.stringify(next)) {
    settings.packages[idx] = next
    settingsChanged = true
    console.log(`applied resource filter for ${entry.source}`)
  }
}

if (settingsChanged) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
  console.log(`updated ${SETTINGS_PATH}`)
}
