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
 * Design §8.3 step 3, end to end with the real desktop client: opening a project
 * connects through the ticket, lists the project's worktrees, reuses the user's
 * checkout when it exists, and otherwise creates it with `worktree.createManaged`.
 *
 * The host is enrolled (heartbeat reports its real port and E2EE key), so the
 * client reaches it the way production does — by the addresses in the ticket.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm40-ensure-workspace')
const PROJECT_KEY = 'ensure-project'

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
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let projectRoot = ''
let workspaceRoot = ''
let otherRepoPath = ''
let projectId = ''

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-ensure-')))
  projectRoot = join(base, 'payment-service')
  workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
  otherRepoPath = join(base, 'other-team')
  initRepo(projectRoot)
  initRepo(otherRepoPath)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-ensure-data-'))
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
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'ensure-admin' })
  })
  const adminToken = readString(await admin.json(), 'accessToken')
  if (adminToken === null) {
    throw new Error('admin login failed')
  }
  const tokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await tokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }

  const started = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-ensure',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-ensure-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-cloud-ensure-',
    service,
    tls: makeSelfSignedTls('dev-ensure'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  // Report the bound port and E2EE key before any ticket is minted.
  await admission.client!.refresh()

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId: admission.host()!.hostId,
      path: projectRoot
    })
  })
  expect(create.status, await create.clone().text()).toBe(201)
  projectId = readString(await create.json(), 'id') ?? ''
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
})

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

/** A fresh desktop client per case: tickets and device keys are per-client. */
async function desktopClient(): Promise<CloudConnectClient> {
  const desktop = new CloudConnectClient({
    apiUrl: platform.url,
    tlsRejectUnauthorized: false
  })
  await desktop.login('zhangsan', 'Passw0rd!')
  return desktop
}

describe('打开项目时按需创建托管工作区（真实平台 + 真实 Runtime + 真实仓库）', () => {
  it('M40-1 首次打开：经票据地址连上并创建工作区，路径在票据工作区根下且是真 worktree', async () => {
    const desktop = await desktopClient()
    const ensured = await ensureCloudWorkspace(desktop, projectId)
    expect(ensured, JSON.stringify(ensured)).toMatchObject({ ok: true, created: true })
    if (!ensured.ok) {
      throw new Error(ensured.code)
    }
    expect(ensured.workspacePath).toBe(join(workspaceRoot, 'main'))
    expect(existsSync(join(ensured.workspacePath, 'README.md'))).toBe(true)
    expect(git(ensured.workspacePath, 'rev-parse', '--show-toplevel').trim()).toBe(
      realpathSync(ensured.workspacePath)
    )

    saveEvidence('m40-1-first-open.json', ensured)
    desktop.close()
  }, 60000)

  it('M40-2 再次打开：复用已有工作区，不再创建第二份', async () => {
    const desktop = await desktopClient()
    const ensured = await ensureCloudWorkspace(desktop, projectId)
    expect(ensured, JSON.stringify(ensured)).toMatchObject({ ok: true, created: false })
    if (!ensured.ok) {
      throw new Error(ensured.code)
    }
    expect(ensured.workspacePath).toBe(join(workspaceRoot, 'main'))
    // Exactly one worktree entry for this user in the project.
    const worktrees = git(projectRoot, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
    expect(worktrees.length).toBe(2) // the main checkout + this user's

    saveEvidence('m40-2-reopen.json', { ensured, worktreeCount: worktrees.length })
    desktop.close()
  }, 60000)

  it('M40-3 目录读取按仓库限定：另一个团队的仓库被拒，不带仓库也拒绝', async () => {
    const desktop = await desktopClient()
    await desktop.openProject(projectId)
    const foreign = await desktop.rpc('worktree.list', { repo: `path:${otherRepoPath}` })
    expect(foreign.ok).toBe(false)
    if (!foreign.ok) {
      expect(foreign.code).toBe('forbidden')
      expect(foreign.message).toContain('outside the project')
    }
    // Without a repo the call would be a fleet-wide listing, so it is refused too.
    const fleet = await desktop.rpc('worktree.list', {})
    expect(fleet.ok).toBe(false)

    saveEvidence('m40-3-repo-scoped-list.json', { foreign, fleet })
    desktop.close()
  }, 60000)
})
