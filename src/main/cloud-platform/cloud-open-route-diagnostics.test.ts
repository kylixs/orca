import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import {
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
import { openCloudProject } from './cloud-project-open-result'

/**
 * M101 (FR-5.7): a working workspace must be able to say which line it is on and
 * what that line cost. The probe log already existed for failures; it now rides
 * on a successful open too, through IPC, so the UI can show 直连/中继 + latency
 * and a diagnosis panel before anything breaks.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm101-open-route-diagnostics')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** A port nothing listens on: the direct probe fails fast. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

type Stack = {
  platform: Platform
  cloud: CloudRuntime
  admission: CloudRuntimeAdmission
  projectId: string
  projectRoot: string
}

let stack: Stack

beforeAll(async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m101-')))
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
    id: 'repo-m101',
    path: projectRoot,
    displayName: 'p',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm101-admin' })
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
  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-m101',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: join(dir, 'host-data'), directAddrs: [`127.0.0.1:${deadDirect}`] }
  )
  if (!admission) {
    throw new Error('cloud admission not enabled')
  }
  await admission.ready

  const cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m101-',
    service,
    tls: makeSelfSignedTls('dev-m101'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm101-diagnostics',
      name: 'm101-diagnostics',
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
  stack = { platform, cloud, admission, projectId, projectRoot }
}, 180_000)

afterAll(async () => {
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.platform.stop()
})

describe('FR-5.7 打开成功时也带线路与延迟（真实平台 + 真实 Runtime）', () => {
  it('M101-1 首个直连地址不可用时继续探测，成功的打开结果里带逐地址探测与选中线路的延迟', async () => {
    const client = new CloudConnectClient({
      apiUrl: stack.platform.url,
      tlsRejectUnauthorized: false
    })
    await client.login('zhangsan', 'Passw0rd!')

    const result = await openCloudProject(
      {
        // Same shape the session service provides: a connection record plus probes.
        open: async (id) => {
          const opened = await client.openProject(id)
          return {
            connection: { route: opened.route },
            ticket: opened.ticket,
            probes: opened.probes
          }
        },
        pinnedFingerprint: () => null,
        failureCode: () => 'OPEN_FAILED'
      },
      stack.projectId
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) {
      return
    }

    const probes = result.connectDiagnostics?.probes ?? []
    expect(probes.length).toBeGreaterThanOrEqual(2)
    // Every attempt is recorded in order: the dead address first, then the winner.
    expect(probes[0]?.route).toBe('direct')
    expect(probes[0]?.ok).toBe(false)
    expect(probes.slice(1).some((probe) => probe.ok)).toBe(true)
    const chosen = probes.findLast((probe) => probe.ok)
    expect(chosen, JSON.stringify(probes)).toBeTruthy()
    expect(chosen?.route).toBe(result.route)
    expect(typeof chosen?.elapsedMs).toBe('number')
    expect(chosen?.endpoint).toMatch(/^127\.0\.0\.1:\d+$/)

    // The workspace really is usable on that line.
    const status = await client.rpc('status.get')
    expect(status.ok, JSON.stringify(status)).toBe(true)

    saveEvidence('open-route-diagnostics.json', {
      route: result.route,
      probes,
      chosen: { route: chosen?.route, endpoint: chosen?.endpoint, elapsedMs: chosen?.elapsedMs },
      rpcOk: status.ok
    })
    client.close()
  }, 120_000)
})
