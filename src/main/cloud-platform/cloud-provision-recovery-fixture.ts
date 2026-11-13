import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import type {
  CloudProjectEnvironment,
  CloudProjectFailure,
  CloudProjectRegistration
} from '../../shared/cloud-platform-ipc'
import { CLOUD_PLATFORM_IPC } from '../../shared/cloud-platform-ipc'
import { readArrayValue, readField, readString } from '../../shared/json-fields'
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
  type Platform,
  type PlatformOptions
} from './cloud-session-e2e-harness'
import { makeBareRepository } from './cloud-project-provisioning-fixture'

/** Real platform + enrolled host + TLS runtime used by the M58 recovery suite. */

export const RECOVERY_PERMISSIONS = ['open', 'terminal', 'agent', 'file:read', 'file:write']
export const RECOVERY_EVIDENCE_DIR = join(
  REPO_ROOT,
  'cloud-platform',
  'evidence',
  'm58-provision-recovery'
)

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

export type RecoveryHarnessOptions = PlatformOptions & {
  /** Start from a clonable bare repo; the renewal suite needs a ready checkout. */
  provisionRepo?: boolean
  refreshLeadMs?: number
  fetchImpl?: typeof fetch
}

export type RecoveryHarness = {
  store: Store
  session: CloudSessionService
  registrationUserData: string
  base: string
  platformUrl: string
  projectId: string
  projectRoot: string
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>
  getProject: (id: string) => Promise<unknown>
  beat: () => Promise<void>
  registerProjects: () => Promise<CloudProjectRegistration>
  retryPrepare: (id: string) => Promise<unknown>
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

function parseRegistration(raw: unknown): CloudProjectRegistration {
  const environments: CloudProjectEnvironment[] = []
  for (const item of readArrayValue(readField(raw, 'environments')) ?? []) {
    const projectId = readString(item, 'projectId')
    const projectName = readString(item, 'projectName')
    const projectRoot = readString(item, 'projectRoot')
    const environmentId = readString(item, 'environmentId')
    if (projectId && projectName && projectRoot && environmentId) {
      environments.push({ projectId, projectName, projectRoot, environmentId })
    }
  }
  const failures: CloudProjectFailure[] = []
  for (const item of readArrayValue(readField(raw, 'failures')) ?? []) {
    const projectId = readString(item, 'projectId')
    const projectKey = readString(item, 'projectKey')
    const projectName = readString(item, 'projectName')
    const code = readString(item, 'code')
    if (projectId && projectKey && projectName && code) {
      failures.push({ projectId, projectKey, projectName, code })
    }
  }
  return { environments, failures }
}

export async function startRecoveryHarness(
  ipcHandlers: ReadonlyMap<string, IpcHandler>,
  options: RecoveryHarnessOptions = {}
): Promise<RecoveryHarness> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m58-recovery-')))
  const projectRoot = join(base, 'checkout', 'recovered-service')
  const registrationUserData = mkdtempSync(join(tmpdir(), 'orca-m58-recovery-user-'))

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m58-recovery-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  const platform: Platform = await startPlatform({
    ...(options.accessTtlMs === undefined ? {} : { accessTtlMs: options.accessTtlMs }),
    ...(options.refreshTtlMs === undefined ? {} : { refreshTtlMs: options.refreshTtlMs })
  })
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm58-admin' })
  })
  const adminToken = readString(await admin.json(), 'accessToken') ?? ''
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
      ORCA_CLOUD_HOST_NAME: 'dev-m58-recovery',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m58-recovery-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  const admission: CloudRuntimeAdmission = started
  await admission.ready

  const cloud: CloudRuntime = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m58-recovery-',
    service,
    tls: makeSelfSignedTls('dev-m58-recovery'),
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

  const created = await adminFetch('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      key: 'm58-recovered-service',
      name: 'Recovered Service',
      hostId: admission.host()!.hostId,
      path: projectRoot,
      repoUrl: options.provisionRepo ? makeBareRepository(base) : join(base, 'missing-source.git'),
      defaultBranch: 'main'
    })
  })
  expect(created.status, await created.clone().text()).toBe(201)
  const projectId = readString(await created.json(), 'id') ?? ''
  const granted = await adminFetch(`/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: RECOVERY_PERMISSIONS
    })
  })
  expect(granted.status).toBe(200)

  // Why: hide the seeded payment project so this suite sees exactly one project.
  const unseeded = await adminFetch('/v1/projects/proj_payment/grants', {
    method: 'PUT',
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
  })
  expect(unseeded.status).toBe(200)

  const session = new CloudSessionService({
    apiUrl: platform.url,
    tlsRejectUnauthorized: false,
    ...(options.refreshLeadMs === undefined ? {} : { refreshLeadMs: options.refreshLeadMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
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
    platformUrl: platform.url,
    projectId,
    projectRoot,
    adminFetch,
    getProject: async (id: string) => {
      const res = await adminFetch(`/v1/projects/${id}`)
      expect(res.status).toBe(200)
      return res.json()
    },
    beat: async () => {
      await admission.client!.refresh()
      await new Promise((resolve) => setTimeout(resolve, 50))
      await admission.client!.refresh()
    },
    registerProjects: async () =>
      parseRegistration(
        await requireHandler(ipcHandlers, CLOUD_PLATFORM_IPC.registerProjects)(null)
      ),
    retryPrepare: (id: string) =>
      requireHandler(ipcHandlers, CLOUD_PLATFORM_IPC.retryPrepare)(null, id),
    saveEvidence: (file: string, content: unknown) => {
      mkdirSync(RECOVERY_EVIDENCE_DIR, { recursive: true })
      writeFileSync(join(RECOVERY_EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
    },
    repoOf: (result: unknown) => {
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
