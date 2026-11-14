// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SidebarCloudSessionEmptyState } from './CloudSessionEmptyState'

describe('SidebarCloudSessionEmptyState', () => {
  afterEach(() => cleanup())

  it('explains the cloud scope instead of the native empty list', () => {
    render(<SidebarCloudSessionEmptyState />)
    expect(screen.getByText('Cloud project session')).toBeTruthy()
    expect(
      screen.getByText(
        'This browser session is scoped to the project opened from the cloud platform. The desktop project catalog is not part of a cloud session.'
      )
    ).toBeTruthy()
    // Same list landmarks the native empty state carries, so tours keep working.
    expect(document.querySelector('[data-worktree-sidebar-container]')).not.toBeNull()
    expect(document.querySelector('[data-contextual-tour-target="workspace-list"]')).not.toBeNull()
    // The native "no workspaces" copy never shows for a cloud session.
    expect(screen.queryByText('No workspaces found')).toBeNull()
  })
})
