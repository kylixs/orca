import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View'
}))
vi.mock('../theme/mobile-theme', () => ({
  colors: { textSecondary: '#999' }
}))
vi.mock('./mobile-file-explorer-styles', () => ({ fileExplorerStyles: {} }))

import { mobileFileSearchNote } from './MobileFileSearchResults'
import type { MobileFileSearchState } from './use-mobile-file-search'

function state(overrides: Partial<MobileFileSearchState>): MobileFileSearchState {
  return {
    status: 'ready',
    results: [],
    totalCount: 0,
    truncated: false,
    libraryTruncated: false,
    legacyFallback: false,
    error: null,
    ...overrides
  }
}

const results = Array.from({ length: 32 }, (_, index) => ({
  relativePath: `src/app-${index}.ts`,
  basename: `app-${index}.ts`,
  kind: 'text' as const
}))

describe('mobileFileSearchNote', () => {
  it('reports a capped new-host result against totalCount', () => {
    expect(
      mobileFileSearchNote(state({ results, totalCount: 148, truncated: true }), 'all', 32)
    ).toBe('Showing first 32 of 148 matches')
  })

  it('says filtering only touched the first 32 fetched results', () => {
    expect(
      mobileFileSearchNote(state({ results, totalCount: 148, truncated: true }), 'code', 12)
    ).toBe('Showing first 32 of 148 matches Filters apply to these first 32 results only.')
  })

  it('never calls the legacy capped list complete', () => {
    expect(
      mobileFileSearchNote(
        state({
          results: results.slice(0, 2),
          totalCount: 2,
          truncated: true,
          libraryTruncated: true,
          legacyFallback: true
        }),
        'all',
        2
      )
    ).toBe('Showing first 5000; results may be incomplete')
  })

  it('reports the real legacy match total even when only 32 are shown', () => {
    expect(
      mobileFileSearchNote(
        state({
          results,
          totalCount: 100,
          truncated: true,
          legacyFallback: true
        }),
        'all',
        32
      )
    ).toBe('Showing first 32 of 100 matches')
  })

  it('does not read a truncated new-host library as a complete result set', () => {
    const note = mobileFileSearchNote(
      state({
        results: results.slice(0, 3),
        totalCount: 3,
        truncated: true,
        libraryTruncated: true
      }),
      'all',
      3
    )
    expect(note).toBe('3 matches File library exceeds 20,000 files; results may be incomplete.')
    expect(note).not.toContain('Showing first 3 of 3')
  })

  it('reports an uncapped result as a plain match count', () => {
    expect(
      mobileFileSearchNote(
        state({
          results: results.slice(0, 2),
          totalCount: 2,
          legacyFallback: true
        }),
        'all',
        2
      )
    ).toBe('Showing 2 of 2 matches')
  })
})
