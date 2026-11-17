import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { readArrayValue, readField, readString } from '../../shared/json-fields'
import { parsePairingCode } from '../../shared/pairing'
import type { CloudAgentSnapshot } from '../cloud-platform/cloud-agent-client'
import type { createCloudAccessGuard } from '../cloud-platform/cloud-access-guard'
import type { CloudHostAuditInput, CloudHostAuditSink } from '../cloud-platform/cloud-host-audit'
import type {
  CloudProvisionReport,
  CloudProvisionReporter
} from '../cloud-platform/cloud-project-provision'
import {
  connectCloudSession,
  openPlatformSession,
  REPO_ROOT,
  startPlatform,
  type CloudConnection,
  type Platform
} from '../cloud-platform/cloud-session-e2e-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import {
  attachCloudRuntime,
  CLOUD_HOST_METHODS,
  cloudAdmissionOption,
  cloudRuntimeAdmission,
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission,
  type CloudRuntimeTarget
} from './cloud-runtime-admission'
import {
  attachRuntimeToCloudAdmission,
  type AttachableCloudAdmission
} from './cloud-runtime-attach'

/**
 * W12b-2（U17）：装机时序。注册模式首启时 enrollment 是在途网络调用，attach 发生在
 * 它兑现之前——按当刻的 `admission.client` 判空会让 provision 回报器与云策略门从此
 * 再未安装：平台看不到 `failed`（永停 ready/provisioning），云会话下载 fail-closed
 * 全拒、读预算不计量。这里断言首启即补装、重启（stored credential）与 poll 模式不回退。
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'w12b2-reporter-timing')

/**
 * attach 的渲染端 IPC 面（attachCloudRuntime → installCloudPlatformIpc）需要 electron；
 * 这里只收下注册，不驱动任何通道。
 */
vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { isPackaged: false }
}))

/** U181 H1：IPC 面归 Electron 启动路径，admission 的 attach 不得再触达它。 */
const cloudPlatformIpc = vi.hoisted(() => ({ installCloudPlatformIpc: vi.fn() }))
vi.mock('../ipc/cloud-platform', () => cloudPlatformIpc)

/** Unroutable loopback port: poll-mode refresh attempts fail fast, never hang. */
const DEAD_PLATFORM = 'http://127.0.0.1:9'

type SurfacesClient = NonNullable<AttachableCloudAdmission['client']>

