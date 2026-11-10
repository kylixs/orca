import { beforeEach, describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ os: 'android' }))
const capabilities = vi.hoisted(() => ({ sharing: true, saf: true }))
const share = vi.hoisted(() => vi.fn(async () => {}))
const touch = vi.hoisted(() => vi.fn())
const saf = vi.hoisted(() => ({
  requestDirectoryPermissionsAsync: vi.fn(),
  readDirectoryAsync: vi.fn(),
  createFileAsync: vi.fn(),
  writeAsStringAsync: vi.fn()
}))

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os
    }
  }
}))
vi.mock('expo-file-system', () => ({
  File: class {
    async base64(): Promise<string> {
      return 'aGVsbG8='
    }
  }
}))
vi.mock('expo-file-system/legacy', () => ({ StorageAccessFramework: saf }))
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () =>
    capabilities.saf
      ? {
          requestDirectoryPermissionsAsync: () => {},
          createSAFFileAsync: () => {}
        }
      : null
}))
vi.mock('./file-action-capabilities', () => ({
  isSharingModuleAvailable: () => capabilities.sharing
}))
vi.mock('../platform/share-file', () => ({ sharePreparedFile: share }))
vi.mock('./mobile-file-download-cache', () => ({
  SAF_MAX_BYTES: 16 * 1024 * 1024,
  touchPreparedCacheFile: touch
}))

import { savePreparedFileToPhone } from './mobile-file-save'
import type { PreparedCachedFile } from './mobile-file-download-cache'

function prepared(size: number): PreparedCachedFile {
  return {
    targetKey: 'target',
    fileName: 'app.ts',
    uri: 'file:///cache/one/app.ts',
    directoryUri: 'file:///cache/one',
    size,
    sha256: 'abc',
    mimeType: 'text/plain',
    uti: 'public.plain-text',
    createdAt: 1,
    usedAt: 1
  }
}

beforeEach(() => {
  platform.os = 'android'
  capabilities.sharing = true
  capabilities.saf = true
  share.mockReset()
  share.mockResolvedValue(undefined)
  touch.mockReset()
  saf.requestDirectoryPermissionsAsync.mockReset()
  saf.requestDirectoryPermissionsAsync.mockResolvedValue({
    granted: true,
    directoryUri: 'content://downloads/tree/primary%3ADownload'
  })
  saf.readDirectoryAsync.mockReset()
  saf.readDirectoryAsync.mockResolvedValue([])
  saf.createFileAsync.mockReset()
  saf.createFileAsync.mockImplementation(
    async (_directory: string, name: string) =>
      `content://downloads/document/primary%3ADownload%2F${encodeURIComponent(name)}`
  )
  saf.writeAsStringAsync.mockReset()
  saf.writeAsStringAsync.mockResolvedValue(undefined)
})

describe('savePreparedFileToPhone', () => {
  it('writes 15.9 MB and exactly 16 MB through SAF', async () => {
    for (const size of [15.9 * 1024 * 1024, 16 * 1024 * 1024]) {
      const result = await savePreparedFileToPhone(prepared(size))
      expect(result.kind).toBe('saved')
      expect(result.sha256).toBe('abc')
      expect(result.path).toBe('Download/app.ts')
    }
    expect(saf.requestDirectoryPermissionsAsync).toHaveBeenCalledTimes(2)
    expect(saf.writeAsStringAsync).toHaveBeenCalledWith(
      expect.stringContaining('content://'),
      'aGVsbG8=',
      { encoding: 'base64' }
    )
    expect(share).not.toHaveBeenCalled()
  })

  it('uses the share sheet above 16 MB instead of building a large base64 string', async () => {
    const result = await savePreparedFileToPhone(prepared(16 * 1024 * 1024 + 1))

    expect(result.kind).toBe('shared')
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ size: 16 * 1024 * 1024 + 1 }), {
      dialogTitle: 'Save to phone'
    })
    expect(saf.requestDirectoryPermissionsAsync).not.toHaveBeenCalled()
  })

  it('renames a colliding SAF document instead of failing', async () => {
    saf.readDirectoryAsync.mockResolvedValue([
      'content://downloads/document/primary%3ADownload%2Fapp.ts'
    ])
    await savePreparedFileToPhone(prepared(10))

    expect(saf.createFileAsync).toHaveBeenCalledWith(
      'content://downloads/tree/primary%3ADownload',
      'app (1).ts',
      'text/plain'
    )
  })

  it('reports cancellation when the folder picker is dismissed, without sharing', async () => {
    saf.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: false })

    await expect(savePreparedFileToPhone(prepared(10))).rejects.toMatchObject({
      code: 'cancelled'
    })
    expect(share).not.toHaveBeenCalled()
  })

  it('fails clearly when a large save has no sharing module', async () => {
    capabilities.sharing = false

    await expect(savePreparedFileToPhone(prepared(17 * 1024 * 1024))).rejects.toMatchObject({
      code: 'unavailable'
    })
  })

  it('uses the share sheet on iOS for every size', async () => {
    platform.os = 'ios'

    const result = await savePreparedFileToPhone(prepared(10))

    expect(result.kind).toBe('shared')
    expect(share).toHaveBeenCalledWith(expect.anything(), { dialogTitle: 'Save to phone' })
    expect(saf.requestDirectoryPermissionsAsync).not.toHaveBeenCalled()
  })
})
