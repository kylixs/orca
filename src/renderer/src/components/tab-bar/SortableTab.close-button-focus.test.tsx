// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import SortableTab from './SortableTab'

const mocks = vi.hoisted(() => {
  const storeState = {
    unreadTerminalTabs: {},
    unreadAgentCompletionPanes: {},
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    keybindings: {}
  }
  const useAppStore = (selector: (state: typeof storeState) => unknown): unknown => selector(storeState)
  useAppStore.getState = () => storeState
  return { useAppStore }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn()
  })
}))
vi.mock('@/lib/use-tab-agent', () => ({ useTabAgent: () => null }))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => <span />,
  getAgentLabel: (agent: string) => agent
}))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: () => null,
  DropdownMenuItem: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => null,
  DropdownMenuShortcut: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DropdownMenuLabel: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DropdownMenuSub: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DropdownMenuSubContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DropdownMenuSubTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />
}))
vi.mock('./TerminalTabLeadingIcon', () => ({ TerminalTabLeadingIcon: () => <span /> }))
vi.mock('./shell-icons', () => ({ ShellIcon: () => <span /> }))
vi.mock('../sidebar/WorktreeCardHelpers', () => ({ FilledBellIcon: () => <span /> }))

const tab = {
  id: 'terminal-tab-1',
  title: 'Terminal 1',
  worktreeId: 'wt-1'
} as TerminalTab

const dragData: TabDragItemData = {
  kind: 'tab',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  unifiedTabId: 'unified-1',
  visibleTabId: 'terminal-tab-1',
  tabType: 'terminal',
  label: 'Terminal 1'
}

/**
 * Mirrors the real split-group wiring: TabGroupPanel's `onFocusCapture` calls
 * focusGroup, whose store write re-renders (here: remounts) the tab strip inside
 * the same pointer gesture. U158: the halfway-click then lands on a different
 * target, so the close never reaches onClose.
 */
function InactiveSplitGroup({
  focusGroup,
  onClose,
  isExpanded = false,
  onToggleExpand = vi.fn()
}: {
  focusGroup: () => void
  onClose: (tabId: string) => void
  isExpanded?: boolean
  onToggleExpand?: (tabId: string) => void
}): React.JSX.Element {
  const [renderEpoch, setRenderEpoch] = useState(0)
  const handleGroupFocus = (): void => {
    focusGroup()
    setRenderEpoch((epoch) => epoch + 1)
  }
  return (
    <div
      data-testid="inactive-group"
      onPointerDown={handleGroupFocus}
      onFocusCapture={handleGroupFocus}
    >
      <SortableTab
        key={renderEpoch}
        tab={tab}
        unifiedTabId="unified-1"
        groupId="group-1"
        tabCount={1}
        hasTabsToRight={false}
        hasTabsToLeft={false}
        isActive={false}
        isPinned={false}
        isExpanded={isExpanded}
        onActivate={vi.fn()}
        onClose={onClose}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onCloseToLeft={vi.fn()}
        onSetCustomTitle={vi.fn()}
        onSetTabColor={vi.fn()}
        onTogglePin={vi.fn()}
        onToggleExpand={onToggleExpand}
        dragData={dragData}
      />
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SortableTab close button in an inactive split group (U158)', () => {
  it('closes on the first click and never takes focus away from the gesture', async () => {
    const user = userEvent.setup()
    const focusGroup = vi.fn()
    const onClose = vi.fn()
    render(<InactiveSplitGroup focusGroup={focusGroup} onClose={onClose} />)
    const closeButton = screen.getByRole('button', { name: /Close tab/ })

    await user.click(closeButton)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('terminal-tab-1')
    // The group-level onFocusCapture must not steal the gesture.
    expect(focusGroup).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(closeButton)
  })

  it('still focuses the group when other tab chrome is clicked', async () => {
    const user = userEvent.setup()
    const focusGroup = vi.fn()
    render(<InactiveSplitGroup focusGroup={focusGroup} onClose={vi.fn()} />)

    await user.click(screen.getByTestId('sortable-tab'))

    expect(focusGroup).toHaveBeenCalledTimes(1)
  })
})

describe('SortableTab collapse button in an inactive split group (U159)', () => {
  it('collapses on the first click without stealing the group gesture', async () => {
    const user = userEvent.setup()
    const focusGroup = vi.fn()
    const onToggleExpand = vi.fn()
    render(
      <InactiveSplitGroup
        focusGroup={focusGroup}
        onClose={vi.fn()}
        isExpanded
        onToggleExpand={onToggleExpand}
      />
    )
    const collapseButton = screen.getByRole('button', { name: /Collapse pane/ })

    await user.click(collapseButton)

    // Why: the production callback activates/focuses the group itself; the pin is
    // that TabGroupPanel's onFocusCapture does not fire first and eat the click.
    expect(onToggleExpand).toHaveBeenCalledTimes(1)
    expect(onToggleExpand).toHaveBeenCalledWith('terminal-tab-1')
    expect(focusGroup).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(collapseButton)
  })
})
