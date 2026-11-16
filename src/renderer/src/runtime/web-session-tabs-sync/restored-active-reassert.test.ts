import { describe, expect, it, vi } from 'vitest'
import { reassertRestoredActiveTab } from './restored-active-reassert'

function args(overrides: Partial<Parameters<typeof reassertRestoredActiveTab>[0]> = {}) {
  return {
    restoredLocalTabId: 'web-terminal-f5ff',
    hostActiveLocalTabId: 'web-terminal-7ad5',
    hostActiveTabId: '7ad5::leaf',
    localTabIds: new Set(['web-terminal-f5ff', 'web-terminal-7ad5']),
    hasPendingUserFocusIntent: false,
    applyLocalActive: vi.fn(),
    activate: vi.fn(),
    ...overrides
  }
}

describe('restored active re-assert (U138 phase 3)', () => {
  it('writes the restored active back to the host once when it differs', () => {
    const call = args()
    expect(reassertRestoredActiveTab(call)).toBe(true)
    expect(call.applyLocalActive).toHaveBeenCalledExactlyOnceWith('web-terminal-f5ff')
    expect(call.activate).toHaveBeenCalledExactlyOnceWith('web-terminal-f5ff')
  })

  it('writes nothing when the restored active already matches the host', () => {
    const call = args({ hostActiveLocalTabId: 'web-terminal-f5ff' })
    expect(reassertRestoredActiveTab(call)).toBe(false)
    expect(call.applyLocalActive).not.toHaveBeenCalled()
    expect(call.activate).not.toHaveBeenCalled()
  })

  it('never overrides a user gesture that already reached the host', () => {
    const call = args({ hasPendingUserFocusIntent: true })
    expect(reassertRestoredActiveTab(call)).toBe(false)
    expect(call.activate).not.toHaveBeenCalled()
  })

  it('stays silent when the host active tab is not mirrored or the restored tab is gone', () => {
    expect(reassertRestoredActiveTab(args({ hostActiveLocalTabId: null }))).toBe(false)
    expect(reassertRestoredActiveTab(args({ hostActiveTabId: null }))).toBe(false)
    expect(reassertRestoredActiveTab(args({ localTabIds: new Set(['web-terminal-7ad5']) }))).toBe(
      false
    )
    expect(reassertRestoredActiveTab(args({ restoredLocalTabId: null }))).toBe(false)
  })
})
