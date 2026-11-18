import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import WebSocket from 'ws'
import { CloudClient } from '../../apps/client/src/cloud-client.ts'
import {
  makeTlsCerts,
  makeTempWorkspace,
  registerHost,
  saveEvidence,
  spawnService,
  type Service
} from './harness.ts'

const EVIDENCE = 'm16-control-plane-isolation'

/**
 * Review-07 F1/F2. The three control-plane reads must land independently, and a
 * structurally invalid revocation body must never read as "nothing revoked".
 *
 * Topology: real platform for JWKS + tickets, a stand-in for only
 * /v1/internal/policy and /v1/internal/revocations — that is exactly the split
 * the bug lived in (one endpoint hanging while the others stayed healthy).
 */

type Revocations = {
  projects: unknown[]
  users: unknown[]
  devices: { id: string; since: number }[]
  jtis: string[]
}

type Fake = {
  url: string
  hangPolicy: (hang: boolean) => void
  setRevocations: (next: Revocations) => void
  close: () => Promise<void>
}

function startFakeControlPlane(): Promise<Fake> {
  let hang = false
  let revocations: Revocations = { projects: [], users: [], devices: [], jtis: [] }
  const server = createHttpServer((req, res) => {
    if (req.url?.startsWith('/v1/internal/policy')) {
      if (hang) {
        return // accepted, never answered
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: 1, downloadDefault: 'deny', projectOverrides: {} }))
      return
    }
    if (req.url?.startsWith('/v1/internal/revocations')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(revocations))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        hangPolicy: (next) => {
          hang = next
        },
        setRevocations: (next) => {
          revocations = next
        },
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          })
      })
    })
  })
}

let api: Service
let runtime: Service
let fake: Fake
let workspace: { root: string; projectRoot: string }

before(async () => {
  workspace = makeTempWorkspace()
  fake = await startFakeControlPlane()
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-isolation'
  )
  const tls = makeTlsCerts()
  runtime = await spawnService(
    'apps/runtime/src/runtime-sim.ts',
    {
      PORT: '0',
      API_URL: fake.url,
      PUBLIC_API_URL: api.url,
      CONTROL_TIMEOUT_MS: '500',
      HOST_ID: 'host_dev001',
      HOST_NAME: 'dev-001',
      SANDBOX_ROOT: workspace.root,
      TLS_KEY: tls.key,
      TLS_CERT: tls.cert
    },
    /\[runtime-sim\] dev-001 listening on :(\d+)/,
    'runtime-isolation'
  )
  const adminRes = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'isolation-admin' })
  })
  const { accessToken } = (await adminRes.json()) as { accessToken: string }
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
  await fake?.close()
})

describe('M16 控制面三路隔离与撤销快照 fail-closed', () => {
  test('F1：policy 端点挂起时，撤销仍能关闭已建会话', { timeout: 40000 }, async () => {
    fake.hangPolicy(true)
    const client = new CloudClient(api.url)
    const { deviceId } = await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const opened = await client.openProject(projects[0].id)
    assert.equal(opened.route, 'direct')

    const closed = new Promise<{ code: number; reason: string } | null>((resolve) => {
      client.onClose((code, reason) => resolve({ code, reason }))
      setTimeout(() => resolve(null), 12_000)
    })

    fake.setRevocations({
      projects: [],
      users: [],
      devices: [{ id: deviceId, since: Date.now() }],
      jtis: []
    })
    const closeInfo = await closed
    assert.ok(closeInfo, 'revocation must land even while the policy endpoint hangs')
    assert.equal(closeInfo.code, 4403)

    saveEvidence(EVIDENCE, 'policy-hang-still-revokes.json', { closeInfo, route: opened.route })
    client.close()
  })

  test('F1：policy 挂起不影响新连接准入（JWKS 来自健康端点）', { timeout: 30000 }, async () => {
    fake.hangPolicy(true)
    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const opened = await client.openProject(projects[0].id)
    assert.equal(opened.route, 'direct')
    const who = await client.rpc('sessions.whoami')
    assert.equal(who.ok, true)
    saveEvidence(EVIDENCE, 'policy-hang-new-session.json', { route: opened.route, whoami: who })
    client.close()
  })

  test('F2：畸形撤销 200（{}）不得清空已生效的撤销', { timeout: 30000 }, async () => {
    // A valid revocation first.
    const probe = new CloudClient(api.url)
    const { deviceId } = await probe.login('zhangsan', 'Passw0rd!')
    const projects = await probe.listProjects()
    const ticket = await probe.requestConnect(projects[0].id)
    probe.close()

    fake.setRevocations({
      projects: [],
      users: [],
      devices: [{ id: deviceId, since: Date.now() }],
      jtis: []
    })
    await new Promise((r) => setTimeout(r, 1600)) // let the poller take it

    const rejectedWhileRevoked = await attempt(projects[0].id, ticket.credential)
    assert.equal(rejectedWhileRevoked.reject, 'device_revoked')

    // The platform now answers with a body that parses as an object but means
    // nothing. Treating it as an empty snapshot would re-admit this ticket.
    fake.setRevocations({} as Revocations)
    await new Promise((r) => setTimeout(r, 1600))

    const rejectedAfterJunk = await attempt(projects[0].id, ticket.credential)
    assert.equal(rejectedAfterJunk.status, 401)
    assert.equal(rejectedAfterJunk.reject, 'device_revoked')

    saveEvidence(EVIDENCE, 'junk-revocations-keep-snapshot.json', {
      rejectedWhileRevoked,
      rejectedAfterJunk
    })
  })
})

/** Presents a ticket directly at the runtime, bypassing the client's route selection. */
async function attempt(
  _projectId: string,
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
      resolve({
        status: res.statusCode,
        reject: res.headers['x-orca-reject'] as string | undefined
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

/** The ticket is signed but not encrypted; reading the device key out is fine in-test. */
function devicePubKeyOf(credential: string): string {
  const claims = JSON.parse(Buffer.from(credential.split('.')[1], 'base64url').toString()) as {
    devicePubKey: string
  }
  return claims.devicePubKey
}
