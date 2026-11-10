import { describe, expect, it } from 'vitest'
import { truncateMobileFilePreview } from './runtime-file-commands-terminal-artifact-access'
import { MOBILE_FILE_READ_MAX_BYTES } from './runtime-file-commands-mobile-file-list-limit'

/** The exact bytes a file of this size would produce, as one single-byte character each. */
function contentOfBytes(bytes: number): string {
  return 'a'.repeat(bytes)
}

describe('truncateMobileFilePreview', () => {
  it('leaves a file one byte below the cap untouched', () => {
    const bytes = MOBILE_FILE_READ_MAX_BYTES - 1
    const result = truncateMobileFilePreview(contentOfBytes(bytes))

    expect(result.truncated).toBe(false)
    expect(result.byteLength).toBe(bytes)
    expect(result.content).toHaveLength(bytes)
  })

  it('keeps a file exactly at the cap and reports the true byte length', () => {
    const bytes = MOBILE_FILE_READ_MAX_BYTES
    const result = truncateMobileFilePreview(contentOfBytes(bytes))

    expect(result.truncated).toBe(false)
    expect(result.byteLength).toBe(bytes)
    expect(result.content).toHaveLength(bytes)
  })

  it('truncates one byte over the cap', () => {
    const bytes = MOBILE_FILE_READ_MAX_BYTES + 1
    const result = truncateMobileFilePreview(contentOfBytes(bytes))

    expect(result.truncated).toBe(true)
    expect(result.byteLength).toBe(bytes)
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(MOBILE_FILE_READ_MAX_BYTES)
  })

  it('truncates a one-megabyte file to the first 512 KB', () => {
    const bytes = 1024 * 1024
    const result = truncateMobileFilePreview(contentOfBytes(bytes))

    expect(result.truncated).toBe(true)
    expect(result.byteLength).toBe(bytes)
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(MOBILE_FILE_READ_MAX_BYTES)
  })

  it('counts UTF-8 bytes, not characters, at the boundary', () => {
    // A CJK character is three bytes, so a string of this many characters is over the cap well
    // before its character count reaches it.
    const characters = Math.floor(MOBILE_FILE_READ_MAX_BYTES / 3) + 1
    const content = '漢'.repeat(characters)
    const result = truncateMobileFilePreview(content)

    expect(result.truncated).toBe(true)
    expect(result.byteLength).toBe(Buffer.byteLength(content, 'utf8'))
    // The cut lands inside a three-byte character; everything before it is intact.
    expect(result.content.startsWith('漢'.repeat(Math.floor(MOBILE_FILE_READ_MAX_BYTES / 3)))).toBe(
      true
    )
  })
})
