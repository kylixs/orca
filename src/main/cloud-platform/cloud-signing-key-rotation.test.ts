import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseJsonText, readString } from '../../shared/json-fields'
import { readTicketClaims } from './cloud-connect-response'
import { connectCloudSession, REPO_ROOT, type CloudConnection } from './cloud-session-e2e-harness'
import {
  startAgentLaunchStack,
  type AgentLaunchStack
} from './cloud-agent-launch-execution-fixture'

/**
 * M76 (G-03 / AC-31): a real host keeps admitting tickets signed by a key that
 * was retired mid-flight, because the retired public key is still on the JWKS
 * it refetches — the AC's "新旧 kid 并行验签".
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm76-signing-key-rotation')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

let stack: AgentLaunchStack
let adminToken: string

beforeAll(async () => {
  stack = await startAgentLaunchStack()
  const res = await fetch(`${stack.platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm76-admin' })
  })
  adminToken = readString(await res.json(), 'accessToken') ?? ''
  expect(adminToken).not.toBe('')
}, 180_000)

afterAll(async () => {
  stack?.stopPtyController()
  stack?.desktop.close()
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.platform.stop()
})

describe('签名密钥轮换后旧票据仍被真实主机接纳（真实平台 + 真实 TLS Runtime + 真实 WSS）', () => {
  it('M76-1 轮换前签发的票据在主机刷新 JWKS 后仍可升级并完成 E2EE', async () => {
    const identity = stack.desktop.deviceIdentity()
    const ticket = await stack.desktop.requestTicket(stack.projectId)
    const claims = readTicketClaims(ticket.credential)
    expect(claims.deviceToken).not.toBeNull()

    const kidsBefore = stack.admission.client!.snapshot().kids
    expect(kidsBefore).toHaveLength(1)

    const rotate = await fetch(`${stack.platform.url}/v1/admin/signing-keys/rotate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` }
    })
    expect(rotate.status).toBe(200)
    const rotatedBody: unknown = await rotate.json()
    const newKid = readString(rotatedBody, 'kid') ?? ''
    const previousKid = readString(rotatedBody, 'previousKid') ?? ''
    expect(newKid).not.toBe('')
    expect(previousKid).not.toBe('')

    // The host refetches the JWKS exactly as its heartbeat loop would.
    await stack.admission.client!.refresh()
    const kidsAfter = stack.admission.client!.snapshot().kids
    expect(kidsAfter.sort()).toEqual([newKid, previousKid].sort())

    const connection: CloudConnection = await connectCloudSession(
      stack.cloud.endpoint,
      stack.cloud.serverPublicKeyB64,
      {
        accessToken: identity.auth.accessToken,
        deviceId: identity.deviceId,
        devicePubKey: Buffer.from(identity.keyPair.publicKey).toString('base64'),
        deviceKeys: identity.keyPair,
        deviceToken: claims.deviceToken!,
        credential: ticket.credential,
        projectId: stack.projectId
      },
      // The old key is retained, so admission must not need a re-issued ticket.
      5_000,
      { tlsRejectUnauthorized: false }
    )
    expect(connection.status).toBe('authenticated')
    if (connection.status === 'authenticated') {
      const status = await connection.rpc('status.get')
      expect(status.ok).toBe(true)
      connection.ws.close()
    }

    saveEvidence('m76-host-admission.json', {
      ticketKid: readKid(ticket.credential),
      previousKid,
      newKid,
      kidsBefore,
      kidsAfter,
      admittedWithRetiredKey: connection.status
    })
  }, 90_000)
})

function readKid(credential: string): string {
  const header = parseJsonText(Buffer.from(credential.split('.')[0], 'base64url').toString('utf8'))
  return readString(header, 'kid') ?? ''
}
