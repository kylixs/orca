import * as React from 'react'

/**
 * U96 B-令5 (§4.1/§4.3): the embed console's lifecycle intent while it tears the
 * simple workspace down. `suspending` keeps host PTYs (the overlay is only
 * being destroyed); `ending` lets every terminal panel close its own PTY.
 *
 * The intent is read at unmount time, not captured in a render: React removes
 * the workspace in the same commit that changes the intent, so the removed
 * subtree never re-renders with the new value.
 */

export type CloudSimpleWorkspaceLifecycleIntent = 'active' | 'suspending' | 'ending'

export type CloudSimpleWorkspaceLifecycle = {
  intent: () => CloudSimpleWorkspaceLifecycleIntent
  /**
   * U112 D1 (§4.3): an explicit end runs these (awaited) before `closeProject`.
   * A panel unmount only closes the PTY it created; the host tab inventory —
   * the target shape — is retired through `session.tabs.close` from here.
   */
  registerEndCleanup: (cleanup: () => Promise<void>) => () => void
  runEndCleanup: () => Promise<void>
}

const CloudSimpleWorkspaceLifecycleContext =
  React.createContext<CloudSimpleWorkspaceLifecycle | null>(null)

export function CloudSimpleWorkspaceLifecycleProvider({
  lifecycle,
  children
}: {
  lifecycle: CloudSimpleWorkspaceLifecycle
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <CloudSimpleWorkspaceLifecycleContext.Provider value={lifecycle}>
      {children}
    </CloudSimpleWorkspaceLifecycleContext.Provider>
  )
}

/** Null outside the embed: the panel keeps its close-on-unmount default. */
export function useCloudSimpleWorkspaceLifecycle(): CloudSimpleWorkspaceLifecycle | null {
  return React.useContext(CloudSimpleWorkspaceLifecycleContext)
}

/**
 * §4.3: `leave-running` during suspend (PTY survives the iframe); otherwise the
 * tab-close path keeps closing the PTY it owns, as it does today.
 */
export function cloudTerminalDetachPolicy(
  intent: CloudSimpleWorkspaceLifecycleIntent
): 'close-on-unmount' | 'leave-running' {
  return intent === 'suspending' ? 'leave-running' : 'close-on-unmount'
}
