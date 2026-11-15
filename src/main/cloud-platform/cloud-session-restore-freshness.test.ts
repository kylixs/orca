import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CloudConnectClient,
  type CloudConnectOptions,
  type CloudProject
} from './cloud-connect-client'
import { writePersistedCloudSession, type PersistedCloudSession } from './cloud-session-persistence'
import { CloudSessionService } from './cloud-session-service'

/**
 * U65b: `cloud:getState` awaits the boot restore. Once the session is revoked or
 * expires, that settled promise must not keep answering with the boot-time
 * signed-in state, or the UI shows a user whose every action now fails.
 */

const API_URL = 'https://platform.test'
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
  closed = false
  expireOnNextList = false

  constructor(options: CloudConnectOptions) {
    super(options)
  }

  override async listProjects(): Promise<CloudProject[]> {
    if (this.expireOnNextList) {
      throw Object.assign(new Error('session expired'), { code: 'SESSION_EXPIRED' })
    }
    return PROJECTS
  }

  override async login(): Promise<{ displayName: string; permissions: string[] }> {
    return { displayName: '张伟', permissions: ['open'] }
  }

  override close(): void {
    this.closed = true
  }
}

function persistedSession(): PersistedCloudSession {
  return {
    version: 1,
    apiUrl: API_URL,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    deviceId: 'device-1',
    deviceSecretKeyB64: Buffer.alloc(32, 7).toString('base64'),
    displayName: '张伟',
    savedAtMs: Date.now()
  }
}

function makeHarness(): {
  session: CloudSessionService
  created: FakeClient[]
  userDataPath: string
} {
  const created: FakeClient[] = []
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-restore-freshness-'))
  writePersistedCloudSession(userDataPath, persistedSession())
  const session = new CloudSessionService(
    { apiUrl: API_URL, tlsRejectUnauthorized: false, userDataPath },
    {
      createClient: (options) => {
        const client = new FakeClient(options)
        created.push(client)
        return client
      }
    }
  )
  return { session, created, userDataPath }
}

describe('恢复后的会话状态新鲜度（U65b）', () => {
  it('恢复成功后会话失效：getState 不再返回启动时的 signed-in', async () => {
    const { session, created } = makeHarness()

    expect((await session.restoreSession()).status).toBe('signed-in')
    expect((await session.whenRestored()).status).toBe('signed-in')

    created[0].expireOnNextList = true
    await expect(session.listProjects()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })

    expect(session.getState()).toEqual({ status: 'signed-out' })
    expect(created[0].closed).toBe(true)
    // The regression: whenRestored used to replay the settled boot promise.
    expect(await session.whenRestored()).toEqual({ status: 'signed-out' })
    expect(session.getState()).toEqual({ status: 'signed-out' })
  })

  it('恢复为签退后手动登录：getState 汇报新的 signed-in', async () => {
    // No saved login for this instance: the boot restore settles on signed-out.
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-restore-freshness-login-'))
    const session = new CloudSessionService(
      { apiUrl: API_URL, tlsRejectUnauthorized: false, userDataPath },
      {
        createClient: (options) => new FakeClient(options)
      }
    )
    expect((await session.restoreSession()).status).toBe('signed-out')

    expect((await session.login('zhangsan', 'Passw0rd!')).status).toBe('signed-in')
    expect((await session.whenRestored()).status).toBe('signed-in')
  })
})
