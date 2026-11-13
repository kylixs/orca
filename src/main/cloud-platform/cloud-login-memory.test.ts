import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readField, readObjectValue, readString } from '../../shared/json-fields'
import {
  CLOUD_LOGIN_MEMORY_FILENAME,
  readCloudLoginMemory,
  writeCloudLoginMemory
} from './cloud-login-memory'

/**
 * M119/W10: the login the client remembers. Same protected-file convention as
 * the saved session beside it, minus every credential — an address and a
 * username are the whole payload.
 */

function makeUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'orca-cloud-login-memory-'))
}

describe('云端登录记忆持久化', () => {
  it('写入后按 cloud.lastPlatformUrl / lastUsername 原样读回', () => {
    const userDataPath = makeUserDataPath()
    expect(
      writeCloudLoginMemory(userDataPath, {
        platformUrl: 'https://cloud.example.com',
        username: 'zhangsan'
      })
    ).toBe(true)

    const raw: unknown = JSON.parse(
      readFileSync(join(userDataPath, CLOUD_LOGIN_MEMORY_FILENAME), 'utf8')
    )
    const cloud = readObjectValue(readField(raw, 'cloud'))
    expect(readString(cloud, 'lastPlatformUrl')).toBe('https://cloud.example.com')
    expect(readString(cloud, 'lastUsername')).toBe('zhangsan')

    expect(readCloudLoginMemory(userDataPath)).toEqual({
      lastPlatformUrl: 'https://cloud.example.com',
      lastUsername: 'zhangsan'
    })
  })

  it('再次成功登录覆盖上一次的记忆', () => {
    const userDataPath = makeUserDataPath()
    writeCloudLoginMemory(userDataPath, {
      platformUrl: 'https://one.example.com',
      username: 'zhangsan'
    })
    writeCloudLoginMemory(userDataPath, {
      platformUrl: 'https://two.example.com',
      username: 'lisi'
    })
    expect(readCloudLoginMemory(userDataPath)).toEqual({
      lastPlatformUrl: 'https://two.example.com',
      lastUsername: 'lisi'
    })
  })

  it('文件对用户之外不可读（沿用受保护文件惯例）', () => {
    const userDataPath = makeUserDataPath()
    writeCloudLoginMemory(userDataPath, {
      platformUrl: 'https://cloud.example.com',
      username: 'zhangsan'
    })
    if (process.platform === 'win32') {
      expect(true).toBe(true)
      return
    }
    const mode = statSync(join(userDataPath, CLOUD_LOGIN_MEMORY_FILENAME)).mode & 0o777
    expect(mode & 0o077).toBe(0)
  })

  it('文件缺失、JSON 损坏或形状不符返回空记忆，且不删除原文件', () => {
    const userDataPath = makeUserDataPath()
    expect(readCloudLoginMemory(userDataPath)).toEqual({
      lastPlatformUrl: null,
      lastUsername: null
    })

    const path = join(userDataPath, CLOUD_LOGIN_MEMORY_FILENAME)
    writeFileSync(path, '{not json')
    expect(readCloudLoginMemory(userDataPath)).toEqual({
      lastPlatformUrl: null,
      lastUsername: null
    })

    writeFileSync(path, JSON.stringify({ version: 1, cloud: { lastPlatformUrl: 42 } }))
    expect(readCloudLoginMemory(userDataPath)).toEqual({
      lastPlatformUrl: null,
      lastUsername: null
    })
    expect(existsSync(path)).toBe(true)
  })
})
