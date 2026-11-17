#!/usr/bin/env node
// Desktop smoke gate: run the first three desktop smoke specs in order.
// A failed step stops the gate; remaining tests must not start until it is fixed.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SMOKE_STEPS = [
  {
    id: 'S1-desktop-launch-workspace',
    spec: 'tests/e2e/cloud-golden-journey-desktop.spec.ts',
    purpose: 'app launches, workspace/terminal/interactive step executes'
  },
  {
    id: 'S2-desktop-drag-host-oracle',
    spec: 'tests/e2e/c6-desktop-drag.spec.ts',
    purpose: 'drag mirror reaches host; host session.tabs.list oracle agrees'
  },
  {
    id: 'S3-desktop-headless-activation',
    spec: 'tests/e2e/headless-serve-desktop-activation.spec.ts',
    purpose: 'headless serve activates a desktop window'
  }
]

const MIN_TEST_MS = 1000

function runStep(step, outDir) {
  const jsonPath = join(outDir, `${step.id}.json`)
  const result = spawnSync(
    'npx',
    [
      'playwright',
      'test',
      step.spec,
      '--config',
      'tests/playwright.config.ts',
      '--project',
      'electron-headless',
      '--workers=1',
      '--reporter=json'
    ],
    {
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_SUPPRESS_DIALOGS: '1',
        PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  return { ...step, status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// Guard: a step is only valid evidence if a real test ran for long enough.
function collectSpecs(suites) {
  return (suites ?? []).flatMap((suite) => [...(suite.specs ?? []), ...collectSpecs(suite.suites)])
}

function specDurationMs(spec) {
  return Math.max(
    0,
    ...(spec.tests ?? []).flatMap((test) => (test.results ?? []).map((r) => r.duration ?? 0))
  )
}

export function validateRun(jsonPath) {
  const report = JSON.parse(readFileSync(jsonPath, 'utf8'))
  const tests = collectSpecs(report.suites)
  const passed = tests.filter((spec) => spec.ok === true)
  const ranLongEnough = passed.every((spec) => specDurationMs(spec) >= MIN_TEST_MS)
  return {
    specCount: tests.length,
    passed: passed.length,
    ranLongEnough,
    valid: passed.length > 0 && ranLongEnough
  }
}

export function runSmokeGate(outDir) {
  // Why: Playwright resolves the JSON reporter path against the config dir, so a
  // relative outDir would land under tests/ and validateRun would ENOENT.
  const absoluteOutDir = resolve(outDir)
  mkdirSync(absoluteOutDir, { recursive: true })
  const results = []
  for (const step of SMOKE_STEPS) {
    const run = runStep(step, absoluteOutDir)
    const evidence = run.status === 0 ? validateRun(join(absoluteOutDir, `${step.id}.json`)) : null
    results.push({ ...run, evidence })
    const failed = run.status !== 0 || !evidence?.valid
    if (failed) {
      console.error(
        `smoke gate FAILED at ${step.id} (${step.purpose}); exit=${run.status}; ` +
          `evidence=${JSON.stringify(evidence)}; fix before running any other suite`
      )
      return { ok: false, results }
    }
    console.log(`smoke gate ok: ${step.id} (${evidence.passed} passed)`)
  }
  return { ok: true, results }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = process.argv[2] ?? 'cloud-platform/evidence/desktop-smoke-gate'
  const { ok } = runSmokeGate(outDir)
  process.exit(ok ? 0 : 1)
}
