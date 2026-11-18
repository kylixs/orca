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
const FORCE_OFFLINE_BODY_MAX_BYTES = 4 * 1024
const DENIED_AUDIT_BODY_MAX_BYTES = 4 * 1024
const HEARTBEAT_BODY_MAX_BYTES = 1024 * 1024
/** U259 §2/§3/§5: a declared body no handler may consume before its early verdict. */
const DECLARED_HUGE_BODY = 16 * 1024 * 1024
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

function logout(base: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/auth/logout`, {
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

/**
 * U259 §1: a JSON body of an exact byte length. `padField` names the growable
 * field, so endpoints that reject unknown keys (internal file events) can still
 * be pinned at the boundary.
 */
function exactJsonBytes(
  fields: Record<string, unknown>,
  totalBytes: number,
  padField = 'pad'
): string {
  const overhead = Buffer.byteLength(JSON.stringify({ ...fields, [padField]: '' }))
  assert.ok(
    totalBytes >= overhead,
    `the fixture base is ${overhead} B, too large for the ${totalBytes} B boundary`
  )
  const body = JSON.stringify({ ...fields, [padField]: 'x'.repeat(totalBytes - overhead) })
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

/** U259 §3: the same in-process tamper the D2 pin uses, reused for D1/D3/D4. */
function breakAuditChain(app: ApiHandle): void {
  if (app.store.audit.length === 0) {
    app.audit.append({
      eventType: 'login',
      actor: 'admin',
      targetType: 'session',
      targetId: null,
      result: 'success',
      traceId: 'u259-chain-seed'
    })
  }
  const first = app.store.audit[0]
  assert.ok(first)
  first.metadata = { ...first.metadata, tampered: true }
  assert.equal(app.audit.verify().ok, false, 'the chain is now broken')
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
 * U259: headers/method are parameterised so the auth and denied orderings can
 * use the same non-pumping shape; `setCookie` is the undici-safe array form.
 */
function declaredOversizedRequest(
  base: string,
  path: string,
  declared: number,
  headers: Record<string, string> = {},
  method = 'POST'
): Promise<{
  status: number
  connection: string | undefined
  setCookie: string[]
  cacheControl: string | undefined
  body: string
  elapsedMs: number
}> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const req = httpRequest(
      `${base}${path}`,
      {
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': String(declared),
          ...headers
        }
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
            setCookie: res.headers['set-cookie'] ?? [],
            cacheControl: res.headers['cache-control'],
            body,
            elapsedMs
          })
        })
      }
    )
    // A server that waits for the rest of the declared body must fail, not hang.
    const deadline = setTimeout(() => {
      req.destroy()
      reject(new Error('no early verdict before the deadline: the server waited for the full body'))
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

/** Decodes the chunked reply framing `readRawResponse` also handles. */
function decodeChunkedBody(payload: Buffer): string {
  const parts: Buffer[] = []
  let cursor = 0
  while (cursor < payload.length) {
    const lineEnd = payload.indexOf('\r\n', cursor)
    if (lineEnd === -1) break
    const size = Number.parseInt(payload.subarray(cursor, lineEnd).toString('latin1'), 16)
    if (!Number.isFinite(size) || size === 0) break
    const start = lineEnd + 2
    parts.push(payload.subarray(start, start + size))
    cursor = start + size + 2
  }
  return Buffer.concat(parts).toString('utf8')
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
  headers: Record<string, string> = {},
  method = 'POST'
): Promise<{
  status: number
  connection: string | undefined
  responseMs: number
  closeMs: number
  receivedResponse: boolean
  closed: boolean
  acceptedBytes: number
  attemptedBytes: number
  body: string
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
    let headerLength = -1
    let chunked = false
    let rawBody = Buffer.alloc(0)
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
        attemptedBytes: attempted,
        body: chunked ? decodeChunkedBody(rawBody) : rawBody.toString('utf8')
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
          ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
          '',
          ''
        ].join('\r\n')
      )
    })
    socket.on('data', (data: Buffer) => {
      if (received) {
        rawBody = Buffer.concat([rawBody, data])
        return
      }
      headerBuffer = Buffer.concat([headerBuffer, data])
      const index = headerBuffer.indexOf('\r\n\r\n')
      if (index === -1) return
      const lines = headerBuffer.subarray(0, index).toString('latin1').split('\r\n')
      status = Number(lines[0]?.split(' ')[1] ?? 0)
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon === -1) continue
        const name = line.slice(0, colon).trim().toLowerCase()
        if (name === 'connection') connection = line.slice(colon + 1).trim()
        else if (name === 'transfer-encoding') {
          chunked = line.slice(colon + 1).trim().toLowerCase().includes('chunked')
        }
      }
      headerLength = index + 4
      rawBody = headerBuffer.subarray(headerLength)
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

    // Count the getter so both handlers are provably past the token check (and
    // parked in the body read) before either can reach check-and-reserve.
    const entry = app.store.hostTokens.at(-1)
    assert.ok(entry)
    let usedAtReads = 0
    let usedAtWrites = 0
    let usedAtValue: number | null = null
    Object.defineProperty(entry, 'usedAt', {
      configurable: true,
      enumerable: true,
      get: () => {
        usedAtReads += 1
        return usedAtValue
      },
      set: (value: number | null) => {
        usedAtWrites += 1
        usedAtValue = value
      }
    })

    const registerUrl = `${base}/v1/hosts/register`
    const hostsBefore = new Set(app.store.hosts.keys())
    const bodyLength = Buffer.byteLength(body)
    const prefixLength = Math.floor(body.length / 2)
    type Parked = {
      req: ReturnType<typeof httpRequest>
      response: Promise<{ status: number; payload: Json }>
    }
    const park = (): Parked => {
      let resolveResponse!: (value: { status: number; payload: Json }) => void
      let rejectResponse!: (error: Error) => void
      const response = new Promise<{ status: number; payload: Json }>((resolve, reject) => {
        resolveResponse = resolve
        rejectResponse = reject
      })
      const req = httpRequest(
        registerUrl,
        {
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'content-length': String(bodyLength)
          }
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            text += chunk
          })
          res.on('end', () => {
            resolveResponse({ status: res.statusCode ?? 0, payload: JSON.parse(text) as Json })
          })
        }
      )
      req.on('error', rejectResponse)
      // A failure before the response is awaited must not surface as unhandled.
      void response.catch(() => undefined)
      req.flushHeaders()
      // Deliberately incomplete: the handler parses only on `end`.
      req.write(body.slice(0, prefixLength))
      return { req, response }
    }
    const first = park()
    const second = park()
    try {
      const deadline = Date.now() + 2000
      while (usedAtReads < 2) {
        if (Date.now() > deadline) {
          throw new Error(`only ${usedAtReads}/2 registrations reached the token check`)
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
      }
      assert.equal(app.store.hosts.size, hostsBefore.size, 'no body was released yet')

      // Release both bodies together; only the post-read recheck can stop the loser.
      first.req.end(body.slice(prefixLength))
      second.req.end(body.slice(prefixLength))
      const results = await Promise.all([first.response, second.response])

      assert.deepEqual(
        results.map((result) => result.status).sort(),
        [201, 401],
        'the token reservation is synchronous, so only one request can win'
      )
      const created = results.find((result) => result.status === 201)
      const refused = results.find((result) => result.status === 401)
      assert.ok(created)
      assert.ok(refused)
      assert.equal(errorCode(refused.payload), 'HOST_TOKEN_INVALID')

      // Count by host id: two successful registrations collapse into one
      // hostsByName entry, so the name index used to hide the duplicate.
      const hostId = String(created.payload.hostId)
      const addedHosts = [...app.store.hosts.keys()].filter((id) => !hostsBefore.has(id))
      assert.deepEqual(addedHosts, [hostId])
      assert.equal(app.store.hosts.size, hostsBefore.size + 1)
      assert.equal(app.store.hosts.get(hostId)?.name, 'u257-race-host')
      assert.equal(usedAtWrites, 1, 'the single-use token is reserved exactly once')
      assert.equal(typeof entry.usedAt, 'number')
    } finally {
      first.req.destroy()
      second.req.destroy()
    }
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

/**
 * U261: register accepted any element type and only failed later inside
 * `ipOfDirectAddr`, which turned a field error into a 500 after the single-use
 * token was spent. Project creation coerced an unknown downloadPolicy to deny.
 */
describe('U261 directAddrs 与项目 downloadPolicy 入口校验', () => {
  test('register directAddrs 含非字符串/非法地址 → 400 HOST_DIRECTADDRS_INVALID，令牌可重试', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u261-directaddr-admin')

    const token = await mintHostToken(base, admin.token)
    const refused = await registerHost(
      base,
      token,
      JSON.stringify({
        name: 'u261-directaddr-host',
        protocolVersion: 3,
        directAddrs: [123]
      })
    )
    const payload = (await refused.json()) as Json
    assert.equal(refused.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'HOST_DIRECTADDRS_INVALID')
    assert.equal(app.store.hostsByName.has('u261-directaddr-host'), false)
    assert.equal(app.store.hostTokens.at(-1)?.usedAt, null, 'the refusal spends no token')

    const retried = await registerHost(
      base,
      token,
      JSON.stringify({
        name: 'u261-directaddr-host',
        protocolVersion: 3,
        directAddrs: ['10.0.0.5:16811']
      })
    )
    assert.equal(retried.status, 201, await retried.text())
    assert.ok(app.store.hostsByName.has('u261-directaddr-host'), 'the retry registers the host')

    const badToken = await mintHostToken(base, admin.token)
    const badAddr = await registerHost(
      base,
      badToken,
      JSON.stringify({
        name: 'u261-directaddr-bad',
        protocolVersion: 3,
        directAddrs: ['not a host']
      })
    )
    const badPayload = (await badAddr.json()) as Json
    assert.equal(badAddr.status, 400, JSON.stringify(badPayload))
    assert.equal(errorCode(badPayload), 'HOST_DIRECTADDRS_INVALID')
    assert.equal(app.store.hostTokens.at(-1)?.usedAt, null, 'the bad address spends no token')
  })

  test('POST /v1/projects：非法 downloadPolicy → 400 POLICY_INVALID 且不落库；缺省仍按 deny', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u261-policy-admin')
    const fields = {
      hostId: HOST_ID,
      key: 'u261-policy-invalid',
      name: 'u261-policy-invalid',
      path: '/srv/work/u261-policy-invalid',
      defaultBranch: 'main'
    }

    const refused = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/projects',
      JSON.stringify({ ...fields, downloadPolicy: 'banana' })
    )
    const payload = (await refused.json()) as Json
    assert.equal(refused.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(payload), 'POLICY_INVALID')
    assert.equal(app.store.projectsByKey.has(fields.key), false, 'no project is written')

    const omitted = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/projects',
      JSON.stringify({
        ...fields,
        key: 'u261-policy-default',
        name: 'u261-policy-default',
        path: '/srv/work/u261-policy-default'
      })
    )
    assert.equal(omitted.status, 201, await omitted.text())
    assert.equal(
      app.store.projectsByKey.get('u261-policy-default')?.downloadPolicy,
      'deny',
      'an absent downloadPolicy keeps the deny default'
    )
  })
})

describe('U259 §1 各档精确边界', () => {
  test('B1 AUTH login 16 KiB：16,384 → 200 建会话；16,385 → 413 无会话、无成功审计', async () => {
    const { app, base } = await startApp()
    const accepted = await login(
      base,
      exactJsonBytes(
        { username: 'admin', password: 'Adm1n!', deviceName: 'u259-b1-accepted' },
        AUTH_BODY_MAX_BYTES
      )
    )
    assert.equal(accepted.status, 200, await accepted.text())
    assert.equal(app.store.sessions.size, 1, 'the boundary request signs in once')

    const refusedName = 'u259-b1-refused'
    const refused = await login(
      base,
      exactJsonBytes(
        { username: 'admin', password: 'Adm1n!', deviceName: refusedName },
        AUTH_BODY_MAX_BYTES + 1
      )
    )
    assert.equal(refused.status, 413)
    assert.equal(errorCode((await refused.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(refused.headers.get('cache-control'), 'no-store')
    assert.equal(refused.headers.get('connection'), 'close')
    assert.equal(app.store.sessions.size, 1, 'the refused login creates no session')
    const successes = app.store.audit.filter(
      (event) => event.eventType === 'login' && event.result === 'success'
    )
    assert.equal(successes.length, 1, 'only the accepted login is audited')
  })

  test('B2 AUTH refresh body 16 KiB：16,384 → 200 轮换；16,385 → 413 不消耗 token', async () => {
    const base = await start()
    const first = (await (
      await login(
        base,
        JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u259-b2-accepted' })
      )
    ).json()) as Json
    const accepted = await refresh(
      base,
      exactJsonBytes({ refreshToken: first.refreshToken }, AUTH_BODY_MAX_BYTES)
    )
    const rotated = (await accepted.json()) as Json
    assert.equal(accepted.status, 200, JSON.stringify(rotated))
    assert.equal(typeof rotated.refreshToken, 'string')
    assert.notEqual(rotated.refreshToken, first.refreshToken, 'the boundary refresh rotates once')

    const second = (await (
      await login(
        base,
        JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u259-b2-refused' })
      )
    ).json()) as Json
    const token = String(second.refreshToken)
    const refused = await refresh(
      base,
      exactJsonBytes({ refreshToken: token }, AUTH_BODY_MAX_BYTES + 1)
    )
    assert.equal(refused.status, 413)
    assert.equal(errorCode((await refused.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(refused.headers.get('cache-control'), 'no-store')
    assert.equal(refused.headers.get('connection'), 'close')

    const again = await refresh(base, JSON.stringify({ refreshToken: token }))
    assert.equal(again.status, 200, 'the refused refresh neither rotated nor consumed the token')
  })

  test('B3 LOGOUT 16 KiB：16,384 → 撤销；16,385 → 200 空 body + 清除头，token 仍可用', async () => {
    const base = await start()
    const acceptedToken = String(
      (
        (await (
          await login(
            base,
            JSON.stringify({
              username: 'admin',
              password: 'Adm1n!',
              deviceName: 'u259-b3-accepted'
            })
          )
        ).json()) as Json
      ).refreshToken
    )
    const accepted = await logout(
      base,
      exactJsonBytes({ refreshToken: acceptedToken }, AUTH_BODY_MAX_BYTES)
    )
    assert.equal(accepted.status, 200, await accepted.text())
    const cleared = accepted.headers.getSetCookie()
    assert.ok(
      cleared.some((entry) => entry.startsWith('orca_refresh=;') && entry.includes('Max-Age=0')),
      'logout still clears the browser Cookie'
    )
    const revoked = await refresh(base, JSON.stringify({ refreshToken: acceptedToken }))
    assert.equal(revoked.status, 401, 'the boundary logout revokes the session')

    const keptToken = String(
      (
        (await (
          await login(
            base,
            JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u259-b3-refused' })
          )
        ).json()) as Json
      ).refreshToken
    )
    const refused = await logout(
      base,
      exactJsonBytes({ refreshToken: keptToken }, AUTH_BODY_MAX_BYTES + 1)
    )
    assert.equal(refused.status, 200, 'logout keeps its empty-body 200')
    assert.equal(refused.headers.get('connection'), 'close')
    assert.ok(
      refused.headers
        .getSetCookie()
        .some((entry) => entry.startsWith('orca_refresh=;') && entry.includes('Max-Age=0')),
      'the oversized logout still clears the Cookie'
    )
    const stillValid = await refresh(base, JSON.stringify({ refreshToken: keptToken }))
    assert.equal(stillValid.status, 200, 'the discarded body did not revoke the session')
  })

  test('B4 INTERNAL 8 KiB：relay 与 file-events 各 8,192 → 成功；8,193 → 400 整包丢弃', async () => {
    const base = await start()
    const relayFields = { id: 'u259-relay', port: 28451, installNonce: 'u259-nonce' }
    const relayOk = await postInternal(
      base,
      '/v1/internal/relay-endpoint',
      exactJsonBytes(relayFields, INTERNAL_BODY_MAX_BYTES)
    )
    assert.equal(relayOk.status, 200, await relayOk.text())

    const relayOver = await postInternal(
      base,
      '/v1/internal/relay-endpoint',
      exactJsonBytes(relayFields, INTERNAL_BODY_MAX_BYTES + 1)
    )
    assert.equal(relayOver.status, 400)
    assert.equal(errorCode((await relayOver.json()) as Json), 'RELAY_PORT_INVALID')
    assert.equal(relayOver.headers.get('connection'), 'close')

    const eventFields = { eventType: 'file_download', result: 'success' }
    const eventOk = await postInternal(
      base,
      '/v1/internal/audit/file-events',
      exactJsonBytes(eventFields, INTERNAL_BODY_MAX_BYTES, 'subject')
    )
    assert.equal(eventOk.status, 200, await eventOk.text())

    const eventOver = await postInternal(
      base,
      '/v1/internal/audit/file-events',
      exactJsonBytes(eventFields, INTERNAL_BODY_MAX_BYTES + 1, 'subject')
    )
    assert.equal(eventOver.status, 400)
    assert.equal(errorCode((await eventOver.json()) as Json), 'INVALID_FILE_EVENT')
    assert.equal(eventOver.headers.get('connection'), 'close')
  })

  test('B5 FORCE_OFFLINE 4 KiB：4,096 → reason 保留；4,097 → 200 空 body', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-b5-admin')

    const acceptedTarget = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u259-b5-accepted')
    const accepted = await authedJson(
      base,
      admin.token,
      'POST',
      `/v1/users/${acceptedTarget.userId}/sessions/revoke`,
      exactJsonBytes({ reason: 'r'.repeat(3600) }, FORCE_OFFLINE_BODY_MAX_BYTES)
    )
    const acceptedPayload = (await accepted.json()) as Json
    assert.equal(accepted.status, 200, JSON.stringify(acceptedPayload))
    assert.equal(acceptedPayload.revokedSessions, 1)

    const refusedTarget = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u259-b5-refused')
    const refused = await authedJson(
      base,
      admin.token,
      'POST',
      `/v1/users/${refusedTarget.userId}/sessions/revoke`,
      exactJsonBytes({ reason: 'r'.repeat(3600) }, FORCE_OFFLINE_BODY_MAX_BYTES + 1)
    )
    const refusedPayload = (await refused.json()) as Json
    assert.equal(refused.status, 200, JSON.stringify(refusedPayload))
    assert.equal(refusedPayload.revokedSessions, 1)
    assert.equal(refused.headers.get('connection'), 'close')

    const events = app.store.audit.filter(
      (event) =>
        event.eventType === 'session_revoke' &&
        event.result === 'success' &&
        event.targetId === acceptedTarget.userId
    )
    const withReason = events.find(
      (event) => (event.metadata as Json | undefined)?.reason === 'r'.repeat(200)
    )
    assert.ok(withReason, 'the 4,096 B reason is kept, truncated to the audit limit')
    assert.equal(((withReason.metadata as Json).reason as string).length, 200)

    const withoutReason = events.find(
      (event) => event !== withReason && !('reason' in (event.metadata as Json))
    )
    assert.ok(withoutReason, 'the 4,097 B body counts as empty')
    assert.equal(
      withoutReason.targetId,
      acceptedTarget.userId,
      'the refused request still revoked the fresh session'
    )
    assert.equal(refusedTarget.userId, acceptedTarget.userId)
  })

  test('B6 SENSITIVE WRITE 16 KiB：16,384 → 201；16,385 → 413 未建项目', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-b6-admin')
    const acceptedKey = 'u259-bound-ok'
    const accepted = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/projects',
      exactJsonBytes(
        {
          hostId: HOST_ID,
          key: acceptedKey,
          name: acceptedKey,
          path: '/srv/u259-bound-ok',
          defaultBranch: 'main'
        },
        SENSITIVE_WRITE_BODY_MAX_BYTES
      )
    )
    assert.equal(accepted.status, 201, await accepted.text())
    assert.ok(app.store.projectsByKey.has(acceptedKey), 'the boundary body creates the project')

    const refusedKey = 'u259-bound-no'
    const refused = await authedJson(
      base,
      admin.token,
      'POST',
      '/v1/projects',
      exactJsonBytes(
        {
          hostId: HOST_ID,
          key: refusedKey,
          name: refusedKey,
          path: '/srv/u259-bound-no',
          defaultBranch: 'main'
        },
        SENSITIVE_WRITE_BODY_MAX_BYTES + 1
      )
    )
    assert.equal(refused.status, 413)
    assert.equal(errorCode((await refused.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(refused.headers.get('connection'), 'close')
    assert.equal(
      app.store.projectsByKey.has(refusedKey),
      false,
      'the refused create persists nothing'
    )

    const created = app.store.audit.filter(
      (event) =>
        event.eventType === 'project_create' &&
        event.result === 'success' &&
        (event.metadata as Json | undefined)?.key === acceptedKey
    )
    assert.equal(created.length, 1, 'exactly the accepted create is audited')
    const refusedEvents = app.store.audit.filter(
      (event) =>
        event.eventType === 'project_create' &&
        (event.metadata as Json | undefined)?.key === refusedKey
    )
    assert.equal(refusedEvents.length, 0, 'the refused create is not audited')
  })

  test('B7 HEARTBEAT 1 MiB：1,048,576 → 200 前进；1,048,577 → 413 状态不变', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-b7-admin')
    const hostToken = await mintHostToken(base, admin.token)
    const registered = await registerHost(
      base,
      hostToken,
      JSON.stringify({ name: 'u259-heartbeat', protocolVersion: 3, networkZone: 'intranet' })
    )
    const host = (await registered.json()) as Json
    assert.equal(registered.status, 201, JSON.stringify(host))
    const hostId = String(host.hostId)
    const stored = app.store.hosts.get(hostId)
    assert.ok(stored)
    const before = Date.now() - 60_000
    stored.lastHeartbeatAt = before

    const accepted = await postHeartbeat(
      base,
      hostId,
      String(host.credential),
      exactJsonBytes({ status: 'online' }, HEARTBEAT_BODY_MAX_BYTES)
    )
    assert.equal(accepted.status, 200, await accepted.text())
    assert.equal(stored.status, 'online')
    assert.ok(stored.lastHeartbeatAt > before, 'the boundary beat advances lastHeartbeatAt')
    const afterAccepted = stored.lastHeartbeatAt

    const refused = await postHeartbeat(
      base,
      hostId,
      String(host.credential),
      exactJsonBytes({ status: 'offline' }, HEARTBEAT_BODY_MAX_BYTES + 1)
    )
    assert.equal(refused.status, 413)
    assert.equal(errorCode((await refused.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(refused.headers.get('connection'), 'close')
    assert.equal(stored.status, 'online', 'the refused beat does not apply offline')
    assert.equal(stored.lastHeartbeatAt, afterAccepted, 'the refused beat does not touch the clock')
  })

  test('B8 DENIED 4 KiB：4,096 → 保留 subjectId；4,097 → 空 metadata', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-b8-admin')
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u259-b8-dev')
    const subjectId = 'u'.repeat(900)
    const fields = { subjectType: 'user', subjectId, permissions: ['open'] }

    const accepted = await authedJson(
      base,
      dev.token,
      'PUT',
      `/v1/projects/${PROJECT_ID}/grants`,
      exactJsonBytes(fields, DENIED_AUDIT_BODY_MAX_BYTES)
    )
    assert.equal(accepted.status, 403)
    assert.equal(errorCode((await accepted.json()) as Json), 'PERMISSION_DENIED')

    const refused = await authedJson(
      base,
      dev.token,
      'PUT',
      `/v1/projects/${PROJECT_ID}/grants`,
      exactJsonBytes(fields, DENIED_AUDIT_BODY_MAX_BYTES + 1)
    )
    assert.equal(refused.status, 403)
    assert.equal(errorCode((await refused.json()) as Json), 'PERMISSION_DENIED')
    assert.equal(refused.headers.get('connection'), 'close')

    const events = (await deniedAuditEvents(base, admin.token, 'zhangsan')).filter(
      (event) => event.eventType === 'grant_update'
    )
    const kept = events.find((event) => (event.metadata as Json).subjectId === subjectId)
    assert.ok(kept, 'the 4,096 B body keeps the refused subject')
    assert.deepEqual((kept.metadata as Json).permissions, ['open'])

    const dropped = events.find(
      (event) => event !== kept && (event.metadata as Json).subjectId === ''
    )
    assert.ok(dropped, 'the 4,097 B body counts as empty')
    assert.deepEqual((dropped.metadata as Json).permissions, [])
  })
})

describe('U259 §4 refresh Cookie 413 真断言', () => {
  async function loginWithRefreshCookie(
    app: ApiHandle,
    base: string,
    deviceName: string
  ): Promise<{ cookie: string; sessionId: string }> {
    const res = await login(
      base,
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName }),
      { origin: ORIGIN }
    )
    assert.equal(res.status, 200, await res.text())
    const cookie = res.headers.getSetCookie()[0]?.split(';')[0] ?? ''
    assert.match(cookie, /^orca_refresh=/)
    const sessions = [...app.store.sessions.values()]
    assert.equal(sessions.length, 1, 'the cookie login creates one session')
    const session = sessions[0]
    assert.ok(session)
    return { cookie, sessionId: session.id }
  }

  test('R1 413 响应无任何 Set-Cookie（不偷偷清 Cookie）', async () => {
    const { app, base } = await startApp()
    const { cookie } = await loginWithRefreshCookie(app, base, 'u259-r1')

    const res = await refresh(base, oversized({}), { cookie, origin: ORIGIN })
    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(
      res.headers.getSetCookie().length,
      0,
      'a refused refresh must neither clear nor rotate the Cookie'
    )
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  test('R2 413 不轮换、不续期、不触发 reuse detection', async () => {
    const { app, base } = await startApp()
    const { cookie, sessionId } = await loginWithRefreshCookie(app, base, 'u259-r2')
    const session = app.store.sessions.get(sessionId)
    assert.ok(session)
    const before = {
      refreshHash: session.refreshHash,
      previousRefreshHash: session.previousRefreshHash,
      refreshExpiresAt: session.refreshExpiresAt
    }

    const res = await refresh(base, oversized({}), { cookie, origin: ORIGIN })
    assert.equal(res.status, 413)
    assert.equal(errorCode((await res.json()) as Json), 'PAYLOAD_TOO_LARGE')

    assert.equal(session.refreshHash, before.refreshHash, 'refreshHash is unchanged')
    assert.equal(
      session.previousRefreshHash,
      before.previousRefreshHash,
      'previousRefreshHash is unchanged'
    )
    assert.equal(session.refreshExpiresAt, before.refreshExpiresAt, 'refreshExpiresAt is unchanged')
    assert.equal(session.revokedAt, null, 'the refused refresh does not revoke the session')
    const reuse = app.store.audit.filter(
      (event) =>
        event.eventType === 'refresh.reuse_detected' || event.eventType === 'refresh.grace_reuse'
    )
    assert.equal(reuse.length, 0, 'no reuse or grace event is written')
  })

  test('R3 同一 Cookie 随后小 body 刷新 200，且重发同一 Cookie 值', async () => {
    const { app, base } = await startApp()
    const { cookie, sessionId } = await loginWithRefreshCookie(app, base, 'u259-r3')

    const refused = await refresh(base, oversized({}), { cookie, origin: ORIGIN })
    assert.equal(refused.status, 413)
    assert.equal(refused.headers.getSetCookie().length, 0)

    const small = await refresh(base, '{}', { cookie, origin: ORIGIN })
    const payload = (await small.json()) as Json
    assert.equal(small.status, 200, JSON.stringify(payload))
    assert.equal(payload.refreshCookie, true, 'the browser renewal re-sends the Cookie')
    const resent = small.headers.getSetCookie()
    assert.equal(resent.length, 1, 'one renewal Cookie')
    assert.equal(resent[0]?.split(';')[0], cookie, 'the same value is re-sent, not cleared')
    assert.equal(/Max-Age=0/.test(resent[0] ?? ''), false, 'the renewal is not a clear')
    const session = app.store.sessions.get(sessionId)
    assert.ok(session)
    assert.equal(session.revokedAt, null, 'the session survives the refused refresh')
  })
})

/**
 * U259 §2: for login/refresh the credential-shape verdict must be reached
 * before the body cap, otherwise a caller can use 413-vs-401/403 to probe
 * Cookie/Origin state and make the server consume an unbounded body.
 */
describe('U259 §2 401/403 先于 413', () => {
  test('O1 login 重复 Cookie + 声明 16 MiB → 401 先于 413，并清除 Cookie', async () => {
    const base = await start()
    const result = await declaredOversizedRequest(
      base,
      '/v1/auth/login',
      DECLARED_HUGE_BODY,
      { cookie: 'orca_refresh=a; orca_refresh=b' },
      'POST'
    )

    assert.equal(result.status, 401, 'the ambiguous Cookie wins over the body cap')
    assert.equal(errorCode(JSON.parse(result.body) as Json), 'SESSION_EXPIRED')
    assert.equal(
      result.body.includes('PAYLOAD_TOO_LARGE'),
      false,
      'the size verdict must leak nowhere'
    )
    assert.equal(result.connection, 'close', 'the unread body must not be drained')
    assert.ok(result.elapsedMs < 1000, `the refusal took ${result.elapsedMs}ms`)
    assert.match(result.setCookie.join(','), /Max-Age=0/, 'the stale Cookie is cleared')
  })

  test('O2 login 外部 Origin + 声明 16 MiB → 403 CSRF_REJECTED 先于 413', async () => {
    const base = await start()
    const result = await declaredOversizedRequest(
      base,
      '/v1/auth/login',
      DECLARED_HUGE_BODY,
      { origin: 'https://evil.example' },
      'POST'
    )

    assert.equal(result.status, 403, 'the foreign Origin wins over the body cap')
    assert.equal(errorCode(JSON.parse(result.body) as Json), 'CSRF_REJECTED')
    assert.equal(result.body.includes('PAYLOAD_TOO_LARGE'), false)
    assert.equal(result.connection, 'close')
    assert.ok(result.elapsedMs < 1000, `the refusal took ${result.elapsedMs}ms`)
    assert.equal(result.setCookie.length, 0, 'a CSRF refusal never touches Cookie state')
  })

  test('O3 refresh 重复 Cookie + 声明 16 MiB → 401 先于 413，并清除 Cookie', async () => {
    const base = await start()
    const result = await declaredOversizedRequest(
      base,
      '/v1/auth/refresh',
      DECLARED_HUGE_BODY,
      { cookie: 'orca_refresh=a; orca_refresh=b', origin: ORIGIN },
      'POST'
    )

    assert.equal(result.status, 401)
    assert.equal(errorCode(JSON.parse(result.body) as Json), 'SESSION_EXPIRED')
    assert.equal(result.body.includes('PAYLOAD_TOO_LARGE'), false)
    assert.equal(result.connection, 'close')
    assert.ok(result.elapsedMs < 1000, `the refusal took ${result.elapsedMs}ms`)
    assert.match(result.setCookie.join(','), /Max-Age=0/, 'the stale Cookie is cleared')
  })

  test('O4 refresh Cookie CSRF 失败 + 声明 16 MiB → 403 先于 413，不清 Cookie', async () => {
    const { app, base } = await startApp()
    const loginRes = await login(
      base,
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u259-o4' }),
      { origin: ORIGIN }
    )
    assert.equal(loginRes.status, 200, await loginRes.text())
    const cookie = loginRes.headers.getSetCookie()[0]?.split(';')[0] ?? ''
    assert.match(cookie, /^orca_refresh=/)

    const result = await declaredOversizedRequest(
      base,
      '/v1/auth/refresh',
      DECLARED_HUGE_BODY,
      { cookie, origin: 'https://evil.example' },
      'POST'
    )
    assert.equal(result.status, 403, 'the CSRF verdict wins over the body cap')
    assert.equal(errorCode(JSON.parse(result.body) as Json), 'CSRF_REJECTED')
    assert.equal(result.body.includes('PAYLOAD_TOO_LARGE'), false)
    assert.equal(result.connection, 'close')
    assert.ok(result.elapsedMs < 1000, `the refusal took ${result.elapsedMs}ms`)
    assert.equal(result.setCookie.length, 0, 'CSRF has no side effect on the Cookie')

    const sessions = [...app.store.sessions.values()]
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.revokedAt, null, 'the refused request did not revoke the session')
    const small = await refresh(base, '{}', { cookie, origin: ORIGIN })
    assert.equal(small.status, 200, 'the untouched Cookie still refreshes')
  })

  test('O5 refresh 无效 token + 超限 → 413（不区分 token 是否存在）', async () => {
    const { app, base } = await startApp()
    const missing = 'u259-does-not-exist'

    const refused = await refresh(base, oversized({ refreshToken: missing }))
    assert.equal(refused.status, 413, 'the cap runs before the token lookup')
    assert.equal(errorCode((await refused.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(refused.headers.get('cache-control'), 'no-store')

    const small = await refresh(base, JSON.stringify({ refreshToken: missing }))
    assert.equal(small.status, 401, 'the same token is only judged after a readable body')
    assert.equal(errorCode((await small.json()) as Json), 'SESSION_EXPIRED')
    assert.equal(
      app.store.audit.filter((event) => event.eventType === 'refresh.reuse_detected').length,
      0
    )
  })

  test('O6 login 错凭据 + 超限 → 413，不计失败、不写登录失败审计', async () => {
    const { app, base } = await startApp()

    const refused = await login(base, oversized({ username: 'admin', password: 'wrong' }))
    assert.equal(refused.status, 413, 'the cap runs before the credential check')
    assert.equal(errorCode((await refused.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(
      app.store.loginAttempts.get('admin')?.count ?? 0,
      0,
      'the refused request must not poison the lockout counter'
    )
    assert.equal(
      app.store.audit.filter((event) => event.eventType === 'login').length,
      0,
      'no login failure event is written'
    )

    const accepted = await login(
      base,
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u259-o6-ok' })
    )
    assert.equal(accepted.status, 200, 'the correct credentials still work')
    assert.equal(app.store.sessions.size, 1)
  })
})

/**
 * U259 §3: D2 already pins "503 before 413". D1/D3/D4 are the remaining
 * high-impact writes whose audit-availability gate must run before the body
 * read, or a broken chain degrades into a 413 with unbounded consumption.
 */
describe('U259 §3 503 先于 413 推广到 D1/D3/D4', () => {
  function brokenVerdict(result: { status: number; connection: string | undefined; body: string }) {
    assert.equal(result.status, 503)
    const parsed = JSON.parse(result.body) as Json
    assert.equal(errorCode(parsed), 'AUDIT_CHAIN_BROKEN')
    const details = (parsed.error as Json).details as Json
    assert.equal(details.reason, 'chain_broken', 'write_failed is a different, retryable branch')
    assert.equal(result.connection, 'close')
  }

  test('C1 D1 项目更新：链损坏 + 声明 16 MiB → 503，项目不变', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-c1')
    const before = app.store.projects.get(PROJECT_ID)
    assert.ok(before)
    const repoUrl = before.repoUrl
    const defaultBranch = before.defaultBranch
    breakAuditChain(app)

    const result = await declaredOversizedRequest(
      base,
      `/v1/projects/${PROJECT_ID}`,
      DECLARED_HUGE_BODY,
      { authorization: `Bearer ${admin.token}` },
      'PUT'
    )

    brokenVerdict(result)
    const after = app.store.projects.get(PROJECT_ID)
    assert.ok(after)
    assert.equal(after.repoUrl, repoUrl, 'nothing was written')
    assert.equal(after.defaultBranch, defaultBranch, 'nothing was written')
  })

  test('C3 D3 全局下载策略：链损坏 + 声明 16 MiB → 503，策略与版本不变', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-c3')
    const downloadDefault = app.store.policies.downloadDefault
    const version = app.store.policies.version
    breakAuditChain(app)

    const result = await declaredOversizedRequest(
      base,
      '/v1/policies/download',
      DECLARED_HUGE_BODY,
      { authorization: `Bearer ${admin.token}` },
      'PUT'
    )

    brokenVerdict(result)
    assert.equal(
      app.store.policies.downloadDefault,
      downloadDefault,
      'the global default is unchanged'
    )
    assert.equal(app.store.policies.version, version, 'the policy version is unchanged')
  })

  test('C4 D4 主机维护：链损坏 + 声明 16 MiB → 503，主机仍在线', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-c4')
    breakAuditChain(app)

    const result = await declaredOversizedRequest(
      base,
      `/v1/hosts/${HOST_ID}/maintenance`,
      DECLARED_HUGE_BODY,
      { authorization: `Bearer ${admin.token}` },
      'POST'
    )

    brokenVerdict(result)
    const host = app.store.hosts.get(HOST_ID)
    assert.ok(host)
    assert.equal(host.status, 'online', 'the audit gate precedes the field check and the write')
    assert.equal(host.maintenanceReason, null)
  })

  test('C5 对照：链健康 + 同样超限 body → 413 且无写入', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-c5')
    const projectBefore = app.store.projects.get(PROJECT_ID)
    assert.ok(projectBefore)
    const repoUrl = projectBefore.repoUrl
    const downloadDefault = app.store.policies.downloadDefault
    const version = app.store.policies.version

    const update = await authedJson(
      base,
      admin.token,
      'PUT',
      `/v1/projects/${PROJECT_ID}`,
      oversizedBody({ repoUrl: 'https://git.example.com/changed.git', defaultBranch: 'changed' })
    )
    assert.equal(update.status, 413)
    assert.equal(errorCode((await update.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(update.headers.get('connection'), 'close')

    const policy = await authedJson(
      base,
      admin.token,
      'PUT',
      '/v1/policies/download',
      oversizedBody({ downloadDefault: 'allow' })
    )
    assert.equal(policy.status, 413)
    assert.equal(errorCode((await policy.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(policy.headers.get('connection'), 'close')

    const maintenance = await authedJson(
      base,
      admin.token,
      'POST',
      `/v1/hosts/${HOST_ID}/maintenance`,
      oversizedBody({ enabled: true })
    )
    assert.equal(maintenance.status, 413)
    assert.equal(errorCode((await maintenance.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(maintenance.headers.get('connection'), 'close')

    const projectAfter = app.store.projects.get(PROJECT_ID)
    assert.ok(projectAfter)
    assert.equal(projectAfter.repoUrl, repoUrl, 'the healthy-chain 413 still writes nothing')
    assert.equal(app.store.policies.downloadDefault, downloadDefault)
    assert.equal(app.store.policies.version, version)
    const host = app.store.hosts.get(HOST_ID)
    assert.ok(host)
    assert.equal(host.status, 'online')
  })
})

/**
 * U259 §5: these six denial branches decide on the role alone; they must never
 * start reading the body to enrich the denied audit, or an unauthorised caller
 * regains ownership of how much the server consumes.
 */
describe('U259 §5 denied 审计固定字段（不读 body）', () => {
  const BODY_FIELDS = [
    'role',
    'downloadPolicy',
    'inherit',
    'downloadDefault',
    'key',
    'path',
    'hostId',
    'name',
    'pad',
    'auditSize'
  ]

  function assertFixedDeniedEvent(
    event: Json | undefined,
    expected: { eventType: string; targetType: string; targetId: string | null }
  ): void {
    assert.ok(event, `${expected.eventType} denied event is missing`)
    assert.equal(event.eventType, expected.eventType)
    assert.equal(event.actor, 'zhangsan')
    assert.equal(event.targetType, expected.targetType)
    assert.equal(event.targetId, expected.targetId)
    assert.equal(event.result, 'denied')
    assert.deepEqual(
      event.metadata,
      { reason: 'PERMISSION_DENIED', requiredPermission: 'platform:admin' },
      'the denied event carries exactly the fixed fields'
    )
    for (const field of BODY_FIELDS) {
      assert.equal(field in event, false, `${field} must not leak into the event`)
      assert.equal(field in (event.metadata as Json), false, `${field} must not leak into metadata`)
    }
    assert.notEqual((event.metadata as Json).reason, 'attacker text', 'the body note is not copied')
  }

  function oneDeniedEvent(events: Json[], eventType: string, targetType: string): Json | undefined {
    const matches = events.filter(
      (event) => event.eventType === eventType && event.targetType === targetType
    )
    assert.equal(matches.length, 1, `expected one ${eventType}/${targetType} denied event`)
    return matches[0]
  }

  test('N1-N6：403 + 固定审计字段，不含任何 body 字段', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-n-admin')
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u259-n-dev')
    const devSession = [...app.store.sessions.values()].find(
      (session) => session.userId === dev.userId
    )
    assert.ok(devSession)
    const projectBefore = app.store.projects.get(PROJECT_ID)
    assert.ok(projectBefore)
    const projectCount = app.store.projects.size
    const downloadPolicy = projectBefore.downloadPolicy
    const globalDefault = app.store.policies.downloadDefault
    const policyVersion = app.store.policies.version
    const hostTokenCount = app.store.hostTokens.length
    const pad = 'x'.repeat(1024)

    const requests = [
      {
        method: 'PUT',
        path: `/v1/users/${dev.userId}/roles`,
        body: { role: 'admin', pad }
      },
      {
        method: 'PUT',
        path: `/v1/projects/${PROJECT_ID}/policy`,
        body: { downloadPolicy: 'allow', inherit: true, pad }
      },
      {
        method: 'PUT',
        path: '/v1/policies/download',
        body: { downloadDefault: 'allow', pad }
      },
      {
        method: 'POST',
        path: '/v1/projects',
        body: {
          hostId: HOST_ID,
          key: 'u259-denied',
          name: 'u259-denied',
          path: '/srv/u259-denied',
          defaultBranch: 'main',
          pad
        }
      },
      { method: 'POST', path: '/v1/hosts/tokens', body: { hostId: HOST_ID, pad } },
      {
        method: 'POST',
        path: `/v1/users/${dev.userId}/sessions/revoke`,
        body: { reason: 'attacker text', pad }
      }
    ]
    for (const request of requests) {
      const res = await authedJson(
        base,
        dev.token,
        request.method,
        request.path,
        JSON.stringify(request.body)
      )
      assert.equal(res.status, 403, `${request.method} ${request.path}`)
      assert.equal(errorCode((await res.json()) as Json), 'PERMISSION_DENIED')
    }

    const events = await deniedAuditEvents(base, admin.token, 'zhangsan')
    assertFixedDeniedEvent(oneDeniedEvent(events, 'role_update', 'user'), {
      eventType: 'role_update',
      targetType: 'user',
      targetId: dev.userId
    })
    assertFixedDeniedEvent(oneDeniedEvent(events, 'policy_update', 'project'), {
      eventType: 'policy_update',
      targetType: 'project',
      targetId: PROJECT_ID
    })
    assertFixedDeniedEvent(oneDeniedEvent(events, 'policy_update', 'policy'), {
      eventType: 'policy_update',
      targetType: 'policy',
      targetId: 'download'
    })
    assertFixedDeniedEvent(oneDeniedEvent(events, 'project_create', 'project'), {
      eventType: 'project_create',
      targetType: 'project',
      targetId: null
    })
    assertFixedDeniedEvent(oneDeniedEvent(events, 'host_token_create', 'host'), {
      eventType: 'host_token_create',
      targetType: 'host',
      targetId: null
    })
    assertFixedDeniedEvent(oneDeniedEvent(events, 'session_revoke', 'user'), {
      eventType: 'session_revoke',
      targetType: 'user',
      targetId: dev.userId
    })

    const devUser = app.store.users.get(dev.userId)
    assert.ok(devUser)
    assert.deepEqual(devUser.roles, ['developer'], 'the refused role change did nothing')
    const projectAfter = app.store.projects.get(PROJECT_ID)
    assert.ok(projectAfter)
    assert.equal(projectAfter.downloadPolicy, downloadPolicy)
    assert.equal(app.store.policies.downloadDefault, globalDefault)
    assert.equal(app.store.policies.version, policyVersion)
    assert.equal(app.store.projects.size, projectCount, 'the refused create wrote no project')
    assert.equal(app.store.projectsByKey.has('u259-denied'), false)
    assert.equal(app.store.hostTokens.length, hostTokenCount, 'the refused mint wrote no token')
    assert.equal(devSession.revokedAt, null, 'the refused revoke left the session live')
  })

  test('N1-N6 声明 16 MiB 未读 body：403 + close，审计仍为固定字段', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-nh-admin')
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u259-nh-dev')
    const devSession = [...app.store.sessions.values()].find(
      (session) => session.userId === dev.userId
    )
    assert.ok(devSession)
    const authorization = { authorization: `Bearer ${dev.token}` }
    const hostTokenCount = app.store.hostTokens.length

    const requests = [
      { method: 'PUT', path: `/v1/users/${dev.userId}/roles` },
      { method: 'PUT', path: `/v1/projects/${PROJECT_ID}/policy` },
      { method: 'PUT', path: '/v1/policies/download' },
      { method: 'POST', path: '/v1/projects' },
      { method: 'POST', path: '/v1/hosts/tokens' },
      { method: 'POST', path: `/v1/users/${dev.userId}/sessions/revoke` }
    ]
    for (const request of requests) {
      const result = await declaredOversizedRequest(
        base,
        request.path,
        DECLARED_HUGE_BODY,
        authorization,
        request.method
      )
      assert.equal(result.status, 403, `${request.method} ${request.path}`)
      assert.equal(errorCode(JSON.parse(result.body) as Json), 'PERMISSION_DENIED')
      assert.equal(result.connection, 'close', `${request.path} must not drain the declared body`)
      assert.ok(result.elapsedMs < 1000, `${request.path} refused in ${result.elapsedMs}ms`)
    }

    const events = await deniedAuditEvents(base, admin.token, 'zhangsan')
    assertFixedDeniedEvent(oneDeniedEvent(events, 'role_update', 'user'), {
      eventType: 'role_update',
      targetType: 'user',
      targetId: dev.userId
    })
    assertFixedDeniedEvent(oneDeniedEvent(events, 'policy_update', 'project'), {
      eventType: 'policy_update',
      targetType: 'project',
      targetId: PROJECT_ID
    })
    assertFixedDeniedEvent(oneDeniedEvent(events, 'policy_update', 'policy'), {
      eventType: 'policy_update',
      targetType: 'policy',
      targetId: 'download'
    })
    assertFixedDeniedEvent(oneDeniedEvent(events, 'project_create', 'project'), {
      eventType: 'project_create',
      targetType: 'project',
      targetId: null
    })
    assertFixedDeniedEvent(oneDeniedEvent(events, 'host_token_create', 'host'), {
      eventType: 'host_token_create',
      targetType: 'host',
      targetId: null
    })
    assertFixedDeniedEvent(oneDeniedEvent(events, 'session_revoke', 'user'), {
      eventType: 'session_revoke',
      targetType: 'user',
      targetId: dev.userId
    })

    assert.equal(devSession.revokedAt, null)
    assert.equal(app.store.projectsByKey.has('u259-denied'), false)
    assert.equal(app.store.hostTokens.length, hostTokenCount, 'the refused mint wrote no token')
    assert.equal(app.store.policies.version, 1)
  })
})

/**
 * U259 §6/§7/P3: observe an early verdict without pumping 16 MiB. Declares a
 * body, writes only a prefix, and reports when the refusal and the close land.
 */
function stalledDeclaredRequest(
  base: string,
  path: string,
  declared: number,
  prefixBytes: number
): Promise<{
  status: number
  connection: string | undefined
  responseMs: number
  closeMs: number
  closed: boolean
  sentBytes: number
}> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const url = new URL(base)
    const socket = connect(Number(url.port), url.hostname)
    const prefix = Buffer.alloc(prefixBytes, 'x')
    const head = [
      `POST ${path} HTTP/1.1`,
      `Host: ${url.host}`,
      'Content-Type: application/json',
      `Content-Length: ${declared}`,
      'Connection: keep-alive',
      '',
      ''
    ].join('\r\n')
    let buffer = Buffer.alloc(0)
    let status = 0
    let connection: string | undefined
    let responseMs = 0
    let closeMs = 0
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      const index = buffer.indexOf('\r\n\r\n')
      if (index !== -1) {
        const lines = buffer.subarray(0, index).toString('latin1').split('\r\n')
        status = Number(lines[0]?.split(' ')[1] ?? 0)
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':')
          if (colon === -1) continue
          if (line.slice(0, colon).trim().toLowerCase() === 'connection') {
            connection = line.slice(colon + 1).trim()
          }
        }
      }
      socket.destroy()
      resolve({
        status,
        connection,
        responseMs,
        closeMs,
        closed: true,
        sentBytes: Buffer.byteLength(head) + prefix.length
      })
    }
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(
        new Error(
          `POST ${path}: no refusal/close within 3000ms ` +
            `(sent=${Buffer.byteLength(head) + prefix.length} B of ${declared} B)`
        )
      )
    }, 3000)
    socket.once('connect', () => {
      socket.write(head)
      socket.write(prefix)
    })
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data])
      if (responseMs === 0 && buffer.includes('\r\n\r\n')) {
        responseMs = Date.now() - started
      }
    })
    socket.on('close', () => {
      closeMs = Date.now() - started
      finish()
    })
    socket.on('error', () => {
      // The refusal and the close carry the verdict.
    })
  })
}

/** Sends a raw request and returns whatever Node's parser replies before closing. */
function rawExchange(
  base: string,
  request: string
): Promise<{
  status: number
  connection: string | undefined
  body: string
  closed: boolean
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(base)
    const socket = connect(Number(url.port), url.hostname)
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      const index = buffer.indexOf('\r\n\r\n')
      socket.destroy()
      if (index === -1) {
        reject(new Error('the parser did not answer before the socket closed'))
        return
      }
      const lines = buffer.subarray(0, index).toString('latin1').split('\r\n')
      const status = Number(lines[0]?.split(' ')[1] ?? 0)
      let connection: string | undefined
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon === -1) continue
        if (line.slice(0, colon).trim().toLowerCase() === 'connection') {
          connection = line.slice(colon + 1).trim()
        }
      }
      resolve({
        status,
        connection,
        body: buffer.subarray(index + 4).toString('utf8'),
        closed: true
      })
    }
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('the parser neither answered nor closed within 1500ms'))
    }, 1500)
    socket.once('connect', () => socket.write(request))
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data])
    })
    socket.on('close', finish)
    socket.on('error', () => {
      // A reset after the parser's 400 is part of the observed close.
    })
  })
}

describe('U259 §6 并发组合', () => {
  test('P1 两个并发超限 login：均 413、无会话、失败计数不变', async () => {
    const { app, base } = await startApp()
    const results = await Promise.all([
      login(base, oversized({ username: 'admin', password: 'Adm1n!', deviceName: 'u259-p1-a' })),
      login(base, oversized({ username: 'admin', password: 'Adm1n!', deviceName: 'u259-p1-b' }))
    ])
    assert.deepEqual(
      results.map((res) => res.status),
      [413, 413],
      'both concurrent overages are refused'
    )
    for (const res of results) {
      const payload = (await res.json()) as Json
      assert.equal(errorCode(payload), 'PAYLOAD_TOO_LARGE')
      assert.equal(res.headers.get('connection'), 'close', 'each refusal closes its connection')
    }
    assert.equal(app.store.sessions.size, 0, 'neither request creates a session')
    assert.equal(app.store.loginAttempts.size, 0, 'the shared failure counter is untouched')
    assert.equal(
      app.store.audit.filter((event) => event.eventType === 'login').length,
      0,
      'no login event is written'
    )
  })

  test('P2 同注册令牌并发：超限 + 正常 → [201,413]，令牌只兑现一次', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-p2-admin')
    const token = await mintHostToken(base, admin.token)
    const entry = app.store.hostTokens.at(-1)
    assert.ok(entry)
    let usedAtReads = 0
    let usedAtWrites = 0
    let usedAtValue: number | null = null
    Object.defineProperty(entry, 'usedAt', {
      configurable: true,
      enumerable: true,
      get: () => {
        usedAtReads += 1
        return usedAtValue
      },
      set: (value: number | null) => {
        usedAtWrites += 1
        usedAtValue = value
      }
    })

    const normalBody = JSON.stringify({ name: 'u259-p2-race-host', protocolVersion: 3 })
    const oversizedBody = oversizedRegisterBody({ name: 'u259-p2-race-over' })
    type Parked = {
      req: ReturnType<typeof httpRequest>
      response: Promise<{ status: number; payload: Json }>
      body: string
      prefixLength: number
    }
    const park = (body: string): Parked => {
      const bodyLength = Buffer.byteLength(body)
      const prefixLength = Math.floor(body.length / 2)
      let resolveResponse!: (value: { status: number; payload: Json }) => void
      let rejectResponse!: (error: Error) => void
      const response = new Promise<{ status: number; payload: Json }>((resolve, reject) => {
        resolveResponse = resolve
        rejectResponse = reject
      })
      const req = httpRequest(
        `${base}/v1/hosts/register`,
        {
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'content-length': String(bodyLength)
          }
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            text += chunk
          })
          res.on('end', () => {
            resolveResponse({ status: res.statusCode ?? 0, payload: JSON.parse(text) as Json })
          })
        }
      )
      req.on('error', rejectResponse)
      void response.catch(() => undefined)
      req.flushHeaders()
      req.write(body.slice(0, prefixLength))
      return { req, response, body, prefixLength }
    }
    const parked = [park(oversizedBody), park(normalBody)]
    const hostsBefore = new Set(app.store.hosts.keys())
    try {
      const deadline = Date.now() + 2000
      while (usedAtReads < 2) {
        if (Date.now() > deadline) {
          throw new Error(`only ${usedAtReads}/2 registrations reached the token check`)
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
      }
      // Both handlers are past the token check and parked in the body read.
      for (const item of parked) {
        item.req.end(item.body.slice(item.prefixLength))
      }
      const results = await Promise.all(parked.map((item) => item.response))
      assert.deepEqual(
        results.map((result) => result.status).sort(),
        [201, 413],
        'the oversized read is refused without spending the token the normal request needs'
      )
      const created = results.find((result) => result.status === 201)
      const refused = results.find((result) => result.status === 413)
      assert.ok(created)
      assert.ok(refused)
      assert.equal(errorCode(refused.payload), 'PAYLOAD_TOO_LARGE')

      const hostId = String(created.payload.hostId)
      const addedHosts = [...app.store.hosts.keys()].filter((id) => !hostsBefore.has(id))
      assert.deepEqual(addedHosts, [hostId], 'exactly one host is stored')
      assert.equal(app.store.hosts.size, hostsBefore.size + 1)
      assert.equal(app.store.hosts.get(hostId)?.name, 'u259-p2-race-host')
      assert.equal(usedAtWrites, 1, 'the single-use token is reserved exactly once')
      assert.equal(typeof entry.usedAt, 'number')

      const replay = await registerHost(
        base,
        token,
        JSON.stringify({ name: 'u259-p2-replay', protocolVersion: 3 })
      )
      assert.equal(replay.status, 401, 'the spent token cannot register again')
    } finally {
      for (const item of parked) item.req.destroy()
    }
  })

  test('P3 同注册令牌并发：超限 + 超限 → [413,413]，令牌未消耗', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-p3-admin')
    const token = await mintHostToken(base, admin.token)
    const entry = app.store.hostTokens.at(-1)
    assert.ok(entry)
    let usedAtReads = 0
    let usedAtWrites = 0
    let usedAtValue: number | null = null
    Object.defineProperty(entry, 'usedAt', {
      configurable: true,
      enumerable: true,
      get: () => {
        usedAtReads += 1
        return usedAtValue
      },
      set: (value: number | null) => {
        usedAtWrites += 1
        usedAtValue = value
      }
    })

    const bodies = [
      oversizedRegisterBody({ name: 'u259-p3-race-a' }),
      oversizedRegisterBody({ name: 'u259-p3-race-b' })
    ]
    type Parked = {
      req: ReturnType<typeof httpRequest>
      response: Promise<{ status: number; payload: Json }>
      body: string
      prefixLength: number
    }
    const park = (body: string): Parked => {
      const bodyLength = Buffer.byteLength(body)
      const prefixLength = Math.floor(body.length / 2)
      let resolveResponse!: (value: { status: number; payload: Json }) => void
      let rejectResponse!: (error: Error) => void
      const response = new Promise<{ status: number; payload: Json }>((resolve, reject) => {
        resolveResponse = resolve
        rejectResponse = reject
      })
      const req = httpRequest(
        `${base}/v1/hosts/register`,
        {
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'content-length': String(bodyLength)
          }
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            text += chunk
          })
          res.on('end', () => {
            resolveResponse({ status: res.statusCode ?? 0, payload: JSON.parse(text) as Json })
          })
        }
      )
      req.on('error', rejectResponse)
      void response.catch(() => undefined)
      req.flushHeaders()
      req.write(body.slice(0, prefixLength))
      return { req, response, body, prefixLength }
    }
    const parked = bodies.map(park)
    const hostsBefore = new Set(app.store.hosts.keys())
    try {
      const deadline = Date.now() + 2000
      while (usedAtReads < 2) {
        if (Date.now() > deadline) {
          throw new Error(`only ${usedAtReads}/2 registrations reached the token check`)
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
      }
      for (const item of parked) {
        item.req.end(item.body.slice(item.prefixLength))
      }
      const results = await Promise.all(parked.map((item) => item.response))
      assert.deepEqual(
        results.map((result) => result.status),
        [413, 413],
        'both oversized reads are refused'
      )
      for (const result of results) {
        assert.equal(errorCode(result.payload), 'PAYLOAD_TOO_LARGE')
      }
      assert.equal(app.store.hosts.size, hostsBefore.size, 'no host is stored')
      assert.equal(usedAtWrites, 0, 'a refused oversized read never reserves the token')
      assert.equal(entry.usedAt, null, 'the token is still unused')

      const retry = await registerHost(
        base,
        token,
        JSON.stringify({ name: 'u259-p3-retry', protocolVersion: 3 })
      )
      assert.equal(retry.status, 201, await retry.text())
      assert.ok(app.store.hostsByName.has('u259-p3-retry'), 'the same token registers afterwards')
    } finally {
      for (const item of parked) item.req.destroy()
    }
  })

  test('P4 两个并发 chunked 超限 login：均 413、连接关闭、新连接仍可登录', async () => {
    const { app, base } = await startApp()
    const results = await Promise.all([
      streamingOversizedRequest(base, '/v1/auth/login'),
      streamingOversizedRequest(base, '/v1/auth/login')
    ])
    for (const result of results) {
      assert.equal(result.status, 413, 'each chunked overage is refused')
      assert.equal(result.connection, 'close', 'an unread chunked stream closes')
      assert.ok(result.responseMs < 1000, `the refusal took ${result.responseMs}ms`)
      assert.ok(
        result.closeMs >= result.responseMs,
        `the close (${result.closeMs}ms) must not precede the response (${result.responseMs}ms)`
      )
      assert.ok(
        result.sentBytes > AUTH_BODY_MAX_BYTES,
        `the stream passed the cap before the refusal (${result.sentBytes} B)`
      )
    }
    const accepted = await login(
      base,
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u259-p4-after' })
    )
    assert.equal(accepted.status, 200, 'two wedged streams do not block a new connection')
    assert.equal(app.store.sessions.size, 1)
  })

  test('P5 超限 + 正常并发同一写端点：恰好一个项目与一条成功审计', async () => {
    const { app, base } = await startApp()
    const admin = await loginAs(base, 'admin', 'Adm1n!', 'u259-p5-admin')
    const acceptedKey = 'u259-p5-ok'
    const refusedKey = 'u259-p5-no'
    const acceptedFields = {
      hostId: HOST_ID,
      key: acceptedKey,
      name: acceptedKey,
      path: '/srv/u259-p5-ok',
      defaultBranch: 'main'
    }
    const refusedFields = {
      hostId: HOST_ID,
      key: refusedKey,
      name: refusedKey,
      path: '/srv/u259-p5-no',
      defaultBranch: 'main'
    }
    const results = await Promise.all([
      authedJson(base, admin.token, 'POST', '/v1/projects', oversizedBody(refusedFields)),
      authedJson(base, admin.token, 'POST', '/v1/projects', JSON.stringify(acceptedFields))
    ])
    assert.deepEqual(
      results.map((res) => res.status).sort(),
      [201, 413],
      'the concurrent write does not turn the overage into a second create'
    )
    const refused = results.find((res) => res.status === 413)
    assert.ok(refused)
    assert.equal(errorCode((await refused.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(refused.headers.get('connection'), 'close')
    assert.ok(app.store.projectsByKey.has(acceptedKey), 'the normal write persists')
    assert.equal(app.store.projectsByKey.has(refusedKey), false, 'the overage persists nothing')

    const events = app.store.audit.filter(
      (event) => event.eventType === 'project_create' && event.result === 'success'
    )
    assert.equal(
      events.filter((event) => (event.metadata as Json | undefined)?.key === acceptedKey).length,
      1,
      'the accepted create is audited exactly once'
    )
    assert.equal(
      events.filter((event) => (event.metadata as Json | undefined)?.key === refusedKey).length,
      0,
      'the refused create writes no success event'
    )
  })
})

describe('U259 §7 早退 close 顺序（U264 后）', () => {
  test('E1 未认证 401：声明 16 MiB 的完整 JSON 响应先于关闭', async () => {
    const base = await start()
    const result = await pacedDeclaredBodyRequest(base, '/v1/projects', DECLARED_HUGE_BODY)
    assert.equal(result.receivedResponse, true, 'the refusal must be readable')
    assert.equal(result.status, 401)
    assert.equal(errorCode(JSON.parse(result.body) as Json), 'SESSION_EXPIRED')
    assert.equal(result.connection, 'close', 'the unread 16 MiB body must not keep keep-alive')
    assert.equal(result.closed, true, 'the server closes the connection')
    assert.ok(
      result.closeMs >= result.responseMs,
      `the response (${result.responseMs}ms) must precede the close (${result.closeMs}ms)`
    )
    assert.ok(result.responseMs < 1000, `the refusal took ${result.responseMs}ms`)
    assert.ok(
      result.acceptedBytes < 2 * 1024 * 1024,
      `the server accepted ${result.acceptedBytes} B of 16 MiB`
    )
  })

  test('E2 无权限 403（项目策略）：声明 16 MiB 先响应后关闭，策略不变', async () => {
    const { app, base } = await startApp()
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u259-e2-dev')
    const project = app.store.projects.get(PROJECT_ID)
    assert.ok(project)
    const downloadPolicy = project.downloadPolicy
    const explicit = project.downloadPolicyExplicit
    const version = app.store.policies.version

    const result = await pacedDeclaredBodyRequest(
      base,
      `/v1/projects/${PROJECT_ID}/policy`,
      DECLARED_HUGE_BODY,
      { authorization: `Bearer ${dev.token}` },
      'PUT'
    )
    assert.equal(result.receivedResponse, true)
    assert.equal(result.status, 403, 'the role verdict wins over the body cap')
    assert.equal(errorCode(JSON.parse(result.body) as Json), 'PERMISSION_DENIED')
    assert.equal(result.connection, 'close', 'the 403 must not consume the declared body')
    assert.equal(result.closed, true)
    assert.ok(
      result.closeMs >= result.responseMs,
      `the response (${result.responseMs}ms) must precede the close (${result.closeMs}ms)`
    )
    assert.ok(result.responseMs < 1000, `the refusal took ${result.responseMs}ms`)
    assert.ok(
      result.acceptedBytes < 2 * 1024 * 1024,
      `the server accepted ${result.acceptedBytes} B of 16 MiB`
    )

    const after = app.store.projects.get(PROJECT_ID)
    assert.ok(after)
    assert.equal(after.downloadPolicy, downloadPolicy, 'the denied write changes no policy')
    assert.equal(after.downloadPolicyExplicit, explicit)
    assert.equal(app.store.policies.version, version)
  })

  test('E3 无权限 403（审计导出）：声明 16 MiB 不创建导出任务', async () => {
    const { app, base } = await startApp()
    const dev = await loginAs(base, 'zhangsan', 'Passw0rd!', 'u259-e3-dev')
    const result = await declaredOversizedRequest(
      base,
      '/v1/audit/export',
      DECLARED_HUGE_BODY,
      { authorization: `Bearer ${dev.token}` },
      'POST'
    )
    assert.equal(result.status, 403)
    assert.equal(errorCode(JSON.parse(result.body) as Json), 'PERMISSION_DENIED')
    assert.equal(result.connection, 'close', 'the high-risk export exit never reads the body')
    assert.equal(result.cacheControl, 'no-store')
    assert.ok(result.elapsedMs < 1000, `the refusal took ${result.elapsedMs}ms`)
    assert.equal(app.auditExportStore.countActive(), 0, 'no export job is queued')
  })

  test('E4 close 阈值：16,384 B 保持 keep-alive；16,385 B 关闭', async () => {
    const base = await start()
    const url = new URL(base)
    const atLimit = 'x'.repeat(AUTH_BODY_MAX_BYTES)
    const overLimit = 'x'.repeat(AUTH_BODY_MAX_BYTES + 1)

    const kept = await connectRaw(base)
    try {
      kept.write(
        [
          'POST /v1/projects HTTP/1.1',
          `Host: ${url.host}`,
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(atLimit)}`,
          'Connection: keep-alive',
          '',
          atLimit
        ].join('\r\n')
      )
      const first = await readRawResponse(kept, 2000, '16,384 B unauthenticated 401')
      assert.equal(first.status, 401)
      assert.notEqual(
        first.headers.connection,
        'close',
        'a body at the close threshold keeps keep-alive'
      )
      kept.write(
        ['GET /health HTTP/1.1', `Host: ${url.host}`, 'Connection: keep-alive', '', ''].join('\r\n')
      )
      const second = await readRawResponse(kept, 2000, 'health after the threshold body')
      assert.equal(second.status, 200, 'the same connection serves the next request')
    } finally {
      kept.destroy()
    }

    const closedSocket = await connectRaw(base)
    try {
      closedSocket.write(
        [
          'POST /v1/projects HTTP/1.1',
          `Host: ${url.host}`,
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(overLimit)}`,
          'Connection: keep-alive',
          '',
          overLimit
        ].join('\r\n')
      )
      const over = await readRawResponse(closedSocket, 2000, '16,385 B unauthenticated 401')
      assert.equal(over.status, 401)
      assert.equal(over.headers.connection, 'close', 'one byte past the threshold closes')
      await waitForClose(closedSocket, 2000)
    } finally {
      closedSocket.destroy()
    }
  })
})

describe('U259 P3 排空与传输边界', () => {
  test('X1 声明 1 MiB（≤2 MiB 排空预算）完整发送：413 可读；小 body 仍 200', async () => {
    const { app, base } = await startApp()
    const declaredBody = JSON.stringify({
      username: 'admin',
      password: 'Adm1n!',
      deviceName: 'u259-x1-over',
      pad: 'x'.repeat(1024 * 1024)
    })
    assert.ok(Buffer.byteLength(declaredBody) > AUTH_BODY_MAX_BYTES)
    assert.ok(Buffer.byteLength(declaredBody) <= 2 * 1024 * 1024, 'the drain budget must cover it')

    const refused = await login(base, declaredBody)
    assert.equal(refused.status, 413, 'the fully sent overage is still refused')
    assert.equal(errorCode((await refused.json()) as Json), 'PAYLOAD_TOO_LARGE')
    assert.equal(refused.headers.get('connection'), 'close')

    const accepted = await login(
      base,
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u259-x1-small' })
    )
    assert.equal(accepted.status, 200, 'a small legal body on the same endpoint still works')
    assert.equal(app.store.sessions.size, 1)
  })

  test('X2 声明 2 MiB 只发 4 KiB：250 ms 定时器到点后拒绝并关闭', async () => {
    const base = await start()
    const declared = 2 * 1024 * 1024
    const prefixBytes = 4 * 1024
    const result = await stalledDeclaredRequest(
      base,
      '/v1/auth/login',
      declared,
      prefixBytes
    )
    assert.equal(result.status, 413, 'the refusal does not wait for the remaining body')
    assert.equal(result.connection, 'close')
    assert.equal(result.closed, true, 'the stalled stream is destroyed')
    assert.ok(result.sentBytes < declared, 'most of the declared body was never sent')
    assert.ok(
      result.responseMs >= 200,
      `the 250 ms drain timer must govern the verdict, got ${result.responseMs}ms`
    )
    assert.ok(
      result.closeMs >= result.responseMs,
      `the close (${result.closeMs}ms) must not precede the response (${result.responseMs}ms)`
    )
  })

  test('X6 malformed / 负数 / 重复 Content-Length：Node 解析器 400 + close', async () => {
    const { app, base } = await startApp()
    const url = new URL(base)
    const auditBefore = app.store.audit.length
    const head = ['POST /v1/auth/login HTTP/1.1', `Host: ${url.host}`]
    const cases: { label: string; request: string }[] = [
      {
        label: 'non-numeric',
        request: [...head, 'Content-Type: application/json', 'Content-Length: abc', '', ''].join(
          '\r\n'
        )
      },
      {
        label: 'negative',
        request: [...head, 'Content-Type: application/json', 'Content-Length: -1', '', ''].join(
          '\r\n'
        )
      },
      {
        label: 'conflicting duplicates',
        request: [
          ...head,
          'Content-Type: application/json',
          'Content-Length: 5',
          'Content-Length: 6',
          '',
          'hello'
        ].join('\r\n')
      },
      {
        label: 'content-length + chunked',
        request: [
          ...head,
          'Content-Type: application/json',
          'Content-Length: 5',
          'Transfer-Encoding: chunked',
          '',
          'hello'
        ].join('\r\n')
      }
    ]
    for (const item of cases) {
      const result = await rawExchange(base, item.request)
      assert.equal(result.status, 400, `${item.label}: Node answers 400`)
      assert.equal(result.connection, 'close', `${item.label}: the parser closes the connection`)
      assert.equal(result.body, '', `${item.label}: no handler body is produced`)
      assert.equal(result.closed, true)
    }
    assert.equal(app.store.sessions.size, 0, 'the handler never ran')
    assert.equal(app.store.audit.length, auditBefore, 'no audit event is written')
  })
})
