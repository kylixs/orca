import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CLOUD_PLATFORM_IPC } from '../../shared/cloud-platform-ipc'
import { readField, readString } from '../../shared/json-fields'
import { readEnvironmentStore } from '../../shared/runtime-environment-store-file'
import { cloudWorkspacePathOf } from '../../shared/runtime-environments'
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
 * M52: the custom renderer shell is gone, so the desktop must reach a cloud
 * project through the native entry instead. This drives the real
 * `cloud:openWorkspace` handler — real platform process, enrolled host, real TLS
 * runtime, real CloudConnectClient — and then calls the registered environment
 * exactly as terminal and file panes do.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm52-cloud-native-entry')
const PROJECT_KEY = 'native-entry-project'
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
  writeFileSync(join(path, 'README.md'), '# native entry\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let session: CloudSessionService
let handlers: ReturnType<typeof registerCloudPlatformHandlers>
let projectRoot = ''
let projectId = ''
const registrationUserData = mkdtempSync(join(tmpdir(), 'orca-m52-entry-user-'))

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m52-entry-')))
  projectRoot = join(base, 'native-entry-service')
  initRepo(projectRoot)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m52-entry-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-project',
    path: projectRoot,
    displayName: 'native-entry-service',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm52-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-m52',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m52-entry-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m52-entry-',
    service,
    tls: makeSelfSignedTls('dev-m52'),
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
      permissions: PERMISSIONS
    })
  })
  expect(granted.status, await granted.clone().text()).toBe(200)

  session = new CloudSessionService({
    apiUrl: platform.url,
    tlsRejectUnauthorized: false
  })
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

function openWorkspaceHandler(): IpcHandler {
  const handler = ipcHandlers.get(CLOUD_PLATFORM_IPC.openWorkspace)
  if (!handler) {
    throw new Error('cloud:openWorkspace handler not registered')
  }
  return handler
}

describe('云端原生入口（真实平台 + 真实 TLS Runtime + 真实 worktree）', () => {
  it('cloud:openWorkspace 注册运行时环境，环境能用真实 status.get 应答', async () => {
    const result = await openWorkspaceHandler()(null, projectId)
    expect(readField(result, 'ok')).toBe(true)

    const environmentId = readString(result, 'environmentId')
    const workspacePath = readString(result, 'workspacePath')
    if (environmentId === null || workspacePath === null) {
      throw new Error(`openWorkspace reply missing paths: ${JSON.stringify(result)}`)
    }
    // The path is the checkout the host created, verified by git rather than echoed.
    expect(realpathSync(workspacePath)).toBe(
      realpathSync(git(workspacePath, 'rev-parse', '--show-toplevel').trim())
    )

    const environment = readEnvironmentStore(registrationUserData).environments.find(
      (entry) => entry.id === environmentId
    )
    if (!environment) {
      throw new Error(`environment ${environmentId} is not stored`)
    }
    expect(environment.cloudProject?.projectId).toBe(projectId)
    expect(cloudWorkspacePathOf(environment)).toBe(workspacePath)

    // The same call terminal and file panes make, through the registered env id.
    const status = await callRuntimeEnvironment(
      registrationUserData,
      environmentId,
      'status.get',
      {}
    )
    expect(status.ok, JSON.stringify(status)).toBe(true)
    if (status.ok) {
      expect(typeof status.result).toBe('object')
    }

    saveEvidence('m52-1-native-entry.json', {
      channel: CLOUD_PLATFORM_IPC.openWorkspace,
      environmentId,
      workspacePath,
      projectId,
      cloudProject: environment.cloudProject,
      statusGet: status
    })
  }, 120000)
})
