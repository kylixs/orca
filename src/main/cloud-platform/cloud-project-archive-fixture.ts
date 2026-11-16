import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import type {
  CloudArchiveProjectResult,
  CloudCreateProjectInput,
  CloudCreateProjectResult,
  CloudOpenResult,
  CloudProjectRegistration,
  CloudRetryPrepareResult
} from '../../shared/cloud-platform-ipc'
import { CLOUD_PLATFORM_IPC } from '../../shared/cloud-platform-ipc'
import { readArrayValue, readField, readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import { PROJECT_PROVISION_METHODS } from '../runtime/rpc/methods/project-provision'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { registerCloudPlatformHandlers } from '../ipc/cloud-platform'
import { CloudSessionService } from './cloud-session-service'
import { createCloudProvisionAssignmentExecutor } from './cloud-provision-assignment'
import { setActiveCloudSession } from './cloud-runtime-session'
import {
  REPO_ROOT,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import { parseCloudProjectRegistration } from './cloud-provision-recovery-fixture'

/** Real platform + self-service host + TLS runtime for the M65 archive suite. */

export const ARCHIVE_EVIDENCE_DIR = join(
  REPO_ROOT,
  'cloud-platform',
  'evidence',
  'm65-project-archive'
)

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

export type ArchiveHarness = {
  base: string
  projectsRoot: string
  platformUrl: string
  hostId: string
  endpoint: string
  serverPublicKeyB64: string
  session: CloudSessionService
  registrationUserData: string
  repoUrl: string
  createProject: (input: CloudCreateProjectInput) => Promise<CloudCreateProjectResult>
  openWorkspace: (projectId: string) => Promise<CloudOpenResult>
  archiveProject: (projectId: string) => Promise<CloudArchiveProjectResult>
  retryPrepare: (projectId: string) => Promise<CloudRetryPrepareResult>
  /** Beats until the kick clone reports the project ready (U37/U44). */
  beatUntilReady: (projectId: string) => Promise<void>
  registerProjects: () => Promise<CloudProjectRegistration>
  adminListProjects: () => Promise<{ id: string; key: string; status: string }[]>
  adminGetProject: (id: string) => Promise<{ status: number; body: unknown }>
  saveEvidence: (file: string, content: unknown) => void
  stop: () => Promise<void>
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeBareRepo(base: string): string {
  const work = join(base, 'source-work')
  mkdirSync(work, { recursive: true })
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'config', 'user.email', 'e2e@example.com')
  git(work, 'config', 'user.name', 'e2e')
  writeFileSync(join(work, 'README.md'), '# m65 archive\n')
  git(work, 'add', '.')
  git(work, 'commit', '-qm', 'init')
  const bare = join(base, 'm65-archive.git')
  git(base, 'init', '-q', '--bare', bare)
  git(work, 'remote', 'add', 'origin', bare)
  git(work, 'push', '-q', 'origin', 'main')
  return bare
}

function requireHandler<T>(
  handlers: ReadonlyMap<string, IpcHandler>,
  channel: string
): (event: unknown, ...args: unknown[]) => Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`${channel} handler not registered`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each call site names the result type the registered handler returns.
  return handler as (event: unknown, ...args: unknown[]) => Promise<T>
}

async function loginToken(platform: Platform, username: string, password: string): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'm65-archive' })
  })
  const token = readString(await res.json(), 'accessToken')
  if (!token) {
    throw new Error(`login ${username} failed`)
  }
  return token
}

