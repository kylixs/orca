import { BROWSER_TAB_CREATE_BACKGROUND_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { ConnectionState } from '../transport/types'
import type { MobileTerminalLinkOpenMode } from '../storage/preferences'

export type TerminalLinkRemoteUnavailableReason =
  | 'workspace'
  | 'offline'
  | 'unknown'
  | 'creating'
  | 'unsupported'

/** Shared by the sheet's disabled hint and the action's own refusal toast, so the two cannot drift. */
export const TERMINAL_LINK_REMOTE_WORKSPACE_HINT = 'Desktop links can only open from a worktree.'
export const TERMINAL_LINK_REMOTE_OFFLINE_HINT = 'Connect to the desktop to open links there.'
export const TERMINAL_LINK_REMOTE_UNKNOWN_HINT =
  'Desktop capability unknown. Reconnect and try again.'
export const TERMINAL_LINK_REMOTE_CREATING_HINT = 'A browser tab is already opening.'
export const TERMINAL_LINK_REMOTE_UNSUPPORTED_HINT = 'Update Orca on the host to open links here.'

export type TerminalLinkRemoteAvailability =
  | { available: true; hidden: false; reason: null; hint: null }
  | {
      available: false
      hidden: boolean
      reason: TerminalLinkRemoteUnavailableReason
      hint: string | null
    }

export type TerminalLinkRemoteAvailabilityInput = {
  isFolderWorkspaceRoute: boolean
  isFloatingWorkspaceRoute: boolean
  client: object | null
  connState: ConnectionState
  statusReadable: boolean
  hostCapabilities: readonly string[]
  creatingBrowser: boolean
}

/**
 * Whether the desktop action can run right now.
 *
 * Folder and floating workspaces hide it outright: neither has a worktree `browser.tabCreate`
 * resolves. Every other refusal disables it with a hint, so a tap never looks like it opened
 * something on the desktop.
 */
export function resolveTerminalLinkRemoteAvailability(
  input: TerminalLinkRemoteAvailabilityInput
): TerminalLinkRemoteAvailability {
  if (input.isFolderWorkspaceRoute || input.isFloatingWorkspaceRoute) {
    return { available: false, hidden: true, reason: 'workspace', hint: null }
  }
  if (input.creatingBrowser) {
    return {
      available: false,
      hidden: false,
      reason: 'creating',
      hint: TERMINAL_LINK_REMOTE_CREATING_HINT
    }
  }
  if (!input.client || input.connState !== 'connected') {
    return {
      available: false,
      hidden: false,
      reason: 'offline',
      hint: TERMINAL_LINK_REMOTE_OFFLINE_HINT
    }
  }
  if (!input.statusReadable) {
    return {
      available: false,
      hidden: false,
      reason: 'unknown',
      hint: TERMINAL_LINK_REMOTE_UNKNOWN_HINT
    }
  }
  if (!input.hostCapabilities.includes(BROWSER_TAB_CREATE_BACKGROUND_RUNTIME_CAPABILITY)) {
    return {
      available: false,
      hidden: false,
      reason: 'unsupported',
      hint: TERMINAL_LINK_REMOTE_UNSUPPORTED_HINT
    }
  }
  return { available: true, hidden: false, reason: null, hint: null }
}

export function isPhoneOpenableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The stored preference only skips the sheet when its action still passes today's gates.
 *
 * A remembered remote choice is not downgraded when the host cannot take it: the sheet opens with
 * the remote action disabled, and the stored value survives so a recovered host opens directly.
 */
export function resolveDirectTerminalLinkAction(
  mode: MobileTerminalLinkOpenMode,
  url: string,
  remote: TerminalLinkRemoteAvailability
): Exclude<MobileTerminalLinkOpenMode, 'ask'> | null {
  if (mode === 'phone-browser') {
    return isPhoneOpenableUrl(url) ? 'phone-browser' : null
  }
  if (mode === 'orca-browser') {
    return remote.available ? 'orca-browser' : null
  }
  return null
}
