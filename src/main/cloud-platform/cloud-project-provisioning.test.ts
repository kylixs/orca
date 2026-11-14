import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import {
  PROVISIONING_README,
  git,
  makeBareRepository,
  saveProvisioningEvidence
} from './cloud-project-provisioning-fixture'
import { createCloudProvisionAssignmentExecutor } from './cloud-provision-assignment'
import { CloudSessionService } from './cloud-session-service'
import {
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'

/**
 * M57: a platform-created project with a repo URL is cloned by the enrolled host
 * from the heartbeat's U37 assignment, reported on the next heartbeat, and only
 * then opened — the ticket's project.provision is the idempotent short circuit.
 * Real platform process, real enrolled host, real TLS runtime, real bare git.
 */

const PERMISSIONS = ['open', 'terminal', 'agent', 'file:read', 'file:write']

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let session: CloudSessionService
let base = ''
let bareRepo = ''
let checkoutPath = ''
let workspaceRoot = ''
let failedCheckoutPath = ''
let projectId = ''
let failedProjectId = ''
let adminToken = ''

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m57-provision-')))
  bareRepo = makeBareRepository(base)
  checkoutPath = join(base, 'checkout', 'payment-service')
  workspaceRoot = join(checkoutPath, '.orca-worktrees', 'zhangsan')
  failedCheckoutPath = join(base, 'checkout', 'missing-service')

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m57-provision-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm57-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-m57-provision',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m57-provision-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m57-provision-',
    service,
    tls: makeSelfSignedTls('dev-m57-provision'),
    // Pre-W13a host table, on purpose: this suite predates workspace.info and never calls it.
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS, ...PROJECT_PROVISION_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  // Production wires this in attachCloudRuntime; the harness owns the pieces separately.
  cloud.runtime.setCloudProvisionReporter((report) => admission.client!.reportProvisioned(report))
  // U37: same point in production (installRuntimeCloudSurfaces); the kick clone
  // happens outside the ticket so a repo-ful project can reach ready on its own.
  admission.client!.onProvisionAssignment(
    createCloudProvisionAssignmentExecutor({
      provision: cloud.runtime.provisionCloudProject.bind(cloud.runtime),
      report: (report) => admission.client!.reportProvisioned(report),
      inMaintenance: () => admission.client!.snapshot().maintenance !== null
    })
  )
  await admission.client!.refresh()

  projectId = await createProvisioningProject({
    key: 'm57-payment-service',
    name: 'Payment Service',
    repoUrl: bareRepo,
    path: checkoutPath
  })
  failedProjectId = await createProvisioningProject({
    key: 'm57-missing-service',
    name: 'Missing Service',
    repoUrl: join(base, 'missing-source.git'),
    path: failedCheckoutPath
  })

  session = new CloudSessionService({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await session.login('zhangsan', 'Passw0rd!')
})

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${platform.url}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`,
      ...init.headers
    }
  })
}

async function createProvisioningProject(input: {
  key: string
  name: string
  repoUrl: string
  path: string
}): Promise<string> {
  const created = await adminFetch('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      key: input.key,
      name: input.name,
      hostId: admission.host()!.hostId,
      path: input.path,
      repoUrl: input.repoUrl,
      defaultBranch: 'main'
    })
  })
  expect(created.status, await created.clone().text()).toBe(201)
  const body: unknown = await created.json()
  expect(readString(body, 'repoUrl')).toBe(input.repoUrl)
  expect(readString(body, 'status')).toBe('provisioning')
  const id = readString(body, 'id') ?? ''
  const granted = await adminFetch(`/v1/projects/${id}/grants`, {
    method: 'PUT',
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: PERMISSIONS
    })
  })
  expect(granted.status, await granted.clone().text()).toBe(200)
  return id
}

async function getProject(id: string): Promise<unknown> {
  const res = await adminFetch(`/v1/projects/${id}`)
  expect(res.status).toBe(200)
  return res.json()
}

/** Two beats: the first may already be in flight from the timer before the report was queued. */
async function beat(): Promise<void> {
  await admission.client!.refresh()
  await admission.client!.refresh()
  await new Promise((resolve) => setTimeout(resolve, 50))
  await admission.client!.refresh()
}

/** Beats until a heartbeat assignment makes the host clone and report; then the platform flips. */
async function beatUntilStatus(id: string, status: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await beat()
    if (readString(await getProject(id), 'status') === status) {
      return
    }
  }
  throw new Error(`project ${id} never became ${status}`)
}

async function provisionAuditEvents(id: string): Promise<unknown[]> {
  const res = await adminFetch('/v1/audit/events?eventType=project_provision&limit=100')
  expect(res.status).toBe(200)
  return (readArrayValue(readField(await res.json(), 'events')) ?? []).filter(
    (event) => readString(event, 'targetId') === id
  )
}

describe('云端项目 provisioning（真实平台 + 真实 TLS Runtime + 真实 git）', () => {
  it('M57-1 心跳指派先克隆：首次打开时票据内 provision 幂等短路、创建工作区', async () => {
    // U37: the first clone is no longer ticket-bound. Beats carry the assignment,
    // the host clones, and the report flips the platform ready before any open.
    await beatUntilStatus(projectId, 'ready')

    // The ticket's project.provision is now the already-provisioned short circuit.
    const prepared = await session.ensureProjectPrepared(projectId)
    expect(prepared).toEqual({ ok: true, provisioned: false })

    const ensured = await session.ensureWorkspace(projectId)
    expect(ensured, JSON.stringify(ensured)).toMatchObject({ ok: true, created: true })
    if (!ensured.ok) {
      throw new Error(ensured.code)
    }

    expect(existsSync(join(checkoutPath, 'README.md'))).toBe(true)
    expect(readFileSync(join(checkoutPath, 'README.md'), 'utf8')).toBe(PROVISIONING_README)
    expect(realpathSync(git(checkoutPath, 'rev-parse', '--show-toplevel').trim())).toBe(
      realpathSync(checkoutPath)
    )
    expect(ensured.workspacePath.startsWith(`${workspaceRoot}/`)).toBe(true)
    expect(realpathSync(git(ensured.workspacePath, 'rev-parse', '--show-toplevel').trim())).toBe(
      realpathSync(ensured.workspacePath)
    )

    await beat()
    const project = await getProject(projectId)
    expect(readString(project, 'status')).toBe('ready')
    expect(readString(project, 'provisioningError')).toBeNull()

    const events = await provisionAuditEvents(projectId)
    expect(events.length).toBeGreaterThan(0)
    expect(readString(events[0], 'result')).toBe('success')

    saveProvisioningEvidence('m57-1-success.json', {
      ensured,
      provisionRpc: prepared,
      checkout: {
        path: checkoutPath,
        toplevel: git(checkoutPath, 'rev-parse', '--show-toplevel').trim(),
        readme: readFileSync(join(checkoutPath, 'README.md'), 'utf8')
      },
      worktree: {
        path: ensured.workspacePath,
        withinWorkspaceRoot: ensured.workspacePath.startsWith(`${workspaceRoot}/`),
        toplevel: git(ensured.workspacePath, 'rev-parse', '--show-toplevel').trim()
      },
      project: await getProject(projectId),
      audit: events
    })
  }, 180_000)

  it('M57-2 失败：心跳指派克隆失败即回报、清理半成品、平台 failed、打开被门禁拒绝', async () => {
    // U37: the failure surfaces from the kick, before any ticket could open.
    await beatUntilStatus(failedProjectId, 'failed')
    expect(existsSync(failedCheckoutPath)).toBe(false)

    const project = await getProject(failedProjectId)
    expect(readString(project, 'status')).toBe('failed')
    const provisioningError = readString(project, 'provisioningError')
    expect(provisioningError).not.toBeNull()
    expect(provisioningError).toContain('CLONE_FAILED')

    const events = await provisionAuditEvents(failedProjectId)
    expect(readString(events[0], 'result')).toBe('failure')

    // U20 gate: a failed project cannot mint a ticket, so the open stops at the platform.
    const ensured = await session.ensureWorkspace(failedProjectId)
    expect(ensured).toMatchObject({ ok: false })
    if (ensured.ok) {
      throw new Error('provisioning unexpectedly succeeded')
    }
    expect(ensured.code).toBe('PROJECT_NOT_PREPARED')

    saveProvisioningEvidence('m57-2-failure.json', {
      ensured,
      checkoutExists: existsSync(failedCheckoutPath),
      project: await getProject(failedProjectId),
      audit: events
    })
  }, 180_000)
})