const emptySnapshot = (): CloudAgentSnapshot => ({
  kids: [],
  revocations: { projects: [], users: [], devices: [], jtis: [] },
  policies: null,
  policyVersion: null,
  lastRefreshAt: null,
  lastError: null,
  lastHeartbeatAt: null,
  lastHeartbeatOk: null,
  lastHeartbeatHttpStatus: null,
  lastErrorCode: null,
  maintenance: null,
  hostRevoked: false
})

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
} {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function stubClient(): {
  client: SurfacesClient
  reports: CloudProvisionReport[]
  audits: CloudHostAuditInput[]
  installedProvisionExecutors: () => number
} {
  const reports: CloudProvisionReport[] = []
  const audits: CloudHostAuditInput[] = []
  let provisionExecutors = 0
  return {
    client: {
      snapshot: emptySnapshot,
      reportProvisioned: (report) => {
        reports.push(report)
      },
      reportAudit: (event) => {
        audits.push(event)
      },
      fileEvents: {
        audit: () => ({ queued: false, reason: 'audit-unavailable' as const }),
        noteCapabilities: () => {},
        capabilities: () => null
      },
      onProvisionAssignment: () => {
        provisionExecutors += 1
        return () => {
          provisionExecutors -= 1
        }
      }
    },
    reports,
    audits,
    installedProvisionExecutors: () => provisionExecutors
  }
}

/** Enrollment 仍可事后兑现的准入：复刻「client 在 attach 之后才出现」的首启形态。 */
function stubAdmission(initial: SurfacesClient | null, ready: Promise<void>) {
  let client = initial
  const admission: AttachableCloudAdmission = {
    bindRuntime: () => undefined,
    get client() {
      return client
    },
    ready
  }
  return {
    admission,
    enroll: (enrolled: SurfacesClient | null) => {
      client = enrolled
    }
  }
}

type RecordingTarget = CloudRuntimeTarget & {
  installed: string[]
  guard: ReturnType<typeof createCloudAccessGuard> | null
  reportProvisioned: CloudProvisionReporter | null
  reportAudit: CloudHostAuditSink | null
}

function recordingTarget(): RecordingTarget {
  const recorded: RecordingTarget = {
    closeCloudDeviceSessions: () => 0,
    setCloudAccessGuard: (guard) => {
      recorded.guard = guard
      if (guard) {
        recorded.installed.push('guard')
      }
    },
    setCloudProvisionReporter: (reporter) => {
      recorded.reportProvisioned = reporter
      if (reporter) {
        recorded.installed.push('provision-reporter')
      }
    },
    setCloudHostAudit: (sink) => {
      recorded.reportAudit = sink
      if (sink) {
        recorded.installed.push('audit-sink')
      }
    },
    getDeviceRegistry: () => null,
    getWebSocketEndpoint: () => null,
    getE2EEPublicKey: () => null,
    installed: [],
    guard: null,
    reportProvisioned: null,
    reportAudit: null
  }
  return recorded
}

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

describe('attach 装机时序（桩准入）', () => {
  beforeEach(() => {
    cloudPlatformIpc.installCloudPlatformIpc.mockClear()
  })

  it('首启（enrollment 在途）：attach 当刻不装机，ready 兑现后补装', async () => {
    const enrolment = deferred()
    const { admission, enroll } = stubAdmission(null, enrolment.promise)
    const target = recordingTarget()

    attachRuntimeToCloudAdmission(target, admission)
    expect(target.installed).toEqual([])
    expect(cloudPlatformIpc.installCloudPlatformIpc).not.toHaveBeenCalled()

    const fake = stubClient()
    enroll(fake.client)
    enrolment.resolve()
    await enrolment.promise
    expect(target.installed).toEqual(['guard', 'provision-reporter', 'audit-sink'])
    // U37: the kick executor rides the same install point as the reporter.
    expect(fake.installedProvisionExecutors()).toBe(1)

    // 补装的回报器确实把 provision 结果与审计事件交给客户端（心跳携带）。
    target.reportProvisioned?.({
      projectId: 'proj_w12b2',
      ok: false,
      error: 'PROJECT_NOT_PREPARED: x'
    })
    target.reportAudit?.({
      eventType: 'method_denied',
      method: 'browser.download'
    })
    expect(fake.reports).toEqual([
      { projectId: 'proj_w12b2', ok: false, error: 'PROJECT_NOT_PREPARED: x' }
    ])
    expect(fake.audits).toEqual([{ eventType: 'method_denied', method: 'browser.download' }])
  })

  it('enrollment 失败：不装机、留一行错误日志，也不留 unhandled rejection', async () => {
    const enrolment = deferred()
    const { admission } = stubAdmission(null, enrolment.promise)
    const target = recordingTarget()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      attachRuntimeToCloudAdmission(target, admission)
      enrolment.reject(new Error('cloud host enrolment failed: boom'))
      await expect(enrolment.promise).rejects.toThrow('boom')
      expect(target.installed).toEqual([])
      expect(consoleError).toHaveBeenCalledWith(
        '[cloud] host enrolment failed:',
        expect.objectContaining({ message: expect.stringContaining('boom') })
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('已有 client（poll 模式 / stored credential 重启）：attach 当刻同步装机，ready 兑现后不重复', async () => {
    const fake = stubClient()
    const { admission } = stubAdmission(fake.client, Promise.resolve())
    const target = recordingTarget()

    attachRuntimeToCloudAdmission(target, admission)
    expect(target.installed).toEqual(['guard', 'provision-reporter', 'audit-sink'])
    expect(cloudPlatformIpc.installCloudPlatformIpc).not.toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()
    expect(target.installed).toEqual(['guard', 'provision-reporter', 'audit-sink'])
  })

  it('非云构建（无准入）：不装机，也不安装渲染端 IPC（IPC 归 Electron 启动路径）', () => {
    const target = recordingTarget()
    attachRuntimeToCloudAdmission(target, null)
    expect(target.installed).toEqual([])
    expect(cloudPlatformIpc.installCloudPlatformIpc).not.toHaveBeenCalled()
  })

  it('对照：poll 模式行为不变——client 即刻在，attach 同步装机', () => {
    const polled = startCloudRuntimeAdmission({
      ORCA_CLOUD_API_URL: DEAD_PLATFORM,
      ORCA_CLOUD_INTERNAL_TOKEN: 'internal-token-w12b2',
      ORCA_CLOUD_HOST_ID: 'host_w12b2',
      ORCA_CLOUD_HOST_NAME: 'dev-w12b2-poll'
    })
    expect(polled).not.toBeNull()
    expect(polled?.client).not.toBeNull()

    const target = recordingTarget()
    attachRuntimeToCloudAdmission(target, polled)
    expect(target.installed).toEqual(['guard', 'provision-reporter', 'audit-sink'])
    expect(target.guard?.downloadAllowed('proj_w12b2')).toBe(false)
    polled?.stop()
  })
})

/**
 * 真实平台 + 真实 Runtime 的首启：attach 发生在 enrollment 兑现之前（生产时序），
 * 随后一次注定失败的 provision 必须把 `failed` 带回平台，策略门必须随策略放行下载。
 */

const HOST_NAME = 'dev-w12b2-first'
const PROJECT_KEY = 'w12b2-provision-failed'
const PERMISSIONS = ['open', 'terminal', 'agent', 'file:read', 'file:write', 'download']

let platform: Platform
let adminToken = ''
let hostDataDir = ''
let projectId = ''
let admission: CloudRuntimeAdmission | null = null
let endpoint = ''
let serverPublicKeyB64 = ''

type AuthenticatedSession = Extract<CloudConnection, { status: 'authenticated' }>

async function adminLogin(): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'Adm1n!',
      deviceName: 'w12b2-admin'
    })
  })
  const token = readString(await res.json(), 'accessToken')
  if (token === null) {
    throw new Error('admin login failed')
  }
  return token
}

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

