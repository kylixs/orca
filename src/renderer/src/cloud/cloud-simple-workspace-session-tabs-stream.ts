import type { CloudTerminalSubscribe } from './cloud-terminal-panel'
import type { CloudSubscription } from './use-cloud-session'
import {
  isPermanentSyncFailure,
  SESSION_TABS_RECONNECT_DELAYS_MS
} from './cloud-simple-workspace-session-tab-failure'

/**
 * U112 D5: `session.tabs.subscribe` with a bounded backoff. A permanent failure
 * degrades the channel once; a transient drop reconnects (the opening frame is a
 * full snapshot, so missed frames are recovered) and degrades after the budget.
 */
export function startSessionTabsStream(args: {
  subscribe: CloudTerminalSubscribe
  worktree: string
  onFrame: (event: unknown) => void
  onSyncing: (syncing: boolean) => void
  onDegraded: () => void
  isStopped: () => boolean
}): { stop: () => void } {
  let subscription: CloudSubscription | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  let epoch = 0
  let stopped = false

  const isStopped = (): boolean => stopped || args.isStopped()

  const schedule = (): void => {
    // Why one timer: onError and onClose can both report one drop.
    if (isStopped() || timer !== undefined) {
      return
    }
    const attempt = attempts
    attempts += 1
    if (attempt >= SESSION_TABS_RECONNECT_DELAYS_MS.length) {
      args.onDegraded()
      return
    }
    args.onSyncing(true)
    timer = setTimeout(() => {
      timer = undefined
      open()
    }, SESSION_TABS_RECONNECT_DELAYS_MS[attempt])
  }

  const open = (): void => {
    const currentEpoch = ++epoch
    subscription?.unsubscribe()
    subscription = null
    void args
      .subscribe(
        'session.tabs.subscribe',
        { worktree: args.worktree },
        {
          onEvent: args.onFrame,
          onClose: () => {
            if (isStopped() || currentEpoch !== epoch) {
              return
            }
            subscription = null
            schedule()
          },
          onError: (error) => {
            if (isStopped() || currentEpoch !== epoch) {
              return
            }
            subscription = null
            if (isPermanentSyncFailure(error)) {
              args.onDegraded()
              return
            }
            schedule()
          }
        }
      )
      .then((streamed) => {
        if (isStopped() || currentEpoch !== epoch) {
          if (streamed.ok) {
            streamed.subscription.unsubscribe()
          }
          return
        }
        if (!streamed.ok) {
          if (isPermanentSyncFailure(streamed)) {
            args.onDegraded()
            return
          }
          schedule()
          return
        }
        subscription = streamed.subscription
        args.onSyncing(false)
      })
      .catch(() => {
        if (isStopped() || currentEpoch !== epoch) {
          return
        }
        schedule()
      })
  }

  open()
  return {
    stop: () => {
      stopped = true
      epoch += 1
      clearTimeout(timer)
      timer = undefined
      subscription?.unsubscribe()
      subscription = null
    }
  }
}
