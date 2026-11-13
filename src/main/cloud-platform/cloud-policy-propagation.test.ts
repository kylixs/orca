import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
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

/**
 * M79 (G-13 / AC-17): a policy change must reach the host through its own poll
 * loop inside 30 seconds — no operator-triggered refresh, no reconnect. The
 * earlier M35 case called `client.refresh()` directly, which proved the gate but
 * not the delivery path the product actually ships.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm79-policy-propagation')
const ACK_WINDOW_MS = 30_000
const POLL_INTERVAL_MS = 10_000

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

let platform: Platform
let adminToken = ''
let cloud: CloudRuntime
let client: ReturnType<typeof createCloudAgentClient>
let projectId = ''

async function adminLogin(): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm79-admin' })
  })
  const token = readString(await res.json(), 'accessToken')
  if (token === null) {
    throw new Error('admin login failed')
  }
  return token
}

async function putProjectPolicy(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${platform.url}/v1/projects/${projectId}/policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(body)
  })
  expect(res.status, await res.clone().text()).toBe(200)
}

beforeAll(async () => {
  platform = await startPlatform()
  adminToken = await adminLogin()
  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm79-policy-project',
      name: 'm79-policy-project',
      hostId: 'host_dev001',
      path: '/srv/work/m79-policy-project'
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
      permissions: ['open', 'file:read', 'download']
    })
  })
  expect(grant.status).toBe(200)

  let registry: ReturnType<CloudRuntime['runtime']['getDeviceRegistry']> = null
  client = createCloudAgentClient({
    apiUrl: platform.url,
    internalToken: DEFAULT_INTERNAL_TOKEN,
    hostId: 'host_dev001',
    hostName: 'dev-001',
    refreshMs: POLL_INTERVAL_MS
  })
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
          permissions: decision.payload.perms,
          projectRoot: decision.payload.projectRoot,
          workspaceRoot: decision.payload.workspaceRoot
        })
      }
      return decision
    },
    connectionGate: client.connectionGate,
    userDataPrefix: 'orca-m79-policy-'
  })
  registry = cloud.runtime.getDeviceRegistry()
  installCloudAccessGuard(cloud.runtime, client)
  // Why start: only the timer is under test; nothing in this file calls refresh().
  client.start()
}, 120_000)

afterAll(async () => {
  client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
})

async function openSession(): Promise<Extract<CloudConnection, { status: 'authenticated' }>> {
  const session = await openPlatformSession(platform, {
    projectKey: 'm79-policy-project',
    deviceName: `m79-${Math.random().toString(16).slice(2, 8)}`
  })
  const connection = await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, session)
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got close ${connection.close.code}`)
  }
  return connection
}

type Probe = { allowed: boolean; message: string }

async function probeDownload(
  session: Extract<CloudConnection, { status: 'authenticated' }>
): Promise<Probe> {
  const reply = await session.rpc('browser.download', { selector: 'a' })
  const message = reply.ok ? '' : reply.message
  return { allowed: !message.includes('platform policy'), message }
}

/** Polls the live session until the gate flips, or the AC's 30s window runs out. */
async function waitForGate(
  session: Extract<CloudConnection, { status: 'authenticated' }>,
  expected: 'open' | 'closed'
): Promise<{ elapsedMs: number; probe: Probe }> {
  const started = Date.now()
  let last: Probe = { allowed: false, message: 'never probed' }
  while (Date.now() - started < ACK_WINDOW_MS) {
    last = await probeDownload(session)
    if ((expected === 'open') === last.allowed) {
      return { elapsedMs: Date.now() - started, probe: last }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `gate did not ${expected} within ${ACK_WINDOW_MS}ms; last message: ${last.message}`
  )
}

describe('策略变更经主机轮询在 30 秒内生效（真实平台 + 真实 Runtime + 真实 WSS）', () => {
  it('M79-1 管理员放开与收回下载策略，均在 30 秒内到达同一会话，无需手动刷新或重连', async () => {
    const session = await openSession()
    try {
      const initial = await probeDownload(session)
      expect(initial.allowed).toBe(false)

      await putProjectPolicy({ downloadPolicy: 'allow' })
      const opened = await waitForGate(session, 'open')
      expect(opened.elapsedMs).toBeLessThan(ACK_WINDOW_MS)

      await putProjectPolicy({ downloadPolicy: 'deny' })
      const closed = await waitForGate(session, 'closed')
      expect(closed.elapsedMs).toBeLessThan(ACK_WINDOW_MS)

      // The same socket served all three states: nothing reconnected.
      const stillAlive = await session.rpc('status.get')
      expect(stillAlive.ok).toBe(true)

      const audit = await fetch(
        `${platform.url}/v1/audit/events?eventType=policy_update&limit=20`,
        {
          headers: { authorization: `Bearer ${adminToken}` }
        }
      )
      expect(audit.status).toBe(200)

      saveEvidence('m79-policy-propagation.json', {
        pollIntervalMs: POLL_INTERVAL_MS,
        ackWindowMs: ACK_WINDOW_MS,
        initial,
        openedAtMs: opened.elapsedMs,
        closedAtMs: closed.elapsedMs,
        socketReused: stillAlive.ok
      })
    } finally {
      session.ws.close()
    }
  }, 90_000)
})
