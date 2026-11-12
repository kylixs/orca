import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
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
 * Design §8.3 / AC-11 / AC-27 on the real stack: the ticket's projectRoot and
 * workspaceRoot bound what a cloud session can reach, even though the client
 * chooses both the worktree selector and the relative path.
 *
 * The host's store really holds two repositories (the granted project and
 * another team's), and the paths are real directories, so a pass means the file
 * command actually ran and a refusal means the gate stopped it.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm36-workspace-boundary')
const PROJECT_KEY = 'boundary-project'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: path })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: path })
  writeFileSync(join(path, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: path })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: path })
}

let platform: Platform
let cloud: CloudRuntime
let client: ReturnType<typeof createCloudAgentClient>
let registry: DeviceRegistry | null = null
let service: OrcaRuntimeService
let base = ''
let projectRoot = ''
let workspaceRoot = ''
let otherRepoPath = ''

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-boundary-')))
  projectRoot = join(base, 'payment-service')
  workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
  otherRepoPath = join(base, 'other-team')
  initRepo(projectRoot)
  initRepo(otherRepoPath)
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  writeFileSync(join(projectRoot, 'src', 'app.ts'), 'export const app = 1\n')
  // The user's managed worktree really exists as a git worktree of the project,
  // which is the shape the platform's workspaceRoot names (design §8.3).
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'zhangsan', workspaceRoot], {
    cwd: projectRoot
  })
  writeFileSync(join(workspaceRoot, 'feature.ts'), 'export const feature = 2\n')
  // A link inside the project that points at the other team's checkout.
  symlinkSync(otherRepoPath, join(projectRoot, 'escape'))

  // Why: the store resolves userData through AppEnvironment, which is otherwise
  // unset in a test that never boots the app.
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-boundary-data-'))
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
  service = new OrcaRuntimeService(store)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'boundary-admin' })
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
      permissions: ['open', 'file:read', 'file:write']
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
    userDataPrefix: 'orca-cloud-boundary-',
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
    deviceName: `boundary-${Math.random().toString(16).slice(2, 8)}`
  })
  const connection = await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, session)
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got close ${connection.close.code}`)
  }
  return connection
}

describe('云会话工作区边界（真实平台 + 真实 Runtime + 真实仓库）', () => {
  it('M36-1 项目内读取放行、项目外拒绝；跨工作区读取被拒', async () => {
    const session = await connect()
    try {
      const inside = await session.rpc('files.read', {
        worktree: `path:${projectRoot}`,
        relativePath: 'src/app.ts'
      })
      // The gate let it through; the handler returned the file.
      expect(inside.ok, JSON.stringify(inside)).toBe(true)
      if (inside.ok) {
        expect(readString(inside.result, 'content')).toContain('export const app = 1')
      }

      const otherTeam = await session.rpc('files.read', {
        worktree: `path:${otherRepoPath}`,
        relativePath: 'README.md'
      })
      expect(otherTeam.ok).toBe(false)
      if (!otherTeam.ok) {
        expect(otherTeam.code).toBe('forbidden')
        expect(otherTeam.message).toContain('outside the project')
      }

      const traversal = await session.rpc('files.read', {
        worktree: `path:${projectRoot}`,
        relativePath: '../../other-team/README.md'
      })
      expect(traversal.ok).toBe(false)
      if (!traversal.ok) {
        expect(traversal.code).toBe('forbidden')
      }

      const symlinkEscape = await session.rpc('files.read', {
        worktree: `path:${projectRoot}`,
        relativePath: 'escape/README.md'
      })
      expect(symlinkEscape.ok).toBe(false)
      if (!symlinkEscape.ok) {
        expect(symlinkEscape.code).toBe('forbidden')
      }

      saveEvidence('m36-1-read-scope.json', { inside, otherTeam, traversal, symlinkEscape })
    } finally {
      session.ws.close()
    }
  }, 40000)

  it('M36-2 写只允许本人工作区根：工作区内成功，项目其它位置拒绝', async () => {
    const session = await connect()
    try {
      // `expectedExecutionHostId` is what a current client echoes so the host can
      // refuse a write aimed at a different machine; 'local' is this host.
      const inWorkspace = await session.rpc('files.write', {
        worktree: `path:${workspaceRoot}`,
        relativePath: 'new-file.ts',
        content: 'export const created = 3\n',
        expectedExecutionHostId: 'local'
      })
      expect(inWorkspace.ok, JSON.stringify(inWorkspace)).toBe(true)

      const inProject = await session.rpc('files.write', {
        worktree: `path:${projectRoot}`,
        relativePath: 'src/app.ts',
        content: 'export const app = 99\n',
        expectedExecutionHostId: 'local'
      })
      expect(inProject.ok).toBe(false)
      if (!inProject.ok) {
        expect(inProject.code).toBe('forbidden')
        expect(inProject.message).toContain('workspace root')
      }

      // The shared checkout is unchanged: the refusal was not a silent write.
      const reread = await session.rpc('files.read', {
        worktree: `path:${projectRoot}`,
        relativePath: 'src/app.ts'
      })
      if (!reread.ok) {
        throw new Error(`re-read failed: ${reread.code}`)
      }
      expect(readString(reread.result, 'content')).toContain('export const app = 1')

      saveEvidence('m36-2-write-scope.json', { inWorkspace, inProject })
    } finally {
      session.ws.close()
    }
  }, 40000)

  it('M36-3 绝对路径与未知选择器都被边界拒绝，不会落到文件命令', async () => {
    const session = await connect()
    try {
      const absolute = await session.rpc('files.read', {
        worktree: `path:${projectRoot}`,
        relativePath: '/etc/passwd'
      })
      expect(absolute.ok).toBe(false)
      if (!absolute.ok) {
        expect(absolute.message).toContain('absolute')
      }

      const unknown = await session.rpc('files.read', {
        worktree: 'id:not-a-worktree',
        relativePath: 'README.md'
      })
      expect(unknown.ok).toBe(false)
      if (!unknown.ok) {
        expect(unknown.code).toBe('forbidden')
        expect(unknown.message).toContain('not available to the cloud session')
      }

      saveEvidence('m36-3-invalid-selectors.json', { absolute, unknown })
    } finally {
      session.ws.close()
    }
  }, 40000)
})
