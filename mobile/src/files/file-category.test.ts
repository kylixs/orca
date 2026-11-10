import { describe, expect, it } from 'vitest'
import { fileCategoryForPath, matchesFileCategory, MOBILE_FILE_CATEGORIES } from './file-category'

describe('file categories', () => {
  it('shows All, Code, Docs, Media, Images, Other in that order', () => {
    expect(MOBILE_FILE_CATEGORIES).toEqual(['all', 'code', 'docs', 'media', 'images', 'other'])
  })

  it.each([
    ['src/app.ts', 'code'],
    ['src/app.tsx', 'code'],
    ['tools/run.py', 'code'],
    ['README.md', 'docs'],
    ['notes.txt', 'docs'],
    ['manual.pdf', 'docs'],
    ['song.mp3', 'media'],
    ['clip.mp4', 'media'],
    ['logo.png', 'images'],
    ['logo.svg', 'images'],
    ['archive.zip', 'other'],
    ['Makefile', 'other']
  ])('%s is %s', (path, category) => {
    expect(fileCategoryForPath(path)).toBe(category)
  })

  it('applies the category as a filter', () => {
    expect(matchesFileCategory('docs/manual.pdf', 'docs')).toBe(true)
    expect(matchesFileCategory('docs/manual.pdf', 'code')).toBe(false)
    expect(matchesFileCategory('anything', 'all')).toBe(true)
  })
})
