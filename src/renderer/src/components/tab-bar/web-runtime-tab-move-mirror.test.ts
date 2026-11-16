import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mirrorWebRuntimeTabMove } from './web-runtime-tab-move-mirror'

const mocks = vi.hoisted(() => ({
  moveWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('../../runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive,
  moveWebRuntimeSessionTab: mocks.moveWebRuntimeSessionTab
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'env-1'
}))

vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({}) }
}))

describe('mirrorWebRuntimeTabMove', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
  })

  it('surfaces a host refusal as a failure toast', async () => {
    mocks.moveWebRuntimeSessionTab.mockResolvedValue(false)

    await expect(
      mirrorWebRuntimeTabMove({
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        targetGroupId: 'group-gone',
        kind: 'move-to-group'
      })
    ).resolves.toBe(false)

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('stays silent when the host applied the move', async () => {
    mocks.moveWebRuntimeSessionTab.mockResolvedValue(true)

    await expect(
      mirrorWebRuntimeTabMove({
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        targetGroupId: 'group-2',
        kind: 'move-to-group'
      })
    ).resolves.toBe(true)

    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('does not toast when no web runtime owns the worktree', async () => {
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)

    await expect(
      mirrorWebRuntimeTabMove({
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        targetGroupId: 'group-2',
        kind: 'move-to-group'
      })
    ).resolves.toBe(false)

    expect(mocks.moveWebRuntimeSessionTab).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
