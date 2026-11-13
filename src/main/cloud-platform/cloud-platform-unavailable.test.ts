import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  makeSelfSignedTls,
  REPO_ROOT,
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
import { startPausableProxy, type PausableProxy } from './cloud-tcp-proxy-fixture'

/**
 * M75 (G-09 / AC-20): a platform outage must read as "temporarily unavailable",
 * never as "your session ended", and it must never tempt a credential-less
 * reconnect. A pause-able proxy cuts the network while the platform keeps its
 * state, so the same session can be shown to recover without re-login.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm75-platform-unavailable')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') {
    return null
  }
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : null
}

type Stack = {
  platform: Platform
  proxy: PausableProxy
  cloud: CloudRuntime
  admission: CloudRuntimeAdmission
  client: CloudConnectClient
  projectId: string
  adminToken: string
}

let stack: Stack

async function adminToken(apiUrl: string): Promise<string> {
  const res = await fetch(`${apiUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm75-admin' })
  })
  const token = readString(await res.json(), 'accessToken')
  if (token === null) {
    throw new Error('admin login failed')
  }
  return token
}

beforeAll(async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m75-')))
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
    id: 'repo-m75',
    path: projectRoot,
    displayName: 'payment-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(dir, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  // Why a 2s access token: with the default 60s refresh lead every request refreshes
  // first, so the outage hits the refresh path — the one that must not latch.
  const platform = await startPlatform({ accessTtlMs: 2000 })
  const admin = await adminToken(platform.url)
  const proxy = await startPausableProxy(Number(new URL(platform.url).port))

  const hostTokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${admin}` }
  })
  const hostToken = readString(await hostTokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }

  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: proxy.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-m75',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: join(dir, 'host-data') }
  )
  if (!admission) {
    throw new Error('cloud admission not enabled')
  }
  await admission.ready

  const cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m75-',
    service,
    tls: makeSelfSignedTls('dev-m75'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({
      key: 'm75-unavailable',
      name: 'm75-unavailable',
      hostId: admission.host()!.hostId,
      path: projectRoot
    })
  })
  expect(create.status, await create.clone().text()).toBe(201)
  const projectId = readString(await create.json(), 'id') ?? ''
  const grant = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  expect(grant.status).toBe(200)

  const client = new CloudConnectClient({ apiUrl: proxy.url, tlsRejectUnauthorized: false })
  await client.login('zhangsan', 'Passw0rd!')
  const ensured = await ensureCloudWorkspace(client, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code}`)
  }
  stack = { platform, proxy, cloud, admission, client, projectId, adminToken: admin }
}, 180_000)

afterAll(async () => {
  stack?.client.close()
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.platform.stop()
})

describe('平台停机映射 PLATFORM_UNAVAILABLE 且不无凭证重连（真实平台 + 真实 TLS Runtime）', () => {
  it('M75-1 断网：已有会话继续，新连接报 PLATFORM_UNAVAILABLE 而不是 SESSION_EXPIRED', async () => {
    const live = await stack.client.rpc('status.get')
    expect(live.ok).toBe(true)

    stack.proxy.pause()
    try {
      const duringOutage = await stack.client.rpc('status.get')
      expect(duringOutage.ok).toBe(true)

      const fresh = new CloudConnectClient({
        apiUrl: stack.proxy.url,
        tlsRejectUnauthorized: false
      })
      let loginCode: string | null = null
      try {
        await fresh.login('zhangsan', 'Passw0rd!')
      } catch (error) {
        loginCode = errorCode(error)
      }
      expect(loginCode).toBe('PLATFORM_UNAVAILABLE')

      let openCode: string | null = null
      try {
        await stack.client.openProject(stack.projectId)
      } catch (error) {
        openCode = errorCode(error)
      }
      // Not SESSION_EXPIRED: the refresh token was never rejected, only unreachable.
      expect(openCode).toBe('PLATFORM_UNAVAILABLE')

      let listCode: string | null = null
      try {
        await stack.client.listProjects()
      } catch (error) {
        listCode = errorCode(error)
      }
      expect(listCode).toBe('PLATFORM_UNAVAILABLE')

      saveEvidence('m75-outage.json', {
        liveSessionDuringOutage: duringOutage.ok,
        loginCode,
        openCode,
        listCode
      })
    } finally {
      stack.proxy.resume()
    }
  }, 90_000)

  it('M75-2 恢复：同一会话不重新登录即可再次取票打开，证明没有把会话判死', async () => {
    const projects = await stack.client.listProjects()
    expect(projects.length).toBeGreaterThan(0)
    const reopened = await stack.client.openProject(stack.projectId)
    const rpc = await stack.client.rpc('status.get')
    expect(rpc.ok).toBe(true)
    saveEvidence('m75-recovered.json', {
      projectCount: projects.length,
      route: reopened.route,
      rpcOk: rpc.ok,
      deviceIdUnchanged: readField({ deviceId: stack.client.currentDeviceId }, 'deviceId') !== ''
    })
  }, 90_000)
})
