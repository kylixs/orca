import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CloudConnectClient,
  type CloudConnectOptions,
  type CloudDeviceIdentity,
  type CloudProject
} from './cloud-connect-client'
import { createCloudAuthSession } from './cloud-auth-session'
import { readCloudLoginMemory } from './cloud-login-memory'
import { readPersistedCloudSession } from './cloud-session-persistence'
import { CloudSessionService } from './cloud-session-service'

/**
 * M119/W10: a login may name its own platform address. That address becomes the
 * session's address (every later client call and the saved session file), and a
 * successful login records {address, username} for the next launch's prefill —
 * a failed one records nothing.
 */

const BOOT_API_URL = 'https://boot.example.com'
const TYPED_API_URL = 'https://typed.example.com'

const IDENTITY: CloudDeviceIdentity = {
  auth: createCloudAuthSession({
    apiUrl: TYPED_API_URL,
    accessToken: 'access-token',
    refreshToken: 'refresh-token'
  }),
  deviceId: 'device-1',
  keyPair: { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) }
}

const PROJECTS: CloudProject[] = [
  {
    id: 'project-a',
    key: 'alpha',
    name: 'Alpha',
    hostName: 'dev-host',
    hostStatus: 'online',
    permissions: ['open'],
    status: 'ready',
    provisioningError: null
  }
]

class FakeClient extends CloudConnectClient {
  readonly optionsSeen: CloudConnectOptions
  closed = false
  /** Set by the harness to script a failed sign-in. */
  loginError: Error | null = null

  constructor(options: CloudConnectOptions) {
    super(options)
    this.optionsSeen = options
  }

  override deviceIdentity(): CloudDeviceIdentity {
    return IDENTITY
  }

  override get currentDeviceId(): string {
    return IDENTITY.deviceId
  }

  override async login(): Promise<{ displayName: string; permissions: string[] }> {
    if (this.loginError) {
      throw this.loginError
    }
    return { displayName: '张伟', permissions: ['open'] }
  }

  override async listProjects(): Promise<CloudProject[]> {
    return PROJECTS
  }

  override close(): void {
    this.closed = true
  }
}

function makeHarness(input: { apiUrl?: string; loginError?: Error } = {}): {
  session: CloudSessionService
  created: FakeClient[]
  userDataPath: string
} {
  const created: FakeClient[] = []
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-login-address-'))
  const session = new CloudSessionService(
    { apiUrl: input.apiUrl ?? BOOT_API_URL, userDataPath },
    {
      createClient: (options) => {
        const client = new FakeClient(options)
        // Why the first client only: a scripted failure must not also fail the
        // retry a later assertion signs in with.
        if (input.loginError && created.length === 0) {
          client.loginError = input.loginError
        }
        created.push(client)
        return client
      }
    }
  )
  return { session, created, userDataPath }
}

describe('登录携带平台地址（M119/W10）', () => {
  it('登录成功把 {平台地址, 用户名} 写入登录记忆', async () => {
    const { session, userDataPath } = makeHarness()

    await session.login('zhangsan', 'Passw0rd!', TYPED_API_URL)

    expect(readCloudLoginMemory(userDataPath)).toEqual({
      lastPlatformUrl: TYPED_API_URL,
      lastUsername: 'zhangsan'
    })
  })

  it('登录地址同时成为会话地址：客户端与会话文件都指向它', async () => {
    const { session, created, userDataPath } = makeHarness()

    await session.login('zhangsan', 'Passw0rd!', TYPED_API_URL)

    expect(created).toHaveLength(1)
    expect(created[0].optionsSeen.apiUrl).toBe(TYPED_API_URL)
    const saved = readPersistedCloudSession(userDataPath, TYPED_API_URL)
    expect(saved).not.toBeNull()
    expect(saved?.displayName).toBe('张伟')
  })

  it('未带地址时沿用既有默认地址，行为与从前一致', async () => {
    const { session, created, userDataPath } = makeHarness()

    await session.login('zhangsan', 'Passw0rd!')

    expect(created[0].optionsSeen.apiUrl).toBe(BOOT_API_URL)
    expect(readCloudLoginMemory(userDataPath)).toEqual({
      lastPlatformUrl: BOOT_API_URL,
      lastUsername: 'zhangsan'
    })
  })

  it('既无默认地址又未填写时拒绝登录，而不是对空地址发请求', async () => {
    const { session, created } = makeHarness({ apiUrl: '' })

    await expect(session.login('zhangsan', 'Passw0rd!')).rejects.toMatchObject({
      code: 'PLATFORM_ADDRESS_REQUIRED'
    })
    expect(created).toHaveLength(0)
  })

  it('登录失败不写记忆', async () => {
    const { session, userDataPath } = makeHarness({
      loginError: Object.assign(new Error('bad credentials'), { code: 'INVALID_CREDENTIALS' })
    })

    await expect(session.login('zhangsan', 'wrong', TYPED_API_URL)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS'
    })
    expect(readCloudLoginMemory(userDataPath)).toEqual({
      lastPlatformUrl: null,
      lastUsername: null
    })
  })

  it('登录失败不改写会话地址：同进程重试仍指向原平台', async () => {
    const { session, created, userDataPath } = makeHarness({
      loginError: Object.assign(new Error('bad credentials'), { code: 'INVALID_CREDENTIALS' })
    })

    await expect(session.login('zhangsan', 'wrong', TYPED_API_URL)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS'
    })
    await session.login('zhangsan', 'Passw0rd!')

    expect(created).toHaveLength(2)
    expect(created[0].optionsSeen.apiUrl).toBe(TYPED_API_URL)
    // 失败的地址不残留：不带地址的第二次登录回到启动地址。
    expect(created[1].optionsSeen.apiUrl).toBe(BOOT_API_URL)
    expect(readCloudLoginMemory(userDataPath)).toEqual({
      lastPlatformUrl: BOOT_API_URL,
      lastUsername: 'zhangsan'
    })
  })

  it('表单地址带 URL 凭据时剥离后再登录与记忆', async () => {
    const { session, created, userDataPath } = makeHarness()

    await session.login('zhangsan', 'Passw0rd!', 'https://user:secret@typed.example.com')

    expect(created[0].optionsSeen.apiUrl).toBe(TYPED_API_URL)
    expect(readCloudLoginMemory(userDataPath).lastPlatformUrl).toBe(TYPED_API_URL)
  })
})
