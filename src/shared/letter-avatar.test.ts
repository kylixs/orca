import { describe, expect, it } from 'vitest'
import { letterAvatarColor, letterAvatarLetter } from './letter-avatar'

describe('letter avatar identity', () => {
  it('derives the initial from the seed', () => {
    expect(letterAvatarLetter('Cursor')).toBe('C')
    expect(letterAvatarLetter('  zed.dev ')).toBe('Z')
    expect(letterAvatarLetter('')).toBe('?')
  })

  it('derives a stable color from the seed', () => {
    expect(letterAvatarColor('Cursor')).toBe(letterAvatarColor('Cursor'))
    expect(letterAvatarColor('Cursor')).toMatch(/^#[0-9a-f]{6}$/)
  })
})
