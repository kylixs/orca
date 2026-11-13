import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import {
  DEFAULT_INTERNAL_TOKEN,
  REPO_ROOT,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { CloudConnectClient } from './cloud-connect-client'
import { startRecordingProxy, type RecordingProxy } from './cloud-tcp-proxy-fixture'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'

/**
 * M90 (AC-06): when direct is impossible the session falls back to the relay, and
 * the terminal must still be usable there. A real relay process carries a real
 * PTY: the client opens a terminal, subscribes, types a marker and reads the
 * shell's own output back over the relayed, end-to-end encrypted socket.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm90-terminal-over-relay')
const MARKER = 'ORCA_M90_RELAY_TERMINAL_OK'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

type RelayProcess = { port: number; logs: () => string; stop: () => Promise<void> }

async function startRelayProcess(apiUrl: string): Promise<RelayProcess> {
  const proc = spawn(process.execPath, ['cloud-platform/apps/relay/src/relay.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: '0',
      API_URL: apiUrl,
      INTERNAL_TOKEN: DEFAULT_INTERNAL_TOKEN
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  const append = (chunk: Buffer): void => {
    out += chunk.toString()
  }
  proc.stdout?.on('data', append)
  proc.stderr?.on('data', append)
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${out}`)), 15_000)
    const tick = (): void => {
      const match = out.match(/\[relay\] listening on :(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
        return
      }
      if (proc.exitCode !== null) {
        clearTimeout(timer)
        reject(new Error(`relay exited early: ${out}`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
  return {
    port,
    logs: () => out,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve()
          return
        }
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
      })
  }
}

/** A real shell: node-pty spawns it, and its output feeds the runtime's own path. */
function installRealPtyController(service: OrcaRuntimeService): void {
  const terminals = new Map<string, { write(data: string): void; kill(): void }>()
  let seq = 0
  service.setPtyController({
    spawn: async (opts) => {
      const nodePty = await import('node-pty')
      const id = `pty-m90-${++seq}`
      const term = nodePty.spawn(process.env.SHELL ?? '/bin/sh', [], {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd ?? process.cwd(),
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? tmpdir(),
          TERM: 'xterm-256color',
          PS1: '$ '
        }
      })
      term.onData((data) => service.onPtyData(id, data, Date.now()))
      terminals.set(id, { write: (data) => term.write(data), kill: () => term.kill() })
      return { id, pid: term.pid }
    },
    write: (ptyId, data) => {
      terminals.get(ptyId)?.write(data)
      return true
    },
    kill: (ptyId) => {
      terminals.get(ptyId)?.kill()
      return true
    },
    getForegroundProcess: async () => null
  })
}

