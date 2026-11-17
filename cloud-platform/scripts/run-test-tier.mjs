#!/usr/bin/env node
// Tiered test runner: run only what this change needs. Full suites are release-gate only.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startSamplerProcess } from './resource-sampler.mjs'
import { selectTargets } from './cleanup-test-processes.mjs'

// Repo root derived from this script, so tiers work from any cwd (IDE task, subdirectory).
export const REPO = resolve(import.meta.dirname, '..', '..')
export const MIN_NODE_VERSION = '24.16.0'
export const TIER_SCRIPT = 'cloud-platform/scripts/run-test-tier.mjs'

const VITEST = 'node_modules/.bin/vitest'
const VITEST_CONFIG = 'config/vitest.config.ts'
const VALID_TIERS = new Set(['critical', 'changed', 'smoke', 'full'])

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
  { prefix: 'cloud-platform/apps/api/', tests: [], cloudE2E: CRITICAL_CLOUD_E2E },
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

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' })
}

function splitLines(stdout) {
  return (stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

// Checks every git call and adds untracked files; missing origin/main degrades loudly.
export function changedFiles({ gitRun = git, warn = console.warn } = {}) {
  const files = new Set()
  const local = gitRun(['diff', '--name-only', 'HEAD'])
  if (local.error) throw new Error(`git diff failed: ${local.error.message}`)
  if (local.status !== 0) throw new Error(`git diff exited ${local.status}: ${local.stderr ?? ''}`)
  splitLines(local.stdout).forEach((file) => files.add(file))

  const base = gitRun(['rev-parse', '--verify', '--quiet', 'origin/main'])
  if (base.status === 0) {
    const committed = gitRun(['diff', '--name-only', 'origin/main...HEAD'])
    if (committed.error) throw new Error(`git diff origin/main failed: ${committed.error.message}`)
    if (committed.status !== 0) {
      throw new Error(`git diff origin/main exited ${committed.status}: ${committed.stderr ?? ''}`)
    }
    splitLines(committed.stdout).forEach((file) => files.add(file))
  } else {
    warn('[changed] origin/main missing; coverage limited to uncommitted + untracked files')
  }

  const untracked = gitRun(['ls-files', '--others', '--exclude-standard'])
  if (untracked.error) throw new Error(`git ls-files failed: ${untracked.error.message}`)
  if (untracked.status !== 0) {
    throw new Error(`git ls-files exited ${untracked.status}: ${untracked.stderr ?? ''}`)
  }
  splitLines(untracked.stdout).forEach((file) => files.add(file))
  return [...files]
}

// Expands glob segments (only '*' is used by the mapping) instead of trusting existsSync.
export function expandTests(paths, { readdir = readdirSync, exists = existsSync } = {}) {
  const expanded = []
  for (const path of paths) {
    if (!path.includes('*')) {
      if (exists(path)) expanded.push(path)
      continue
    }
    const slash = path.lastIndexOf('/')
    const dir = slash === -1 ? '.' : path.slice(0, slash)
    const pattern = path.slice(slash + 1)
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`)
    let entries = []
    try {
      entries = readdir(dir)
    } catch {
      entries = []
    }
    const matched = entries
      .filter((entry) => regex.test(entry))
      .map((entry) => (dir === '.' ? entry : join(dir, entry)))
      .sort()
    expanded.push(...matched)
  }
  return [...new Set(expanded)]
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function runVitest(paths, { run: runFn = run } = {}) {
  const existing = expandTests(paths)
  if (existing.length === 0) {
    console.warn('[changed] no vitest tests matched the changed files')
    return 0
  }
  // Contract: worker count stays at the config default (2 locally); integration runs stay sequential.
  return runFn(VITEST, ['run', '--config', VITEST_CONFIG, ...existing], {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_SUPPRESS_DIALOGS: '1'
  })
}

export function runCloudE2E(paths, { run: runFn = run } = {}) {
  const existing = expandTests(paths)
  if (existing.length === 0) {
    console.warn('[changed] no cloud e2e tests matched the changed files')
    return 0
  }
  return runFn('node', ['--test', '--test-concurrency=1', '--test-reporter=spec', ...existing], {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_SUPPRESS_DIALOGS: '1'
  })
}

function parseVersionParts(version) {
  const match = String(version ?? '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1, 4).map(Number) : null
}

export function isSupportedNode(version, minimum = MIN_NODE_VERSION) {
  const current = parseVersionParts(version)
  const required = parseVersionParts(minimum)
  if (!current || !required) return false
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index]
  }
  return true
}

function defaultReexec({ argv, env, script = TIER_SCRIPT }) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  // REPO-relative by default, so the re-exec works from any cwd.
  const target = resolve(REPO, script)
  const result = spawnSync(npx, ['-y', `node@${MIN_NODE_VERSION}`, target, ...argv], {
    stdio: 'inherit',
    env
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

// Why: node:sqlite truncates TEXT at NUL before 24.16, which reads as product failures.
export function ensureSupportedNode({
  version = process.versions.node,
  execPath = process.execPath,
  argv = [],
  env = process.env,
  script = TIER_SCRIPT,
  reexec = defaultReexec,
  log = console.log,
  error = console.error
} = {}) {
  log(`[runtime] node ${version} (${execPath}); required >= ${MIN_NODE_VERSION}`)
  if (isSupportedNode(version)) return { ok: true, code: 0 }
  if (env.ORCA_TEST_NODE_AUTO === '1') {
    log(
      `[runtime] node ${version} < ${MIN_NODE_VERSION}; re-executing via npx node@${MIN_NODE_VERSION}`
    )
    return { ok: false, code: reexec({ argv, env, script }) }
  }
  error(`[runtime] refusing to run: node ${version} < ${MIN_NODE_VERSION}`)
  error('[runtime] older node:sqlite truncates TEXT at NUL and produces false failures')
  error(
    `[runtime] re-run with: npx -y node@${MIN_NODE_VERSION} ${script} ${argv.join(' ') || '<tier>'}`
  )
  error('[runtime] or set ORCA_TEST_NODE_AUTO=1 to re-exec automatically')
  return { ok: false, code: 3 }
}

function cleanupStaleProcesses() {
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
}

export async function main(
  argv,
  {
    startSampler = startSamplerProcess,
    cleanup = cleanupStaleProcesses,
    chdir = process.chdir,
    run: runFn = run,
    version = process.versions.node,
    execPath = process.execPath,
    env = process.env,
    reexec,
    log = console.log,
    error = console.error
  } = {}
) {
  const tier = argv[0]
  // Reject unsupported tiers before any side effect (mkdir, monitor, process cleanup).
  if (!VALID_TIERS.has(tier)) {
    error('usage: run-test-tier.mjs <smoke|critical|changed|full>')
    return 2
  }
  if (tier === 'full') {
    error('full tier is a release gate: use the documented L4 run (serial, node>=24.16)')
    return 2
  }
  const gate = ensureSupportedNode({
    version,
    execPath,
    argv,
    env,
    log,
    error,
    ...(reexec ? { reexec } : {})
  })
  // A re-executed child carries the verdict; the parent must not run the tier twice.
  if (!gate.ok) return gate.code
  // Why: every path below is repo-relative; running from a subdirectory used to pass zero tests.
  chdir(REPO)
  const sampler = startSampler({
    intervalSec: 5,
    outDir: `cloud-platform/evidence/resource-monitor-${tier}-${Date.now()}`,
    limits: { maxNode: 24, maxRssGb: 12, maxLoad: 0 }
  })
  try {
    cleanup()
    if (tier === 'critical') {
      const vitest = runVitest(CRITICAL_VITEST, { run: runFn })
      if (vitest !== 0) return vitest
      return runCloudE2E(CRITICAL_CLOUD_E2E, { run: runFn })
    }
    if (tier === 'changed') {
      const files = changedFiles()
      const targets = changedTargets(files)
      log(
        `changed tier: ${targets.vitest.length} vitest paths, ${targets.cloudE2E.length} cloud e2e paths`
      )
      if (files.some((file) => file.startsWith('cloud-platform/apps/api/'))) {
        log('[changed] api 改动如需全树验证请显式跑 T1（critical）或 T3（发版 L4）')
      }
      const vitest = runVitest(targets.vitest, { run: runFn })
      if (vitest !== 0) return vitest
      return runCloudE2E(targets.cloudE2E, { run: runFn })
    }
    return runFn('node', ['cloud-platform/scripts/smoke/desktop-smoke-gate.mjs'])
  } finally {
    await sampler.stop()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)))
}
