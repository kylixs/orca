import { beforeEach, describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ os: 'android' }))
const capabilities = vi.hoisted(() => ({ sharing: true, intent: true }))
const content = vi.hoisted(() => ({ uri: 'content://com.orca/files/app.ts' }))
const share = vi.hoisted(() => vi.fn(async () => {}))
const touch = vi.hoisted(() => vi.fn())
const startActivityAsync = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os
    }
  }
}))
vi.mock('expo-file-system', () => ({
  File: class {
    get contentUri(): string {
      return content.uri
    }
  }
}))
vi.mock('expo-intent-launcher', () => ({ startActivityAsync }))
vi.mock('../files/file-action-capabilities', () => ({
  isIntentLauncherModuleAvailable: () => capabilities.intent,
  isSharingModuleAvailable: () => capabilities.sharing
}))
vi.mock('../files/mobile-file-download-cache', () => ({
  touchPreparedCacheFile: touch
}))
vi.mock('./share-file', () => ({ sharePreparedFile: share }))

import { openPreparedFile } from './open-file'
import type { PreparedCachedFile } from '../files/mobile-file-download-cache'

const PREPARED: PreparedCachedFile = {
  targetKey: 'target',
  fileName: 'app.ts',
  uri: 'file:///cache/one/app.ts',
  directoryUri: 'file:///cache/one',
  size: 10,
  sha256: 'abc',
  mimeType: 'text/plain',
  uti: 'public.plain-text',
  createdAt: 1,
  usedAt: 1
}

beforeEach(() => {
  platform.os = 'android'
  capabilities.sharing = true
  capabilities.intent = true
  content.uri = 'content://com.orca/files/app.ts'
  share.mockReset()
  share.mockResolvedValue(undefined)
  touch.mockReset()
  startActivityAsync.mockReset()
  startActivityAsync.mockResolvedValue(undefined)
})

describe('openPreparedFile', () => {
  it('launches ACTION_VIEW with the content URI and a read grant', async () => {
    const result = await openPreparedFile(PREPARED)

    expect(result).toBe('opened')
    expect(startActivityAsync).toHaveBeenCalledWith('android.intent.action.VIEW', {
      data: 'content://com.orca/files/app.ts',
      type: 'text/plain',
      flags: 1
    })
    expect(touch).toHaveBeenCalledWith(PREPARED)
  })

  it('falls back to the share chooser when the intent launcher is missing', async () => {
    capabilities.intent = false

    await expect(openPreparedFile(PREPARED)).resolves.toBe('shared')
    expect(share).toHaveBeenCalledWith(PREPARED, { dialogTitle: 'Open with' })
  })

  it('falls back to the share chooser when ACTION_VIEW finds no handler', async () => {
    startActivityAsync.mockRejectedValue(new Error('no activity'))

    await expect(openPreparedFile(PREPARED)).resolves.toBe('shared')
    expect(share).toHaveBeenCalledWith(PREPARED, { dialogTitle: 'Open with' })
  })

  it('reports no_app when neither a content URI nor sharing exists', async () => {
    content.uri = ''
    capabilities.sharing = false

    await expect(openPreparedFile(PREPARED)).rejects.toMatchObject({
      code: 'no_app',
      message: 'No app available for this file type. Use Save to phone instead.'
    })
    expect(share).not.toHaveBeenCalled()
  })

  it('uses the same no-app copy when ACTION_VIEW fails without a share fallback', async () => {
    capabilities.sharing = false
    startActivityAsync.mockRejectedValue(new Error('no activity'))

    await expect(openPreparedFile(PREPARED)).rejects.toMatchObject({
      code: 'no_app',
      message: 'No app available for this file type. Use Save to phone instead.'
    })
  })

  it('uses the share sheet on iOS', async () => {
    platform.os = 'ios'

    await expect(openPreparedFile(PREPARED)).resolves.toBe('shared')
    expect(startActivityAsync).not.toHaveBeenCalled()
  })
})
