import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { CloudClient } from '../../apps/client/src/cloud-client.ts'
import {
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

