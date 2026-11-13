import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
import { buildCloudProjectLink, type CloudProjectLink } from './cloud-pairing-offer'
import { CloudConnectClient } from './cloud-connect-client'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'
import { registerCloudRuntimeEnvironment } from './cloud-runtime-environment'
import {
  getRuntimeEnvironmentSidecarPath,
  readRuntimeEnvironmentSidecar
} from '../../shared/runtime-environment-sidecar'
import { readEnvironmentStore } from '../../shared/runtime-environment-store-file'
import { cloudWorkspacePathOf } from '../../shared/runtime-environments'

/**
 * M45: the checkout `ensureCloudWorkspace` created is carried on the cloud
 * environment's sidecar entry. Real platform, real TLS runtime, real git
 * worktree — the stored path is checked against git, not against its own echo.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm45-workspace-path-sidecar')
const PROJECT_KEY = 'workspace-path-project'

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
  writeFileSync(join(path, 'README.md'), '# payment service\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

function gitToplevel(path: string): string {
  return realpathSync(git(path, 'rev-parse', '--show-toplevel').trim())
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let desktop: CloudConnectClient
let projectRoot = ''
let projectId = ''
let projectLink: CloudProjectLink
let workspacePath = ''
const registrationUserData = mkdtempSync(join(tmpdir(), 'orca-m45-sidecar-user-'))

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m45-sidecar-')))
  projectRoot = join(base, 'payment-service')
  initRepo(projectRoot)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m45-sidecar-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-project',
    path: projectRoot,
    displayName: 'payment-service',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm45-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-m45',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m45-sidecar-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m45-sidecar-',
    service,
    tls: makeSelfSignedTls('dev-m45'),
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
  projectLink = link
})

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

function register(workspace?: string, now = Date.now()) {
  return registerCloudRuntimeEnvironment(
    registrationUserData,
    {
      projectId,
      projectKey: PROJECT_KEY,
      projectName: PROJECT_KEY,
      hostId: admission.host()!.hostId,
      link: projectLink,
      ...(workspace ? { workspacePath: workspace } : {})
    },
    now
  )
}

function stored(environmentId: string) {
  const environment = readEnvironmentStore(registrationUserData).environments.find(
    (entry) => entry.id === environmentId
  )
  if (!environment) {
    throw new Error(`environment ${environmentId} is not stored`)
  }
  return environment
}

describe('云端环境的 sidecar 携带用户工作区路径（真实平台 + 真实 worktree）', () => {
  it('M45-1 注册写入的路径就是主机创建的 worktree，且与 git 顶层目录一致', () => {
    const environment = register(workspacePath)
    const persisted = cloudWorkspacePathOf(stored(environment.id))
    expect(persisted).toBe(workspacePath)
    // Not an echo: git itself reports the same checkout for the stored path.
    expect(realpathSync(persisted!)).toBe(gitToplevel(workspacePath))
    expect(getRuntimeEnvironmentSidecarPath(registrationUserData)).toContain(
      'orca-environment-sidecar.json'
    )
    const entry = readRuntimeEnvironmentSidecar(registrationUserData).entries[environment.id]
    expect(entry?.cloudProject?.workspacePath).toBe(workspacePath)

    saveEvidence('m45-1-persisted.json', {
      environmentId: environment.id,
      ensuredWorkspacePath: workspacePath,
      sidecarEntry: entry
    })
  }, 60000)

  it('M45-2 再次打开保持环境 id 不变，并用新检出的路径刷新', () => {
    const first = register(workspacePath, 100)
    const secondCheckout = join(realpathSync(tmpdir()), `m45-second-${process.pid}`)
    git(projectRoot, 'worktree', 'add', '-q', '-b', 'sidecar-second', secondCheckout, 'main')
    const second = register(secondCheckout, 200)

    expect(second.id).toBe(first.id)
    expect(cloudWorkspacePathOf(stored(first.id))).toBe(secondCheckout)
    expect(realpathSync(secondCheckout)).toBe(gitToplevel(secondCheckout))

    saveEvidence('m45-2-reopen.json', {
      firstId: first.id,
      secondId: second.id,
      refreshedPath: cloudWorkspacePathOf(stored(first.id)),
      firstWorkspacePath: workspacePath
    })
  }, 60000)

  it('M45-3 没有该字段的 sidecar 仍然解析，读取结果为 null', () => {
    const environment = register(workspacePath, 300)
    const sidecarPath = getRuntimeEnvironmentSidecarPath(registrationUserData)
    const raw = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    expect(raw.entries[environment.id].cloudProject.workspacePath).toBe(workspacePath)
    delete raw.entries[environment.id].cloudProject.workspacePath
    writeFileSync(sidecarPath, JSON.stringify(raw))

    const legacyEntry = readRuntimeEnvironmentSidecar(registrationUserData).entries[environment.id]
    expect(legacyEntry?.cloudProject).not.toHaveProperty('workspacePath')
    expect(cloudWorkspacePathOf(stored(environment.id))).toBeNull()

    saveEvidence('m45-3-legacy-entry.json', {
      environmentId: environment.id,
      legacyCloudProject: legacyEntry?.cloudProject,
      readerResult: cloudWorkspacePathOf(stored(environment.id))
    })
  }, 60000)
})
