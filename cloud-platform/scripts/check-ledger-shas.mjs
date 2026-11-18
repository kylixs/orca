#!/usr/bin/env node
// U58: a ledger row citing a commit that does not exist is a silent fabrication;
// resolve every backticked short sha against this repo's object database.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

const DEFAULT_FILE = resolve(
  REPO_ROOT,
  'remote-connectivity/design/2026-11-13-cloud-dev-platform/defect-ledger.md'
)
// Whole-span matching only: a path like `evidence/w9-head-20261117-091324/summary.json`
// or a truncated `cf75751c…` must not yield its inner digit run as a candidate.
const SHA_SPAN = /^[0-9a-fA-F]{7,40}$/

/** Backticked spans that are exactly a 7-40 char hex string, with 1-based lines. */
export function extractCandidates(text) {
  const candidates = []
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/`([^`\n]*)`/g)) {
      const span = match[1].trim()
      if (SHA_SPAN.test(span)) {
        candidates.push({ sha: span.toLowerCase(), line: index + 1 })
      }
    }
  })
  return candidates
}

/** True when the sha resolves to a commit object in `repo`. */
export function commitExists(sha, repo = REPO_ROOT) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repo, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Validates every unique candidate once; `failures` keeps every occurrence so
 * the report points at each file:line that carries a dead sha.
 */
export function checkShas({ files, repo = REPO_ROOT, exists = commitExists }) {
  const occurrences = []
  for (const file of files) {
    for (const candidate of extractCandidates(readFileSync(file, 'utf8'))) {
      occurrences.push({ file, line: candidate.line, sha: candidate.sha })
    }
  }
  const uniqueShas = [...new Set(occurrences.map((occurrence) => occurrence.sha))]
  const dead = new Set(uniqueShas.filter((sha) => !exists(sha, repo)))
  return {
    fileCount: files.length,
    uniqueCount: uniqueShas.length,
    deadCount: dead.size,
    failures: occurrences.filter((occurrence) => dead.has(occurrence.sha))
  }
}

function parseArgs(argv) {
  const files = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== '--file' && arg !== '-f') {
      throw new Error(`unknown argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined) {
      throw new Error('--file requires a path')
    }
    files.push(resolve(value))
    index += 1
  }
  return files.length > 0 ? files : [DEFAULT_FILE]
}

function main(argv) {
  let result
  try {
    result = checkShas({ files: parseArgs(argv) })
  } catch (error) {
    console.error(`ledger sha check aborted: ${error.message}`)
    return 2
  }
  if (result.uniqueCount === 0) {
    console.error('ledger sha check aborted: no backticked commit sha candidates found')
    return 2
  }
  for (const failure of result.failures) {
    console.error(`${failure.file}:${failure.line} ${failure.sha}`)
  }
  if (result.deadCount > 0) {
    console.error(
      `ledger sha check failed: ${result.deadCount} dead sha(s) in ${result.fileCount} file(s)`
    )
    return 1
  }
  console.log(`ledger shas ok: ${result.uniqueCount} unique, ${result.fileCount} files`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
