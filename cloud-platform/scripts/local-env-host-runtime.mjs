// Host-process plumbing for the local reseed: forwarder, supervisor, per-host env.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureSource,
  exists,
  isAlive,
  isLoopback,
  killTree,
  listeners,
  readPid,
  spawnDetached,
  tcpReachable,
  tryRun,
  waitFor,
  waitPortsFree
} from './local-env-daemon-control.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const requireFromRepo = createRequire(import.meta.url)

const FORWARDER = `import net from 'node:net'\nconst port = Number(process.env.FORWARD_PORT ?? 18787)\nnet.createServer((client) => {\n  const upstream = net.connect(port, '127.0.0.1')\n  client.on('error', () => upstream.destroy())\n  upstream.on('error', () => client.destroy())\n  client.pipe(upstream)\n  upstream.pipe(client)\n}).listen(port, '0.0.0.0')\n`
// The dev build quits when its parent dies; this supervisor keeps the host alive.
const SUPERVISOR = `import { spawn } from 'node:child_process'\nconst [command, ...args] = process.argv.slice(2)\nconst child = spawn(command, args, { stdio: 'inherit', env: process.env })\nfor (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {\n  process.on(signal, () => { try { child.kill(signal) } catch {} })\n}\nchild.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))\n`

export async function ensureForwarder(paths, options) {
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

export function hostEnv(paths, options, host, token) {
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
    HOME: host.home,
    ORCA_E2E_HOME_DIR: host.home,
    ORCA_E2E_USER_DATA_DIR: host.ud,
    // Pinned only when configured; the primary host keeps the OS-assigned port.
    ...(host.wsPort ? { ORCA_E2E_RUNTIME_WS_PORT: String(host.wsPort) } : {}),
    ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1',
    ORCA_BACKGROUND_LAUNCH: '1',
    NODE_EXTRA_CA_CERTS: paths.caPem,
    ORCA_CLOUD_API_URL: `https://127.0.0.1:${options.port}`,
    ORCA_CLOUD_HOST_NAME: host.name,
    ORCA_CLOUD_HOST_TOKEN: token,
    ORCA_CLOUD_PROJECTS_ROOT: host.projects,
    ORCA_CLOUD_TLS_CERT_PATH: host.cert,
    ORCA_CLOUD_TLS_KEY_PATH: host.key,
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

export async function findAdvertisedHost(api, adminToken, options, host) {
  const hosts = (await api('GET', '/v1/hosts', { token: adminToken })).json?.hosts ?? []
  const found = hosts.find((candidate) => candidate.name === host.name)
  const advertised = (found?.directAddrs ?? []).some((addr) =>
    addr.startsWith(`${options.advertiseHost}:`)
  )
  return found?.online && advertised ? found : null
}

export async function ensureHost(api, paths, options, host, token, adminToken) {
  const entry = path.join(ROOT, 'out/main/index.js')
  if (!exists(entry)) {
    throw new Error(`missing build: ${entry} — run pnpm build:electron-vite`)
  }
  await killTree(readPid(host.pid))
  for (const pid of (tryRun('pgrep', ['-f', host.ud]) ?? '').split(/\s+/).map(Number)) {
    if (Number.isInteger(pid) && pid !== process.pid) {
      await killTree(pid)
    }
  }
  fs.rmSync(host.credential, { force: true })
  await ensureSource(paths.supervisor, SUPERVISOR)
  const pid = spawnDetached({
    command: process.execPath,
    args: [paths.supervisor, electronBinary(), entry],
    env: hostEnv(paths, options, host, token),
    logFile: host.log,
    pidFile: host.pid
  })
  const found = await waitFor(
    `host ${host.name} online`,
    () => findAdvertisedHost(api, adminToken, options, host),
    120000,
    1000
  )
  return { pid, host: found, reused: false }
}
