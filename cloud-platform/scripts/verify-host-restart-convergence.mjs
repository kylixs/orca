#!/usr/bin/env node
/**
 * C7: restart both local hosts by supervisor pid and prove they converge online.
 * Usage: node verify-host-restart-convergence.mjs [--dry-run] [--root dir] [--port n]
 *        [--evidence-dir dir] [--timeout-ms n]
 * No store/seed reset: hosts are killed by pid and respawned through the reseed path.
 * On failure the full reseed runs once as recovery and the outcome is reported as-is.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { httpsJson, readPid, tryRun, waitFor, writeFile } from './local-env-daemon-control.mjs'
import { ensureHost } from './local-env-host-runtime.mjs'
import { buildPaths } from './local-env-paths.mjs'
import { createApi, login } from './local-env-platform-only.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const ARTIFACT = path.join(ROOT, 'out/main/index.js')
const ADMIN = { username: 'admin', password: 'Adm1n!' }
const OLD_PID_WAIT_MS = 15000

// On-screen windows only: hidden background renders must not count as new windows.
const WINDOW_SCRIPT = `import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for window in list {
  let id = window[kCGWindowNumber as String] as? Int ?? -1
  let ownerPid = window[kCGWindowOwnerPID as String] as? Int ?? -1
  let owner = window[kCGWindowOwnerName as String] as? String ?? "?"
  print("\\(id)\\t\\(ownerPid)\\t\\(owner)")
}
`

function parseOptions(argv) {
  const options = {
    root: process.env.ORCA_LOCAL_ENV_ROOT || path.join(os.homedir(), 'orca-local-env'),
    port: Number(process.env.ORCA_LOCAL_PLATFORM_PORT || 18787),
    hostName: process.env.ORCA_LOCAL_HOST_NAME || 'dev-local-02',
    host2Name: process.env.ORCA_LOCAL_HOST2_NAME || 'dev-local-03',
    host2WsPort: Number(process.env.ORCA_LOCAL_HOST2_WS_PORT || 18889),
    advertiseHost: process.env.ORCA_LOCAL_ADVERTISE_HOST || '100.103.213.12',
    timeoutMs: 90_000,
    dryRun: false,
    evidenceDir: null
  }
  const value = (index, flag) => {
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      throw new Error(`${flag} needs a value`)
    }
    return next
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(import.meta.filename, 'utf8').split('*/')[0])
      process.exit(0)
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--root') {
      options.root = path.resolve(value(i, arg))
      i += 1
    } else if (arg === '--port') {
      options.port = Number(value(i, arg))
      i += 1
    } else if (arg === '--evidence-dir') {
      options.evidenceDir = path.resolve(value(i, arg))
      i += 1
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(value(i, arg))
      i += 1
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new Error(`invalid --port: ${options.port}`)
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`invalid --timeout-ms: ${options.timeoutMs}`)
  }
  return options
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function buildState() {
  const stat = fs.statSync(ARTIFACT)
  return {
    file: ARTIFACT,
    mtime: stat.mtime.toISOString(),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha256: sha256(ARTIFACT)
  }
}

function psField(pid, field) {
  const text = tryRun('ps', ['-p', String(pid), '-o', `${field}=`])
  return text == null || text === '' ? null : text.trim()
}

function processStartMs(pid) {
  const text = psField(pid, 'lstart')
  if (!text) {
    return null
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

// Zombies have an exit status but no running process behind them.
function processAlive(pid) {
  const stat = psField(pid, 'stat')
  return Boolean(stat) && !stat.startsWith('Z')
}

function pidList(text) {
  return (text ?? '')
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
}

function hostPids(host, supervisorPid) {
  const pids = new Set()
  if (supervisorPid) {
    pids.add(supervisorPid)
    for (const pid of pidList(tryRun('pgrep', ['-P', String(supervisorPid)]))) {
      pids.add(pid)
    }
  }
  for (const pid of pidList(tryRun('pgrep', ['-f', host.ud]))) {
    pids.add(pid)
  }
  return [...pids]
}

function describePid(pid) {
  const stat = psField(pid, 'stat')
  return {
    pid,
    start: psField(pid, 'lstart'),
    startMs: processStartMs(pid),
    stat,
    alive: processAlive(pid)
  }
}

function windowSnapshot() {
  try {
    const output = execFileSync('swift', ['-e', WINDOW_SCRIPT], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const windows = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, ownerPid, ...ownerParts] = line.split('\t')
        return { id: Number(id), pid: Number(ownerPid), owner: ownerParts.join('\t') }
      })
      .filter((window) => Number.isInteger(window.id))
    return { available: true, count: windows.length, windows }
  } catch (error) {
    return { available: false, count: null, windows: [], error: error.message }
  }
}

