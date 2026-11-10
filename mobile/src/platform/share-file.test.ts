import { beforeEach, describe, expect, it, vi } from 'vitest'

const capabilities = vi.hoisted(() => ({ sharing: true }))
const sharingModule = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: vi.fn(async () => {})
}))
const touch = vi.hoisted(() => vi.fn())

vi.mock('expo-sharing', () => sharingModule)
vi.mock('../files/file-action-capabilities', () => ({
  isSharingModuleAvailable: () => capabilities.sharing
}))
vi.mock('../files/mobile-file-download-cache', () => ({
  touchPreparedCacheFile: touch
}))

import { sharePreparedFile } from './share-file'
import type { PreparedCachedFile } from '../files/mobile-file-download-cache'

const PREPARED: PreparedCachedFile = {
  targetKey: 'target',
  fileName: 'photo.png',
  uri: 'file:///cache/one/photo.png',
  directoryUri: 'file:///cache/one',
  size: 10,
  sha256: 'abc',
  mimeType: 'image/png',
  uti: 'public.png',
  createdAt: 1,
  usedAt: 1
}

beforeEach(() => {
  capabilities.sharing = true
  sharingModule.isAvailableAsync.mockReset()
  sharingModule.isAvailableAsync.mockResolvedValue(true)
  sharingModule.shareAsync.mockReset()
  sharingModule.shareAsync.mockResolvedValue(undefined)
  touch.mockReset()
})

describe('sharePreparedFile', () => {
  it('hands the file to the sheet with its MIME type and UTI', async () => {
    await sharePreparedFile(PREPARED, {
      dialogTitle: 'Open with',
      anchor: { x: 1, y: 2, width: 3, height: 4 }
    })

    expect(sharingModule.shareAsync).toHaveBeenCalledWith('file:///cache/one/photo.png', {
      mimeType: 'image/png',
      UTI: 'public.png',
      dialogTitle: 'Open with',
      anchor: { x: 1, y: 2, width: 3, height: 4 }
    })
    // The target app may read the URI after the sheet resolves; keep the cache entry alive.
    expect(touch).toHaveBeenCalledWith(PREPARED)
  })

  it('never imports or calls the native module on an old binary', async () => {
    capabilities.sharing = false

    await expect(sharePreparedFile(PREPARED)).rejects.toMatchObject({ code: 'unavailable' })
    expect(sharingModule.shareAsync).not.toHaveBeenCalled()
  })

  it('reports unavailable when the platform has no share sheet', async () => {
    sharingModule.isAvailableAsync.mockResolvedValue(false)

    await expect(sharePreparedFile(PREPARED)).rejects.toMatchObject({ code: 'unavailable' })
  })
})
