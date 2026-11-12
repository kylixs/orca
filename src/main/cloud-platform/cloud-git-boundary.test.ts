import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
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
 * Design §8.3: the main checkout is read-only; a cloud session's git writes belong
 * to its own worktree. The ticket grants git through `terminal`, which says
 * nothing about which checkout the call names — so without this a session could
 * commit or discard inside the shared repo everyone else depends on.
 *
 * Real platform, real Ed25519 tickets, real runtime, real git repositories.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm37-git-boundary')
const PROJECT_KEY = 'git-boundary-project'

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

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-git-')))
  projectRoot = join(base, 'payment-service')
  workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
  otherRepoPath = join(base, 'other-team')
  initRepo(projectRoot)
  initRepo(otherRepoPath)
  git(projectRoot, 'worktree', 'add', '-q', '-b', 'zhangsan', workspaceRoot)
  writeFileSync(join(workspaceRoot, 'feature.ts'), 'export const feature = 2\n')

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-git-data-'))
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
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'git-admin' })
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
      permissions: ['open', 'terminal', 'file:read']
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
    userDataPrefix: 'orca-cloud-git-',
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
    deviceName: `git-${Math.random().toString(16).slice(2, 8)}`
  })
  const connection = await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, session)
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got close ${connection.close.code}`)
  }
  return connection
}

describe('云会话 git 边界（真实平台 + 真实 Runtime + 真实仓库）', () => {
  it('M37-1 读类 git 在项目内放行、对别的仓库拒绝', async () => {
    const session = await connect()
    try {
      const own = await session.rpc('git.status', { worktree: `path:${workspaceRoot}` })
      expect(own.ok, JSON.stringify(own)).toBe(true)

      const other = await session.rpc('git.status', { worktree: `path:${otherRepoPath}` })
      expect(other.ok).toBe(false)
      if (!other.ok) {
        expect(other.code).toBe('forbidden')
        expect(other.message).toContain('outside the project')
      }

      saveEvidence('m37-1-read.json', { own, other })
    } finally {
      session.ws.close()
    }
  }, 40000)

  it('M37-2 写类 git 在共享主仓库被拒，主仓库确实没有新提交', async () => {
    const before = git(projectRoot, 'rev-parse', 'HEAD').trim()
    const session = await connect()
    try {
      const stage = await session.rpc('git.stage', {
        worktree: `path:${projectRoot}`,
        filePath: 'README.md'
      })
      expect(stage.ok).toBe(false)
      if (!stage.ok) {
        expect(stage.code).toBe('forbidden')
        expect(stage.message).toContain('workspace root')
      }

      const commit = await session.rpc('git.commit', {
        worktree: `path:${projectRoot}`,
        message: 'cloud session must not commit here'
      })
      expect(commit.ok).toBe(false)
      if (!commit.ok) {
        expect(commit.code).toBe('forbidden')
      }

      expect(git(projectRoot, 'rev-parse', 'HEAD').trim()).toBe(before)
      saveEvidence('m37-2-main-checkout-readonly.json', { stage, commit, headUnchanged: true })
    } finally {
      session.ws.close()
    }
  }, 40000)

  it('M37-3 写类 git 在本人工作区放行：真实 stage + commit 落到该 worktree', async () => {
    const session = await connect()
    try {
      const stage = await session.rpc('git.stage', {
        worktree: `path:${workspaceRoot}`,
        filePath: 'feature.ts'
      })
      expect(stage.ok, JSON.stringify(stage)).toBe(true)

      const commit = await session.rpc('git.commit', {
        worktree: `path:${workspaceRoot}`,
        message: 'add feature from cloud session'
      })
      expect(commit.ok, JSON.stringify(commit)).toBe(true)

      // The commit is real: read it back with the user's own git binary.
      const subject = git(workspaceRoot, 'log', '-1', '--pretty=%s').trim()
      expect(subject).toBe('add feature from cloud session')
      // And the shared checkout's branch is untouched.
      expect(git(projectRoot, 'log', '-1', '--pretty=%s').trim()).toBe('init')

      saveEvidence('m37-3-workspace-writes.json', { stage, commit, subject })
    } finally {
      session.ws.close()
    }
  }, 40000)

  it('M37-4 git 的文件路径同样受边界约束：越界的 filePath 被拒', async () => {
    const session = await connect()
    try {
      const escape = await session.rpc('git.stage', {
        worktree: `path:${workspaceRoot}`,
        filePath: '../../other-team/README.md'
      })
      expect(escape.ok).toBe(false)
      if (!escape.ok) {
        expect(escape.code).toBe('forbidden')
      }
      // The other team's index is unchanged: the path never reached git.
      expect(git(otherRepoPath, 'status', '--porcelain').trim()).toBe('')

      saveEvidence('m37-4-path-escape.json', { escape })
    } finally {
      session.ws.close()
    }
  }, 40000)
})
