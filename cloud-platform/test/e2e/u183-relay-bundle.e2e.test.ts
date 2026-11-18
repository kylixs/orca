import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnService, type Service } from './harness.ts'

/**
 * U183 R2: the platform serves the content-addressed relay bundle, and the
 * generated relay.sh carries the same sha, URL and download scheme. The bundle
 * endpoints are public (the tarball holds no secret); the script endpoint keeps
 * its admin gate.
 */

const INTERNAL_TOKEN = 'u183-r2-internal-token'
const SHA_A = 'a'.repeat(64)
const SHA_MISSING_TSGZ = 'b'.repeat(64)
const SHA_NO_MANIFEST = 'c'.repeat(64)
const SHA_BAD_MANIFEST = 'd'.repeat(64)
const TGZ_BODY = 'fake relay tarball bytes'

let api: Service
let brokenApi: Service
let bundleDir = ''
let adminToken = ''

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

function manifest(sha: string): string {
  return JSON.stringify({
    bundleSha256: sha,
    schemaVersion: 1,
    relayCodeVersion: '0.1.0',
    files: ['VERSION', 'apps/relay/src/relay.ts']
  })
}

/** Raw Host/proto headers: undici rewrites Host, so use http.request. */
function rawGet(
  service: Service,
  path: string,
  headers: Record<string, string>
): Promise<{
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}> {
  const url = new URL(service.url)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: 'GET',
        headers
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

before(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'u183-relay-bundles-'))
  writeFileSync(join(bundleDir, `relay-bundle-${SHA_A}.tgz`), TGZ_BODY)
  writeFileSync(join(bundleDir, `relay-bundle-${SHA_A}.manifest.json`), manifest(SHA_A))
  // .tgz present, manifest absent → deployment error when generating a script.
  writeFileSync(join(bundleDir, `relay-bundle-${SHA_NO_MANIFEST}.tgz`), TGZ_BODY)
  writeFileSync(join(bundleDir, `relay-bundle-${SHA_BAD_MANIFEST}.tgz`), TGZ_BODY)
  writeFileSync(
    join(bundleDir, `relay-bundle-${SHA_BAD_MANIFEST}.manifest.json`),
    manifest('f'.repeat(64))
  )

  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN, ORCA_RELAY_BUNDLE_DIR: bundleDir },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'u183-r2-api'
  )
  brokenApi = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN, ORCA_RELAY_BUNDLE_DIR: join(bundleDir, 'absent') },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'u183-r2-broken-api'
  )

  const login = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u183-r2' })
  })
  assert.equal(login.status, 200)
  adminToken = ((await login.json()) as { accessToken: string }).accessToken
  assert.notEqual(adminToken, '')
}, { timeout: 120_000 })

after(async () => {
  await api?.stop()
  await brokenApi?.stop()
})

