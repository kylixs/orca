import { generateKeyPairSync, sign } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readArray, readField, readNumber, readString } from '../../shared/json-fields'
import {
  DEFAULT_INTERNAL_TOKEN,
  startPlatform,
  type Platform
} from './cloud-platform-server-process'
import { createCloudUpgradeAdmission, type CloudRevocations } from './cloud-upgrade-admission'

/**
 * Revocation is compared against when a ticket was issued. Tickets carry `iat`
 * in whole seconds, revocations carry milliseconds, so a ticket minted in the
 * same second as a revoke-then-regrant was refused for up to a second even
 * though it postdated the regrant. These cases drive that boundary through the
 * real platform: real Ed25519 signature, real revocations endpoint.
 */

let platform: Platform
let adminToken = ''
let projectId = ''
let hostId = ''
let hostName = ''
const devicePubKey = (() => {
  const { publicKey } = generateKeyPairSync('x25519')
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
})()

type Ticket = { credential: string; hostId: string; hostName: string }

async function loginDevice(deviceName: string): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey,
      deviceName
    })
  })
  const body: unknown = await res.json()
  const accessToken = readString(body, 'accessToken')
  const deviceId = readString(readField(body, 'device'), 'id')
  if (accessToken === null || deviceId === null) {
    throw new Error('login response malformed')
  }
  return `${accessToken}:${deviceId}`
}

async function mintTicket(): Promise<Ticket> {
  const [accessToken, deviceId] = (await loginDevice('precision')).split(':')
  const res = await fetch(`${platform.url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ deviceId, devicePubKey, clientVersion: '1.5.0' })
  })
  if (!res.ok) {
    throw new Error(`connect failed: ${res.status} ${await res.text()}`)
  }
  const body: unknown = await res.json()
  const credential = readString(body, 'credential')
  if (credential === null) {
    throw new Error('ticket malformed')
  }
  return { credential, hostId, hostName }
}

async function setGrants(permissions: string[]): Promise<void> {
  await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions })
  })
}

function parseRevocations(body: unknown): CloudRevocations {
  const list = (key: 'projects' | 'users' | 'devices'): { id: string; since: number }[] =>
    (readArray(body, key) ?? []).flatMap((entry) => {
      const id = readString(entry, 'id')
      const since = readNumber(entry, 'since')
      return id !== null && since !== null ? [{ id, since }] : []
    })
  return {
    projects: list('projects'),
    users: list('users'),
    devices: list('devices'),
    jtis: (readArray(body, 'jtis') ?? []).filter((entry) => typeof entry === 'string')
  }
}

async function loadKeysAndRevocations(): Promise<{
  keys: Map<string, string>
  revocations: CloudRevocations
}> {
  const jwks: unknown = await (await fetch(`${platform.url}/v1/jwks`)).json()
  const keys = new Map<string, string>()
  for (const entry of readArray(jwks, 'keys') ?? []) {
    const kid = readString(entry, 'kid')
    const publicKeyPem = readString(entry, 'publicKeyPem')
    if (kid !== null && publicKeyPem !== null) {
      keys.set(kid, publicKeyPem)
    }
  }
  const revocations = parseRevocations(
    await (
      await fetch(`${platform.url}/v1/internal/revocations`, {
        headers: { 'x-internal-token': DEFAULT_INTERNAL_TOKEN }
      })
    ).json()
  )
  return { keys, revocations }
}

function admissionFor(keys: Map<string, string>, revocations: CloudRevocations) {
  return createCloudUpgradeAdmission({ hostId, hostName, keys, revocations })
}

function headersFor(ticket: Ticket): Record<string, string> {
  return {
    'sec-websocket-protocol': `orca-runtime, orca-cred.${ticket.credential}`,
    'x-orca-device-pubkey': devicePubKey
  }
}

beforeAll(async () => {
  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'precision-admin' })
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
  const hostRes = await fetch(`${platform.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({
      name: 'precision-host',
      fingerprint: 'host:precision-host',
      e2eePublicKeyB64: '',
      orcaVersion: '',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: ['127.0.0.1:1'],
      relayTarget: '',
      relayRoute: 'precision-host',
      runtimeCapabilities: ['pty']
    })
  })
  const hostBody: unknown = await hostRes.json()
  hostId = readString(hostBody, 'hostId') ?? ''
  hostName = 'precision-host'

  const projectRes = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'precision-svc',
      name: 'precision-svc',
      hostId,
      path: '/srv/work/precision-svc'
    })
  })
  projectId = readString(await projectRes.json(), 'id') ?? ''
  await setGrants(['open', 'terminal'])
  await new Promise((r) => setTimeout(r, 1200))
})

