import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readField, readObjectValue, readString, readStringArray } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import {
  CLOUD_HOST_METHODS,
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
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
import { CloudConnectClient } from './cloud-connect-client'
import { readTicketClaims } from './cloud-connect-response'
import { CLOUD_SESSION_TABS_RESTORE_CAPABILITY } from '../../shared/cloud-workspace-info'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'

/**
 * W13a: `workspace.info` on a real host — real platform issuing tickets, a real
 * TLS runtime carrying the production method table (`CLOUD_HOST_METHODS`), a
 * real git checkout. The answer must be the ticket's own facts plus the checkout
 * found inside the workspace root, and nothing else.
 *
 * Node pool: bun's ws shim fails the throwaway-certificate handshake, the same
 * family as cloud-entry-session-slots (W5b defect B).
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'w13a-workspace-info')
const PROJECT_KEY = 'workspace-info-project'

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
let projectRoot = ''
let workspaceRoot = ''
const hostDenials: { eventType: string; method?: string }[] = []

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-workspace-info-')))
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

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-workspace-info-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-workspace-info',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'w13a-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-workspace-info',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-workspace-info-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-cloud-workspace-info-',
    service,
    tls: makeSelfSignedTls('dev-workspace-info'),
    // The exact table cloudAdmissionOption installs (production composition).
    methods: CLOUD_HOST_METHODS
  })
  admission.bindRuntime(cloud.runtime)
  // Production wires this in attachCloudRuntime; the harness owns the pieces separately.
  cloud.runtime.setCloudHostAudit((event) => {
    hostDenials.push(
      event.method === undefined
        ? { eventType: event.eventType }
        : { eventType: event.eventType, method: event.method }
    )
    admission.client?.reportAudit(event)
  })
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

  desktop = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await desktop.login('zhangsan', 'Passw0rd!')
}, 60_000)

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

async function openSessionSocket(): Promise<Extract<CloudConnection, { status: 'authenticated' }>> {
  const prepared = await desktop.prepareProjectLink(projectId)
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
    projectId
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

/** One `workspace.info` call over the admitted session, flattened for assertions. */
async function askWorkspaceInfo(): Promise<{
  ok: boolean
  raw: unknown
  projectId: string | null
  root: string | null
  repoUrl: string | null
  defaultBranch: string | null
  workspaceRoot: string | null
  path: string | null
  branch: string | null
  perms: string[] | null
  capabilities: string[] | null
  keys: string[]
  errorCode: string | null
}> {
  const socket = await openSessionSocket()
  try {
    const reply = await socket.rpc('workspace.info')
    if (!reply.ok) {
      return {
        ok: false,
        raw: null,
        projectId: null,
        root: null,
        repoUrl: null,
        defaultBranch: null,
        workspaceRoot: null,
        path: null,
        branch: null,
        perms: null,
        capabilities: null,
        keys: [],
        errorCode: reply.code
      }
    }
    const result = readObjectValue(reply.result)
    const project = readObjectValue(readField(result, 'project'))
    const workspace = readObjectValue(readField(result, 'workspace'))
    return {
      ok: true,
      raw: reply.result,
      projectId: readString(project, 'id'),
      root: readString(project, 'root'),
      repoUrl: readString(project, 'repoUrl'),
      defaultBranch: readString(project, 'defaultBranch'),
      workspaceRoot: readString(workspace, 'root'),
      path: readString(workspace, 'path'),
      branch: readString(workspace, 'branch'),
      perms: readStringArray(result, 'perms'),
      capabilities: readStringArray(result, 'capabilities'),
      keys: Object.keys(result ?? {}).sort(),
      errorCode: null
    }
  } finally {
    socket.ws.close()
  }
}

describe('workspace.info（真实平台 + 真实 TLS 宿主 + 真实仓库）', () => {
  it('W13A-1 未 ensure 时直出票据字段，path/branch=null，键集恰为白名单', async () => {
    const reply = await askWorkspaceInfo()

    expect(reply.errorCode ?? 'ok', JSON.stringify(reply.raw)).toBe('ok')
    expect(reply.projectId).toBe(projectId)
    expect(reply.root).toBe(projectRoot)
    expect(reply.repoUrl).toBe('')
    expect(reply.defaultBranch).toBe('main')
    expect(reply.workspaceRoot).toBe(workspaceRoot)
    expect(reply.path).toBeNull()
    expect(reply.branch).toBeNull()
    expect(reply.perms).toEqual(['open', 'terminal', 'file:read', 'file:write'])
    // U96 A-1: names only, no host facts (wire-additive field).
    expect(reply.capabilities).toEqual([CLOUD_SESSION_TABS_RESTORE_CAPABILITY])
    expect(reply.keys).toEqual(['capabilities', 'perms', 'project', 'workspace'])

    saveEvidence('w13a-1-before-ensure.json', reply.raw)
  }, 60_000)

  it('W13A-2 ensure 后返回 workspaceRoot 内的检出与当前分支', async () => {
    const ensured = await ensureCloudWorkspace(desktop, projectId)
    if (!ensured.ok) {
      throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
    }

    const reply = await askWorkspaceInfo()

    expect(reply.errorCode ?? 'ok', JSON.stringify(reply.raw)).toBe('ok')
    expect(reply.workspaceRoot).toBe(workspaceRoot)
    expect(reply.path).toBe(ensured.workspacePath)
    // The branch is whatever that checkout is actually on, read from git itself.
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ensured.workspacePath,
      encoding: 'utf8'
    }).trim()
    expect(reply.branch).toBe(branch)
    // The checkout the ticket names is a real worktree of the project.
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: ensured.workspacePath,
      encoding: 'utf8'
    }).trim()
    expect(toplevel).toBe(realpathSync(ensured.workspacePath))

    saveEvidence('w13a-2-after-ensure.json', {
      reply: reply.raw,
      workspacePath: ensured.workspacePath
    })
  }, 120_000)

  it('W13A-3 重复调用幂等：应答逐字段一致', async () => {
    const first = await askWorkspaceInfo()
    const second = await askWorkspaceInfo()

    expect(second).toEqual(first)
    saveEvidence('w13a-3-idempotent.json', { first: first.raw, second: second.raw })
  }, 60_000)

  it('W13A-4 非云宿主方法表没有该方法：owner 侧 method_not_found，老云宿主同样落到 method_not_found 而非 forbidden', async () => {
    const hasWorkspaceInfo = (methods: readonly { name: string }[]) =>
      methods.some((method) => method.name === 'workspace.info')
    expect(hasWorkspaceInfo(CLOUD_HOST_METHODS)).toBe(true)
    expect(hasWorkspaceInfo(ALL_RPC_METHODS)).toBe(false)

    const onCloudDenial = vi.fn()
    const dispatcher = new RpcDispatcher({ runtime: service, methods: ALL_RPC_METHODS })
    const response = await dispatcher.dispatch(
      { id: 'req-1', authToken: 'tok', method: 'workspace.info' },
      {
        callerScope: {
          kind: 'cloud',
          permissions: ['open', 'terminal', 'file:read', 'file:write'],
          downloadAllowed: true
        },
        onCloudDenial
      }
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(onCloudDenial).not.toHaveBeenCalled()
    saveEvidence('w13a-4-legacy-host.json', { response })
  }, 60_000)

  it('W13A-5 全程零 workspace.info 云拒绝审计（只读自省无拒绝路径）', () => {
    const denials = hostDenials.filter((event) => event.method === 'workspace.info')
    expect(denials).toEqual([])
    saveEvidence('w13a-5-audit.json', { hostDenials })
  })
})
