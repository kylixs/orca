import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { createApp, type ApiHandle } from '../src/server.ts'
import { AUDIT_EVENT_MAX_BYTES, AUDIT_METADATA_MAX_BYTES } from '../src/audit.ts'
import { startAuditWriter, type AuditWriter } from '../../audit-writer/src/writer.ts'

/**
 * U249 P3-7: the unauthenticated login/refresh bodies were read without a cap.
 * They now share the logout limit and answer 413 before parsing, while a normal
 * (or long-token) request keeps working.
 */

const ORIGIN = 'https://console.u249.example'
const AUTH_BODY_MAX_BYTES = 16 * 1024
const INTERNAL_BODY_MAX_BYTES = 8 * 1024
const SENSITIVE_WRITE_BODY_MAX_BYTES = 16 * 1024
const REGISTER_BODY_MAX_BYTES = 64 * 1024
const DENIED_AUDIT_BODY_MAX_BYTES = 4 * 1024
const HEARTBEAT_BODY_MAX_BYTES = 1024 * 1024
const FILE_EVENT_METADATA_LIMIT = 4096
const PROJECT_PATH_MAX_CHARS = 4096
/** U257: register names are indexed and audited, so they share ingest's bound. */
const HOST_NAME_MAX_CHARS = 128
const INTERNAL_TOKEN = 'u249-token'
const PROJECT_ID = 'proj_payment'
const HOST_ID = 'host_dev001'
const apps: ApiHandle[] = []
const writers: AuditWriter[] = []

async function startApp(): Promise<{ app: ApiHandle; base: string }> {
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
  return { app, base: `http://127.0.0.1:${port}` }
}

async function start(): Promise<string> {
  return (await startApp()).base
}

/** U254: the regression only exists behind the shared writer's 16 KiB event cap. */
async function startAppWithWriter(): Promise<{
  app: ApiHandle
  base: string
  writer: AuditWriter
}> {
  const writer = await startAuditWriter({ port: 0, internalToken: INTERNAL_TOKEN })
  writers.push(writer)
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    internalToken: INTERNAL_TOKEN,
    cookieMode: 'auto',
    publicOrigin: ORIGIN,
    auditWriterUrl: `http://127.0.0.1:${writer.port}`
  })
  apps.push(app)
  const port = await app.listen()
  return { app, base: `http://127.0.0.1:${port}`, writer }
}

type Json = Record<string, unknown>

function login(base: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
}

function refresh(base: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
}

function oversized(fields: Record<string, unknown>): string {
  // Comfortably above the cap; the old code buffered all of it before parsing.
  return JSON.stringify({ ...fields, pad: 'x'.repeat(AUTH_BODY_MAX_BYTES * 4) })
}

function postInternal(base: string, path: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body
  })
}

function errorCode(body: Json): unknown {
  const error = body.error
  return error !== null && typeof error === 'object' ? (error as Json).code : undefined
}

async function loginAs(
  base: string,
  username: string,
  password: string,
  device: string
): Promise<{ token: string; userId: string }> {
  const res = await login(base, JSON.stringify({ username, password, deviceName: device }))
  assert.equal(res.status, 200, `${username} must log in`)
  const body = (await res.json()) as Json
  const user = body.user as Json | undefined
  return { token: String(body.accessToken ?? ''), userId: String(user?.id ?? '') }
}

function authedJson(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: string
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body })
  })
}

function oversizedBody(fields: Record<string, unknown>): string {
  // The named fields stay legible in the JSON; only the cap decides they are ignored.
  return JSON.stringify({ ...fields, pad: 'x'.repeat(SENSITIVE_WRITE_BODY_MAX_BYTES * 2) })
}

function oversizedRegisterBody(fields: Record<string, unknown>): string {
  // Registration now has its own cap, so the 16 KiB shape above is legal.
  return JSON.stringify({ ...fields, pad: 'x'.repeat(REGISTER_BODY_MAX_BYTES * 2) })
}

/**
 * U252: the registration contract allows 200 projectDirs; a name may reach the
 * filesystem's 255 B limit, so the legal maximum measured ~52 KiB.
 */
function legalMaxRegistration(): { body: string; dirs: string[] } {
  const dirs = Array.from({ length: 200 }, (_, index) => {
    const prefix = `dir${String(index).padStart(3, '0')}`
    return `${prefix}${'d'.repeat(255 - prefix.length)}`
  })
  const body = JSON.stringify({
    name: 'u252-max-register',
    fingerprint: 'sha256:u252-max-register',
    protocolVersion: 3,
    networkZone: 'intranet',
    projectDirs: dirs
  })
  return { body, dirs }
}

function pathOfLength(length: number): string {
  return `/${'p'.repeat(length - 1)}`
}

/** U256: an ASCII register body of an exact byte length, to pin the cap boundary. */
function registerBodyOfBytes(name: string, totalBytes: number): string {
  const prefix = `{"name":"${name}","fingerprint":"sha256:${name}","protocolVersion":3,"networkZone":"intranet","pad":"`
  const suffix = '"}'
  const pad = 'x'.repeat(totalBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))
  const body = `${prefix}${pad}${suffix}`
  assert.equal(Buffer.byteLength(body), totalBytes, 'the fixture must land on the exact boundary')
  return body
}

function repoUrlOfLength(length: number): string {
  const prefix = 'https://git.example.com/'
  const suffix = '.git'
  return `${prefix}${'r'.repeat(length - prefix.length - suffix.length)}${suffix}`
}

async function mintHostToken(base: string, token: string): Promise<string> {
  const res = await authedJson(base, token, 'POST', '/v1/hosts/tokens')
  assert.equal(res.status, 201, 'an admin may mint a host registration token')
  return String(((await res.json()) as Json).token ?? '')
}

function registerHost(base: string, token: string, body: string): Promise<Response> {
  return fetch(`${base}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body
  })
}

function postHeartbeat(
  base: string,
  hostId: string,
  credential: string,
  body: string
): Promise<Response> {
  return fetch(`${base}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body
  })
}

/**
 * U251: the largest beat a current host can legally send — 100 file events whose
 * metadata sits near the platform's 4096 B per-event cap, 200 projectDirs (200 B
 * names), and 32 provision reports (500 B errors). Every shape comes from the
 * upstream producers: `cloud-host-audit.ts` (100/beat), `cloud-project-dirs.ts`
 * (200 names), and `cloud-provision-report-queue.ts` (32 reports).
 */
function legalMaxHeartbeat(): string {
  const metadata = {
    hostId: 'h'.repeat(128),
    hostName: 'n'.repeat(128),
    projectKey: 'p'.repeat(128),
    method: 'm'.repeat(128),
    kind: 'k'.repeat(128),
    surface: 's'.repeat(128),
    capturePoint: 'c'.repeat(128),
    captureConfidence: 'c'.repeat(128),
    copyKind: 'c'.repeat(128),
    policy: 'p'.repeat(128),
    reason: 'r'.repeat(128),
    mime: 'm'.repeat(128),
    clientVersion: 'v'.repeat(64),
    fileName: 'f'.repeat(255),
    savedName: 's'.repeat(255),
    path: 'd'.repeat(1024),
    sizeBytes: Number.MAX_SAFE_INTEGER,
    copiedChars: Number.MAX_SAFE_INTEGER,
    copiedBytes: Number.MAX_SAFE_INTEGER,
    itemCount: Number.MAX_SAFE_INTEGER,
    occurredAt: Number.MAX_SAFE_INTEGER,
    isBinary: true,
    truncated: true,
    excerptTruncated: false,
    sha256: 'a'.repeat(64),
    sha256Source: 'host'
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(metadata)) <= FILE_EVENT_METADATA_LIMIT,
    'the fixture metadata must stay inside the per-event cap or the event is dropped'
  )

  const audit = Array.from({ length: 100 }, (_, index) => ({
    eventType: 'file_download',
    result: 'success',
    deviceId: `device_u251_${index}`,
    subject: 'user:zhangsan',
    projectId: PROJECT_ID,
    method: 'GET',
    traceId: `trace_u251_${index}`,
    metadata
  }))
  const projectDirs = Array.from(
    { length: 200 },
    (_, index) => `dir${String(index).padStart(3, '0')}${'d'.repeat(194)}`
  )
  const provisioned = Array.from({ length: 32 }, (_, index) => ({
    projectId: `proj_u251_${index}`,
    ok: false,
    error: 'e'.repeat(500)
  }))

  return JSON.stringify({
    status: 'online',
    directAddrs: ['192.168.10.10:5210'],
    projectDirs,
    provisioned,
    audit,
    orcaVersion: '1.5.0'
  })
}

async function deniedAuditEvents(base: string, token: string, actor: string): Promise<Json[]> {
  const query = new URLSearchParams({ actor, result: 'denied', limit: '200' })
  const res = await authedJson(base, token, 'GET', `/v1/audit/events?${query.toString()}`)
  assert.equal(res.status, 200, 'audit query must be available to the admin')
  const body = (await res.json()) as Json
  return (body.events as Json[] | undefined) ?? []
}

/** U257: `appendBestEffort` over the remote client is fire-and-forget. */
async function waitForAuditEvent(
  base: string,
  token: string,
  params: Record<string, string>,
  predicate: (event: Json) => boolean
): Promise<Json> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const query = new URLSearchParams({ limit: '200', ...params })
    const res = await authedJson(base, token, 'GET', `/v1/audit/events?${query.toString()}`)
    assert.equal(res.status, 200, 'audit query must be available to the admin')
    const events = (((await res.json()) as Json).events as Json[] | undefined) ?? []
    const found = events.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail('the expected audit event never reached the chain')
}

function redeemHandoff(
  base: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${base}/v1/web/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
}

