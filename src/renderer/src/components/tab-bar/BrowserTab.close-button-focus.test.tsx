// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTab as BrowserTabState } from '../../../../shared/browser-workspace-types'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import BrowserTab from './BrowserTab'

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn()
  })
}))
vi.mock('./use-tab-strip-slot-props', () => ({
  useTabStripSlotProps: () => ({ className: '', 'data-tab-strip-slot': '' })
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
  DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

const tab: BrowserTabState = {
  id: 'browser-tab-1',
  worktreeId: 'wt-1',
  label: 'Browser 1',
  url: 'https://example.com/',
  title: 'Example',
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 0
}

const dragData: TabDragItemData = {
  kind: 'tab',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  unifiedTabId: 'unified-1',
  visibleTabId: 'browser-tab-1',
  tabType: 'browser',
  label: 'Example'
}

/**
 * Mirrors the real split-group wiring: TabGroupPanel's `onFocusCapture` calls
 * focusGroup, whose store write re-renders (here: remounts) the tab strip inside
 * the same pointer gesture. U159: the halfway-click then lands on a different
 * target, so the close never reaches onClose.
 */
function InactiveSplitGroup({
  focusGroup,
  onClose
}: {
  focusGroup: () => void
  onClose: () => void
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
      <BrowserTab
        key={renderEpoch}
        tab={tab}
        isActive={false}
        isPinned={false}
        hasTabsToRight={false}
        hasTabsToLeft={false}
        tabCount={1}
        onActivate={vi.fn()}
        onClose={onClose}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onCloseToLeft={vi.fn()}
        onTogglePin={vi.fn()}
        dragData={dragData}
      />
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BrowserTab close button in an inactive split group (U159)', () => {
  it('closes on the first click and never takes focus away from the gesture', async () => {
    const user = userEvent.setup()
    const focusGroup = vi.fn()
    const onClose = vi.fn()
    render(<InactiveSplitGroup focusGroup={focusGroup} onClose={onClose} />)
    const closeButton = screen.getByRole('button')

    await user.click(closeButton)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(focusGroup).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(closeButton)
  })

  it('still focuses the group when other tab chrome is clicked', async () => {
    const user = userEvent.setup()
    const focusGroup = vi.fn()
    render(<InactiveSplitGroup focusGroup={focusGroup} onClose={vi.fn()} />)
    const tabRoot = document.querySelector('[data-tab-id="browser-tab-1"]')
    if (!(tabRoot instanceof HTMLElement)) {
      throw new Error('browser tab root not rendered')
    }

    await user.click(tabRoot)

    expect(focusGroup).toHaveBeenCalledTimes(1)
  })
})
