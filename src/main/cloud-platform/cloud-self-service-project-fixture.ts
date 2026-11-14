import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { CloudProjectEnvironment } from '../../shared/cloud-platform-ipc'
import { CLOUD_PLATFORM_IPC } from '../../shared/cloud-platform-ipc'
import { readArrayValue, readField, readString, readStringArray } from '../../shared/json-fields'
import type { Repo } from '../../shared/repo-types'
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
import { setActiveCloudSession } from './cloud-runtime-session'
import {
  REPO_ROOT,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import { makeBareRepository } from './cloud-project-provisioning-fixture'

/** Real platform + enrolled host declaring projectsRoot + TLS runtime, for M59. */

export const SELF_SERVICE_EVIDENCE_DIR = join(
  REPO_ROOT,
  'cloud-platform',
  'evidence',
  'm59-self-service-projects'
)

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

export type SelfServiceHarness = {
  store: Store
  session: CloudSessionService
  registrationUserData: string
  base: string
  projectsRoot: string
  hostId: string
  repoUrl: string
  createProject: (input: Record<string, unknown>) => Promise<unknown>
  listProvisionableHosts: () => Promise<unknown[]>
  getProject: (id: string) => Promise<unknown>
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>
  retryPrepare: (id: string) => Promise<unknown>
  listPlatformProjects: () => Promise<unknown[]>
  beat: () => Promise<void>
  saveEvidence: (file: string, content: unknown) => void
  repoOf: (result: unknown) => Repo | null
  stop: () => Promise<void>
}

function requireHandler(handlers: ReadonlyMap<string, IpcHandler>, channel: string): IpcHandler {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`${channel} handler not registered`)
  }
  return handler
}

export function parseEnvironment(raw: unknown): CloudProjectEnvironment | null {
  const projectId = readString(raw, 'projectId')
  const projectName = readString(raw, 'projectName')
  const projectRoot = readString(raw, 'projectRoot')
  const environmentId = readString(raw, 'environmentId')
  return projectId && projectName && projectRoot && environmentId
    ? { projectId, projectName, projectRoot, environmentId }
    : null
}

async function loginToken(platform: Platform, username: string, password: string): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'm59-self-service' })
  })
  const token = readString(await res.json(), 'accessToken')
  if (!token) {
    throw new Error(`login ${username} failed`)
  }
  return token
}

export async function startSelfServiceHarness(
  ipcHandlers: ReadonlyMap<string, IpcHandler>
): Promise<SelfServiceHarness> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m59-self-service-')))
  const projectsRoot = join(base, 'projects')
  mkdirSync(projectsRoot, { recursive: true })
  const registrationUserData = mkdtempSync(join(tmpdir(), 'orca-m59-self-service-user-'))

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m59-self-service-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  const platform = await startPlatform()
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
      ORCA_CLOUD_HOST_NAME: 'dev-m59-self-service',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1',
      ORCA_CLOUD_PROJECTS_ROOT: projectsRoot
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m59-self-service-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  const admission: CloudRuntimeAdmission = started
  await admission.ready

  const cloud: CloudRuntime = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m59-self-service-',
    service,
    tls: makeSelfSignedTls('dev-m59-self-service'),
    // Pre-W13a host table, on purpose: this suite predates workspace.info and never calls it.
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS, ...PROJECT_PROVISION_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  cloud.runtime.setCloudProvisionReporter((report) => admission.client!.reportProvisioned(report))
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

  const session = new CloudSessionService({
    apiUrl: platform.url,
    tlsRejectUnauthorized: false
  })
  await session.login('zhangsan', 'Passw0rd!')
  setActiveCloudSession(session)
  registerCloudPlatformHandlers(session, {
    broadcast: () => undefined,
    userDataPath: registrationUserData
  })

  return {
    store,
    session,
    registrationUserData,
    base,
    projectsRoot,
    hostId: admission.host()!.hostId,
    repoUrl: makeBareRepository(base),
    createProject: (input) =>
      requireHandler(ipcHandlers, CLOUD_PLATFORM_IPC.createProject)(null, input),
    listProvisionableHosts: async () => {
      const raw = await requireHandler(ipcHandlers, CLOUD_PLATFORM_IPC.listProvisionableHosts)(null)
      const hosts: unknown[] = []
      for (const item of readArrayValue(raw) ?? []) {
        hosts.push({
          id: readString(item, 'id'),
          name: readString(item, 'name'),
          online: readField(item, 'online'),
          provisionable: readField(item, 'provisionable'),
          projectDirs: readStringArray(item, 'projectDirs') ?? []
        })
      }
      return hosts
    },
    getProject: async (id) => {
      const res = await adminFetch(`/v1/projects/${id}`)
      expect(res.status).toBe(200)
      return res.json()
    },
    adminFetch,
    retryPrepare: (id) => requireHandler(ipcHandlers, CLOUD_PLATFORM_IPC.retryPrepare)(null, id),
    listPlatformProjects: async () => {
      const res = await adminFetch('/v1/projects')
      expect(res.status).toBe(200)
      return readArrayValue(readField(await res.json(), 'projects')) ?? []
    },
    beat: async () => {
      await admission.client!.refresh()
      await new Promise((resolve) => setTimeout(resolve, 50))
      await admission.client!.refresh()
    },
    saveEvidence: (file, content) => {
      mkdirSync(SELF_SERVICE_EVIDENCE_DIR, { recursive: true })
      writeFileSync(join(SELF_SERVICE_EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
    },
    repoOf: (result) => {
      const repo = readField(result, 'repo')
      const id = readString(repo, 'id')
      const path = readString(repo, 'path')
      const displayName = readString(repo, 'displayName')
      const badgeColor = readString(repo, 'badgeColor')
      return id && path && displayName && badgeColor
        ? { id, path, displayName, badgeColor, addedAt: 0 }
        : null
    },
    stop: async () => {
      setActiveCloudSession(null)
      admission.client?.stop()
      await cloud.runtime.stop()
      await platform.stop()
      await closeTestStores()
    }
  }
}
