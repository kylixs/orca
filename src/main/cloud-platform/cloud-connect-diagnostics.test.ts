import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
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
import { startPausableProxy, type PausableProxy } from './cloud-tcp-proxy-fixture'
import { failedCloudOpen } from './cloud-project-open-result'
import type { CloudEndpointProbe } from '../../shared/cloud-platform-ipc'

/**
 * M91 (AC-07): when neither the direct address nor the relay answers, the user
 * must see the code AND which addresses were tried, and a retry must work once
 * the path is back. Real platform, real ticket, real TCP: the relay hop is a
 * pause-able proxy so the outage is genuine from the client's point of view.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm91-connect-diagnostics')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** A TCP port nothing listens on: connect is refused immediately. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

type RelayProcess = { port: number; logs: () => string; stop: () => Promise<void> }

/** A real relay process: its port is what the platform hands out as the relay endpoint. */
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

/** Waits until the platform publishes this relay as healthy, so /connect hands it out. */
async function waitForRelay(platform: Platform, relay: RelayProcess): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (/routes synced n=\d+/.test(relay.logs())) {
      const view = await fetch(`${platform.url}/v1/internal/relays`, {
        headers: { 'x-internal-token': DEFAULT_INTERNAL_TOKEN }
      })
      const nodes = readField(await view.json(), 'relays')
      const online =
        Array.isArray(nodes) &&
        nodes.some(
          (node) => readField(node, 'port') === relay.port && readField(node, 'online') === true
        )
      if (online) {
        return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`relay never registered: ${relay.logs()}`)
}

function errorProbes(error: unknown): CloudEndpointProbe[] {
  const probes = error === null || typeof error !== 'object' ? null : Reflect.get(error, 'probes')
  if (!Array.isArray(probes)) {
    return []
  }
  return probes.filter(
    (probe): probe is CloudEndpointProbe =>
      probe !== null &&
      typeof probe === 'object' &&
      typeof Reflect.get(probe, 'endpoint') === 'string' &&
      typeof Reflect.get(probe, 'ok') === 'boolean' &&
      typeof Reflect.get(probe, 'elapsedMs') === 'number' &&
      (Reflect.get(probe, 'route') === 'direct' || Reflect.get(probe, 'route') === 'relay')
  )
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' ? String(Reflect.get(error, 'code')) : null
}

type Stack = {
  platform: Platform
  cloud: CloudRuntime
  admission: CloudRuntimeAdmission
  proxy: PausableProxy
  relay: RelayProcess
  client: CloudConnectClient
  projectId: string
}

let stack: Stack
let runtimePort = 0

beforeAll(async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m91-')))
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
    id: 'repo-m91',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm91-admin' })
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

  const deadDirect = await closedPort()
  const proxy = await startPausableProxy(() => runtimePort)
  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-m91'
    },
    {
      userDataPath: join(dir, 'host-data'),
      // Right now nothing answers on this address — that is the point.
      directAddrs: [`127.0.0.1:${deadDirect}`],
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
    userDataPrefix: 'orca-m91-',
    service,
    tls: makeSelfSignedTls('dev-m91'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()
  runtimePort = Number(new URL(cloud.endpoint).port)

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm91-diagnostics',
      name: 'm91-diagnostics',
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
      permissions: ['open', 'terminal', 'file:read']
    })
  })
  expect(grant.status).toBe(200)

  // A real relay so the ticket carries a relay endpoint; it is killed before the
  // failure case, which is exactly "the relay does not answer".
  const relay = await startRelayProcess(platform.url)
  await waitForRelay(platform, relay)

  const client = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await client.login('zhangsan', 'Passw0rd!')
  stack = { platform, cloud, admission, proxy, relay, client, projectId }
}, 180_000)

afterAll(async () => {
  stack?.client.close()
  stack?.admission.client?.stop()
  await stack?.relay.stop()
  await stack?.cloud.runtime.stop()
  await stack?.platform.stop()
})

describe('AC-07 直连与中继均不可达：错误码 + 分步诊断 + 重试（真实平台 + 真实 TCP）', () => {
  it('M91-1 两条线路都不通时给出逐地址诊断，恢复后重试成功', async () => {
    // Both hops are genuinely down: the direct address is a closed port and the
    // relay process is gone.
    stack.proxy.pause()
    await stack.relay.stop()

    let thrown: unknown = null
    try {
      await stack.client.openProject(stack.projectId)
    } catch (error) {
      thrown = error
    }
    expect(thrown, 'an outage must not silently succeed').not.toBeNull()
    expect(errorCode(thrown)).toBe('ENDPOINT_UNREACHABLE')

    // The probe log is what the failure panel shows; read it the way the panel does.
    const steps = errorProbes(thrown)
    expect(steps.length).toBeGreaterThanOrEqual(2)
    expect(steps[0]?.route).toBe('direct')
    expect(steps[0]?.ok).toBe(false)
    expect(steps.some((step) => step.route === 'relay' && !step.ok)).toBe(true)
    expect(steps.every((step) => /^127\.0\.0\.1:\d+$/.test(step.endpoint))).toBe(true)
    expect(steps.every((step) => typeof step.elapsedMs === 'number')).toBe(true)

    // The renderer receives the same list through the IPC result, not just an error string.
    const openResult = failedCloudOpen('ENDPOINT_UNREACHABLE', thrown)
    expect(openResult.ok).toBe(false)
    if (!openResult.ok) {
      expect(openResult.connectDiagnostics?.probes.length).toBe(steps.length)
      expect(openResult.connectDiagnostics?.probes[0]?.route).toBe('direct')
    }

    // ---- retry: the same client, no re-login, once the path is back ----
    stack.proxy.resume()
    const restarted = await startRelayProcess(stack.platform.url)
    await waitForRelay(stack.platform, restarted)
    const opened = await stack.client.openProject(stack.projectId)
    expect(opened.route).toBe('relay')
    const who = await stack.client.rpc('status.get')
    expect(who.ok, JSON.stringify(who)).toBe(true)

    await restarted.stop()
    saveEvidence('connect-diagnostics.json', {
      code: 'ENDPOINT_UNREACHABLE',
      steps,
      ipcProbeCount: openResult.ok ? null : (openResult.connectDiagnostics?.probes.length ?? 0),
      deadRelayPort: stack.relay.port,
      restartedRelayPort: restarted.port,
      retryRoute: opened.route,
      retryRpcOk: who.ok
    })
  }, 120_000)
})
