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

test('CLI exits 0/1 and prints PASS/FAIL', () => {
  const passDir = fixture({ 'summary.json': '{"ok":true}' })
  const pass = spawnSync(process.execPath, [SCRIPT, passDir], { encoding: 'utf8' })
  assert.equal(pass.status, 0)
  assert.match(pass.stdout, /^PASS evidence:/)

  const failDir = fixture({})
  const fail = spawnSync(process.execPath, [SCRIPT, failDir], { encoding: 'utf8' })
  assert.equal(fail.status, 1)
  assert.match(fail.stdout, /^FAIL evidence:/)
})
