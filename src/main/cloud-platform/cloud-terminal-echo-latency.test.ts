import { execFileSync } from 'node:child_process'
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
import {
  installRealPtyController,
  startRelayProcess,
  type RelayProcess
} from './cloud-terminal-e2e-fixture'
import { startLatencyHop, type LatencyHop } from './cloud-latency-hop-fixture'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'

/**
 * M102 (requirements §5.1): terminal input echo P95 ≤ 120ms. Measured on the
 * worst line the product offers — relayed TCP, real TLS, E2EE, real runtime and
 * a real PTY with a real shell — from the byte leaving the client to the echoed
 * byte arriving back. A delayed hop proves the number measures the path.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm102-terminal-echo-latency')
const BUDGET_MS = 120
const SAMPLES = 50
const WARMUP = 5
const CONTROL_SAMPLES = 20
const INJECTED_DELAY_MS = 150
const KEYS = 'qjkvxzwypbfghmnrstuioledca'
const QUIET_MS = 80

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

type EchoStats = { samples: number; p50: number; p95: number; min: number; max: number }

function statsOf(values: number[]): EchoStats {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (percent: number): number => {
    const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)
    return round(sorted[Math.max(0, index)] ?? 0)
  }
  return {
    samples: sorted.length,
    p50: at(50),
    p95: at(95),
    min: round(sorted[0] ?? 0),
    max: round(sorted.at(-1) ?? 0)
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** The product's own acceptance check; the delayed run must make this throw. */
function assertEchoBudget(stats: EchoStats, budget: number): void {
  if (stats.p95 > budget) {
    throw new Error(`terminal echo P95 ${stats.p95}ms over budget ${budget}ms`)
  }
}

type Stack = {
  platform: Platform
  cloud: CloudRuntime
  admission: CloudRuntimeAdmission
  relay: RelayProcess
  hop: LatencyHop
  client: CloudConnectClient
  projectId: string
  workspacePath: string
  route: 'direct' | 'relay'
}

let stack: Stack
let runtimePort = 0

beforeAll(async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m102-')))
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
    id: 'repo-m102',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm102-admin' })
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

  // Relay-only by design: no advertised address, so the slowest supported line
  // is the one measured. The relay target goes through the delay hop.
  const hop = await startLatencyHop(() => runtimePort)
  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-m102'
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
    userDataPrefix: 'orca-m102-',
    service,
    tls: makeSelfSignedTls('dev-m102'),
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
      key: 'm102-echo-latency',
      name: 'm102-echo-latency',
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

describe('终端输入回显延迟（真实中继 + 真实 TLS + E2EE + 真实 PTY）', () => {
  it('M102-1 中继线路上的输入回显 P95 ≤ 120ms；注入 150ms 延迟时同一断言转红', async () => {
    expect(stack.route).toBe('relay')
    const created = await stack.client.rpc('terminal.create', {
      worktree: `path:${stack.workspacePath}`,
      title: 'm102-echo-pane'
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    if (!created.ok) {
      return
    }
    const terminal = readString(readField(created.result, 'terminal'), 'handle')
    if (terminal === null) {
      throw new Error(`no terminal handle in ${JSON.stringify(created)}`)
    }

    let lastDataAt = 0
    let expected: string | null = null
    let resolveEcho: ((at: number) => void) | null = null
    const subscription = stack.client.subscribe('terminal.subscribe', { terminal }, (event) => {
      if (readString(event, 'type') !== 'data') {
        return
      }
      const chunk = readString(event, 'chunk') ?? ''
      const at = performance.now()
      lastDataAt = at
      if (expected !== null && chunk.includes(expected) && resolveEcho !== null) {
        const done = resolveEcho
        expected = null
        resolveEcho = null
        done(at)
      }
    })
    if (subscription === null) {
      throw new Error('subscribe returned null')
    }

    const waitQuiet = async (): Promise<void> => {
      const started = Date.now()
      while (Date.now() - started < 5_000) {
        if (lastDataAt !== 0 && performance.now() - lastDataAt > QUIET_MS) {
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('terminal never went quiet')
    }

    // Why `cat`: the line discipline echoes each byte with no prompt redraw, so a
    // keystroke maps to exactly one echo — the product's input-echo path, uncluttered.
    const started = await stack.client.rpc('terminal.send', { terminal, text: 'cat\r' })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    await waitQuiet()

    const measure = async (key: string): Promise<number> => {
      const echo = new Promise<number>((resolve, reject) => {
        expected = key
        resolveEcho = resolve
        setTimeout(() => {
          if (resolveEcho === resolve) {
            expected = null
            resolveEcho = null
            reject(new Error(`no echo for ${JSON.stringify(key)}`))
          }
        }, 5_000)
      })
      const t0 = performance.now()
      const sent = await stack.client.rpc('terminal.send', { terminal, text: key })
      expect(sent.ok, JSON.stringify(sent)).toBe(true)
      return (await echo) - t0
    }

    const runSamples = async (count: number): Promise<number[]> => {
      const values: number[] = []
      for (let index = 0; index < count; index += 1) {
        const key = KEYS[index % KEYS.length] ?? 'q'
        values.push(await measure(key))
      }
      return values
    }

    await runSamples(WARMUP)
    const normal = statsOf(await runSamples(SAMPLES))
    assertEchoBudget(normal, BUDGET_MS)

    stack.hop.setDelayMs(INJECTED_DELAY_MS)
    await waitQuiet()
    await runSamples(3)
    const injected = statsOf(await runSamples(CONTROL_SAMPLES))
    expect(() => assertEchoBudget(injected, BUDGET_MS)).toThrow(/over budget/)

    stack.hop.setDelayMs(0)
    await waitQuiet()
    await runSamples(3)
    const restored = statsOf(await runSamples(CONTROL_SAMPLES))
    assertEchoBudget(restored, BUDGET_MS)

    await stack.client.rpc('terminal.send', { terminal, text: '\u0003' })
    await stack.client.rpc('terminal.unsubscribe', {
      subscriptionId: terminal,
      requestId: subscription.requestId
    })
    await subscription.done
    await stack.client.rpc('terminal.close', { terminal })

    saveEvidence('terminal-echo-latency.json', {
      route: stack.route,
      budgetMs: BUDGET_MS,
      samples: SAMPLES,
      normal,
      injected: { delayMs: INJECTED_DELAY_MS, ...injected },
      restored,
      shell: process.env.SHELL ?? '/bin/sh',
      platform: process.platform,
      node: process.version
    })

    expect(injected.p95).toBeGreaterThanOrEqual(normal.p95 + INJECTED_DELAY_MS / 2)
    expect(restored.p95).toBeLessThanOrEqual(BUDGET_MS)
  }, 180_000)
})
