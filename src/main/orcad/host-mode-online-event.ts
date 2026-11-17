/**
 * U181 §8 H8b `orca_host_online`: one structured line per non-online → online
 * transition. Log-only; install scripts still judge success by the state file.
 */
export type HostOnlineEventInput = {
  hostId: string | null
  platformUrl: string | null
  lastHeartbeatAt: number | null
}

/** Strictly four fields; never a credential, token, or error detail. */
export function formatHostModeOnlineEvent(input: HostOnlineEventInput): string {
  return JSON.stringify({
    event: 'orca_host_online',
    hostId: input.hostId,
    platformUrl: input.platformUrl,
    lastHeartbeatAt: input.lastHeartbeatAt
  })
}

/** One line per non-online → online transition; a repeated online persist is silent. */
export function emitHostModeOnlineEvent(
  previous: { status: string } | null | undefined,
  next: HostOnlineEventInput & { status: string }
): void {
  if (next.status !== 'online' || previous?.status === 'online') {
    return
  }
  console.log(formatHostModeOnlineEvent(next))
}
