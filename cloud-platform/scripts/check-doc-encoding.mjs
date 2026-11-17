#!/usr/bin/env node
// U+FFFD guard for docs edited via shell heredocs; the write hook only covers Write/Edit.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const REPLACEMENT_CHAR = String.fromCharCode(0xfffd)

const REPO = resolve(import.meta.dirname, '..', '..')

export const DEFAULT_TARGETS = [
  'cloud-platform/PROGRESS.md',
  'cloud-platform/test-retrospective-log.md',
  'remote-connectivity/design/2026-11-13-cloud-dev-platform'
]

/** 1-based line numbers carrying U+FFFD, so a failure points at the pasted line. */
export function findReplacementChars(text) {
  const hits = []
  text.split('\n').forEach((line, index) => {
    if (line.includes(REPLACEMENT_CHAR)) hits.push(index + 1)
  })
  return hits
}

/** Expands a target into Markdown files; a path is recursive so a new mXX is covered. */
export function collectMarkdown(target, out = []) {
  const stats = statSync(target)
  if (stats.isDirectory()) {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      collectMarkdown(join(target, entry.name), out)
    }
    return out
  }
  if (target.endsWith('.md')) out.push(target)
  return out
}

export function scanTargets(targets = DEFAULT_TARGETS, repo = REPO) {
  const issues = []
  for (const target of targets) {
    for (const file of collectMarkdown(resolve(repo, target))) {
      const lines = findReplacementChars(readFileSync(file, 'utf8'))
      if (lines.length > 0) issues.push({ file, lines })
    }
  }
  return issues
}

export function formatIssues(issues) {
  return issues.map((issue) => `${issue.file}: U+FFFD at line(s) ${issue.lines.join(', ')}`)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)

if (invokedDirectly) {
  const targets = process.argv.slice(2)
  const issues = scanTargets(targets.length > 0 ? targets : DEFAULT_TARGETS)
  if (issues.length > 0) {
    for (const line of formatIssues(issues)) console.error(line)
    process.exit(1)
  }
  console.log(`doc encoding ok (${(targets.length > 0 ? targets : DEFAULT_TARGETS).length} target(s))`)
}
