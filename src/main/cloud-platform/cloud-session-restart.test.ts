import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readString } from '../../shared/json-fields'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import { startRecoveryHarness, type RecoveryHarness } from './cloud-provision-recovery-fixture'
import { CLOUD_SESSION_FILENAME } from './cloud-session-persistence'
import { CloudSessionService } from './cloud-session-service'

/**
 * M66: a desktop restart keeps the cloud login. Real platform (short access TTL)
 * + real enrolled host/heartbeat + TLS runtime + bare git; "restart" is a new
 * service instance over the same userDataPath.
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

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm66-session-persistence')
const ACCESS_TTL_MS = 1200

/** Captures the token the newest platform login/refresh issued; never written to evidence. */
const latestAccessToken = { value: '' }

const recordingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const response = await fetch(input, init)
  if (url.endsWith('/v1/auth/login') || url.endsWith('/v1/auth/refresh')) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null)
    const token = readString(body, 'accessToken')
    if (token !== null) {
      latestAccessToken.value = token
    }
  }
  return response
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

describe('桌面重启后恢复云会话（真实平台 + 真实主机/TLS/git）', () => {
  it('M66-1 三次重启都免登录，设备身份不变；会话作废后恢复为签退并删除文件', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-m66-session-'))
    const sessionFile = join(userDataPath, CLOUD_SESSION_FILENAME)
    const phases: {
      phase: string
      status: string
      deviceId: string
      fileExists: boolean
    }[] = []
    const note = (phase: string, service: CloudSessionService, status: string): void => {
      phases.push({
        phase,
        status,
        deviceId: service.currentDeviceId,
        fileExists: existsSync(sessionFile)
      })
    }
    // Why a factory: each call is a new process that only shares userDataPath.
    const restart = (): CloudSessionService =>
      new CloudSessionService({
        apiUrl: harness.platformUrl,
        tlsRejectUnauthorized: false,
        refreshLeadMs: 0,
        fetchImpl: recordingFetch,
        userDataPath
      })

    // First process: log in, then let the access token expire before the first call.
    const first = restart()
    const loggedIn = await first.login('zhangsan', 'Passw0rd!')
    expect(loggedIn.status).toBe('signed-in')
    const deviceId = first.currentDeviceId
    expect(deviceId.length).toBeGreaterThan(0)
    note('login', first, loggedIn.status)
    // U44: wait for the kick clone, so connect is not blocked by the U20 gate.
    await harness.beatUntilReady(harness.projectId)

    await sleep(ACCESS_TTL_MS + 300)
    const firstEnsure = await first.ensureWorkspace(harness.projectId)
    expect(firstEnsure, JSON.stringify(firstEnsure)).toMatchObject({ ok: true, route: 'direct' })
    // The refresh above rotated the tokens; the file must now carry the new pair.
    expect(existsSync(sessionFile)).toBe(true)
    first.closeProject(harness.projectId)
    note('first-process-after-refresh', first, first.getState().status)

    // Second process: restore from disk, poll (forces another rotation), write back.
    const second = restart()
    const restoredOnce = await second.restoreSession()
    expect(restoredOnce.status).toBe('signed-in')
    if (restoredOnce.status !== 'signed-in') {
      throw new Error('first restore must sign in')
    }
    expect(second.currentDeviceId).toBe(deviceId)
    const secondEnsure = await second.ensureWorkspace(harness.projectId)
    expect(secondEnsure, JSON.stringify(secondEnsure)).toMatchObject({ ok: true })
    await sleep(ACCESS_TTL_MS + 300)
    const rotated = await second.listProjects()
    expect(rotated.some((project) => project.id === harness.projectId)).toBe(true)
    second.closeProject(harness.projectId)
    note('second-process-after-rotation', second, second.getState().status)

    // Third process: only succeeds if the rotated refresh token was persisted.
    const third = restart()
    const restoredTwice = await third.restoreSession()
    expect(restoredTwice.status).toBe('signed-in')
    if (restoredTwice.status !== 'signed-in') {
      throw new Error('second restore must sign in')
    }
    expect(third.currentDeviceId).toBe(deviceId)
    const thirdEnsure = await third.ensureWorkspace(harness.projectId)
    expect(thirdEnsure, JSON.stringify(thirdEnsure)).toMatchObject({ ok: true })
    third.closeProject(harness.projectId)
    note('third-process-after-rotation', third, third.getState().status)

    // The platform kills this login: the next process must not silently sign in.
    expect(latestAccessToken.value).not.toBe('')
    const revoked = await fetch(`${harness.platformUrl}/v1/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${latestAccessToken.value}` }
    })
    expect(revoked.ok).toBe(true)
    expect(existsSync(sessionFile)).toBe(true)

    const fourth = restart()
    const afterRevoke = await fourth.restoreSession()
    expect(afterRevoke).toEqual({ status: 'signed-out' })
    expect(fourth.currentDeviceId).toBe('')
    note('restore-after-platform-revocation', fourth, afterRevoke.status)
    expect(existsSync(sessionFile)).toBe(false)

    expect(phases.map((entry) => entry.status)).toEqual([
      'signed-in',
      'signed-in',
      'signed-in',
      'signed-in',
      'signed-out'
    ])
    expect(new Set(phases.slice(0, 4).map((entry) => entry.deviceId))).toEqual(new Set([deviceId]))

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(
      join(EVIDENCE_DIR, 'desktop-restart.json'),
      JSON.stringify(
        {
          platformAccessTtlMs: ACCESS_TTL_MS,
          restarts: 3,
          phases,
          deviceIdStableAcrossRestarts:
            new Set(phases.slice(0, 4).map((entry) => entry.deviceId)).size === 1,
          sessionFileAfterRevocation: existsSync(sessionFile),
          negativeControl: {
            change:
              'performRefresh stops calling onTokensChanged, so rotated tokens stay in memory',
            expected: 'the next restart cannot restore and the suite turns red',
            evidence: 'negative-control-desktop.json'
          }
        },
        null,
        2
      )
    )
  }, 300_000)
})