describe('U183 R2: relay bundle routes', () => {
  test('公开获取 tgz：200、no-store、application/gzip、字节一致', async () => {
    const res = await fetch(`${api.url}/install/relay-bundle/${SHA_A}.tgz`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('content-type'), 'application/gzip')
    assert.equal(await res.text(), TGZ_BODY)
  })

  test('公开获取 manifest：200、JSON、no-store、sha 与文件名一致', async () => {
    const res = await fetch(`${api.url}/install/relay-bundle/${SHA_A}.manifest.json`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    const body = (await res.json()) as { bundleSha256: string }
    assert.equal(body.bundleSha256, SHA_A)
  })

  test('非法 sha 以 400 拒绝；路径穿越不回落到明文文件', async () => {
    for (const path of [
      `/install/relay-bundle/not-a-sha.tgz`,
      `/install/relay-bundle/${'A'.repeat(64)}.tgz`,
      `/install/relay-bundle/${'a'.repeat(63)}.tgz`,
      `/install/relay-bundle/%2e%2e%2fsecret.tgz`
    ]) {
      const res = await fetch(`${api.url}${path}`)
      assert.equal(res.status, 400, path)
    }
  })

  test('合法 sha 但文件不存在 → 404（与目录缺失区分）', async () => {
    const res = await fetch(`${api.url}/install/relay-bundle/${SHA_MISSING_TSGZ}.tgz`)
    assert.equal(res.status, 404)
    assert.equal(
      ((await res.json()) as { error?: { code: string } }).error?.code,
      'RELAY_BUNDLE_NOT_FOUND'
    )
  })

  test('bundle 目录未配置 → 503', async () => {
    const res = await fetch(`${brokenApi.url}/install/relay-bundle/${SHA_A}.tgz`)
    assert.equal(res.status, 503)
    assert.equal(
      ((await res.json()) as { error?: { code: string } }).error?.code,
      'RELAY_BUNDLE_UNAVAILABLE'
    )
  })
})

describe('U183 R2: relay.sh embeds the selected bundle', () => {
  test('http 本地平台：sha/URL 一致、无 --proto、打印非 TLS 警告', async () => {
    const res = await fetch(`${api.url}/install/relay.sh?sha=${SHA_A}`, {
      headers: auth(adminToken)
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const script = await res.text()

    const embeddedSha = /^ORCA_RELAY_BUNDLE_SHA256='([0-9a-f]{64})'$/m.exec(script)?.[1]
    const embeddedUrl = /^ORCA_RELAY_BUNDLE_URL='([^']+)'$/m.exec(script)?.[1]
    assert.equal(embeddedSha, SHA_A)
    assert.equal(embeddedUrl, `${api.url}/install/relay-bundle/${SHA_A}.tgz`)
    assert.match(script, /^ORCA_RELAY_DOWNLOAD_TLS=0$/m)
    assert.match(script, /未强制 TLS/)
    assert.doesNotMatch(script, /--proto/)
    assert.match(script, /^ORCA_RELAY_SCHEMA_VERSION=1$/m)
    assert.match(script, /^ORCA_RELAY_CODE_VERSION='0\.1\.0'$/m)
    // The URL the target machine downloads is the route this same server serves.
    assert.ok(embeddedUrl!.endsWith(`/install/relay-bundle/${embeddedSha}.tgz`))
  })

  test('https 平台：TLS 参数进入下载命令', async () => {
    const res = await rawGet(api, `/install/relay.sh?sha=${SHA_A}`, {
      ...auth(adminToken),
      'x-forwarded-proto': 'https'
    })
    assert.equal(res.status, 200)
    assert.match(res.body, /^ORCA_RELAY_DOWNLOAD_TLS=1$/m)
    assert.match(res.body, /^ORCA_RELAY_BUNDLE_URL='https:\/\//m)
    assert.ok(res.body.includes(`--proto '=https' --tlsv1.2`))
    assert.doesNotMatch(res.body, /未强制 TLS/)
  })

  test('非 loopback 的 http 平台拒绝生成脚本', async () => {
    const res = await rawGet(api, `/install/relay.sh?sha=${SHA_A}`, {
      ...auth(adminToken),
      host: 'platform.example.com'
    })
    assert.equal(res.status, 400)
    assert.equal(
      (JSON.parse(res.body) as { error?: { code: string } }).error?.code,
      'RELAY_BUNDLE_INSECURE_URL'
    )
  })

  test('目标包缺失 → 503，不生成注定失败的脚本', async () => {
    const res = await fetch(`${api.url}/install/relay.sh?sha=${SHA_MISSING_TSGZ}`, {
      headers: auth(adminToken)
    })
    assert.equal(res.status, 503)
    assert.equal(
      ((await res.json()) as { error?: { code: string } }).error?.code,
      'RELAY_BUNDLE_UNAVAILABLE'
    )
  })

  test('缺清单 → 500 RELAY_BUNDLE_MANIFEST_MISSING', async () => {
    const res = await fetch(`${api.url}/install/relay.sh?sha=${SHA_NO_MANIFEST}`, {
      headers: auth(adminToken)
    })
    assert.equal(res.status, 500)
    assert.equal(
      ((await res.json()) as { error?: { code: string } }).error?.code,
      'RELAY_BUNDLE_MANIFEST_MISSING'
    )
  })

  test('清单 sha 不符 → 500 RELAY_BUNDLE_MANIFEST_INVALID', async () => {
    const res = await fetch(`${api.url}/install/relay.sh?sha=${SHA_BAD_MANIFEST}`, {
      headers: auth(adminToken)
    })
    assert.equal(res.status, 500)
    assert.equal(
      ((await res.json()) as { error?: { code: string } }).error?.code,
      'RELAY_BUNDLE_MANIFEST_INVALID'
    )
  })

  test('脚本端点鉴权不变：匿名 401，bundle 路由仍公开', async () => {
    const script = await fetch(`${api.url}/install/relay.sh?sha=${SHA_A}`)
    assert.equal(script.status, 401)
    const bundle = await fetch(`${api.url}/install/relay-bundle/${SHA_A}.tgz`)
    assert.equal(bundle.status, 200)
  })
})