function newWindows(before, after) {
  if (!before.available || !after.available) {
    return []
  }
  const seen = new Set(before.windows.map((window) => window.id))
  return after.windows.filter((window) => !seen.has(window.id))
}

async function platformHealth(options, paths) {
  try {
    const res = await httpsJson(`https://127.0.0.1:${options.port}/health`, { ca: paths.caPem })
    return { status: res.status, ok: res.json?.ok === true, time: res.json?.time ?? null }
  } catch (error) {
    return { status: 0, ok: false, error: error.message }
  }
}

async function listHosts(api, token) {
  const res = await api('GET', '/v1/hosts', { token })
  return { status: res.status, hosts: res.json?.hosts ?? [] }
}

function hostRecord(records, name) {
  const record = records.find((candidate) => candidate.name === name)
  return record
    ? {
        id: record.id,
        name: record.name,
        online: record.online === true,
        directAddrs: record.directAddrs ?? [],
        lastSeenAt: record.lastSeenAt ?? null
      }
    : null
}

async function mintHostToken(api, adminToken) {
  const res = await api('POST', '/v1/hosts/tokens', { token: adminToken })
  if (res.status !== 201 || !res.json?.token) {
    throw new Error(`host token -> ${res.status} ${res.text}`)
  }
  return res.json.token
}

async function capturePreState(options, paths, api, admin) {
  const records = await listHosts(api, admin.accessToken)
  if (records.status !== 200) {
    throw new Error(`GET /v1/hosts -> ${records.status}`)
  }
  const hosts = options.hosts.map((host) => {
    const supervisorPid = readPid(host.pid)
    const pids = hostPids(host, supervisorPid)
    return {
      name: host.name,
      supervisorPid,
      supervisorStart: psField(supervisorPid, 'lstart'),
      supervisorStartMs: processStartMs(supervisorPid),
      pids: pids.map(describePid),
      record: hostRecord(records.hosts, host.name)
    }
  })
  return {
    platformHealth: await platformHealth(options, paths),
    windows: windowSnapshot(),
    hosts
  }
}

async function restartHost(api, paths, options, host, adminToken) {
  const beforePid = readPid(host.pid)
  const startedAt = Date.now()
  try {
    const token = await mintHostToken(api, adminToken)
    const entry = await ensureHost(api, paths, options, host, token, adminToken, options.timeoutMs)
    return {
      name: host.name,
      ok: true,
      error: null,
      beforePid,
      returnedPid: entry.pid,
      waitedMs: Date.now() - startedAt
    }
  } catch (error) {
    return {
      name: host.name,
      ok: false,
      error: error.message,
      beforePid,
      returnedPid: readPid(host.pid),
      waitedMs: Date.now() - startedAt
    }
  }
}

async function waitBothOnline(api, adminToken, names, deadline) {
  const auth = adminToken
  const attempt = async () => {
    const records = await listHosts(api, auth)
    const online = names.every(
      (name) => records.hosts.find((candidate) => candidate.name === name)?.online === true
    )
    return online ? records.hosts : null
  }
  try {
    const hosts = await waitFor('both hosts online', attempt, Math.max(500, deadline - Date.now()))
    return { ok: true, hosts }
  } catch (error) {
    return { ok: false, hosts: (await listHosts(api, auth)).hosts, error: error.message }
  }
}

async function capturePostState(options, paths, api, admin) {
  const records = await listHosts(api, admin.accessToken)
  const hosts = options.hosts.map((host) => {
    const supervisorPid = readPid(host.pid)
    return {
      name: host.name,
      supervisorPid,
      supervisorStart: psField(supervisorPid, 'lstart'),
      supervisorStartMs: processStartMs(supervisorPid),
      pids: hostPids(host, supervisorPid),
      record: hostRecord(records.hosts, host.name)
    }
  })
  return {
    platformHealth: await platformHealth(options, paths),
    windows: windowSnapshot(),
    hosts
  }
}

function runEvidenceValidation(dir) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'cloud-platform/scripts/validate-evidence.mjs'),
      dir,
      '--require=summary.json,results.json',
      '--check-generated-at',
      '--json'
    ],
    { encoding: 'utf8' }
  )
  let parsed = null
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    parsed = null
  }
  return {
    command: 'validate-evidence --check-generated-at',
    exitCode: result.status,
    ok: result.status === 0 && parsed?.ok === true,
    issues: parsed?.issues ?? [],
    stdout: (result.stdout ?? '').trim().slice(0, 2000),
    stderr: (result.stderr ?? '').trim().slice(0, 2000)
  }
}

function reseedEnv(options) {
  return {
    ORCA_LOCAL_ENV_ROOT: options.root,
    ORCA_LOCAL_PLATFORM_PORT: String(options.port),
    ORCA_LOCAL_HOST_NAME: options.hostName,
    ORCA_LOCAL_HOST2_NAME: options.host2Name,
    ORCA_LOCAL_HOST2_WS_PORT: String(options.host2WsPort),
    ORCA_LOCAL_ADVERTISE_HOST: options.advertiseHost
  }
}

