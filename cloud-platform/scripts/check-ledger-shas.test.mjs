import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkShas, extractCandidates, REPO_ROOT } from './check-ledger-shas.mjs'

const REAL_SHA = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
  cwd: REPO_ROOT,
  encoding: 'utf8'
}).trim()
// 40 hex chars that no object in this repo can plausibly carry.
const FAKE_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

function withLedgerFile(content, run) {
  const root = mkdtempSync(join(tmpdir(), 'ledger-shas-'))
  try {
    const file = join(root, 'ledger.md')
    writeFileSync(file, content)
    return run(file)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('accepts a real commit sha', () => {
  withLedgerFile(`| U1 | 已修 | \`${REAL_SHA}\` |\n`, (file) => {
    const result = checkShas({ files: [file] })
    assert.deepEqual(result.failures, [])
    assert.equal(result.uniqueCount, 1)
    assert.equal(result.fileCount, 1)
  })
})

test('reports a fabricated sha with its file and line number', () => {
  withLedgerFile(`# 台账\n\n| U2 | 已修 | \`${FAKE_SHA}\` |\n`, (file) => {
    const result = checkShas({ files: [file] })
    assert.equal(result.deadCount, 1)
    assert.deepEqual(result.failures, [{ file, line: 3, sha: FAKE_SHA }])
  })
})

test('ignores hex shorter than 7 or longer than 40 chars', () => {
  const tooLong = 'a'.repeat(41)
  withLedgerFile(`短 \`1a2b3\`\n长 \`${tooLong}\`\n`, (file) => {
    assert.deepEqual(extractCandidates(`短 \`1a2b3\`\n长 \`${tooLong}\`\n`), [])
    const result = checkShas({ files: [file] })
    assert.equal(result.uniqueCount, 0)
    assert.deepEqual(result.failures, [])
  })
})

test('counts a repeated sha once while keeping the unique total', () => {
  withLedgerFile(
    `| U1 | \`${REAL_SHA}\` |\n| U2 | \`${REAL_SHA.toUpperCase()}\` |\n| U3 | \`${FAKE_SHA}\` |\n`,
    (file) => {
      const result = checkShas({ files: [file] })
      assert.equal(result.uniqueCount, 2)
      // The fake sha is repeated nowhere, so only its single line is reported.
      assert.equal(result.failures.length, 1)
      assert.equal(result.failures[0].line, 3)
    }
  )
})

test('does not mistake paths or truncated shas for candidates', () => {
  const text = '`evidence/w9-head-20261117-091324/summary.json`\n`cf75751c…`\n'
  assert.deepEqual(extractCandidates(text), [])
})
