import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import { mtlsFetch } from '../../packages/contract/src/internal-fetch.ts'
import { makeTempWorkspace, saveEvidence, spawnService, type Service } from './harness.ts'

const EVIDENCE = 'm9-mtls'

type Certs = {
  ca: string
  serverKey: string
  serverCert: string
  relayKey: string
  relayCert: string
  rogueKey: string
  rogueCert: string
  rogueCa: string
}

/**
 * Builds a private CA, a server cert for 127.0.0.1, a relay client cert signed by
 * that CA, and a rogue client cert signed by a different CA.
 */
function makeMtlsCerts(): Certs {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cloud-mtls-'))
  const sh = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  }
  // Internal CA
  sh(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=orca-internal-ca'])
  // Server
  sh(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1'])
  writeFileSync(
    join(dir, 'server.ext'),
    'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n'
  )
  sh(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '1', '-extfile', 'server.ext'])
  // Relay client (signed by the internal CA)
  sh(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'relay.key', '-out', 'relay.csr', '-subj', '/CN=orca-relay'])
  writeFileSync(join(dir, 'client.ext'), 'extendedKeyUsage=clientAuth\n')
  sh(['x509', '-req', '-in', 'relay.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'relay.crt', '-days', '1', '-extfile', 'client.ext'])
  // Rogue CA + client cert (must be rejected)
  sh(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'rogue-ca.key', '-out', 'rogue-ca.crt', '-days', '1', '-subj', '/CN=rogue-ca'])
  sh(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'rogue.key', '-out', 'rogue.csr', '-subj', '/CN=orca-relay'])
  sh(['x509', '-req', '-in', 'rogue.csr', '-CA', 'rogue-ca.crt', '-CAkey', 'rogue-ca.key', '-CAcreateserial', '-out', 'rogue.crt', '-days', '1', '-extfile', 'client.ext'])

  return {
    ca: join(dir, 'ca.crt'),
    serverKey: join(dir, 'server.key'),
    serverCert: join(dir, 'server.crt'),
    relayKey: join(dir, 'relay.key'),
    relayCert: join(dir, 'relay.crt'),
    rogueKey: join(dir, 'rogue.key'),
    rogueCert: join(dir, 'rogue.crt'),
    rogueCa: join(dir, 'rogue-ca.crt')
  }
}

let api: Service
let relay: Service
let runtime: Service
let certs: Certs
let internalPort = 0
let runtimePort = 0
let onlyOtherPort = 0

async function waitForLog(service: Service, pattern: RegExp, timeoutMs = 10000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (service.logs.some((line) => pattern.test(line))) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`log ${pattern} not seen: ${service.logs.join('')}`)
}

before(async () => {
  certs = makeMtlsCerts()
  const workspace = makeTempWorkspace()

  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TLS_PORT: '0',
      INTERNAL_TLS_KEY: certs.serverKey,
      INTERNAL_TLS_CERT: certs.serverCert,
      INTERNAL_TLS_CA: certs.ca,
      INTERNAL_TLS_ALLOWED_CNS: 'orca-relay,orca-runtime'
    },
    /\[api\] ready public=(\d+) internal=(\d+)/,
    'api'
  )
  internalPort = Number(/internal=(\d+)/.exec(api.logs.join(''))?.[1] ?? 0)

  relay = await spawnService(
    'apps/relay/src/relay.ts',
    {
      PORT: '0',
      API_URL: `https://127.0.0.1:${internalPort}`,
      INTERNAL_TOKEN: 'internal-test-token',
      INTERNAL_TLS_KEY: certs.relayKey,
      INTERNAL_TLS_CERT: certs.relayCert,
      INTERNAL_TLS_CA: certs.ca
    },
    /\[relay\] listening on :(\d+)/,
    'relay'
  )

  runtime = await spawnService(
    'apps/runtime/src/runtime-sim.ts',
    {
      PORT: '0',
      API_URL: `https://127.0.0.1:${internalPort}`,
      PUBLIC_API_URL: api.url,
      HOST_ID: 'host_dev001',
      HOST_NAME: 'dev-001',
      SANDBOX_ROOT: workspace.root,
      INTERNAL_TOKEN: 'internal-test-token',
      INTERNAL_TLS_KEY: certs.relayKey,
      INTERNAL_TLS_CERT: certs.relayCert,
      INTERNAL_TLS_CA: certs.ca
    },
    /\[runtime-sim\] dev-001 listening on :(\d+)/,
    'runtime'
  )
  runtimePort = runtime.port

  // Register the host over the public listener so the relay has a route to sync.
  const loginRes = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm9' })
  })
  const { accessToken } = (await loginRes.json()) as { accessToken: string }
  const tokenRes = await fetch(`${api.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` }
  })
  const { token } = (await tokenRes.json()) as { token: string }
  await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'dev-001',
      fingerprint: 'sha256:dev-001',
      e2eePublicKeyB64: 'test-e2ee-key',
      directAddrs: [`127.0.0.1:${runtimePort}`],
      relayTarget: `127.0.0.1:${runtimePort}`,
      relayRoute: 'dev-001',
      runtimeCapabilities: ['pty', 'files', 'managed-credential']
    })
  })
})

after(async () => {
  await runtime?.stop()
  await relay?.stop()
  await api?.stop()
})

