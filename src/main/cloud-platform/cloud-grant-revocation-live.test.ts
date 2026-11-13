import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readArray, readField, readString } from '../../shared/json-fields'
import { generateKeyPair } from '../../shared/e2ee-crypto'
import {
  REPO_ROOT,
  connectCloudSession,
  makeSelfSignedTls,
  openPlatformSession,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'

/**
 * M88 (AC-12): taking a group's grant away must reach a session that is already
 * open. The host learns revocations on its own heartbeat timer, so this test
 * never refreshes by hand — it waits, as production would, and measures how long
 * the close takes against the 60-second budget.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm88-grant-revocation-live')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let adminToken = ''
let projectId = ''
let projectKey = ''

type Live = { token: string; deviceId: string; ws: WebSocket; close: Promise<{ code: number }> }

async function loginAdmin(): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm88-admin' })
  })
  return readString(await res.json(), 'accessToken') ?? ''
}

async function setTeamGrant(permissions: string[]): Promise<void> {
  const res = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions })
  })
  expect(res.status, await res.clone().text()).toBe(200)
}

/** Opens a session with the current grants and keeps its close promise. */
async function openLive(): Promise<Live> {
  const session = await openPlatformSession(platform, { projectKey })
  const connection = await connectCloudSession(
    cloud.endpoint,
    cloud.serverPublicKeyB64,
    session,
    5000,
    { tlsRejectUnauthorized: false }
  )
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got ${JSON.stringify(connection.close)}`)
  }
  return {
    token: session.accessToken,
    deviceId: session.deviceId,
    ws: connection.ws,
    close: connection.close
  }
}

async function visibleProjects(token: string): Promise<string[]> {
  const res = await fetch(`${platform.url}/v1/projects`, {
    headers: { authorization: `Bearer ${token}` }
  })
  const projects = readArray(await res.json(), 'projects') ?? []
  return projects.map((project) => readString(project, 'key') ?? '')
}

async function connectStatus(
  token: string,
  deviceId: string,
  devicePubKey: string
): Promise<number> {
  const res = await fetch(`${platform.url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId, devicePubKey, clientVersion: '1.5.0' })
  })
  return res.status
}

beforeAll(async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m88-')))
  platform = await startPlatform()
  adminToken = await loginAdmin()
  expect(adminToken).not.toBe('')

  const tokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await tokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }

  // Enrolled host: revocations arrive on its heartbeat, the production path.
  const started = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-m88'
    },
    { userDataPath: join(dir, 'host-data') }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m88-',
    tls: makeSelfSignedTls('dev-m88')
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const projectRoot = join(dir, 'payment-service')
  mkdirSync(projectRoot, { recursive: true })
  const created = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm88-grant-live',
      name: 'm88-grant-live',
      hostId: admission.host()!.hostId,
      path: projectRoot
    })
  })
  expect(created.status, await created.clone().text()).toBe(201)
  projectId = readString(await created.json(), 'id') ?? ''
  projectKey = 'm88-grant-live'
  await setTeamGrant(['open', 'terminal', 'agent', 'file:read', 'file:write'])
}, 180_000)

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
})

describe('AC-12 授权收回：已建立连接在 60 秒内断连，重开 404，恢复后立即可用（真实平台 + 真实 Runtime）', () => {
  it('M88-1 收回 team-payment 授权后，存活会话被 4403 关闭', async () => {
    const live = await openLive()
    expect(live.ws.readyState).toBe(WebSocket.OPEN)
    const before = await visibleProjects(live.token)
    expect(before).toContain(projectKey)

    // Why no manual refresh: the close must come from the host's own heartbeat.
    const revokedAt = Date.now()
    await setTeamGrant([])
    const closed = await Promise.race([
      live.close,
      new Promise<{ code: number }>((resolve) => setTimeout(() => resolve({ code: -1 }), 60_000))
    ])
    const elapsedMs = Date.now() - revokedAt
    expect(closed.code, `closed after ${elapsedMs}ms`).toBe(4403)
    expect(elapsedMs).toBeLessThanOrEqual(60_000)
    expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(live.ws.readyState)

    saveEvidence('grant-revocation-live.json', {
      projectKey,
      closeCode: closed.code,
      elapsedMs,
      budgetMs: 60_000,
      refreshedManually: false
    })
  }, 120_000)

  it('M88-2 收回后重新登录看不到项目、取票 404；恢复授权立即可见可开', async () => {
    // Self-contained: the previous case may have left the grant in place.
    await setTeamGrant([])
    const session = await openPlatformSessionLater()
    expect(session.projects).not.toContain(projectKey)

    const status = await connectStatus(session.token, session.deviceId, session.devicePubKey)
    expect(status).toBe(404)

    // Restore: permissions are read live, so no wait and no refresh is needed.
    const restoredAt = Date.now()
    await setTeamGrant(['open', 'terminal', 'agent', 'file:read', 'file:write'])
    const after = await visibleProjects(session.token)
    expect(after).toContain(projectKey)
    const restoredStatus = await connectStatus(
      session.token,
      session.deviceId,
      session.devicePubKey
    )
    expect(restoredStatus).toBe(200)

    const reopened = await openPlatformSession(platform, { projectKey })
    const connection = await connectCloudSession(
      cloud.endpoint,
      cloud.serverPublicKeyB64,
      reopened,
      5000,
      { tlsRejectUnauthorized: false }
    )
    expect(connection.status).toBe('authenticated')
    if (connection.status === 'authenticated') {
      connection.ws.close()
    }

    saveEvidence('grant-restore.json', {
      visibleWhileRevoked: false,
      connectWhileRevoked: status,
      restoredInMs: Date.now() - restoredAt,
      connectAfterRestore: restoredStatus,
      reopened: connection.status
    })
  }, 120_000)
})

/** Logs in without requiring project access, so the revoked view can be observed. */
async function openPlatformSessionLater(): Promise<{
  token: string
  deviceId: string
  devicePubKey: string
  projects: string[]
}> {
  const deviceKeys = generateKeyPair()
  const devicePubKey = Buffer.from(deviceKeys.publicKey).toString('base64')
  const login = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey,
      deviceName: 'm88-revoked-view'
    })
  })
  const body: unknown = await login.json()
  const token = readString(body, 'accessToken')
  const deviceId = readString(readField(body, 'device'), 'id')
  if (token === null || deviceId === null) {
    throw new Error('login response malformed')
  }
  return { token, deviceId, devicePubKey, projects: await visibleProjects(token) }
}
