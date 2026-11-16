import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { headerText } from '../../shared/http-header-text'
import {
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
import { CloudConnectClient } from './cloud-connect-client'

/**
 * AC-14 on the real stack: a registered host learns of its own revocation over
 * the heartbeat and closes every live cloud session within 60 seconds, while the
 * platform refuses new tickets.
 * Runner: node (vitest-node-runtime-files.mjs) — bun's ws cannot complete the
 * throwaway-certificate TLS handshake (U93).
 */

const EVIDENCE_DIR = new URL(
  '../../../cloud-platform/evidence/m71-host-revocation/',
  import.meta.url
).pathname
const HEARTBEAT_INTERVAL_MS = 10_000
const REVOCATION_DEADLINE_MS = 60_000

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let adminToken = ''
let hostId = ''
let projectId = ''

async function adminLogin(): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm71-admin' })
  })
  const body: unknown = await res.json()
  if (!res.ok || typeof body !== 'object' || body === null || !('accessToken' in body)) {
    throw new Error('admin login failed')
  }
  return String(body.accessToken)
}

async function mintHostToken(): Promise<string> {
  const res = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const body: unknown = await res.json()
  if (!res.ok || typeof body !== 'object' || body === null || !('token' in body)) {
    throw new Error('host token missing')
  }
  return String(body.token)
}

async function createProjectForHost(): Promise<string> {
  const created = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm71-revocable-svc',
      name: 'm71-revocable-svc',
      hostId,
      path: '/srv/work/m71-revocable-svc'
    })
  })
  const createdBody: unknown = await created.json()
  if (!created.ok || typeof createdBody !== 'object' || createdBody === null) {
    throw new Error('project create failed')
  }
  const id = 'id' in createdBody ? String(createdBody.id) : ''
  const grant = await fetch(`${platform.url}/v1/projects/${id}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  if (!grant.ok) {
    throw new Error(`grant failed: ${grant.status}`)
  }
  return id
}

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

/** Pre-handshake refusal: the host answers HTTP 401 with an x-orca-reject reason. */
function attemptUpgrade(
  credential: string,
  devicePubKey: string
): Promise<{ status?: number; reject?: string; opened?: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(cloud.endpoint, ['orca-runtime', `orca-cred.${credential}`], {
      headers: { 'x-orca-device-pubkey': devicePubKey },
      rejectUnauthorized: false,
      handshakeTimeout: 5000
    })
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode, reject: headerText(res.headers['x-orca-reject']) })
      ws.terminate()
    })
    ws.once('open', () => {
      resolve({ opened: true })
      ws.close()
    })
    ws.once('error', () => resolve({}))
  })
}

function readProjectRows(value: unknown): { id: string; hostStatus: string }[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('id' in entry) ||
      !('hostStatus' in entry)
    ) {
      return []
    }
    return [{ id: String(entry.id), hostStatus: String(entry.hostStatus) }]
  })
}

beforeAll(async () => {
  platform = await startPlatform()
  adminToken = await adminLogin()
  const started = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: await mintHostToken(),
      ORCA_CLOUD_HOST_NAME: 'm71-revocable',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-m71-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready
  const enrolled = admission.host()
  if (!enrolled) {
    throw new Error('host enrolment missing')
  }
  hostId = enrolled.hostId
  projectId = await createProjectForHost()
  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    tls: makeSelfSignedTls('m71-revocable'),
    userDataPrefix: 'orca-cloud-m71-runtime-'
  })
  admission.bindRuntime(cloud.runtime)
})

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
})

describe('主机吊销：心跳通知主机并关闭已建云会话（真实平台 + TLS Runtime）', () => {
  it('吊销后已建连接在 60 秒内被主机以 4403 关闭，新连接返回 HOST_REVOKED', async () => {
    const session = await openPlatformSession(platform, { projectKey: 'm71-revocable-svc' })
    const connection = await connectCloudSession(
      cloud.endpoint,
      cloud.serverPublicKeyB64,
      session,
      5000,
      { tlsRejectUnauthorized: false }
    )
    if (connection.status !== 'authenticated') {
      throw new Error(`expected an authenticated session, got ${connection.close.code}`)
    }

    const revokedAt = Date.now()
    const revoke = await fetch(`${platform.url}/v1/hosts/${hostId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminToken}` }
    })
    expect(revoke.status).toBe(200)

    // Wait for the host's own heartbeat timer (10s), not a manual refresh.
    const closed = await Promise.race([
      connection.close,
      new Promise<{ code: number; reason: string }>((resolve) =>
        setTimeout(() => resolve({ code: -1, reason: 'timeout' }), REVOCATION_DEADLINE_MS - 5_000)
      )
    ])
    const elapsedMs = Date.now() - revokedAt
    expect(closed.code).toBe(4403)
    expect(elapsedMs).toBeLessThan(REVOCATION_DEADLINE_MS)

    const client = admission.client
    if (!client) {
      throw new Error('cloud client missing')
    }
    expect(client.isHostRevoked()).toBe(true)
    expect(client.snapshot().hostRevoked).toBe(true)

    const list = await fetch(`${platform.url}/v1/projects`, {
      headers: { authorization: `Bearer ${session.accessToken}` }
    })
    const listBody: unknown = await list.json()
    const projects =
      typeof listBody === 'object' && listBody !== null && 'projects' in listBody
        ? readProjectRows(listBody.projects)
        : []
    expect(projects.find((entry) => entry.id === projectId)?.hostStatus).toBe('offline')

    const desktop = new CloudConnectClient({
      apiUrl: platform.url,
      tlsRejectUnauthorized: false
    })
    await desktop.login('zhangsan', 'Passw0rd!')
    await expect(desktop.prepareProjectLink(projectId)).rejects.toMatchObject({
      code: 'HOST_REVOKED'
    })

    // The host itself refuses even a still-signed ticket, pre-handshake.
    const upgrade = await attemptUpgrade(session.credential, session.devicePubKey)
    expect(upgrade).toMatchObject({ status: 401, reject: 'host_revoked' })

    saveEvidence('m71-revocation.json', {
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      revocationDeadlineMs: REVOCATION_DEADLINE_MS,
      establishedSession: {
        closeCode: closed.code,
        closeReason: closed.reason,
        elapsedMs
      },
      hostSnapshot: {
        hostRevoked: client.snapshot().hostRevoked,
        lastError: client.snapshot().lastError
      },
      projectHostStatusAfterRevoke: projects.find((entry) => entry.id === projectId)?.hostStatus,
      newConnectionErrorCode: 'HOST_REVOKED',
      hostUpgradeReject: { status: upgrade.status ?? null, reason: upgrade.reject ?? null }
    })
  }, 90_000)
})
