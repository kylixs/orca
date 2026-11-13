import { afterEach, describe, expect, it } from 'vitest'
import {
  builtInDefaultPlatformUrl,
  isCloudPlatformBuild,
  isManagedOrcaBuild,
  stubCloudBuildFlagsForTests
} from '../../shared/cloud-build-flags'
import { loginPlatformAddress, resolveCloudPlatformAddress } from './cloud-platform-address'

/**
 * M119/W10 address rules: runtime env > last successful login > build-injected
 * default > none; a managed build pins the address; a client with nothing still
 * starts and asks the user. The compile-time constants are stubbed through the
 * module's test seam.
 */

type BuildFlags = { defaultUrl?: string | null; managed?: boolean }

function stubBuildFlags(input: BuildFlags): void {
  stubCloudBuildFlagsForTests(input)
}

afterEach(() => {
  stubCloudBuildFlagsForTests(null)
})

describe('云端构建判定', () => {
  it('运行时 env 存在即为云端构建（沿用既有信号）', () => {
    stubBuildFlags({})
    expect(isCloudPlatformBuild({ ORCA_CLOUD_API_URL: 'https://cloud.example.com' })).toBe(true)
  })

  it('无 env 时构建期默认地址或托管开关同样成立', () => {
    stubBuildFlags({ defaultUrl: 'https://baked.example.com' })
    expect(isCloudPlatformBuild({})).toBe(true)
    stubBuildFlags({ managed: true })
    expect(isCloudPlatformBuild({})).toBe(true)
  })

  it('什么都没有就是普通桌面构建，不出现云端入口', () => {
    stubBuildFlags({})
    expect(isCloudPlatformBuild({})).toBe(false)
  })

  it('构建常量缺省时读取默认值，而非抛错', () => {
    stubBuildFlags({})
    expect(builtInDefaultPlatformUrl()).toBeNull()
    expect(isManagedOrcaBuild()).toBe(false)
  })
})

describe('平台地址默认值优先级', () => {
  it('env > 上次成功登录 > 构建默认 > 空', () => {
    stubBuildFlags({ defaultUrl: 'https://build.example.com' })
    expect(
      resolveCloudPlatformAddress({
        envApiUrl: 'https://env.example.com',
        memoryApiUrl: 'https://memory.example.com'
      })
    ).toMatchObject({ apiUrl: 'https://env.example.com', source: 'env', locked: false })
    expect(
      resolveCloudPlatformAddress({ memoryApiUrl: 'https://memory.example.com/' })
    ).toMatchObject({ apiUrl: 'https://memory.example.com', source: 'memory', locked: false })
    expect(resolveCloudPlatformAddress({})).toMatchObject({
      apiUrl: 'https://build.example.com',
      source: 'build',
      locked: false
    })
    stubBuildFlags({})
    expect(resolveCloudPlatformAddress({})).toEqual({ apiUrl: null, source: 'none', locked: false })
  })

  it('上一档无效时落到下一档，永不抛错', () => {
    stubBuildFlags({ defaultUrl: 'https://build.example.com' })
    expect(
      resolveCloudPlatformAddress({ envApiUrl: 'not a url', memoryApiUrl: 'ftp://nope' })
    ).toMatchObject({ apiUrl: 'https://build.example.com', source: 'build' })
  })

  it('打包构建不接受明文 http 环境地址，非打包保留本机 http', () => {
    stubBuildFlags({})
    expect(
      resolveCloudPlatformAddress({
        envApiUrl: 'http://127.0.0.1:8443',
        packaged: true
      }).apiUrl
    ).toBeNull()
    expect(
      resolveCloudPlatformAddress({
        envApiUrl: 'http://127.0.0.1:8443',
        packaged: false
      }).apiUrl
    ).toBe('http://127.0.0.1:8443')
  })

  it('托管构建锁定已解析地址；地址为空时不锁死登录', () => {
    stubBuildFlags({ managed: true, defaultUrl: 'https://build.example.com' })
    expect(resolveCloudPlatformAddress({})).toEqual({
      apiUrl: 'https://build.example.com',
      source: 'build',
      locked: true
    })
    stubBuildFlags({ managed: true })
    expect(resolveCloudPlatformAddress({}).locked).toBe(false)
  })
})

describe('登录使用的地址', () => {
  const RESOLVED = resolveCloudPlatformAddress({ envApiUrl: 'https://env.example.com' })

  it('托管构建无视表单输入，始终使用锁定地址', () => {
    stubBuildFlags({ managed: true, defaultUrl: 'https://pinned.example.com' })
    const pinned = resolveCloudPlatformAddress({})
    expect(loginPlatformAddress(pinned, 'https://evil.example.com', true)).toEqual({
      ok: true,
      apiUrl: 'https://pinned.example.com'
    })
  })

  it('非托管构建使用表单地址并去掉多余斜杠', () => {
    expect(loginPlatformAddress(RESOLVED, ' https://typed.example.com/ ', true)).toEqual({
      ok: true,
      apiUrl: 'https://typed.example.com'
    })
  })

  it('表单地址非法时报 PLATFORM_ADDRESS_INVALID，而不是悄悄换成别的平台', () => {
    expect(loginPlatformAddress(RESOLVED, 'not a url', true)).toEqual({
      ok: false,
      code: 'PLATFORM_ADDRESS_INVALID'
    })
    expect(loginPlatformAddress(RESOLVED, 'ftp://typed.example.com', true)).toEqual({
      ok: false,
      code: 'PLATFORM_ADDRESS_INVALID'
    })
  })

  it('表单未带地址时回退到解析结果；两者皆无则要求填写', () => {
    expect(loginPlatformAddress(RESOLVED, undefined, true)).toEqual({
      ok: true,
      apiUrl: 'https://env.example.com'
    })
    expect(loginPlatformAddress(resolveCloudPlatformAddress({}), ' ', true)).toEqual({
      ok: false,
      code: 'PLATFORM_ADDRESS_REQUIRED'
    })
  })
})
