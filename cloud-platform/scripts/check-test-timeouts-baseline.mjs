import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  PLATFORM_ROOT,
  ROOT,
  SCAN_SCOPE,
  scanSources,
  scanTestTimeouts
} from './check-test-timeouts-scan.mjs'

export const DEFAULT_BASELINE = path.join(PLATFORM_ROOT, 'scripts', 'test-timeouts-baseline.json')

// Location-independent key: file + form + hash(normalized call signature).
function contentKey(violation, context) {
  const digest = createHash('sha256')
    .update(context.signatures.get(violation))
    .digest('hex')
    .slice(0, 12)
  return `${violation.file}|${violation.form}|${digest}`
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024

function git(args, root) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER })
}

function inScanScope(file) {
  if (!file.endsWith('.ts')) {
    return false
  }
  const parts = file.split('/')
  if (parts[0] !== 'cloud-platform') {
    return false
  }
  if (parts[1] === 'test') {
    return true
  }
  if (parts[1] === 'apps' && parts.length >= 5 && parts[3] === 'test') {
    return true
  }
  return parts[1] === 'apps' && parts[3] === 'src' && file.endsWith('.test.ts')
}

export function headScopeFiles({ root = ROOT, ref = 'HEAD' } = {}) {
  const listed = git(
    ['ls-tree', '-r', '--name-only', '--full-tree', ref, '--', 'cloud-platform'],
    root
  )
  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => inScanScope(line))
    .sort()
}

// Scan committed content, so a dirty working tree cannot leak into the baseline (U297).
export function scanHeadSources({ root = ROOT, ref = 'HEAD' } = {}) {
  const files = headScopeFiles({ root, ref })
  if (files.length === 0) {
    throw new Error(`no test files matched the scan scope in ${ref}`)
  }
  const sources = files.map((file) => ({ file, source: git(['show', `${ref}:${file}`], root) }))
  return { ...scanSources(sources), ref }
}

function summarize(violations) {
  const byForm = {}
  for (const { form } of violations) {
    byForm[form] = (byForm[form] ?? 0) + 1
  }
  return byForm
}

function readBaseline(baselinePath) {
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const entries = parsed?.entries
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error(
      `${baselinePath}: legacy or invalid baseline; regenerate with --from-head or --update-baseline`
    )
  }
  const counts = new Map()
  for (const [key, count] of Object.entries(entries)) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`${baselinePath}: entry "${key}" must be a positive integer count`)
    }
    counts.set(key, count)
  }
  return counts
}

function writeBaseline(baselinePath, violations, contexts, scannedFiles) {
  const counts = new Map()
  for (const violation of violations) {
    const key = contentKey(violation, contexts.get(violation.file))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const entries = {}
  for (const key of [...counts.keys()].sort()) {
    entries[key] = counts.get(key)
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    scanner: 'cloud-platform/scripts/check-test-timeouts.mjs',
    scanScope: SCAN_SCOPE,
    scannedFiles,
    counts: { total: violations.length, byForm: summarize(violations) },
    entries
  }
  mkdirSync(path.dirname(baselinePath), { recursive: true })
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

function baselineTotal(baseline) {
  let total = 0
  for (const count of baseline.values()) {
    total += count
  }
  return total
}

// New violation = the occurrence count for its content key exceeds the baselined count.
function findNewViolations(violations, contexts, baseline) {
  const seen = new Map()
  const newViolations = []
  for (const violation of violations) {
    const key = contentKey(violation, contexts.get(violation.file))
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count > (baseline.get(key) ?? 0)) {
      newViolations.push(violation)
    }
  }
  return newViolations
}

export function checkTestTimeouts({
  files = [],
  baselinePath = DEFAULT_BASELINE,
  updateBaseline = false,
  fromHead = false,
  checkOnly = false,
  headRoot = ROOT,
  root = ROOT
}) {
  const scanned = fromHead
    ? scanHeadSources({ root: headRoot })
    : (() => {
        const result = scanTestTimeouts({ files, root })
        return {
          violations: result.violations,
          contexts: result.contexts,
          scannedFiles: files.length
        }
      })()
  const created = !existsSync(baselinePath)
  const rewrite = (created || updateBaseline || fromHead) && !checkOnly
  const base = { violations: scanned.violations, baselinePath, scannedFiles: scanned.scannedFiles }
  if (rewrite) {
    const payload = writeBaseline(
      baselinePath,
      scanned.violations,
      scanned.contexts,
      scanned.scannedFiles
    )
    return {
      ...base,
      exitCode: 0,
      newViolations: [],
      baselineWritten: true,
      baselineCount: payload.counts.total,
      source: fromHead ? scanned.ref : 'worktree'
    }
  }
  const baseline = readBaseline(baselinePath)
  const newViolations = findNewViolations(scanned.violations, scanned.contexts, baseline)
  return {
    ...base,
    exitCode: newViolations.length === 0 ? 0 : 1,
    newViolations,
    baselineWritten: false,
    baselineCount: baselineTotal(baseline),
    source: fromHead ? scanned.ref : 'worktree'
  }
}
