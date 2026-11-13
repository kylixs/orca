import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
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
 * M96 (AC-12): revoking one developer's access must not disconnect the rest of
 * the project. The platform used to append a *project-wide* revocation for every
 * grant edit, so removing one user's grant closed every live session on that
 * project — including people whose permissions never changed.
 *
 * Real platform, real enrolled host (heartbeat is the revocation channel), real
 * TLS runtime, real end-to-end encryption.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm96-grant-revocation-scope')
const PROJECT_KEY = 'm96-scope'
const CLOSE_BUDGET_MS = 60_000

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let adminToken = ''
let projectId = ''
let lisiId = ''

type Live = { ws: WebSocket; close: Promise<{ code: number }> }

async function loginAdmin(): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm96-admin' })
  })
  return readString(await res.json(), 'accessToken') ?? ''
}

async function putGrant(
  subjectType: 'group' | 'user',
  subjectId: string,
  permissions: string[]
): Promise<void> {
  const res = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType, subjectId, permissions })
  })
  expect(res.status, await res.clone().text()).toBe(200)
}

async function openLive(username: string): Promise<Live> {
  const deviceName = `m96-${username}`
  const session = await openPlatformSession(platform, {
    username,
    deviceName,
    projectKey: PROJECT_KEY
  })
  const connection = await connectCloudSession(
    cloud.endpoint,
    cloud.serverPublicKeyB64,
    session,
    5000,
    { tlsRejectUnauthorized: false }
  )
  if (connection.status !== 'authenticated') {
    throw new Error(`${username} was not admitted: ${JSON.stringify(connection.close)}`)
  }
  return { ws: connection.ws, close: connection.close }
}

function closedWithin(live: Live, ms: number): Promise<{ code: number; elapsedMs: number }> {
  const started = Date.now()
  return Promise.race([
    live.close.then((info) => ({ code: info.code, elapsedMs: Date.now() - started })),
    new Promise<{ code: number; elapsedMs: number }>((resolve) =>
      setTimeout(() => resolve({ code: -1, elapsedMs: ms }), ms)
    )
  ])
}

beforeAll(async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m96-')))
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

  const started = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-m96',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
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
    userDataPrefix: 'orca-m96-',
    tls: makeSelfSignedTls('dev-m96')
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const projectRoot = join(dir, 'shared-service')
  mkdirSync(projectRoot, { recursive: true })
  const created = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId: admission.host()!.hostId,
      path: projectRoot
    })
  })
  expect(created.status, await created.clone().text()).toBe(201)
  projectId = readString(await created.json(), 'id') ?? ''
  await putGrant('group', 'team-payment', ['open', 'terminal', 'file:read'])

  // The user-scoped grant needs the id, not the username (the login reply has it).
  const lisiLogin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'lisi',
      password: 'Passw0rd!',
      deviceName: 'm96-lisi-probe',
      devicePubKey: Buffer.from('m96-lisi-probe').toString('base64')
    })
  })
  const lisiBody: unknown = await lisiLogin.json()
  lisiId =
    readString(readField(lisiBody, 'user'), 'id') ??
    readString(readField(lisiBody, 'device'), 'id') ??
    ''
  expect(lisiId).not.toBe('')
}, 180_000)

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
})

describe('AC-12 收回单个用户授权只断开该用户（真实平台 + 真实心跳 + 真实 Runtime）', () => {
  it('M96-1 移除 lisi 的个人授权后 lisi 被 4403 关闭，zhangsan 的会话不受影响', async () => {
    await putGrant('user', lisiId, ['open', 'file:read'])

    const lisi = await openLive('lisi')
    const zhangsan = await openLive('zhangsan')
    expect(lisi.ws.readyState).toBe(WebSocket.OPEN)
    expect(zhangsan.ws.readyState).toBe(WebSocket.OPEN)

    // ---- remove only lisi's grant ----
    await putGrant('user', lisiId, [])
    const closed = await closedWithin(lisi, CLOSE_BUDGET_MS)
    expect(closed.code, `lisi closed after ${closed.elapsedMs}ms`).toBe(4403)
    expect(closed.elapsedMs).toBeLessThanOrEqual(CLOSE_BUDGET_MS)

    // ---- zhangsan's team grant never changed: the session must survive ----
    await new Promise((resolve) => setTimeout(resolve, closed.elapsedMs + 3_000))
    expect(zhangsan.ws.readyState).toBe(WebSocket.OPEN)

    saveEvidence('grant-revocation-scope.json', {
      lisiClose: closed,
      zhangsanStillOpen: true,
      budgetMs: CLOSE_BUDGET_MS
    })
    zhangsan.ws.close()
  }, 180_000)
})
