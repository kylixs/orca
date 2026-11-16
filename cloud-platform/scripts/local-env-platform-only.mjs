// U126: platform-only restart. Refresh the web release snapshot without touching
// host processes — a host rebuild kills PTYs and rotates the host id.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  httpsJson,
  isAlive,
  readPid,
  sleep,
  tryRun,
  writeFile
} from './local-env-daemon-control.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
// One heartbeat period: hosts beat every 10s, then the platform notices a gap.
const HEARTBEAT_WAIT_MS = 12_000
const WEB_SNAPSHOT_FILES = ['index.html', 'app.js', 'styles.css', 'router/routes.js']

export const createApi =
  (options, paths) =>
  (method, pathname, { token, body, headers } = {}) =>
    httpsJson(`https://127.0.0.1:${options.port}${pathname}`, {
      method,
      body,
      ca: paths.caPem,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      }
    })

export async function login(api, { username, password }) {
  const res = await api('POST', '/v1/auth/login', {
    body: { username, password, deviceName: 'local-env-reseed' }
  })
  if (res.status !== 200 || !res.json?.accessToken) {
    throw new Error(`login ${username} -> ${res.status} ${res.text}`)
  }
  return res.json
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Same digest the platform computes at startup (web-release.ts loadWebRelease). */
function localWebBuild(webRoot) {
  const manifest = WEB_SNAPSHOT_FILES.filter((name) => fs.existsSync(path.join(webRoot, name)))
    .sort()
    .map((name) => `${name}:${sha256File(path.join(webRoot, name))}`)
    .join('|')
  return createHash('sha256').update(manifest).digest('hex').slice(0, 12)
}

/** Asserts the platform serves the assets on disk, not a stale startup snapshot. */
async function verifyWebSnapshot(api) {
  const webRoot = path.join(ROOT, 'cloud-platform/apps/web')
  const local = localWebBuild(webRoot)
  const res = await api('GET', '/v1/web/release')
  const assets = res.json?.assets ?? {}
  const files = {}
  const failures = []
  for (const name of WEB_SNAPSHOT_FILES.filter((entry) => entry !== 'index.html')) {
    const expected = sha256File(path.join(webRoot, name))
    const served = assets[name]?.sha256 ?? null
    files[name] = { served, expected, match: served === expected }
    if (served !== expected) {
      failures.push(`web ${name} is not the current source`)
    }
  }
  const build = res.json?.build ?? null
  if (build !== local) {
    failures.push(`web build ${build} != source ${local}`)
  }
  return {
    ok: res.status === 200 && failures.length === 0,
    build,
    sourceBuild: local,
    files,
    failures
  }
}

/** Direct + transitive children: PTY shells live here, so overlap proves they survived. */
export function descendantPids(pid) {
  if (!Number.isInteger(pid)) {
    return []
  }
  const found = new Set()
  const queue = [pid]
  while (queue.length > 0) {
    for (const child of (tryRun('pgrep', ['-P', String(queue.shift())]) ?? '')
      .split(/\s+/)
      .map(Number)) {
      if (Number.isInteger(child) && !found.has(child)) {
        found.add(child)
        queue.push(child)
      }
    }
  }
  return [...found]
}

export function captureHostState(paths) {
  return {
    platformPid: readPid(paths.platformPid),
    hosts: Object.fromEntries(paths.hosts.map((host) => [host.name, readPid(host.pid)])),
    descendants: Object.fromEntries(
      paths.hosts.map((host) => [host.name, descendantPids(readPid(host.pid))])
    )
  }
}

/**
 * Waits one heartbeat window for the hosts to reappear, but never rebuilds them.
 * Offline is deferred, not failed: the restarted dev platform holds its store in
 * memory, so it starts empty and the untouched hosts cannot re-enrol.
 */
async function waitForHostRecords(api, token, paths) {
  const read = async () => {
    const hosts = (await api('GET', '/v1/hosts', { token })).json?.hosts ?? []
    return paths.hosts.map(
      (host) => hosts.find((candidate) => candidate.name === host.name) ?? null
    )
  }
  let records = await read()
  const deadline = Date.now() + HEARTBEAT_WAIT_MS
  while (Date.now() < deadline && !records.every((record) => record?.online === true)) {
    await sleep(1000)
    records = await read()
  }
  return paths.hosts.map((host, index) => ({
    name: host.name,
    online: records[index]?.online === true,
    id: records[index]?.id ?? null,
    note:
      records[index] === null
        ? 'no host record: the restarted platform starts with an empty store'
        : null
  }))
}

export async function runPlatformOnly({ api, token, paths, options, platform, before, log }) {
  const snapshot = await verifyWebSnapshot(api)
  log(
    'web',
    `${snapshot.ok ? 'refreshed' : 'STALE'} build=${snapshot.build} source=${snapshot.sourceBuild}`
  )
  const hosts = await waitForHostRecords(api, token, paths)
  for (const host of hosts) {
    log('host', `${host.online ? 'online' : 'deferred'} ${host.name} id=${host.id ?? '?'}`)
  }
  const after = Object.fromEntries(paths.hosts.map((host) => [host.name, readPid(host.pid)]))
  const forwarderPid = readPid(paths.forwarderPid)
  const survivors = {}
  for (const host of paths.hosts) {
    const beforePids = before.descendants[host.name] ?? []
    const afterPids = descendantPids(after[host.name])
    const kept = beforePids.filter((pid) => afterPids.includes(pid))
    survivors[host.name] = {
      before: beforePids.length,
      after: afterPids.length,
      kept: kept.length,
      keptPids: kept
    }
  }
  const failures = [...snapshot.failures]
  const platformRestarted =
    platform.status === 'started' && platform.pid !== before.platformPid && isAlive(platform.pid)
  if (!platformRestarted) {
    failures.push('platform pid did not change')
  }
  for (const host of paths.hosts) {
    const pidBefore = before.hosts[host.name]
    if (pidBefore !== undefined && (after[host.name] !== pidBefore || !isAlive(pidBefore))) {
      failures.push(`${host.name} pid ${pidBefore} -> ${after[host.name]}`)
    }
    if (survivors[host.name].kept === 0 && survivors[host.name].before > 0) {
      failures.push(`${host.name} child processes did not survive`)
    }
  }
  const offline = hosts.filter((host) => !host.online).map((host) => host.name)
  if (offline.length > 0) {
    // Deferred, not failed: hosts are deliberately left alone so their PTYs live on.
    console.warn(
      `[reseed] WARN platform-only: hosts ${offline.join(',')} have no record after ${HEARTBEAT_WAIT_MS}ms; hosts untouched — run without --platform-only to rebuild`
    )
  }
  const evidence = {
    task: 'local cloud-dev-platform platform-only restart',
    date: new Date().toISOString(),
    mode: 'platform-only',
    options: {
      root: options.root,
      platformPort: options.port,
      restartPlatform: options.restartPlatform,
      platformOnly: options.platformOnly
    },
    platform: {
      pidBefore: before.platformPid,
      pid: platform.pid,
      status: platform.status,
      restarted: platformRestarted,
      url: platform.url,
      log: paths.platformLog,
      webArchive: path.join(options.root, 'web-archive')
    },
    webSnapshot: snapshot,
    forwarder: {
      pid: forwarderPid,
      alive: isAlive(forwarderPid),
      log: paths.forwarderLog
    },
    hosts: paths.hosts.map((host) => ({
      name: host.name,
      pidBefore: before.hosts[host.name],
      pid: after[host.name],
      alive: isAlive(after[host.name]),
      online: hosts.find((entry) => entry.name === host.name)?.online === true,
      id: hosts.find((entry) => entry.name === host.name)?.id ?? null,
      children: survivors[host.name],
      log: host.log
    })),
    hostAssertions: offline.length > 0 ? 'deferred' : 'passed',
    deferredHosts: offline,
    failures
  }
  const file = path.join(options.root, 'platform-only-evidence.json')
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`)
  log('evidence', file)
  if (evidence.failures.length > 0) {
    console.error(`[reseed] FAILED: ${evidence.failures.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log('[reseed] OK (platform-only)')
  }
}
