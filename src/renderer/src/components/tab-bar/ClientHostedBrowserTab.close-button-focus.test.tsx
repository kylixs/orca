// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'
import ClientHostedBrowserTab from './ClientHostedBrowserTab'

vi.mock('./TabHoverCard', () => ({
  TabHoverCard: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
vi.mock('./use-tab-strip-slot-props', () => ({
  useTabStripSlotProps: () => ({ className: '', 'data-tab-strip-slot': '' })
}))
vi.mock('lucide-react', () => ({
  Laptop: () => <span />,
  Loader2: () => <span />,
  X: () => <span />
}))

const row: ClientHostedBrowserRow = {
  browserPageId: 'page-1',
  worktreeId: 'wt-1',
  url: 'https://example.test/page-1',
  title: 'Marker',
  loading: false,
  browserHostClientId: 'host-a',
  hostDeviceName: 'Studio',
  hostAbsent: false
}

/**
 * Mirrors the real split-group wiring: TabGroupPanel's `onFocusCapture` calls focusGroup, whose
 * store write re-renders (here: remounts) the strip inside the same pointer gesture, and the row's
 * own `onActivate` does the same. U160: a focused close button lets that re-render swallow the click.
 */
function InactiveHostedGroup({
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
      <ClientHostedBrowserTab
        key={renderEpoch}
        row={row}
        isActive={false}
        hasTabsToRight={false}
        onActivate={handleGroupFocus}
        onClose={onClose}
      />
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ClientHostedBrowserTab close button in an inactive split group (U160)', () => {
  it('closes on the first click and never takes focus away from the gesture', async () => {
    const user = userEvent.setup()
    const focusGroup = vi.fn()
    const onClose = vi.fn()
    render(<InactiveHostedGroup focusGroup={focusGroup} onClose={onClose} />)
    const closeButton = screen.getByRole('button', { name: 'Close hosted page' })

    await user.click(closeButton)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(focusGroup).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(closeButton)
  })
})
