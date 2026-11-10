import { describe, expect, it } from 'vitest'
import { flattenDirectoryCache, type DirectoryCache, type MobileDirEntry } from './file-tree'

function entry(name: string, isDirectory = false): MobileDirEntry {
  return { name, isDirectory }
}

describe('lazy-tree category filtering', () => {
  it('keeps ancestors of a match and hides loaded directories with no matches', () => {
    const cache: DirectoryCache = {
      '': {
        entries: [entry('src', true), entry('assets', true), entry('README.md')]
      },
      src: { entries: [entry('app.ts'), entry('notes.txt')] },
      assets: { entries: [entry('logo.png')] }
    }

    const rows = flattenDirectoryCache(cache, new Set(['src', 'assets']), 'code')
    expect(rows.map((row) => row.id)).toEqual(['dir:src', 'file:src/app.ts'])
  })

  it('keeps an unloaded directory and says it is not loaded', () => {
    const cache: DirectoryCache = {
      '': { entries: [entry('src', true), entry('README.md')] }
    }

    const rows = flattenDirectoryCache(cache, new Set(), 'code')
    expect(rows.map((row) => row.id)).toEqual(['dir:src'])
    expect(rows[0]).toMatchObject({ filterNote: 'not loaded' })
  })

  it('keeps a failed or loading directory so it can still be retried', () => {
    const cache: DirectoryCache = {
      '': { entries: [entry('locked', true), entry('loading', true)] },
      locked: { entries: [], error: 'permission denied' },
      loading: { entries: [], loading: true }
    }

    expect(flattenDirectoryCache(cache, new Set(), 'code').map((row) => row.id)).toEqual([
      'dir:loading',
      'dir:locked'
    ])
  })

  it('keeps PDFs out of Code and in Docs', () => {
    const cache: DirectoryCache = {
      '': { entries: [entry('manual.pdf'), entry('app.ts'), entry('logo.png')] }
    }

    expect(flattenDirectoryCache(cache, new Set(), 'docs').map((row) => row.id)).toEqual([
      'file:manual.pdf'
    ])
    expect(flattenDirectoryCache(cache, new Set(), 'images').map((row) => row.id)).toEqual([
      'file:logo.png'
    ])
  })

  it('leaves All identical to the unfiltered tree', () => {
    const cache: DirectoryCache = {
      '': { entries: [entry('src', true), entry('README.md')] },
      src: { entries: [entry('app.ts')] }
    }
    expect(flattenDirectoryCache(cache, new Set(['src']), 'all')).toEqual(
      flattenDirectoryCache(cache, new Set(['src']))
    )
  })
})
