import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { parseJsonText, readArray, readField, readString } from '../../shared/json-fields'
import { parsePairingCode } from '../../shared/pairing'
import { readTicketClaims } from './cloud-connect-response'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from '../runtime/rpc/e2ee-crypto'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { OrcaRuntimeRpcServerOptions } from '../runtime/runtime-rpc/runtime-rpc-pairing-types'
import type { UpgradeAdmission, WebSocketConnectionGate } from '../runtime/rpc/ws-transport'

/**
 * Shared fixture for the cloud host tests that need the real stack: a real
 * platform process issuing signed tickets, a real runtime server behind TLS-less
 * WS, and the real E2EE handshake. Extracted so each test states only what it
 * asserts, and so the platform's signing path is exercised the same way in all.
 */

export const REPO_ROOT = new URL('../../..', import.meta.url).pathname
export const DEFAULT_INTERNAL_TOKEN = 'cloud-e2e-internal-token'

/** A throwaway certificate for a real wss:// runtime in tests, as the platform hands out `wss://`. */
export function makeSelfSignedTls(commonName = 'dev-cloud'): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cloud-tls-'))
  const key = join(dir, 'server.key')
  const cert = join(dir, 'server.crt')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    `/CN=${commonName}`,
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ])
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
}

export type Platform = { url: string; stop: () => Promise<void> }

export async function startPlatform(): Promise<Platform> {
  const proc: ChildProcess = spawn(process.execPath, ['cloud-platform/apps/api/src/server.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: '0', INTERNAL_TOKEN: DEFAULT_INTERNAL_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('platform did not start')), 15_000)
    let buffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = /\[api\] listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    proc.once('exit', (code) => reject(new Error(`platform exited ${code}`)))
  })
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve()
          return
        }
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
      })
  }
}

export type CloudSession = {
  accessToken: string
  deviceId: string
  devicePubKey: string
  /** The device key the host demands proof of at handshake. */
  deviceKeys: { publicKey: Uint8Array; secretKey: Uint8Array }
  deviceToken: string
  credential: string
  projectId: string
}

