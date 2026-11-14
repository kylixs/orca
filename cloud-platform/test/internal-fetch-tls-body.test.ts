import { test, describe, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpsServer } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { mtlsFetch } from '../packages/contract/src/internal-fetch.ts'
import { makeTlsCerts } from './e2e/harness.ts'

/**
 * U43: the TLS branch of mtlsFetch used to end the request without writing
 * init.body, so every HTTPS POST reached the platform as an empty body
 * (relay announce -> 400 RELAY_PORT_INVALID). These tests pin the body bytes
 * the server actually receives on the mTLS path.
 */

type Captured = { method?: string; body: string; contentLength?: string }

const certs = makeTlsCerts()
let received: Captured[] = []
const server = createHttpsServer(
  { key: readFileSync(certs.key), cert: readFileSync(certs.cert) },
  (req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({
        method: req.method,
        body: Buffer.concat(chunks).toString('utf8'),
        contentLength: req.headers['content-length']
      })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, bytes: Buffer.concat(chunks).length }))
    })
  }
)
server.listen(0, '127.0.0.1')
after(() => server.close())

let port = 0
const config = {
  internalUrl: '',
  token: 'internal-test-token',
  caPath: certs.cert
}

before(async () => {
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
  }
  port = (server.address() as AddressInfo).port
  config.internalUrl = `https://127.0.0.1:${port}`
})

describe('mtlsFetch TLS 请求体（U43）', () => {
  test('POST 字符串体完整到达服务端且 Content-Length 匹配', async () => {
    received = []
    const payload = JSON.stringify({ id: 'relay:18443', host: '10.0.0.8', port: 18443 })
    const res = await mtlsFetch(config, '/v1/internal/relay-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload
    })
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json()) as { bytes: number }, { ok: true, bytes: payload.length })
    assert.equal(received.length, 1)
    assert.equal(received[0].body, payload)
    assert.equal(received[0].contentLength, String(Buffer.byteLength(payload)))
  })

  test('POST Buffer 体（多字节 UTF-8）按字节落地', async () => {
    received = []
    const payload = Buffer.from(JSON.stringify({ note: '中文路径/工作区' }), 'utf8')
    const res = await mtlsFetch(config, '/v1/internal/relay-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload
    })
    assert.equal(res.status, 200)
    assert.equal(received.length, 1)
    assert.deepEqual(Buffer.from(received[0].body, 'utf8'), payload)
    assert.equal(received[0].contentLength, String(payload.byteLength))
  })

  test('调用方自带 chunked 帧定时不补 Content-Length，体仍完整', async () => {
    received = []
    const payload = 'port=18443'
    await mtlsFetch(config, '/v1/internal/relay-endpoint', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
      body: payload,
      signal: AbortSignal.timeout(5000)
    })
    assert.equal(received[0].body, payload)
    assert.equal(received[0].contentLength, undefined)
  })

  test('GET 仍无请求体也无 Content-Length（零回归）', async () => {
    received = []
    const res = await mtlsFetch(config, '/v1/internal/relay-routes')
    assert.equal(res.status, 200)
    assert.equal(received.length, 1)
    assert.equal(received[0].method, 'GET')
    assert.equal(received[0].body, '')
    assert.equal(received[0].contentLength, undefined)
  })

  test('不支持的流式请求体显式报错而不是发空体', async () => {
    await assert.rejects(
      mtlsFetch(config, '/v1/internal/relay-endpoint', {
        method: 'POST',
        body: new FormData()
      }),
      TypeError
    )
  })
})
