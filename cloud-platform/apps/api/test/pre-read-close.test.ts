import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { createApp, type ApiHandle } from '../src/server.ts'

/**
 * U264: the U258 pre-read close rule only covered the JSON exits. Static files,
 * OPTIONS and the other bare `writeHead/end` replies still drained an unread
 * 16 MiB body, and every chunked request was closed even when tiny. These tests
 * pin the single `writeHead` wrapper and the bounded chunked drain. Kept apart
 * from auth-body-limit.test.ts, which another change is editing concurrently.
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

type RawResponse = { status: number; headers: Record<string, string>; body: string }

/** Reads one framed response off a raw socket (mirrors the U255 helper). */
function readRawResponse(socket: Socket, timeoutMs: number, label: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let headerEnd = -1
    let expectedBody = 0
    let chunked = false
    let chunkCursor = 0
    let chunkedBody = Buffer.alloc(0)
    let status = 0
    let headers: Record<string, string> = {}
    let done = false
    const cleanup = (): void => {
      done = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      socket.off('error', onError)
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
      if (done || headerEnd === -1) return
      if (chunked) {
        if (!consumeChunked()) return
        cleanup()
        resolve({ status, headers, body: chunkedBody.toString('utf8') })
        return
      }
      if (buffer.length - headerEnd < expectedBody) return
      cleanup()
      resolve({
        status,
        headers,
        body: buffer.subarray(headerEnd, headerEnd + expectedBody).toString('utf8')
      })
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
      maybeResolve()
      if (done) return
      cleanup()
      reject(new Error(`${label}: socket closed before a complete response`))
    }
    const onError = (error: Error): void => {
      if (done) return
      maybeResolve()
      if (done) return
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => {
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
  test('未认证 GET 不存在的静态页声明 16 MiB → 404、消费远小于声明、连接关闭', async () => {
    const base = await startApp()
    const result = await pacedDeclaredRequest(base, 'GET', '/definitely-not-a-page', DECLARED_16_MIB)
    assertUnreadBodyClosed('static 404', result, 404, DECLARED_16_MIB)
  }, { timeout: 8000 })

  test('未认证 OPTIONS /v1/projects 声明 2 MiB → 204、消费远小于声明、连接关闭', async () => {
    const base = await startApp()
    const result = await pacedDeclaredRequest(base, 'OPTIONS', '/v1/projects', DECLARED_2_MIB)
    assertUnreadBodyClosed('cors preflight', result, 204, DECLARED_2_MIB)
  }, { timeout: 8000 })

  test('OPTIONS 的小 body 仍保持 keep-alive：同连接继续可用', async () => {
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
  }, { timeout: 5000 })
})

describe('U264 chunked 小体量保持 keep-alive', () => {
  test('13 B chunked 的 401：不关闭连接，同连接第二次请求成功', async () => {
    const base = await startApp()
    const url = new URL(base)
    const socket = await connectRaw(base)
    const body = 'u264-small-13'
    assert.equal(Buffer.byteLength(body), 13)
    try {
      socket.write(
        [
          'POST /v1/projects HTTP/1.1',
          `Host: ${url.host}`,
          'Content-Type: application/json',
          'Transfer-Encoding: chunked',
          'Connection: keep-alive',
          '',
          `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`
        ].join('\r\n')
      )
      const first = await readRawResponse(socket, 2000, 'chunked small 401')
      assert.equal(first.status, 401)
      assert.notEqual(first.headers.connection, 'close', 'a small chunked body keeps keep-alive')

      socket.write(
        ['GET /health HTTP/1.1', `Host: ${url.host}`, 'Connection: keep-alive', '', ''].join('\r\n')
      )
      const second = await readRawResponse(socket, 2000, 'health on the same connection')
      assert.equal(second.status, 200, 'the refused chunked request must not wedge the connection')
    } finally {
      socket.destroy()
    }
  }, { timeout: 5000 })

  test('超过 16 KiB 的 chunked 未读 body：拒绝后可读，连接最终被关闭', async () => {
    const base = await startApp()
    const socket = await connectRaw(base)
    const url = new URL(base)
    let closed = false
    socket.on('close', () => {
      closed = true
    })
    try {
      socket.write(
        [
          'POST /v1/projects HTTP/1.1',
          `Host: ${url.host}`,
          'Content-Type: application/json',
          'Transfer-Encoding: chunked',
          'Connection: keep-alive',
          '',
          '8000\r\n'
        ].join('\r\n')
      )
      const first = await new Promise<{ status: number; connection: string | undefined }>(
        (resolve, reject) => {
          let buffer = Buffer.alloc(0)
          const timer = setTimeout(() => reject(new Error('no refusal within 2000ms')), 2000)
          const onData = (data: Buffer): void => {
            buffer = Buffer.concat([buffer, data])
            const index = buffer.indexOf('\r\n\r\n')
            if (index === -1) return
            socket.off('data', onData)
            clearTimeout(timer)
            const lines = buffer.subarray(0, index).toString('latin1').split('\r\n')
            const status = Number(lines[0]?.split(' ')[1] ?? 0)
            const connection = lines
              .slice(1)
              .find((line) => line.toLowerCase().startsWith('connection:'))
              ?.slice('connection:'.length)
              .trim()
            resolve({ status, connection })
          }
          socket.on('data', onData)
        }
      )
      assert.equal(first.status, 401, 'the refusal is sent before the body is drained')
      assert.notEqual(first.connection, 'close', 'chunked is not closed from the header alone')

      // Keep the stream going well past the drain bound; the server must destroy.
      const payload = Buffer.alloc(32 * 1024, 'x')
      for (let index = 0; index < 8 && !closed; index += 1) {
        try {
          socket.write(`${payload.length.toString(16)}\r\n`)
          socket.write(payload)
          socket.write('\r\n')
        } catch {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(closed, true, 'a chunked stream past the bound must end the connection')
    } finally {
      socket.destroy()
    }
  }, { timeout: 8000 })
})

describe('U264 合法大 body 不受影响', () => {
  test('32,889 B register 仍 201，且同一 keep-alive 连接复用', async () => {
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
  }, { timeout: 8000 })
})
