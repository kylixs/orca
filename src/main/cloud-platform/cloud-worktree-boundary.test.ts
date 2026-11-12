import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
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
 * Design §8.3 / T301a: `worktree.create` derives its path from the host's own
 * workspace settings and takes no target, so a cloud session must not use it —
 * nor may it remove a worktree outside its own workspace. Until
 * `worktree.createManaged` exists, creation is refused rather than left open.
 *
 * Real platform, real tickets, real runtime, real git repositories on disk.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm38-worktree-boundary')
const PROJECT_KEY = 'worktree-boundary-project'

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
let otherWorktreePath = ''

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-worktree-')))
  projectRoot = join(base, 'payment-service')
  workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
  otherRepoPath = join(base, 'other-team')
  otherWorktreePath = join(otherRepoPath, '.orca-worktrees', 'lisi')
  initRepo(projectRoot)
  initRepo(otherRepoPath)
  git(projectRoot, 'worktree', 'add', '-q', '-b', 'zhangsan', workspaceRoot)
  git(otherRepoPath, 'worktree', 'add', '-q', '-b', 'lisi', otherWorktreePath)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-worktree-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  // Why: the store path is a machine-wide working directory, not the project root —
  // that is exactly what cloud sessions must not be able to create into.
  const storeWorkspaces = join(base, 'host-workspaces')
  mkdirSync(storeWorkspaces, { recursive: true })
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
  store.updateSettings({ workspaceDir: storeWorkspaces })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'wt-admin' })
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
    userDataPrefix: 'orca-cloud-worktree-',
    service
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
    deviceName: `wt-${Math.random().toString(16).slice(2, 8)}`
  })
  const connection = await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, session)
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got close ${connection.close.code}`)
  }
  return connection
}

describe('云会话 worktree 边界（真实平台 + 真实 Runtime + 真实仓库）', () => {
  it('M38-1 worktree.create 被拒：不会在主机工作目录下建出 checkout', async () => {
    const session = await connect()
    try {
      const create = await session.rpc('worktree.create', {
        repo: `path:${projectRoot}`,
        name: 'cloud-created',
        baseBranch: 'main'
      })
      expect(create.ok).toBe(false)
      if (!create.ok) {
        expect(create.code).toBe('forbidden')
        expect(create.message).toContain('managed creation')
      }
      // Nothing was created in the host's workspace directory, where plain
      // creation would have put it.
      const hostWorkspaces = join(projectRoot, '..', 'host-workspaces')
      expect(readdirSync(hostWorkspaces)).toEqual([])

      saveEvidence('m38-1-create-refused.json', { create })
    } finally {
      session.ws.close()
    }
  }, 40000)

  it('M38-2 worktree.rm 不能删别人的 worktree，也不能删共享主仓库', async () => {
    const session = await connect()
    try {
      const other = await session.rpc('worktree.rm', { worktree: `path:${otherWorktreePath}` })
      expect(other.ok).toBe(false)
      if (!other.ok) {
        expect(other.code).toBe('forbidden')
      }
      expect(existsSync(otherWorktreePath)).toBe(true)

      const main = await session.rpc('worktree.rm', { worktree: `path:${projectRoot}` })
      expect(main.ok).toBe(false)
      if (!main.ok) {
        expect(main.code).toBe('forbidden')
        expect(main.message).toContain('workspace root')
      }
      expect(existsSync(join(projectRoot, 'README.md'))).toBe(true)

      saveEvidence('m38-2-remove-boundary.json', { other, main })
    } finally {
      session.ws.close()
    }
  }, 40000)

  it('M38-3 worktree.show 在本人工作区可用，跨项目被拒', async () => {
    const session = await connect()
    try {
      const own = await session.rpc('worktree.show', { worktree: `path:${workspaceRoot}` })
      expect(own.ok, JSON.stringify(own)).toBe(true)

      const other = await session.rpc('worktree.show', { worktree: `path:${otherWorktreePath}` })
      expect(other.ok).toBe(false)
      if (!other.ok) {
        expect(other.code).toBe('forbidden')
        expect(other.message).toContain('outside the project')
      }

      saveEvidence('m38-3-show-scope.json', { own, other })
    } finally {
      session.ws.close()
    }
  }, 40000)

  it('M38-4 无目标 worktree 的批量方法对云会话一律拒绝（不能枚举全机工作区）', async () => {
    const session = await connect()
    try {
      const results: Record<string, unknown> = {}
      for (const method of ['worktree.list', 'worktree.detectedList', 'worktree.ps']) {
        const reply = await session.rpc(method, {})
        results[method] = reply
        expect(reply.ok, `${method} must not be reachable from a cloud session`).toBe(false)
        if (!reply.ok) {
          expect(reply.code).toBe('forbidden')
        }
      }
      saveEvidence('m38-4-fleet-methods.json', results)
    } finally {
      session.ws.close()
    }
  }, 40000)
})
