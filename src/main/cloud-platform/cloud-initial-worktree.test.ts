import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readArray, readString } from '../../shared/json-fields'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { cloudWorkspacePathOf } from '../../shared/runtime-environments'
import { readEnvironmentStore } from '../../shared/runtime-environment-store-file'
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
import {
  REPO_ROOT,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import { buildCloudProjectLink } from './cloud-pairing-offer'
import { CloudConnectClient } from './cloud-connect-client'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'
import { registerCloudRuntimeEnvironment } from './cloud-runtime-environment'
import { selectCloudInitialWorktreeId } from '../../shared/cloud-initial-worktree'

/**
 * M55: after sign-in the native entry selects the user's own checkout. This
 * drives the real host so both sides are facts, not fixtures: the sidecar path
 * from M45, the rows the host's `worktree.list` reports, and git itself.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm55-initial-worktree')
const PROJECT_KEY = 'initial-worktree-project'
const REPO_ID = 'repo-project'

type ListedWorktree = { id: string; repoId: string; path: string }

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
  writeFileSync(join(path, 'README.md'), '# initial worktree\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

function gitToplevel(path: string): string {
  return realpathSync(git(path, 'rev-parse', '--show-toplevel').trim())
}

function listedWorktrees(result: unknown): ListedWorktree[] {
  const rows = readArray(result, 'worktrees') ?? []
  return rows.flatMap((row) => {
    const id = readString(row, 'id')
    const repoId = readString(row, 'repoId')
    const path = readString(row, 'path')
    return id === null || repoId === null || path === null ? [] : [{ id, repoId, path }]
  })
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let desktop: CloudConnectClient
let projectRoot = ''
let projectId = ''
let workspacePath = ''
let environmentId = ''
let sidecarWorkspacePath: string | null = null
let listed: ListedWorktree[] = []
let selectedId: string | null = null
const registrationUserData = mkdtempSync(join(tmpdir(), 'orca-m55-worktree-user-'))

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m55-worktree-')))
  projectRoot = join(base, 'initial-worktree-service')
  initRepo(projectRoot)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m55-worktree-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: REPO_ID,
    path: projectRoot,
    displayName: 'initial-worktree-service',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm55-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-m55',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m55-worktree-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m55-worktree-',
    service,
    tls: makeSelfSignedTls('dev-m55'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
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
  const granted = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read', 'file:write']
    })
  })
  expect(granted.status, await granted.clone().text()).toBe(200)

  desktop = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await desktop.login('zhangsan', 'Passw0rd!')
  const ensured = await ensureCloudWorkspace(desktop, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
  }
  workspacePath = ensured.workspacePath

  // M45 sidecar: the same path the entry will read back on the next launch.
  const prepared = await desktop.prepareProjectLink(projectId)
  const link = buildCloudProjectLink({
    ticket: prepared.ticket,
    endpoint: prepared.endpoint,
    route: prepared.route,
    tlsRejectUnauthorized: false
  })
  if (!link) {
    throw new Error('cloud link unavailable')
  }
  const environment = registerCloudRuntimeEnvironment(registrationUserData, {
    projectId,
    projectKey: PROJECT_KEY,
    projectName: PROJECT_KEY,
    hostId: admission.host()!.hostId,
    link,
    workspacePath
  })
  environmentId = environment.id
  const stored = readEnvironmentStore(registrationUserData).environments.find(
    (entry) => entry.id === environmentId
  )
  if (!stored) {
    throw new Error(`environment ${environmentId} is not stored`)
  }
  sidecarWorkspacePath = cloudWorkspacePathOf(stored)

  const rpc = await desktop.rpc('worktree.list', { repo: `path:${projectRoot}` }, 20_000)
  if (!rpc.ok) {
    throw new Error(`worktree.list failed: ${rpc.code} ${rpc.message ?? ''}`)
  }
  listed = listedWorktrees(rpc.result)
  const repoId = listed[0]?.repoId
  if (!repoId) {
    throw new Error('host reported no worktrees')
  }
  selectedId = selectCloudInitialWorktreeId({
    workspacePath: sidecarWorkspacePath,
    repo: { id: repoId, path: projectRoot },
    worktrees: listed
  })
})

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

describe('云端入口初始选中（真实平台 + 真实 worktree.list）', () => {
  it('M55-1 选中的 worktree 就是主机创建的用户检查目录', () => {
    expect(sidecarWorkspacePath).toBe(workspacePath)
    expect(selectedId).not.toBeNull()

    const persisted = sidecarWorkspacePath
    const selected = listed.find((worktree) => worktree.id === selectedId)
    if (!persisted || !selected) {
      throw new Error(`selected worktree ${selectedId} is not in worktree.list`)
    }
    expect(selected.repoId).toBe(REPO_ID)
    expect(normalizeRuntimePathForComparison(selected.path)).toBe(
      normalizeRuntimePathForComparison(persisted)
    )
    // Not an echo: git agrees both the opened checkout and the selected row are
    // the same top-level working tree.
    const openedToplevel = gitToplevel(workspacePath)
    const selectedToplevel = gitToplevel(selected.path)
    expect(selectedToplevel).toBe(openedToplevel)
    expect(realpathSync(selected.path)).toBe(openedToplevel)

    saveEvidence('m55-1-initial-worktree.json', {
      environmentId,
      projectId,
      projectRoot,
      sidecarWorkspacePath,
      openedWorkspacePath: workspacePath,
      gitToplevelOfOpened: openedToplevel,
      listedWorktrees: listed,
      selectedWorktreeId: selectedId,
      selectedWorktreePath: selected.path,
      gitToplevelOfSelected: selectedToplevel,
      equalToplevel: selectedToplevel === openedToplevel
    })
  }, 60000)
})
