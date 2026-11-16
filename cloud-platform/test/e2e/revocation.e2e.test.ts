import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { CloudClient } from '../../apps/client/src/cloud-client.ts'
import {
  login,
  makeTlsCerts,
  makeTempWorkspace,
  registerHost,
  saveEvidence,
  spawnService,
  type Service
} from './harness.ts'

const EVIDENCE = 'm11-revocation'

let api: Service
let runtime: Service
let workspace: { root: string; projectRoot: string }

before(async () => {
  workspace = makeTempWorkspace()
  const tls = makeTlsCerts()
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-revocation'
  )
  runtime = await spawnService(
    'apps/runtime/src/runtime-sim.ts',
    {
      PORT: '0',
      API_URL: api.url,
      HOST_ID: 'host_dev001',
      HOST_NAME: 'dev-001',
      SANDBOX_ROOT: workspace.root,
      TLS_KEY: tls.key,
      TLS_CERT: tls.cert
    },
    /\[runtime-sim\] dev-001 listening on :(\d+)/,
    'runtime-revocation'
  )
  const loginRes = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'revocation-admin' })
  })
  const { accessToken } = (await loginRes.json()) as { accessToken: string }
  await registerHost({
    apiUrl: api.url,
    adminToken: accessToken,
    name: 'dev-001',
    directAddr: `127.0.0.1:${runtime.port}`,
    relayTarget: `127.0.0.1:${runtime.port}`
  })
})

after(async () => {
  await runtime?.stop()
  await api?.stop()
})

function closedWithin(client: CloudClient, timeoutMs: number): Promise<{ code: number; reason: string } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    client.onClose((code, reason) => {
      clearTimeout(timer)
      resolve({ code, reason })
    })
  })
}

test('M11 设备吊销后已建立连接在 60 秒内被关闭（4403）', { timeout: 30000 }, async () => {
  const client = new CloudClient(api.url)
  await client.login('zhangsan', 'Passw0rd!')
  const projects = await client.listProjects()
  const opened = await client.openProject(projects[0].id)
  assert.equal(opened.route, 'direct')

  const before = await client.rpc('sessions.whoami')
  assert.equal(before.ok, true)

  const closed = closedWithin(client, 10_000)
  await client.revokeCurrentDevice()

  // Admission only runs at upgrade; without an established-session recheck the
  // socket would stay open forever (review-06 N2, AC-25).
  const closeInfo = await closed
  assert.ok(closeInfo, 'the revoked session must be closed by the host')
  assert.equal(closeInfo.code, 4403, 'revocation close code')
  assert.match(closeInfo.reason, /device_revoked/)

  // The socket is closed; sending on it either throws or never answers.
  const after = await client.rpc('sessions.whoami').catch(() => null)
  assert.ok(after === null || after.ok === false, 'revoked session must not serve RPCs')

  saveEvidence(EVIDENCE, 'device-revoke-closes-session.json', {
    openedRoute: opened.route,
    before,
    closeInfo,
    after
  })
  client.close()
})

/**
 * U65 §3.3 / AC-38 host-side half: a user ticket minted before a host-grant
 * shrink must be refused at its first host use, not merely by the platform.
 * The host learns it from the next revocation poll (`host_grant_changed` ->
 * user revocation -> `user_revoked`).
 */
test(
  '主机授权收缩后旧 ticket 首次使用被宿主拒绝（401 user_revoked）',
  { timeout: 30000 },
  async () => {
    const adminToken = await login(api.url, 'admin', 'Adm1n!')
    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projectId = (await client.listProjects())[0].id

    // Full host grant first: view+provision widens the ticket beyond the project bits.
    const granted = await fetch(`${api.url}/v1/hosts/host_dev001/grants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        subjectType: 'user',
        subjectId: 'zhangsan',
        permissions: ['view', 'provision']
      })
    })
    assert.equal(granted.status, 200, await granted.text())

    // Two tickets exist before the shrink: one proves the pre-shrink behaviour,
    // the other is deliberately held back for its first use after the shrink.
    const preShrinkControl = await client.requestConnect(projectId)
    const ticket = await client.requestConnect(projectId)
    const beforeShrink = await attempt(preShrinkControl.credential)
    assert.equal(beforeShrink.opened, true, JSON.stringify(beforeShrink))

    const revocationsBefore = await fetch(`${api.url}/v1/internal/revocations`, {
      headers: { 'x-internal-token': 'internal-test-token' }
    })
    assert.equal(
      readUserRevocations(await revocationsBefore.json()).some((entry) => entry.id === 'zhangsan'),
      false,
      'no user revocation exists before the shrink'
    )

    const shrunk = await fetch(`${api.url}/v1/hosts/host_dev001/grants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ subjectType: 'user', subjectId: 'zhangsan', permissions: ['view'] })
    })
    assert.equal(shrunk.status, 200, await shrunk.text())

    // The platform writes a user-scoped revocation: tickets carry `sub: user:<username>`.
    const revocationsRes = await fetch(`${api.url}/v1/internal/revocations`, {
      headers: { 'x-internal-token': 'internal-test-token' }
    })
    assert.equal(revocationsRes.status, 200)
    const userRevocation = readUserRevocations(await revocationsRes.json()).find(
      (entry) => entry.id === 'zhangsan'
    )
    assert.ok(userRevocation, 'the host-grant shrink must leave a user revocation')

    // The host polls revocations every second; give it one full window.
    await new Promise((resolve) => setTimeout(resolve, 1600))

    const staleTicket = await attempt(ticket.credential)
    assert.equal(staleTicket.status, 401, JSON.stringify(staleTicket))
    assert.equal(staleTicket.reject, 'user_revoked')

    // A ticket minted after the revocation is still admitted (shrunk, not dead).
    const freshTicket = await client.requestConnect(projectId)
    const freshUse = await attempt(freshTicket.credential)
    assert.equal(freshUse.opened, true, JSON.stringify(freshUse))

    saveEvidence(EVIDENCE, 'host-grant-revoke-rejects-stale-ticket.json', {
      hostId: 'host_dev001',
      projectId,
      beforeShrink,
      userRevocation,
      staleTicket,
      freshUse
    })
    client.close()
  }
)

/** Presents a ticket directly at the host, bypassing the client's route selection. */
function attempt(
  credential: string
): Promise<{ status?: number; reject?: string; opened?: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `wss://127.0.0.1:${runtime.port}/`,
      ['orca-runtime', `orca-cred.${credential}`],
      {
        rejectUnauthorized: false,
        headers: { 'x-orca-device-pubkey': devicePubKeyOf(credential) }
      }
    )
    ws.once('unexpected-response', (_req, res) => {
      const reject = res.headers['x-orca-reject']
      resolve({
        status: res.statusCode,
        reject: Array.isArray(reject) ? reject[0] : reject
      })
      ws.terminate()
    })
    ws.once('open', () => {
      resolve({ opened: true })
      ws.close()
    })
    ws.once('error', () => resolve({}))
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readUserRevocations(value: unknown): { id: string; since: number }[] {
  if (!isRecord(value) || !Array.isArray(value.users)) {
    return []
  }
  return value.users.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === 'string' && typeof entry.since === 'number'
      ? [{ id: entry.id, since: entry.since }]
      : []
  )
}

/** The ticket is signed but not encrypted; reading the device key out is fine in-test. */
function devicePubKeyOf(credential: string): string {
  const claims: unknown = JSON.parse(Buffer.from(credential.split('.')[1], 'base64url').toString())
  return isRecord(claims) && typeof claims.devicePubKey === 'string' ? claims.devicePubKey : ''
}

