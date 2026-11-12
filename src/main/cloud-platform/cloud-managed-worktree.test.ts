import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import {
  DEFAULT_INTERNAL_TOKEN,
  REPO_ROOT,
  connectCloudSession,
  openPlatformSession,
  startCloudRuntime,
  startPlatform,
  type CloudConnection,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import { createCloudAgentClient } from './cloud-agent-client'
import type { DeviceRegistry } from '../runtime/device-registry'

/**
 * Design §8.3 / T301a: cloud sessions create their workspace through
 * `worktree.createManaged`, which takes the root explicitly and forces nesting
 * off — so the checkout lands exactly at `<workspaceRoot>/<name>`, inside the
 * boundary M36–M38 enforce.
 *
 * Real platform, real tickets, real runtime, real git repositories.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm39-managed-worktree')
const PROJECT_KEY = 'managed-worktree-project'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'e2e@example.com')
  git(path, 'config', 'user.name', 'e2e')
  writeFileSync(join(path, 'README.md'), 'hello\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

let platform: Platform
let cloud: CloudRuntime
let client: ReturnType<typeof createCloudAgentClient>
let registry: DeviceRegistry | null = null
let projectRoot = ''
let workspaceRoot = ''
let otherRepoPath = ''
let storeWorkspaces = ''

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-managed-')))
  projectRoot = join(base, 'payment-service')
  workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
  otherRepoPath = join(base, 'other-team')
  storeWorkspaces = join(base, 'host-workspaces')
  initRepo(projectRoot)
  initRepo(otherRepoPath)
  mkdirSync(storeWorkspaces, { recursive: true })

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-managed-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-project',
    path: projectRoot,
    displayName: 'payment-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.addRepo({
    id: 'repo-other',
    path: otherRepoPath,
    displayName: 'other-team',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: storeWorkspaces, nestWorkspaces: true })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'managed-admin' })
  })
  const adminToken = readString(await admin.json(), 'accessToken')
  if (adminToken === null) {
    throw new Error('admin login failed')
  }
  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId: 'host_dev001',
      path: projectRoot
    })
  })
  expect(create.status, await create.clone().text()).toBe(201)
  const projectId = readString(await create.json(), 'id')
  const grant = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read', 'file:write']
    })
  })
  expect(grant.status).toBe(200)

  client = createCloudAgentClient({
    apiUrl: platform.url,
    internalToken: DEFAULT_INTERNAL_TOKEN,
    hostId: 'host_dev001',
    hostName: 'dev-001'
  })
  await client.refresh()
  cloud = await startCloudRuntime({
    admission: (headers) => {
      const decision = client.admit(headers)
      if (decision.ok) {
        registry?.adoptCloudDevice({
          deviceId: decision.payload.deviceId,
          token: decision.payload.deviceToken,
          name: decision.payload.sub,
          publicKeyB64: decision.payload.devicePubKey,
          project: decision.payload.project,
          permissions: decision.payload.perms,
          projectRoot: decision.payload.projectRoot,
          workspaceRoot: decision.payload.workspaceRoot
        })
      }
      return decision
    },
    connectionGate: client.connectionGate,
    userDataPrefix: 'orca-cloud-managed-',
    service,
    // Non-cloud builds do not register this method (design §8.3).
    methods: MANAGED_WORKTREE_METHODS
  })
  registry = cloud.runtime.getDeviceRegistry()
})

afterAll(async () => {
  client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

async function connect(): Promise<Extract<CloudConnection, { status: 'authenticated' }>> {
  const session = await openPlatformSession(platform, {
    projectKey: PROJECT_KEY,
    deviceName: `managed-${Math.random().toString(16).slice(2, 8)}`
  })
  const connection = await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, session)
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got close ${connection.close.code}`)
  }
  return connection
}

describe('托管工作区创建（真实平台 + 真实 Runtime + 真实仓库）', () => {
  it('M39-1 在票据工作区根下创建：路径恰为 <workspaceRoot>/<name>，且是真实 git worktree', async () => {
    const session = await connect()
    try {
      const created = await session.rpc('worktree.createManaged', {
        repo: `path:${projectRoot}`,
        workspaceRoot,
        name: 'cloud-feature',
        baseBranch: 'main',
        idempotencyKey: 'mk-1'
      })
      expect(created.ok, JSON.stringify(created)).toBe(true)

      const expectedPath = join(workspaceRoot, 'cloud-feature')
      expect(existsSync(expectedPath)).toBe(true)
      // Forced nesting off: no extra <repoName> level under the root.
      expect(existsSync(join(workspaceRoot, 'payment-service'))).toBe(false)
      // A real worktree of the project, not a copy.
      expect(git(expectedPath, 'rev-parse', '--show-toplevel').trim()).toBe(
        realpathSync(expectedPath)
      )
      expect(existsSync(join(expectedPath, 'README.md'))).toBe(true)
      // The host's own workspace directory was not used.
      expect(execFileSync('ls', [storeWorkspaces], { encoding: 'utf8' }).trim()).toBe('')

      saveEvidence('m39-1-create-in-workspace.json', { created, expectedPath })
    } finally {
      session.ws.close()
    }
  }, 60000)

  it('M39-2 同一幂等键重试返回同一工作区，不会创建第二份', async () => {
    const session = await connect()
    try {
      const first = await session.rpc('worktree.createManaged', {
        repo: `path:${projectRoot}`,
        workspaceRoot,
        name: 'idempotent-feature',
        baseBranch: 'main',
        idempotencyKey: 'same-key'
      })
      expect(first.ok, JSON.stringify(first)).toBe(true)
      const second = await session.rpc('worktree.createManaged', {
        repo: `path:${projectRoot}`,
        workspaceRoot,
        name: 'idempotent-feature',
        baseBranch: 'main',
        idempotencyKey: 'same-key'
      })
      expect(second.ok, JSON.stringify(second)).toBe(true)
      if (first.ok && second.ok) {
        expect(readString(second.result, 'worktree')).toBe(readString(first.result, 'worktree'))
      }
      saveEvidence('m39-2-idempotent.json', { first, second })
    } finally {
      session.ws.close()
    }
  }, 60000)

  it('M39-3 目标根在票据工作区之外被拒，且磁盘上没有建出目录', async () => {
    const session = await connect()
    try {
      const outside = join(otherRepoPath, 'escape-target')
      const response = await session.rpc('worktree.createManaged', {
        repo: `path:${projectRoot}`,
        workspaceRoot: outside,
        name: 'escape',
        baseBranch: 'main'
      })
      expect(response.ok).toBe(false)
      if (!response.ok) {
        expect(response.code).toBe('forbidden')
        expect(response.message).toContain('workspace root')
      }
      expect(existsSync(join(outside, 'escape'))).toBe(false)

      saveEvidence('m39-3-root-outside.json', { response })
    } finally {
      session.ws.close()
    }
  }, 60000)

  it('M39-4 用别的团队仓库创建被拒：不能把他人代码 checkout 进自己的根', async () => {
    const session = await connect()
    try {
      const response = await session.rpc('worktree.createManaged', {
        repo: `path:${otherRepoPath}`,
        workspaceRoot,
        name: 'borrowed',
        baseBranch: 'main'
      })
      expect(response.ok).toBe(false)
      if (!response.ok) {
        expect(response.code).toBe('forbidden')
        expect(response.message).toContain('outside the project')
      }
      expect(existsSync(join(workspaceRoot, 'borrowed'))).toBe(false)

      saveEvidence('m39-4-foreign-repo.json', { response })
    } finally {
      session.ws.close()
    }
  }, 60000)
})
