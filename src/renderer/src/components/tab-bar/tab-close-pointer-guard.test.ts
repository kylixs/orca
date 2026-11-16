import { describe, expect, it, vi } from 'vitest'
import { guardTabClosePointerDown, type TabClosePointerGuardEvent } from './tab-close-pointer-guard'

function guardEvent(button: number): TabClosePointerGuardEvent {
  return { button, preventDefault: vi.fn(), stopPropagation: vi.fn() }
}

describe('guardTabClosePointerDown', () => {
  it('cancels the default action and the bubble for the primary button', () => {
    const event = guardEvent(0)

    guardTabClosePointerDown(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('leaves middle and right clicks untouched', () => {
    for (const button of [1, 2]) {
      const event = guardEvent(button)

      guardTabClosePointerDown(event)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(event.stopPropagation).not.toHaveBeenCalled()
    }
  })
})
