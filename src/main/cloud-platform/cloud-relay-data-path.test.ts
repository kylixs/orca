import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
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
import { ensureCloudWorkspace } from './cloud-workspace-ensure'
import { startRecordingProxy, type RecordingProxy } from './cloud-tcp-proxy-fixture'

/**
 * M86 (AC-24 relay half): the relay forwards ciphertext and records metadata only.
 * A real session is forced through a real relay — the host advertises no direct
 * address — and every byte the relay sends toward the runtime is recorded. The
 * payload marker must not appear in those bytes or in the relay's own records.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm86-relay-data-path')
const MARKER = 'M86_RELAY_PAYLOAD_c41e77_'
const PAYLOAD = MARKER.repeat(1500)

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

type Stack = {
  platform: Platform
  proxy: RecordingProxy
  cloud: CloudRuntime
  admission: CloudRuntimeAdmission
  relay: RelayProcess
  client: CloudConnectClient
  projectId: string
  workspacePath: string
  route: 'direct' | 'relay'
}

let stack: Stack
let runtimePort = 0

type RelayProcess = { port: number; logs: () => string; stop: () => Promise<void> }

/** A real relay process: it syncs routes and forwards bytes over real sockets. */
async function startRelayProcess(apiUrl: string): Promise<RelayProcess> {
  const proc = spawn(process.execPath, ['cloud-platform/apps/relay/src/relay.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: '0', API_URL: apiUrl, INTERNAL_TOKEN: DEFAULT_INTERNAL_TOKEN },
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

beforeAll(async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m86-')))
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
    id: 'repo-m86',
    path: projectRoot,
    displayName: 'payment-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(dir, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  const platform = await startPlatform()
  const adminLogin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm86-admin' })
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

  // Tap the relay's egress: the relay dials this proxy, which dials the runtime.
  const proxy = await startRecordingProxy(() => runtimePort)

  // No advertised host and no extra addresses: the platform hands out no direct
  // endpoint, so the client must reach the runtime through the relay.
  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-m86'
    },
    {
      userDataPath: join(dir, 'host-data'),
      relayTarget: `127.0.0.1:${Number(new URL(proxy.url).port)}`
    }
  )
  if (!admission) {
    throw new Error('cloud admission not enabled')
  }
  await admission.ready

  const cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m86-',
    service,
    tls: makeSelfSignedTls('dev-m86'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()
  runtimePort = Number(new URL(cloud.endpoint).port)

  const relay = await startRelayProcess(platform.url)
  // The relay syncs routes on a 2s timer and then announces itself; the platform
  // must know it before /connect can hand its endpoint out.
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
      key: 'm86-relay-path',
      name: 'm86-relay-path',
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
  stack = {
    platform,
    proxy,
    cloud,
    admission,
    relay,
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
  await stack?.proxy.close()
  await stack?.platform.stop()
})

/** Writes the marker through the proxy as raw bytes, to prove the tap sees plaintext. */
function writePlainThroughProxy(): Promise<void> {
  const port = Number(new URL(stack.proxy.url).port)
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.end(Buffer.from(MARKER))
      resolve()
    })
    socket.on('error', reject)
  })
}

describe('中继只转发密文、只记元数据（真实中继 + 真实 TLS Runtime + E2EE）', () => {
  it('M86-1 会话经中继完成；中继出向字节与其记录均无负载明文', async () => {
    expect(stack.route).toBe('relay')
    const bytesBefore = stack.proxy.totalBytes()

    const write = await stack.client.rpc('files.write', {
      worktree: `path:${stack.workspacePath}`,
      relativePath: 'relay-payload.txt',
      content: PAYLOAD,
      expectedExecutionHostId: 'local'
    })
    expect(write.ok, JSON.stringify(write)).toBe(true)
    const read = await stack.client.rpc('files.read', {
      worktree: `path:${stack.workspacePath}`,
      relativePath: 'relay-payload.txt'
    })
    if (!read.ok) {
      throw new Error(`read failed: ${read.code} ${read.message ?? ''}`)
    }
    expect(JSON.stringify(read.result)).toContain(MARKER)

    const relayBytes = stack.proxy.captured().subarray(bytesBefore)
    // The hop really carried this session, in both directions...
    expect(relayBytes.length).toBeGreaterThan(Buffer.byteLength(PAYLOAD))
    // ...but only as ciphertext.
    expect(relayBytes.includes(Buffer.from(MARKER))).toBe(false)
    // The relay's own log is metadata or silence: never the payload.
    const relayLog = stack.relay.logs()
    expect(relayLog).not.toContain(MARKER)
    expect(relayLog).toMatch(/routes synced/)

    // Control: the same tap does catch plaintext written straight through it.
    await writePlainThroughProxy()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(stack.proxy.captured().includes(Buffer.from(MARKER))).toBe(true)

    saveEvidence('relay-ciphertext-only.json', {
      route: stack.route,
      payloadBytes: Buffer.byteLength(PAYLOAD),
      relayBytesObserved: relayBytes.length,
      payloadMarkerInRelayBytes: false,
      payloadMarkerInRelayLog: false,
      relayLogLines: relayLog.trim().split('\n').length,
      tapSeesPlaintextWhenPresent: true
    })
  }, 60_000)
})
