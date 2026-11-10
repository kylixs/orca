import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-file-system', () => ({
  Directory: class {},
  File: class {},
  Paths: { cache: '' }
}))

import {
  clearDownloadCache,
  DOWNLOAD_CACHE_MAX_BYTES,
  DOWNLOAD_CACHE_RETENTION_MS,
  enforceDownloadCacheLimit,
  planDownloadCacheEviction,
  subscribeDownloadCacheInvalidation
} from './mobile-file-download-cache'

const NOW = 1_000_000_000

describe('download cache eviction', () => {
  it('removes incomplete prepares and entries past 24 hours', () => {
    expect(
      planDownloadCacheEviction(
        [
          { directoryName: 'partial', size: 0, usedAt: NOW, complete: false },
          {
            directoryName: 'old',
            size: 10,
            usedAt: NOW - DOWNLOAD_CACHE_RETENTION_MS - 1,
            complete: true
          },
          { directoryName: 'fresh', size: 10, usedAt: NOW - 1000, complete: true }
        ],
        {
          maxBytes: DOWNLOAD_CACHE_MAX_BYTES,
          retentionMs: DOWNLOAD_CACHE_RETENTION_MS,
          now: NOW
        }
      )
    ).toEqual(['partial', 'old'])
  })

  it('evicts the least recently used entries until under 512 MB', () => {
    const entries = [
      { directoryName: 'oldest', size: 200, usedAt: NOW - 3000, complete: true },
      { directoryName: 'middle', size: 200, usedAt: NOW - 2000, complete: true },
      { directoryName: 'newest', size: 200, usedAt: NOW - 1000, complete: true }
    ]
    expect(
      planDownloadCacheEviction(entries, {
        maxBytes: 300,
        retentionMs: DOWNLOAD_CACHE_RETENTION_MS,
        now: NOW
      })
    ).toEqual(['oldest', 'middle'])
  })

  it('evicts the only entry when it alone exceeds the cap', () => {
    expect(
      planDownloadCacheEviction(
        [{ directoryName: 'newest', size: 900, usedAt: NOW - 1, complete: true }],
        { maxBytes: 400, retentionMs: DOWNLOAD_CACHE_RETENTION_MS, now: NOW }
      )
    ).toEqual(['newest'])
  })

  it('tells prepared tasks when the cache is cleared or trimmed', () => {
    const invalidated = vi.fn()
    const unsubscribe = subscribeDownloadCacheInvalidation(invalidated)

    clearDownloadCache()
    enforceDownloadCacheLimit(NOW)

    expect(invalidated).toHaveBeenNthCalledWith(1, null)
    expect(invalidated).toHaveBeenNthCalledWith(2, new Set())
    unsubscribe()
  })
})
