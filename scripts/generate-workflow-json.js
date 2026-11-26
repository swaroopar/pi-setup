#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const WORKFLOWS_DIR = path.join(__dirname, '..', 'workflows')
const LIB_SKILL_DIR = path.join(__dirname, '..', 'skills', 'lib')
const USER_SAVED_DIR = path.join(os.homedir(), '.pi', 'workflows', 'saved')
const MONITOR_SCRIPTS = ['monitor-mr-gitlab.sh', 'monitor-mr-github.sh']

function extractMeta(source, sourcePath) {
  const metaKeywordIndex = source.indexOf('export const meta')
  if (metaKeywordIndex === -1) {
    throw new Error(`${sourcePath}: no "export const meta = {...}" found`)
  }

  const braceStart = source.indexOf('{', metaKeywordIndex)
  if (braceStart === -1) {
    throw new Error(`${sourcePath}: found "export const meta" but no opening "{"`)
  }

  let depth = 0
  let braceEnd = -1
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        braceEnd = i
        break
      }
    }
  }
  if (braceEnd === -1) {
    throw new Error(`${sourcePath}: unbalanced braces while scanning meta object`)
  }

  const metaLiteral = source.slice(braceStart, braceEnd + 1)
  let meta
  try {
    meta = new Function(`return (${metaLiteral})`)()
  } catch (err) {
    throw new Error(`${sourcePath}: failed to evaluate meta object literal: ${err.message}`)
  }

  if (!meta || typeof meta !== 'object' || typeof meta.name !== 'string' || typeof meta.description !== 'string') {
    throw new Error(`${sourcePath}: meta must be an object with string "name" and "description" fields`)
  }

  return meta
}

function generateWorkflowJson(inputPath) {
  const source = fs.readFileSync(inputPath, 'utf8')
  const meta = extractMeta(source, inputPath)
  return {
    name: meta.name,
    description: meta.description,
    script: source,
  }
}

function copyMonitorScripts() {
  for (const file of MONITOR_SCRIPTS) {
    const inputPath = path.join(LIB_SKILL_DIR, file)
    if (!fs.existsSync(inputPath)) {
      throw new Error(`${inputPath}: expected monitor script not found`)
    }
    const outputPath = path.join(USER_SAVED_DIR, file)
    fs.copyFileSync(inputPath, outputPath)
    fs.chmodSync(outputPath, 0o755)
    console.log(`Wrote ${outputPath}`)
  }
}

function main() {
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.js'))
  if (files.length === 0) {
    console.error(`No workflow .js files found in ${WORKFLOWS_DIR}`)
    process.exit(1)
  }

  fs.mkdirSync(USER_SAVED_DIR, { recursive: true })

  for (const file of files) {
    const inputPath = path.join(WORKFLOWS_DIR, file)
    const payload = generateWorkflowJson(inputPath)
    const outputPath = path.join(USER_SAVED_DIR, `${payload.name}.json`)
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    console.log(`Wrote ${outputPath} (name="${payload.name}")`)
  }

  // bead-shipper-workflow.js instructs the user to run these from ~/.pi/workflows/saved/,
  // so they need to live alongside the generated workflow JSON, not just in skills/lib/.
  copyMonitorScripts()
}

if (require.main === module) {
  main()
}

module.exports = { generateWorkflowJson, extractMeta, copyMonitorScripts }
