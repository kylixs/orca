import { describe, expect, it } from 'vitest'
import { BROWSER_TAB_CREATE_BACKGROUND_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  isPhoneOpenableUrl,
  resolveDirectTerminalLinkAction,
  resolveTerminalLinkRemoteAvailability,
  type TerminalLinkRemoteAvailabilityInput
} from './terminal-link-open-policy'

function availabilityInput(
  overrides: Partial<TerminalLinkRemoteAvailabilityInput> = {}
): TerminalLinkRemoteAvailabilityInput {
  return {
    isFolderWorkspaceRoute: false,
    isFloatingWorkspaceRoute: false,
    client: {},
    connState: 'connected',
    statusReadable: true,
    hostCapabilities: [BROWSER_TAB_CREATE_BACKGROUND_RUNTIME_CAPABILITY],
    creatingBrowser: false,
    ...overrides
  }
}

describe('desktop link action availability', () => {
  it('is available with a live client, readable status and the background capability', () => {
    expect(resolveTerminalLinkRemoteAvailability(availabilityInput())).toEqual({
      available: true,
      hidden: false,
      reason: null,
      hint: null
    })
  })

  it('hides in folder and floating workspaces', () => {
    for (const workspace of [
      { isFolderWorkspaceRoute: true },
      { isFloatingWorkspaceRoute: true }
    ]) {
      expect(resolveTerminalLinkRemoteAvailability(availabilityInput(workspace))).toMatchObject({
        available: false,
        hidden: true,
        reason: 'workspace'
      })
    }
  })

  it('disables while a browser is being created', () => {
    expect(
      resolveTerminalLinkRemoteAvailability(availabilityInput({ creatingBrowser: true }))
    ).toMatchObject({ available: false, hidden: false, reason: 'creating' })
  })

  it('disables offline and when status is unreadable', () => {
    expect(
      resolveTerminalLinkRemoteAvailability(
        availabilityInput({ client: null, connState: 'disconnected' })
      )
    ).toMatchObject({ available: false, reason: 'offline' })
    expect(
      resolveTerminalLinkRemoteAvailability(availabilityInput({ statusReadable: false }))
    ).toMatchObject({ available: false, reason: 'unknown' })
  })

  it('disables on an old host without the background capability', () => {
    const availability = resolveTerminalLinkRemoteAvailability(
      availabilityInput({ hostCapabilities: ['browser.screencast.v1'] })
    )

    expect(availability).toMatchObject({ available: false, reason: 'unsupported' })
    expect(availability.hint).toBe('Update Orca on the host to open links here.')
  })
})

describe('stored link preference as a direct-open decision', () => {
  const available = resolveTerminalLinkRemoteAvailability(availabilityInput())
  const unavailable = resolveTerminalLinkRemoteAvailability(
    availabilityInput({ statusReadable: false })
  )

  it('asks when the stored mode is ask', () => {
    expect(resolveDirectTerminalLinkAction('ask', 'https://example.com', available)).toBeNull()
  })

  it('opens directly when the stored action still passes today’s gates', () => {
    expect(
      resolveDirectTerminalLinkAction('phone-browser', 'https://example.com', unavailable)
    ).toBe('phone-browser')
    expect(resolveDirectTerminalLinkAction('orca-browser', 'https://example.com', available)).toBe(
      'orca-browser'
    )
  })

  it('falls back to the sheet without downgrading a stored remote choice', () => {
    expect(
      resolveDirectTerminalLinkAction('orca-browser', 'https://example.com', unavailable)
    ).toBeNull()
  })

  it('will not hand a non-web URL to the phone browser', () => {
    expect(isPhoneOpenableUrl('mailto:a@b.com')).toBe(false)
    expect(isPhoneOpenableUrl('custom://thing')).toBe(false)
    expect(resolveDirectTerminalLinkAction('phone-browser', 'custom://thing', available)).toBeNull()
  })
})
