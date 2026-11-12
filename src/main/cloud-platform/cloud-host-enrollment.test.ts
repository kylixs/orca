import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parsePairingCode } from '../../shared/pairing'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from '../runtime/rpc/e2ee-crypto'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { readStoredHostCredential } from './cloud-host-enrollment'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'

/**
 * A dev machine that registers itself. Nothing here supplies the host id: the
 * platform assigns it at enrolment, and the session has to be admitted by the
 * host that enrolled — not by an env-provided identity.
 */

const REPO_ROOT = new URL('../../..', import.meta.url).pathname

type Platform = { url: string; stop: () => Promise<void> }
let platform: Platform
let adminToken = ''

async function startPlatform(): Promise<Platform> {
  const proc: ChildProcess = spawn(process.execPath, ['cloud-platform/apps/api/src/server.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: '0', INTERNAL_TOKEN: 'enrol-token' },
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

async function mintHostToken(): Promise<string> {
  const res = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const { token } = (await res.json()) as { token: string }
  return token
}

async function platformHosts(): Promise<
  { id: string; name: string; status: string; directAddrs: string[] }[]
> {
  const res = await fetch(`${platform.url}/v1/hosts`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const body = (await res.json()) as {
    hosts: { id: string; name: string; status: string; directAddrs: string[] }[]
  }
  return body.hosts
}

type RuntimeFixture = {
  admission: CloudRuntimeAdmission
  runtime: OrcaRuntimeRpcServer
  endpoint: string
  serverPublicKeyB64: string
}

async function startHost(input: {
  hostName: string
  hostToken: string
  userDataPath: string
  directAddrs: string[]
}): Promise<RuntimeFixture> {
  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: input.hostToken,
      ORCA_CLOUD_HOST_NAME: input.hostName
    },
    { userDataPath: input.userDataPath, directAddrs: input.directAddrs }
  )
  if (!admission) {
    throw new Error('cloud admission not enabled')
  }
  await admission.ready
  const runtime = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: input.userDataPath,
    enableWebSocket: true,
    wsPort: 0,
    upgradeAdmission: admission.admission
  })
  await runtime.start()
  admission.bindRuntime(runtime)
  const offer = runtime.createPairingOffer({
    address: '127.0.0.1',
    name: input.hostName,
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const parsed = parsePairingCode(offer.pairingUrl)!
  return { admission, runtime, endpoint: parsed.endpoint, serverPublicKeyB64: parsed.publicKeyB64 }
}

type Session = {
  accessToken: string
  deviceId: string
  devicePubKey: string
  deviceToken: string
  credential: string
  hostId: string
}

async function openSession(projectId: string): Promise<Session> {
  const { publicKey } = generateKeyPair()
  const devicePubKey = Buffer.from(publicKey).toString('base64')
  const loginRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey,
      deviceName: 'enrol-e2e'
    })
  })
  const login = (await loginRes.json()) as { accessToken: string; device: { id: string } }
  const auth = { authorization: `Bearer ${login.accessToken}` }
  const connectRes = await fetch(`${platform.url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: login.device.id, devicePubKey, clientVersion: '1.5.0' })
  })
  if (!connectRes.ok) {
    throw new Error(`connect failed: ${await connectRes.text()}`)
  }
  const { credential } = (await connectRes.json()) as { credential: string }
  const claims = JSON.parse(Buffer.from(credential.split('.')[1], 'base64url').toString()) as {
    deviceToken: string
    host: string
  }
  return {
    accessToken: login.accessToken,
    deviceId: login.device.id,
    devicePubKey,
    deviceToken: claims.deviceToken,
    credential,
    hostId: claims.host
  }
}

function completeHandshake(
  endpoint: string,
  serverPublicKeyB64: string,
  session: Session
): Promise<{ ws: WebSocket; close: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, ['orca-runtime', `orca-cred.${session.credential}`], {
      headers: { 'x-orca-device-pubkey': session.devicePubKey },
      handshakeTimeout: 5000
    })
    const close = new Promise<{ code: number; reason: string }>((done) => {
      ws.once('close', (code, reason) => done({ code, reason: reason.toString() }))
    })
    const mobileKeys = generateKeyPair()
    const sharedKey = deriveSharedKey(
      mobileKeys.secretKey,
      Uint8Array.from(Buffer.from(serverPublicKeyB64, 'base64'))
    )
    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: Buffer.from(mobileKeys.publicKey).toString('base64')
        })
      )
    })
    ws.once('message', (readyRaw) => {
      const ready = JSON.parse(readyRaw.toString()) as { type: string }
      if (ready.type !== 'e2ee_ready') {
        reject(new Error(`expected e2ee_ready, got ${ready.type}`))
        return
      }
      ws.send(
        encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: session.deviceToken }), sharedKey)
      )
      ws.once('message', (authRaw) => {
        const auth = JSON.parse(decrypt(authRaw.toString(), sharedKey) ?? '{}') as { type: string }
        if (auth.type !== 'e2ee_authenticated') {
          reject(new Error(`expected e2ee_authenticated, got ${JSON.stringify(auth)}`))
          return
        }
        resolve({ ws, close })
      })
    })
    ws.once('error', reject)
  })
}

let host: RuntimeFixture
let userDataPath = ''
let projectId = ''

beforeAll(async () => {
  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'enrol-admin' })
  })
  adminToken = ((await adminRes.json()) as { accessToken: string }).accessToken

  userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-enrol-'))
  host = await startHost({
    hostName: 'dev-enrolled',
    hostToken: await mintHostToken(),
    userDataPath,
    directAddrs: [`127.0.0.1:${0}`]
  })

  // Bind a project to the host the platform assigned — the test never learns the
  // host id from env, only from the enrolment response.
  const hostId = host.admission.host()!.hostId
  const projectRes = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'enrolled-svc',
      name: 'enrolled-svc',
      hostId,
      path: '/srv/work/enrolled-svc'
    })
  })
  expect(projectRes.status).toBe(201)
  projectId = ((await projectRes.json()) as { id: string }).id

  const grant = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  expect(grant.ok).toBe(true)
})

afterAll(async () => {
  host?.admission.stop()
  await host?.runtime.stop()
  await platform?.stop()
})

describe('开发机自注册与心跳（真实平台 + 真实 Runtime）', () => {
  it('用一次性令牌注册，平台分配主机 ID 并标记在线', async () => {
    const enrolled = host.admission.host()
    expect(enrolled).not.toBeNull()
    const hosts = await platformHosts()
    const row = hosts.find((entry) => entry.id === enrolled!.hostId)
    expect(row?.name).toBe('dev-enrolled')
    expect(row?.status).toBe('online')
  })

  it('注册凭证持久化，重启复用而不是再消耗一个令牌', async () => {
    const stored = readStoredHostCredential(userDataPath)
    expect(stored?.hostId).toBe(host.admission.host()!.hostId)

    // A second process reuses the same userDataPath and presents a *different*,
    // already-spent token: only the persisted credential can make this work.
    const second = startCloudRuntimeAdmission(
      {
        ORCA_CLOUD_API_URL: platform.url,
        ORCA_CLOUD_HOST_TOKEN: 'spent-token-should-not-be-used',
        ORCA_CLOUD_HOST_NAME: 'dev-enrolled'
      },
      { userDataPath, directAddrs: ['127.0.0.1:6768'] }
    )
    await second!.ready
    expect(second!.host()?.hostId).toBe(stored!.hostId)
    second!.stop()
  })

  it('平台为该主机签发的凭证，在它自己的 Runtime 上完成 E2EE 握手', async () => {
    const session = await openSession(projectId)
    expect(session.hostId).toBe(host.admission.host()!.hostId)
    const { ws } = await completeHandshake(host.endpoint, host.serverPublicKeyB64, session)
    expect(host.runtime.getDeviceRegistry()?.getDevice(session.deviceId)?.token).toBe(
      session.deviceToken
    )
    ws.close()
  }, 20000)

  it('心跳携带撤销集合：吊销设备后已建会话被 4403 关闭', async () => {
    const session = await openSession(projectId)
    const { ws, close } = await completeHandshake(host.endpoint, host.serverPublicKeyB64, session)
    expect(ws.readyState).toBe(WebSocket.OPEN)

    const revoke = await fetch(`${platform.url}/v1/me/devices/${session.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session.accessToken}` }
    })
    expect(revoke.ok).toBe(true)

    await host.admission.client!.refresh()
    const closed = await Promise.race([
      close,
      new Promise<{ code: number; reason: string }>((resolve) =>
        setTimeout(() => resolve({ code: -1, reason: 'timeout' }), 5000)
      )
    ])
    expect(closed.code).toBe(4403)
    expect(host.admission.client!.snapshot().revocations.devices.map((d) => d.id)).toContain(
      session.deviceId
    )
  }, 25000)

  it('主机维护状态经心跳可见', async () => {
    const enabled = await fetch(
      `${platform.url}/v1/hosts/${host.admission.host()!.hostId}/maintenance`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ enabled: true, reason: '内核升级' })
      }
    )
    expect(enabled.ok).toBe(true)
    await host.admission.client!.refresh()
    expect(host.admission.client!.snapshot().maintenance?.reason).toBe('内核升级')

    await fetch(`${platform.url}/v1/hosts/${host.admission.host()!.hostId}/maintenance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ enabled: false })
    })
  })
})
