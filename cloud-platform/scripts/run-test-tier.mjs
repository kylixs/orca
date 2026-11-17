#!/usr/bin/env node
// Tiered test runner: run only what this change needs. Full suites are release-gate only.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { startMonitor } from './monitor-system-resources.mjs'
import { selectTargets } from './cleanup-test-processes.mjs'
import { pathToFileURL } from 'node:url'

const VITEST = 'node_modules/.bin/vitest'
const VITEST_CONFIG = 'config/vitest.config.ts'

// Tier 1: user-visible business paths. Keep this list small and stable.
export const CRITICAL_VITEST = [
  'src/renderer/src/runtime/web-session-tabs-sync',
  'src/renderer/src/runtime/local-structured-session-tabs-sync',
  'src/renderer/src/components/terminal-pane',
  'src/main/runtime',
  'src/main/persistence/profile-state'
]

export const CRITICAL_CLOUD_E2E = [
  'cloud-platform/test/e2e/project-archive.e2e.test.ts',
  'cloud-platform/test/e2e/policy-version-conflict.e2e.test.ts',
  'cloud-platform/test/e2e/web-download-policy.e2e.test.ts',
  'cloud-platform/test/e2e/web-settings-project-policy.e2e.test.ts',
  'cloud-platform/test/e2e/revocation.e2e.test.ts',
  'cloud-platform/test/e2e/host-authorization.e2e.test.ts',
  'cloud-platform/apps/api/test/relay-route-freshness.test.ts'
]

// Changed-area mapping: source prefix -> vitest paths to run.
export const CHANGE_RULES = [
  { prefix: 'src/renderer/src/runtime/', tests: ['src/renderer/src/runtime'] },
  {
    prefix: 'src/renderer/src/components/terminal-pane/',
    tests: ['src/renderer/src/components/terminal-pane']
  },
  {
    prefix: 'src/renderer/src/components/tab',
    tests: ['src/renderer/src/components/tab-bar', 'src/renderer/src/components/tab-group']
  },
  { prefix: 'src/renderer/src/components/editor/', tests: ['src/renderer/src/components/editor'] },
  { prefix: 'src/renderer/src/app-shell/', tests: ['src/renderer/src/app-shell'] },
  { prefix: 'src/main/runtime/', tests: ['src/main/runtime'] },
  { prefix: 'src/main/persistence/', tests: ['src/main/persistence'] },
  { prefix: 'src/main/startup/', tests: ['src/main/startup'] },
  { prefix: 'src/main/ssh/', tests: ['src/main/ssh'] },
  { prefix: 'src/shared/', tests: ['src/shared'] },
  { prefix: 'cloud-platform/apps/api/', tests: [], cloudE2E: ['cloud-platform/test/e2e'] },
  {
    prefix: 'cloud-platform/apps/web/',
    tests: [],
    cloudE2E: ['cloud-platform/test/e2e/web-*.e2e.test.ts']
  }
]

function run(cmd, args, env = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  return result.status ?? 1
}

export function changedTargets(changedFiles) {
  const vitest = new Set()
  const cloudE2E = new Set()
  for (const file of changedFiles) {
    for (const rule of CHANGE_RULES) {
      if (!file.startsWith(rule.prefix)) continue
      rule.tests.forEach((t) => vitest.add(t))
      ;(rule.cloudE2E ?? []).forEach((t) => cloudE2E.add(t))
    }
  }
  return { vitest: [...vitest], cloudE2E: [...cloudE2E] }
}

function changedFiles() {
  const result = spawnSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' })
  const committed = spawnSync('git', ['diff', '--name-only', 'origin/main...HEAD'], {
    encoding: 'utf8'
  })
  const files = `${result.stdout}\n${committed.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return [...new Set(files)]
}

function runVitest(paths) {
  const existing = paths.filter((path) => existsSync(path))
  if (existing.length === 0) return 0
  // Contract: worker count stays at the config default (2 locally); integration runs stay sequential.
  return run(VITEST, ['run', '--config', VITEST_CONFIG, ...existing], {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_SUPPRESS_DIALOGS: '1'
  })
}

function runCloudE2E(paths) {
  const existing = paths.filter((path) => existsSync(path))
  if (existing.length === 0) return 0
  return run('node', ['--test', '--test-concurrency=1', '--test-reporter=spec', ...existing], {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_SUPPRESS_DIALOGS: '1'
  })
}

function main(argv) {
  const tier = argv[0]
  const monitor = startMonitor({
    intervalSec: 5,
    outDir: `cloud-platform/evidence/resource-monitor-${tier ?? 'unknown'}-${Date.now()}`,
    limits: { maxNode: 24, maxRssGb: 12, maxLoad: 0 }
  })
  // Why: leftover Electron/daemon processes from earlier runs poison later runs.
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' })
  const stale = selectTargets(ps.stdout ?? '').targets
  for (const row of stale) {
    try {
      process.kill(row.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  if (stale.length > 0) console.log(`[cleanup] terminated ${stale.length} stale test processes`)
  const finish = (code) => {
    monitor.stop()
    return code
  }
  if (tier === 'critical') {
    const vitest = runVitest(CRITICAL_VITEST)
    if (vitest !== 0) return finish(vitest)
    return finish(runCloudE2E(CRITICAL_CLOUD_E2E))
  }
  if (tier === 'changed') {
    const targets = changedTargets(changedFiles())
    console.log(
      `changed tier: ${targets.vitest.length} vitest paths, ${targets.cloudE2E.length} cloud e2e paths`
    )
    const vitest = runVitest(targets.vitest)
    if (vitest !== 0) return finish(vitest)
    return finish(runCloudE2E(targets.cloudE2E))
  }
  if (tier === 'smoke') {
    return finish(run('node', ['cloud-platform/scripts/smoke/desktop-smoke-gate.mjs']))
  }
  if (tier === 'full') {
    console.error('full tier is a release gate: use the documented L4 run (serial, node>=24.16)')
    return 2
  }
  finish(2)
  console.error('usage: run-test-tier.mjs <smoke|critical|changed|full>')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
