import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls'
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
  // Server
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
  // Relay client (signed by the internal CA)
  sh([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'relay.key',
    '-out',
    'relay.csr',
    '-subj',
    '/CN=orca-relay'
  ])
  writeFileSync(join(dir, 'client.ext'), 'extendedKeyUsage=clientAuth\n')
  sh([
    'x509',
    '-req',
    '-in',
    'relay.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'relay.crt',
    '-days',
    '1',
    '-extfile',
    'client.ext'
  ])
  // Rogue CA + client cert (must be rejected)
  sh([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'rogue-ca.key',
    '-out',
    'rogue-ca.crt',
    '-days',
    '1',
    '-subj',
    '/CN=rogue-ca'
  ])
  sh([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'rogue.key',
    '-out',
    'rogue.csr',
    '-subj',
    '/CN=orca-relay'
  ])
  sh([
    'x509',
    '-req',
    '-in',
    'rogue.csr',
    '-CA',
    'rogue-ca.crt',
    '-CAkey',
    'rogue-ca.key',
    '-CAcreateserial',
    '-out',
    'rogue.crt',
    '-days',
    '1',
    '-extfile',
    'client.ext'
  ])

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

function tlsClientOptions(): ConnectionOptions {
  return {
    host: '127.0.0.1',
    port: internalPort,
    // The server cert covers DNS localhost; naming it avoids the IP-SNI warning.
    servername: 'localhost',
    key: readFileSync(certs.relayKey),
    cert: readFileSync(certs.relayCert),
    ca: readFileSync(certs.ca),
    rejectUnauthorized: true
  }
}

async function openTlsSocket(): Promise<TLSSocket> {
  const socket = tlsConnect(tlsClientOptions())
  socket.on('error', () => {
    // Errors after a refusal are expected; each assertion reads the response first.
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('TLS connect timed out'))
    }, 2000)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return socket
}

type RawTlsResponse = {
  status: number
  headers: Record<string, string>
  body: string
  /** Time from the first write to the complete response. */
  responseMs: number
  /** Time to the socket close, or null when the close was still awaited at the deadline. */
  closeMs: number | null
  bytesWrittenAtClose: number
  errors: string[]
}

type RawTlsResponseOptions = {
  /** Keep listening after the response for the server-issued close. */
  awaitClose?: boolean
  /** Runs once the response is complete, before the awaited close arrives. */
  onResponse?: () => void
}

/** Reads one framed response off a raw TLS socket. */
function readTlsResponse(
  socket: TLSSocket,
  timeoutMs: number,
  label: string,
  options: RawTlsResponseOptions = {}
): Promise<RawTlsResponse> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const errors: string[] = []
    let buffer = Buffer.alloc(0)
    let headerEnd = -1
    let expectedBody = 0
    let chunked = false
    let chunkCursor = 0
    let chunkedBody = Buffer.alloc(0)
    let bodyText = ''
    let status = 0
    const headers: Record<string, string> = {}
    let done = false
    let responseDone = false
    let responseMs = 0
    let closeMs: number | null = null
    const cleanup = (): void => {
      done = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const result = (): RawTlsResponse => ({
      status,
      headers,
      body: bodyText,
      responseMs,
      closeMs,
      bytesWrittenAtClose: socket.bytesWritten,
      errors: [...errors]
    })
    const settle = (): void => {
      cleanup()
      resolve(result())
    }
    const consumeChunked = (): boolean => {
      while (true) {
        const lineEnd = buffer.indexOf('\r\n', chunkCursor)
        if (lineEnd === -1) return false
        const size = Number.parseInt(buffer.subarray(chunkCursor, lineEnd).toString('latin1'), 16)
        if (!Number.isFinite(size)) return false
        const dataStart = lineEnd + 2
        if (size === 0) return buffer.length >= dataStart + 2
        if (buffer.length < dataStart + size + 2) return false
        chunkedBody = Buffer.concat([chunkedBody, buffer.subarray(dataStart, dataStart + size)])
        chunkCursor = dataStart + size + 2
      }
    }
    const maybeResolve = (): void => {
      if (done || responseDone || headerEnd === -1) return
      if (chunked) {
        if (!consumeChunked()) return
        bodyText = chunkedBody.toString('utf8')
      } else {
        if (buffer.length - headerEnd < expectedBody) return
        bodyText = buffer.subarray(headerEnd, headerEnd + expectedBody).toString('utf8')
      }
      responseDone = true
      responseMs = Date.now() - started
      if (!options.awaitClose) {
        settle()
        return
      }
      options.onResponse?.()
    }
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (headerEnd === -1) {
        const index = buffer.indexOf('\r\n\r\n')
        if (index === -1) return
        headerEnd = index + 4
        const lines = buffer.subarray(0, index).toString('latin1').split('\r\n')
        status = Number(lines[0]?.split(' ')[1] ?? 0)
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':')
          if (colon === -1) continue
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        expectedBody = Number(headers['content-length'] ?? 0)
        chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')
        chunkCursor = headerEnd
      }
      maybeResolve()
    }
    const onClose = (): void => {
      if (done) return
      closeMs = Date.now() - started
      if (!responseDone) {
        maybeResolve()
      }
      if (responseDone) {
        settle()
        return
      }
      cleanup()
      reject(new Error(`${label}: socket closed before a complete response`))
    }
    const onError = (error: Error): void => {
      if (done) return
      errors.push(error.message)
      // A reset after the full response is the server tearing down an unread body.
      if (responseDone && options.awaitClose) return
      if (!responseDone) {
        maybeResolve()
      }
      if (responseDone) {
        settle()
        return
      }
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => {
      if (done) return
      if (responseDone) {
        settle()
        return
      }
      cleanup()
      reject(new Error(`${label}: no response within ${timeoutMs}ms`))
    }, timeoutMs)
    socket.on('data', onData)
    socket.on('close', onClose)
    socket.on('error', onError)
  })
}