async function mintHostToken(): Promise<string> {
  const res = await adminFetch('/v1/hosts/tokens', { method: 'POST' })
  const token = readString(await res.json(), 'token')
  if (token === null) {
    throw new Error('host token missing')
  }
  return token
}

/**
 * 注定失败的 provision：票据路径被一个既有文件占住，init 落盘必败。U20 后 connect 只
 * 放行 ready 项目，而宿主只在票据内克隆（repo-ful 项目拿不到第一张票），所以失败经
 * 票据可达的 init 计划驱动——本组只验证「宿主失败 → 平台 failed」这条回报通道本身，
 * 不绑定具体计划。
 */
async function createFailingProject(hostId: string): Promise<string> {
  const blockedPath = join(mkdtempSync(join(tmpdir(), 'orca-w12b2-projects-')), 'checkout')
  writeFileSync(blockedPath, 'not a directory')
  const created = await adminFetch('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId,
      path: blockedPath
    })
  })
  expect(created.status, await created.clone().text()).toBe(201)
  const body: unknown = await created.json()
  // 无 repoUrl 的项目创建即 ready：只有 ready 取得到票，init 的失败随后把它打成 failed。
  expect(readString(body, 'status')).toBe('ready')
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

async function setGlobalPolicy(body: Record<string, unknown>): Promise<void> {
  const res = await adminFetch('/v1/policies/download', {
    method: 'PUT',
    body: JSON.stringify(body)
  })
  expect(res.status, await res.clone().text()).toBe(200)
}

