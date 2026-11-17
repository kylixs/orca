import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SMOKE_STEPS,
  STEP_TIMEOUT_MS,
  runSmokeGate,
  runStep,
  validateRun
} from './desktop-smoke-gate.mjs'

function writeReport(report) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-smoke-gate-'))
  const jsonPath = join(dir, 'report.json')
  writeFileSync(jsonPath, JSON.stringify(report))
  return jsonPath
}

function spec({ ok, duration }) {
  return { ok, tests: [{ results: [{ duration }] }] }
}

test('ok=false spec is not evidence of a pass', () => {
  const result = validateRun(
    writeReport({ suites: [{ specs: [spec({ ok: false, duration: 5000 })] }] })
  )
  assert.equal(result.specCount, 1)
  assert.equal(result.passed, 0)
  assert.equal(result.valid, false)
})

test('a passing spec that ran under 1s is rejected (no instant/empty run)', () => {
  const result = validateRun(
    writeReport({ suites: [{ specs: [spec({ ok: true, duration: 500 })] }] })
  )
  assert.equal(result.passed, 1)
  assert.equal(result.ranLongEnough, false)
  assert.equal(result.valid, false)
})

test('a passing spec that ran at least 1s is valid', () => {
  const result = validateRun(
    writeReport({ suites: [{ specs: [spec({ ok: true, duration: 5000 })] }] })
  )
  assert.deepEqual(result, {
    specCount: 1,
    passed: 1,
    ranLongEnough: true,
    stale: false,
    valid: true
  })
})

test('specs nested inside describe suites are collected recursively', () => {
  const nested = spec({ ok: true, duration: 2000 })
  const outer = spec({ ok: false, duration: 2000 })
  const report = {
    suites: [{ specs: [outer], suites: [{ specs: [], suites: [{ specs: [nested] }] }] }]
  }
  const result = validateRun(writeReport(report))
  assert.equal(result.specCount, 2)
  assert.equal(result.passed, 1)
  assert.equal(result.valid, true)
})

test('an empty report is never valid', () => {
  for (const report of [{ suites: [] }, { suites: [{ specs: [], suites: [] }] }]) {
    assert.equal(validateRun(writeReport(report)).valid, false)
  }
})

test('SMOKE_STEPS stays in protocol order S1/W9a, S2/C6, S3/headless-serve', () => {
  assert.deepEqual(
    SMOKE_STEPS.map((step) => step.id),
    ['S1-desktop-launch-workspace', 'S2-desktop-drag-host-oracle', 'S3-desktop-headless-activation']
  )
  assert.deepEqual(
    SMOKE_STEPS.map((step) => step.spec),
    [
      'tests/e2e/cloud-golden-journey-desktop.spec.ts',
      'tests/e2e/c6-desktop-drag.spec.ts',
      'tests/e2e/headless-serve-desktop-activation.spec.ts'
    ]
  )
})

test('JS/JSON evidence older than the run start is rejected', () => {
  const jsonPath = writeReport({ suites: [{ specs: [spec({ ok: true, duration: 5000 })] }] })
  const result = validateRun(jsonPath, { startedAt: Date.now() + 60_000 })
  assert.equal(result.stale, true)
  assert.equal(result.valid, false)
})

test('runStep applies a hard timeout and reports a timed-out step', () => {
  let spawnOptions = null
  const run = runStep(SMOKE_STEPS[0], mkdtempSync(join(tmpdir(), 'smoke-timeout-')), {
    spawn: (cmd, args, options) => {
      spawnOptions = options
      return { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }
    }
  })
  assert.equal(spawnOptions.timeout, STEP_TIMEOUT_MS)
  assert.equal(STEP_TIMEOUT_MS, 600_000)
  assert.equal(run.timedOut, true)
})

test('runSmokeGate deletes previous evidence and cannot pass on a stale JSON', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'smoke-old-json-'))
  // A previous successful run left valid-looking evidence behind.
  writeFileSync(
    join(outDir, `${SMOKE_STEPS[0].id}.json`),
    JSON.stringify({ suites: [{ specs: [spec({ ok: true, duration: 5000 })] }] })
  )
  const { ok, results } = runSmokeGate(outDir, {
    // The step exits 0 but writes no fresh reporter output.
    runStep: (step, dir) => ({ ...step, status: 0, stdout: '', stderr: '', dir })
  })
  assert.equal(ok, false)
  assert.equal(results.length, 1)
  assert.equal(results[0].evidence.valid, false)
  assert.match(results[0].evidence.error, /ENOENT/)
})