describe('M9 内部通道 mTLS', () => {
  test('有效客户端证书可读取内部路由表', async () => {
    const res = await mtlsFetch(
      {
        internalUrl: `https://127.0.0.1:${internalPort}`,
        token: 'internal-test-token',
        keyPath: certs.relayKey,
        certPath: certs.relayCert,
        caPath: certs.ca
      },
      '/v1/internal/relay-routes'
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as { routes: unknown[] }
    assert.ok(Array.isArray(body.routes))
    saveEvidence(EVIDENCE, 'valid-client-success.json', { status: res.status, routes: body.routes.length })
  })

  test('无客户端证书握手失败', async () => {
    const result = await new Promise<{ error?: string; status?: number }>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: internalPort,
          path: '/v1/internal/relay-routes',
          headers: { 'x-internal-token': 'internal-test-token' },
          ca: readFileSync(certs.ca),
          rejectUnauthorized: true
        },
        (res) => {
          res.resume()
          resolve({ status: res.statusCode })
        }
      )
      req.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? err.message }))
      req.end()
    })
    assert.notEqual(result.status, 200, 'request without a client cert must not succeed')
    saveEvidence(EVIDENCE, 'no-client-cert.json', result)
  })

  test('其他 CA 签发的客户端证书被拒', async () => {
    const result = await new Promise<{ error?: string; status?: number }>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: internalPort,
          path: '/v1/internal/relay-routes',
          headers: { 'x-internal-token': 'internal-test-token' },
          key: readFileSync(certs.rogueKey),
          cert: readFileSync(certs.rogueCert),
          ca: readFileSync(certs.ca),
          rejectUnauthorized: true
        },
        (res) => {
          res.resume()
          resolve({ status: res.statusCode })
        }
      )
      req.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? err.message }))
      req.end()
    })
    assert.notEqual(result.status, 200, 'rogue CA cert must not be accepted')
    saveEvidence(EVIDENCE, 'rogue-ca-rejected.json', result)
  })

  test('有效证书但 CN 不在允许列表被拒（403 MTLS_CN_NOT_ALLOWED）', async () => {
    // Reuse the relay cert (CN=orca-relay) against a server configured to allow only "someone-else".
    const onlyOther = await spawnService(
      'apps/api/src/server.ts',
      {
        PORT: '0',
        INTERNAL_TLS_PORT: '0',
        INTERNAL_TLS_KEY: certs.serverKey,
        INTERNAL_TLS_CERT: certs.serverCert,
        INTERNAL_TLS_CA: certs.ca,
        INTERNAL_TLS_ALLOWED_CNS: 'not-orca-relay'
      },
      /\[api\] ready public=(\d+) internal=(\d+)/,
      'api-strict-cn'
    )
    onlyOtherPort = Number(/internal=(\d+)/.exec(onlyOther.logs.join(''))?.[1] ?? 0)
    try {
      const res = await mtlsFetch(
        {
          internalUrl: `https://127.0.0.1:${onlyOtherPort}`,
          token: 'internal-test-token',
          keyPath: certs.relayKey,
          certPath: certs.relayCert,
          caPath: certs.ca
        },
        '/v1/internal/relay-routes'
      )
      assert.equal(res.status, 403)
      const body = (await res.json()) as { error?: { code: string } }
      assert.equal(body.error?.code, 'MTLS_CN_NOT_ALLOWED')
      saveEvidence(EVIDENCE, 'cn-not-allowed.json', { status: res.status, body })
    } finally {
      await onlyOther.stop()
    }
  })

  test('内部通道只暴露 /v1/internal/*，其他路径 404', async () => {
    const res = await mtlsFetch(
      {
        internalUrl: `https://127.0.0.1:${internalPort}`,
        token: 'internal-test-token',
        keyPath: certs.relayKey,
        certPath: certs.relayCert,
        caPath: certs.ca
      },
      '/v1/projects'
    )
    assert.equal(res.status, 404)
    const body = (await res.json()) as { error?: { code: string } }
    assert.equal(body.error?.code, 'NOT_FOUND')
    saveEvidence(EVIDENCE, 'path-scope.json', { status: res.status, body })
  })

  test('缺少内部令牌时即使 mTLS 通过也被拒', async () => {
    const res = await mtlsFetch(
      {
        internalUrl: `https://127.0.0.1:${internalPort}`,
        token: 'wrong-token',
        keyPath: certs.relayKey,
        certPath: certs.relayCert,
        caPath: certs.ca
      },
      '/v1/internal/relay-routes'
    )
    assert.equal(res.status, 401)
    const body = (await res.json()) as { error?: { code: string } }
    assert.equal(body.error?.code, 'INTERNAL_TOKEN_INVALID')
    saveEvidence(EVIDENCE, 'wrong-token.json', { status: res.status, body })
  })

  test('中继经 mTLS 同步到路由表', async () => {
    // The relay polls every 2s; after the host is registered it should log a sync.
    await waitForLog(relay, /routes synced n=\d+/, 12000)
    const synced = relay.logs.filter((line) => /routes synced/.test(line))
    assert.ok(synced.length >= 1)
    saveEvidence(EVIDENCE, 'relay-sync-log.json', { lines: synced.slice(-5) })
  })

  test('Runtime 经 mTLS 拉取策略并保持运行', async () => {
    await waitForLog(runtime, /policy synced v=\d+/, 12000)
    assert.equal(runtime.proc.exitCode, null)
    saveEvidence(EVIDENCE, 'runtime-uses-mtls.json', {
      alive: true,
      port: runtimePort,
      policySyncLines: runtime.logs.filter((l) => /policy synced/.test(l)).slice(-3)
    })
  })
})
