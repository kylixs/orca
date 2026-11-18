import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { createApp, type ApiHandle } from '../src/server.ts'

/**
 * U264: the U258 pre-read close rule only covered the JSON exits. Static files,
 * OPTIONS and the other bare `writeHead/end` replies still drained an unread
 * 16 MiB body, and every chunked request was closed even when tiny. These tests
 * pin the single `writeHead` wrapper and the bounded chunked drain. U267/U269:
 * the chunked cases send legal frames (one size line per chunk); the over-budget
 * case pins the bound by the full framed byte count and close-after-response
 * order. Kept apart from auth-body-limit.test.ts, which another change is
 * editing concurrently.
 */

const ORIGIN = 'https://console.u264.example'
const INTERNAL_TOKEN = 'u264-token'
const DECLARED_16_MIB = 16 * 1024 * 1024
const DECLARED_2_MIB = 2 * 1024 * 1024
const LEGAL_REGISTER_BYTES = 32_889
const apps: ApiHandle[] = []

async function startApp(): Promise<string> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: INTERNAL_TOKEN,
    cookieMode: 'auto',
    publicOrigin: ORIGIN
  })
  apps.push(app)
  const port = await app.listen()
  return `http://127.0.0.1:${port}`
}

type RawResponse = {
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

type RawResponseOptions = {
  /** Keep listening after the response for the server-issued close. */
  awaitClose?: boolean
  /** Runs once the response is complete, before the awaited close arrives. */
  onResponse?: () => void
}

/** Reads one framed response off a raw socket (mirrors the U255 helper). */
function readRawResponse(
  socket: Socket,
  timeoutMs: number,
  label: string,
  options: RawResponseOptions = {}
): Promise<RawResponse> {
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
    let headers: Record<string, string> = {}
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
    const result = (): RawResponse => ({
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
        if (size === 0) {
          if (buffer.length < dataStart + 2) return false
          return true
        }
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
      if (!responseDone) maybeResolve()
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

async function connectRaw(base: string): Promise<Socket> {
  const url = new URL(base)
  const socket = connect(Number(url.port), url.hostname)
  socket.on('error', () => {
    // An EPIPE after the refusal is the expected outcome.
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('raw socket connect timed out'))
    }, 2000)
    socket.once('connect', () => {
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

/** One legal chunk: exactly one size line, the body split into shards, then CRLF. */
function chunkFrame(payload: Buffer, shardBytes: number): Buffer[] {
  const frames = [Buffer.from(`${payload.length.toString(16)}\r\n`, 'latin1')]
  for (let offset = 0; offset < payload.length; offset += shardBytes) {
    frames.push(payload.subarray(offset, offset + shardBytes))
  }
  frames.push(Buffer.from('\r\n', 'latin1'))
  return frames
}

function chunkedRequestHead(host: string, path: string): string {
  return [
    `POST ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Content-Type: application/json',
    'Transfer-Encoding: chunked',
    'Connection: keep-alive',
    '',
    ''
  ].join('\r\n')
}

const CHUNKED_TERMINATOR = '0\r\n\r\n'

/**
 * Declares a body, waits for the refusal computed from headers alone, then pumps
 * the declared bytes. A kept-alive connection accepts all of it; a closed one
 * accepts only what was already in flight.
 */
function pacedDeclaredRequest(
  base: string,
  method: string,
  path: string,
  declared: number
): Promise<{
  status: number
  connection: string | undefined
  receivedResponse: boolean
  closed: boolean
  responseMs: number
  closeMs: number
  acceptedBytes: number
  attemptedBytes: number
}> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const url = new URL(base)
    const socket = connect(Number(url.port), url.hostname)
    const chunk = Buffer.alloc(32 * 1024, 'x')
    let attempted = 0
    let status = 0
    let connection: string | undefined
    let responseMs = 0
    let closeMs = 0
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
      resolve({
        status,
        connection,
        responseMs,
        closeMs,
        receivedResponse: received,
        closed,
        acceptedBytes,
        attemptedBytes: attempted
      })
    }
    const pump = (): void => {
      writeTimer = setInterval(() => {
        if (closed || attempted >= declared) {
          if (writeTimer !== undefined) clearInterval(writeTimer)
          if (attempted >= declared) finish()
          return
        }
        const size = Math.min(chunk.length, declared - attempted)
        try {
          socket.write(chunk.subarray(0, size))
          attempted += size
        } catch {
          // Writing after the reset is the expected outcome.
        }
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
          `${method} ${path}: neither the refusal nor the close settled within 5000ms ` +
            `(accepted=${acceptedBytes} B, attempted=${attempted} B, ` +
            `response=${received ? status : 'none'}, connection=${connection ?? 'none'}, ` +
            `closed=${closed})`
        )
      )
    }, 5000)
    socket.once('connect', () => {
      socket.write(
        [
          `${method} ${path} HTTP/1.1`,
          `Host: ${url.host}`,
          'Content-Type: application/json',
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
      responseMs = Date.now() - started
      if (closed) finish()
      else pump()
    })
    socket.on('close', () => {
      closed = true
      closeMs = Date.now() - started
      finish()
    })
    socket.on('error', () => {
      // Writing after the refusal is expected; the close carries the verdict.
    })
  })
}

function assertUnreadBodyClosed(
  label: string,
  result: {
    status: number
    connection: string | undefined
    receivedResponse: boolean
    closed: boolean
    responseMs: number
    closeMs: number
    acceptedBytes: number
    attemptedBytes: number
  },
  expectedStatus: number,
  declared: number
): void {
  assert.equal(result.receivedResponse, true, `${label}: the refusal must be readable`)
  assert.equal(result.status, expectedStatus, `${label}: status`)
  assert.equal(
    result.connection,
    'close',
    `${label}: an unread oversized body must not keep the connection ` +
      `(accepted=${result.acceptedBytes} B)`
  )
  assert.equal(result.closed, true, `${label}: the server did not close the connection`)
  assert.ok(
    result.acceptedBytes < declared / 8,
    `${label}: the server accepted ${result.acceptedBytes} B of ${declared} B`
  )
  assert.ok(result.responseMs < 1000, `${label}: the refusal took ${result.responseMs}ms`)
  assert.ok(result.closeMs < 1500, `${label}: the close took ${result.closeMs}ms`)
}

type Json = Record<string, unknown>

function agentRequest(
  agent: Agent,
  url: string,
  method: string,
  body?: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; reused: boolean; payload: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method,
        agent,
        headers: {
          'content-type': 'application/json',
          ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            reused: req.reusedSocket,
            payload: Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function login(base: string, device: string): Promise<string> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: device })
  })
  assert.equal(res.status, 200, 'admin must log in')
  return String(((await res.json()) as Json).accessToken ?? '')
}

async function mintHostToken(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 201, 'an admin may mint a host registration token')
  return String(((await res.json()) as Json).token ?? '')
}

/** U256: an ASCII register body of an exact byte length (the U264 legal-body pin). */
function registerBodyOfBytes(name: string, totalBytes: number): string {
  const prefix = `{"name":"${name}","fingerprint":"sha256:${name}","protocolVersion":3,"networkZone":"intranet","pad":"`
  const suffix = '"}'
  const pad = 'x'.repeat(totalBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))
  const body = `${prefix}${pad}${suffix}`
  assert.equal(Buffer.byteLength(body), totalBytes, 'the fixture must land on the exact length')
  return body
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U264 非 JSON 出口的读取前关闭', () => {
  test('未认证 GET 不存在的静态页声明 16 MiB → 404、消费远小于声明、连接关闭', { timeout: 8000 }, async () => {
    const base = await startApp()
    const result = await pacedDeclaredRequest(base, 'GET', '/definitely-not-a-page', DECLARED_16_MIB)
    assertUnreadBodyClosed('static 404', result, 404, DECLARED_16_MIB)
  })

  test('未认证 OPTIONS /v1/projects 声明 2 MiB → 204、消费远小于声明、连接关闭', { timeout: 8000 }, async () => {
    const base = await startApp()
    const result = await pacedDeclaredRequest(base, 'OPTIONS', '/v1/projects', DECLARED_2_MIB)
    assertUnreadBodyClosed('cors preflight', result, 204, DECLARED_2_MIB)
  })

  test('OPTIONS 的小 body 仍保持 keep-alive：同连接继续可用', { timeout: 5000 }, async () => {
    const base = await startApp()
    const url = new URL(base)
    const socket = await connectRaw(base)
    const smallBody = '{"small":1}'
    try {
      socket.write(
        [
          'OPTIONS /v1/projects HTTP/1.1',
          `Host: ${url.host}`,
          `Content-Length: ${Buffer.byteLength(smallBody)}`,
          'Connection: keep-alive',
          '',
          smallBody
        ].join('\r\n')
      )
      const first = await readRawResponse(socket, 2000, 'small OPTIONS')
      assert.equal(first.status, 204)
      assert.notEqual(first.headers.connection, 'close', 'a small unread body keeps keep-alive')

      socket.write(
        ['GET /health HTTP/1.1', `Host: ${url.host}`, 'Connection: keep-alive', '', ''].join('\r\n')
      )
      const second = await readRawResponse(socket, 2000, 'health on the same connection')
      assert.equal(second.status, 200, 'the same connection serves the next request')
    } finally {
      socket.destroy()
    }
  })
})

describe('U264 chunked 有界排空', () => {
  test('13 B chunked 的 401：合法帧、同连接第二次请求 200', { timeout: 5000 }, async () => {
    const base = await startApp()
    const url = new URL(base)
    const socket = await connectRaw(base)
    const body = Buffer.from('u264-small-13', 'utf8')
    assert.equal(body.length, 13)
    try {
      socket.write(chunkedRequestHead(url.host, '/v1/projects'))
      for (const frame of chunkFrame(body, 5)) socket.write(frame)
      socket.write(CHUNKED_TERMINATOR)
      const first = await readRawResponse(socket, 2000, 'chunked small 401')
      assert.equal(first.status, 401)
      assert.notEqual(first.headers.connection, 'close', 'a small chunked body keeps keep-alive')

      socket.write(
        ['GET /health HTTP/1.1', `Host: ${url.host}`, 'Connection: keep-alive', '', ''].join('\r\n')
      )
      const second = await readRawResponse(socket, 2000, 'health on the same connection')
      assert.equal(second.status, 200, 'the refused chunked request must not wedge the connection')
      assert.deepEqual(second.errors, [], 'the reused connection sees no client-side error')
    } finally {
      socket.destroy()
    }
  })

  test('15 KiB chunked 在 16 KiB 预算内：keep-alive，同连接 GET /health 200', { timeout: 5000 }, async () => {
    const base = await startApp()
    const url = new URL(base)
    const socket = await connectRaw(base)
    const body = Buffer.alloc(15 * 1024, 'x')
    try {
      socket.write(chunkedRequestHead(url.host, '/v1/projects'))
      for (const frame of chunkFrame(body, 4 * 1024)) socket.write(frame)
      socket.write(CHUNKED_TERMINATOR)
      const first = await readRawResponse(socket, 2000, 'chunked 15 KiB 401')
      assert.equal(first.status, 401)
      assert.notEqual(first.headers.connection, 'close', 'within-budget chunked keeps keep-alive')

      socket.write(
        ['GET /health HTTP/1.1', `Host: ${url.host}`, 'Connection: keep-alive', '', ''].join('\r\n')
      )
      const second = await readRawResponse(socket, 2000, 'health after 15 KiB chunked')
      assert.equal(second.status, 200, '15 KiB is inside the drain budget')
      assert.deepEqual(second.errors, [], 'the reused connection sees no client-side error')
    } finally {
      socket.destroy()
    }
  })

  test('32 KiB chunked 超过 16 KiB 预算：401 可达后连接关闭', { timeout: 8000 }, async (t) => {
    const base = await startApp()
    const url = new URL(base)
    const socket = await connectRaw(base)
    const body = Buffer.alloc(32 * 1024, 'x')
    const preResponseShard = 8 * 1024
    try {
      const pending = readRawResponse(socket, 4000, 'chunked 32 KiB over budget', {
        awaitClose: true,
        onResponse: () => {
          // Finish the one legal chunk and terminate; the tail crosses the drain bound.
          socket.write(body.subarray(preResponseShard))
          socket.write('\r\n')
          socket.write(CHUNKED_TERMINATOR)
        }
      })
      const requestHead = chunkedRequestHead(url.host, '/v1/projects')
      socket.write(requestHead)
      socket.write(`${body.length.toString(16)}\r\n`)
      socket.write(body.subarray(0, preResponseShard))
      const result = await pending
      t.diagnostic(
        `32 KiB chunked: response=${result.responseMs}ms, ` +
          `close=${result.closeMs === null ? 'not closed' : `${result.closeMs}ms`}, ` +
          `bytesWrittenAtClose=${result.bytesWrittenAtClose}`
      )
      assert.equal(result.status, 401, 'the refusal is readable before the bound closes the socket')
      assert.notEqual(result.headers.connection, 'close', 'chunked is not closed from the header alone')
      assert.ok(
        result.closeMs !== null,
        'a chunked body past the 16 KiB bound must close the connection'
      )
      const closeMs = result.closeMs
      assert.ok(
        closeMs >= result.responseMs,
        `the refusal (${result.responseMs}ms) must precede the close (${closeMs}ms)`
      )
      // One legal frame: head (136/137 B for a 4/5-digit port) + 6 B size line
      // + 32,768 B body + 2 B chunk CRLF + 5 B terminator = 32,917/32,918 B.
      const framedBytes =
        Buffer.byteLength(requestHead, 'latin1') +
        Buffer.byteLength(`${body.length.toString(16)}\r\n`, 'latin1') +
        body.length +
        2 +
        5
      assert.ok(
        result.bytesWrittenAtClose >= framedBytes && result.bytesWrittenAtClose <= framedBytes + 1,
        `the whole legal frame reached the socket: ` +
          `${result.bytesWrittenAtClose} B vs ${framedBytes} B`
      )
      assert.ok(result.responseMs < 1000, `the refusal took ${result.responseMs}ms`)
    } finally {
      socket.destroy()
    }
  })
})

describe('U264 合法大 body 不受影响', () => {
  test('32,889 B register 仍 201，且同一 keep-alive 连接复用', { timeout: 8000 }, async () => {
    const base = await startApp()
    const token = await login(base, 'u264-register-admin')
    const hostToken = await mintHostToken(base, token)
    const body = registerBodyOfBytes('u264-legal-register', LEGAL_REGISTER_BYTES)
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      const registered = await agentRequest(agent, `${base}/v1/hosts/register`, 'POST', body, {
        authorization: `Bearer ${hostToken}`
      })
      assert.equal(registered.status, 201, registered.payload)
      assert.equal(registered.reused, false)

      const health = await agentRequest(agent, `${base}/health`, 'GET')
      assert.equal(health.status, 200)
      assert.equal(health.reused, true, 'a legal read-after-auth body keeps the connection usable')
    } finally {
      agent.destroy()
    }
  })
})
