import { describe, expect, it } from 'vitest'
import {
  deletePersistedWebCloudSession,
  readPersistedWebCloudSession,
  writePersistedWebCloudSession,
  type PersistedWebCloudSession,
  type WebCloudSessionStorage
} from './web-cloud-session-storage'

/** The saved browser login: shape-checked, platform-bound, and removable. */

const API_URL = 'http://platform.test'

class MemorySessionStorage implements WebCloudSessionStorage {
  value: string | null = null
  writes = 0
  removals = 0

  read(): string | null {
    return this.value
  }

  write(value: string): void {
    this.value = value
    this.writes += 1
  }

  remove(): void {
    this.value = null
    this.removals += 1
  }
}

function makeSession(overrides: Partial<PersistedWebCloudSession> = {}): PersistedWebCloudSession {
  return {
    version: 1,
    apiUrl: API_URL,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    deviceId: 'device-1',
    displayName: '张伟',
    savedAtMs: 1_700_000_000_000,
    ...overrides
  }
}

describe('浏览器云会话存储', () => {
  it('写入后可原样读回，并兼容平台地址尾部斜杠', () => {
    const storage = new MemorySessionStorage()
    const value = makeSession()
    expect(writePersistedWebCloudSession(storage, value)).toBe(true)
    expect(readPersistedWebCloudSession(storage, API_URL)).toEqual(value)
    expect(readPersistedWebCloudSession(storage, `${API_URL}/`)).toEqual(value)
  })

  it('空存储、损坏 JSON 或形状不符时返回 null', () => {
    const storage = new MemorySessionStorage()
    expect(readPersistedWebCloudSession(storage, API_URL)).toBeNull()

    storage.value = '{not json'
    expect(readPersistedWebCloudSession(storage, API_URL)).toBeNull()

    storage.value = JSON.stringify({ ...makeSession(), version: 2 })
    expect(readPersistedWebCloudSession(storage, API_URL)).toBeNull()

    storage.value = JSON.stringify({ ...makeSession(), refreshToken: undefined })
    expect(readPersistedWebCloudSession(storage, API_URL)).toBeNull()
  })

  it('apiUrl 不一致时返回 null：换平台必须重新登录', () => {
    const storage = new MemorySessionStorage()
    writePersistedWebCloudSession(storage, makeSession({ apiUrl: 'http://old-platform.test' }))
    expect(readPersistedWebCloudSession(storage, API_URL)).toBeNull()
  })

  it('删除后存储为空，写入失败不抛出', () => {
    const storage = new MemorySessionStorage()
    writePersistedWebCloudSession(storage, makeSession())
    deletePersistedWebCloudSession(storage)
    expect(storage.value).toBeNull()
    expect(readPersistedWebCloudSession(storage, API_URL)).toBeNull()

    const refusing: WebCloudSessionStorage = {
      read: () => null,
      write: () => {
        throw new Error('quota')
      },
      remove: () => undefined
    }
    expect(writePersistedWebCloudSession(refusing, makeSession())).toBe(false)
  })
})
