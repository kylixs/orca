import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_PLATFORM_IPC } from '../../shared/cloud-platform-ipc'
import { startCloudRuntimeAdmission, type CloudRuntimeAdmission } from './cloud-runtime-admission'

/**
 * U6: which env signal puts the app into host admission. `ORCA_CLOUD_API_URL`
 * alone is the client's prefilled platform address (M119/W10), so it must never
 * demand the host identity variables — only an explicit host token does.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

const ipcHandlers = vi.hoisted(() => new Map<string, IpcHandler>())
const sessions = vi.hoisted((): { installed: InstalledCloudSession[] } => ({ installed: [] }))

type InstalledCloudSession = { options: { apiUrl: string; userDataPath?: string } }

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { isPackaged: false }
}))

vi.mock('../cloud-platform/cloud-session-service', () => ({
  CloudSessionService: class {
    readonly options: { apiUrl: string; userDataPath?: string }
    constructor(options: { apiUrl: string; userDataPath?: string }) {
      this.options = options
      sessions.installed.push(this)
    }
    onConnectionChanged(): () => void {
      return () => undefined
    }
    restoreSession(): Promise<unknown> {
      return Promise.resolve({ status: 'signed-out' })
    }
    whenRestored(): Promise<unknown> {
      return Promise.resolve({ status: 'signed-out' })
    }
  }
}))

/** Unroutable loopback port: enrolment/heartbeat attempts fail fast, never hang. */
const DEAD_PLATFORM = 'http://127.0.0.1:9'

const startedAdmissions: CloudRuntimeAdmission[] = []

function startTracked(env: NodeJS.ProcessEnv): CloudRuntimeAdmission | null {
  const started = startCloudRuntimeAdmission(env)
  if (started) {
    startedAdmissions.push(started)
  }
  return started
}

async function loginContextReply(): Promise<unknown> {
  const handler = ipcHandlers.get(CLOUD_PLATFORM_IPC.loginContext)
  if (!handler) {
    throw new Error('loginContext handler not registered')
  }
  return handler(undefined)
}

afterEach(() => {
  for (const admission of startedAdmissions.splice(0)) {
    admission.stop()
  }
  for (const value of Object.values(CLOUD_PLATFORM_IPC)) {
    ipcHandlers.delete(value)
  }
  sessions.installed.length = 0
  vi.resetModules()
})

describe('云端准入的宿主信号判定（U6）', () => {
  it('仅设 ORCA_CLOUD_API_URL：不进宿主准入、不抛错，登录界面照常装配并预填', async () => {
    const env = { ORCA_CLOUD_API_URL: 'https://platform.example.com' }

    let started: CloudRuntimeAdmission | null = null
    expect(() => {
      started = startTracked(env)
    }).not.toThrow()
    expect(started).toBeNull()

    const { installCloudPlatformIpc } = await import('../ipc/cloud-platform')
    const installed = installCloudPlatformIpc(env, { userDataPath: makeUserDataPath() })
    expect(await loginContextReply()).toEqual({
      platformUrl: 'https://platform.example.com',
      username: null,
      locked: false
    })
    installed.dispose()
    expect(ipcHandlers.size).toBe(0)
  })

  it('无任何 cloud env：仍不进宿主准入；登录入口照常装配（W11），无地址可预填', async () => {
    expect(startTracked({})).toBeNull()

    const { installCloudPlatformIpc } = await import('../ipc/cloud-platform')
    const installed = installCloudPlatformIpc({}, { userDataPath: makeUserDataPath() })
    expect(await loginContextReply()).toEqual({ platformUrl: null, username: null, locked: false })
    installed.dispose()
    expect(ipcHandlers.size).toBe(0)
  })

  it('ORCA_CLOUD_HOST_TOKEN：进入注册路径，注册完成前拒绝所有升级', async () => {
    const started = startTracked({
      ORCA_CLOUD_API_URL: DEAD_PLATFORM,
      ORCA_CLOUD_HOST_TOKEN: 'host-token-u6',
      ORCA_CLOUD_HOST_NAME: 'dev-u6'
    })
    expect(started).not.toBeNull()
    if (!started) {
      return
    }
    // Enrolled-mode signature: no poll client until enrolment hands one over.
    expect(started.client).toBeNull()
    expect(started.admission({})).toMatchObject({ ok: false, reason: 'not_enrolled' })

    const failure = await started.ready.then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toHaveProperty(
      'message',
      expect.stringContaining('cloud host enrolment failed')
    )
  })

  it('ORCA_CLOUD_INTERNAL_TOKEN（无 HOST_TOKEN）：保留轮询路径，凭证即刻生效', async () => {
    const started = startTracked({
      ORCA_CLOUD_API_URL: DEAD_PLATFORM,
      ORCA_CLOUD_INTERNAL_TOKEN: 'internal-token-u6',
      ORCA_CLOUD_HOST_ID: 'host_u6',
      ORCA_CLOUD_HOST_NAME: 'dev-u6'
    })
    expect(started).not.toBeNull()
    if (!started) {
      return
    }
    // Poll-mode signature: env identity, client live immediately, no enrolment.
    expect(started.client).not.toBeNull()
    await started.ready
    expect(started.host()).toBeNull()
    expect(started.admission({})).toMatchObject({ ok: false, reason: 'credential_missing' })
  })

  it('INTERNAL_TOKEN 仍是显式宿主信号：缺 HOST_ID 的半套配置照旧抛错', () => {
    expect(() =>
      startCloudRuntimeAdmission({
        ORCA_CLOUD_API_URL: DEAD_PLATFORM,
        ORCA_CLOUD_INTERNAL_TOKEN: 'internal-token-u6',
        ORCA_CLOUD_HOST_NAME: 'dev-u6'
      })
    ).toThrow('Cloud mode is incomplete: missing ORCA_CLOUD_HOST_ID')
  })

  it('生产装配入口 cloudAdmissionOption：仅 API_URL 时不再注入宿主升级门', async () => {
    // cloudAdmissionOption memoises, so this call runs against a fresh module registry.
    vi.resetModules()
    const { cloudAdmissionOption } = await import('./cloud-runtime-admission')
    expect(
      cloudAdmissionOption({ ORCA_CLOUD_API_URL: 'https://platform.example.com' }, {})
    ).not.toHaveProperty('upgradeAdmission')
  })
})

function makeUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'orca-admission-env-'))
}
