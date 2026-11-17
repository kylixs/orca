import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findReplacementChars, formatIssues, REPLACEMENT_CHAR, scanTargets } from './check-doc-encoding.mjs'

test('clean text has no findings', () => {
  assert.deepEqual(findReplacementChars('第一行\n第二行\n'), [])
})

test('reports 1-based line numbers for every polluted line', () => {
  const text = `ok\nbad ${REPLACEMENT_CHAR} here\nok\n${REPLACEMENT_CHAR}${REPLACEMENT_CHAR}\n`
  assert.deepEqual(findReplacementChars(text), [2, 4])
})

test('scans a directory recursively and skips non-markdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-encoding-'))
  try {
    writeFileSync(join(root, 'clean.md'), 'ok\n')
    writeFileSync(join(root, 'dirty.md'), `ok\n${REPLACEMENT_CHAR}\n`)
    writeFileSync(join(root, 'ignored.txt'), `${REPLACEMENT_CHAR}\n`)
    const issues = scanTargets(['.'], root)
    assert.deepEqual(
      issues.map((issue) => issue.lines),
      [[2]]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('formats findings with the offending line numbers', () => {
  assert.deepEqual(formatIssues([{ file: '/a.md', lines: [3, 9] }]), ['/a.md: U+FFFD at line(s) 3, 9'])
})
