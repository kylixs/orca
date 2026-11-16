#!/usr/bin/env node
/**
 * Persistent local cloud-dev-platform rebuild. Safe to re-run.
 * Usage: node cloud-platform/scripts/local-env-reseed.mjs [--root dir] [--port n]
 *        [--host-name name] [--advertise-host ip] [--restart-platform]
 *        [--platform-only] [--skip-keychain] [--keep-legacy] [--help]
 * The second host name/WS port come from ORCA_LOCAL_HOST2_NAME (dev-local-03) and
 * ORCA_LOCAL_HOST2_WS_PORT (18889). Everything lives under --root (default
 * ~/orca-local-env). Exit 0 = every check passed.
 *
 * --platform-only restarts only the platform process (implies --restart-platform)
 * and refreshes the web release snapshot it serves. Host processes are never
 * killed, re-enrolled, or health-rebuilt, so their PTYs survive; host assertions
 * are deferred instead of retried. The dev platform keeps its store in memory, so
 * a restart starts empty: hosts stay offline until a full reseed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  killTree,
  listeners,
  isAlive,
  isLoopback,
  httpsJson,
  readPid,
  spawnDetached,
  tcpReachable,
  waitFor,
  waitPortsFree,
  writeFile
} from './local-env-daemon-control.mjs'
import { ensureCertificates, ensureKeychain } from './local-env-certificates.mjs'
import { DEMO_REPOS, ensureRepo, repoSummary } from './local-env-demo-projects.mjs'
import { ensureForwarder, ensureHost, findAdvertisedHost } from './local-env-host-runtime.mjs'
import { captureHostState, createApi, login, runPlatformOnly } from './local-env-platform-only.mjs'
import { buildPaths } from './local-env-paths.mjs'
import { probeEnvironment, relayProbe, verify } from './local-env-verification.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const ADMIN = { username: 'admin', password: 'Adm1n!' }
const DEV = { username: 'zhangsan', password: 'Passw0rd!' }
const LIMITED = { username: 'lisi', password: 'Passw0rd!' }
const FULL = ['open', 'terminal', 'agent', 'file:read', 'file:write']
const READ_ONLY = ['open', 'file:read']
const LEGACY_DIRS = ['/tmp/m114-platform-tls', '/tmp/m114-host']
const LEGACY_FILES = [
  '/tmp/m114-forwarder.js',
  '/tmp/m114-forwarder.log',
  '/tmp/m114-platform-tls.log'
]
const log = (step, msg) => console.log(`[reseed] ${step} ${msg}`)

// U88: children's stdout/stderr go to logs/<role>.log (append); stamp each reseed
// round so a later silent death can be tied to a run.
const logSinks = (paths) => ({
  platform: paths.platformLog,
  forwarder: paths.forwarderLog,
  host: paths.hosts[0].log,
  host2: paths.hosts[1].log
})

function parseOptions(argv) {
  const options = {
    root: process.env.ORCA_LOCAL_ENV_ROOT || path.join(os.homedir(), 'orca-local-env'),
    port: Number(process.env.ORCA_LOCAL_PLATFORM_PORT || 18787),
    hostName: process.env.ORCA_LOCAL_HOST_NAME || 'dev-local-02',
    host2Name: process.env.ORCA_LOCAL_HOST2_NAME || 'dev-local-03',
    host2WsPort: Number(process.env.ORCA_LOCAL_HOST2_WS_PORT || 18889),
    advertiseHost: process.env.ORCA_LOCAL_ADVERTISE_HOST || '100.103.213.12',
    internalToken: process.env.ORCA_LOCAL_INTERNAL_TOKEN || 'm114-link-token',
    restartPlatform: false,
    platformOnly: false,
    skipKeychain: false,
    keepLegacy: false
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
    } else if (arg === '--root') {
      options.root = path.resolve(value(i, arg))
      i += 1
    } else if (arg === '--port') {
      options.port = Number(value(i, arg))
      i += 1
    } else if (arg === '--host-name') {
      options.hostName = value(i, arg)
      i += 1
    } else if (arg === '--advertise-host') {
      options.advertiseHost = value(i, arg)
      i += 1
    } else if (arg === '--restart-platform') {
      options.restartPlatform = true
    } else if (arg === '--platform-only') {
      options.platformOnly = true
      options.restartPlatform = true
    } else if (arg === '--skip-keychain') {
      options.skipKeychain = true
    } else if (arg === '--keep-legacy') {
      options.keepLegacy = true
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new Error(`invalid --port: ${options.port}`)
  }
  if (!Number.isInteger(options.host2WsPort) || options.host2WsPort <= 0) {
    throw new Error(`invalid ORCA_LOCAL_HOST2_WS_PORT: ${options.host2WsPort}`)
  }
  if (options.hostName === options.host2Name) {
    throw new Error('--host-name and ORCA_LOCAL_HOST2_NAME must differ')
  }
  options.root = path.resolve(options.root)
  return options
}

async function ensurePlatform(paths, options) {
  const base = `https://127.0.0.1:${options.port}`
  const healthy = async () => {
    try {
      const res = await httpsJson(`${base}/`, { ca: paths.caPem })
      return res.status > 0 && res.status < 500
    } catch {
      return false
    }
  }
  const pid = readPid(paths.platformPid)
  if (!options.restartPlatform && isAlive(pid) && (await healthy())) {
    return { pid, status: 'reused', url: base }
  }
  await killTree(pid)
  for (const found of listeners(options.port)) {
    if (isLoopback(found.address)) {
      await killTree(found.pid)
    }
  }
  await waitPortsFree(options.port, true)
  const started = spawnDetached({
    command: process.execPath,
    args: [path.join(ROOT, 'cloud-platform/apps/api/src/server.ts')],
    env: {
      ...process.env,
      INTERNAL_TOKEN: options.internalToken,
      PORT: String(options.port),
      PLATFORM_TLS_CERT_PATH: paths.platformCert,
      PLATFORM_TLS_KEY_PATH: paths.platformKey,
      ORCA_CLOUD_WEB_ROOT: path.join(ROOT, 'cloud-platform/apps/web'),
      // U126: keep superseded builds so a cached browser page keeps resolving.
      ORCA_CLOUD_WEB_ARCHIVE: path.join(options.root, 'web-archive')
    },
    logFile: paths.platformLog,
    pidFile: paths.platformPid
  })
  await waitFor('platform health', healthy, 60000)
  return { pid: started, status: 'started', url: base }
}

async function seedData(api, paths) {
  const admin = await login(api, ADMIN)
  const dev = await login(api, DEV)
  const limited = await login(api, LIMITED)
  const hosts = (await api('GET', '/v1/hosts', { token: admin.accessToken })).json?.hosts ?? []
  const keep = new Set(paths.hosts.map((host) => host.name))
  const revoked = []
  for (const host of hosts) {
    if (keep.has(host.name) || host.revokedAt !== null) {
      continue
    }
    const res = await api('DELETE', `/v1/hosts/${host.id}`, { token: admin.accessToken })
    revoked.push({ name: host.name, id: host.id, status: res.status })
  }
  const repos = {}
  for (const host of paths.hosts) {
    for (const key of host.projectKeys) {
      repos[key] = ensureRepo(path.join(host.projects, key), DEMO_REPOS[key])
    }
  }
  return { admin, dev, limited, revoked, repos }
}

async function hostToken(api, token) {
  const res = await api('POST', '/v1/hosts/tokens', { token })
  if (res.status !== 201 || !res.json?.token) {
    throw new Error(`host token -> ${res.status} ${res.text}`)
  }
  return res.json.token
}

async function findProject(api, token, key) {
  const res = await api('GET', '/v1/projects', { token })
  return res.json?.projects?.find((project) => project.key === key) ?? null
}

async function ensureProject(api, token, spec, self) {
  const res = await api('POST', self ? '/v1/projects/self' : '/v1/projects', { token, body: spec })
  if (res.status === 201) {
    return { status: 'created', project: res.json }
  }
  if (res.status === 409) {
    const found = await findProject(api, token, spec.key)
    if (found) {
      return { status: 'reused', project: found }
    }
  }
  throw new Error(`project ${spec.key} -> ${res.status} ${res.text}`)
}

const SELF_SERVICE_KEYS = new Set(['zhangsan-demo', 'zhangsan-lab'])
// Cross-host visibility is deliberate: infra-tools is visible beyond its creator
// via team-payment, while each self-created project stays private to zhangsan.
const PROJECT_GRANTS = {
  'demo-app': [
    ['group', 'team-payment', FULL],
    ['user', 'zhangsan', FULL],
    ['user', 'lisi', READ_ONLY],
    ['user', 'admin', FULL]
  ],
  'zhangsan-demo': [
    ['user', 'zhangsan', FULL],
    ['user', 'admin', FULL]
  ],
  'infra-tools': [
    ['group', 'team-payment', FULL],
    ['user', 'admin', FULL]
  ],
  'zhangsan-lab': []
}

// U67: self-service creation gates on the host-level provision bit, so the seed
// must mint zhangsan a host grant (view+provision = full) on every seeded host.
async function seedHostGrants(api, tokens) {
  const adminToken = tokens.admin.accessToken
  const rows = []
  for (const host of Object.values(tokens.hosts)) {
    const res = await api('PUT', `/v1/hosts/${host.id}/grants`, {
      token: adminToken,
      body: { subjectType: 'user', subjectId: DEV.username, permissions: ['view', 'provision'] }
    })
    if (res.status !== 200) {
      throw new Error(`host grant ${host.name}:${DEV.username} -> ${res.status} ${res.text}`)
    }
    rows.push(`${host.name}:user:${DEV.username}`)
  }
  return rows
}

async function seedProjects(api, tokens, paths) {
  const adminToken = tokens.admin.accessToken
  const hostGrants = await seedHostGrants(api, tokens)
  const projects = {}
  const skipped = []
  const grantRows = []
  for (const host of paths.hosts) {
    const recorded = tokens.hosts[host.name]
    for (const key of host.projectKeys) {
      const self = SELF_SERVICE_KEYS.has(key)
      const spec = self
        ? { name: key, key, dir: key, hostId: recorded.id, defaultBranch: 'main' }
        : {
            name: key,
            key,
            hostId: recorded.id,
            path: path.join(host.projects, key),
            defaultBranch: 'main'
          }
      let result
      try {
        result = await ensureProject(
          api,
          self ? tokens.dev.accessToken : adminToken,
          spec,
          self
        )
      } catch (error) {
        console.warn(`[reseed] warn project ${key} skipped: ${error.message}`)
        skipped.push(key)
        continue
      }
      for (const [subjectType, subjectId, permissions] of PROJECT_GRANTS[key]) {
        const res = await api('PUT', `/v1/projects/${result.project.id}/grants`, {
          token: adminToken,
          body: { subjectType, subjectId, permissions }
        })
        if (res.status !== 200) {
          console.warn(`[reseed] warn grant ${key}:${subjectId} -> ${res.status} ${res.text}`)
          continue
        }
        grantRows.push([key, subjectType, subjectId])
      }
      projects[key] = { ...result, hostName: host.name, owner: self ? DEV.username : 'admin' }
    }
  }
  const global = await api('PUT', '/v1/policies/download', {
    token: adminToken,
    body: { downloadDefault: 'allow' }
  })
  const demoApp = projects['demo-app']
  const demoPolicy = demoApp
    ? await api('PUT', `/v1/projects/${demoApp.project.id}/policy`, {
        token: adminToken,
        body: { downloadPolicy: 'deny' }
      })
    : null
  if (global.status !== 200 || demoPolicy?.status !== 200) {
    throw new Error('policy seed failed')
  }
  return {
    projects,
    skipped,
    hostGrants,
    grants: grantRows.map(([key, type, id]) => `${key}:${type}:${id}`),
    policies: { global: global.status, demoApp: demoPolicy?.status ?? null }
  }
}

function hostView(spec, entry, record) {
  return {
    pid: entry.pid,
    reused: entry.reused,
    id: record.id,
    name: record.name,
    online: record.online,
    directAddrs: record.directAddrs,
    relayRoute: record.relayRoute,
    projectsRoot: record.projectsRoot,
    projectDirs: record.projectDirs,
    tlsFingerprint: record.tlsFingerprint,
    home: spec.home,
    userData: spec.ud,
    projects: spec.projects,
    cert: spec.cert,
    key: spec.key,
    log: spec.log
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const paths = buildPaths(options.root, options)
  const dirs = [
    options.root,
    path.dirname(paths.caPem),
    paths.logs,
    paths.run,
    path.dirname(paths.supervisor)
  ]
  for (const host of paths.hosts) {
    dirs.push(host.home, host.ud, host.projects, path.dirname(host.cert))
  }
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true })
  }
  for (const file of Object.values(logSinks(paths))) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `[reseed] ${new Date().toISOString()} run start pid=${process.pid}\n`)
  }
  log(
    'paths',
    `root=${options.root} platform=https://127.0.0.1:${options.port} hosts=${paths.hosts.map((host) => host.name).join(',')} advertise=${options.advertiseHost}`
  )

  const certs = await ensureCertificates(paths, options, log)
  log('certs', `ca=${certs.ca.source} ${certs.ca.fp}`)
  log('certs', `platform=${certs.platform.source} hosts=${JSON.stringify(certs.hosts)}`)
  const keychain = ensureKeychain(paths, options)
  log('keychain', keychain.status)

  const before = options.platformOnly ? captureHostState(paths) : null
  let platform = await ensurePlatform(paths, options)
  log('platform', `${platform.status} pid=${platform.pid}`)
  if (options.platformOnly) {
    const api = createApi(options, paths)
    const admin = await login(api, ADMIN)
    await runPlatformOnly({
      api,
      token: admin.accessToken,
      paths,
      options,
      platform,
      before,
      log
    })
    return
  }
  const forwarder = await ensureForwarder(paths, options)
  const edgeReachable = await waitFor(
    'forwarder edge',
    () => tcpReachable(options.advertiseHost, options.port),
    15000
  )
    .then(() => true)
    .catch(() => false)
  log('forwarder', `${forwarder.status} pid=${forwarder.pid} edgeReachable=${edgeReachable}`)
  if (!edgeReachable) {
    throw new Error(`advertised platform ${options.advertiseHost}:${options.port} unreachable`)
  }

  let api = createApi(options, paths)
  const health = await probeEnvironment(api, (await login(api, ADMIN)).accessToken, options)
  log(
    'health',
    health.healthy ? 'existing environment reachable' : `rebuild needed: ${health.reason}`
  )
  if (!health.healthy && platform.status === 'reused') {
    // A fresh store is the only way to replace a relay route whose target no
    // longer matches the host; the platform refuses to move an existing route.
    platform = await ensurePlatform(paths, { ...options, restartPlatform: true })
    api = createApi(options, paths)
    log('platform', `restarted pid=${platform.pid} for fresh routes`)
  }

  const seeded = await seedData(api, paths)
  log('seed', `admin/zhangsan/lisi login ok, revoked=${JSON.stringify(seeded.revoked)}`)
  const hostEntries = {}
  for (const host of paths.hosts) {
    const reuse = platform.status === 'reused' && health.healthy
    const existing = reuse
      ? await findAdvertisedHost(api, seeded.admin.accessToken, options, host)
      : null
    const entry = existing
      ? { pid: readPid(host.pid), reused: true, host: existing }
      : await ensureHost(
          api,
          paths,
          options,
          host,
          await hostToken(api, seeded.admin.accessToken),
          seeded.admin.accessToken
        )
    hostEntries[host.name] = entry
    log(
      'host',
      `${entry.reused ? 'reused' : 'online'} ${host.name} pid=${entry.pid ?? '?'} id=${entry.host.id} addrs=${entry.host.directAddrs.join(',')}`
    )
  }

  const hostIds = Object.fromEntries(
    paths.hosts.map((host) => [host.name, hostEntries[host.name].host])
  )
  const projects = await seedProjects(api, { ...seeded, hosts: hostIds }, paths)
  if (projects.skipped.length > 0) {
    log('projects', `skipped=${projects.skipped.join(',')}`)
  }
  log(
    'projects',
    paths.hosts
      .flatMap((host) => host.projectKeys)
      .filter((key) => projects.projects[key])
      .map((key) => `${key}=${projects.projects[key].project.id}`)
      .join(' ')
  )
  const liveHosts =
    (await api('GET', '/v1/hosts', { token: seeded.admin.accessToken })).json?.hosts ?? []
  const verification = await verify(api, seeded, projects.projects, {
    hosts: paths.hosts.map((host) => ({
      name: host.name,
      record: liveHosts.find((candidate) => candidate.name === host.name) ?? null
    })),
    advertiseHost: options.advertiseHost,
    internalToken: options.internalToken
  })
  const relay = await relayProbe(
    api,
    seeded.admin.accessToken,
    options,
    paths.hosts.map((host) => host.name)
  )
  log(
    'verify',
    `failures=${JSON.stringify(verification.failures)} relay=${JSON.stringify(Object.fromEntries(Object.entries(relay.hosts).map(([name, value]) => [name, value.status])))}`
  )

  if (!options.keepLegacy) {
    for (const dir of LEGACY_DIRS) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    for (const file of LEGACY_FILES) {
      fs.rmSync(file, { force: true })
    }
    log('legacy', 'removed /tmp/m114-* assets')
  }
  const repos = {}
  for (const host of paths.hosts) {
    for (const key of host.projectKeys) {
      const dir = path.join(host.projects, key)
      repos[key] = { path: dir, ...repoSummary(dir), createdThisRun: seeded.repos[key] }
    }
  }
  const hostEvidence = paths.hosts.map((host) =>
    hostView(host, hostEntries[host.name], hostIds[host.name])
  )
  const projectEvidence = Object.fromEntries(
    Object.entries(projects.projects).map(([key, value]) => [
      key,
      {
        id: value.project.id,
        status: value.status,
        hostName: value.hostName,
        owner: value.owner,
        path: value.project.path,
        visibleTo: Object.entries(verification.confirmations.visibility)
          .filter(([, keys]) => keys.includes(key))
          .map(([identity]) => identity)
      }
    ])
  )
  const primary = hostEvidence[0]
  const evidence = {
    task: 'local cloud-dev-platform persistent environment rebuild',
    date: new Date().toISOString(),
    note: 'Credentials are not recorded. Seed passwords are the static demo values in server.ts.',
    options: {
      root: options.root,
      platformPort: options.port,
      hostName: options.hostName,
      host2Name: options.host2Name,
      host2WsPort: options.host2WsPort,
      advertiseHost: options.advertiseHost,
      restartPlatform: options.restartPlatform
    },
    persistentAssets: {
      ca: { pem: paths.caPem, key: paths.caKey, ...certs.ca },
      platformTls: { cert: paths.platformCert, key: paths.platformKey, ...certs.platform },
      hosts: Object.fromEntries(
        paths.hosts.map((host) => [
          host.name,
          { cert: host.cert, key: host.key, ...certs.hosts[host.name] }
        ])
      ),
      logs: paths.logs
    },
    keychain,
    platform: {
      pid: platform.pid,
      status: platform.status,
      url: platform.url,
      log: paths.platformLog
    },
    forwarder: {
      pid: forwarder.pid,
      status: forwarder.status,
      edgeReachable,
      log: paths.forwarderLog
    },
    host: {
      pid: primary.pid,
      reused: primary.reused,
      id: primary.id,
      name: primary.name,
      online: primary.online,
      directAddrs: primary.directAddrs,
      projectsRoot: primary.projectsRoot,
      projectDirs: primary.projectDirs,
      tlsFingerprint: primary.tlsFingerprint,
      log: primary.log
    },
    hosts: hostEvidence,
    revokedResidualHosts: seeded.revoked,
    projects: projectEvidence,
    repos,
    grants: projects.grants,
    hostGrants: projects.hostGrants,
    skippedProjects: projects.skipped,
    policies: projects.policies,
    verification,
    relay: {
      online: relay.online,
      url: relay.url,
      status: relay.status,
      hosts: relay.hosts
    },
    legacyCleanup: options.keepLegacy
      ? { skipped: true }
      : { removed: LEGACY_DIRS.length + LEGACY_FILES.length }
  }
  await writeFile(paths.evidence, `${JSON.stringify(evidence, null, 2)}\n`)
  const multiHost = {
    task: 'multi-host multi-project environment seed',
    date: new Date().toISOString(),
    options: {
      root: options.root,
      platformPort: options.port,
      advertiseHost: options.advertiseHost
    },
    hosts: hostEvidence,
    projects: projectEvidence,
    visibilityMatrix: verification.confirmations.visibility,
    crossHostAssertions: {
      lisi: {
        'host-1': verification.confirmations.visibility.lisi.filter(
          (key) => projectEvidence[key]?.hostName === options.hostName
        ),
        'host-2': verification.confirmations.visibility.lisi.filter(
          (key) => projectEvidence[key]?.hostName === options.host2Name
        )
      },
      infraToolsVisibleViaGroup:
        verification.confirmations.visibility.zhangsan.includes('infra-tools'),
      selfServiceProjectsPrivate: !verification.confirmations.visibility.lisi.some(
        (key) => key === 'zhangsan-demo' || key === 'zhangsan-lab'
      )
    },
    handoff: verification.confirmations.handoff,
    relayRoutes: verification.confirmations.relayRoutes,
    relay: { online: relay.online, hosts: relay.hosts },
    idempotency: {
      hostsReused: hostEvidence.map((host) => ({ name: host.name, reused: host.reused })),
      projectStatuses: Object.fromEntries(
        Object.entries(projects.projects).map(([key, value]) => [key, value.status])
      )
    },
    failures: verification.failures
  }
  await writeFile(paths.multiHostEvidence, `${JSON.stringify(multiHost, null, 2)}\n`)
  log('evidence', `${paths.evidence} ${paths.multiHostEvidence}`)
  const relayStatuses = Object.values(relay.hosts).map((entry) => entry.status)
  if (verification.failures.length > 0) {
    console.error(`[reseed] FAILED: ${verification.failures.join(', ')}`)
    process.exitCode = 1
  } else if (relayStatuses.some((status) => status !== 200)) {
    console.error(`[reseed] FAILED: relay browser entries -> ${relayStatuses.join(',')}`)
    process.exitCode = 1
  } else {
    console.log('[reseed] OK')
  }
}

try {
  await main()
} catch (error) {
  console.error(`[reseed] ERROR ${error.stack ?? error.message}`)
  process.exitCode = 1
}
