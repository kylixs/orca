import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOUD_SESSION_FILENAME,
  deletePersistedCloudSession,
  readPersistedCloudSession,
  writePersistedCloudSession,
  type PersistedCloudSession
} from './cloud-session-persistence'

/** The saved login is a credential file: shape-checked, platform-bound, user-only. */

const API_URL = 'http://platform.test'

function makeSession(overrides: Partial<PersistedCloudSession> = {}): PersistedCloudSession {
  return {
    version: 1,
    apiUrl: API_URL,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    deviceId: 'device-1',
    // 32 zero bytes: a well-formed key, not a usable one.
    deviceSecretKeyB64: Buffer.alloc(32, 0).toString('base64'),
    displayName: '张伟',
    savedAtMs: 1_700_000_000_000,
    ...overrides
  }
}

function makeUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'orca-cloud-session-persist-'))
}

describe('桌面云会话持久化', () => {
  it('写入后可原样读回，并带上当前平台的匹配校验', () => {
    const userDataPath = makeUserDataPath()
    const value = makeSession()
    expect(writePersistedCloudSession(userDataPath, value)).toBe(true)

    expect(readPersistedCloudSession(userDataPath, API_URL)).toEqual(value)
    // The stored URL is normalized only for comparison, not rewritten.
    expect(readPersistedCloudSession(userDataPath, `${API_URL}/`)).toEqual(value)
  })

  it('文件缺失、JSON 损坏或形状不符时返回 null，且不删除原文件', () => {
    const userDataPath = makeUserDataPath()
    expect(readPersistedCloudSession(userDataPath, API_URL)).toBeNull()

    const path = join(userDataPath, CLOUD_SESSION_FILENAME)
    writeFileSync(path, '{not json')
    expect(readPersistedCloudSession(userDataPath, API_URL)).toBeNull()
    expect(existsSync(path)).toBe(true)

    // A wrong version and a short secret key are both "not a session", not partial data.
    writeFileSync(path, JSON.stringify({ ...makeSession(), version: 2 }))
    expect(readPersistedCloudSession(userDataPath, API_URL)).toBeNull()
    writeFileSync(path, JSON.stringify(makeSession({ deviceSecretKeyB64: 'AAAA' })))
    expect(readPersistedCloudSession(userDataPath, API_URL)).toBeNull()
  })

  it('apiUrl 与当前配置不一致时返回 null：旧平台的令牌不能打新平台', () => {
    const userDataPath = makeUserDataPath()
    writePersistedCloudSession(userDataPath, makeSession({ apiUrl: 'http://old-platform.test' }))
    expect(readPersistedCloudSession(userDataPath, API_URL)).toBeNull()
    expect(existsSync(join(userDataPath, CLOUD_SESSION_FILENAME))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('文件权限收紧到仅当前用户可读写', () => {
    const userDataPath = makeUserDataPath()
    writePersistedCloudSession(userDataPath, makeSession())
    const mode = statSync(join(userDataPath, CLOUD_SESSION_FILENAME)).mode
    expect(mode & 0o077).toBe(0)
  })

  it('删除后不再可读，重复删除不报错', () => {
    const userDataPath = makeUserDataPath()
    writePersistedCloudSession(userDataPath, makeSession())
    deletePersistedCloudSession(userDataPath)
    expect(readPersistedCloudSession(userDataPath, API_URL)).toBeNull()
    expect(existsSync(join(userDataPath, CLOUD_SESSION_FILENAME))).toBe(false)
    expect(() => deletePersistedCloudSession(userDataPath)).not.toThrow()
  })
})
