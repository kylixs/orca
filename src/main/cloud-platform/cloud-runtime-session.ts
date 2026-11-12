import type { CloudSessionService } from './cloud-session-service'

/**
 * The one cloud session the app is signed in with. Panes reach it through the
 * environment transport, which has no IPC context of its own.
 */
let active: CloudSessionService | null = null

export function setActiveCloudSession(session: CloudSessionService | null): void {
  active = session
}

export function activeCloudSession(): CloudSessionService | null {
  return active
}
