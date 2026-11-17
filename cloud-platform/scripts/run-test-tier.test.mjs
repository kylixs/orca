import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CRITICAL_CLOUD_E2E,
  CRITICAL_VITEST,
  REPO,
  changedFiles,
  changedTargets,
  main,
  runCloudE2E
} from './run-test-tier.mjs'

test('maps renderer runtime changes to their suite', () => {
  const targets = changedTargets([
    'src/renderer/src/runtime/web-session-tabs-sync/layout-groups.ts'
  ])
  assert.deepEqual(targets.vitest, ['src/renderer/src/runtime'])
  assert.deepEqual(targets.cloudE2E, [])
})

test('maps platform api changes to the cloud e2e tree', () => {
  const targets = changedTargets(['cloud-platform/apps/api/src/server.ts'])
  assert.deepEqual(targets.vitest, [])
  assert.deepEqual(targets.cloudE2E, ['cloud-platform/test/e2e'])
})

test('ignores unrelated files', () => {
  const targets = changedTargets(['README.md', 'cloud-platform/PROGRESS.md'])
  assert.deepEqual(targets, { vitest: [], cloudE2E: [] })
})

test('critical tier stays small and user-facing', () => {
  assert.ok(CRITICAL_VITEST.length <= 6)
  assert.ok(CRITICAL_CLOUD_E2E.length <= 10)
  assert.ok(CRITICAL_VITEST.some((path) => path.includes('web-session-tabs-sync')))
})

test('cloud e2e glob expands to concrete files instead of being dropped by existsSync', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tier-glob-'))
  writeFileSync(join(dir, 'web-a.e2e.test.ts'), '')
  writeFileSync(join(dir, 'web-b.e2e.test.ts'), '')
  writeFileSync(join(dir, 'api.e2e.test.ts'), '')
  let invoked = null
  const code = runCloudE2E([join(dir, 'web-*.e2e.test.ts')], {
    run: (cmd, args) => {
      invoked = { cmd, args }
      return 0
    }
  })
  assert.equal(code, 0)
  assert.ok(invoked, 'runner must be invoked for an expanded glob')
  const collected = invoked.args.filter((arg) => arg.includes('.e2e.test.ts'))
  assert.deepEqual(collected.sort(), [
    join(dir, 'web-a.e2e.test.ts'),
    join(dir, 'web-b.e2e.test.ts')
  ])
})

test('changedFiles includes untracked files', () => {
  const calls = []
  const gitRun = (args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'sha\n', stderr: '' }
    if (args[0] === 'ls-files') return { status: 0, stdout: 'src/new-file.ts\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  const files = changedFiles({ gitRun })
  assert.ok(files.includes('src/new-file.ts'))
  assert.ok(calls.some((args) => args[0] === 'ls-files'))
})

test('changedFiles degrades loudly when origin/main is missing', () => {
  const warnings = []
  const gitRun = (args) => {
    if (args[0] === 'rev-parse') return { status: 128, stdout: '', stderr: 'unknown revision' }
    if (args[0] === 'ls-files') return { status: 0, stdout: 'untracked.ts\n', stderr: '' }
    if (args[0] === 'diff') return { status: 0, stdout: 'local.ts\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  const files = changedFiles({ gitRun, warn: (message) => warnings.push(message) })
  assert.deepEqual(files.sort(), ['local.ts', 'untracked.ts'])
  assert.ok(warnings.some((message) => message.includes('origin/main missing')))
})

test('changedFiles surfaces git failures instead of silently passing', () => {
  const gitRun = (args) => {
    if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === 'HEAD')
      return { status: 128, stdout: '', stderr: 'not a git repository' }
    return { status: 0, stdout: '', stderr: '' }
  }
  assert.throws(() => changedFiles({ gitRun }), /not a git repository/)
})

test('full and unknown tiers are rejected before any side effect', () => {
  for (const tier of ['full', 'bogus', undefined]) {
    let monitorStarted = false
    let cleaned = false
    let chdirCalled = false
    const code = main(tier === undefined ? [] : [tier], {
      startMonitor: () => {
        monitorStarted = true
        return { stop() {} }
      },
      cleanup: () => {
        cleaned = true
      },
      chdir: () => {
        chdirCalled = true
      },
      run: () => 0
    })
    assert.equal(code, 2)
    assert.equal(monitorStarted, false, `${tier}: monitor must not start`)
    assert.equal(cleaned, false, `${tier}: cleanup must not run`)
    assert.equal(chdirCalled, false, `${tier}: no cwd change needed`)
  }
})

test('main changes into the repo root before running a tier', () => {
  let chdirArg = null
  let stopCount = 0
  let invoked = false
  const code = main(['smoke'], {
    startMonitor: () => ({ stop: () => (stopCount += 1) }),
    cleanup: () => {},
    chdir: (dir) => (chdirArg = dir),
    run: () => {
      invoked = true
      return 0
    }
  })
  assert.equal(code, 0)
  assert.equal(chdirArg, REPO)
  assert.equal(invoked, true)
  assert.equal(stopCount, 1)
})