function waitForEvent(
  events: unknown[],
  predicate: (event: unknown) => boolean,
  timeoutMs = 20_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (events.some(predicate)) {
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for a stream event; saw ${JSON.stringify(events)}`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

const isDataContaining = (needle: string) => (event: unknown) =>
  readString(event, 'type') === 'data' && (readString(event, 'chunk') ?? '').includes(needle)

type Stack = {
  platform: Platform
  cloud: CloudRuntime
  admission: CloudRuntimeAdmission
  relay: RelayProcess
  hop: RecordingProxy
  client: CloudConnectClient
  projectId: string
  workspacePath: string
  route: 'direct' | 'relay'
}

let stack: Stack
let runtimePort = 0

beforeAll(async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m90-')))
  installFakeAppEnvironment({ getPath: () => dir })
  const store = createSqliteTestStore(Store, { dataFile: join(dir, 'orca-data.json') })
  const projectRoot = join(dir, 'payment-service')
  mkdirSync(projectRoot, { recursive: true })
  git(projectRoot, 'init', '-q', '-b', 'main')
  git(projectRoot, 'config', 'user.email', 'e2e@example.com')
  git(projectRoot, 'config', 'user.name', 'e2e')
  writeFileSync(join(projectRoot, 'README.md'), 'hello\n')
  git(projectRoot, 'add', '.')
  git(projectRoot, 'commit', '-qm', 'init')
  store.addRepo({
    id: 'repo-m90',
    path: projectRoot,
    displayName: 'payment-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(dir, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)
  installRealPtyController(service)

  const platform = await startPlatform()
  const adminLogin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm90-admin' })
  })
  const adminToken = readString(await adminLogin.json(), 'accessToken')
  if (adminToken === null) {
    throw new Error('admin login failed')
  }
  const hostTokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await hostTokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }

  // No advertised address and no extra addresses: direct is impossible by design,
  // so the client has to find the relay. The runtime's TLS port does not exist
  // yet at enrolment, so the relay target goes through a hop that resolves late.
  const hop = await startRecordingProxy(() => runtimePort)
  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-m90'
    },
    {
      userDataPath: join(dir, 'host-data'),
      relayTarget: `127.0.0.1:${Number(new URL(hop.url).port)}`
    }
  )
  if (!admission) {
    throw new Error('cloud admission not enabled')
  }
  await admission.ready

  const cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m90-',
    service,
    tls: makeSelfSignedTls('dev-m90'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  runtimePort = Number(new URL(cloud.endpoint).port)

  const relay = await startRelayProcess(platform.url)
  const deadline = Date.now() + 20_000
  let announced = false
  while (Date.now() < deadline) {
    if (/routes synced n=\d+/.test(relay.logs())) {
      const view = await fetch(`${platform.url}/v1/internal/relays`, {
        headers: { 'x-internal-token': DEFAULT_INTERNAL_TOKEN }
      })
      const nodes = readField(await view.json(), 'relays')
      announced =
        Array.isArray(nodes) &&
        nodes.some(
          (node) => readField(node, 'port') === relay.port && readField(node, 'online') === true
        )
      if (announced) {
        break
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  expect(announced, `relay never registered: ${relay.logs()}`).toBe(true)

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm90-terminal-relay',
      name: 'm90-terminal-relay',
      hostId: admission.host()!.hostId,
      path: projectRoot
    })
  })
  expect(create.status, await create.clone().text()).toBe(201)
  const projectId = readString(await create.json(), 'id') ?? ''
  const grant = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  expect(grant.status).toBe(200)

  const client = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await client.login('zhangsan', 'Passw0rd!')
  const ensured = await ensureCloudWorkspace(client, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
  }
  expect(ensured.route).toBe('relay')
  stack = {
    platform,
    cloud,
    admission,
    relay,
    hop,
    client,
    projectId,
    workspacePath: ensured.workspacePath,
    route: ensured.route
  }
}, 180_000)

afterAll(async () => {
  stack?.client.close()
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.relay.stop()
  await stack?.hop.close()
  await stack?.platform.stop()
})

describe('中继线路下的终端（真实中继进程 + 真实 TLS Runtime + 真实 PTY）', () => {
  it('M90-1 回落到中继后创建终端、写入并读到 shell 真实输出', async () => {
    expect(stack.route).toBe('relay')
    const created = await stack.client.rpc('terminal.create', {
      worktree: `path:${stack.workspacePath}`,
      title: 'm90-relay-pane'
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    if (!created.ok) {
      return
    }
    const terminal = readString(readField(created.result, 'terminal'), 'handle')
    if (terminal === null) {
      throw new Error(`no terminal handle in ${JSON.stringify(created)}`)
    }

    const events: unknown[] = []
    const subscription = stack.client.subscribe('terminal.subscribe', { terminal }, (event) => {
      events.push(event)
    })
    if (subscription === null) {
      throw new Error('subscribe returned null')
    }
    await waitForEvent(events, (event) => readString(event, 'type') === 'scrollback')

    const sent = await stack.client.rpc('terminal.send', { terminal, text: `echo ${MARKER}\n` })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await waitForEvent(events, isDataContaining(MARKER))

    await stack.client.rpc('terminal.unsubscribe', {
      subscriptionId: terminal,
      requestId: subscription.requestId
    })
    await subscription.done
    await stack.client.rpc('terminal.close', { terminal })

    // A file RPC over the same relayed socket, to show the session is not terminal-only.
    const write = await stack.client.rpc('files.write', {
      worktree: `path:${stack.workspacePath}`,
      relativePath: 'relay-note.txt',
      content: 'written over relay\n',
      expectedExecutionHostId: 'local'
    })
    expect(write.ok, JSON.stringify(write)).toBe(true)

    saveEvidence('terminal-over-relay.json', {
      route: stack.route,
      relayPort: stack.relay.port,
      terminal,
      eventTypes: events.map((event) => readString(event, 'type')),
      sawMarker: events.some(isDataContaining(MARKER)),
      fileWriteOverRelay: write.ok,
      relayLogLines: stack.relay.logs().trim().split('\n').length
    })
  }, 120_000)
})
