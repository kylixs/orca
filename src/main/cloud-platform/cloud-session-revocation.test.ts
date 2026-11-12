import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseJsonText, readArray, readField, readString } from '../../shared/json-fields'
import { readTicketClaims } from './cloud-connect-response'
import { parsePairingCode } from '../../shared/pairing'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from '../runtime/rpc/e2ee-crypto'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'

/**
 * The full cloud path on the real runtime: the platform issues the ticket, the host
 * adopts the device from it, the E2EE handshake completes with the platform's
 * device token, and a platform-side revocation closes the live socket with 4403.
 */

const REPO_ROOT = new URL('../../..', import.meta.url).pathname

type Platform = { url: string; stop: () => Promise<void> }
let platform: Platform

async function startPlatform(): Promise<Platform> {
  const proc: ChildProcess = spawn(process.execPath, ['cloud-platform/apps/api/src/server.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: '0', INTERNAL_TOKEN: 'session-revoke-token' },
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

type Session = {
  accessToken: string
  deviceId: string
  devicePubKey: string
  /** The device key the host demands proof of at handshake. */
  deviceKeys: { publicKey: Uint8Array; secretKey: Uint8Array }
  deviceToken: string
  credential: string
}

async function openPlatformSession(): Promise<Session> {
  // Why a NaCl key: the handshake must use this key, so it has to be the same
  // 32-byte Curve25519 key the ticket binds.
  const deviceKeys = generateKeyPair()
  const devicePubKey = Buffer.from(deviceKeys.publicKey).toString('base64')
  const loginRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey,
      deviceName: 'revoke-e2e'
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
  const projectId = readString(readArray(await projectsRes.json(), 'projects')?.[0], 'id')
  if (projectId === null) {
    throw new Error('project list malformed')
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
  return { accessToken, deviceId, devicePubKey, deviceKeys, deviceToken, credential }
}

/**
 * Completes the real E2EE handshake (hello → ready → encrypted auth). The server
 * public key comes from this runtime's own pairing code; in production the client
 * receives the same key from POST /v1/projects/{id}/connect.
 */
function completeHandshake(
  url: string,
  serverPublicKeyB64: string,
  session: Session
): Promise<{ ws: WebSocket; close: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['orca-runtime', `orca-cred.${session.credential}`], {
      headers: { 'x-orca-device-pubkey': session.devicePubKey },
      handshakeTimeout: 5000
    })
    const close = new Promise<{ code: number; reason: string }>((done) => {
      ws.once('close', (code, reason) => done({ code, reason: reason.toString() }))
    })
    const sharedKey = deriveSharedKey(
      session.deviceKeys.secretKey,
      Uint8Array.from(Buffer.from(serverPublicKeyB64, 'base64'))
    )
    ws.once('message', (readyRaw) => {
      const readyType = readString(parseJsonText(readyRaw.toString()), 'type')
      if (readyType !== 'e2ee_ready') {
        reject(new Error(`expected e2ee_ready, got ${readyType}`))
        return
      }
      // encrypt() returns base64 text; the server accepts it as a text frame.
      ws.send(
        encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: session.deviceToken }), sharedKey)
      )
      ws.once('message', (authRaw) => {
        const auth = parseJsonText(decrypt(authRaw.toString(), sharedKey) ?? '{}')
        if (readString(auth, 'type') !== 'e2ee_authenticated') {
          reject(new Error(`expected e2ee_authenticated, got ${JSON.stringify(auth)}`))
          return
        }
        resolve({ ws, close })
      })
    })
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

let admission: CloudRuntimeAdmission | null = null
let runtime: OrcaRuntimeRpcServer | null = null
let endpoint = ''
let serverPublicKeyB64 = ''

beforeAll(async () => {
  platform = await startPlatform()
  admission = startCloudRuntimeAdmission({
    ORCA_CLOUD_API_URL: platform.url,
    ORCA_CLOUD_INTERNAL_TOKEN: 'session-revoke-token',
    ORCA_CLOUD_HOST_ID: 'host_dev001',
    ORCA_CLOUD_HOST_NAME: 'dev-001'
  })
  if (!admission) {
    throw new Error('cloud admission not enabled')
  }
  await admission.client!.refresh()
  runtime = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-revoke-')),
    enableWebSocket: true,
    wsPort: 0,
    upgradeAdmission: admission.admission
  })
  await runtime.start()
  admission.bindRuntime(runtime)
  const offer = runtime.createPairingOffer({
    address: '127.0.0.1',
    name: 'cloud-revoke',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const parsed = parsePairingCode(offer.pairingUrl)!
  endpoint = parsed.endpoint
  serverPublicKeyB64 = parsed.publicKeyB64
})

afterAll(async () => {
  admission?.client?.stop()
  await runtime?.stop()
  await platform?.stop()
})

describe('云端会话：设备登记与撤销关闭（真实平台 + 真实 Runtime）', () => {
  it('准入时用凭证里的设备身份登记到 DeviceRegistry，E2EE 握手成功', async () => {
    const session = await openPlatformSession()
    const { ws } = await completeHandshake(endpoint, serverPublicKeyB64, session)
    const adopted = runtime!.getDeviceRegistry()?.getDevice(session.deviceId)
    expect(adopted?.token).toBe(session.deviceToken)
    ws.close()
  }, 20000)

  it('平台吊销设备后，已建立的连接在下一轮轮询内被 4403 关闭', async () => {
    const session = await openPlatformSession()
    const { ws, close } = await completeHandshake(endpoint, serverPublicKeyB64, session)
    expect(ws.readyState).toBe(WebSocket.OPEN)

    const revoke = await fetch(`${platform.url}/v1/me/devices/${session.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session.accessToken}` }
    })
    expect(revoke.ok).toBe(true)

    await admission!.client!.refresh()
    const closed = await Promise.race([
      close,
      new Promise<{ code: number; reason: string }>((resolve) =>
        setTimeout(() => resolve({ code: -1, reason: 'timeout' }), 5000)
      )
    ])
    expect(closed.code).toBe(4403)
  }, 25000)

  it('未被吊销的会话不因他人吊销而被关闭', async () => {
    const keep = await openPlatformSession()
    const victim = await openPlatformSession()
    const { ws: keepWs } = await completeHandshake(endpoint, serverPublicKeyB64, keep)
    const { ws: victimWs } = await completeHandshake(endpoint, serverPublicKeyB64, victim)

    await fetch(`${platform.url}/v1/me/devices/${victim.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${victim.accessToken}` }
    })
    await admission!.client!.refresh()
    await new Promise((r) => setTimeout(r, 800))

    expect(keepWs.readyState).toBe(WebSocket.OPEN)
    expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(victimWs.readyState)
    keepWs.close()
    victimWs.close()
  }, 25000)
})