function seedHandoff(app: ApiHandle, code: string): void {
  const user = app.store.usersByName.get('zhangsan')
  assert.ok(user)
  app.store.webHandoffs.set(code, {
    userId: user.id,
    projectId: 'proj_payment',
    expiresAt: Date.now() + 60_000
  })
}

/**
 * U251: declares `content-length` above the cap but only writes a prefix. The
 * server must answer from the header alone, without waiting for the body.
 */
function declaredOversizedRequest(
  base: string,
  path: string,
  declared: number
): Promise<{ status: number; connection: string | undefined; body: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const req = httpRequest(
      `${base}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(declared) }
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          const elapsedMs = Date.now() - started
          clearTimeout(deadline)
          req.destroy()
          resolve({
            status: res.statusCode ?? 0,
            connection: res.headers.connection,
            body,
            elapsedMs
          })
        })
      }
    )
    // A server that waits for the rest of the declared body must fail, not hang.
    const deadline = setTimeout(() => {
      req.destroy()
      reject(new Error('no 413 before the deadline: the server waited for the full body'))
    }, 1500)
    req.on('error', reject)
    req.write('{"username":"admin"')
  })
}

/**
 * U251: streams a chunked body (no `content-length`) past the cap until the
 * server closes. Reports when the 413 and the socket close arrived.
 */
function streamingOversizedRequest(
  base: string,
  path: string
): Promise<{
  status: number
  connection: string | undefined
  responseMs: number
  closeMs: number
  sentBytes: number
}> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let status = 0
    let connection: string | undefined
    let responseMs = 0
    let closeMs = 0
    let sentBytes = 0
    let headersReceived = false
    let socketClosed = false
    let settled = false
    const finish = (): void => {
      if (!headersReceived || !socketClosed || settled) return
      settled = true
      clearInterval(writeTimer)
      clearTimeout(deadline)
      resolve({ status, connection, responseMs, closeMs, sentBytes })
    }
    const req = httpRequest(
      `${base}${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        responseMs = Date.now() - started
        status = res.statusCode ?? 0
        connection = res.headers.connection
        headersReceived = true
        // The refusal arrived: stop feeding the stream and let the socket close.
        clearInterval(writeTimer)
        res.resume()
        finish()
      }
    )
    req.on('socket', (socket) => {
      socket.once('close', () => {
        closeMs = Date.now() - started
        socketClosed = true
        finish()
      })
    })
    // A reset after the headers is expected; only an early failure is fatal.
    req.on('error', (error: Error) => {
      if (headersReceived || settled) return
      clearInterval(writeTimer)
      clearTimeout(deadline)
      reject(error)
    })
    const chunk = Buffer.alloc(8 * 1024, 'x')
    const writeTimer = setInterval(() => {
      if (headersReceived) return
      try {
        req.write(chunk)
        sentBytes += chunk.length
      } catch {
        // Writing after the reset is the expected outcome.
      }
    }, 2)
    // A server that drains the whole stream must fail, not hang.
    const deadline = setTimeout(() => {
      clearInterval(writeTimer)
      req.destroy()
      reject(new Error('no 413 before the deadline: the stream was drained to completion'))
    }, 2000)
  })
}

function agentPost(
  agent: Agent,
  url: string,
  body: string
): Promise<{ status: number; reused: boolean }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        agent,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body))
        }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

type RawResponse = { status: number; headers: Record<string, string>; body: string }

/**
 * U255: reads one response off a raw socket. The socket has to stay observable:
 * the assertion is whether the server closed it or left a half-read body, which
 * a client helper that owns the connection can tell apart.
 */
function readRawResponse(
  socket: Socket,
  timeoutMs: number,
  label: string
): Promise<RawResponse> {
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
    // Server responses use chunked encoding: json() calls writeHead without a
    // content-length, so the body length is only known at the framing level.
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

function waitForClose(socket: Socket, timeoutMs: number): Promise<void> {
  if (socket.destroyed) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('close', onClose)
      reject(new Error('the server did not close the refused connection'))
    }, timeoutMs)
    const onClose = (): void => {
      clearTimeout(timer)
      resolve()
    }
    socket.once('close', onClose)
  })
}

/**
 * U255: declares a body far over the cap and keeps writing until the server
 * either accepts the whole declaration (the bug: Node dumps the request on
 * response finish) or closes. `flushedAll`/`flushedBytes` are the side channel
 * proving whether the declared payload was actually pushed through.
 */
