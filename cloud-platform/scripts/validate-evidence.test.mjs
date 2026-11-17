import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  collectEvidenceIssues,
  parseRequireFlag,
  validateEvidenceDir
} from './validate-evidence.mjs'

const SCRIPT = fileURLToPath(new URL('./validate-evidence.mjs', import.meta.url))

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'validate-evidence-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

const codeList = (result) => result.issues.map((issue) => issue.code)

// Discriminative power: every negative case asserts the exact issue code, so a validator that
// only checks existence (or only checks JSON) cannot pass this suite.
test('passes when a default evidence file is valid', () => {
  const dir = fixture({ 'summary.json': '{"ok":true}', 'run.log': 'done\n' })
  const result = validateEvidenceDir(dir)
  assert.equal(result.ok, true)
  assert.deepEqual(result.issues, [])
  assert.ok(result.latestMtime > 0)
})

test('default group accepts results.json without summary.json', () => {
  const dir = fixture({ 'results.json': '{"tests":1}' })
  const result = validateEvidenceDir(dir)
  assert.equal(result.ok, true)
})

test('fails when no default evidence file exists', () => {
  const dir = fixture({ 'run.log': 'done\n' })
  const result = validateEvidenceDir(dir)
  assert.equal(result.ok, false)
  assert.deepEqual(codeList(result), ['no-required-json'])
})

test('fails when a required file is missing', () => {
  const dir = fixture({ 'run.log': 'done\n' })
  const result = validateEvidenceDir(dir, ['run.log', 'summary.json'])
  assert.equal(result.ok, false)
  assert.deepEqual(codeList(result), ['missing'])
  assert.equal(result.issues[0].file, 'summary.json')
})

test('fails when a required file is empty', () => {
  const dir = fixture({ 'summary.json': '' })
  const result = validateEvidenceDir(dir)
  assert.equal(result.ok, false)
  assert.deepEqual(codeList(result), ['empty'])
})

test('fails when required JSON does not parse', () => {
  const dir = fixture({ 'summary.json': '{"ok":' })
  const result = validateEvidenceDir(dir)
  assert.equal(result.ok, false)
  assert.deepEqual(codeList(result), ['invalid-json'])
})

test('custom --require list accepts non-JSON files with content', () => {
  const dir = fixture({ 'run.log': 'all green\n', 'summary.json': '' })
  const result = validateEvidenceDir(dir, ['run.log'])
  assert.equal(result.ok, true)
  assert.deepEqual(result.issues, [])
})

test('fails when the newest file exceeds --max-age-hours', () => {
  const dir = fixture({ 'summary.json': '{"ok":true}' })
  const stale = new Date(Date.now() - 48 * 60 * 60 * 1000)
  utimesSync(join(dir, 'summary.json'), stale, stale)
  const result = validateEvidenceDir(dir, [], { maxAgeHours: 24 })
  assert.equal(result.ok, false)
  assert.deepEqual(codeList(result), ['stale'])
})

test('fails when the evidence directory does not exist', () => {
  const result = validateEvidenceDir(join(fixture({}), 'absent'))
  assert.equal(result.ok, false)
  assert.deepEqual(codeList(result), ['dir-missing'])
})

test('collectEvidenceIssues is pure and reports missing plus stale together', () => {
  const now = Date.now()
  const { issues } = collectEvidenceIssues(
    [{ name: 'run.log', size: 3, mtimeMs: now - 25 * 60 * 60 * 1000, text: '' }],
    ['run.log', 'summary.json'],
    { now, maxAgeHours: 24 }
  )
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['missing', 'stale']
  )
})

test('parseRequireFlag trims, dedupes, and rejects an empty list', () => {
  assert.deepEqual(parseRequireFlag(' run.log,summary.json,run.log,'), ['run.log', 'summary.json'])
  assert.deepEqual(parseRequireFlag(undefined), [])
  assert.throws(() => parseRequireFlag(' , '), /at least one file/)
})

