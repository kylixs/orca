import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CloudClient } from '../../apps/client/src/cloud-client.ts'
import { mtlsFetch } from '../../packages/contract/src/internal-fetch.ts'
import {
  makeTlsCerts,
  makeTempWorkspace,
  saveEvidence,
  spawnService,
  type Service
} from './harness.ts'

const EVIDENCE = 'm17-review07-gaps'

/**
 * Review-07 F7: four behaviours the earlier rounds fixed but never pinned with a
 * test. Each one here fails if its fix is reverted.
 */

type Certs = {
  ca: string
  serverKey: string
  serverCert: string
  clientKey: string
  clientCert: string
}

function makeMtlsCerts(): Certs {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cloud-gaps-'))
  const sh = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  }
  sh([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
    '-days',
    '1',
    '-subj',
    '/CN=orca-internal-ca'
  ])
  sh([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
    '-subj',
    '/CN=127.0.0.1'
  ])
  writeFileSync(
    join(dir, 'server.ext'),
    'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n'
  )
  sh([
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'server.crt',
    '-days',
    '1',
    '-extfile',
    'server.ext'
  ])
  sh([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'client.key',
    '-out',
    'client.csr',
    '-subj',
    '/CN=orca-runtime'
  ])
  writeFileSync(join(dir, 'client.ext'), 'extendedKeyUsage=clientAuth\n')
  sh([
    'x509',
    '-req',
    '-in',
    'client.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'client.crt',
    '-days',
    '1',
    '-extfile',
    'client.ext'
  ])
  return {
    ca: join(dir, 'ca.crt'),
    serverKey: join(dir, 'server.key'),
    serverCert: join(dir, 'server.crt'),
    clientKey: join(dir, 'client.key'),
    clientCert: join(dir, 'client.crt')
  }
}

let certs: Certs
let api: Service
let internalPort = 0

before(async () => {
  certs = makeMtlsCerts()
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TLS_PORT: '0',
      INTERNAL_TLS_KEY: certs.serverKey,
      INTERNAL_TLS_CERT: certs.serverCert,
      INTERNAL_TLS_CA: certs.ca,
      INTERNAL_TLS_ALLOWED_CNS: 'orca-runtime',
      INTERNAL_TOKEN: 'gaps-non-default-token'
    },
    /\[api\] ready public=(\d+) internal=(\d+)/,
    'api-gaps'
  )
  internalPort = Number(/internal=(\d+)/.exec(api.logs.join(''))?.[1] ?? 0)
})

after(async () => {
  await api?.stop()
})

