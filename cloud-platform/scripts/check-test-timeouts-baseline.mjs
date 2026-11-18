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
import {
  NODE_TEST_IMPORT_GREP,
  SCAN_EXCLUSIONS,
  SOURCE_EXTENSIONS,
  committedRunnerTargets,
  importsNodeTest,
  isExcluded,
  runnerTokens
} from './check-test-timeouts-scope.mjs'

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

// U315: import/require pattern, evaluated by git grep against committed content.
// U324: the pattern is a loose enumeration prefilter (it can also match mentions
// inside strings/comments); every candidate is re-verified with `importsNodeTest()`
// against its committed content, so HEAD scope and worktree scope agree. U317 ⑤: the
// pattern is exported by the scope module, shared with the worktree RegExp.
const SOURCE_PATHSPECS = [...SOURCE_EXTENSIONS].map((extension) => `*${extension}`)

function gitOrEmpty(args, root) {
  try {
    return git(args, root)
  } catch (error) {
    // git grep exits 1 when there is simply no match.
    if (error.status === 1) {
      return ''
    }
    throw error
  }
}

// Committed scope: importers are found without reading every blob; runner
// references come from the committed package.json files and are intersected with the
// committed file list, so a dirty worktree cannot invent files. Evidence trees are
// excluded exactly as in the worktree.
export function headScopeFiles({ root = ROOT, ref = 'HEAD', exclusions = SCAN_EXCLUSIONS } = {}) {
  const listed = git(['ls-tree', '-r', '--name-only', '--full-tree', ref], root)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const listedSet = new Set(listed)
  const grepped = gitOrEmpty(
    [
      'grep',
      '-l',
      '-I',
      '-E',
      '-e',
      NODE_TEST_IMPORT_GREP,
      ref,
      '--',
      ...SOURCE_PATHSPECS
    ],
    root
  )
  const files = new Set()
  for (const line of grepped.split('\n')) {
    const entry = line.trim()
    if (entry.length === 0) {
      continue
    }
    const prefix = `${ref}:`
    const file = entry.startsWith(prefix) ? entry.slice(prefix.length) : entry
    if (!listedSet.has(file) || isExcluded(file, exclusions)) {
      continue
    }
    // U324: git grep prefiltered by text; comments and string literals can contain
    // the same spelling, so confirm the keyword is code in committed content.
    let source
    try {
      source = git(['show', `${ref}:${file}`], root)
    } catch {
      continue
    }
    if (importsNodeTest(source)) {
      files.add(file)
    }
  }
  // U317 ③: read the committed manifests, never the worktree ones.
  for (const manifestPath of listed) {
    if (
      path.posix.basename(manifestPath) !== 'package.json' ||
      isExcluded(manifestPath, exclusions)
    ) {
      continue
    }
    let manifest
    try {
      manifest = JSON.parse(git(['show', `${ref}:${manifestPath}`], root))
    } catch {
      continue
    }
    const directory = path.posix.dirname(manifestPath)
    for (const token of runnerTokens(manifest)) {
      for (const file of committedRunnerTargets(
        directory === '.' ? '' : directory,
        token,
        listed
      )) {
        if (SOURCE_EXTENSIONS.has(path.posix.extname(file)) && !isExcluded(file, exclusions)) {
          files.add(file)
        }
      }
    }
  }
  return [...files].sort()
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
  return {
    counts,
    scannedFiles: Number.isInteger(parsed.scannedFiles) ? parsed.scannedFiles : null
  }
}

function countByContentKey(violations, contexts) {
  const counts = new Map()
  for (const violation of violations) {
    const key = contentKey(violation, contexts.get(violation.file))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function writeBaseline(baselinePath, violations, contexts, scannedFiles) {
  const counts = countByContentKey(violations, contexts)
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

// Non-failing report: keys whose current count fell below the baseline (tighten candidates).
function findStaleKeys(counts, baseline) {
  const stale = []
  for (const [key, count] of baseline) {
    const current = counts.get(key) ?? 0
    if (current < count) {
      stale.push({ key, baselineCount: count, currentCount: current })
    }
  }
  return stale.sort((a, b) => a.key.localeCompare(b.key))
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
          scannedFiles: result.scannedFiles
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
      staleKeys: [],
      baselineWritten: true,
      baselineCount: payload.counts.total,
      source: fromHead ? scanned.ref : 'worktree'
    }
  }
  const baseline = readBaseline(baselinePath)
  const currentCounts = countByContentKey(scanned.violations, scanned.contexts)
  const newViolations = findNewViolations(scanned.violations, scanned.contexts, baseline.counts)
  // U317 ④: surface scope drift explicitly rather than letting a silently different
  // file set pass as an ordinary clean check. This is a hint, not a failure: the
  // pinned scope test is what fails when the intended scope moves.
  const scopeMismatch =
    baseline.scannedFiles === null || baseline.scannedFiles === scanned.scannedFiles
      ? null
      : { baselineScannedFiles: baseline.scannedFiles, scannedFiles: scanned.scannedFiles }
  return {
    ...base,
    exitCode: newViolations.length === 0 ? 0 : 1,
    newViolations,
    staleKeys: findStaleKeys(currentCounts, baseline.counts),
    baselineWritten: false,
    baselineCount: baselineTotal(baseline.counts),
    scopeMismatch,
    source: fromHead ? scanned.ref : 'worktree'
  }
}