export async function startArchiveHarness(
  ipcHandlers: ReadonlyMap<string, IpcHandler>
): Promise<ArchiveHarness> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m65-archive-')))
  const projectsRoot = join(base, 'projects')
  const registrationUserData = mkdtempSync(join(tmpdir(), 'orca-m65-archive-user-'))
  const repoUrl = makeBareRepo(base)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m65-archive-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  const platform: Platform = await startPlatform()
  const adminToken = await loginToken(platform, 'admin', 'Adm1n!')
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
      ORCA_CLOUD_HOST_NAME: 'dev-m65-archive',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1',
      ORCA_CLOUD_PROJECTS_ROOT: projectsRoot
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m65-archive-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  const admission: CloudRuntimeAdmission = started
  await admission.ready

  const cloud: CloudRuntime = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m65-archive-',
    service,
    tls: makeSelfSignedTls('dev-m65-archive'),
    // Pre-W13a host table, on purpose: this suite predates workspace.info and never calls it.
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS, ...PROJECT_PROVISION_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  cloud.runtime.setCloudProvisionReporter((report) => admission.client!.reportProvisioned(report))
  // U37/U44: the heartbeat assignment clones the repo before any ticket exists.
  admission.client!.onProvisionAssignment(
    createCloudProvisionAssignmentExecutor({
      provision: cloud.runtime.provisionCloudProject.bind(cloud.runtime),
      report: (report) => admission.client!.reportProvisioned(report),
      inMaintenance: () => admission.client!.snapshot().maintenance !== null
    })
  )
  await admission.client!.refresh()

  const adminFetch = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${platform.url}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken}`,
        ...init.headers
      }
    })

  // Why: hide the seeded payment project so the developer sees only this suite's rows.
  const unseeded = await adminFetch('/v1/projects/proj_payment/grants', {
    method: 'PUT',
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
  })
  expect(unseeded.status).toBe(200)

  const host = admission.host()
  if (!host) {
    throw new Error('host not enrolled')
  }
  // U62 C10: self-service creation needs the host provision bit (U61 shape).
  const provisionGrant = await adminFetch(`/v1/hosts/${host.hostId}/grants`, {
    method: 'PUT',
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'developers',
      permissions: ['provision']
    })
  })
  if (!provisionGrant.ok) {
    throw new Error(`host provision grant failed: ${provisionGrant.status}`)
  }

  const session = new CloudSessionService({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await session.login('zhangsan', 'Passw0rd!')
  setActiveCloudSession(session)
  const handlers = registerCloudPlatformHandlers(session, {
    broadcast: () => undefined,
    userDataPath: registrationUserData
  })

  return {
    base,
    projectsRoot,
    platformUrl: platform.url,
    hostId: host.hostId,
    endpoint: cloud.endpoint,
    serverPublicKeyB64: cloud.serverPublicKeyB64,
    session,
    registrationUserData,
    repoUrl,
    createProject: async (input) =>
      requireHandler<CloudCreateProjectResult>(ipcHandlers, CLOUD_PLATFORM_IPC.createProject)(
        null,
        input
      ),
    openWorkspace: async (projectId) =>
      requireHandler<CloudOpenResult>(ipcHandlers, CLOUD_PLATFORM_IPC.openWorkspace)(
        null,
        projectId
      ),
    archiveProject: async (projectId) =>
      requireHandler<CloudArchiveProjectResult>(ipcHandlers, CLOUD_PLATFORM_IPC.archiveProject)(
        null,
        projectId
      ),
    retryPrepare: async (projectId) =>
      requireHandler<CloudRetryPrepareResult>(ipcHandlers, CLOUD_PLATFORM_IPC.retryPrepare)(
        null,
        projectId
      ),
    beatUntilReady: async (projectId) => {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        await admission.client!.refresh()
        await new Promise((resolve) => setTimeout(resolve, 50))
        await admission.client!.refresh()
        const detail = await adminFetch(`/v1/projects/${projectId}`)
        const status = readString(await detail.json(), 'status')
        if (status === 'ready') {
          return
        }
      }
      throw new Error(`project ${projectId} never became ready`)
    },
    registerProjects: async () =>
      parseCloudProjectRegistration(
        await requireHandler(ipcHandlers, CLOUD_PLATFORM_IPC.registerProjects)(null)
      ),
    adminListProjects: async () => {
      const res = await adminFetch('/v1/projects?includeArchived=1')
      const rows = readArrayValue(readField(await res.json(), 'projects')) ?? []
      return rows.flatMap((row) => {
        const id = readString(row, 'id')
        const key = readString(row, 'key')
        const status = readString(row, 'status')
        return id && key && status ? [{ id, key, status }] : []
      })
    },
    adminGetProject: async (id) => {
      const res = await adminFetch(`/v1/projects/${id}`)
      return { status: res.status, body: await res.json() }
    },
    saveEvidence: (file, content) => {
      mkdirSync(ARCHIVE_EVIDENCE_DIR, { recursive: true })
      writeFileSync(join(ARCHIVE_EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
    },
    stop: async () => {
      handlers.dispose()
      setActiveCloudSession(null)
      admission.client?.stop()
      await cloud.runtime.stop()
      await platform.stop()
      await closeTestStores()
    }
  }
}
