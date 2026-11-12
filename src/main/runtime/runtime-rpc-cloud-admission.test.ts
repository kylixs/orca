import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { headerText } from '../../shared/http-header-text'
import {
  createCloudUpgradeAdmission,
  type CloudRevocations
} from '../cloud-platform/cloud-upgrade-admission'
import { canonicalCloudJson, type CloudCredentialPayload } from '../cloud-platform/cloud-credential'
import { parsePairingCode } from '../../shared/pairing'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

// Real Ed25519 keys and real signed tickets: no mocks of the crypto path.
const keys = generateKeyPairSync('ed25519')
const KEY_ID = 'kid-test'
const JWKS = new Map([[KEY_ID, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()]])

function signTicket(payload: CloudCredentialPayload): string {
  const header = { alg: 'EdDSA', typ: 'JWT', kid: KEY_ID }
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(
    canonicalCloudJson(payload)
  ).toString('base64url')}`
  const signature = sign(null, Buffer.from(input), keys.privateKey)
  return `${input}.${signature.toString('base64url')}`
}

function ticket(overrides: Partial<CloudCredentialPayload> = {}): CloudCredentialPayload {
  const now = Math.floor(Date.now() / 1000)
  return {
    v: 1,
    jti: `jti-${Math.random().toString(16).slice(2)}`,
    sub: 'user:zhangsan',
    aud: 'host:dev-001',
    host: 'host_dev001',
    project: 'proj_payment',
    projectRoot: '/srv/work/payment-service',
    workspaceRoot: '/srv/work/payment-service/.orca-worktrees/zhangsan',
    deviceId: 'dev_client',
    devicePubKey: 'device-public-key',
    deviceToken: 'device-token',
    perms: ['open', 'terminal', 'file:read'],
    iat: now,
    exp: now + 60,
    ...overrides
  }
}

type Server = { url: string; stop: () => Promise<void> }

async function startServer(revocations?: CloudRevocations): Promise<Server> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-admission-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0,
    upgradeAdmission: createCloudUpgradeAdmission({
      hostId: 'host_dev001',
      hostName: 'dev-001',
      keys: JWKS,
      revocations
    })
  })
  await server.start()
  // The pairing offer is the public way to learn the bound WS endpoint.
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'cloud-admission',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const endpoint = parsePairingCode(offer.pairingUrl)?.endpoint
  if (!endpoint) {
    throw new Error('no ws endpoint')
  }
  return { url: endpoint, stop: () => server.stop() }
}

type Outcome = { status?: number; reject?: string; opened?: boolean; error?: string }

function attempt(
  url: string,
  protocols: string[],
  headers: Record<string, string> = {}
): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const ws = new WebSocket(url, protocols, { headers, handshakeTimeout: 5000 })
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

let running: Server | null = null
afterEach(async () => {
  await running?.stop()
  running = null
})

describe('真实 Orca Runtime 的云端凭证准入', () => {
  it('合法凭证 + 设备头通过升级', async () => {
    running = await startServer()
    const outcome = await attempt(
      running.url,
      ['orca-runtime', `orca-cred.${signTicket(ticket())}`],
      { 'x-orca-device-pubkey': 'device-public-key' }
    )
    expect(outcome.opened).toBe(true)
  })

  it('缺少凭证被拒（401 + credential_missing）', async () => {
    running = await startServer()
    const outcome = await attempt(running.url, ['orca-runtime'])
    expect(outcome.status).toBe(401)
    expect(outcome.reject).toBe('credential_missing')
  })

  it('伪造签名的凭证被拒（bad_signature）', async () => {
    running = await startServer()
    const forged = signTicket(ticket()).split('.')
    forged[1] = Buffer.from(canonicalCloudJson(ticket({ perms: ['open', 'download'] }))).toString(
      'base64url'
    )
    const outcome = await attempt(running.url, ['orca-runtime', `orca-cred.${forged.join('.')}`], {
      'x-orca-device-pubkey': 'device-public-key'
    })
    expect(outcome.status).toBe(401)
    expect(outcome.reject).toBe('bad_signature')
  })

  it('省略设备公钥头一律拒绝（device_pubkey_missing）', async () => {
    running = await startServer()
    const outcome = await attempt(running.url, [
      'orca-runtime',
      `orca-cred.${signTicket(ticket())}`
    ])
    expect(outcome.status).toBe(401)
    expect(outcome.reject).toBe('device_pubkey_missing')
  })

  it('设备公钥不匹配被拒（device_mismatch）', async () => {
    running = await startServer()
    const outcome = await attempt(
      running.url,
      ['orca-runtime', `orca-cred.${signTicket(ticket())}`],
      {
        'x-orca-device-pubkey': 'another-device-key'
      }
    )
    expect(outcome.status).toBe(401)
    expect(outcome.reject).toBe('device_mismatch')
  })

  it('指向另一台主机的凭证被拒（host_mismatch）', async () => {
    running = await startServer()
    const outcome = await attempt(
      running.url,
      ['orca-runtime', `orca-cred.${signTicket(ticket({ aud: 'host:dev-999' }))}`],
      { 'x-orca-device-pubkey': 'device-public-key' }
    )
    expect(outcome.status).toBe(401)
    expect(outcome.reject).toBe('host_mismatch')
  })

  it('过期凭证被拒（expired）', async () => {
    running = await startServer()
    const past = Math.floor(Date.now() / 1000) - 3600
    const outcome = await attempt(
      running.url,
      ['orca-runtime', `orca-cred.${signTicket(ticket({ iat: past, exp: past + 60 }))}`],
      { 'x-orca-device-pubkey': 'device-public-key' }
    )
    expect(outcome.status).toBe(401)
    expect(outcome.reject).toBe('expired')
  })

  it('吊销设备后新凭证升级被拒（device_revoked）', async () => {
    const payload = ticket()
    // Revocation timestamps are "credentials issued at or before this are dead".
    const revokedAt = Date.now()
    running = await startServer({ devices: [{ id: 'dev_client', since: revokedAt }] })
    const outcome = await attempt(
      running.url,
      ['orca-runtime', `orca-cred.${signTicket(payload)}`],
      {
        'x-orca-device-pubkey': 'device-public-key'
      }
    )
    expect(outcome.status).toBe(401)
    expect(outcome.reject).toBe('device_revoked')
  })
})
