import { spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { headerText } from '../../shared/http-header-text'
import { readArray, readField, readString } from '../../shared/json-fields'
import { parsePairingCode } from '../../shared/pairing'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { createCloudAgentClient } from './cloud-agent-client'

/**
 * End-to-end against the real platform process: the platform issues a real
 * Ed25519 ticket, the real Orca runtime admits it over a real WebSocket upgrade,
 * and a device revocation reaches the host through the control-plane poll.
 */

const REPO_ROOT = new URL('../../..', import.meta.url).pathname

type Platform = { url: string; stop: () => Promise<void> }

let platform: Platform

async function startPlatform(): Promise<Platform> {
  const proc: ChildProcess = spawn(process.execPath, ['cloud-platform/apps/api/src/server.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: '0', INTERNAL_TOKEN: 'agent-test-token' },
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
  credential: string
}

async function openPlatformSession(): Promise<Session> {
  const { publicKey } = generateKeyPairSync('x25519')
  const devicePubKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const loginRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey,
      deviceName: 'agent-e2e'
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
  if (credential === null) {
    throw new Error('connect response malformed')
  }
  return {
    accessToken,
    deviceId,
    devicePubKey,
    credential
  }
}

type Outcome = { status?: number; reject?: string; opened?: boolean; error?: string }

function attempt(url: string, credential: string, devicePubKey: string): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const ws = new WebSocket(url, ['orca-runtime', `orca-cred.${credential}`], {
      headers: { 'x-orca-device-pubkey': devicePubKey },
      handshakeTimeout: 5000
    })
    ws.once('unexpected-response', (_req, res) => {
      resolve({
        status: res.statusCode,
        reject: headerText(res.headers['x-orca-reject'])
      })
      ws.terminate()
    })
    ws.once('open', () => {
      resolve({ opened: true })
      ws.close()
    })
    ws.once('error', (error) => resolve({ error: error.message }))
  })
}

let runtime: OrcaRuntimeRpcServer | null = null
let endpoint = ''
let agent: ReturnType<typeof createCloudAgentClient> | null = null

beforeAll(async () => {
  platform = await startPlatform()
  agent = createCloudAgentClient({
    apiUrl: platform.url,
    internalToken: 'agent-test-token',
    hostId: 'host_dev001',
    hostName: 'dev-001',
    refreshMs: 200,
    timeoutMs: 2000
  })
  await agent.refresh()

  runtime = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-agent-')),
    enableWebSocket: true,
    wsPort: 0,
    upgradeAdmission: (headers) => agent!.admit(headers)
  })
  await runtime.start()
  const offer = runtime.createPairingOffer({
    address: '127.0.0.1',
    name: 'cloud-agent',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  endpoint = parsePairingCode(offer.pairingUrl)!.endpoint
})

afterAll(async () => {
  agent?.stop()
  await runtime?.stop()
  await platform?.stop()
})

describe('开发机侧云端接入（真实平台进程 + 真实 Runtime）', () => {
  it('从平台拉取 JWKS 与撤销快照', () => {
    const snapshot = agent!.snapshot()
    expect(snapshot.kids.length).toBeGreaterThan(0)
    expect(snapshot.lastError).toBeNull()
    expect(snapshot.revocations.devices).toEqual([])
  })

  it('平台签发的真实凭证在真实 Runtime 上通过升级', async () => {
    const session = await openPlatformSession()
    const outcome = await attempt(endpoint, session.credential, session.devicePubKey)
    expect(outcome).toMatchObject({ opened: true })
  })

  it('凭证被移植到另一设备仍被拒（设备绑定在真实 Runtime 生效）', async () => {
    const session = await openPlatformSession()
    const outcome = await attempt(endpoint, session.credential, 'some-other-device-key')
    expect(outcome.status).toBe(401)
    expect(outcome.reject).toBe('device_mismatch')
  })

  it('设备吊销经控制面轮询到达主机，新升级被拒（device_revoked）', async () => {
    const session = await openPlatformSession()
    const before = await attempt(endpoint, session.credential, session.devicePubKey)
    expect(before.opened).toBe(true)

    const revoke = await fetch(`${platform.url}/v1/me/devices/${session.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session.accessToken}` }
    })
    expect(revoke.ok).toBe(true)

    await agent!.refresh()
    expect(agent!.snapshot().revocations.devices.map((entry) => entry.id)).toContain(
      session.deviceId
    )

    // A ticket issued before the revocation is dead; the platform would not issue
    // a fresh one for a revoked device, so replaying the old one is the worst case.
    const second = await openPlatformSession()
    const rejected = await attempt(endpoint, second.credential, second.devicePubKey)
    expect(rejected.opened).toBe(true)

    const revokedSession = await attempt(endpoint, session.credential, session.devicePubKey)
    expect(revokedSession.status).toBe(401)
    expect(revokedSession.reject).toBe('device_revoked')
  })
})