function declaredHugeRawRequest(
  base: string,
  path: string,
  declared: number,
  headers: Record<string, string>,
  method = 'POST',
  settleOnResponse = false
): Promise<{
  status: number
  connection: string | undefined
  body: string
  responseMs: number
  closeMs: number
  flushedBytes: number
  flushedAll: boolean
}> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const url = new URL(base)
    const socket = connect(Number(url.port), url.hostname)
    const chunk = Buffer.alloc(64 * 1024, 'x')
    let written = 0
    let flushedAll = false
    let response: RawResponse | undefined
    let responseMs = 0
    let closeMs = 0
    let settled = false
    const settle = (): void => {
      if (settled || !response) return
      if (!settleOnResponse && !flushedAll && closeMs === 0) return
      settled = true
      clearTimeout(deadline)
      // Capture before destroy: it is the only client-side view of what the
      // server was willing to accept.
      const flushedBytes = socket.bytesWritten
      socket.destroy()
      resolve({
        status: response.status,
        connection: response.headers.connection,
        body: response.body,
        responseMs,
        closeMs,
        flushedBytes,
        flushedAll
      })
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket.destroy()
      reject(error)
    }
    const deadline = setTimeout(() => {
      fail(
        new Error(
          `${method} ${path}: the declared overage was neither answered nor closed within 3000ms ` +
            `(flushed=${socket.bytesWritten} B, response=${response ? response.status : 'none'}, ` +
            `connection=${response?.headers.connection ?? 'none'})`
        )
      )
    }, 3000)
    socket.on('error', () => {
      // Writing after the refusal is expected; the close carries the verdict.
    })
    socket.on('close', () => {
      closeMs = Date.now() - started
      settle()
    })
    void readRawResponse(socket, 3000, 'declared overage').then((res) => {
      response = res
      responseMs = Date.now() - started
      settle()
    }, fail)
    const pump = (): void => {
      if (settled || written >= declared) return
      const size = Math.min(chunk.length, declared - written)
      written += size
      let accepted = true
      try {
        accepted = socket.write(chunk.subarray(0, size))
      } catch {
        return
      }
      if (written >= declared) {
        flushedAll = true
        settle()
        return
      }
      if (accepted) {
        setImmediate(pump)
      } else {
        socket.once('drain', pump)
      }
    }
    socket.once('connect', () => {
      const lines = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${url.host}`,
        'Content-Type: application/json',
        `Content-Length: ${declared}`,
        'Connection: keep-alive',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)
      ]
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      pump()
    })
  })
}

/**
 * U258: declares 16 MiB, waits for the refusal from the header alone, and only
 * then pumps the declared body. That ordering is what makes the bug legible —
 * a kept-alive connection drains the whole 16 MiB after the 401, while a closed
 * one accepts almost none — and it also avoids racing the server's reset with
 * the response bytes. The pump is paced so neither kernel buffer can mask how
 * much the server is willing to take.
 */
function pacedDeclaredBodyRequest(
  base: string,
  path: string,
  declared: number,
  headers: Record<string, string> = {}
): Promise<{
  status: number
  connection: string | undefined
  responseMs: number
  closeMs: number
  receivedResponse: boolean
  closed: boolean
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
      // Captured before destroy: the client-side view of how much the server
      // was willing to take (the audit's own measurement basis).
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
          `POST ${path}: neither the refusal nor the close settled within 5000ms ` +
            `(accepted=${acceptedBytes} B, attempted=${attempted} B, ` +
            `response=${received ? status : 'none'}, connection=${connection ?? 'none'}, ` +
            `closed=${closed})`
        )
      )
    }, 5000)
    socket.once('connect', () => {
      socket.write(
        [
          `POST ${path} HTTP/1.1`,
          `Host: ${url.host}`,
          'Content-Type: application/json',
          `Content-Length: ${declared}`,
          'Connection: keep-alive',
          ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
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

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
  await Promise.all(writers.map((writer) => writer.close()))
})

describe('U250 /v1/web/handoff body 上限（未认证）', () => {
  test('合法交接码 2xx（回归）', async () => {
    const { app, base } = await startApp()
    seedHandoff(app, 'u250-valid')

    const res = await redeemHandoff(
      base,
      JSON.stringify({ code: 'u250-valid', deviceName: 'u250' })
    )

    assert.equal(res.status, 200)
    const body = (await res.json()) as Json
    assert.equal((body.user as Json).username, 'zhangsan')
    assert.equal(app.store.webHandoffs.has('u250-valid'), false, 'a redeemed code is consumed')
  })

  test('超大 body → 413 PAYLOAD_TOO_LARGE，且不消耗交接码', async () => {
    const { app, base } = await startApp()
    seedHandoff(app, 'u250-keep')

    const res = await redeemHandoff(base, oversized({ code: 'u250-keep', deviceName: 'u250' }))

    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.ok(app.store.webHandoffs.has('u250-keep'), 'the code must survive an oversized request')

    const again = await redeemHandoff(base, JSON.stringify({ code: 'u250-keep' }))
    assert.equal(again.status, 200, 'the untouched code still redeems')
  })

  test('有无有效凭据行为一致：未知码、重复 Cookie 同样 413，不泄露凭据状态', async () => {
    const { app, base } = await startApp()
    seedHandoff(app, 'u250-known')

    const known = await redeemHandoff(base, oversized({ code: 'u250-known' }))
    const unknown = await redeemHandoff(base, oversized({ code: 'u250-unknown' }))
    // The cap runs before the Cookie-state checks, so a request that would
    // otherwise be a Cookie 401 is still a content-size 413.
    const ambiguousCookie = await redeemHandoff(base, oversized({ code: 'u250-known' }), {
      cookie: 'orca_refresh=a; orca_refresh=b'
    })

    assert.equal(known.status, 413)
    assert.equal(unknown.status, 413)
    assert.equal(ambiguousCookie.status, 413)
    assert.equal(errorCode((await known.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(errorCode((await unknown.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.ok(app.store.webHandoffs.has('u250-known'), 'neither request may consume the code')
  })
})

describe('U249 未认证 login/refresh body 上限', () => {
  test('login 超大 body → 413 PAYLOAD_TOO_LARGE，且不建立会话', async () => {
    const base = await start()
    const res = await login(base, oversized({ username: 'admin', password: 'Adm1n!' }))
    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')
  })

  test('login 正常 body 仍 200（回归）', async () => {
    const base = await start()
    const res = await login(
      base,
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u249' })
    )
    assert.equal(res.status, 200)
  })

  test('refresh body 分支超大 body → 413，且不消耗原 token', async () => {
    const base = await start()
    const first = (await (
      await login(base, JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u249' }))
    ).json()) as Json
    const token = first.refreshToken
    assert.equal(typeof token, 'string')

    const huge = await refresh(base, oversized({ refreshToken: token }))
    assert.equal(huge.status, 413)
    assert.equal(errorCode((await huge.json()) as Json), 'PAYLOAD_TOO_LARGE')

    const again = await refresh(base, JSON.stringify({ refreshToken: token }))
    assert.equal(again.status, 200)
  })

  test('refresh Cookie 分支超大 body → 413，Cookie 会话仍可用', async () => {
    const base = await start()
    const loginRes = await login(
      base,
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u249' }),
      { origin: ORIGIN }
    )
    assert.equal(loginRes.status, 200)
    const cookie = loginRes.headers.getSetCookie()[0]?.split(';')[0] ?? ''
    assert.match(cookie, /^orca_refresh=/)

    const huge = await refresh(base, oversized({}), { cookie, origin: ORIGIN })
    assert.equal(huge.status, 413)
    assert.equal(errorCode((await huge.json()) as Json), 'PAYLOAD_TOO_LARGE')

    const small = await refresh(base, '{}', { cookie, origin: ORIGIN })
    assert.equal(small.status, 200)
  })
})

describe('U250 档 2 已鉴权敏感写 body 上限（16 KiB）', () => {
  test('正常写路径：超限 413 PAYLOAD_TOO_LARGE，且先于任何写入', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-write-admin')
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u250-write-dev')
    assert.notEqual(admin.token, '')
    assert.notEqual(dev.userId, '')

    const cases = [
      {
        name: '项目 grants',
        method: 'PUT',
        path: `/v1/projects/${PROJECT_ID}/grants`,
        body: { subjectType: 'user', subjectId: dev.userId, permissions: ['open'] }
      },
      {
        name: '项目 policy',
        method: 'PUT',
        path: `/v1/projects/${PROJECT_ID}/policy`,
        body: { downloadPolicy: 'allow' }
      },
      {
        name: '用户 roles',
        method: 'PUT',
        path: `/v1/users/${dev.userId}/roles`,
        body: { role: 'auditor' }
      },
      { name: 'hosts/tokens 签发', method: 'POST', path: '/v1/hosts/tokens', body: {} },
      {
        name: 'host grants',
        method: 'PUT',
        path: `/v1/hosts/${HOST_ID}/grants`,
        body: { subjectType: 'user', subjectId: dev.userId, permissions: ['view'] }
      },
      {
        name: 'host provision-policy',
        method: 'PUT',
        path: `/v1/hosts/${HOST_ID}/provision-policy`,
        body: { mode: 'open' }
      },
      {
        name: '全局下载策略',
        method: 'PUT',
        path: '/v1/policies/download',
        body: { downloadDefault: 'allow' }
      }
    ]

    for (const entry of cases) {
      const res = await authedJson(
        base,
        admin.token,
        entry.method,
        entry.path,
        oversizedBody(entry.body)
      )
      assert.equal(res.status, 413, `${entry.name} must answer 413`)
      assert.equal(
        errorCode((await res.json()) as Json),
        'PAYLOAD_TOO_LARGE',
        `${entry.name} must name the size refusal`
      )
    }

    // A 413 precedes the write: none of the refused changes may have landed.
    assert.equal(app.store.policies.downloadDefault, 'deny', 'global policy untouched')
    assert.equal(
      app.store.projects.get(PROJECT_ID)?.downloadPolicy,
      'deny',
      'project policy untouched'
    )
    assert.equal(
      app.store.hosts.get(HOST_ID)?.provisionPolicy,
      undefined,
      'provision policy untouched'
    )
    assert.ok(
      !app.store.users.get(dev.userId)?.roles.includes('platform:auditor'),
      'role untouched'
    )
    assert.ok(
      !app.store.grants.some(
        (grant) => grant.projectId === PROJECT_ID && grant.subjectId === dev.userId
      ),
      'project grant untouched'
    )
    assert.ok(
      !app.store.hostGrants.some(
        (grant) => grant.hostId === HOST_ID && grant.subjectId === dev.userId
      ),
      'host grant untouched'
    )
  })

  test('拒绝分支：超限 body 仍 403，denied 审计按空 body 记录', async () => {
    const { base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-deny-admin')
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u250-deny-dev')
    const pad = 'x'.repeat(DENIED_AUDIT_BODY_MAX_BYTES * 2)

    const projectGrant = await authedJson(
      base,
      dev.token,
      'PUT',
      `/v1/projects/${PROJECT_ID}/grants`,
      JSON.stringify({ pad, subjectType: 'user', subjectId: dev.userId, permissions: ['open'] })
    )
    assert.equal(projectGrant.status, 403, 'a denied project grant write stays 403')
    assert.equal(
      errorCode((await projectGrant.json()) as Json),
      'PERMISSION_DENIED',
      'the refusal keeps its permission error code'
    )

    const hostGrant = await authedJson(
      base,
      dev.token,
      'PUT',
      `/v1/hosts/${HOST_ID}/grants`,
      JSON.stringify({ pad, subjectType: 'user', subjectId: dev.userId, permissions: ['view'] })
    )
    assert.equal(hostGrant.status, 403, 'a denied host grant write stays 403')
    assert.equal(errorCode((await hostGrant.json()) as Json), 'PERMISSION_DENIED')

    const provision = await authedJson(
      base,
      dev.token,
      'PUT',
      `/v1/hosts/${HOST_ID}/provision-policy`,
      JSON.stringify({ pad, mode: 'open' })
    )
    assert.equal(provision.status, 403, 'a denied provision-policy write stays 403')
    assert.equal(errorCode((await provision.json()) as Json), 'PERMISSION_DENIED')

    // Over the 4 KiB audit cap the body counts as empty, so the record stays
    // bounded instead of echoing an attacker-sized document.
    const events = await deniedAuditEvents(base, admin.token, 'zhangsan')
    const projectEvent = events.find((event) => event.eventType === 'grant_update')
    assert.ok(projectEvent, 'the refused project grant write is audited')
    assert.equal((projectEvent.metadata as Json).subjectId, '')
    assert.deepEqual((projectEvent.metadata as Json).permissions, [])

    const hostEvent = events.find((event) => event.eventType === 'host_grant_update')
    assert.ok(hostEvent, 'the refused host grant write is audited')
    assert.equal((hostEvent.metadata as Json).subjectId, '')
    assert.deepEqual((hostEvent.metadata as Json).permissions, [])

    const provisionEvent = events.find(
      (event) => event.eventType === 'host_provision_policy_update'
    )
    assert.ok(provisionEvent, 'the refused provision-policy write is audited')
    assert.equal((provisionEvent.metadata as Json).mode, '')
  })
})

describe('U250/U251 内部端点 body 上限（8 KiB，超限丢弃整包）', () => {
  test('internal relay-endpoint：超限按空 body 处理，非对象归一化为 {}', async () => {
    const base = await start()
    const valid = JSON.stringify({ id: 'u250-relay', port: 28450 })

    const ok = await postInternal(base, '/v1/internal/relay-endpoint', valid)
    assert.equal(ok.status, 200)

    // An unknown top-level field is ignored by parseRelayRegistration, so a
    // full read would still be a 200; only the discard turns this into a 400.
    const huge = await postInternal(
      base,
      '/v1/internal/relay-endpoint',
      JSON.stringify({ id: 'u250-relay', port: 28450, pad: 'x'.repeat(INTERNAL_BODY_MAX_BYTES * 2) })
    )
    assert.equal(huge.status, 400)
    assert.equal(errorCode((await huge.json()) as Json), 'RELAY_PORT_INVALID')

    const scalar = await postInternal(base, '/v1/internal/relay-endpoint', 'null')
    assert.equal(scalar.status, 400)
    assert.equal(errorCode((await scalar.json()) as Json), 'RELAY_PORT_INVALID')
  })

  test('internal audit file-events：超限按空 body 处理，非对象归一化为 {}', async () => {
    const base = await start()
    const valid = JSON.stringify({ eventType: 'file_download', result: 'success' })

    // No cloud session: a valid body answers 200 without touching the chain.
    const ok = await postInternal(base, '/v1/internal/audit/file-events', valid)
    assert.equal(ok.status, 200)

    // `subject` is an allowed field, so a full read would still be a 200; only
    // the discard (empty body) fails the eventType check.
    const huge = await postInternal(
      base,
      '/v1/internal/audit/file-events',
      JSON.stringify({
        eventType: 'file_download',
        result: 'success',
        subject: 'x'.repeat(INTERNAL_BODY_MAX_BYTES * 2)
      })
    )
    assert.equal(huge.status, 400)
    assert.equal(errorCode((await huge.json()) as Json), 'INVALID_FILE_EVENT')

    const scalar = await postInternal(base, '/v1/internal/audit/file-events', 'null')
    assert.equal(scalar.status, 400)
    assert.equal(errorCode((await scalar.json()) as Json), 'INVALID_FILE_EVENT')
  })

  test('file-events：4096 B metadata + 顶层字段的合法包（>4 KiB）不被丢弃', async () => {
    const base = await start()
    // A real event may carry metadata up to FILE_EVENT_METADATA_LIMIT (4096 B)
    // plus its envelope; the old 4 KiB cap turned that legal shape into `{}`.
    const envelope = JSON.stringify({
      eventType: 'file_download',
      result: 'success',
      subject: 's'.repeat(4 * 1024),
      metadata: { path: 'd'.repeat(1024) }
    })
    const bytes = Buffer.byteLength(envelope)
    assert.ok(bytes > 4 * 1024, `fixture is ${bytes} B, must exceed the old cap`)
    assert.ok(bytes < INTERNAL_BODY_MAX_BYTES, `fixture is ${bytes} B, must fit the new cap`)

    const res = await postInternal(base, '/v1/internal/audit/file-events', envelope)
    assert.equal(res.status, 200, await res.text())
  })
})

describe('U250 档 3 普通读写调用点 body 上限（16 KiB）', () => {
  test('POST /v1/projects：超限 413 且不创建项目，正常 body 仍 201', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-tier3-project')
    const before = app.store.projects.size
    const fields = {
      hostId: HOST_ID,
      key: 'u250-bounded-project',
      name: 'u250-bounded-project',
      path: '/srv/work/u250-bounded-project',
      defaultBranch: 'main'
    }

    const res = await authedJson(base, admin.token, 'POST', '/v1/projects', oversizedBody(fields))
    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(app.store.projects.size, before, 'the refused create adds no project')
    assert.equal(
      [...app.store.projects.values()].some((project) => project.key === fields.key),
      false
    )

    const ok = await authedJson(base, admin.token, 'POST', '/v1/projects', JSON.stringify(fields))
    assert.equal(ok.status, 201)
    assert.ok(app.store.projectsByKey.has(fields.key), 'a normal body still creates the project')
  })

  test('POST /v1/hosts/register：超限 413 且不消耗注册令牌，错误可诊断', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-tier3-register')
    const token = await mintHostToken(base, admin.token)
    const fields = {
      name: 'u250-bounded-host',
      fingerprint: 'sha256:u250-bounded-host',
      protocolVersion: 3,
      networkZone: 'intranet'
    }

    // U252: registration has its own 64 KiB cap, so the overage is 128 KiB.
    const res = await registerHost(base, token, oversizedRegisterBody(fields))
    assert.equal(res.status, 413)
    const payload = (await res.json()) as Json
    assert.equal(errorCode(payload), 'PAYLOAD_TOO_LARGE')
    const failure = payload.error as Json
    assert.equal(typeof failure.traceId, 'string', 'the wire refusal names a trace id')
    assert.equal(app.store.hostsByName.has(fields.name), false)

    // The token is single-use and must survive the refusal.
    const retried = await registerHost(base, token, JSON.stringify(fields))
    assert.equal(retried.status, 201)
    assert.ok(app.store.hostsByName.has(fields.name))
  })

  test('POST /v1/audit/export：超限 413 且不创建导出任务', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-tier3-export')

    const res = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/audit/export',
      oversizedBody({ confirm: true, format: 'jsonl' })
    )

    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(app.auditExportStore.countActive(admin.userId), 0, 'no job was accepted')
  })

  test('其余 6 个普通调用点超限同样 413', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u250-tier3-other-admin')
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u250-tier3-other-dev')
    const beforeProjects = app.store.projects.size

    const cases: Array<{
      name: string
      token: string
      method: string
      path: string
      body: Json
    }> = [
      {
        name: '项目更新',
        token: admin.token,
        method: 'PUT',
        path: `/v1/projects/${PROJECT_ID}`,
        body: { repoUrl: 'https://git.example.com/u250/bounded.git' }
      },
      {
        name: '自助项目创建',
        token: dev.token,
        method: 'POST',
        path: '/v1/projects/self',
        body: { name: 'u250-self-service' }
      },
      {
        name: '主机维护',
        token: admin.token,
        method: 'POST',
        path: `/v1/hosts/${HOST_ID}/maintenance`,
        body: { enabled: true }
      },
      {
        name: 'web 交接',
        token: admin.token,
        method: 'POST',
        path: `/v1/projects/${PROJECT_ID}/web-handoff`,
        body: { surface: 'admin' }
      },
      {
        name: '连接',
        token: admin.token,
        method: 'POST',
        path: `/v1/projects/${PROJECT_ID}/connect`,
        body: {}
      }
    ]

    for (const entry of cases) {
      const res = await authedJson(
        base,
        entry.token,
        entry.method,
        entry.path,
        oversizedBody(entry.body)
      )
      assert.equal(res.status, 413, `${entry.name} must answer 413`)
      assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE', entry.name)
    }

    assert.equal(app.store.projects.size, beforeProjects, 'no project was created or replaced')
    assert.equal(
      app.store.projects.get(PROJECT_ID)?.repoUrl,
      'git@git.example.com:pay/payment-service.git'
    )
    assert.equal(app.store.hosts.get(HOST_ID)?.status, 'online', 'maintenance was not applied')
    assert.equal(app.store.webHandoffs.size, 0, 'no handoff code was minted')

    // U251: heartbeat is no longer a 16 KiB sensitive write; a 32 KiB beat is a
    // legal batch headroom case and must be accepted.
    const hostToken = await mintHostToken(base, admin.token)
    const registered = await registerHost(
      base,
      hostToken,
      JSON.stringify({ name: 'u250-beat-host', protocolVersion: 3, networkZone: 'intranet' })
    )
    assert.equal(registered.status, 201)
    const host = (await registered.json()) as Json
    const beat = await postHeartbeat(
      base,
      String(host.hostId),
      String(host.credential),
      oversizedBody({ status: 'online' })
    )
    assert.equal(beat.status, 200, await beat.text())
  })
})

describe('U252 register 独立 body 上限（64 KiB）', () => {
  test('注册契约合法最大包（200 × 255 B projectDirs）→ 201，目录全部入存储', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u252-max-admin')
    const token = await mintHostToken(base, admin.token)
    const { body, dirs } = legalMaxRegistration()
    const bytes = Buffer.byteLength(body)
    assert.ok(bytes > SENSITIVE_WRITE_BODY_MAX_BYTES, `fixture is ${bytes} B, must exceed 16 KiB`)
    assert.ok(bytes < REGISTER_BODY_MAX_BYTES, `fixture is ${bytes} B, must fit the 64 KiB cap`)

    const res = await registerHost(base, token, body)
    const payload = (await res.json()) as Json
    assert.equal(res.status, 201, JSON.stringify(payload))
    const stored = app.store.hosts.get(String(payload.hostId))
    assert.equal(stored?.projectDirs.length, 200, 'every legal directory was stored')
    assert.deepEqual(stored?.projectDirs, [...dirs].sort())
  })

  test('超过 64 KiB → 413 PAYLOAD_TOO_LARGE，且注册令牌未被消耗', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u252-huge-admin')
    const token = await mintHostToken(base, admin.token)
    const fields = {
      name: 'u252-huge-host',
      fingerprint: 'sha256:u252-huge-host',
      protocolVersion: 3,
      networkZone: 'intranet'
    }

    const huge = await registerHost(base, token, oversizedRegisterBody(fields))
    assert.equal(huge.status, 413)
    assert.equal(errorCode((await huge.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(app.store.hostsByName.has(fields.name), false)

    const retried = await registerHost(base, token, JSON.stringify(fields))
    assert.equal(retried.status, 201, 'the single-use token survives the refusal')
    assert.ok(app.store.hostsByName.has(fields.name))
  })
})

describe('U252 项目 path 契约上限（4096 字符）', () => {
  test('path 4096 字符 → 201，正常创建', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u252-path-4096-admin')
    const path = pathOfLength(PROJECT_PATH_MAX_CHARS)
    const key = 'u252-path-4096'

    const res = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/projects',
      JSON.stringify({ hostId: HOST_ID, key, name: key, path, defaultBranch: 'main' })
    )
    assert.equal(res.status, 201, await res.text())
    const stored = [...app.store.projects.values()].find((project) => project.key === key)
    assert.equal(stored?.path, path)
  })

  test('path 4097 字符 → 400 PROJECT_PATH_INVALID，且不创建项目', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u252-path-4097-admin')
    const path = pathOfLength(PROJECT_PATH_MAX_CHARS + 1)
    const key = 'u252-path-4097'

    const res = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/projects',
      JSON.stringify({ hostId: HOST_ID, key, name: key, path, defaultBranch: 'main' })
    )
    assert.equal(res.status, 400)
    assert.equal(errorCode((await res.json()) as Json), 'PROJECT_PATH_INVALID')
    assert.equal(app.store.projectsByKey.has(key), false, 'the refused create adds no project')

    // U256: the denial is auditable, and the recorded path stays bounded.
    const denied = await deniedAuditEvents(base, admin.token, 'admin')
    const event = denied.find(
      (entry) => (entry.metadata as Json | undefined)?.reason === 'PROJECT_PATH_INVALID'
    )
    assert.ok(event, 'the refused create is audited')
    assert.equal(event.targetType, 'project')
    assert.equal(event.targetId, null)
    assert.equal(((event.metadata as Json).path as string).length, PROJECT_PATH_MAX_CHARS)
  })

  test('path 4000 + repoUrl 4096 → 201，不再依赖 body 上限兜底', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u252-path-repo-admin')
    const path = pathOfLength(4000)
    const repoUrl = repoUrlOfLength(4096)
    assert.equal(repoUrl.length, 4096)
    const key = 'u252-path-repo'

    const res = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/projects',
      JSON.stringify({
        hostId: HOST_ID,
        key,
        name: key,
        path,
        repoUrl,
        defaultBranch: 'main'
      })
    )
    assert.equal(res.status, 201, await res.text())
    const stored = app.store.projectsByKey.get(key)
    assert.equal(stored?.path.length, 4000)
    assert.equal(stored?.repoUrl.length, 4096)
  })
})

describe('U256 projectsRoot 与自助派生路径上限', () => {
  test('15,003 字符 projectsRoot 注册 → 400 PROJECTS_ROOT_INVALID，令牌未消耗', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u256-root-long-admin')
    const token = await mintHostToken(base, admin.token)
    const fields = {
      name: 'u256-root-long',
      fingerprint: 'sha256:u256-root-long',
      protocolVersion: 3,
      networkZone: 'intranet',
      projectsRoot: pathOfLength(15_003)
    }

    const refused = await registerHost(base, token, JSON.stringify(fields))
    const payload = (await refused.json()) as Json
    // U256: a field error, not the body-cap 413 the unbounded root used to cause.
    assert.ok(
      Buffer.byteLength(JSON.stringify(fields)) < REGISTER_BODY_MAX_BYTES,
      'the body is under the 64 KiB cap, so only field validation can refuse it'
    )
    assert.equal(refused.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'PROJECTS_ROOT_INVALID')
    assert.equal(app.store.hostsByName.has(fields.name), false)

    const retried = await registerHost(
      base,
      token,
      JSON.stringify({ ...fields, projectsRoot: '/srv/u256-long-retry' })
    )
    assert.equal(retried.status, 201, 'the single-use token survives a field refusal')
    const host = (await retried.json()) as Json
    assert.equal(app.store.hosts.get(String(host.hostId))?.projectsRoot, '/srv/u256-long-retry')
  })

  test('projectsRoot 4000 + 200 × 255 B 目录 → 201，合法最大包仍在 64 KiB 内', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u256-root-max-admin')
    const token = await mintHostToken(base, admin.token)
    const root = pathOfLength(4000)
    const dirs = Array.from({ length: 200 }, (_, index) => {
      const prefix = `dir${String(index).padStart(3, '0')}`
      return `${prefix}${'d'.repeat(255 - prefix.length)}`
    })
    const body = JSON.stringify({
      name: 'u256-root-max',
      fingerprint: 'sha256:u256-root-max',
      protocolVersion: 3,
      networkZone: 'intranet',
      projectsRoot: root,
      projectDirs: dirs
    })
    const bytes = Buffer.byteLength(body)
    assert.ok(bytes > SENSITIVE_WRITE_BODY_MAX_BYTES, `fixture is ${bytes} B, must exceed 16 KiB`)
    assert.ok(bytes < REGISTER_BODY_MAX_BYTES, `fixture is ${bytes} B, must fit the 64 KiB cap`)

    const res = await registerHost(base, token, body)
    const payload = (await res.json()) as Json
    assert.equal(res.status, 201, JSON.stringify(payload))
    const stored = app.store.hosts.get(String(payload.hostId))
    assert.equal(stored?.projectsRoot, root)
    assert.deepEqual(stored?.projectDirs, [...dirs].sort(), 'all 200 legal directories were stored')
  })

  test('心跳超长 projectsRoot → 200 + PROJECTS_ROOT_INVALID，旧根保留', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u256-beat-root-admin')
    const token = await mintHostToken(base, admin.token)
    const registered = await registerHost(
      base,
      token,
      JSON.stringify({ name: 'u256-beat-root', projectsRoot: '/srv/u256-beat' })
    )
    assert.equal(registered.status, 201)
    const host = (await registered.json()) as Json
    const beat = await postHeartbeat(
      base,
      String(host.hostId),
      String(host.credential),
      JSON.stringify({ status: 'online', projectsRoot: pathOfLength(PROJECT_PATH_MAX_CHARS + 1) })
    )
    assert.equal(beat.status, 200)
    assert.equal(((await beat.json()) as Json).projectsRootRejected, 'PROJECTS_ROOT_INVALID')
    assert.equal(app.store.hosts.get(String(host.hostId))?.projectsRoot, '/srv/u256-beat')
  })

  test('自助创建派生 path 超 4096 → 400 PROJECT_PATH_INVALID，且不落库', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u256-self-admin')
    const token = await mintHostToken(base, admin.token)
    const root = pathOfLength(PROJECT_PATH_MAX_CHARS)
    const registered = await registerHost(
      base,
      token,
      JSON.stringify({ name: 'u256-self-host', projectsRoot: root })
    )
    assert.equal(registered.status, 201)
    const host = (await registered.json()) as Json
    const hostId = String(host.hostId)
    const granted = await authedJson(
      base,
      admin.token,
      'PUT',
      `/v1/hosts/${hostId}/grants`,
      JSON.stringify({ subjectType: 'group', subjectId: 'developers', permissions: ['provision'] })
    )
    assert.equal(granted.status, 200, await granted.text())

    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u256-self-dev')
    const key = 'u256-self-over'
    const dir = 'd'.repeat(200)
    assert.ok(root.length + 1 + dir.length > PROJECT_PATH_MAX_CHARS)
    const res = await authedJson(
      base,
      dev.token,
      'POST',
      '/v1/projects/self',
      JSON.stringify({ hostId, key, name: 'Self Over', dir })
    )
    const payload = (await res.json()) as Json
    assert.equal(res.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'PROJECT_PATH_INVALID')
    assert.equal(app.store.projectsByKey.has(key), false, 'the refused create persists nothing')

    const denied = await deniedAuditEvents(base, admin.token, 'zhangsan')
    assert.ok(
      denied.some(
        (entry) => (entry.metadata as Json | undefined)?.reason === 'PROJECT_PATH_INVALID'
      ),
      'the refused self-service create is audited'
    )
  })

  test('register 精确边界：65,536 B → 201，65,537 B → 413', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u256-boundary-admin')

    const token = await mintHostToken(base, admin.token)
    const accepted = await registerHost(
      base,
      token,
      registerBodyOfBytes('u256-boundary-ok', REGISTER_BODY_MAX_BYTES)
    )
    assert.equal(accepted.status, 201, await accepted.text())

    const overToken = await mintHostToken(base, admin.token)
    const refused = await registerHost(
      base,
      overToken,
      registerBodyOfBytes('u256-boundary-no', REGISTER_BODY_MAX_BYTES + 1)
    )
    assert.equal(refused.status, 413)
    assert.equal(errorCode((await refused.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(app.store.hostsByName.has('u256-boundary-no'), false)
  })

  test('projectDirs 名称按 UTF-8 字节限 255：255 B 保留，256 B/多字节超限丢弃', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u256-dirs-admin')
    const token = await mintHostToken(base, admin.token)
    const atLimit = 'a'.repeat(255)
    const overAscii = 'b'.repeat(256)
    const overUtf8 = '目'.repeat(86)
    assert.equal(Buffer.byteLength(atLimit, 'utf8'), 255)
    assert.ok(
      overUtf8.length < 255 && Buffer.byteLength(overUtf8, 'utf8') > 255,
      'a multi-byte name may fit in characters but not in bytes'
    )

    const res = await registerHost(
      base,
      token,
      JSON.stringify({ name: 'u256-dirs', projectDirs: [atLimit, overAscii, overUtf8, 'keep'] })
    )
    const payload = (await res.json()) as Json
    assert.equal(res.status, 201, JSON.stringify(payload))
    const stored = app.store.hosts.get(String(payload.hostId))
    assert.deepEqual(stored?.projectDirs, [atLimit, 'keep'].sort())
  })
})

describe('U251 heartbeat 独立 body 上限（1 MiB）', () => {
  test('100 审计事件（4096 B metadata）+ 200 projectDirs + 32 报告 → 200，整批入链', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u251-beat-admin')
    const hostToken = await mintHostToken(base, admin.token)
    const registered = await registerHost(
      base,
      hostToken,
      JSON.stringify({ name: 'u251-beat-host', protocolVersion: 3, networkZone: 'intranet' })
    )
    assert.equal(registered.status, 201)
    const host = (await registered.json()) as Json
    const hostId = String(host.hostId)

    const body = legalMaxHeartbeat()
    const bodyBytes = Buffer.byteLength(body)
    assert.ok(bodyBytes > SENSITIVE_WRITE_BODY_MAX_BYTES, 'the legal beat exceeds the old 16 KiB cap')
    assert.ok(bodyBytes < HEARTBEAT_BODY_MAX_BYTES, 'the legal beat stays inside the new cap')

    const beat = await postHeartbeat(base, hostId, String(host.credential), body)
    assert.equal(beat.status, 200, await beat.text())

    // The host only calls clearThrough after beat.ok, so a 200 with the whole
    // batch in the chain is exactly the acknowledgement that unblocks it.
    const query = await authedJson(
      base,
      admin.token,
      'GET',
      '/v1/audit/events?eventType=file_download&limit=200'
    )
    assert.equal(query.status, 200)
    const page = (await query.json()) as Json
    const events = (page.events as Json[] | undefined) ?? []
    assert.equal(events.length, 100, 'the platform accepted every event in the batch')
    assert.equal((events[0]?.metadata as Json | undefined)?.path, 'd'.repeat(1024))

    const stored = app.store.hosts.get(hostId)
    assert.equal(stored?.projectDirs.length, 200, 'all 200 reported directories were stored')
    assert.ok(stored?.projectDirs.every((dir) => dir.length === 200))
  })

  test('超过 1 MiB → 413 PAYLOAD_TOO_LARGE，心跳状态不写入', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u251-huge-admin')
    const hostToken = await mintHostToken(base, admin.token)
    const registered = await registerHost(
      base,
      hostToken,
      JSON.stringify({ name: 'u251-huge-host', protocolVersion: 3, networkZone: 'intranet' })
    )
    assert.equal(registered.status, 201)
    const host = (await registered.json()) as Json
    const hostId = String(host.hostId)

    const huge = JSON.stringify({
      status: 'offline',
      pad: 'x'.repeat(HEARTBEAT_BODY_MAX_BYTES + 1024)
    })
    const beat = await postHeartbeat(base, hostId, String(host.credential), huge)
    assert.equal(beat.status, 413)
    assert.equal(errorCode((await beat.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(app.store.hosts.get(hostId)?.status, 'online', 'the refused beat changed nothing')
  })
})

describe('U251 超限早拒（不等待、不排空请求体）', () => {
  test('声明 content-length 远超上限：只发少量前缀即收到 413 且 Connection: close', async () => {
    const base = await start()
    // 8 MiB is past the bounded drain budget, so the refusal must come from the
    // header alone. A modest overage is drained first for client compatibility.
    const { status, connection, body, elapsedMs } = await declaredOversizedRequest(
      base,
      '/v1/auth/login',
      8 * 1024 * 1024
    )

    assert.equal(status, 413)
    assert.equal(connection, 'close')
    assert.equal(errorCode(JSON.parse(body) as Json), 'PAYLOAD_TOO_LARGE')
    assert.ok(elapsedMs < 1000, `the refusal waited ${elapsedMs}ms for the declared body`)
  }, { timeout: 5000 })

  test('chunked 持续发送超限：立即 413、连接关闭且不再消费', async () => {
    const base = await start()
    const { status, connection, responseMs, closeMs, sentBytes } =
      await streamingOversizedRequest(base, '/v1/auth/login')

    assert.equal(status, 413)
    assert.equal(connection, 'close')
    assert.ok(responseMs < 1000, `the refusal arrived after ${responseMs}ms`)
    assert.ok(closeMs >= responseMs, 'the connection closes only after the refusal')
    assert.ok(sentBytes > AUTH_BODY_MAX_BYTES, `the client streamed ${sentBytes} B before the close`)
  }, { timeout: 5000 })

  test('keep-alive：未超限的正常请求继续复用同一连接', async () => {
    const base = await start()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      const first = await agentPost(
        agent,
        `${base}/v1/auth/login`,
        JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u251-ka-1' })
      )
      const second = await agentPost(
        agent,
        `${base}/v1/auth/login`,
        JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u251-ka-2' })
      )

      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      assert.equal(first.reused, false, 'the first request opens the connection')
      assert.equal(second.reused, true, 'a normal request keeps the connection usable')
    } finally {
      agent.destroy()
    }
  }, { timeout: 5000 })
})

describe('U251 P3 审计可用性检查先于 policy 读取', () => {
  test('审计链损坏 + 超限 body → 503 AUDIT_CHAIN_BROKEN，而非 413', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u251-policy-order')

    if (app.store.audit.length === 0) {
      app.audit.append({
        eventType: 'login',
        actor: 'admin',
        targetType: 'session',
        targetId: null,
        result: 'success',
        traceId: 'u251-seed'
      })
    }
    const first = app.store.audit[0]
    assert.ok(first)
    first.metadata = { ...first.metadata, tampered: true }
    assert.equal(app.audit.verify().ok, false, 'the chain is now broken')

    const res = await authedJson(
      base,
      admin.token,
      'PUT',
      `/v1/projects/${PROJECT_ID}/policy`,
      oversizedBody({ downloadPolicy: 'allow' })
    )

    assert.equal(res.status, 503)
    assert.equal(errorCode((await res.json()) as Json), 'AUDIT_CHAIN_BROKEN')
    assert.equal(app.store.projects.get(PROJECT_ID)?.downloadPolicy, 'deny', 'nothing was written')
  }, { timeout: 5000 })
})

/**
 * U254: the writer refuses any event over 16 KiB (`BATCH_INVALID`). These legal
 * 16 KiB bodies had their oversized field copied verbatim into `metadata`, so
 * the event was refused, the audit gate answered 503, and the operation never
 * happened. The fields are now truncated at the audit landing point.
 */
describe('U254 超长 body 字段不得把审计事件撑过 writer 16 KiB', () => {
  const MAINTENANCE_REASON_MAX_CHARS = 200
  const PROJECT_KEY_MAX_CHARS = 64
  // Just under the 16 KiB sensitive-write body cap; the audit envelope pushes
  // the same value over the writer's per-event cap.
  const OVERSIZED_FIELD_CHARS = SENSITIVE_WRITE_BODY_MAX_BYTES - 128

  test('16 KiB maintenance reason → 2xx，维护生效且事件入链，reason 截断到 200', async () => {
    const { app, base } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u254-maintenance-admin')
    const reason = 'r'.repeat(OVERSIZED_FIELD_CHARS)
    const body = JSON.stringify({ enabled: true, reason })
    assert.ok(Buffer.byteLength(body) < SENSITIVE_WRITE_BODY_MAX_BYTES, 'the body is legal')
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({
          eventType: 'host_maintenance',
          actor: 'admin',
          targetType: 'host',
          targetId: HOST_ID,
          result: 'success',
          traceId: '0'.repeat(36),
          metadata: { enabled: true, reason }
        })
      ) > 16 * 1024,
      'the untruncated event exceeds the writer cap'
    )

    const res = await authedJson(
      base,
      admin.token,
      'POST',
      `/v1/hosts/${HOST_ID}/maintenance`,
      body
    )
    assert.equal(res.status, 200, await res.text())
    assert.equal(app.store.hosts.get(HOST_ID)?.status, 'maintenance', '维护已生效')

    const query = await authedJson(
      base,
      admin.token,
      'GET',
      '/v1/audit/events?eventType=host_maintenance&limit=200'
    )
    assert.equal(query.status, 200)
    const events = (((await query.json()) as Json).events as Json[] | undefined) ?? []
    assert.equal(events.length, 1, 'the maintenance event is in the chain')
    const storedReason = (events[0]?.metadata as Json | undefined)?.reason
    assert.equal(typeof storedReason, 'string')
    assert.equal((storedReason as string).length, MAINTENANCE_REASON_MAX_CHARS)
    assert.equal(storedReason, 'r'.repeat(MAINTENANCE_REASON_MAX_CHARS))
  })

  test('16 KiB 非法 project path → 400，拒绝事件入链，path 截断到 4096', async () => {
    const { app, base } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u254-path-admin')
    const key = 'u254-path-oversize'
    const path = pathOfLength(OVERSIZED_FIELD_CHARS)
    const body = JSON.stringify({ hostId: HOST_ID, key, name: key, path, defaultBranch: 'main' })
    assert.ok(Buffer.byteLength(body) < SENSITIVE_WRITE_BODY_MAX_BYTES, 'the body is legal')

    const res = await authedJson(base, admin.token, 'POST', '/v1/projects', body)
    const payload = (await res.json()) as Json
    assert.equal(res.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'PROJECT_PATH_INVALID')
    assert.equal(app.store.projectsByKey.has(key), false, '拒绝时未创建项目')

    const denied = await deniedAuditEvents(base, admin.token, 'admin')
    const event = denied.find(
      (entry) => (entry.metadata as Json | undefined)?.reason === 'PROJECT_PATH_INVALID'
    )
    assert.ok(event, 'the refused create is audited')
    assert.equal(((event.metadata as Json).path as string).length, PROJECT_PATH_MAX_CHARS)
  })

  test('16 KiB 非法 project key → 400，拒绝事件入链，key 截断到 64', async () => {
    const { app, base } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u254-key-admin')
    const key = 'k'.repeat(OVERSIZED_FIELD_CHARS)
    const body = JSON.stringify({ hostId: HOST_ID, key })
    assert.ok(Buffer.byteLength(body) < SENSITIVE_WRITE_BODY_MAX_BYTES, 'the body is legal')

    const res = await authedJson(base, admin.token, 'POST', '/v1/projects', body)
    const payload = (await res.json()) as Json
    assert.equal(res.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'PROJECT_KEY_INVALID')
    assert.equal(app.store.projectsByKey.has(key), false, '拒绝时未创建项目')

    const denied = await deniedAuditEvents(base, admin.token, 'admin')
    const event = denied.find(
      (entry) => (entry.metadata as Json | undefined)?.reason === 'PROJECT_KEY_INVALID'
    )
    assert.ok(event, 'the refused create is audited')
    assert.equal(((event.metadata as Json).key as string).length, PROJECT_KEY_MAX_CHARS)
  })
})

/**
 * U255: these five `readJson` callers discarded `oversized`, so the response
 * kept keep-alive and Node drained the unread body without a bound. A declared
 * body over the 2 MiB drain budget must be answered from the header alone and
 * close; a chunked one must pause and close; the caller's old semantics (empty
 * body, 403/200, audit event) stay the same.
 */
describe('U255 readJson 超限路径关闭 keep-alive', () => {
  test('未认证 logout 声明 64 MiB：返回 200 后不再读走整包', async () => {
    const base = await start()
    const result = await declaredHugeRawRequest(base, '/v1/auth/logout', 64 * 1024 * 1024, {})

    assert.equal(result.status, 200, 'logout keeps its empty-body 200')
    assert.equal(
      result.flushedAll,
      false,
      `the server accepted the full 64 MiB declaration (flushed=${result.flushedBytes} B, ` +
        `connection=${String(result.connection)}, response=${result.responseMs}ms, close=${result.closeMs}ms)`
    )
    assert.equal(result.connection, 'close', 'an unread oversized body must not keep the connection')
    assert.ok(
      result.flushedBytes < 64 * 1024 * 1024 - 2 * 1024 * 1024,
      `the server accepted ${result.flushedBytes} B of 64 MiB`
    )
    assert.ok(result.responseMs < 1000, `the response took ${result.responseMs}ms`)
    assert.ok(result.closeMs > 0 && result.closeMs < 1500, `the close took ${result.closeMs}ms`)
  }, { timeout: 8000 })

  test('chunked 超限 logout：拒绝后同连接/新连接仍能继续请求', async () => {
    const base = await start()
    const url = new URL(base)
    const socket = await connectRaw(base)
    const chunk = Buffer.alloc(8 * 1024, 'x')
    const pump = setInterval(() => {
      socket.write(`${chunk.length.toString(16)}\r\n`)
      socket.write(chunk)
      socket.write('\r\n')
    }, 2)
    const chunkedHead = [
      'POST /v1/auth/logout HTTP/1.1',
      `Host: ${url.host}`,
      'Content-Type: application/json',
      'Transfer-Encoding: chunked',
      'Connection: keep-alive'
    ].join('\r\n')
    socket.write(`${chunkedHead}\r\n\r\n`)

    const first = await readRawResponse(socket, 3000, 'chunked logout')
    clearInterval(pump)
    assert.equal(first.status, 200, 'logout still answers 200 for a chunked overage')
    const closed = first.headers.connection === 'close'
    // A kept-alive connection is only usable if the server can still parse the
    // next request; the body is deliberately never terminated, matching a client
    // that keeps streaming past the cap.

    const loginBody = JSON.stringify({
      username: 'admin',
      password: 'Adm1n!',
      deviceName: 'u255-after-chunked'
    })
    const loginHead = [
      'POST /v1/auth/login HTTP/1.1',
      `Host: ${url.host}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(loginBody)}`,
      'Connection: keep-alive'
    ].join('\r\n')
    const loginRequest = `${loginHead}\r\n\r\n${loginBody}`

    let second: RawResponse
    if (closed) {
      await waitForClose(socket, 1000)
      const fresh = await connectRaw(base)
      fresh.write(loginRequest)
      second = await readRawResponse(fresh, 3000, 'login after close')
      fresh.destroy()
    } else {
      socket.write(loginRequest)
      second = await readRawResponse(socket, 2500, 'login on the half-read connection')
    }
    socket.destroy()

    assert.equal(second.status, 200, 'a refused chunked body must not wedge the connection')
  }, { timeout: 8000 })

  test('3 处 403 拒绝分支：超限 body 仍 403、关闭连接并写入 denied 审计', async () => {
    const { base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u255-deny-admin')
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u255-deny-dev')
    const authorization = { authorization: `Bearer ${dev.token}` }
    const paths = [
      `/v1/projects/${PROJECT_ID}/grants`,
      `/v1/hosts/${HOST_ID}/grants`,
      `/v1/hosts/${HOST_ID}/provision-policy`
    ]

    for (const path of paths) {
      const refused = await declaredHugeRawRequest(
        base,
        path,
        8 * 1024 * 1024,
        authorization,
        'PUT',
        true
      )
      assert.equal(refused.status, 403, `${path} must keep its 403`)
      assert.equal(refused.connection, 'close', `${path} must close the unread connection`)
      assert.equal(errorCode(JSON.parse(refused.body) as Json), 'PERMISSION_DENIED')
    }

    const events = await deniedAuditEvents(base, admin.token, 'zhangsan')
    const projectEvent = events.find((event) => event.eventType === 'grant_update')
    assert.ok(projectEvent, 'the refused project grant write is audited')
    assert.equal((projectEvent.metadata as Json).subjectId, '')
    const hostEvent = events.find((event) => event.eventType === 'host_grant_update')
    assert.ok(hostEvent, 'the refused host grant write is audited')
    assert.equal((hostEvent.metadata as Json).subjectId, '')
    const policyEvent = events.find(
      (event) => event.eventType === 'host_provision_policy_update'
    )
    assert.ok(policyEvent, 'the refused provision-policy write is audited')
    assert.equal((policyEvent.metadata as Json).mode, '')
  }, { timeout: 8000 })

  test('force-offline：超限 body 仍 200 + 撤销，审计按空 body 记录', async () => {
    const { app, base } = await startApp()
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u255-force-dev')
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u255-force-admin')

    const forced = await declaredHugeRawRequest(
      base,
      `/v1/users/${dev.userId}/sessions/revoke`,
      8 * 1024 * 1024,
      { authorization: `Bearer ${admin.token}` },
      'POST',
      true
    )
    assert.equal(forced.status, 200, 'force-offline keeps its 200')
    assert.equal(forced.connection, 'close', 'the unread body must not keep the connection')
    assert.deepEqual(JSON.parse(forced.body) as Json, { ok: true, revokedSessions: 1 })

    const session = [...app.store.sessions.values()].find((entry) => entry.userId === dev.userId)
    assert.ok(session, 'the dev session exists')
    assert.notEqual(session.revokedAt, null, 'the session is revoked despite the oversized body')

    const query = await authedJson(
      base,
      admin.token,
      'GET',
      '/v1/audit/events?eventType=session_revoke&result=success&limit=200'
    )
    assert.equal(query.status, 200)
    const events = (((await query.json()) as Json).events as Json[] | undefined) ?? []
    const event = events.find(
      (entry) => entry.eventType === 'session_revoke' && entry.targetId === dev.userId
    )
    assert.ok(event, 'the revocation is still audited')
    assert.equal((event.metadata as Json).revokedSessions, 1)
    assert.equal('reason' in (event.metadata as Json), false, 'the oversized note was discarded')
  }, { timeout: 8000 })
})

/**
 * U257: the API used to hand the writer legal-but-huge events (control-character
 * inflation, 20k names, 16k versions, two 4096-char CJK roots), so the writer
 * answered 400 and an otherwise valid request became a 500 or the best-effort
 * event silently disappeared. The boundary now lives at both write entries.
 */
describe('U257 审计事件体积全局护栏', () => {
  test('2700 个 NUL 的 project path → 400，事件归一后入链且链仍可验证', async () => {
    const { app, base } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u257-ctrl-admin')
    const path = '\u0000'.repeat(2700)
    const body = JSON.stringify({
      hostId: HOST_ID,
      key: 'u257-ctrl-path',
      name: 'u257-ctrl-path',
      path,
      defaultBranch: 'main'
    })
    assert.ok(
      Buffer.byteLength(body) < SENSITIVE_WRITE_BODY_MAX_BYTES,
      'the body is legal; only the escaped path inflates the event'
    )

    const res = await authedJson(base, admin.token, 'POST', '/v1/projects', body)
    const payload = (await res.json()) as Json
    assert.equal(res.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'PROJECT_PATH_INVALID')
    assert.equal(app.store.projectsByKey.has('u257-ctrl-path'), false)

    const denied = await deniedAuditEvents(base, admin.token, 'admin')
    const event = denied.find(
      (entry) => (entry.metadata as Json | undefined)?.reason === 'PROJECT_PATH_INVALID'
    )
    assert.ok(event, 'the refused create is audited')
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= AUDIT_EVENT_MAX_BYTES)
    assert.ok(
      Buffer.byteLength(JSON.stringify(event.metadata)) <= AUDIT_METADATA_MAX_BYTES,
      'metadata stays inside the per-event budget'
    )
    const metadata = event.metadata as Json
    assert.equal(typeof metadata.path, 'string', 'the locatable prefix survives')
    assert.equal((metadata.auditSize as Json).truncated, true)

    const verdict = await app.audit.verify()
    assert.equal(verdict.ok, true, 'bounding happens before the hash, so the chain verifies')
  })

  test('20,000 字符 host name → 400 HOST_NAME_INVALID，令牌未消耗且可重试', async () => {
    const { app, base } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u257-name-admin')
    const token = await mintHostToken(base, admin.token)
    const hugeName = 'n'.repeat(20_000)

    const refused = await registerHost(
      base,
      token,
      JSON.stringify({ name: hugeName, protocolVersion: 3 })
    )
    const payload = (await refused.json()) as Json
    assert.equal(refused.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'HOST_NAME_INVALID')
    assert.equal(app.store.hostsByName.has(hugeName), false, 'no oversized name is indexed')
    assert.equal(app.store.hostTokens.at(-1)?.usedAt, null, 'the refusal spends no token')

    const retried = await registerHost(
      base,
      token,
      JSON.stringify({ name: 'u257-name-retry', protocolVersion: 3 })
    )
    assert.equal(retried.status, 201, await retried.text())
    assert.ok(app.store.hostsByName.has('u257-name-retry'))

    // The denial is best-effort and only recorded with the bounded name.
    const event = await waitForAuditEvent(
      base,
      admin.token,
      { eventType: 'host_register', result: 'denied' },
      (entry) => (entry.metadata as Json | undefined)?.reason === 'HOST_NAME_INVALID'
    )
    const metadata = event.metadata as Json
    assert.ok(((metadata.name as string) ?? '').length <= HOST_NAME_MAX_CHARS)
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= AUDIT_EVENT_MAX_BYTES)
  })

  test('审计失败 → 503 AUDIT_UNAVAILABLE，令牌回滚且主机不落库', async () => {
    const { app, base, writer } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u257-fail-admin')
    const token = await mintHostToken(base, admin.token)
    await writer.close()

    const res = await registerHost(
      base,
      token,
      JSON.stringify({ name: 'u257-fail-closed', protocolVersion: 3 })
    )
    const payload = (await res.json()) as Json
    assert.equal(res.status, 503, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'AUDIT_UNAVAILABLE')
    assert.equal(app.store.hostsByName.has('u257-fail-closed'), false, 'no unrecorded host')
    assert.equal(app.store.hosts.get('u257-fail-closed'), undefined)
    assert.equal(app.store.hostTokens.at(-1)?.usedAt, null, 'the token is reusable after the retry')
  })

  test('并发同令牌双注册 → 仅一个 201，主机只落库一次', async () => {
    const { app, base } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u257-race-admin')
    const token = await mintHostToken(base, admin.token)
    const body = JSON.stringify({ name: 'u257-race-host', protocolVersion: 3 })

    const [first, second] = await Promise.all([
      registerHost(base, token, body),
      registerHost(base, token, body)
    ])
    assert.deepEqual(
      [first.status, second.status].sort(),
      [201, 401],
      'the token reservation is synchronous, so only one request can win'
    )
    const hosts = [...app.store.hostsByName.values()].filter(
      (host) => host.name === 'u257-race-host'
    )
    assert.equal(hosts.length, 1)
  })

  test('2 × 4096 CJK projectsRoot 的 root-change 事件不超限', async () => {
    const { app, base } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u257-root-admin')
    const token = await mintHostToken(base, admin.token)
    const registered = await registerHost(
      base,
      token,
      JSON.stringify({ name: 'u257-root-host', protocolVersion: 3 })
    )
    assert.equal(registered.status, 201)
    const host = (await registered.json()) as Json
    const hostId = String(host.hostId)
    const stored = app.store.hosts.get(hostId)
    assert.ok(stored)

    const currentRoot = `/${'项'.repeat(PROJECT_PATH_MAX_CHARS - 1)}`
    const requestedRoot = `/${'目'.repeat(PROJECT_PATH_MAX_CHARS - 1)}`
    stored.projectsRoot = currentRoot
    // A non-archived project makes the root move a conflict, which is the event
    // whose two path fields used to exceed the writer's per-event cap.
    app.store.projects.set('proj_u257_root', {
      id: 'proj_u257_root',
      key: 'u257-root-proj',
      name: 'U257 root',
      repoUrl: '',
      hostId,
      path: `${currentRoot}/proj`,
      defaultBranch: 'main',
      downloadPolicy: 'deny',
      status: 'ready',
      createdAt: Date.now()
    })

    const beat = await postHeartbeat(
      base,
      hostId,
      String(host.credential),
      JSON.stringify({ status: 'online', projectsRoot: requestedRoot })
    )
    assert.equal(beat.status, 200)
    const beatBody = (await beat.json()) as Json
    assert.equal(beatBody.projectsRootRejected, 'PROJECTS_ROOT_CONFLICT')
    assert.equal(app.store.hosts.get(hostId)?.projectsRoot, currentRoot, 'the old root is kept')

    const event = await waitForAuditEvent(
      base,
      admin.token,
      { eventType: 'projects_root_change', result: 'denied' },
      (entry) => (entry.metadata as Json | undefined)?.reason === 'PROJECTS_ROOT_CONFLICT'
    )
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= AUDIT_EVENT_MAX_BYTES)
    const metadata = event.metadata as Json
    assert.ok(Buffer.byteLength(JSON.stringify(metadata)) <= AUDIT_METADATA_MAX_BYTES)
    assert.equal((metadata.auditSize as Json).truncated, true)
    assert.ok(((metadata.requested as string) ?? '').length < PROJECT_PATH_MAX_CHARS)
    assert.ok(((metadata.current as string) ?? '').length < PROJECT_PATH_MAX_CHARS)
  })

  test('16,202 字符 clientVersion → 426 VERSION_UNSUPPORTED，事件归一', async () => {
    const { app, base } = await startAppWithWriter()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u257-version-admin')
    const token = await mintHostToken(base, admin.token)
    const registered = await registerHost(
      base,
      token,
      JSON.stringify({ name: 'u257-version-host', protocolVersion: 3 })
    )
    assert.equal(registered.status, 201)
    const host = (await registered.json()) as Json
    const hostId = String(host.hostId)

    const projectId = 'proj_u257_version'
    app.store.projects.set(projectId, {
      id: projectId,
      key: 'u257-version-proj',
      name: 'U257 version',
      repoUrl: '',
      hostId,
      path: '/srv/u257-version',
      defaultBranch: 'main',
      downloadPolicy: 'deny',
      status: 'ready',
      createdAt: Date.now()
    })
    app.store.grants.push({
      projectId,
      subjectType: 'user',
      subjectId: admin.userId,
      permissions: ['open']
    })

    const offered = '0'.repeat(16_202)
    const body = JSON.stringify({ clientVersion: offered })
    assert.ok(Buffer.byteLength(body) < SENSITIVE_WRITE_BODY_MAX_BYTES, 'the body is legal')
    const res = await authedJson(
      base,
      admin.token,
      'POST',
      `/v1/projects/${projectId}/connect`,
      body
    )
    const payload = (await res.json()) as Json
    assert.equal(res.status, 426, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'VERSION_UNSUPPORTED')

    const denied = await deniedAuditEvents(base, admin.token, 'admin')
    const event = denied.find(
      (entry) => (entry.metadata as Json | undefined)?.reason === 'VERSION_UNSUPPORTED'
    )
    assert.ok(event, 'the refused connect is audited')
    const metadata = event.metadata as Json
    assert.ok(((metadata.offered as string) ?? '').length <= 64)
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= AUDIT_EVENT_MAX_BYTES)
    assert.equal((metadata.auditSize as Json).truncated, true)
  })
})

/**
 * U258: a refusal answered before the body is read left Node to drain the rest
 * after the response so keep-alive could continue; an unauthenticated 16 MiB
 * POST was consumed in full. Above the 16 KiB per-command cap the refusal now
 * closes the connection, while a normal small request keeps it.
 */
describe('U258 读取前拒绝：未读的大 body 不保持 keep-alive', () => {
  const DECLARED_16_MIB = 16 * 1024 * 1024

  function assertHugeUnreadBody(
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
    expectedStatus: number
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
      result.acceptedBytes < 2 * 1024 * 1024,
      `${label}: the server accepted ${result.acceptedBytes} B of 16 MiB`
    )
    assert.ok(result.responseMs < 1000, `${label}: the refusal took ${result.responseMs}ms`)
    assert.ok(
      result.closeMs < 1500,
      `${label}: the close took ${result.closeMs}ms`
    )
  }

  test('未认证 POST /v1/projects 声明 16 MiB → 401，消费字节远小于声明、连接关闭', async () => {
    const base = await start()
    const result = await pacedDeclaredBodyRequest(base, '/v1/projects', DECLARED_16_MIB)
    assertHugeUnreadBody('unauth project create', result, 401)
  }, { timeout: 8000 })

  test('错误内部令牌 声明 16 MiB → 401，消费字节远小于声明、连接关闭', async () => {
    const base = await start()
    const result = await pacedDeclaredBodyRequest(
      base,
      '/v1/internal/relay-endpoint',
      DECLARED_16_MIB,
      { 'x-internal-token': 'u258-wrong-internal-token' }
    )
    assertHugeUnreadBody('wrong internal token', result, 401)
  }, { timeout: 8000 })

  test('无效注册令牌 声明 16 MiB → 401，消费字节远小于声明、连接关闭', async () => {
    const base = await start()
    const result = await pacedDeclaredBodyRequest(base, '/v1/hosts/register', DECLARED_16_MIB, {
      authorization: 'Bearer u258-invalid-register-token'
    })
    assertHugeUnreadBody('invalid register token', result, 401)
  }, { timeout: 8000 })

  test('未知主机 heartbeat 声明 16 MiB → 404，消费字节远小于声明、连接关闭', async () => {
    const base = await start()
    const result = await pacedDeclaredBodyRequest(
      base,
      '/v1/hosts/host_u258_missing/heartbeat',
      DECLARED_16_MIB,
      { authorization: 'Bearer u258-invalid-host-credential' }
    )
    assertHugeUnreadBody('unknown host heartbeat', result, 404)
  }, { timeout: 8000 })

  test('小 body 的 401 仍保持 keep-alive：同连接第二次请求成功', async () => {
    const base = await start()
    const url = new URL(base)
    const socket = await connectRaw(base)
    try {
      const smallBody = JSON.stringify({ note: 'small-401' })
      socket.write(
        [
          'POST /v1/projects HTTP/1.1',
          `Host: ${url.host}`,
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(smallBody)}`,
          'Connection: keep-alive',
          '',
          smallBody
        ].join('\r\n')
      )
      const first = await readRawResponse(socket, 2000, 'small body 401')
      assert.equal(first.status, 401)
      assert.notEqual(first.headers.connection, 'close', 'a small unread body keeps keep-alive')

      socket.write(['GET /health HTTP/1.1', `Host: ${url.host}`, 'Connection: keep-alive', '', ''].join('\r\n'))
      const second = await readRawResponse(socket, 2000, 'health on the same connection')
      assert.equal(second.status, 200, 'the same connection serves the next request')
    } finally {
      socket.destroy()
    }
  }, { timeout: 5000 })

  test('合法登录不受影响：200 且同一连接继续复用', async () => {
    const base = await start()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      const first = await agentPost(
        agent,
        `${base}/v1/auth/login`,
        JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u258-ka-1' })
      )
      const second = await agentPost(
        agent,
        `${base}/v1/auth/login`,
        JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u258-ka-2' })
      )
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      assert.equal(first.reused, false)
      assert.equal(second.reused, true, 'a legal request keeps the connection usable')
    } finally {
      agent.destroy()
    }
  }, { timeout: 5000 })
})
