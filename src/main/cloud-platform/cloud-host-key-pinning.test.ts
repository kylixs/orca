import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import {
  startAgentLaunchStack,
  type AgentLaunchStack
} from './cloud-agent-launch-execution-fixture'
import { CloudConnectClient } from './cloud-connect-client'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'
import { formatFingerprint, hostKeyFingerprint } from './cloud-host-trust'

/**
 * M77 (G-02 / AC-29): a host's E2EE key is pinned on first use. When the platform
 * hands a different key later, the client refuses with FINGERPRINT_MISMATCH,
 * closes the live socket with 4433, and only re-pins after explicit re-verification.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm77-host-key-pinning')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function errorCode(error: unknown): string | null {
  return error !== null &&
    typeof error === 'object' &&
    typeof Reflect.get(error, 'code') === 'string'
    ? String(Reflect.get(error, 'code'))
    : null
}

let stack: AgentLaunchStack
let userDataPath: string

beforeAll(async () => {
  stack = await startAgentLaunchStack()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-m77-trust-'))
}, 180_000)

afterAll(async () => {
  stack?.stopPtyController()
  stack?.desktop.close()
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.platform.stop()
})

describe('主机公钥 TOFU 固定与 4433 中断（真实平台 + 真实 TLS Runtime + 真实 WSS）', () => {
  it('M77-1 首次固定、平台换钥后拒绝并断开，显式重新核对后才更新', async () => {
    const client = new CloudConnectClient({
      apiUrl: stack.platform.url,
      tlsRejectUnauthorized: false,
      userDataPath
    })
    await client.login('zhangsan', 'Passw0rd!')
    const ensured = await ensureCloudWorkspace(client, stack.projectId)
    expect(ensured.ok, JSON.stringify(ensured)).toBe(true)

    const host = stack.admission.host()!
    const realKey = stack.cloud.serverPublicKeyB64
    const pinned = client.pinnedHostFingerprint(host.hostId)
    expect(pinned).toBe(hostKeyFingerprint(realKey))
    const beforeOpen = await client.rpc('status.get')
    expect(beforeOpen.ok).toBe(true)

    // The platform (or someone who can write host state) now hands out another key.
    stack.admission.client!.stop()
    const rogueKey = Buffer.alloc(32, 7).toString('base64')
    const beat = await fetch(`${stack.platform.url}/v1/hosts/${host.hostId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${host.credential}` },
      body: JSON.stringify({ status: 'online', e2eePublicKeyB64: rogueKey })
    })
    expect(beat.status).toBe(200)

    let mismatchCode: string | null = null
    let mismatchCloseCode: number | null = null
    try {
      await client.openProject(stack.projectId)
    } catch (error) {
      mismatchCode = errorCode(error)
      const closeCode =
        error !== null && typeof error === 'object' ? Reflect.get(error, 'closeCode') : null
      mismatchCloseCode = typeof closeCode === 'number' ? closeCode : null
    }
    expect(mismatchCode).toBe('FINGERPRINT_MISMATCH')
    expect(mismatchCloseCode).toBe(4433)
    // The live socket was dropped rather than left open under the old pin.
    expect((await client.rpc('status.get')).ok).toBe(false)
    // The pin is unchanged: a refusal must not silently adopt the new key.
    expect(client.pinnedHostFingerprint(host.hostId)).toBe(hostKeyFingerprint(realKey))

    // Explicit re-verification is the only path that moves the pin.
    client.trustHostKey(host.hostId, rogueKey)
    expect(client.pinnedHostFingerprint(host.hostId)).toBe(hostKeyFingerprint(rogueKey))

    saveEvidence('m77-pin-mismatch.json', {
      hostId: host.hostId,
      pinnedFingerprint: pinned,
      displayFingerprint: pinned === null ? null : formatFingerprint(pinned),
      mismatchCode,
      closeCode: mismatchCloseCode,
      pinAfterMismatch: hostKeyFingerprint(realKey),
      pinAfterReverify: hostKeyFingerprint(rogueKey)
    })

    // Restore the host's real key so the rest of the fixture stays consistent.
    await fetch(`${stack.platform.url}/v1/hosts/${host.hostId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${host.credential}` },
      body: JSON.stringify({ status: 'online', e2eePublicKeyB64: realKey })
    })
    client.close()
  }, 90_000)

  it('M77-2 固定值持久化：新客户端实例读到同一指纹，不会重新 TOFU', async () => {
    const host = stack.admission.host()!
    const fresh = new CloudConnectClient({
      apiUrl: stack.platform.url,
      tlsRejectUnauthorized: false,
      userDataPath
    })
    const pinned = fresh.pinnedHostFingerprint(host.hostId)
    expect(pinned).not.toBeNull()
    // The rogue key's pin from M77-1 survived the process boundary too.
    expect(pinned).toBe(hostKeyFingerprint(Buffer.alloc(32, 7).toString('base64')))

    await fresh.login('zhangsan', 'Passw0rd!')
    let code: string | null = null
    try {
      await fresh.openProject(stack.projectId)
    } catch (error) {
      code = errorCode(error)
    }
    // The platform is back on the real key, so the persisted rogue pin must refuse.
    expect(code).toBe('FINGERPRINT_MISMATCH')

    saveEvidence('m77-pin-persisted.json', { persistedFingerprint: pinned, code })
    fresh.close()
  }, 60_000)
})
