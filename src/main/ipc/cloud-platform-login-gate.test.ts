import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeCloudLoginMemory } from '../cloud-platform/cloud-login-memory'
import { CLOUD_PLATFORM_IPC, type CloudSessionState } from '../../shared/cloud-platform-ipc'

/**
 * M119/W10 at the IPC boundary: the login screen exists for cloud builds even
 * with no environment variable, the loginContext reply carries the resolved
 * address and remembered username, and a managed build signs in to its pinned
 * address no matter what the form sent.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

type RecordedSession = {
  options: { apiUrl: string; userDataPath?: string }
  logins: { username: string; password: string; apiUrl?: string }[]
}

const ipcHandlers = vi.hoisted(() => new Map<string, IpcHandler>())
const sessions = vi.hoisted((): RecordedSession[] => [])

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
    readonly logins: { username: string; password: string; apiUrl?: string }[] = []
    private state: CloudSessionState = { status: 'signed-out' }

    constructor(options: { apiUrl: string; userDataPath?: string }) {
      this.options = options
      sessions.push(this)
    }

    onConnectionChanged(): () => void {
      return () => undefined
    }

    restoreSession(): Promise<CloudSessionState> {
      return Promise.resolve(this.state)
    }

    whenRestored(): Promise<CloudSessionState> {
      return Promise.resolve(this.state)
    }

    async login(username: string, password: string, apiUrl?: string): Promise<CloudSessionState> {
      this.logins.push({ username, password, apiUrl })
      this.state = { status: 'signed-in', displayName: '张伟', projects: [] }
      return this.state
    }

    logout(): CloudSessionState {
      this.state = { status: 'signed-out' }
      return this.state
    }
  }
}))

type BuildFlags = { defaultUrl?: string | null; managed?: boolean }

/**
 * Why re-import the flags module: afterEach's vi.resetModules() drops the
 * previous instance, so the stub must land in the same registry the
 * module-under-test is loaded from.
 */
async function stubBuildFlags(input: BuildFlags | null): Promise<void> {
  const flags = await import('../../shared/cloud-build-flags')
  flags.stubCloudBuildFlagsForTests(input)
}

function makeUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'orca-login-gate-'))
}

async function loginContextReply(): Promise<unknown> {
  const handler = ipcHandlers.get(CLOUD_PLATFORM_IPC.loginContext)
  if (!handler) {
    throw new Error('loginContext handler not registered')
  }
  return handler(undefined)
}

async function loginReply(
  username: string,
  password: string,
  platformUrl?: string
): Promise<unknown> {
  const handler = ipcHandlers.get(CLOUD_PLATFORM_IPC.login)
  if (!handler) {
    throw new Error('login handler not registered')
  }
  return handler(undefined, username, password, platformUrl)
}

afterEach(async () => {
  await stubBuildFlags(null)
  for (const value of Object.values(CLOUD_PLATFORM_IPC)) {
    ipcHandlers.delete(value)
  }
  sessions.length = 0
  vi.resetModules()
})

describe('云端 IPC 装配（M119/W10）', () => {
  it('普通桌面构建不装配任何云端处理器（零回归）', async () => {
    await stubBuildFlags({})
    const { installCloudPlatformIpc } = await import('./cloud-platform')
    expect(installCloudPlatformIpc({}, { userDataPath: makeUserDataPath() })).toBeNull()
    expect(ipcHandlers.size).toBe(0)
  })

  it('无 env 启动也装配登录界面：构建默认地址成为预填值', async () => {
    await stubBuildFlags({ defaultUrl: 'https://build.example.com' })
    const { installCloudPlatformIpc } = await import('./cloud-platform')
    const installed = installCloudPlatformIpc({}, { userDataPath: makeUserDataPath() })
    expect(installed).not.toBeNull()
    expect(await loginContextReply()).toEqual({
      platformUrl: 'https://build.example.com',
      username: null,
      locked: false
    })
    installed?.dispose()
    expect(ipcHandlers.size).toBe(0)
  })

  it('上次成功登录的地址与用户名覆盖构建默认，成为预填值', async () => {
    await stubBuildFlags({ defaultUrl: 'https://build.example.com' })
    const userDataPath = makeUserDataPath()
    writeCloudLoginMemory(userDataPath, {
      platformUrl: 'https://memory.example.com',
      username: 'zhangsan'
    })
    const { installCloudPlatformIpc } = await import('./cloud-platform')
    const installed = installCloudPlatformIpc({}, { userDataPath })
    expect(await loginContextReply()).toEqual({
      platformUrl: 'https://memory.example.com',
      username: 'zhangsan',
      locked: false
    })
    installed?.dispose()
  })

  it('运行时 env 覆盖记忆，仍然只是预填值', async () => {
    const userDataPath = makeUserDataPath()
    writeCloudLoginMemory(userDataPath, {
      platformUrl: 'https://memory.example.com',
      username: 'zhangsan'
    })
    const { installCloudPlatformIpc } = await import('./cloud-platform')
    const installed = installCloudPlatformIpc(
      { ORCA_CLOUD_API_URL: 'https://env.example.com' },
      { userDataPath }
    )
    expect(await loginContextReply()).toMatchObject({ platformUrl: 'https://env.example.com' })
    expect(sessions[0]?.options.apiUrl).toBe('https://env.example.com')
    installed?.dispose()
  })

  it('登录地址非法时拒绝并给出错误码，不再触碰会话', async () => {
    await stubBuildFlags({ defaultUrl: 'https://build.example.com' })
    const { installCloudPlatformIpc } = await import('./cloud-platform')
    const installed = installCloudPlatformIpc({}, { userDataPath: makeUserDataPath() })

    await expect(loginReply('zhangsan', 'Passw0rd!', 'not a url')).rejects.toMatchObject({
      code: 'PLATFORM_ADDRESS_INVALID'
    })
    expect(sessions[0]?.logins).toHaveLength(0)
    installed?.dispose()
  })

  it('托管构建锁定地址：表单输入被忽略，登录始终指向锁定地址', async () => {
    await stubBuildFlags({ managed: true, defaultUrl: 'https://pinned.example.com' })
    const { installCloudPlatformIpc } = await import('./cloud-platform')
    const installed = installCloudPlatformIpc({}, { userDataPath: makeUserDataPath() })
    expect(await loginContextReply()).toMatchObject({ locked: true })

    await loginReply('zhangsan', 'Passw0rd!', 'https://evil.example.com')

    expect(sessions[0]?.logins).toEqual([
      { username: 'zhangsan', password: 'Passw0rd!', apiUrl: 'https://pinned.example.com' }
    ])
    installed?.dispose()
  })

  it('登录成功即写入登录记忆，下次启动预填', async () => {
    await stubBuildFlags({})
    const userDataPath = makeUserDataPath()
    const { installCloudPlatformIpc } = await import('./cloud-platform')
    const installed = installCloudPlatformIpc(
      { ORCA_CLOUD_API_URL: 'https://env.example.com' },
      { userDataPath }
    )

    await loginReply('zhangsan', 'Passw0rd!', 'https://env.example.com')

    expect(sessions[0]?.logins).toEqual([
      { username: 'zhangsan', password: 'Passw0rd!', apiUrl: 'https://env.example.com' }
    ])
    // The memory write belongs to the real service (covered there); the install
    // path only has to hand the session a writable userDataPath.
    expect(sessions[0]?.options.userDataPath).toBe(userDataPath)
    installed?.dispose()
  })
})
