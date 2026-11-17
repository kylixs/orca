#!/usr/bin/env node
// U206/meta: the defect ledger is edit-heavy; a merged row (two rows on one
// line) or a blank line inside the table silently breaks rendering. This guard
// runs over the table and fails loudly with the offending line numbers.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_PATH = resolve(
  import.meta.dirname,
  '../../remote-connectivity/design/2026-11-13-cloud-dev-platform/defect-ledger.md'
)
const STATUS = new Set(['🔴', '🟡', '🟢', '⚪'])
// Historical rows whose action cell accumulated concatenated content before the
// guard existed. They stay visible but are exempt from the column check.
const LEGACY_BAD_ROWS = new Set(['U138'])

function cells(line) {
  const parts = line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
  return parts.map((cell) => cell.trim())
}

export function checkLedgerTable(text) {
  const lines = text.split('\n')
  const headerIndex = lines.findIndex((line) => /^\|\s*#\s*\|/.test(line))
  if (headerIndex === -1) return ['ledger table header (| # |) not found']
  const expected = cells(lines[headerIndex]).length
  const issues = []
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^##\s/.test(line)) return issues
    if (line.trim() === '') {
      // One blank line ends the table legitimately only when the next
      // non-empty line is a heading; anything else means the table is split.
      const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== '')
      if (next === undefined || /^##\s/.test(next)) return issues
      issues.push(`line ${index + 1}: blank line inside the ledger table`)
      continue
    }
    if (!line.startsWith('|')) {
      issues.push(`line ${index + 1}: non-table line inside the ledger table`)
      continue
    }
    if (/^\|\s*-/.test(line)) continue // separator row
    const row = cells(line)
    if (row.length !== expected && !LEGACY_BAD_ROWS.has(row[0])) {
      issues.push(
        `line ${index + 1}: ${row.length} cells, expected ${expected} (merged or malformed row)`
      )
      continue
    }
    if (!STATUS.has(row[1])) {
      issues.push(`line ${index + 1}: invalid status '${row[1]}'`)
    }
  }
  return issues
}

function main(argv) {
  const path = argv[0] ?? DEFAULT_PATH
  const issues = checkLedgerTable(readFileSync(path, 'utf8'))
  for (const issue of issues) console.error(issue)
  if (issues.length > 0) {
    console.error(`ledger table check failed: ${issues.length} issue(s) in ${path}`)
    return 1
  }
  console.log(`ledger table ok: ${path}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
