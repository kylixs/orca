import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  checkTestTimeouts,
  parseArgs,
  scanSource,
  scanTestTimeouts
} from './check-test-timeouts.mjs'

function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'test-timeouts-'))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeFixture(root, name, source) {
  const file = join(root, name)
  writeFileSync(file, source)
  return file
}

test('flags numeric third argument on test/it', () => {
  const violations = scanSource("test('adds', () => {}, 5000)\nit('sub', fn, 30_000)\n")
  assert.deepEqual(violations, [
    { file: '<memory>', line: 1, form: 'test-numeric-third' },
    { file: '<memory>', line: 2, form: 'test-numeric-third' }
  ])
})

test('flags constant numeric expressions as timeout third/second arguments', () => {
  const violations = scanSource(
    'test(\n  `load`,\n  async () => {},\n  DURATION_S * 1_000 + 300_000\n)\n' +
      'before(setup, TIMEOUT_MS * 1)\n'
  )
  assert.deepEqual(violations, [
    { file: '<memory>', line: 1, form: 'test-numeric-third' },
    { file: '<memory>', line: 6, form: 'hook-numeric-second' }
  ])
})

test('does not flag lowercase identifiers as numeric timeout', () => {
  assert.deepEqual(scanSource("test('x', fn, callback)\n"), [])
})

test('flags object third argument on test/it (silently ignored by node:test)', () => {
  const violations = scanSource(
    "test('adds', () => {}, { timeout: 5000 })\n" +
      "it('sub', async () => {}, {\n  timeout: 10_000\n})\n"
  )
  assert.deepEqual(violations, [
    { file: '<memory>', line: 1, form: 'test-object-third' },
    { file: '<memory>', line: 2, form: 'test-object-third' }
  ])
})

test('accepts the legal options-second form on test/it', () => {
  const violations = scanSource(
    "test('adds', { timeout: 5000 }, () => {})\n" +
      "it('sub', { timeout: 10_000 }, async () => {})\n" +
      "test('plain', () => {})\n"
  )
  assert.deepEqual(violations, [])
})

test('flags numeric second argument on hooks', () => {
  const violations = scanSource(
    'before(() => {}, 5000)\nafter(async () => {}, 30_000)\n' +
      'beforeEach(fn, 1_000)\nafterEach(setup, 2_000)\n'
  )
  assert.deepEqual(violations, [
    { file: '<memory>', line: 1, form: 'hook-numeric-second' },
    { file: '<memory>', line: 2, form: 'hook-numeric-second' },
    { file: '<memory>', line: 3, form: 'hook-numeric-second' },
    { file: '<memory>', line: 4, form: 'hook-numeric-second' }
  ])
})

test('accepts the legal options-second form on hooks', () => {
  const violations = scanSource(
    'before(() => {}, { timeout: 5000 })\nafterEach(fn, { timeout: 1000 })\n'
  )
  assert.deepEqual(violations, [])
})

test('ignores pseudo-code in comments and strings', () => {
  const source = [
    '// test("pseudo", () => {}, 5000)',
    '/* before(fn, 5000)',
    "   test('pseudo', () => {}, { timeout: 1 }) */",
    'const sample = "test(\'pseudo\', fn, 5000)"',
    'const template = `before(fn, 5000)`',
    "test('real', { timeout: 5000 }, () => {})"
  ].join('\n')
  assert.deepEqual(scanSource(source), [])
})

test('does not flag method calls or identifiers ending in a test name', () => {
  const violations = scanSource('latest(fn, 5000)\nedit(fn, 5000)\nobj.test(fn, 5000)\n')
  assert.deepEqual(violations, [])
})

test('baseline mode stays green when nothing is added', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    const created = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(created.baselineWritten, true)
    assert.equal(created.exitCode, 0)
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    assert.equal(baseline.counts.total, 1)
    assert.deepEqual(baseline.violations, [`${file}:1`])

    const repeat = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(repeat.exitCode, 0)
    assert.deepEqual(repeat.newViolations, [])
  })
})

test('baseline mode reports a newly added violation', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })
    writeFileSync(file, `${readFileSync(file, 'utf8')}\ntest('b', () => {}, { timeout: 10 })\n`)

    const result = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(result.exitCode, 1)
    assert.deepEqual(
      result.newViolations.map((violation) => `${violation.file}:${violation.line}`),
      [`${file}:3`]
    )
  })
})

test('--update-baseline rewrites the full list', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })
    writeFileSync(file, `${readFileSync(file, 'utf8')}before(fn, 5000)\n`)

    const result = checkTestTimeouts({ files: [file], baselinePath, updateBaseline: true })
    assert.equal(result.exitCode, 0)
    assert.equal(result.baselineCount, 2)
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    assert.deepEqual(baseline.violations, [`${file}:1`, `${file}:2`])
    assert.deepEqual(baseline.counts.byForm, {
      'test-numeric-third': 1,
      'hook-numeric-second': 1
    })
  })
})

test('scanTestTimeouts walks explicit files and reports file:line form', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'b.test.ts', "test('b', () => {}, 5000)\n")
    const { violations } = scanTestTimeouts({ files: [file] })
    assert.deepEqual(violations, [{ file, line: 1, form: 'test-numeric-third' }])
  })
})

test('parseArgs rejects unknown flags and missing paths', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
  assert.throws(() => parseArgs(['--baseline']), /requires a path/)
  assert.equal(parseArgs(['--update-baseline']).updateBaseline, true)
})