type DeclaredProbe = {
  status: number
  connection: string | undefined
  receivedResponse: boolean
  closed: boolean
  acceptedBytes: number
}

/**
 * Declares a body, waits for the refusal computed from headers alone, then
 * pumps the declared bytes. A closed connection accepts only what was already
 * in flight; the accepted count is far below the declaration.
 */
function pacedDeclaredTlsRequest(path: string, declared: number): Promise<DeclaredProbe> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(tlsClientOptions())
    const chunk = Buffer.alloc(32 * 1024, 'x')
    let attempted = 0
    let status = 0
    let connection: string | undefined
    let received = false
    let closed = false
    let settled = false
    let writeTimer: NodeJS.Timeout | undefined
    let headerBuffer = Buffer.alloc(0)
    const finish = (): void => {
      if (settled) return
      settled = true
      if (writeTimer !== undefined) clearInterval(writeTimer)
      clearTimeout(deadline)
      const acceptedBytes = socket.bytesWritten
      socket.destroy()
      resolve({ status, connection, receivedResponse: received, closed, acceptedBytes })
    }
    const pump = (): void => {
      writeTimer = setInterval(() => {
        if (closed || attempted >= declared) {
          if (writeTimer !== undefined) clearInterval(writeTimer)
          if (attempted >= declared) finish()
          return
        }
        const size = Math.min(chunk.length, declared - attempted)
        socket.write(chunk.subarray(0, size))
        attempted += size
      }, 2)
    }
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      if (writeTimer !== undefined) clearInterval(writeTimer)
      const acceptedBytes = socket.bytesWritten
      socket.destroy()
      reject(
        new Error(
          `no refusal or close within 5000ms (accepted=${acceptedBytes} B, ` +
            `response=${received ? status : 'none'}, connection=${connection ?? 'none'})`
        )
      )
    }, 5000)
    socket.once('secureConnect', () => {
      socket.write(
        [
          `POST ${path} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Content-Type: application/json',
          'x-internal-token: wrong-token',
          `Content-Length: ${declared}`,
          'Connection: keep-alive',
          '',
          ''
        ].join('\r\n')
      )
    })
    socket.on('data', (data: Buffer) => {
      if (received) return
      headerBuffer = Buffer.concat([headerBuffer, data])
      const index = headerBuffer.indexOf('\r\n\r\n')
      if (index === -1) return
      const lines = headerBuffer.subarray(0, index).toString('latin1').split('\r\n')
      status = Number(lines[0]?.split(' ')[1] ?? 0)
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon === -1) continue
        if (line.slice(0, colon).trim().toLowerCase() === 'connection') {
          connection = line.slice(colon + 1).trim()
        }
      }
      received = true
      pump()
    })
    socket.on('close', () => {
      closed = true
      finish()
    })
    socket.on('error', () => {
      // Writing after the refusal is expected; close carries the verdict.
    })
  })
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
    saveEvidence(EVIDENCE, 'valid-client-success.json', {
      status: res.status,
      routes: body.routes.length
    })
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

  test(
    'U267: 内部通道 404 声明 2 MiB → 先可读、connection: close、消费远小于声明',
    { timeout: 8000 },
    async () => {
      const declared = 2 * 1024 * 1024
      const result = await pacedDeclaredTlsRequest('/v1/projects', declared)
      assert.equal(result.receivedResponse, true, 'the refusal must be readable')
      assert.equal(result.status, 404)
      assert.equal(result.connection, 'close', 'an unread oversized body must close')
      assert.equal(result.closed, true, 'the server did not close the connection')
      assert.ok(
        result.acceptedBytes < declared / 8,
        `the server accepted ${result.acceptedBytes} B of ${declared} B`
      )
      saveEvidence(EVIDENCE, 'unread-declared-close.json', {
        ...result,
        declared
      })
    }
  )

  test(
    'U267: 13 B chunked 未读 body → keep-alive，同 TLS 连接第二次请求可用',
    { timeout: 8000 },
    async () => {
      const socket = await openTlsSocket()
      const body = 'u267-chunk-13'
      assert.equal(Buffer.byteLength(body), 13)
      try {
        socket.write(
          [
            'POST /v1/internal/relay-routes HTTP/1.1',
            'Host: 127.0.0.1',
            'Content-Type: application/json',
            'x-internal-token: wrong-token',
            'Transfer-Encoding: chunked',
            'Connection: keep-alive',
            '',
            `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`
          ].join('\r\n')
        )
        const first = await readTlsResponse(socket, 3000, 'chunked 13 B refusal')
        assert.equal(first.status, 401)
        assert.notEqual(first.headers.connection, 'close', 'a small chunked body keeps keep-alive')

        socket.write(
          [
            'GET /v1/internal/relay-routes HTTP/1.1',
            'Host: 127.0.0.1',
            'x-internal-token: wrong-token',
            'Connection: keep-alive',
            '',
            ''
          ].join('\r\n')
        )
        const second = await readTlsResponse(socket, 3000, 'second request on the same TLS socket')
        assert.equal(
          second.status,
          401,
          'the refused chunked request must not wedge the connection'
        )
        saveEvidence(EVIDENCE, 'unread-chunked-reuse.json', {
          firstStatus: first.status,
          secondStatus: second.status,
          firstConnection: first.headers.connection ?? null
        })
      } finally {
        socket.destroy()
      }
    }
  )

  test(
    'U270: 内部通道 chunked 32 KiB 超 16 KiB 预算 → 401 可达后连接关闭',
    { timeout: 8000 },
    async (t) => {
      const socket = await openTlsSocket()
      const body = Buffer.alloc(32 * 1024, 'x')
      const preResponseShard = 8 * 1024
      const requestHead = [
        'POST /v1/internal/relay-routes HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        'x-internal-token: wrong-token',
        'Transfer-Encoding: chunked',
        'Connection: keep-alive',
        '',
        ''
      ].join('\r\n')
      try {
        const pending = readTlsResponse(socket, 4000, 'chunked 32 KiB over budget', {
          awaitClose: true,
          onResponse: () => {
            // Finish the one legal chunk and terminate; the tail crosses the drain bound.
            socket.write(body.subarray(preResponseShard))
            socket.write('\r\n')
            socket.write('0\r\n\r\n')
          }
        })
        socket.write(requestHead)
        socket.write(`${body.length.toString(16)}\r\n`)
        socket.write(body.subarray(0, preResponseShard))
        const result = await pending
        t.diagnostic(
          `32 KiB chunked: response=${result.responseMs}ms, ` +
            `close=${result.closeMs === null ? 'not closed' : `${result.closeMs}ms`}, ` +
            `bytesWrittenAtClose=${result.bytesWrittenAtClose}`
        )
        assert.equal(
          result.status,
          401,
          'the refusal is readable before the bound closes the socket'
        )
        assert.notEqual(
          result.headers.connection,
          'close',
          'chunked is not closed from the header alone'
        )
        assert.ok(
          result.closeMs !== null,
          'a chunked body past the 16 KiB bound must close the connection'
        )
        const closeMs = result.closeMs
        assert.ok(
          closeMs >= result.responseMs,
          `the refusal (${result.responseMs}ms) must precede the close (${closeMs}ms)`
        )
        // One legal frame: request head + size line + 32,768 B body + 2 B chunk
        // CRLF + 5 B terminator.
        const framedBytes =
          Buffer.byteLength(requestHead, 'latin1') +
          Buffer.byteLength(`${body.length.toString(16)}\r\n`, 'latin1') +
          body.length +
          2 +
          5
        assert.ok(
          result.bytesWrittenAtClose >= framedBytes &&
            result.bytesWrittenAtClose <= framedBytes + 1,
          `the whole legal frame reached the socket: ` +
            `${result.bytesWrittenAtClose} B vs ${framedBytes} B`
        )
        assert.ok(result.responseMs < 1000, `the refusal took ${result.responseMs}ms`)
        saveEvidence(EVIDENCE, 'unread-chunked-32k-close.json', {
          ...result,
          framedBytes
        })
      } finally {
        socket.destroy()
      }
    }
  )

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

  test('U43: announce POST 经 mTLS 携带请求体，平台收到并登记健康中继', async () => {
    // The relay announce used to arrive as an empty body -> 400 RELAY_PORT_INVALID.
    const res = await mtlsFetch(
      {
        internalUrl: `https://127.0.0.1:${internalPort}`,
        token: 'internal-test-token',
        keyPath: certs.relayKey,
        certPath: certs.relayCert,
        caPath: certs.ca
      },
      '/v1/internal/relay-endpoint',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'relay:18999', host: '127.0.0.1', port: 18999 })
      }
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok: boolean; id: string; healthyRelays: number }
    assert.equal(body.ok, true)
    assert.equal(body.id, 'relay:18999')
    assert.ok(body.healthyRelays >= 1)
    saveEvidence(EVIDENCE, 'u43-announce-body-received.json', body)
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
