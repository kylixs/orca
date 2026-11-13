import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CLOUD_PLATFORM_IPC, type CloudProjectEnvironment } from '../../shared/cloud-platform-ipc'
import { readArrayValue, readField, readString } from '../../shared/json-fields'
import { readEnvironmentStore } from '../../shared/runtime-environment-store-file'
import type { Repo } from '../../shared/repo-types'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { registerCloudPlatformHandlers } from '../ipc/cloud-platform'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import {
  planCloudProjectRepos,
  syncCloudProjectRepos,
  type CloudProjectRepoPorts
} from '../../renderer/src/cloud/cloud-project-repos'
import { CloudSessionService } from './cloud-session-service'
import { setActiveCloudSession } from './cloud-runtime-session'
import {
  REPO_ROOT,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'

/**
 * M52: cloud projects become native sidebar repos. This drives the same plan the
 * renderer runs, the real `cloud:registerProjects` handler, the real main-side
 * runtime call (`repo.add` through the registered environment) and the real host
 * store — real platform process, enrolled host, TLS runtime, real git repos.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm52-cloud-repo-registration')
const PERMISSIONS = ['open', 'terminal', 'agent', 'file:read', 'file:write']

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

const ipcHandlers = vi.hoisted(() => new Map<string, IpcHandler>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

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
  writeFileSync(join(path, 'README.md'), `# ${path.split('/').at(-1)}\n`)
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

function repoOf(result: unknown): Repo | null {
  const repo = readField(result, 'repo')
  const id = readString(repo, 'id')
  const path = readString(repo, 'path')
  const displayName = readString(repo, 'displayName')
  const badgeColor = readString(repo, 'badgeColor')
  if (id === null || path === null || displayName === null || badgeColor === null) {
    return null
  }
  return { id, path, displayName, badgeColor, addedAt: 0 }
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let session: CloudSessionService
let service: OrcaRuntimeService
let store: Store
let handlers: ReturnType<typeof registerCloudPlatformHandlers>
let base = ''
let projectRoots: string[] = []
let projectIds: string[] = []
let adminToken = ''
const registrationUserData = mkdtempSync(join(tmpdir(), 'orca-m52-repo-user-'))

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m52-repo-')))
  projectRoots = [join(base, 'checkout-service'), join(base, 'payments-service')]
  projectRoots.forEach(initRepo)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m52-repo-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  // Why seed only the first: `repo.add` must reuse it and create the second one.
  store.addRepo({
    id: 'repo-checkout',
    path: projectRoots[0],
    displayName: 'checkout-host-name',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  service = new OrcaRuntimeService(store)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm52-admin' })
  })
  adminToken = readString(await admin.json(), 'accessToken') ?? ''
  if (!adminToken) {
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
      ORCA_CLOUD_HOST_NAME: 'dev-m52-repos',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m52-repo-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m52-repo-',
    service,
    tls: makeSelfSignedTls('dev-m52-repos'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  for (const [index, projectRoot] of projectRoots.entries()) {
    const create = await fetch(`${platform.url}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        key: `repo-project-${index + 1}`,
        name: index === 0 ? 'Checkout Service' : 'Payments Service',
        hostId: admission.host()!.hostId,
        path: projectRoot
      })
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const projectId = readString(await create.json(), 'id') ?? ''
    projectIds.push(projectId)
    const granted = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        subjectType: 'group',
        subjectId: 'team-payment',
        permissions: PERMISSIONS
      })
    })
    expect(granted.status, await granted.clone().text()).toBe(200)
  }

  session = new CloudSessionService({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await session.login('zhangsan', 'Passw0rd!')
  setActiveCloudSession(session)
  handlers = registerCloudPlatformHandlers(session, {
    broadcast: () => undefined,
    userDataPath: registrationUserData
  })
})

afterAll(async () => {
  handlers?.dispose()
  setActiveCloudSession(null)
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

function handlerFor(channel: string): IpcHandler {
  const handler = ipcHandlers.get(channel)
  if (!handler) {
    throw new Error(`${channel} handler not registered`)
  }
  return handler
}

let registered: CloudProjectEnvironment[] | null = null

/** One sign-in's registration is the real flow; later tests reuse it. */
async function registerEnvironments(): Promise<CloudProjectEnvironment[]> {
  if (registered) {
    return registered
  }
  const raw = await handlerFor(CLOUD_PLATFORM_IPC.registerProjects)(null)
  const entries: CloudProjectEnvironment[] = []
  for (const item of readArrayValue(raw) ?? []) {
    const projectId = readString(item, 'projectId')
    const projectName = readString(item, 'projectName')
    const projectRoot = readString(item, 'projectRoot')
    const environmentId = readString(item, 'environmentId')
    if (projectId && projectName && projectRoot && environmentId) {
      entries.push({ projectId, projectName, projectRoot, environmentId })
    }
  }
  registered = entries
  return entries
}

function repoAddPort(targets: string[]): CloudProjectRepoPorts['addRepo'] {
  return async (target) => {
    targets.push(target.projectId)
    const response = await callRuntimeEnvironment(
      registrationUserData,
      target.environmentId,
      'repo.add',
      { path: target.path, kind: 'git', displayName: target.displayName }
    )
    if (response.ok !== true) {
      throw new Error(`repo.add refused: ${JSON.stringify(response)}`)
    }
    return repoOf(response.result)
  }
}

describe('云项目注册为原生 repo（真实平台 + 真实 TLS Runtime + 真实 git）', () => {
  it('M52-1 登录后每个项目一个环境，repo 行带 runtime:<envId> 与项目根路径', async () => {
    const environments = await registerEnvironments()
    expect(environments).toHaveLength(2)
    expect(environments.map((entry) => entry.projectId).sort()).toEqual([...projectIds].sort())
    expect(environments.map((entry) => entry.projectRoot).sort()).toEqual([...projectRoots].sort())

    const stored = readEnvironmentStore(registrationUserData).environments
    for (const environment of environments) {
      const entry = stored.find((candidate) => candidate.id === environment.environmentId)
      expect(entry?.cloudProject?.projectId).toBe(environment.projectId)
    }

    const addCalls: string[] = []
    const renamed: string[] = []
    const ports: Pick<CloudProjectRepoPorts, 'addRepo' | 'renameRepo'> = {
      addRepo: repoAddPort(addCalls),
      renameRepo: ({ displayName }) => renamed.push(displayName)
    }
    const first = await syncCloudProjectRepos({ environments, repos: [], ports })
    expect(first.failed).toEqual([])
    expect(first.added).toHaveLength(2)
    const expectedName = (projectId: string): string =>
      projectId === projectIds[0] ? 'Checkout Service' : 'Payments Service'
    for (const [index, row] of first.added.entries()) {
      const environment = environments[index]
      expect(row.path).toBe(environment.projectRoot)
      expect(row.executionHostId).toBe(`runtime:${environment.environmentId}`)
      expect(row.displayName).toBe(expectedName(environment.projectId))
    }
    // The seeded host row keeps its own name on the host but the sidebar shows the project name.
    expect(renamed).toEqual(['Checkout Service'])

    // The host really holds one row per project, at the paths git reports.
    const hostRepos = store.getRepos()
    expect(hostRepos).toHaveLength(2)
    expect(hostRepos.map((repo) => repo.path).sort()).toEqual([...projectRoots].sort())
    for (const path of projectRoots) {
      expect(realpathSync(git(path, 'rev-parse', '--show-toplevel').trim())).toBe(
        realpathSync(path)
      )
    }

    // Second sign-in: same environment ids, no second row, no extra host calls.
    const second = await syncCloudProjectRepos({
      environments,
      repos: first.added,
      ports: { addRepo: repoAddPort(addCalls), renameRepo: vi.fn() }
    })
    expect(second.added).toEqual([])
    expect(second.renamed).toBe(0)
    expect(addCalls).toHaveLength(2)
    expect(planCloudProjectRepos({ environments, repos: first.added }).add).toEqual([])
    expect(store.getRepos()).toHaveLength(2)

    saveEvidence('m52-1-repo-registration.json', {
      environments,
      rows: first.added,
      addCalls,
      hostRepos: store.getRepos().map((repo) => ({ id: repo.id, path: repo.path })),
      secondSync: { added: second.added.length, renamed: second.renamed }
    })
  }, 180_000)

  it('M52-2 重复注册同一项目仍是一行，直接 repo.add 命中原有 repo id', async () => {
    const environments = await registerEnvironments()
    const target = environments.find((entry) => entry.projectRoot === projectRoots[0])
    if (!target) {
      throw new Error('the seeded project was not registered')
    }
    const before = store.getRepos().length
    const response = await callRuntimeEnvironment(
      registrationUserData,
      target.environmentId,
      'repo.add',
      { path: target.projectRoot, kind: 'git' }
    )
    expect(response.ok, JSON.stringify(response)).toBe(true)
    if (response.ok) {
      expect(repoOf(response.result)?.id).toBe('repo-checkout')
    }
    expect(store.getRepos()).toHaveLength(before)

    saveEvidence('m52-2-idempotent.json', {
      projectRoot: target.projectRoot,
      repoId: response.ok ? repoOf(response.result)?.id : null,
      hostRepoCount: store.getRepos().length
    })
  }, 120_000)

  it('M52-3 已注册环境能应答真实 RPC，越界 repo.add 被路径守卫拒绝', async () => {
    const environments = await registerEnvironments()
    const environment = environments[0]

    const status = await callRuntimeEnvironment(
      registrationUserData,
      environment.environmentId,
      'status.get',
      {}
    )
    expect(status.ok, JSON.stringify(status)).toBe(true)
    if (status.ok) {
      expect(typeof status.result).toBe('object')
    }

    const worktrees = await callRuntimeEnvironment(
      registrationUserData,
      environment.environmentId,
      'worktree.list',
      { repo: `path:${environment.projectRoot}` }
    )
    expect(worktrees.ok, JSON.stringify(worktrees)).toBe(true)

    const outside = await callRuntimeEnvironment(
      registrationUserData,
      environment.environmentId,
      'repo.add',
      { path: join(base, 'not-my-project'), kind: 'git' }
    )
    expect(outside.ok).toBe(false)
    if (!outside.ok) {
      expect(outside.error.code).toBe('forbidden')
      expect(outside.error.message).toContain('only register the project')
    }

    saveEvidence('m52-3-real-rpc.json', {
      environmentId: environment.environmentId,
      status,
      worktrees,
      outsideRepoAdd: outside
    })
  }, 120_000)
})
