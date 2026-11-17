#!/usr/bin/env node
// Evidence-integrity gate (§3a): required files exist, are non-empty, JSON parses, and are fresh.
// Usage: node validate-evidence.mjs <evidence-dir> [--require=a.json,b.log] [--max-age-hours=24] [--check-generated-at] [--json]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_REQUIRED = ['summary.json', 'results.json']
const HOUR_MS = 60 * 60 * 1000

export function parseRequireFlag(value) {
  if (value == null) {
    return []
  }
  const names = String(value)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.length === 0) {
    throw new Error('--require needs at least one file name')
  }
  return [...new Set(names)]
}

export function parseArgs(argv) {
  const positional = []
  let requireValue
  let maxAgeHours = null
  let json = false
  let checkGeneratedAt = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      json = true
    } else if (arg === '--check-generated-at') {
      checkGeneratedAt = true
    } else if (arg.startsWith('--require=')) {
      requireValue = arg.slice('--require='.length)
    } else if (arg === '--require') {
      requireValue = argv[(index += 1)]
    } else if (arg.startsWith('--max-age-hours=')) {
      maxAgeHours = parseMaxAge(arg.slice('--max-age-hours='.length))
    } else if (arg === '--max-age-hours') {
      maxAgeHours = parseMaxAge(argv[(index += 1)])
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`)
    } else {
      positional.push(arg)
    }
  }

  if (positional.length !== 1) {
    throw new Error('expected exactly one <evidence-dir>')
  }
  return {
    dir: positional[0],
    required: parseRequireFlag(requireValue),
    maxAgeHours,
    checkGeneratedAt,
    json
  }
}

function parseMaxAge(value) {
  const hours = Number(value)
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`invalid --max-age-hours: ${value}`)
  }
  return hours
}

function isJsonFile(name) {
  return name.toLowerCase().endsWith('.json')
}

function isNonEmpty(entry, name) {
  if (entry.size <= 0) {
    return false
  }
  return isJsonFile(name) ? entry.text.trim().length > 0 : true
}

// Pure: `dirEntries` are { name, size, mtimeMs, text }. Returns issue objects, never throws.
export function collectEvidenceIssues(
  dirEntries,
  required = [],
  { now = Date.now(), maxAgeHours = null, checkGeneratedAt = false } = {}
) {
  const issues = []
  const byName = new Map(dirEntries.map((entry) => [entry.name, entry]))

  if (required.length > 0) {
    for (const name of required) {
      issues.push(...inspectFile(byName.get(name), name))
    }
  } else {
    issues.push(...inspectDefaultGroup(byName))
  }

  const latestMtime = latestMtimeMs(dirEntries)
  if (maxAgeHours != null && latestMtime != null) {
    const ageHours = (now - latestMtime) / HOUR_MS
    if (ageHours > maxAgeHours) {
      issues.push({
        code: 'stale',
        file: null,
        message: `newest file is ${ageHours.toFixed(1)}h old (limit ${maxAgeHours}h)`
      })
    }
  }

  if (checkGeneratedAt) {
    issues.push(...inspectGeneratedAt(byName.get('summary.json'), { now, maxAgeHours }))
  }

  return { issues, latestMtime }
}

const ISO_DATETIME_PREFIX = /^\d{4}-\d{2}-\d{2}T/

// mtime can be refreshed by backfilling; generatedAt is the durable freshness signal.
function inspectGeneratedAt(entry, { now, maxAgeHours }) {
  if (!entry) {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(entry.text)
  } catch {
    return [
      {
        code: 'summary-generated-at-invalid',
        file: 'summary.json',
        message: 'summary.json is not valid JSON, so generatedAt cannot be read'
      }
    ]
  }
  const value = parsed && typeof parsed === 'object' ? parsed.generatedAt : undefined
  if (value == null) {
    return [
      {
        code: 'summary-generated-at-missing',
        file: 'summary.json',
        message: 'summary.json has no generatedAt (backfilled summaries must declare it)'
      }
    ]
  }
  if (
    typeof value !== 'string' ||
    !ISO_DATETIME_PREFIX.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return [
      {
        code: 'summary-generated-at-invalid',
        file: 'summary.json',
        message: `generatedAt is not a parseable ISO timestamp: ${JSON.stringify(value)}`
      }
    ]
  }
  if (maxAgeHours != null) {
    const ageHours = (now - Date.parse(value)) / HOUR_MS
    if (ageHours > maxAgeHours) {
      return [
        {
          code: 'summary-generated-at-stale',
          file: 'summary.json',
          message: `generatedAt is ${ageHours.toFixed(1)}h old (limit ${maxAgeHours}h)`
        }
      ]
    }
  }
  return []
}

function inspectDefaultGroup(byName) {
  const present = DEFAULT_REQUIRED.map((name) => [name, byName.get(name)]).filter(
    ([, entry]) => entry
  )
  if (present.length === 0) {
    return [
      {
        code: 'no-required-json',
        file: DEFAULT_REQUIRED.join(' | '),
        message: `missing required evidence: at least one of ${DEFAULT_REQUIRED.join(', ')}`
      }
    ]
  }

  const candidateIssues = present.map(([name, entry]) => ({
    name,
    issues: inspectFile(entry, name)
  }))
  if (candidateIssues.some(({ issues }) => issues.length === 0)) {
    return []
  }
  return candidateIssues.flatMap(({ issues }) => issues)
}

function inspectFile(entry, name) {
  if (!entry) {
    return [{ code: 'missing', file: name, message: `missing required file: ${name}` }]
  }
  const issues = []
  if (!isNonEmpty(entry, name)) {
    issues.push({ code: 'empty', file: name, message: `empty required file: ${name}` })
    return issues
  }
  if (isJsonFile(name)) {
    try {
      JSON.parse(entry.text)
    } catch (error) {
      issues.push({
        code: 'invalid-json',
        file: name,
        message: `invalid JSON in ${name}: ${error.message}`
      })
    }
  }
  return issues
}

function latestMtimeMs(dirEntries) {
  const mtimes = dirEntries.map((entry) => entry.mtimeMs).filter(Number.isFinite)
  return mtimes.length > 0 ? Math.max(...mtimes) : null
}

// IO shell: reads the directory and feeds the pure collector.
export function validateEvidenceDir(dir, required = [], options = {}) {
  let dirents
  try {
    dirents = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return {
      ok: false,
      issues: [
        { code: 'dir-missing', file: dir, message: `cannot read evidence dir: ${error.message}` }
      ],
      latestMtime: null
    }
  }

  const dirEntries = []
  const fileIssues = []
  for (const dirent of dirents) {
    if (!dirent.isFile()) {
      continue
    }
    const path = join(dir, dirent.name)
    try {
      const stat = statSync(path)
      // Only required JSON needs content; read lazily-ish by suffix to keep large logs out of memory.
      const text = isJsonFile(dirent.name) ? readFileSync(path, 'utf8') : ''
      dirEntries.push({ name: dirent.name, size: stat.size, mtimeMs: stat.mtimeMs, text })
    } catch (error) {
      fileIssues.push({ code: 'unreadable', file: dirent.name, message: error.message })
    }
  }

  const { issues, latestMtime } = collectEvidenceIssues(dirEntries, required, options)
  const allIssues = [...fileIssues, ...issues]
  return { ok: allIssues.length === 0, issues: allIssues, latestMtime }
}

function printHuman(dir, result) {
  const status = result.ok ? 'PASS' : 'FAIL'
  console.log(`${status} evidence: ${dir}`)
  if (result.latestMtime != null) {
    console.log(`newest mtime: ${new Date(result.latestMtime).toISOString()}`)
  }
  for (const issue of result.issues) {
    console.log(`  [${issue.code}] ${issue.message}`)
  }
}

function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(`validate-evidence: ${error.message}`)
    console.error(
      'usage: validate-evidence.mjs <evidence-dir> [--require=a,b] [--max-age-hours=24] [--check-generated-at] [--json]'
    )
    return 1
  }

  const result = validateEvidenceDir(args.dir, args.required, {
    maxAgeHours: args.maxAgeHours,
    checkGeneratedAt: args.checkGeneratedAt
  })
  if (args.json) {
    console.log(JSON.stringify({ dir: args.dir, ...result }, null, 2))
  } else {
    printHuman(args.dir, result)
  }
  return result.ok ? 0 : 1
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  process.exit(main())
}
