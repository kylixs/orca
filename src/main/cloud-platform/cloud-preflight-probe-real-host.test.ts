import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  readArray,
  readArrayValue,
  readObjectValue,
  readString,
  readStringArray
} from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import {
  CLOUD_HOST_METHODS,
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { CloudConnectClient } from './cloud-connect-client'
import { readTicketClaims } from './cloud-connect-response'
import {
  REPO_ROOT,
  connectCloudSession,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudConnection,
  type CloudRuntime,
  type CloudSession,
  type Platform
} from './cloud-session-e2e-harness'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'
import { isInsideWorkspaceRoot } from '../../shared/cloud-workspace-open'

/**
 * O1-d: `preflight.detectAgents`/`refreshAgents` on a real host — real platform
 * tickets, the production cloud method table (`CLOUD_HOST_METHODS`) over real
 * TLS, a real managed checkout. A ticket holding `agent` probes its own
 * workspace; the host-wide diagnostics (`check`/`detectRemoteAgents`) stay
 * refused, and a ticket without `agent` is refused at the permission layer.
 *
 * Node pool: bun's ws shim fails the throwaway-certificate handshake, the same
 * family as cloud-workspace-info-real-host (W5b defect B).
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'o1-d-preflight')
const PROJECT_KEY = 'preflight-probe'
const NO_AGENT_KEY = 'preflight-probe-noagent'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), `${JSON.stringify(content, null, 2)}\n`)
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let desktop: CloudConnectClient
let service: OrcaRuntimeService
let projectId = ''
let noAgentProjectId = ''
let projectRoot = ''
let workspaceRoot = ''
let workspacePath = ''
let workspaceWorktreeId = ''
const hostDenials: {
  eventType: string
  method?: string
  denial?: string
  reason?: string
}[] = []

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-preflight-probe-')))
  projectRoot = join(base, 'payment-service')
  mkdirSync(projectRoot, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: projectRoot })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: projectRoot })
  writeFileSync(join(projectRoot, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: projectRoot })
  // Why --no-verify: a global core.hooksPath (husky) must not gate a fixture commit.
  execFileSync('git', ['commit', '--no-verify', '-qm', 'init'], { cwd: projectRoot })
  workspaceRoot = `${projectRoot}/.orca-worktrees/zhangsan`

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-preflight-probe-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-preflight-probe',
    path: projectRoot,
    displayName: 'payment-service',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'o1d-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-preflight-probe',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-preflight-probe-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-cloud-preflight-probe-',
    service,
    tls: makeSelfSignedTls('dev-preflight-probe'),
    // The exact table cloudAdmissionOption installs (production composition).
    methods: CLOUD_HOST_METHODS
  })
  admission.bindRuntime(cloud.runtime)
  // Production wires this in attachCloudRuntime; the harness owns the pieces separately.
  cloud.runtime.setCloudHostAudit((event) => {
    hostDenials.push({
      eventType: event.eventType,
      ...(event.method === undefined ? {} : { method: event.method }),
      ...(event.denial === undefined ? {} : { denial: event.denial }),
      ...(event.reason === undefined ? {} : { reason: event.reason })
    })
    admission.client?.reportAudit(event)
  })
  await admission.client!.refresh()

  const hostId = admission.host()!.hostId
  projectId = await createProject(adminToken, hostId, PROJECT_KEY, projectRoot, [
    'open',
    'terminal',
    'agent',
    'file:read',
    'file:write'
  ])
  // The negative ticket differs only in the missing `agent` permission.
  noAgentProjectId = await createProject(
    adminToken,
    hostId,
    NO_AGENT_KEY,
    join(base, 'no-agent-project'),
    ['open', 'terminal', 'file:read']
  )

  desktop = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await desktop.login('zhangsan', 'Passw0rd!')

  const ensured = await ensureCloudWorkspace(desktop, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
  }
  workspacePath = ensured.workspacePath
  expect(isInsideWorkspaceRoot(workspaceRoot, workspacePath)).toBe(true)
  workspaceWorktreeId = await listWorkspaceWorktreeId()
}, 120_000)

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

async function createProject(
  adminToken: string,
  hostId: string,
  key: string,
  path: string,
  permissions: string[]
): Promise<string> {
  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ key, name: key, hostId, path })
  })
  expect(create.status, await create.clone().text()).toBe(201)
  const id = readString(await create.json(), 'id')
  if (id === null) {
    throw new Error('project id missing')
  }
  const grant = await fetch(`${platform.url}/v1/projects/${id}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions })
  })
  expect(grant.status).toBe(200)
  return id
}

/** The managed checkout `ensureCloudWorkspace` created, by its path inside the ticket root. */
async function listWorkspaceWorktreeId(): Promise<string> {
  const listed = await desktop.rpc('worktree.list', { repo: `path:${projectRoot}` }, 15_000)
  expect(listed.ok, JSON.stringify(listed)).toBe(true)
  if (!listed.ok) {
    throw new Error('worktree.list failed')
  }
  for (const record of readArray(listed.result, 'worktrees') ?? []) {
    if (readString(record, 'path') === workspacePath) {
      const id = readString(record, 'id')
      if (id === null) {
        throw new Error('the managed checkout has no worktree id')
      }
      return id
    }
  }
  throw new Error(`worktree.list has no row for ${workspacePath}`)
}

async function openSessionSocket(
  targetProjectId: string
): Promise<Extract<CloudConnection, { status: 'authenticated' }>> {
  const prepared = await desktop.prepareProjectLink(targetProjectId)
  const identity = desktop.deviceIdentity()
  const claims = readTicketClaims(prepared.ticket.credential)
  if (claims.deviceToken === null) {
    throw new Error('ticket carries no device token')
  }
  const session: CloudSession = {
    accessToken: '',
    deviceId: identity.deviceId,
    devicePubKey: desktop.devicePubKeyB64,
    deviceKeys: identity.keyPair,
    deviceToken: claims.deviceToken,
    credential: prepared.ticket.credential,
    projectId: targetProjectId
  }
  const connection = await connectCloudSession(
    cloud.endpoint,
    cloud.serverPublicKeyB64,
    session,
    5000,
    { tlsRejectUnauthorized: false }
  )
  if (connection.status !== 'authenticated') {
    throw new Error(`session socket was refused: ${JSON.stringify(connection.close)}`)
  }
  return connection
}

async function probeAgents(
  method: string,
  params: Record<string, unknown>
): Promise<{
  ok: boolean
  raw: unknown
  agents: string[] | null
  code: string | null
  message: string
}> {
  const socket = await openSessionSocket(projectId)
  try {
    const reply = await socket.rpc(method, params)
    if (!reply.ok) {
      return {
        ok: false,
        raw: null,
        agents: null,
        code: reply.code,
        message: reply.message
      }
    }
    return {
      ok: true,
      raw: reply.result,
      // detectAgents answers a bare string array; refreshAgents wraps it in `agents`.
      agents:
        readArrayValue(reply.result)?.filter((agent) => typeof agent === 'string') ??
        readStringArray(readObjectValue(reply.result), 'agents'),
      code: null,
      message: ''
    }
  } finally {
    socket.ws.close()
  }
}

describe('preflight agent 探测（真实平台 + 真实 TLS 宿主 + 真实托管检出）', () => {
  it('O1D-1 持 agent 权限的票据探测本人工作区：应答且结果只含探测出的 CLI 名', async () => {
    const reply = await probeAgents('preflight.detectAgents', { worktreeId: workspaceWorktreeId })

    expect(reply.code ?? 'ok').toBe('ok')
    expect(reply.agents, JSON.stringify(reply.raw)).not.toBeNull()
    expect(reply.agents!.every((agent) => typeof agent === 'string' && agent.length > 0)).toBe(true)
    saveEvidence('o1d-1-detect-agents.json', {
      worktreeId: workspaceWorktreeId,
      workspacePath,
      agents: reply.agents
    })
  }, 60_000)

  it('O1D-2 refreshAgents 应答 PATH 水合结果，宿主审计零 method_denied', async () => {
    const reply = await probeAgents('preflight.refreshAgents', { worktreeId: workspaceWorktreeId })

    expect(reply.code ?? 'ok').toBe('ok')
    const result = readObjectValue(reply.raw)
    expect(readStringArray(result, 'agents')).not.toBeNull()
    expect(readString(result, 'pathSource')).not.toBeNull()

    const denied = hostDenials.filter(
      (event) =>
        event.eventType === 'method_denied' && event.method?.startsWith('preflight.') === true
    )
    expect(denied, JSON.stringify(hostDenials)).toEqual([])
    saveEvidence('o1d-2-refresh-agents.json', { reply: reply.raw, hostDenials })
  }, 120_000)

  it('O1D-3 无名探测被拒：不许退回宿主默认的全机 PATH 探测', async () => {
    const missing = await probeAgents('preflight.detectAgents', {})
    expect(missing.code).toBe('forbidden')
    expect(missing.message).toContain('must name the workspace it probes')

    const unknown = await probeAgents('preflight.refreshAgents', {
      worktreeId: 'no-such-workspace'
    })
    expect(unknown.code).toBe('forbidden')
    expect(unknown.message).toContain('not available to the cloud session')

    // Both are boundary verdicts, not permission denials.
    expect(
      hostDenials.filter(
        (event) =>
          event.eventType === 'method_denied' && event.method?.startsWith('preflight.') === true
      )
    ).toEqual([])
    saveEvidence('o1d-3-unbounded-probe.json', { missing, unknown })
  }, 60_000)

  it('O1D-4 无 agent 权限的票据在权限层被拒，文案指明缺 agent', async () => {
    const socket = await openSessionSocket(noAgentProjectId)
    try {
      const reply = await socket.rpc('preflight.detectAgents', {
        worktreeId: 'no-such-workspace'
      })
      expect(reply.ok).toBe(false)
      if (!reply.ok) {
        expect(reply.code).toBe('forbidden')
        expect(reply.message).toBe(
          "Method 'preflight.detectAgents' needs the 'agent' project permission, which this cloud session was not granted."
        )
      }
      saveEvidence('o1d-4-no-agent-permission.json', { reply })
    } finally {
      socket.ws.close()
    }
  }, 60_000)

  it('O1D-5 宿主全域诊断逐字拒绝：check/detectRemoteAgents 不是云会话可用的方法', async () => {
    const socket = await openSessionSocket(projectId)
    try {
      const results: Record<string, unknown> = {}
      for (const method of ['preflight.check', 'preflight.detectRemoteAgents']) {
        const reply = await socket.rpc(method, {})
        results[method] = reply
        expect(reply.ok, `${method} must stay refused`).toBe(false)
        if (!reply.ok) {
          expect(reply.code).toBe('forbidden')
          expect(reply.message).toBe(`Method '${method}' is not available to cloud sessions`)
        }
      }
      expect(hostDenials).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventType: 'method_denied', method: 'preflight.check' }),
          expect.objectContaining({
            eventType: 'method_denied',
            method: 'preflight.detectRemoteAgents'
          })
        ])
      )
      saveEvidence('o1d-5-host-diagnostics-denied.json', { results, hostDenials })
    } finally {
      socket.ws.close()
    }
  }, 60_000)

  it('O1D-6 裸方法表上云侧拒绝来自权限表，而不是 method_not_found', async () => {
    const onCloudDenial = vi.fn()
    const dispatcher = new RpcDispatcher({
      runtime: service,
      methods: ALL_RPC_METHODS
    })
    const response = await dispatcher.dispatch(
      { id: 'req-1', authToken: 'tok', method: 'preflight.detectAgents' },
      {
        callerScope: {
          kind: 'cloud',
          permissions: ['open', 'terminal', 'file:read', 'file:write'],
          downloadAllowed: true
        },
        onCloudDenial
      }
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    if (!response.ok) {
      expect(response.error.message).toContain("needs the 'agent' project permission")
    }
    expect(onCloudDenial).toHaveBeenCalledWith(
      { denial: 'PERMISSION_MISSING', permission: 'agent' },
      'preflight.detectAgents'
    )
    saveEvidence('o1d-6-permission-table-decides.json', { response })
  }, 60_000)
})
