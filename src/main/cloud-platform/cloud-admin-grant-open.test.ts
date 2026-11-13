import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
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
import { ensureCloudWorkspace } from './cloud-workspace-ensure'

/**
 * M95 (AC-04): an admin registers a project and grants a group; a member who is
 * already signed in refreshes and sees it, and can actually open it. The proof
 * AC-04 was missing was the open — a 200 ticket is not the same as a working
 * workspace over a real host.
 *
 * Real platform, real enrolment, real TLS runtime, real end-to-end encryption.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm95-admin-grant-open')
const PROJECT_KEY = 'm95-granted-project'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

type Stack = {
  platform: Platform
  cloud: CloudRuntime
  admission: CloudRuntimeAdmission
  projectRoot: string
  projectId: string
  adminToken: string
}

let stack: Stack

beforeAll(async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m95-')))
  installFakeAppEnvironment({ getPath: () => dir })
  const store = createSqliteTestStore(Store, { dataFile: join(dir, 'orca-data.json') })
  const projectRoot = join(dir, 'granted-service')
  mkdirSync(projectRoot, { recursive: true })
  git(projectRoot, 'init', '-q', '-b', 'main')
  git(projectRoot, 'config', 'user.email', 'e2e@example.com')
  git(projectRoot, 'config', 'user.name', 'e2e')
  writeFileSync(join(projectRoot, 'README.md'), '# granted-service\n')
  git(projectRoot, 'add', '.')
  git(projectRoot, 'commit', '-qm', 'init')
  store.addRepo({
    id: 'repo-m95',
    path: projectRoot,
    displayName: 'granted-service',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm95-admin' })
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

  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-m95',
      // The runtime binds loopback; without an advertised host the platform
      // hands out no direct address and the client has no relay to fall back to.
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
    userDataPrefix: 'orca-m95-',
    service,
    tls: makeSelfSignedTls('dev-m95'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  stack = {
    platform,
    cloud,
    admission,
    projectRoot,
    projectId: '',
    adminToken
  }
}, 180_000)

afterAll(async () => {
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.platform.stop()
})

describe('AC-04 管理员登记项目并授权组，成员刷新可见并能真实打开（真实平台 + 真实 Runtime）', () => {
  it('M95-1 成员在项目创建前登录，刷新后可见新项目并打开为可用工作区', async () => {
    const client = new CloudConnectClient({
      apiUrl: stack.platform.url,
      tlsRejectUnauthorized: false
    })
    await client.login('zhangsan', 'Passw0rd!')

    // ---- before the grant: the project does not exist yet, so it cannot be seen ----
    const before = await client.listProjects()
    expect(before.map((project) => project.key)).not.toContain(PROJECT_KEY)

    // ---- admin registers the project on the real host and grants the group ----
    const created = await fetch(`${stack.platform.url}/v1/projects`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${stack.adminToken}`
      },
      body: JSON.stringify({
        key: PROJECT_KEY,
        name: PROJECT_KEY,
        hostId: stack.admission.host()!.hostId,
        path: stack.projectRoot
      })
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const projectId = readString(await created.json(), 'id')
    if (projectId === null) {
      throw new Error('project id missing')
    }
    stack.projectId = projectId

    const granted = await fetch(`${stack.platform.url}/v1/projects/${projectId}/grants`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${stack.adminToken}`
      },
      body: JSON.stringify({
        subjectType: 'group',
        subjectId: 'team-payment',
        permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
      })
    })
    expect(granted.status, await granted.clone().text()).toBe(200)

    // ---- the same signed-in member refreshes: no re-login, no new process ----
    const after = await client.listProjects()
    const listed = after.find((project) => project.key === PROJECT_KEY)
    expect(listed, JSON.stringify(after)).toBeTruthy()
    expect(listed?.hostStatus).toBe('online')
    expect(listed?.permissions).toContain('open')

    // ---- and actually opens it: real ticket, real TLS, real workspace ----
    const ensured = await ensureCloudWorkspace(client, projectId)
    if (!ensured.ok) {
      throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
    }
    const status = await client.rpc('status.get')
    expect(status.ok, JSON.stringify(status)).toBe(true)
    const read = await client.rpc('files.read', {
      worktree: `path:${ensured.workspacePath}`,
      relativePath: 'README.md'
    })
    expect(read.ok, JSON.stringify(read)).toBe(true)

    // ---- a developer outside the group sees nothing ----
    const outsider = new CloudConnectClient({
      apiUrl: stack.platform.url,
      tlsRejectUnauthorized: false
    })
    await outsider.login('lisi', 'Passw0rd!')
    const outsiderProjects = await outsider.listProjects()
    expect(outsiderProjects.map((project) => project.key)).not.toContain(PROJECT_KEY)

    saveEvidence('admin-grant-open.json', {
      visibleBeforeGrant: false,
      visibleAfterRefresh: true,
      hostStatus: listed?.hostStatus,
      route: ensured.route,
      workspacePathTail: ensured.workspacePath.split('/').slice(-2).join('/'),
      rpcOk: status.ok,
      readOk: read.ok,
      visibleToOutsider: false
    })
    outsider.close()
    client.close()
  }, 180_000)
})
