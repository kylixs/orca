import * as React from 'react'
import { cloudWorktreeSelector, type CloudRpc } from '../../../shared/cloud-file-browser'
import { readArrayValue, readField, readObjectValue, readString } from '../../../shared/json-fields'
import { CLOUD_SESSION_TABS_RESTORE_CAPABILITY } from '../../../shared/cloud-workspace-info'
import type { RuntimeMobileSessionClientTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { CloudSubscription } from './use-cloud-session'
import type { CloudTerminalSubscribe } from './cloud-terminal-panel'
import {
  hostTerminalTabsFromSnapshot,
  type CloudSimpleHostTabsSnapshot,
  type CloudSimpleHostTerminalTab
} from './cloud-simple-workspace-session-tabs'

/**
 * U96 B-令2: bootstrap the simple workspace from the host's session-tab
 * inventory (design §2.5). Capability-gated: a legacy host makes zero
 * `session.tabs.*` calls. One failed attempt degrades the session — no retry,
 * no warn-loop — and the shell keeps its local-tab behaviour.
 */

export type CloudSimpleWorkspaceHostSnapshot = {
  tabs: CloudSimpleHostTerminalTab[]
  activeTabId: string | null
}

export type CloudSimpleWorkspaceSessionTabs = {
  /** Null until the capability gate passes and the host answered. */
  hostSnapshot: CloudSimpleWorkspaceHostSnapshot | null
  syncing: boolean
  /** Capability absent, or the one attempt failed (negative cache). */
  unsupported: boolean
}

type HostTabsFrame = CloudSimpleHostTabsSnapshot & { activeTabId: string | null }

/**
 * Shape-checked `session.tabs.list` reply / stream frame. Terminal rows are
 * read-only projections, so entries only need to be objects — the host owns
 * the row schema (the same trust the web mirror applies).
 */
function readHostTabsFrame(value: unknown): HostTabsFrame | null {
  const frame = readObjectValue(value)
  if (frame === null) {
    return null
  }
  const tabs = readArrayValue(readField(frame, 'tabs'))
  if (tabs === null || tabs.some((row) => readObjectValue(row) === null)) {
    return null
  }
  const groups = readArrayValue(readField(frame, 'tabGroups'))
  const tabGroups =
    groups === null
      ? undefined
      : groups.flatMap((group) => {
          const order = readArrayValue(readField(group, 'tabOrder'))
          return order === null
            ? []
            : [{ tabOrder: order.filter((id): id is string => typeof id === 'string') }]
        })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: entries are verified non-null objects above; the host owns the terminal-row field set.
  const rows = tabs as RuntimeMobileSessionClientTab[]
  return {
    tabs: rows,
    ...(tabGroups === undefined ? {} : { tabGroups }),
    activeTabId: readString(frame, 'activeTabId')
  }
}

export function useCloudSimpleWorkspaceSessionTabs({
  rpc,
  subscribe,
  workspacePath,
  capabilities
}: {
  rpc: CloudRpc
  subscribe?: CloudTerminalSubscribe | null
  workspacePath?: string | null
  /** From `workspace.info.capabilities`; null until that reply lands. */
  capabilities?: readonly string[] | null
}): CloudSimpleWorkspaceSessionTabs {
  const restoreSupported =
    Boolean(workspacePath) &&
    (capabilities?.includes(CLOUD_SESSION_TABS_RESTORE_CAPABILITY) ?? false)
  const [hostSnapshot, setHostSnapshot] =
    React.useState<CloudSimpleWorkspaceHostSnapshot | null>(null)
  const [syncing, setSyncing] = React.useState(false)
  const [degraded, setDegraded] = React.useState(false)
  // Why refs: the cloud bridge hands in fresh rpc/subscribe closures on every
  // parent render; depending on them would retry a degraded session in a loop.
  const rpcRef = React.useRef(rpc)
  rpcRef.current = rpc
  const subscribeRef = React.useRef(subscribe)
  subscribeRef.current = subscribe

  React.useEffect(() => {
    const subscribeStream = subscribeRef.current
    if (!restoreSupported || !workspacePath || !subscribeStream) {
      return
    }
    const worktree = cloudWorktreeSelector(workspacePath)
    let cancelled = false
    let failed = false
    let subscription: CloudSubscription | null = null

    const degrade = (): void => {
      if (cancelled || failed) {
        return
      }
      failed = true
      setSyncing(false)
      setDegraded(true)
      subscription?.unsubscribe()
    }

    const apply = (frame: HostTabsFrame): void => {
      if (cancelled || failed) {
        return
      }
      setHostSnapshot({
        tabs: hostTerminalTabsFromSnapshot(frame),
        activeTabId: frame.activeTabId
      })
    }

    setHostSnapshot(null)
    setDegraded(false)
    setSyncing(true)

    const establish = async (): Promise<void> => {
      const listed = await rpcRef.current('session.tabs.list', { worktree }).catch(() => null)
      if (cancelled) {
        return
      }
      const initial = listed?.ok ? readHostTabsFrame(listed.result) : null
      if (initial === null) {
        degrade()
        return
      }
      apply(initial)
      const streamed = await subscribeStream(
        'session.tabs.subscribe',
        { worktree },
        {
          onEvent: (event) => {
            const frame = readHostTabsFrame(event)
            if (frame !== null) {
              apply(frame)
            }
          },
          onClose: () => {
            if (!cancelled && !failed) {
              setSyncing(false)
            }
          },
          onError: degrade
        }
      ).catch(() => null)
      if (cancelled || failed) {
        if (streamed?.ok) {
          streamed.subscription.unsubscribe()
        }
        return
      }
      if (!streamed?.ok) {
        degrade()
        return
      }
      subscription = streamed.subscription
      setSyncing(false)
    }

    void establish()
    return () => {
      cancelled = true
      subscription?.unsubscribe()
    }
    // Why only these: rpc/subscribe identity churns per render (see refs above).
  }, [restoreSupported, workspacePath])

  return {
    hostSnapshot,
    syncing,
    unsupported: !restoreSupported || degraded
  }
}
