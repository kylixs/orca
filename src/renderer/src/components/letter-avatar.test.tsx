import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { letterAvatarColor } from '../../../shared/letter-avatar'
import { LetterAvatar } from './letter-avatar'

describe('LetterAvatar', () => {
  it('renders a stable initial and hashed color', () => {
    const first = renderToStaticMarkup(<LetterAvatar name="Cursor" size={16} />)
    const second = renderToStaticMarkup(<LetterAvatar name="Cursor" size={16} />)

    expect(first).toBe(second)
    expect(first).toContain('>C</text>')
    expect(first).toContain(letterAvatarColor('Cursor'))
  })
})