// --check-generated-at: summary.json.generatedAt must be present, parseable, and (with a window)
// recent. mtime alone is spoofable by backfilling, so generatedAt is the durable freshness signal.
const NOW = Date.parse('2026-11-17T12:00:00Z')

function summaryEntry(generatedAt) {
  const payload = generatedAt === undefined ? '{"ok":true}' : JSON.stringify({ generatedAt })
  return { name: 'summary.json', size: payload.length, mtimeMs: NOW, text: payload }
}

test('--check-generated-at passes when generatedAt is inside the window', () => {
  const { issues } = collectEvidenceIssues([summaryEntry('2026-11-17T06:00:00Z')], [], {
    now: NOW,
    maxAgeHours: 24,
    checkGeneratedAt: true
  })
  assert.deepEqual(
    issues.map((issue) => issue.code),
    []
  )
})

test('--check-generated-at fails stale generatedAt with an exact code', () => {
  const { issues } = collectEvidenceIssues([summaryEntry('2026-11-15T06:00:00Z')], [], {
    now: NOW,
    maxAgeHours: 24,
    checkGeneratedAt: true
  })
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['summary-generated-at-stale']
  )
  assert.equal(issues[0].file, 'summary.json')
})

test('--check-generated-at fails a missing or malformed generatedAt', () => {
  const missing = collectEvidenceIssues([summaryEntry(undefined)], [], {
    now: NOW,
    checkGeneratedAt: true
  })
  assert.deepEqual(
    missing.issues.map((issue) => issue.code),
    ['summary-generated-at-missing']
  )

  const malformed = collectEvidenceIssues([summaryEntry('last tuesday')], [], {
    now: NOW,
    checkGeneratedAt: true
  })
  assert.deepEqual(
    malformed.issues.map((issue) => issue.code),
    ['summary-generated-at-invalid']
  )
})

test('--check-generated-at without --max-age-hours only checks presence and parseability', () => {
  const old = collectEvidenceIssues([summaryEntry('2020-01-01T00:00:00Z')], [], {
    now: NOW,
    checkGeneratedAt: true
  })
  assert.deepEqual(old.issues, [])

  const missing = collectEvidenceIssues([summaryEntry(undefined)], [], {
    now: NOW,
    checkGeneratedAt: true
  })
  assert.deepEqual(
    missing.issues.map((issue) => issue.code),
    ['summary-generated-at-missing']
  )
})

test('default behaviour ignores generatedAt entirely', () => {
  const result = validateEvidenceDir(fixture({ 'summary.json': '{not json' }), [], {})
  assert.equal(result.ok, false)
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ['invalid-json']
  )

  const stale = fixture({ 'summary.json': '{"generatedAt":"2020-01-01T00:00:00Z"}' })
  const ignored = validateEvidenceDir(stale, [], { maxAgeHours: 24 })
  assert.equal(ignored.ok, true)
  assert.deepEqual(ignored.issues, [])
})

test('CLI exits 0/1 and prints PASS/FAIL', () => {
  const passDir = fixture({ 'summary.json': '{"ok":true}' })
  const pass = spawnSync(process.execPath, [SCRIPT, passDir], { encoding: 'utf8' })
  assert.equal(pass.status, 0)
  assert.match(pass.stdout, /^PASS evidence:/)

  const failDir = fixture({})
  const fail = spawnSync(process.execPath, [SCRIPT, failDir], { encoding: 'utf8' })
  assert.equal(fail.status, 1)
  assert.match(fail.stdout, /^FAIL evidence:/)

  const backfilled = fixture({ 'summary.json': '{"generatedAt":"2020-01-01T00:00:00Z"}' })
  const checked = spawnSync(
    process.execPath,
    [SCRIPT, backfilled, '--check-generated-at', '--max-age-hours=24'],
    { encoding: 'utf8' }
  )
  assert.equal(checked.status, 1)
  assert.match(checked.stdout, /\[summary-generated-at-stale\]/)
})