async function runRecovery(options) {
  const startedAt = Date.now()
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'cloud-platform/scripts/local-env-reseed.mjs'),
      '--root',
      options.root,
      '--port',
      String(options.port),
      '--host-name',
      options.hostName
    ],
    { encoding: 'utf8', timeout: 480000, env: { ...process.env, ...reseedEnv(options) } }
  )
  const tail = (text) => (text ?? '').trim().split('\n').slice(-12).join('\n')
  return {
    ran: true,
    exitCode: result.status,
    signal: result.signal ?? null,
    durationMs: Date.now() - startedAt,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  }
}

function verdictOf(checks) {
  return Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const paths = buildPaths(options.root, options)
  // buildPaths reads host names from options; keep both names on the same object.
  options.hosts = paths.hosts
  const runStartedAt = Date.now()
  const build = buildState()
  const api = createApi(options, paths)
  const admin = await login(api, ADMIN)
  const pre = await capturePreState(options, paths, api, admin)
  const names = options.hosts.map((host) => host.name)
  const evidenceDir =
    options.evidenceDir ??
    path.join(
      ROOT,
      'cloud-platform/evidence',
      `c7-host-restart-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`
    )
  const plan = {
    dryRun: options.dryRun,
    mechanism: 'precise supervisor-pid restart via local-env-reseed ensureHost',
    storeReset: false,
    timeouts: { onlineMs: options.timeoutMs, oldPidWaitMs: OLD_PID_WAIT_MS },
    platform: { url: `https://127.0.0.1:${options.port}`, health: pre.platformHealth },
    build,
    hosts: pre.hosts.map((host) => ({
      name: host.name,
      supervisorPid: host.supervisorPid,
      supervisorStart: host.supervisorStart,
      onlineBefore: host.record?.online ?? false,
      hostIdBefore: host.record?.id ?? null,
      pidsToStop: host.pids.map((entry) => entry.pid)
    })),
    steps: [
      'mint a fresh host token per host',
      'kill each supervisor process group and its host.ud descendants',
      'respawn supervisor + Electron through ensureHost (no store/seed reset)',
      'wait up to timeoutMs for /v1/hosts to report both hosts online',
      'assert new supervisor start is after out/main/index.js mtime',
      'assert old pids gone, no new on-screen CGWindows, platform /health 200',
      'on failure run local-env-reseed.mjs once and report the outcome'
    ],
    evidenceDir: options.dryRun ? null : evidenceDir
  }
  if (options.dryRun) {
    console.log(JSON.stringify({ plan, pre: { windows: pre.windows, hosts: pre.hosts } }, null, 2))
    return
  }

  console.log(
    `[c7] pre: ${names.map((name, index) => `${name} pid=${pre.hosts[index].supervisorPid} online=${pre.hosts[index].record?.online}`).join(' ')}`
  )
  const restartStartedAt = Date.now()
  const deadline = restartStartedAt + options.timeoutMs
  const restarts = await Promise.all(
    options.hosts.map((host) => restartHost(api, paths, options, host, admin.accessToken))
  )
  for (const result of restarts) {
    console.log(
      `[c7] restart ${result.name}: ${result.ok ? 'online' : `FAILED ${result.error}`} pid=${result.returnedPid} waited=${result.waitedMs}ms`
    )
  }
  const online = await waitBothOnline(api, admin.accessToken, names, deadline)
  const onlineWaitMs = Date.now() - restartStartedAt
  const post = await capturePostState(options, paths, api, admin)

  const oldPids = pre.hosts.flatMap((host) => host.pids.map((entry) => entry.pid))
  await waitFor(
    'old pids gone',
    () => oldPids.every((pid) => !processAlive(pid)),
    OLD_PID_WAIT_MS,
    500
  ).catch(() => null)
  const remainingOldPids = oldPids.filter((pid) => processAlive(pid))

  const newWindowList = newWindows(pre.windows, post.windows)
  // C7 owns host windows only; unrelated apps (IME popups, the user's own apps)
  // are reported for context but cannot fail the restart assertion.
  const hostPidSet = new Set([
    ...pre.hosts.flatMap((host) => host.pids.map((entry) => entry.pid)),
    ...post.hosts.flatMap((host) => host.pids ?? [])
  ])
  const newHostWindows = newWindowList.filter((window) => hostPidSet.has(window.pid))
  const unrelatedNewWindows = newWindowList.filter((window) => !hostPidSet.has(window.pid))
  const hostChecks = options.hosts.map((host, index) => {
    const before = pre.hosts[index]
    const after = post.hosts[index]
    const changedPid = Boolean(after.supervisorPid) && after.supervisorPid !== before.supervisorPid
    const startedAfterBuild =
      after.supervisorStartMs != null && after.supervisorStartMs > build.mtimeMs
    return {
      name: host.name,
      before: {
        pid: before.supervisorPid,
        start: before.supervisorStart,
        startMs: before.supervisorStartMs,
        online: before.record?.online ?? false,
        hostId: before.record?.id ?? null,
        pids: before.pids.map((entry) => entry.pid)
      },
      after: {
        pid: after.supervisorPid,
        start: after.supervisorStart,
        startMs: after.supervisorStartMs,
        online: after.record?.online === true,
        hostId: after.record?.id ?? null
      },
      changedPid,
      startedAfterBuild,
      error: restarts[index].error
    }
  })
  const gatingChecks = {
    restartsSpawned: restarts.every((result) => Boolean(result.returnedPid)),
    bothHostsOnline: online.ok && post.hosts.every((host) => host.record?.online === true),
    hostsOnlineInApi: names.every(
      (name) => post.hosts.find((host) => host.name === name)?.record?.online === true
    ),
    oldPidsGone: remainingOldPids.length === 0,
    newPidStartedAfterBuild: hostChecks.every((host) => host.startedAfterBuild),
    newSupervisorPid: hostChecks.every((host) => host.changedPid),
    noNewHostWindows:
      pre.windows.available && post.windows.available && newHostWindows.length === 0,
    platformHealthy: post.platformHealth.status === 200 && post.platformHealth.ok
  }
  const checks = {
    ...gatingChecks,
    noNewOnScreenWindows:
      pre.windows.available && post.windows.available && newWindowList.length === 0
  }
  let verdict = verdictOf(gatingChecks)
  let recovery = null
  if (!gatingChecks.bothHostsOnline) {
    console.log('[c7] convergence failed; running local-env-reseed.mjs once as recovery')
    recovery = await runRecovery(options)
    const reloaded = await login(api, ADMIN).catch(() => null)
    if (reloaded?.accessToken) {
      const recoveredHosts = await listHosts(api, reloaded.accessToken)
      recovery.hosts = names.map((name) => ({
        name,
        online: recoveredHosts.hosts.find((host) => host.name === name)?.online === true
      }))
      recovery.converged = recovery.hosts.every((host) => host.online)
    }
    recovery.platformHealth = await platformHealth(options, paths)
    console.log(`[c7] recovery exit=${recovery.exitCode} converged=${recovery.converged ?? false}`)
  }

  const summary = {
    task: 'C7 host restart convergence',
    generatedAt: new Date().toISOString(),
    verdict,
    ok: verdict === 'PASS',
    mechanism: plan.mechanism,
    storeReset: false,
    durationMs: Date.now() - runStartedAt,
    build,
    platform: {
      url: plan.platform.url,
      healthBefore: pre.platformHealth,
      healthAfter: post.platformHealth
    },
    hosts: hostChecks,
    checks,
    windows: {
      beforeCount: pre.windows.count,
      afterCount: post.windows.count,
      newCount: newWindowList.length,
      newHostCount: newHostWindows.length,
      newWindows: newWindowList,
      newHostWindows,
      unrelatedNewWindows,
      available: pre.windows.available && post.windows.available
    },
    oldPids: {
      tracked: oldPids,
      remaining: remainingOldPids
    },
    restartResults: restarts,
    onlineWaitMs,
    recovery,
    evidenceDir
  }
  const results = {
    generatedAt: summary.generatedAt,
    task: summary.task,
    checks,
    hosts: hostChecks,
    windows: summary.windows,
    oldPids: summary.oldPids,
    restartResults: restarts,
    recovery
  }
  fs.mkdirSync(evidenceDir, { recursive: true })
  await writeFile(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await writeFile(path.join(evidenceDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  const validation = runEvidenceValidation(evidenceDir)
  await writeFile(
    path.join(evidenceDir, 'validation.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), ...validation }, null, 2)}\n`
  )
  console.log(
    `[c7] ${verdict} hosts=${names.map((name, index) => `${name}:${hostChecks[index].after.online}`).join(' ')} oldPidsRemaining=${remainingOldPids.length} newHostWindows=${newHostWindows.length} newUnrelatedWindows=${unrelatedNewWindows.length} health=${post.platformHealth.status}`
  )
  console.log(`[c7] evidence ${evidenceDir} validate=${validation.ok ? 'PASS' : 'FAIL'}`)
  if (!validation.ok) {
    console.error(`[c7] validate-evidence: ${validation.stdout}`)
  }
  process.exitCode = verdict === 'PASS' && validation.ok ? 0 : 1
}

try {
  await main()
} catch (error) {
  console.error(`[c7] ERROR ${error.stack ?? error.message}`)
  process.exitCode = 1
}