async function setProjectPolicy(
  projectId: string,
  body: Record<string, unknown>
): Promise<Response> {
  return await adminFetch(`/v1/projects/${projectId}/policy`, {
    method: 'PUT',
    body: JSON.stringify(body)
  })
}

async function connect(): Promise<AuthenticatedSession> {
  const session = await openPlatformSession(platform, {
    projectKey: PROJECT_KEY,
    deviceName: `w12b2-${Math.random().toString(16).slice(2, 8)}`
  })
  const connection = await connectCloudSession(endpoint, serverPublicKeyB64, session)
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got close ${connection.close.code}`)
  }
  return connection
}

/**
 * Keeps beating until the report has landed: a refresh already in flight when the
 * report was queued carries nothing, so one beat is not enough.
 */
async function beatUntil(status: () => Promise<string | null>): Promise<string | null> {
  let seen: string | null = null
  for (let attempt = 0; attempt < 6 && seen !== 'failed'; attempt += 1) {
    await admission?.client?.refresh()
    await new Promise((resolve) => setTimeout(resolve, 50))
    seen = await status()
  }
  return seen
}

async function provisionAuditEvents(id: string): Promise<unknown[]> {
  const res = await adminFetch('/v1/audit/events?eventType=project_provision&limit=100')
  expect(res.status).toBe(200)
  const events = readArrayValue(readField(await res.json(), 'events')) ?? []
  return events.filter((event) => readString(event, 'targetId') === id)
}

beforeAll(async () => {
  // beforeAll 先于全局 setup 的 beforeEach：装机路径要解析 userData，必须自己装。
  installFakeAppEnvironment()
  platform = await startPlatform()
  adminToken = await adminLogin()
  hostDataDir = mkdtempSync(join(tmpdir(), 'orca-w12b2-host-'))

  // 生产时序复刻（main-process-runtime-launch）：cloudAdmissionOption 在 RPC server
  // 构造前同步触发 enrollment，attach 紧随其后，此刻它必然还在途。
  const env = {
    ORCA_CLOUD_API_URL: platform.url,
    ORCA_CLOUD_HOST_TOKEN: await mintHostToken(),
    ORCA_CLOUD_HOST_NAME: HOST_NAME
  }
  const options = cloudAdmissionOption(env, { userDataPath: hostDataDir })
  // W13a audit MIN-1③: the production option must carry the constant itself, so a
  // reverted in-line composition drifts red here instead of silently.
  expect(options.methods).toBe(CLOUD_HOST_METHODS)
  admission = cloudRuntimeAdmission(env, { userDataPath: hostDataDir })
  if (!admission || !options.upgradeAdmission) {
    throw new Error('cloud admission not enabled')
  }
  // 首启签名：client 尚不存在——这正是旧实现跳过装机的分支。
  expect(admission.client).toBeNull()

  const runtime = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-w12b2-runtime-')),
    enableWebSocket: true,
    wsPort: 0,
    upgradeAdmission: options.upgradeAdmission,
    ...(options.connectionGate ? { connectionGate: options.connectionGate } : {}),
    ...(options.methods ? { methods: options.methods } : {})
  })
  attachCloudRuntime(runtime)
  await runtime.start()
  const offer = runtime.createPairingOffer({
    address: '127.0.0.1',
    name: HOST_NAME,
    scope: 'runtime'
  })
  const parsed = offer.available ? parsePairingCode(offer.pairingUrl) : null
  if (!parsed) {
    throw new Error('WebSocket pairing unavailable')
  }
  endpoint = parsed.endpoint
  serverPublicKeyB64 = parsed.publicKeyB64

  await admission.ready
  const hostId = admission.host()?.hostId
  if (!hostId) {
    throw new Error('enrolment did not yield a host id')
  }
  projectId = await createFailingProject(hostId)
}, 60_000)

afterAll(async () => {
  admission?.client?.stop()
  await platform?.stop()
})

describe('首启宿主的装机与回报（真实平台 + 真实 Runtime）', () => {
  it('策略门随 enrollment 兑现生效：下载按平台策略放行，读按预算计量', async () => {
    if (!admission?.client) {
      throw new Error('host not ready')
    }
    await setGlobalPolicy({ downloadDefault: 'allow' })
    await admission.client.refresh()

    const session = await connect()
    try {
      // 缺策略门时导出恒拒（fail-closed）；装了之后才随策略打开。
      const exported = await session.rpc('browser.download', { selector: 'a' })
      expect(exported.ok).toBe(false)
      if (!exported.ok) {
        expect(exported.message).not.toContain('platform policy')
      }

      const tight = await setProjectPolicy(projectId, {
        downloadPolicy: 'allow',
        readRatePerHour: { calls: 1, bytes: 1024 * 1024 }
      })
      expect(tight.status, await tight.clone().text()).toBe(200)
      await admission.client.refresh()

      const first = await session.rpc('files.read', {
        worktree: PROJECT_KEY,
        relativePath: 'a.txt'
      })
      expect(first.ok).toBe(false)
      if (!first.ok) {
        expect(first.code).not.toBe('read_budget_exceeded')
      }
      const second = await session.rpc('files.read', {
        worktree: PROJECT_KEY,
        relativePath: 'b.txt'
      })
      expect(second.ok).toBe(false)
      if (!second.ok) {
        expect(second.code).toBe('read_budget_exceeded')
        expect(second.message).toContain('1/1')
      }
      saveEvidence('w12b2-policy-guard.json', { exported, first, second })
    } finally {
      session.ws.close()
    }
  }, 60_000)

  it('失败 provision 经回报器上报：平台置 failed + provisioningError', async () => {
    if (!admission?.client) {
      throw new Error('host not ready')
    }
    const session = await connect()
    let reply: Awaited<ReturnType<AuthenticatedSession['rpc']>>
    try {
      reply = await session.rpc('project.provision')
    } finally {
      session.ws.close()
    }
    // 信封 ok 只代表 RPC 本身送达；provision 的判定在 result 里。
    if (!reply.ok) {
      throw new Error(`project.provision refused at the envelope: ${reply.code}`)
    }
    expect(readField(reply.result, 'ok')).toBe(false)
    expect(readString(reply.result, 'code')).toBe('INIT_FAILED')

    let project: unknown = null
    const status = await beatUntil(async () => {
      const res = await adminFetch(`/v1/projects/${projectId}`)
      expect(res.status).toBe(200)
      project = await res.json()
      return readString(project, 'status')
    })
    expect(status).toBe('failed')
    const provisioningError = readString(project, 'provisioningError')
    expect(provisioningError).not.toBeNull()
    expect(provisioningError).toContain('INIT_FAILED')

    const events = await provisionAuditEvents(projectId)
    expect(events.length).toBeGreaterThan(0)
    expect(readString(events[0], 'result')).toBe('failure')
    expect(readString(events[0], 'targetId')).toBe(projectId)
    expect(readString(readField(events[0], 'metadata'), 'error')).toContain('INIT_FAILED')
    saveEvidence('w12b2-failed-provision-report.json', {
      reply,
      project,
      events
    })
  }, 60_000)

  it('对照：stored credential 重启路径——client 即刻在，attach 同步装机（不回退）', async () => {
    const restarted = startCloudRuntimeAdmission(
      {
        ORCA_CLOUD_API_URL: platform.url,
        // 已花费的令牌：只有首启持久化的凭证能让这条路走通。
        ORCA_CLOUD_HOST_TOKEN: 'spent-token-should-not-be-used',
        ORCA_CLOUD_HOST_NAME: HOST_NAME
      },
      { userDataPath: hostDataDir }
    )
    expect(restarted).not.toBeNull()
    expect(restarted?.client).not.toBeNull()

    const target = recordingTarget()
    attachRuntimeToCloudAdmission(target, restarted)
    expect(target.installed).toEqual(['guard', 'provision-reporter', 'audit-sink'])
    await restarted?.ready
    restarted?.stop()
  }, 30_000)
})
