/**
 * What an agent client needs to reach the control plane. Enrolled-host mode
 * (heartbeat) is the normal path; the internal routes serve hosts that never
 * enrolled, and tests inject `fetchImpl`/`now`.
 */

export type CloudAgentConfig = {
  /** Public API base, used for /v1/jwks. */
  apiUrl: string
  /** Control-plane base; https here means the requests go over mTLS. */
  internalUrl?: string
  /** Bearer token for /v1/internal/*. */
  internalToken: string
  hostId: string
  hostName: string
  refreshMs?: number
  /** Per-request timeout; a hung platform must not stall the loop. */
  timeoutMs?: number
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number
  /** How long signing keys stay usable without a successful refetch. */
  keysTtlMs?: number
  /** Design §8.4 caps; overrides exist for tests, production uses the defaults. */
  maxSessionsPerUserProject?: number
  maxSessionsPerHost?: number
  /**
   * Enrolled-host mode: revocations and policy come from the heartbeat response
   * instead of `/v1/internal/*`. This is the normal path for a registered host;
   * the internal routes exist for hosts that never enrolled.
   */
  heartbeat?: {
    hostId: string
    credential: string
    /**
     * Addresses reported on every beat so the platform sees the port the runtime
     * actually bound, not one guessed before it listened.
     */
    directAddrs?: string[] | (() => string[])
    /** Reported so the platform can hand the host key to clients with the ticket. */
    e2eePublicKeyB64?: () => string | null
    /** Parent directory for self-service projects; absent means the host opts out. */
    projectsRoot?: string
  }
}
