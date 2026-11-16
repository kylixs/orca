export type WebCloudWorkspaceBootstrapPhase =
  | 'idle'
  | 'loading'
  | 'registering'
  | 'ensuring'
  | 'activating'
  | 'done'
  | 'fallback'

export type WebCloudWorkspaceBootstrapStatus = {
  phase: WebCloudWorkspaceBootstrapPhase
  /** Why no workspace view came up; set with `fallback` only. */
  fallbackReason: 'unsupported-host' | 'unavailable' | 'failed' | null
  fallbackDetail: string | null
  /** Only a `failed` fallback is worth retrying: the ensure flow is idempotent. */
  retryable: boolean
  /** The ticket grants `open` but not `terminal`: the repo row is up, no workspace opens. */
  terminalNotGranted: boolean
}

export const IDLE: WebCloudWorkspaceBootstrapStatus = {
  phase: 'idle',
  fallbackReason: null,
  fallbackDetail: null,
  retryable: false,
  terminalNotGranted: false
}