describe('M17 评审 07 遗留用例', () => {
  test('F7-a 配置 mTLS 后，公网监听对内部路由返回 404（N6）', async () => {
    for (const route of [
      '/v1/internal/policy',
      '/v1/internal/revocations',
      '/v1/internal/relay-routes'
    ]) {
      for (const token of ['gaps-non-default-token', 'internal-test-token', '']) {
        const res = await fetch(`${api.url}${route}`, {
          headers: token ? { 'x-internal-token': token } : {}
        })
        assert.equal(res.status, 404, `${route} must 404 on the public listener`)
        const body = (await res.json()) as { error?: { code: string } }
        assert.equal(body.error?.code, 'NOT_FOUND')
      }
    }
    // The relay still self-registers before mTLS exists, so this one stays reachable
    // on the public listener — but only with the real token.
    const allowed = await fetch(`${api.url}/v1/internal/relay-endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'gaps-non-default-token' },
      body: JSON.stringify({ port: 18099 })
    })
    assert.equal(allowed.status, 200)
    const denied = await fetch(`${api.url}/v1/internal/relay-endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'wrong' },
      body: JSON.stringify({ port: 18099 })
    })
    assert.equal(denied.status, 401)
    saveEvidence(EVIDENCE, 'public-listener-404.json', { routes: 3, relayEndpointReachable: true })
  })

  test('F7-b 平台接受非默认 INTERNAL_TOKEN（M8）', async () => {
    const res = await mtlsFetch(
      {
        internalUrl: `https://127.0.0.1:${internalPort}`,
        token: 'gaps-non-default-token',
        keyPath: certs.clientKey,
        certPath: certs.clientCert,
        caPath: certs.ca
      },
      '/v1/internal/policy'
    )
    assert.equal(res.status, 200)
    const wrong = await mtlsFetch(
      {
        internalUrl: `https://127.0.0.1:${internalPort}`,
        token: 'internal-test-token',
        keyPath: certs.clientKey,
        certPath: certs.clientCert,
        caPath: certs.ca
      },
      '/v1/internal/policy'
    )
    assert.equal(wrong.status, 401)
    saveEvidence(EVIDENCE, 'non-default-internal-token.json', {
      ok: res.status,
      wrong: wrong.status
    })
  })

  test('F7-c TLS 控制面挂起时客户端中止并回收 socket', { timeout: 30000 }, async () => {
    const workspace = makeTempWorkspace()
    // Control plane over HTTPS: this is the mtlsFetch branch, not the fetch branch.
    const tls = makeTlsCerts()
    let active = 0
    let total = 0
    const hanging = createHttpsServer({
      key: readFileSync(certs.serverKey),
      cert: readFileSync(certs.serverCert)
    })
    hanging.on('connection', (socket) => {
      total += 1
      active += 1
      socket.on('close', () => {
        active -= 1
      })
    })
    hanging.on('request', () => {
      // accepted, never answered
    })
    await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', () => r()))
    const hangingPort = (hanging.address() as { port: number }).port

    const runtime = await spawnService(
      'apps/runtime/src/runtime-sim.ts',
      {
        PORT: '0',
        // HTTPS without client cert material: the TLS branch still runs and aborts.
        API_URL: `https://127.0.0.1:${hangingPort}`,
        PUBLIC_API_URL: api.url,
        CONTROL_TIMEOUT_MS: '300',
        HOST_ID: 'host_dev001',
        HOST_NAME: 'dev-001',
        SANDBOX_ROOT: workspace.root,
        INTERNAL_TLS_CA: certs.ca,
        TLS_KEY: tls.key,
        TLS_CERT: tls.cert
      },
      /\[runtime-sim\] dev-001 listening on :(\d+)/,
      'runtime-tls-abort'
    )
    try {
      await new Promise((r) => setTimeout(r, 3500))
      assert.ok(total >= 3, `polling must have happened, total=${total}`)
      assert.ok(
        active <= 4,
        `aborted TLS sockets must be released, active=${active} total=${total}`
      )
      assert.equal(runtime.proc.exitCode, null)
      saveEvidence(EVIDENCE, 'tls-abort-released.json', { total, active })
    } finally {
      await runtime.stop()
      await new Promise<void>((r) => {
        hanging.closeAllConnections?.()
        hanging.close(() => r())
      })
    }
  })

  test('F7-d allow 策略下导出通过授权（反向验证，用独立平台）', { timeout: 30000 }, async () => {
    // Deny-only coverage would also pass if the method were blocked unconditionally.
    const workspace = makeTempWorkspace()
    const tls = makeTlsCerts()
    const isolatedApi = await spawnService(
      'apps/api/src/server.ts',
      { PORT: '0' },
      /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
      'api-allow'
    )
    const { registerHost } = await import('./harness.ts')
    const runtime = await spawnService(
      'apps/runtime/src/runtime-sim.ts',
      {
        PORT: '0',
        API_URL: isolatedApi.url,
        HOST_ID: 'host_dev001',
        HOST_NAME: 'dev-001',
        SANDBOX_ROOT: workspace.root,
        TLS_KEY: tls.key,
        TLS_CERT: tls.cert
      },
      /\[runtime-sim\] dev-001 listening on :(\d+)/,
      'runtime-allow'
    )
    let client: CloudClient | null = null
    try {
      const adminRes = await fetch(`${isolatedApi.url}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'allow-admin' })
      })
      const { accessToken } = (await adminRes.json()) as { accessToken: string }
      await registerHost({
        apiUrl: isolatedApi.url,
        adminToken: accessToken,
        name: 'dev-001',
        directAddr: `127.0.0.1:${runtime.port}`,
        relayTarget: `127.0.0.1:${runtime.port}`
      })
      const put = await fetch(`${isolatedApi.url}/v1/policies/download`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ downloadDefault: 'allow' })
      })
      assert.equal(put.status, 200)

      client = new CloudClient(isolatedApi.url)
      await client.login('zhangsan', 'Passw0rd!')
      const projects = await client.listProjects()
      // Allow needs both halves: the policy (export class) and the grant
      // (`download` permission). The seeded team grant deliberately omits it.
      const projectPolicy = await fetch(`${isolatedApi.url}/v1/projects/${projects[0].id}/policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ downloadPolicy: 'allow' })
      })
      assert.equal(projectPolicy.status, 200)
      const grant = await fetch(`${isolatedApi.url}/v1/projects/${projects[0].id}/grants`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          subjectType: 'group',
          subjectId: 'team-payment',
          permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write', 'download']
        })
      })
      assert.equal(grant.status, 200)
      // Grant changes revoke credentials issued up to `now`, so the next ticket must
      // be minted strictly after that stamp.
      await new Promise((r) => setTimeout(r, 1200))

      const opened = await client.openProject(projects[0].id)
      // Long enough for the runtime's 1s policy poll to pick up the allow.
      await new Promise((r) => setTimeout(r, 2500))

      const download = await client.rpc('files.download', {
        path: `${opened.connect.workspace.projectRoot}/README.md`
      })
      // Authorization passed; the simulator does not implement the export itself.
      assert.equal(download.ok, false)
      assert.equal(download.ok === false ? download.code : '', 'NOT_IMPLEMENTED')
      saveEvidence(EVIDENCE, 'allow-policy-passes-authorization.json', { download })
    } finally {
      client?.close()
      await runtime.stop()
      await isolatedApi.stop()
    }
  })
})
