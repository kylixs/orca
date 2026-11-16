// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    activeWorktreeId: 'wt-active',
    rightSidebarOpen: true,
    sidebarOpen: true,
    groupsByWorktree: {}
  }
  const tabBarProps: Record<string, unknown>[] = []
  const useAppStore = (selector: (current: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { tabBarProps, useAppStore }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../editor/editor-dropped-file-open', () => ({
  captureEditorFileDropOpen: () => undefined,
  editorGroupStillExists: () => true
}))
vi.mock('../tab-bar/TabBar', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.tabBarProps.push(props)
    return null
  }
}))
vi.mock('../tab-bar/TabBarQuickCommandsButton', () => ({
  TabBarQuickCommandsButton: () => null
}))
vi.mock('@/lib/pane-manager/client-hosted-browser-row-state', () => ({
  useClientHostedBrowserRows: () => []
}))
vi.mock('./useTabGroupWorkspaceModel', () => ({
  useTabGroupWorkspaceModel: () => ({
    activeTab: {
      id: 'unified-term',
      entityId: 'terminal-1',
      contentType: 'terminal'
    },
    agentSessionItems: [],
    browserItems: [],
    commands: { focusGroup: () => undefined },
    editorItems: [],
    tabBarOrder: [],
    terminalTabs: [],
    groupTabs: [],
    expandedPaneByTabId: {}
  })
}))

import TabGroupPanel from './TabGroupPanel'
import { TooltipProvider } from '../ui/tooltip'

function renderPanel(isFocused: boolean): Record<string, unknown> {
  mocks.tabBarProps.length = 0
  render(
    <TooltipProvider>
      <TabGroupPanel
        groupId="group-b"
        worktreeId="wt-b"
        isVisible
        isFocused={isFocused}
        hasSplitGroups
        touchesLeftEdge={false}
        touchesRightEdge={false}
        reserveClosedExplorerToggleSpace={false}
        reserveCollapsedSidebarHeaderSpace={false}
      />
    </TooltipProvider>
  )
  return mocks.tabBarProps.at(-1)!
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TabGroupPanel tab strip active ownership', () => {
  it('marks the focused pane tab active', () => {
    expect(renderPanel(true)).toMatchObject({
      activeTabId: 'terminal-1',
      activeTabType: 'terminal'
    })
  })

  it('does not mark an unfocused split pane tab active (U124)', () => {
    // Why: the pane keeps group.activeTabId for its content, but a second DOM
    // [data-active="true"] makes the worktree-global active tab ambiguous.
    expect(renderPanel(false)).toMatchObject({
      activeTabId: null,
      activeFileId: null,
      activeBrowserTabId: null,
      activeSimulatorTabId: null
    })
  })
})
