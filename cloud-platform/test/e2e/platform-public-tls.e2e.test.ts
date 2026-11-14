import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { makeTlsCerts } from './harness.ts'

/**
 * U41: the public listener speaks plain HTTP unless PLATFORM_TLS_* is set, and
 * HTTPS when it is — a pure transport swap (same routes, same port semantics).
 * The origin links hand out (`?api=`) must follow the transport: a TLS listener
 * has no proxy to announce the scheme via x-forwarded-proto.
 */

const apps: ApiHandle[] = []

async function start(publicTls?: { certPath: string; keyPath: string }): Promise<number> {
  const app = createApp({ port: 0, ...(publicTls ? { publicTls } : {}) })
  apps.push(app)
  return app.listen()
}

type Reply = { status: number; body: Record<string, unknown> }

function call(
  base: URL,
  method: 'GET' | 'POST',
  path: string,
  ca: Buffer | undefined,
  init?: { token?: string; body?: Record<string, unknown> }
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      host: base.hostname,
      port: base.port,
      path,
      method,
      headers: { 'content-type': 'application/json' },
      ...(ca ? { ca, rejectUnauthorized: true } : {})
    }
    const req = (ca ? httpsRequest : httpRequest)(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        })
      })
    })
    if (init?.token) req.setHeader('authorization', `Bearer ${init.token}`)
    if (init?.body) req.write(JSON.stringify(init.body))
    req.on('error', reject)
    req.end()
  })
}

async function adminToken(base: URL, ca?: Buffer): Promise<string> {
  const res = await call(base, 'POST', '/v1/auth/login', ca, {
    body: { username: 'admin', password: 'Adm1n!', deviceName: 'tls-probe' }
  })
  assert.equal(res.status, 200)
  const token = res.body.accessToken
  assert.equal(typeof token, 'string')
  return token
}

async function seededSessionPageUrl(base: URL, ca?: Buffer): Promise<string> {
  const token = await adminToken(base, ca)
  const projects = await call(base, 'GET', '/v1/projects', ca, { token })
  assert.equal(projects.status, 200)
  const items = (projects.body as { projects?: Record<string, unknown>[] }).projects ?? []
  const seeded = items.find((p) => p.key === 'payment-service')
  assert.ok(seeded, 'seeded payment-service project is visible')
  return String(seeded.sessionPageUrl)
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('平台公网口可选 TLS（U41）', () => {
  test('未配置 TLS → HTTP 照常服务，链接 origin 为 http（零回归）', async () => {
    const port = await start()
    const base = new URL(`http://127.0.0.1:${port}`)
    const health = await call(base, 'GET', '/health', undefined)
    assert.equal(health.status, 200)

    const pageUrl = await seededSessionPageUrl(base)
    const api = new URL(pageUrl).searchParams.get('api')
    assert.equal(api, `http://127.0.0.1:${port}`)
  })

  test('配置 TLS → 同一端口改说 HTTPS，`?api=` 随之变为 https', async () => {
    const { key, cert } = makeTlsCerts()
    const ca = readFileSync(cert)
    const port = await start({ certPath: cert, keyPath: key })
    const base = new URL(`https://127.0.0.1:${port}`)

    const health = await call(base, 'GET', '/health', ca)
    assert.equal(health.status, 200)

    const pageUrl = await seededSessionPageUrl(base, ca)
    const api = new URL(pageUrl).searchParams.get('api')
    assert.equal(api, `https://127.0.0.1:${port}`)
  })
})
