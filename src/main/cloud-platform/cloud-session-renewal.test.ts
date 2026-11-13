import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readString } from '../../shared/json-fields'
import type { CloudConnectionEvent } from '../../shared/cloud-platform-ipc'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import { startRecoveryHarness, type RecoveryHarness } from './cloud-provision-recovery-fixture'

/**
 * M61: the desktop session renews its access token transparently. Real platform
 * (1.2s access TTL) + real enrolled host + heartbeat + TLS runtime + real git.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const ipcHandlers = vi.hoisted(() => new Map<string, IpcHandler>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => ipcHandlers.set(channel, handler),
    removeHandler: (channel: string) => ipcHandlers.delete(channel)
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm61-session-renewal')
const ACCESS_TTL_MS = 1200

const refreshTokensSent: string[] = []

/** Records refresh-token rotation without touching the production token path. */
const recordingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith('/v1/auth/refresh')) {
    const body: unknown = JSON.parse(String(init?.body))
    const token = readString(body, 'refreshToken')
    if (token !== null) {
      refreshTokensSent.push(token)
    }
  }
  return fetch(input, init)
}

let harness: RecoveryHarness

beforeAll(async () => {
  harness = await startRecoveryHarness(ipcHandlers, {
    accessTtlMs: ACCESS_TTL_MS,
    refreshLeadMs: 0,
    provisionRepo: true,
    fetchImpl: recordingFetch
  })
}, 120_000)

afterAll(async () => {
  await harness?.stop()
})

async function loginAsOtherDevice(): Promise<string> {
  const res = await fetch(`${harness.platformUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'zhangsan', password: 'Passw0rd!', deviceName: 'm61-revoker' })
  })
  const token = readString(await res.json(), 'accessToken')
  if (token === null) {
    throw new Error('revoker login failed')
  }
  return token
}

function saveEvidence(content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, 'm61-renewal.json'), JSON.stringify(content, null, 2))
}

describe('云端会话自动续期（真实平台短 TTL + 真实主机/TLS/git）', () => {
  it('M61-1 令牌过期后 ensureWorkspace 内部刷新成功；会话被作废后回到签退并推送事件', async () => {
    const before = harness.session.authTokenFingerprints()
    expect(before).not.toBeNull()

    // Why past the real 1.2s TTL: the client's second-granularity estimate still
    // says valid, so the first request must recover through the 401 path.
    await new Promise((resolve) => setTimeout(resolve, ACCESS_TTL_MS + 200))
    const ensured = await harness.session.ensureWorkspace(harness.projectId)
    expect(ensured).toMatchObject({ ok: true, route: 'direct' })
    expect(refreshTokensSent.length).toBeGreaterThan(0)

    const after = harness.session.authTokenFingerprints()
    expect(after?.access).not.toBe(before?.access)
    expect(after?.refresh).not.toBe(before?.refresh)
    expect(after?.refresh).not.toBeNull()

    // The renewed token still authorizes platform calls.
    const projects = await harness.session.listProjects()
    expect(projects.some((project) => project.id === harness.projectId)).toBe(true)

    const events: CloudConnectionEvent[] = []
    harness.session.onConnectionChanged((event) => events.push(event))
    const deviceId = harness.session.currentDeviceId
    const revokerToken = await loginAsOtherDevice()
    const revoked = await fetch(`${harness.platformUrl}/v1/me/devices/${deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${revokerToken}` }
    })
    expect(revoked.ok).toBe(true)

    const link = await harness.session.prepareProjectLink(harness.projectId)
    expect(link).toMatchObject({ ok: false, code: 'SESSION_EXPIRED' })
    expect(harness.session.getState().status).toBe('signed-out')
    expect(harness.session.connectedProjectIds).toEqual([])
    expect(events).toContainEqual({
      projectId: null,
      route: null,
      closeCode: 4401,
      reason: 'session_expired'
    })

    saveEvidence({
      platformAccessTtlMs: ACCESS_TTL_MS,
      expiredCallStillSucceeded: ensured,
      refreshRequestCount: refreshTokensSent.length,
      tokenFingerprints: { before, after },
      projectsAfterRefresh: projects.map((project) => project.id),
      negativeControl: {
        change: 'cloudAuthorizedFetch returns the first 401 without refreshing',
        expected: 'ensureWorkspace fails with SESSION_EXPIRED instead of recovering',
        evidence: 'negative-control-no-401-refresh.txt'
      },
      revocation: {
        deviceId,
        prepareProjectLink: link,
        state: harness.session.getState(),
        connectedProjectIds: harness.session.connectedProjectIds,
        events
      }
    })
  }, 240_000)
})
