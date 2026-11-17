import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CRITICAL_CLOUD_E2E,
  CRITICAL_VITEST,
  MIN_NODE_VERSION,
  REPO,
  changedFiles,
  changedTargets,
  ensureSupportedNode,
  isSupportedNode,
  main,
  runCloudE2E
} from './run-test-tier.mjs'

const SUPPORTED = { version: MIN_NODE_VERSION }

test('maps renderer runtime changes to their suite', () => {
  const targets = changedTargets([
    'src/renderer/src/runtime/web-session-tabs-sync/layout-groups.ts'
  ])
  assert.deepEqual(targets.vitest, ['src/renderer/src/runtime'])
  assert.deepEqual(targets.cloudE2E, [])
})

test('maps platform api changes to the critical cloud e2e set, not the whole tree', () => {
  const targets = changedTargets(['cloud-platform/apps/api/src/server.ts'])
  assert.deepEqual(targets.vitest, [])
  assert.deepEqual(targets.cloudE2E, CRITICAL_CLOUD_E2E)
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

test('full and unknown tiers are rejected before any side effect', async () => {
  for (const tier of ['full', 'bogus', undefined]) {
    let monitorStarted = false
    let cleaned = false
    let chdirCalled = false
    const code = await main(tier === undefined ? [] : [tier], {
      ...SUPPORTED,
      startSampler: () => {
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

test('main changes into the repo root before running a tier', async () => {
  let chdirArg = null
  let stopCount = 0
  let invoked = false
  const code = await main(['smoke'], {
    ...SUPPORTED,
    startSampler: () => ({ stop: () => (stopCount += 1) }),
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

test('runtime gate accepts node >= 24.16.0', () => {
  assert.equal(isSupportedNode('24.16.0'), true)
  assert.equal(isSupportedNode('v24.21.0'), true)
  assert.equal(isSupportedNode('25.0.0'), true)
  assert.equal(isSupportedNode('24.15.9'), false)
  assert.equal(isSupportedNode('22.18.0'), false)
  const logs = []
  const result = ensureSupportedNode({
    version: '24.16.0',
    argv: ['changed'],
    env: {},
    reexec: () => assert.fail('must not re-exec a supported runtime'),
    log: (message) => logs.push(message)
  })
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.ok(
    logs.some((message) => message.includes('24.16.0')),
    'must print the actual runtime'
  )
})

test('runtime gate refuses node < 24.16 and prints the npx command', () => {
  const errors = []
  let reexecCalled = false
  const result = ensureSupportedNode({
    version: '24.5.0',
    argv: ['changed'],
    env: {},
    reexec: () => {
      reexecCalled = true
      return 0
    },
    log: () => {},
    error: (message) => errors.push(message)
  })
  assert.equal(result.ok, false)
  assert.notEqual(result.code, 0)
  assert.equal(reexecCalled, false)
  const output = errors.join('\n')
  assert.ok(output.includes(`npx -y node@${MIN_NODE_VERSION}`), 'must name the npx fallback')
  assert.ok(output.includes('run-test-tier.mjs changed'), 'must include the tier argument')
})

test('ORCA_TEST_NODE_AUTO=1 re-executes once with the original args', () => {
  const calls = []
  const result = ensureSupportedNode({
    version: '24.5.0',
    argv: ['changed', '--extra'],
    env: { ORCA_TEST_NODE_AUTO: '1' },
    reexec: (options) => {
      calls.push(options)
      return 7
    },
    log: () => {},
    error: () => {}
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].argv, ['changed', '--extra'])
  assert.ok(calls[0].script.endsWith('run-test-tier.mjs'))
  assert.equal(result.ok, false)
  assert.equal(result.code, 7)
})

test('main rejects an old runtime before chdir, cleanup, sampler, or command', async () => {
  let sideEffect = false
  const code = await main(['smoke'], {
    version: '24.5.0',
    startSampler: () => {
      sideEffect = true
      return { stop() {} }
    },
    cleanup: () => {
      sideEffect = true
    },
    chdir: () => {
      sideEffect = true
    },
    run: () => {
      sideEffect = true
      return 0
    },
    log: () => {},
    error: () => {}
  })
  assert.notEqual(code, 0)
  assert.equal(sideEffect, false)
})

test('main starts the sampler before the command and stops it afterwards', async () => {
  const order = []
  const code = await main(['smoke'], {
    ...SUPPORTED,
    startSampler: () => {
      order.push('sampler-start')
      return { stop: () => order.push('sampler-stop') }
    },
    cleanup: () => order.push('cleanup'),
    chdir: () => {},
    run: () => {
      order.push('run')
      return 0
    },
    log: () => {}
  })
  assert.equal(code, 0)
  assert.deepEqual(order, ['sampler-start', 'cleanup', 'run', 'sampler-stop'])
})

test('main stops the sampler when the command fails', async () => {
  let stops = 0
  const code = await main(['smoke'], {
    ...SUPPORTED,
    startSampler: () => ({ stop: () => (stops += 1) }),
    cleanup: () => {},
    chdir: () => {},
    run: () => 1,
    log: () => {}
  })
  assert.equal(code, 1)
  assert.equal(stops, 1)
})

test('main stops the sampler when the command throws', async () => {
  let stops = 0
  await assert.rejects(
    main(['smoke'], {
      ...SUPPORTED,
      startSampler: () => ({ stop: () => (stops += 1) }),
      cleanup: () => {},
      chdir: () => {},
      run: () => {
        throw new Error('boom')
      },
      log: () => {}
    }),
    /boom/
  )
  assert.equal(stops, 1)
})