afterAll(async () => {
  await platform?.stop()
})

describe('撤销时间语义（真实平台进程 + 真实 Ed25519 凭证）', () => {
  it('撤销前签发的票据在撤销后被拒：fail-closed 不变', async () => {
    await setGrants(['open', 'terminal'])
    const before = await mintTicket()
    await setGrants([])
    const { keys, revocations } = await loadKeysAndRevocations()
    const decision = admissionFor(keys, revocations)(headersFor(before))
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.reason).toBe('project_revoked')
    }
  }, 30000)

  it('同一秒内撤销后立即重新授权：新票据必须可用（否则用户被多锁一秒）', async () => {
    // Start early in a second so revoke + regrant + mint land in the same one;
    // if the test overruns, retry once from the next second.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 10))
      const startSecond = Math.floor(Date.now() / 1000)
      await setGrants([])
      await setGrants(['open', 'terminal'])
      const ticket = await mintTicket()
      const sameSecond = Math.floor(Date.now() / 1000) === startSecond
      const { keys, revocations } = await loadKeysAndRevocations()
      const decision = admissionFor(keys, revocations)(headersFor(ticket))
      if (!sameSecond) {
        continue
      }
      expect(decision).toMatchObject({ ok: true })
      return
    }
    throw new Error('could not keep revoke/regrant/mint inside one second')
  }, 40000)

  it('旧版平台不签 iatMs：仍按秒级比较，行为不变（向后兼容）', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const kid = 'legacy-kid'
    const keys = new Map([[kid, publicKey.export({ type: 'spki', format: 'pem' }).toString()]])
    const sinceMs = Date.now() - 500
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    const signTicket = (iat: number, withIatMs: boolean): string => {
      const payload = {
        v: 1,
        jti: `legacy-${iat}-${withIatMs}`,
        sub: 'user:zhangsan',
        aud: `host:${hostName}`,
        host: hostId,
        project: projectId,
        projectRoot: '/srv/work/precision-svc',
        workspaceRoot: '/srv/work/precision-svc/.orca-worktrees/zhangsan',
        deviceId: 'legacy-device',
        devicePubKey,
        deviceToken: 'legacy-token',
        perms: ['open'],
        iat,
        ...(withIatMs ? { iatMs: sinceMs + 250 } : {}),
        exp: expiresAt
      }
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid })).toString(
        'base64url'
      )
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
      const signature = sign(null, Buffer.from(`${header}.${body}`), privateKey)
      return `${header}.${body}.${signature.toString('base64url')}`
    }
    const revocations = { projects: [{ id: projectId, since: sinceMs }] }
    const admission = admissionFor(keys, revocations)

    // Old ticket in the same whole second as the revocation: still refused.
    const legacy = signTicket(Math.floor(sinceMs / 1000), false)
    const legacyDecision = admission({
      'sec-websocket-protocol': `orca-cred.${legacy}`,
      'x-orca-device-pubkey': devicePubKey
    })
    expect(legacyDecision).toMatchObject({ ok: false })

    // New ticket carrying the millisecond stamp is newer than the revocation.
    const fresh = signTicket(Math.floor(sinceMs / 1000), true)
    const freshDecision = admission({
      'sec-websocket-protocol': `orca-cred.${fresh}`,
      'x-orca-device-pubkey': devicePubKey
    })
    expect(freshDecision).toMatchObject({ ok: true })
  }, 30000)

  it('授权收回期间平台拒绝签发新票：不会出现"更晚的旧票"', async () => {
    await setGrants([])
    const [accessToken, deviceId] = (await loginDevice('precision')).split(':')
    const res = await fetch(`${platform.url}/v1/projects/${projectId}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ deviceId, devicePubKey, clientVersion: '1.5.0' })
    })
    expect(res.ok).toBe(false)
    const body: unknown = await res.json()
    expect(readString(readField(body, 'error'), 'code')).toBe('PROJECT_NOT_FOUND')
  }, 30000)
})
