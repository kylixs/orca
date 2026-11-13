import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import { CLOUD_SESSION_FILENAME } from './cloud-session-persistence'
import { CloudSessionService } from './cloud-session-service'
import { startRecoveryHarness, type RecoveryHarness } from './cloud-provision-recovery-fixture'

/**
 * M98 (AC-16, G-14): the saved login is one per data directory. Two people (or two
 * installs) on one machine must each resume their own identity, see only their own
 * projects, and signing out of one must not touch the other's session.
 *
 * Real platform process, real enrolled host and TLS runtime; "restart" is a new
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

let harness: RecoveryHarness

function saveEvidence(file: string, content: unknown): void {
  const dir = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm98-session-user-isolation')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), JSON.stringify(content, null, 2))
}

function serviceFor(userDataPath: string): CloudSessionService {
  return new CloudSessionService({
    apiUrl: harness.platformUrl,
    tlsRejectUnauthorized: false,
    refreshLeadMs: 0,
    userDataPath
  })
}

beforeAll(async () => {
  harness = await startRecoveryHarness(ipcHandlers, { provisionRepo: true })
}, 120_000)

afterAll(async () => {
  await harness?.stop()
})

describe('AC-16 每个数据目录各自恢复自己的云会话（多用户/多设备隔离）', () => {
  it('M98-1 两个目录分别是 zhangsan 与 lisi：身份、设备与项目互不串；一方登出不影响另一方', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'orca-m98-user-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'orca-m98-user-b-'))
    const fileA = join(dirA, CLOUD_SESSION_FILENAME)
    const fileB = join(dirB, CLOUD_SESSION_FILENAME)

    // ---- two people sign in, each in their own directory ----
    const a = serviceFor(dirA)
    const loginA = await a.login('zhangsan', 'Passw0rd!')
    expect(loginA.status).toBe('signed-in')
    const deviceA = a.currentDeviceId

    const b = serviceFor(dirB)
    const loginB = await b.login('lisi', 'Passw0rd!')
    expect(loginB.status).toBe('signed-in')
    const deviceB = b.currentDeviceId

    expect(deviceA.length).toBeGreaterThan(0)
    expect(deviceB.length).toBeGreaterThan(0)
    expect(deviceB).not.toBe(deviceA)
    expect(existsSync(fileA) && existsSync(fileB)).toBe(true)

    // Only zhangsan is in team-payment; lisi must see nothing.
    const projectsA = await a.listProjects()
    const projectsB = await b.listProjects()
    expect(projectsA.some((project) => project.id === harness.projectId)).toBe(true)
    expect(projectsB.some((project) => project.id === harness.projectId)).toBe(false)

    // ---- restart both: each resumes its own identity, not the other's ----
    const aRestarted = serviceFor(dirA)
    const bRestarted = serviceFor(dirB)
    const restoredA = await aRestarted.restoreSession()
    const restoredB = await bRestarted.restoreSession()
    expect(restoredA.status).toBe('signed-in')
    expect(restoredB.status).toBe('signed-in')
    if (restoredA.status !== 'signed-in' || restoredB.status !== 'signed-in') {
      throw new Error('both directories must restore their own session')
    }
    expect(restoredA.displayName).toBe('张伟')
    expect(restoredB.displayName).toBe('李四')
    expect(aRestarted.currentDeviceId).toBe(deviceA)
    expect(bRestarted.currentDeviceId).toBe(deviceB)

    // ---- signing out of A must not end B ----
    await aRestarted.logout()
    expect(existsSync(fileA)).toBe(false)
    expect(existsSync(fileB)).toBe(true)

    const bAfterAOut = serviceFor(dirB)
    const restoredBAfter = await bAfterAOut.restoreSession()
    expect(restoredBAfter.status).toBe('signed-in')
    if (restoredBAfter.status === 'signed-in') {
      expect(restoredBAfter.displayName).toBe('李四')
    }
    expect(bAfterAOut.currentDeviceId).toBe(deviceB)

    // A signed-out directory stays signed out.
    const aAfterOut = serviceFor(dirA)
    expect(await aAfterOut.restoreSession()).toEqual({ status: 'signed-out' })

    saveEvidence('session-user-isolation.json', {
      directories: 2,
      users: { a: 'zhangsan', b: 'lisi' },
      deviceIdsDistinct: deviceB !== deviceA,
      projectsA: projectsA.map((project) => project.id),
      projectsB: projectsB.map((project) => project.id),
      restored: {
        a: { status: restoredA.status, displayName: restoredA.displayName },
        b: { status: restoredB.status, displayName: restoredB.displayName }
      },
      afterSignOutA: {
        fileAExists: false,
        fileBExists: true,
        bRestores: restoredBAfter.status,
        aRestores: 'signed-out'
      }
    })
  }, 300_000)
})
