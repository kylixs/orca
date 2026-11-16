import type { CloudSubscribeOutcome, CloudSubscriptionCallbacks } from './use-cloud-session'

/** Shared by the panel and its stream hook; kept out of both files' line budgets. */

export type CloudPanelState =
  | { kind: 'booting' }
  | { kind: 'live' }
  | { kind: 'reconnecting'; code: string | null }
  | { kind: 'failed'; code: string }
  /** Host row exists but its PTY is still being restored; no create races it. */
  | { kind: 'pending' }
  /** The PTY behind the handle is gone (host restart/exit); reopen is explicit. */
  | { kind: 'ended'; code: string }

export type CloudStreamSubscribe = (
  method: string,
  params: Record<string, unknown>,
  callbacks: CloudSubscriptionCallbacks
) => Promise<CloudSubscribeOutcome>
