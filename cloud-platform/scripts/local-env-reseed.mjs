#!/usr/bin/env node
/**
 * Persistent local cloud-dev-platform rebuild. Safe to re-run.
 * Usage: node cloud-platform/scripts/local-env-reseed.mjs [--root dir] [--port n]
 *        [--host-name name] [--advertise-host ip] [--restart-platform]
 *        [--skip-keychain] [--keep-legacy] [--help]
 * Everything lives under --root (default ~/orca-local-env). Exit 0 = every check passed.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureSource,
  exists,
  killTree,
  listeners,
  isAlive,
  isLoopback,
  httpsJson,
  readPid,
  spawnDetached,
  tcpReachable,
  tryRun,
  waitFor,
  waitPortsFree,
  writeFile
} from './local-env-daemon-control.mjs'
import { ensureCertificates, ensureKeychain } from './local-env-certificates.mjs'
import { DEMO_REPOS, ensureRepo, repoSummary } from './local-env-demo-projects.mjs'
import { probeEnvironment, relayProbe, verify } from './local-env-verification.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const requireFromRepo = createRequire(import.meta.url)
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

function parseOptions(argv) {
  const options = {
    root: process.env.ORCA_LOCAL_ENV_ROOT || path.join(os.homedir(), 'orca-local-env'),
    port: Number(process.env.ORCA_LOCAL_PLATFORM_PORT || 18787),
    hostName: process.env.ORCA_LOCAL_HOST_NAME || 'dev-local-02',
    advertiseHost: process.env.ORCA_LOCAL_ADVERTISE_HOST || '100.103.213.12',
    internalToken: process.env.ORCA_LOCAL_INTERNAL_TOKEN || 'm114-link-token',
    restartPlatform: false,
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
  options.root = path.resolve(options.root)
  return options
}

function buildPaths(root) {
  const p = (name) => path.join(root, name)
  return {
    root,
    caPem: p('tls/ca.pem'),
    caKey: p('tls/ca.key'),
    caSerial: p('tls/ca.srl'),
    platformCert: p('tls/platform/cert.pem'),
    platformKey: p('tls/platform/key.pem'),
    hostCert: p('tls/host/cert.pem'),
    hostKey: p('tls/host/key.pem'),
    hostHome: p('host/home'),
    hostUd: p('host/ud'),
    hostProjects: p('host/projects'),
    hostCredential: p('host/ud/orca-cloud-host.json'),
    supervisor: p('bin/host-supervisor.mjs'),
    forwarderScript: p('bin/forwarder.mjs'),
    logs: p('logs'),
    run: p('run'),
    platformPid: p('run/platform.pid'),
    forwarderPid: p('run/forwarder.pid'),
    hostPid: p('run/host.pid'),
    platformLog: p('logs/platform.log'),
    forwarderLog: p('logs/forwarder.log'),
    hostLog: p('logs/host.log'),
    evidence: path.join(ROOT, 'cloud-platform/evidence/env-persist-2026-11-14/result.json')
  }
}

const FORWARDER = `import net from 'node:net'\nconst port = Number(process.env.FORWARD_PORT ?? 18787)\nnet.createServer((client) => {\n  const upstream = net.connect(port, '127.0.0.1')\n  client.on('error', () => upstream.destroy())\n  upstream.on('error', () => client.destroy())\n  client.pipe(upstream)\n  upstream.pipe(client)\n}).listen(port, '0.0.0.0')\n`
// The dev build quits when its parent dies; this supervisor keeps the host alive.
const SUPERVISOR = `import { spawn } from 'node:child_process'\nconst [command, ...args] = process.argv.slice(2)\nconst child = spawn(command, args, { stdio: 'inherit', env: process.env })\nfor (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {\n  process.on(signal, () => { try { child.kill(signal) } catch {} })\n}\nchild.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))\n`

async function ensureForwarder(paths, options) {
  await ensureSource(paths.forwarderScript, FORWARDER)
  const pid = readPid(paths.forwarderPid)
  if (isAlive(pid) && (await tcpReachable(options.advertiseHost, options.port))) {
    return { pid, status: 'reused' }
  }
  await killTree(pid)
  for (const found of listeners(options.port)) {
    if (!isLoopback(found.address)) {
      await killTree(found.pid)
    }
  }
  await waitPortsFree(options.port, true)
  const started = spawnDetached({
    command: process.execPath,
    args: [paths.forwarderScript],
    env: { ...process.env, FORWARD_PORT: String(options.port) },
    logFile: paths.forwarderLog,
    pidFile: paths.forwarderPid
  })
  return { pid: started, status: 'started' }
}

const createApi =
  (options, paths) =>
  (method, pathname, { token, body } = {}) =>
    httpsJson(`https://127.0.0.1:${options.port}${pathname}`, {
      method,
      body,
      ca: paths.caPem,
      headers: token ? { authorization: `Bearer ${token}` } : {}
    })

async function login(api, { username, password }) {
  const res = await api('POST', '/v1/auth/login', {
    body: { username, password, deviceName: 'local-env-reseed' }
  })
  if (res.status !== 200 || !res.json?.accessToken) {
    throw new Error(`login ${username} -> ${res.status} ${res.text}`)
  }
  return res.json
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
      ORCA_CLOUD_WEB_ROOT: path.join(ROOT, 'cloud-platform/apps/web')
    },
    logFile: paths.platformLog,
    pidFile: paths.platformPid
  })
  await waitFor('platform health', healthy, 60000)
  return { pid: started, status: 'started', url: base }
}

async function seedData(api, paths, options) {
  const admin = await login(api, ADMIN)
  const dev = await login(api, DEV)
  const limited = await login(api, LIMITED)
  const hosts = (await api('GET', '/v1/hosts', { token: admin.accessToken })).json?.hosts ?? []
  const revoked = []
  for (const host of hosts) {
    if (host.name === options.hostName || host.revokedAt !== null) {
      continue
    }
    const res = await api('DELETE', `/v1/hosts/${host.id}`, { token: admin.accessToken })
    revoked.push({ name: host.name, id: host.id, status: res.status })
  }
  const repos = {}
  for (const [key, spec] of Object.entries(DEMO_REPOS)) {
    repos[key] = ensureRepo(path.join(paths.hostProjects, key), spec)
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

async function seedProjects(api, tokens, paths) {
  const token = tokens.admin.accessToken
  const demo = await ensureProject(api, token, {
    name: 'demo-app',
    key: 'demo-app',
    hostId: tokens.hostId,
    path: path.join(paths.hostProjects, 'demo-app'),
    defaultBranch: 'main'
  })
  const zs = await ensureProject(
    api,
    tokens.dev.accessToken,
    {
      name: 'zhangsan-demo',
      key: 'zhangsan-demo',
      dir: 'zhangsan-demo',
      hostId: tokens.hostId,
      defaultBranch: 'main'
    },
    true
  )
  const grants = [
    ['demo-app', demo.project.id, 'group', 'team-payment', FULL],
    ['demo-app', demo.project.id, 'user', 'zhangsan', FULL],
    ['demo-app', demo.project.id, 'user', 'lisi', READ_ONLY],
    ['demo-app', demo.project.id, 'user', 'admin', FULL],
    ['zhangsan-demo', zs.project.id, 'user', 'zhangsan', FULL],
    ['zhangsan-demo', zs.project.id, 'user', 'admin', FULL]
  ]
  for (const [, projectId, subjectType, subjectId, permissions] of grants) {
    const res = await api('PUT', `/v1/projects/${projectId}/grants`, {
      token,
      body: { subjectType, subjectId, permissions }
    })
    if (res.status !== 200) {
      throw new Error(`grant ${subjectId} -> ${res.status} ${res.text}`)
    }
  }
  const global = await api('PUT', '/v1/policies/download', {
    token,
    body: { downloadDefault: 'allow' }
  })
  const demoPolicy = await api('PUT', `/v1/projects/${demo.project.id}/policy`, {
    token,
    body: { downloadPolicy: 'deny' }
  })
  if (global.status !== 200 || demoPolicy.status !== 200) {
    throw new Error('policy seed failed')
  }
  return {
    demo,
    zs,
    grants: grants.map(([key, , type, id]) => `${key}:${type}:${id}`),
    policies: { global: global.status, demoApp: demoPolicy.status }
  }
}

function hostEnv(paths, options, token) {
  const env = { ...process.env }
  const drop = [
    'ORCA_USER_DATA_PATH',
    'ORCA_TAB_ID',
    'ORCA_PANE_KEY',
    'ORCA_TERMINAL_HANDLE',
    'ORCA_AGENT_PANE',
    'ORCA_AGENT_LAUNCH',
    'ORCA_AGENT_LAUNCH_TOKEN',
    'ORCA_AGENT_HOOK_ENDPOINT',
    'ORCA_WORKSPACE_ID',
    'ORCA_WORKTREE_ID',
    'ORCA_RUNTIME_SOURCE_ID',
    'ORCA_RUNTIME_SOURCE_INCARNATION',
    'ORCA_RUNTIME_SOURCE_PROFILE_PATH'
  ]
  for (const key of Object.keys(env)) {
    if (key.startsWith('ORCA_CLOUD_') || drop.includes(key)) {
      delete env[key]
    }
  }
  return {
    ...env,
    HOME: paths.hostHome,
    ORCA_E2E_HOME_DIR: paths.hostHome,
    ORCA_E2E_USER_DATA_DIR: paths.hostUd,
    ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1',
    ORCA_BACKGROUND_LAUNCH: '1',
    NODE_EXTRA_CA_CERTS: paths.caPem,
    ORCA_CLOUD_API_URL: `https://127.0.0.1:${options.port}`,
    ORCA_CLOUD_HOST_NAME: options.hostName,
    ORCA_CLOUD_HOST_TOKEN: token,
    ORCA_CLOUD_PROJECTS_ROOT: paths.hostProjects,
    ORCA_CLOUD_TLS_CERT_PATH: paths.hostCert,
    ORCA_CLOUD_TLS_KEY_PATH: paths.hostKey,
    ORCA_CLOUD_ADVERTISE_HOST: options.advertiseHost
  }
}

function electronBinary() {
  const resolved = requireFromRepo('electron')
  if (typeof resolved === 'string' && exists(resolved)) {
    return resolved
  }
  throw new Error('cannot resolve electron — run pnpm install')
}

async function ensureHost(api, paths, options, token, adminToken) {
  const entry = path.join(ROOT, 'out/main/index.js')
  if (!exists(entry)) {
    throw new Error(`missing build: ${entry} — run pnpm build:electron-vite`)
  }
  await killTree(readPid(paths.hostPid))
  for (const pid of (tryRun('pgrep', ['-f', paths.hostUd]) ?? '').split(/\s+/).map(Number)) {
    if (Number.isInteger(pid) && pid !== process.pid) {
      await killTree(pid)
    }
  }
  fs.rmSync(paths.hostCredential, { force: true })
  await ensureSource(paths.supervisor, SUPERVISOR)
  const pid = spawnDetached({
    command: process.execPath,
    args: [paths.supervisor, electronBinary(), entry],
    env: hostEnv(paths, options, token),
    logFile: paths.hostLog,
    pidFile: paths.hostPid
  })
  const host = await waitFor(
    `host ${options.hostName} online`,
    async () => {
      const hosts = (await api('GET', '/v1/hosts', { token: adminToken })).json?.hosts ?? []
      const found = hosts.find((candidate) => candidate.name === options.hostName)
      const advertised = (found?.directAddrs ?? []).some((addr) =>
        addr.startsWith(`${options.advertiseHost}:`)
      )
      return found?.online && advertised ? found : null
    },
    120000,
    1000
  )
  return { pid, host, reused: false }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const paths = buildPaths(options.root)
  for (const dir of [
    options.root,
    path.dirname(paths.caPem),
    paths.hostHome,
    paths.hostUd,
    paths.hostProjects,
    paths.logs,
    paths.run,
    path.dirname(paths.supervisor)
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  log(
    'paths',
    `root=${options.root} platform=https://127.0.0.1:${options.port} host=${options.hostName} advertise=${options.advertiseHost}`
  )

  const certs = await ensureCertificates(paths, options, log)
  log('certs', `ca=${certs.ca.source} ${certs.ca.fp}`)
  log('certs', `platform=${certs.platform.source} host=${certs.host.source}`)
  const keychain = ensureKeychain(paths, options)
  log('keychain', keychain.status)

  let platform = await ensurePlatform(paths, options)
  log('platform', `${platform.status} pid=${platform.pid}`)
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

  const seeded = await seedData(api, paths, options)
  log('seed', `admin/zhangsan/lisi login ok, revoked=${JSON.stringify(seeded.revoked)}`)
  const host =
    platform.status === 'reused' && health.healthy
      ? { pid: readPid(paths.hostPid), host: health.host, reused: true }
      : await ensureHost(
          api,
          paths,
          options,
          await hostToken(api, seeded.admin.accessToken),
          seeded.admin.accessToken
        )
  log(
    'host',
    `${host.reused ? 'reused' : 'online'} pid=${host.pid ?? '?'} id=${host.host.id} addrs=${host.host.directAddrs.join(',')}`
  )

  const projects = await seedProjects(api, { ...seeded, hostId: host.host.id }, paths)
  log('projects', `demo-app=${projects.demo.project.id} zhangsan-demo=${projects.zs.project.id}`)
  const verification = await verify(api, seeded, projects)
  const relay = await relayProbe(api, seeded.admin.accessToken, options)
  log('verify', `failures=${JSON.stringify(verification.failures)} relay=${relay.status}`)

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
  for (const key of Object.keys(DEMO_REPOS)) {
    const dir = path.join(paths.hostProjects, key)
    repos[key] = { path: dir, ...repoSummary(dir), createdThisRun: seeded.repos[key] }
  }
  const evidence = {
    task: 'local cloud-dev-platform persistent environment rebuild',
    date: new Date().toISOString(),
    note: 'Credentials are not recorded. Seed passwords are the static demo values in server.ts.',
    options: {
      root: options.root,
      platformPort: options.port,
      hostName: options.hostName,
      advertiseHost: options.advertiseHost,
      restartPlatform: options.restartPlatform
    },
    persistentAssets: {
      ca: { pem: paths.caPem, key: paths.caKey, ...certs.ca },
      platformTls: { cert: paths.platformCert, key: paths.platformKey, ...certs.platform },
      hostTls: { cert: paths.hostCert, key: paths.hostKey, ...certs.host },
      hostHome: paths.hostHome,
      hostUserData: paths.hostUd,
      hostProjects: paths.hostProjects,
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
      pid: host.pid,
      reused: host.reused,
      id: host.host.id,
      name: host.host.name,
      online: host.host.online,
      directAddrs: host.host.directAddrs,
      projectsRoot: host.host.projectsRoot,
      projectDirs: host.host.projectDirs,
      tlsFingerprint: host.host.tlsFingerprint,
      log: paths.hostLog
    },
    revokedResidualHosts: seeded.revoked,
    projects: {
      'demo-app': {
        id: projects.demo.project.id,
        status: projects.demo.status,
        path: path.join(paths.hostProjects, 'demo-app')
      },
      'zhangsan-demo': {
        id: projects.zs.project.id,
        status: projects.zs.status,
        path: path.join(paths.hostProjects, 'zhangsan-demo')
      }
    },
    repos,
    grants: projects.grants,
    policies: projects.policies,
    verification,
    relay: { online: relay.online, url: relay.url, status: relay.status },
    legacyCleanup: options.keepLegacy
      ? { skipped: true }
      : { removed: LEGACY_DIRS.length + LEGACY_FILES.length }
  }
  await writeFile(paths.evidence, `${JSON.stringify(evidence, null, 2)}\n`)
  log('evidence', paths.evidence)
  if (verification.failures.length > 0) {
    console.error(`[reseed] FAILED: ${verification.failures.join(', ')}`)
    process.exitCode = 1
  } else if (relay.status !== 200) {
    console.error(`[reseed] FAILED: relay browser entry -> ${relay.status}`)
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
