import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRestoredActiveReassertForTests,
  reassertRestoredActiveTab
} from './restored-active-reassert'

let mutationSequence = 0

function args(overrides: Partial<Parameters<typeof reassertRestoredActiveTab>[0]> = {}) {
  mutationSequence += 1
  return {
    mutationId: `mutation-${mutationSequence}`,
    restoredLocalTabId: 'web-terminal-f5ff',
    hostActiveLocalTabId: 'web-terminal-7ad5',
    hostActiveTabId: '7ad5::leaf',
    localTabIds: new Set(['web-terminal-f5ff', 'web-terminal-7ad5']),
    hasPendingUserFocusIntent: false,
    applyLocalActive: vi.fn(),
    activate: vi.fn(async () => true),
    ...overrides
  }
}

beforeEach(() => {
  resetRestoredActiveReassertForTests()
})

describe('restored active re-assert (U138 phase 3/5)', () => {
  it('writes the restored active back to the host once when it differs', async () => {
    const call = args()
    await expect(reassertRestoredActiveTab(call)).resolves.toBe(true)
    expect(call.applyLocalActive).toHaveBeenCalledExactlyOnceWith('web-terminal-f5ff')
    expect(call.activate).toHaveBeenCalledExactlyOnceWith('web-terminal-f5ff')
  })

  it('writes nothing when the restored active already matches the host', async () => {
    const call = args({ hostActiveLocalTabId: 'web-terminal-f5ff' })
    await expect(reassertRestoredActiveTab(call)).resolves.toBe(false)
    expect(call.applyLocalActive).not.toHaveBeenCalled()
    expect(call.activate).not.toHaveBeenCalled()
  })

  it('never overrides a user gesture that already reached the host', async () => {
    const call = args({ hasPendingUserFocusIntent: true })
    await expect(reassertRestoredActiveTab(call)).resolves.toBe(false)
    expect(call.activate).not.toHaveBeenCalled()
  })

  it('stays silent when the host active tab is not mirrored or the restored tab is gone', async () => {
    await expect(reassertRestoredActiveTab(args({ hostActiveLocalTabId: null }))).resolves.toBe(
      false
    )
    await expect(reassertRestoredActiveTab(args({ hostActiveTabId: null }))).resolves.toBe(false)
    await expect(
      reassertRestoredActiveTab(args({ localTabIds: new Set(['web-terminal-7ad5']) }))
    ).resolves.toBe(false)
    await expect(reassertRestoredActiveTab(args({ restoredLocalTabId: null }))).resolves.toBe(false)
  })

  it('keeps the host answer authoritative: a refused activate never overrides local', async () => {
    const call = args({ activate: vi.fn(async () => false) })
    await expect(reassertRestoredActiveTab(call)).resolves.toBe(false)
    expect(call.applyLocalActive).not.toHaveBeenCalled()
  })

  it('consumes its mutation id so one entry cannot write back twice', async () => {
    const first = args()
    await expect(reassertRestoredActiveTab(first)).resolves.toBe(true)

    const second = args({ mutationId: first.mutationId })
    await expect(reassertRestoredActiveTab(second)).resolves.toBe(false)
    expect(second.activate).not.toHaveBeenCalled()
    expect(second.applyLocalActive).not.toHaveBeenCalled()
  })
})
