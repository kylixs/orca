import { spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { createCloudAgentClient } from './cloud-agent-client'

/**
 * A host verifies tickets with keys it fetched from the platform. If the
 * platform becomes unreachable, those keys would otherwise keep admitting
 * tickets forever — including ones signed with a key the platform has since
 * rotated away. The host must stop admitting once its key set is stale.
 *
 * Real platform process (real Ed25519 keys and tickets); the clock is injected
 * so the TTL boundary is exercised without waiting.
 */

const REPO_ROOT = new URL('../../..', import.meta.url).pathname
const INTERNAL_TOKEN = 'jwks-stale-token'
// Tickets expire after 60s, so the key TTL under test has to be shorter than
// that or the ticket itself would expire before the staleness boundary.
const TTL_MS = 20_000

type Platform = { url: string; stop: () => Promise<void> }
let platform: Platform
let adminToken = ''
let hostId = ''
let hostName = ''
let projectId = ''
const devicePubKey = (() => {
  const { publicKey } = generateKeyPairSync('x25519')
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
})()

async function startPlatform(): Promise<Platform> {
  const proc: ChildProcess = spawn(process.execPath, ['cloud-platform/apps/api/src/server.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: '0', INTERNAL_TOKEN },
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

async function mintTicket(): Promise<string> {
  const loginRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey,
      deviceName: 'jwks-stale'
    })
  })
  const login: unknown = await loginRes.json()
  const accessToken = readString(login, 'accessToken')
  const deviceId = readString(readField(login, 'device'), 'id')
  if (accessToken === null || deviceId === null) {
    throw new Error('login response malformed')
  }
  const res = await fetch(`${platform.url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ deviceId, devicePubKey, clientVersion: '1.5.0' })
  })
  if (!res.ok) {
    throw new Error(`connect failed: ${res.status} ${await res.text()}`)
  }
  const credential = readString(await res.json(), 'credential')
  if (credential === null) {
    throw new Error('ticket malformed')
  }
  return credential
}

function headersFor(credential: string): Record<string, string> {
  return {
    'sec-websocket-protocol': `orca-runtime, orca-cred.${credential}`,
    'x-orca-device-pubkey': devicePubKey
  }
}

beforeAll(async () => {
  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'jwks-admin' })
  })
  adminToken = readString(await adminRes.json(), 'accessToken') ?? ''

  const tokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await tokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }
  hostName = 'jwks-stale-host'
  const hostRes = await fetch(`${platform.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({
      name: hostName,
      fingerprint: `host:${hostName}`,
      e2eePublicKeyB64: '',
      orcaVersion: '',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: ['127.0.0.1:1'],
      relayTarget: '',
      relayRoute: hostName,
      runtimeCapabilities: ['pty']
    })
  })
  hostId = readString(await hostRes.json(), 'hostId') ?? ''

  const projectRes = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'jwks-svc',
      name: 'jwks-svc',
      hostId,
      path: '/srv/work/jwks-svc'
    })
  })
  projectId = readString(await projectRes.json(), 'id') ?? ''
  await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal']
    })
  })
  await new Promise((r) => setTimeout(r, 1200))
})

afterAll(async () => {
  await platform?.stop()
})

describe('主机侧签名公钥过期（真实平台 + 真实 Ed25519 票据）', () => {
  it('刚刷新过公钥时放行；超过 TTL 未再刷新则拒绝新连接', async () => {
    let clock = Date.now()
    const client = createCloudAgentClient({
      apiUrl: platform.url,
      internalUrl: platform.url,
      internalToken: INTERNAL_TOKEN,
      hostId,
      hostName,
      now: () => clock,
      keysTtlMs: TTL_MS,
      fetchImpl: (input, init) => fetch(input, init)
    })
    await client.refresh()
    expect(client.snapshot().kids.length).toBeGreaterThan(0)

    const fresh = await mintTicket()
    expect(client.admit(headersFor(fresh))).toMatchObject({ ok: true })

    // Within the window the host still trusts what it fetched.
    clock += TTL_MS - 1
    const stillFresh = await mintTicket()
    expect(client.admit(headersFor(stillFresh))).toMatchObject({ ok: true })

    // Past the window, with no successful refetch, it must stop admitting.
    clock += 2
    const stale = await mintTicket()
    const staleDecision = client.admit(headersFor(stale))
    expect(staleDecision.ok).toBe(false)
    if (!staleDecision.ok) {
      expect(staleDecision.reason).toBe('jwks_stale')
      expect(staleDecision.headers['x-orca-reject']).toBe('jwks_stale')
    }

    // A successful refresh restores service.
    await client.refresh()
    const recovered = await mintTicket()
    expect(client.admit(headersFor(recovered))).toMatchObject({ ok: true })
    client.stop()
  }, 40000)

  it('平台不可达导致刷新失败时不刷新时间戳：最终仍会拒绝', async () => {
    let clock = Date.now()
    let reachable = true
    const client = createCloudAgentClient({
      apiUrl: platform.url,
      internalUrl: platform.url,
      internalToken: INTERNAL_TOKEN,
      hostId,
      hostName,
      now: () => clock,
      keysTtlMs: TTL_MS,
      fetchImpl: (input, init) =>
        reachable ? fetch(input, init) : Promise.reject(new Error('ECONNREFUSED'))
    })
    await client.refresh()
    expect(client.snapshot().kids.length).toBeGreaterThan(0)

    reachable = false
    clock += TTL_MS + 1
    // Refresh fails; the failure must not extend key freshness.
    await client.refresh()
    expect(client.snapshot().lastError).toContain('jwks fetch failed')

    const ticket = await mintTicket()
    expect(client.admit(headersFor(ticket))).toMatchObject({ ok: false, reason: 'jwks_stale' })
    client.stop()
  }, 40000)

  it('吊销优先于公钥过期：被撤销的项目明确报 project_revoked 而不是 jwks_stale', async () => {
    let clock = Date.now()
    const client = createCloudAgentClient({
      apiUrl: platform.url,
      internalUrl: platform.url,
      internalToken: INTERNAL_TOKEN,
      hostId,
      hostName,
      now: () => clock,
      keysTtlMs: TTL_MS
    })
    await client.refresh()
    const ticket = await mintTicket()

    await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
    })
    try {
      clock += TTL_MS + 1
      await client.refresh()

      const decision = client.admit(headersFor(ticket))
      expect(decision.ok).toBe(false)
      if (!decision.ok) {
        expect(decision.reason).toBe('project_revoked')
      }
    } finally {
      await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          subjectType: 'group',
          subjectId: 'team-payment',
          permissions: ['open', 'terminal']
        })
      })
    }
    client.stop()
  }, 40000)
})