/** Logs in, registers this device, and asks the platform for a single-use ticket. */
export async function openPlatformSession(
  platform: Platform,
  options: {
    username?: string
    password?: string
    deviceName?: string
    /** Target project key; defaults to the first project the user can see. */
    projectKey?: string
  } = {}
): Promise<CloudSession> {
  // Why NaCl: the handshake must use the key the ticket binds, so it is the same
  // 32-byte Curve25519 key material, not a PEM.
  const deviceKeys = generateKeyPair()
  const devicePubKey = Buffer.from(deviceKeys.publicKey).toString('base64')
  const loginRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: options.username ?? 'zhangsan',
      password: options.password ?? 'Passw0rd!',
      devicePubKey,
      deviceName: options.deviceName ?? 'cloud-session-e2e'
    })
  })
  const login: unknown = await loginRes.json()
  const accessToken = readString(login, 'accessToken')
  const deviceId = readString(readField(login, 'device'), 'id')
  if (accessToken === null || deviceId === null) {
    throw new Error('login response malformed')
  }
  const auth = { authorization: `Bearer ${accessToken}` }
  const projectsRes = await fetch(`${platform.url}/v1/projects`, { headers: auth })
  const projects = readArray(await projectsRes.json(), 'projects') ?? []
  const chosen =
    options.projectKey === undefined
      ? projects[0]
      : projects.find((project) => readString(project, 'key') === options.projectKey)
  const projectId = readString(chosen, 'id')
  if (projectId === null) {
    throw new Error(`project ${options.projectKey ?? '(first)'} not visible to this user`)
  }
  const connectRes = await fetch(`${platform.url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, devicePubKey, clientVersion: '1.5.0' })
  })
  if (!connectRes.ok) {
    throw new Error(`connect failed: ${await connectRes.text()}`)
  }
  const credential = readString(await connectRes.json(), 'credential')
  const deviceToken = credential === null ? null : readTicketClaims(credential).deviceToken
  if (credential === null || deviceToken === null) {
    throw new Error('connect response malformed')
  }
  return { accessToken, deviceId, devicePubKey, deviceKeys, deviceToken, credential, projectId }
}

export type CloseInfo = { code: number; reason: string }

/** One RPC's reply, decrypted; `error.code` is what the host refused with. */
export type CloudRpcReply =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string }

export type CloudConnection =
  | {
      status: 'authenticated'
      ws: WebSocket
      close: Promise<CloseInfo>
      /** Sends an encrypted RPC over the admitted session and awaits its reply. */
      rpc: (method: string, params?: unknown) => Promise<CloudRpcReply>
    }
  | { status: 'refused'; close: CloseInfo }

export type CloudConnectTransport = {
  /**
   * How the device key reaches the host. A browser cannot set headers, so it
   * presents the key as an extra subprotocol token instead.
   */
  deviceKeyIn?: 'header' | 'subprotocol'
  /** The test runtime uses a throwaway certificate. */
  tlsRejectUnauthorized?: boolean
}

/** The `orca-device.<base64url>` token a header-less client offers. */
export function cloudDeviceProtocol(devicePubKeyB64: string): string {
  return `orca-device.${Buffer.from(devicePubKeyB64, 'base64').toString('base64url')}`
}

/**
 * Runs the real handshake. A host cap refuses the socket before `e2ee_ready`, so
 * refusal is a resolved outcome rather than a handshake error.
 */
export function connectCloudSession(
  url: string,
  serverPublicKeyB64: string,
  session: CloudSession,
  handshakeTimeoutMs = 5000,
  transport: CloudConnectTransport = {}
): Promise<CloudConnection> {
  const protocols = ['orca-runtime', `orca-cred.${session.credential}`]
  if (transport.deviceKeyIn === 'subprotocol') {
    protocols.push(cloudDeviceProtocol(session.devicePubKey))
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, {
      ...(transport.deviceKeyIn === 'subprotocol'
        ? {}
        : { headers: { 'x-orca-device-pubkey': session.devicePubKey } }),
      ...(transport.tlsRejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
      handshakeTimeout: handshakeTimeoutMs
    })
    let authenticated = false
    const close = new Promise<CloseInfo>((done) => {
      ws.once('close', (code, reason) => done({ code, reason: reason.toString() }))
    })
    void close.then((info) => {
      if (!authenticated) {
        resolve({ status: 'refused', close: info })
      }
    })
    const sharedKey = deriveSharedKey(
      session.deviceKeys.secretKey,
      Uint8Array.from(Buffer.from(serverPublicKeyB64, 'base64'))
    )
    // One persistent listener rather than nested `once` handlers: Bun's `ws`
    // shim can re-deliver the in-flight message to a listener added mid-dispatch,
    // and a nested handler would then read `e2ee_ready` where the reply belongs.
    let sentAuth = false
    const pending = new Map<string, (reply: CloudRpcReply) => void>()
    let nextId = 0
    ws.on('message', (raw) => {
      const text = raw.toString()
      const type = readString(parseJsonText(text), 'type')
      if (type === 'e2ee_ready') {
        if (!sentAuth) {
          sentAuth = true
          ws.send(
            encrypt(
              JSON.stringify({ type: 'e2ee_auth', deviceToken: session.deviceToken }),
              sharedKey
            )
          )
        }
        return
      }
      const decoded = parseJsonText(decrypt(text, sharedKey) ?? '{}')
      if (readString(decoded, 'type') !== null) {
        if (readString(decoded, 'type') !== 'e2ee_authenticated') {
          reject(new Error(`expected e2ee_authenticated, got ${JSON.stringify(decoded)}`))
          return
        }
        authenticated = true
        resolve({ status: 'authenticated', ws, close, rpc })
        return
      }
      const id = readString(decoded, 'id')
      const settle = id === null ? undefined : pending.get(id)
      if (id === null || !settle) {
        return
      }
      pending.delete(id)
      settle(
        decoded !== null && readField(decoded, 'ok') === true
          ? { ok: true, result: readField(decoded, 'result') }
          : {
              ok: false,
              code: readString(readField(decoded, 'error'), 'code') ?? 'unknown',
              message: readString(readField(decoded, 'error'), 'message') ?? ''
            }
      )
    })

    const rpc = (method: string, params?: unknown): Promise<CloudRpcReply> => {
      const id = `e2e-${nextId++}`
      return new Promise<CloudRpcReply>((settle) => {
        pending.set(id, settle)
        ws.send(encrypt(JSON.stringify({ id, method, params }), sharedKey))
      })
    }
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: Buffer.from(session.deviceKeys.publicKey).toString('base64')
        })
      )
    })
    ws.once('error', reject)
  })
}

export type CloudRuntime = {
  runtime: OrcaRuntimeRpcServer
  endpoint: string
  serverPublicKeyB64: string
}

export async function startCloudRuntime(options: {
  admission: UpgradeAdmission
  connectionGate?: WebSocketConnectionGate
  userDataPrefix?: string
  /** Pre-built service, for tests that need real repos or a real store. */
  service?: OrcaRuntimeService
  /** Extra RPC methods; cloud-only ones are not in the default table. */
  methods?: OrcaRuntimeRpcServerOptions['methods']
  /** Serve the runtime over TLS, which cloud clients expect (`wss://`). */
  tls?: { cert: string; key: string }
}): Promise<CloudRuntime> {
  const runtime = new OrcaRuntimeRpcServer({
    runtime: options.service ?? new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), options.userDataPrefix ?? 'orca-cloud-session-')),
    enableWebSocket: true,
    wsPort: 0,
    upgradeAdmission: options.admission,
    ...(options.connectionGate ? { connectionGate: options.connectionGate } : {}),
    ...(options.methods ? { methods: options.methods } : {}),
    ...(options.tls ? { webSocketTls: options.tls } : {})
  })
  await runtime.start()
  const offer = runtime.createPairingOffer({
    address: '127.0.0.1',
    name: 'cloud-session-e2e',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const parsed = parsePairingCode(offer.pairingUrl)
  if (!parsed) {
    throw new Error('pairing code unparsable')
  }
  return { runtime, endpoint: parsed.endpoint, serverPublicKeyB64: parsed.publicKeyB64 }
}
