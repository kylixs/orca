import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MIME_TYPE,
  DEFAULT_UTI,
  extensionOfFileName,
  mimeTypeForFileName,
  safeLocalFileName,
  uniqueLocalFileName,
  utiForFileName
} from './file-download-naming'

describe('safeLocalFileName', () => {
  it('strips paths, traversal and control characters', () => {
    expect(safeLocalFileName('../../etc/passwd')).toBe('passwd')
    expect(safeLocalFileName('a/b\\c.txt')).toBe('c.txt')
    expect(safeLocalFileName('bad\u0000name\u001f.txt')).toBe('badname.txt')
    expect(safeLocalFileName('..')).toBe('file')
    expect(safeLocalFileName('')).toBe('file')
  })

  it('removes Unicode bidi overrides that can disguise an extension', () => {
    expect(safeLocalFileName('invoice\u202etxt.exe')).toBe('invoicetxt.exe')
  })

  it('keeps dotfiles and names without an extension intact', () => {
    expect(safeLocalFileName('.env')).toBe('.env')
    expect(safeLocalFileName('Makefile')).toBe('Makefile')
  })

  it('byte-truncates to 255 while keeping a short extension', () => {
    const name = safeLocalFileName(`${'a'.repeat(300)}.ts`)
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255)
    expect(name.endsWith('.ts')).toBe(true)
  })

  it('does not split a multi-byte character at the cap', () => {
    const name = safeLocalFileName('汉'.repeat(100))
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255)
    expect(name).not.toContain('\uFFFD')
  })
})

describe('MIME and UTI mapping', () => {
  it.each([
    ['a.png', 'image/png', 'public.png'],
    ['a.jpg', 'image/jpeg', 'public.jpeg'],
    ['a.jpeg', 'image/jpeg', 'public.jpeg'],
    ['a.gif', 'image/gif', 'com.compuserve.gif'],
    ['a.webp', 'image/webp', 'org.webmproject.webp'],
    ['a.pdf', 'application/pdf', 'com.adobe.pdf'],
    ['a.zip', 'application/zip', 'public.zip-archive'],
    ['a.mp4', 'video/mp4', 'public.mpeg-4'],
    ['a.mp3', 'audio/mpeg', 'public.mp3'],
    ['a.md', 'text/plain', 'public.plain-text'],
    ['a.tsx', 'text/plain', 'public.plain-text'],
    ['a.html', 'text/html', 'public.plain-text']
  ])('%s maps to its declared type', (name, mime, uti) => {
    expect(mimeTypeForFileName(name)).toBe(mime)
    expect(utiForFileName(name)).toBe(uti)
  })

  it('falls back for unknown and extensionless names', () => {
    expect(mimeTypeForFileName('archive.bin')).toBe(DEFAULT_MIME_TYPE)
    expect(utiForFileName('archive.bin')).toBe(DEFAULT_UTI)
    expect(mimeTypeForFileName('Makefile')).toBe(DEFAULT_MIME_TYPE)
  })

  it('treats a leading dot as a dotfile rather than an extension', () => {
    expect(extensionOfFileName('.env')).toBe('')
  })
})

describe('uniqueLocalFileName', () => {
  it('appends a counter before the extension, preserving it', () => {
    expect(uniqueLocalFileName('report.pdf', [])).toBe('report.pdf')
    expect(uniqueLocalFileName('report.pdf', ['report.pdf'])).toBe('report (1).pdf')
    expect(uniqueLocalFileName('report.pdf', ['report.pdf', 'report (1).pdf'])).toBe(
      'report (2).pdf'
    )
  })

  it('compares names case-insensitively and handles extensionless files', () => {
    expect(uniqueLocalFileName('README', ['readme'])).toBe('README (1)')
  })
})
