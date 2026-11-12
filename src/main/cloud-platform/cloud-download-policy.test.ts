import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readArray, readField, readNumber, readString } from '../../shared/json-fields'
import {
  DEFAULT_INTERNAL_TOKEN,
  REPO_ROOT,
  connectCloudSession,
  openPlatformSession,
  startCloudRuntime,
  startPlatform,
  type CloudConnection,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import { createCloudAgentClient } from './cloud-agent-client'
import { installCloudAccessGuard } from '../startup/cloud-runtime-admission'
import type { DeviceRegistry } from '../runtime/device-registry'

/**
 * Design §9 / AC-10 / AC-17: the host refuses dedicated export RPCs unless the
 * platform's policy pack allows download, and accounts file reads against a
 * rolling-hour budget. Both are enforced where the RPC lands — a managed client
 * hiding the download button is convenience, not a control.
 *
 * Real platform process, real Ed25519 tickets, real Runtime, real encrypted RPCs.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm35-download-policy')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

async function adminLogin(platform: Platform): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'policy-admin' })
  })
  const token = readString(await res.json(), 'accessToken')
  if (token === null) {
    throw new Error('admin login failed')
  }
  return token
}

async function setGlobalPolicy(
  platform: Platform,
  token: string,
  body: Record<string, unknown>
): Promise<void> {
  const res = await fetch(`${platform.url}/v1/policies/download`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  expect(res.status, await res.clone().text()).toBe(200)
}

async function setProjectPolicy(
  platform: Platform,
  token: string,
  projectId: string,
  body: Record<string, unknown>
): Promise<Response> {
  return await fetch(`${platform.url}/v1/projects/${projectId}/policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
}

let platform: Platform
let adminToken = ''
let cloud: CloudRuntime
let client: ReturnType<typeof createCloudAgentClient>
let registry: DeviceRegistry | null = null
let projectId = ''

beforeAll(async () => {
  platform = await startPlatform()
  adminToken = await adminLogin(platform)
  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'policy-project',
      name: 'policy-project',
      hostId: 'host_dev001',
      path: '/srv/work/policy-project'
    })
  })
  expect(create.status).toBe(201)
  projectId = readString(await create.json(), 'id') ?? ''
  const grant = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'file:read', 'download']
    })
  })
  expect(grant.status).toBe(200)

  client = createCloudAgentClient({
    apiUrl: platform.url,
    internalToken: DEFAULT_INTERNAL_TOKEN,
    hostId: 'host_dev001',
    hostName: 'dev-001'
  })
  await client.refresh()
  cloud = await startCloudRuntime({
    admission: (headers) => {
      const decision = client.admit(headers)
      if (decision.ok) {
        registry?.adoptCloudDevice({
          deviceId: decision.payload.deviceId,
          token: decision.payload.deviceToken,
          name: decision.payload.sub,
          publicKeyB64: decision.payload.devicePubKey,
          project: decision.payload.project,
          permissions: decision.payload.perms
        })
      }
      return decision
    },
    connectionGate: client.connectionGate,
    userDataPrefix: 'orca-cloud-policy-'
  })
  registry = cloud.runtime.getDeviceRegistry()
  installCloudAccessGuard(cloud.runtime, client)
})

afterAll(async () => {
  client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
})

async function connect(): Promise<Extract<CloudConnection, { status: 'authenticated' }>> {
  const session = await openPlatformSession(platform, {
    projectKey: 'policy-project',
    deviceName: `policy-${Math.random().toString(16).slice(2, 8)}`
  })
  const connection = await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, session)
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got close ${connection.close.code}`)
  }
  return connection
}

describe('下载策略由平台下发、主机执行（真实平台 + 真实 Runtime）', () => {
  it('M35-1 默认为拒绝：票据有 download 权限也调不通导出 RPC；管理员放开后可用，再按项目收回', async () => {
    const session = await connect()
    try {
      // The ticket grants download; the platform's default policy still closes it.
      const denied = await session.rpc('browser.download', { selector: 'a' })
      expect(denied.ok).toBe(false)
      if (!denied.ok) {
        expect(denied.code).toBe('forbidden')
        expect(denied.message).toContain('disabled for this project by platform policy')
      }

      await setGlobalPolicy(platform, adminToken, { downloadDefault: 'allow' })
      await client.refresh()
      const allowed = await session.rpc('browser.download', { selector: 'a' })
      expect(allowed.ok).toBe(false)
      if (!allowed.ok) {
        // The gate opened; what fails now is the handler (no such browser session).
        expect(allowed.message).not.toContain('platform policy')
      }

      const override = await setProjectPolicy(platform, adminToken, projectId, {
        downloadPolicy: 'deny'
      })
      expect(override.status).toBe(200)
      await client.refresh()
      const reDenied = await session.rpc('browser.download', { selector: 'a' })
      expect(reDenied.ok).toBe(false)
      if (!reDenied.ok) {
        expect(reDenied.message).toContain('platform policy')
      }

      // AC-17: the change is audited, and the audit chain still verifies.
      const events = await fetch(
        `${platform.url}/v1/audit/events?eventType=policy_update&limit=20`,
        { headers: { authorization: `Bearer ${adminToken}` } }
      )
      const eventsBody: unknown = await events.json()
      const log = readArray(eventsBody, 'events') ?? []
      expect(log.length).toBeGreaterThanOrEqual(2)
      expect(log.some((event) => readString(event, 'eventType') === 'policy_update')).toBe(true)
      const verify = await fetch(`${platform.url}/v1/audit/verify`, {
        headers: { authorization: `Bearer ${adminToken}` }
      })
      expect(verify.status).toBe(200)

      saveEvidence('m35-1-download-policy.json', { denied, allowed, reDenied })
    } finally {
      session.ws.close()
    }
  }, 40000)

  it('M35-2 读取按滚动小时记账：超出次数后拒绝 read_budget_exceeded，放宽策略后恢复', async () => {
    const tight = await setProjectPolicy(platform, adminToken, projectId, {
      downloadPolicy: 'deny',
      readRatePerHour: { calls: 3, bytes: 1024 * 1024 }
    })
    expect(tight.status).toBe(200)
    await client.refresh()

    const session = await connect()
    try {
      const outcomes: string[] = []
      for (let index = 0; index < 3; index += 1) {
        const read = await session.rpc('files.read', {
          worktree: 'policy-project',
          relativePath: `file-${index}.txt`
        })
        expect(read.ok).toBe(false)
        if (!read.ok) {
          // The handler answers (unknown worktree); the budget did not refuse.
          expect(read.code).not.toBe('read_budget_exceeded')
          outcomes.push(read.code)
        }
      }

      const over = await session.rpc('files.read', {
        worktree: 'policy-project',
        relativePath: 'file-over.txt'
      })
      expect(over.ok).toBe(false)
      if (!over.ok) {
        expect(over.code).toBe('read_budget_exceeded')
        expect(over.message).toContain('3/3')
      }

      // Raising the budget takes effect without reconnecting.
      const relaxed = await setProjectPolicy(platform, adminToken, projectId, {
        downloadPolicy: 'deny',
        readRatePerHour: { calls: 50, bytes: 1024 * 1024 }
      })
      expect(relaxed.status).toBe(200)
      await client.refresh()
      const after = await session.rpc('files.read', {
        worktree: 'policy-project',
        relativePath: 'file-after.txt'
      })
      expect(after.ok).toBe(false)
      if (!after.ok) {
        expect(after.code).not.toBe('read_budget_exceeded')
      }

      saveEvidence('m35-2-read-budget.json', { outcomes, over, after })
    } finally {
      session.ws.close()
    }
  }, 40000)

  it('M35-3 非法限速在平台侧被拒，不会把主机配额改成无限或锁死', async () => {
    const bad = await setProjectPolicy(platform, adminToken, projectId, {
      downloadPolicy: 'deny',
      readRatePerHour: { calls: 0, bytes: 10 }
    })
    expect(bad.status).toBe(400)
    const badBody: unknown = await bad.json()
    expect(readString(readField(badBody, 'error'), 'code')).toBe('POLICY_INVALID')

    // Clearing an override returns the project to the global budget.
    const cleared = await setProjectPolicy(platform, adminToken, projectId, {
      downloadPolicy: 'deny',
      readRatePerHour: null
    })
    expect(cleared.status).toBe(200)
    const policy = await fetch(`${platform.url}/v1/projects/${projectId}/policy`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })
    const view: unknown = await policy.json()
    expect(readNumber(readField(view, 'readRatePerHour'), 'calls')).toBeGreaterThan(0)
    saveEvidence('m35-3-policy-validation.json', { bad: badBody, cleared: view })
  }, 30000)
})
