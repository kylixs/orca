// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const appStore = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('../store', () => ({
  useAppStore: { getState: () => appStore.state }
}))

import { defaultWebCloudWorkspacePorts } from './web-cloud-workspace-store-ports'

const WORKTREE_ID = 'repo_1::/srv/work/payment-service/.orca-worktrees/zhangsan/main'
const EXECUTION_HOST_ID = 'runtime:web-bootstrap-env'

function seedStore(tabsByWorktree: Record<string, unknown>): void {
  appStore.state = {
    activeView: 'editor',
    tabsByWorktree,
    rightSidebarOpen: false,
    rightSidebarTab: 'files',
    setActiveView: vi.fn(),
    setActiveWorktree: vi.fn(),
    createTab: vi.fn(() => ({ id: 'seeded-tab' })),
    setActiveTab: vi.fn(),
    setRightSidebarTab: vi.fn(),
    setRightSidebarOpen: vi.fn()
  }
}

function activate(): void {
  defaultWebCloudWorkspacePorts().activateWorkspace({
    worktreeId: WORKTREE_ID,
    executionHostId: EXECUTION_HOST_ID,
    mountExplorer: false
  })
}

describe('cloud workspace fallback seeding', () => {
  beforeEach(() => {
    seedStore({})
  })

  it('does not seed when the restored inventory already populated the worktree', () => {
    seedStore({ [WORKTREE_ID]: [{ id: 'restored-tab' }] })

    activate()

    expect(appStore.state.createTab).not.toHaveBeenCalled()
    expect(appStore.state.setActiveTab).not.toHaveBeenCalled()
    expect(appStore.state.setActiveWorktree).toHaveBeenCalledWith(
      WORKTREE_ID,
      EXECUTION_HOST_ID
    )
  })

  it('seeds exactly one fallback tab when the inventory left the worktree empty', () => {
    activate()

    expect(appStore.state.createTab).toHaveBeenCalledTimes(1)
    expect(appStore.state.createTab).toHaveBeenCalledWith(WORKTREE_ID)
    expect(appStore.state.setActiveTab).toHaveBeenCalledWith('seeded-tab')
  })
})
