// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorFileTabCloseButton } from './EditorFileTabCloseButton'

vi.mock('./TabCloseTooltip', () => ({
  TabCloseTooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
vi.mock('lucide-react', () => ({
  X: () => <span />
}))

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
      <div data-testid="editor-tab-root" key={renderEpoch}>
        <EditorFileTabCloseButton
          fileIsDirty={false}
          showsSelectionChrome={false}
          onClose={onClose}
        />
      </div>
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('EditorFileTabCloseButton in an inactive split group (U159)', () => {
  it('closes on the first click and never takes focus away from the gesture', async () => {
    const user = userEvent.setup()
    const focusGroup = vi.fn()
    const onClose = vi.fn()
    render(<InactiveSplitGroup focusGroup={focusGroup} onClose={onClose} />)
    const closeButton = screen.getByRole('button', { name: /Close tab/ })

    await user.click(closeButton)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(focusGroup).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(closeButton)
  })

  it('still focuses the group when other tab chrome is clicked', async () => {
    const user = userEvent.setup()
    const focusGroup = vi.fn()
    render(<InactiveSplitGroup focusGroup={focusGroup} onClose={vi.fn()} />)

    await user.click(screen.getByTestId('editor-tab-root'))

    expect(focusGroup).toHaveBeenCalledTimes(1)
  })
})
