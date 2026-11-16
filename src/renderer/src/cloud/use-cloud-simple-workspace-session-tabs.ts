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
import { recoverSimpleWorkspaceTerminalOrphans } from './cloud-simple-workspace-orphan-recovery'

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

/**
 * U96 B-令4 close outcome. `local` means the host cannot be coordinated with
 * (capability absent, degraded, or the call failed), so the shell falls back to
 * today's local tab close instead of pretending the host acted.
 */
export type CloudSimpleWorkspaceHostCloseOutcome = 'closed' | 'refused' | 'local'

export type CloudSimpleWorkspaceSessionTabActions = {
  /** User gesture only; never called while applying a host frame (loop guard). */
  activate: (tabId: string) => void
  close: (tabId: string) => Promise<CloudSimpleWorkspaceHostCloseOutcome>
  /** T-B1: create the PTY with the client-generated tab/leaf ids, then activate it. */
  createTerminal: (tabId: string, leafId: string, title: string) => Promise<boolean>
  /** Host refusal text to keep visible next to the tab strip. */
  notice: string | null
  dismissNotice: () => void
}

export type CloudSimpleWorkspaceSessionTabs = {
  /** Null until the capability gate passes and the host answered. */
  hostSnapshot: CloudSimpleWorkspaceHostSnapshot | null
  syncing: boolean
  /** Capability absent, or the one attempt failed (negative cache). */
  unsupported: boolean
  actions: CloudSimpleWorkspaceSessionTabActions
}

function closeRefusalNotice(reason: string | null): string {
  switch (reason) {
    case 'live-host-pty':
      return '桌面端正在使用该终端，无法从云端关闭。'
    case 'retirement-owner':
      return '该终端正由桌面端结束，请稍后重试。'
    case 'stale-terminal':
    case 'stale-publication':
      return '终端状态已变化，请刷新后重试。'
    case 'unknown-liveness':
      return '暂时无法确认终端状态，标签已保留。'
    case null:
    default:
      return '云端无法关闭该终端，标签已保留。'
  }
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
  const [notice, setNotice] = React.useState<string | null>(null)
  // Why refs: the cloud bridge hands in fresh rpc/subscribe closures on every
  // parent render; depending on them would retry a degraded session in a loop.
  const rpcRef = React.useRef(rpc)
  rpcRef.current = rpc
  const subscribeRef = React.useRef(subscribe)
  subscribeRef.current = subscribe
  // Mutation seam shared by the actions and the bootstrap effect below.
  const degradeRef = React.useRef<(() => void) | null>(null)
  const worktreeRef = React.useRef<string | null>(null)
  const supportedRef = React.useRef(false)
  // Loop guard (T-B2): the host active tab we last observed, plus the one this
  // client asked for. Applying a frame never calls activate.
  const hostActiveRef = React.useRef<string | null>(null)
  const requestedActivationRef = React.useRef<string | null>(null)

  const activate = React.useCallback((tabId: string): void => {
    const worktree = worktreeRef.current
    if (!supportedRef.current || !worktree) {
      return
    }
    // The host already has it (or our own notification is in flight).
    if (hostActiveRef.current === tabId || requestedActivationRef.current === tabId) {
      return
    }
    requestedActivationRef.current = tabId
    rpcRef.current('session.tabs.activate', { worktree, tabId, notifyClients: true })
      .then((outcome) => {
        if (!outcome.ok) {
          requestedActivationRef.current = null
          degradeRef.current?.()
        }
      })
      .catch(() => {
        requestedActivationRef.current = null
        degradeRef.current?.()
      })
  }, [])

  const close = React.useCallback(
    async (tabId: string): Promise<CloudSimpleWorkspaceHostCloseOutcome> => {
      const worktree = worktreeRef.current
      if (!supportedRef.current || !worktree) {
        return 'local'
      }
      const outcome = await rpcRef.current('session.tabs.close', {
        worktree,
        tabId,
        reason: 'user'
      }).catch(() => null)
      if (!outcome?.ok) {
        degradeRef.current?.()
        setNotice('连接不可用，未关闭该终端。')
        return 'local'
      }
      const result = readObjectValue(outcome.result)
      if (result !== null && readField(result, 'refused') === true) {
        setNotice(closeRefusalNotice(readString(result, 'refusalReason')))
        return 'refused'
      }
      setNotice(null)
      return 'closed'
    },
    []
  )

  const createTerminal = React.useCallback(
    async (tabId: string, leafId: string, title: string): Promise<boolean> => {
      const worktree = worktreeRef.current
      if (!supportedRef.current || !worktree) {
        return false
      }
      const outcome = await rpcRef.current('terminal.create', {
        worktree,
        tabId,
        leafId,
        title,
        clientMutationId: tabId
      }).catch(() => null)
      if (!outcome?.ok) {
        degradeRef.current?.()
        return false
      }
      requestedActivationRef.current = tabId
      const activated = await rpcRef.current('session.tabs.activate', {
        worktree,
        tabId,
        notifyClients: true
      }).catch(() => null)
      if (activated !== null && !activated.ok) {
        degradeRef.current?.()
      }
      return true
    },
    []
  )

  const actions = React.useMemo<CloudSimpleWorkspaceSessionTabActions>(
    () => ({ activate, close, createTerminal, notice, dismissNotice: () => setNotice(null) }),
    [activate, close, createTerminal, notice]
  )

  React.useEffect(() => {
    const subscribeStream = subscribeRef.current
    if (!restoreSupported || !workspacePath || !subscribeStream) {
      supportedRef.current = false
      worktreeRef.current = null
      return
    }
    const worktree = cloudWorktreeSelector(workspacePath)
    worktreeRef.current = worktree
    supportedRef.current = true
    let cancelled = false
    let failed = false
    let subscription: CloudSubscription | null = null

    const degrade = (): void => {
      if (cancelled || failed) {
        return
      }
      failed = true
      supportedRef.current = false
      setSyncing(false)
      setDegraded(true)
      subscription?.unsubscribe()
    }
    degradeRef.current = degrade

    const apply = (frame: HostTabsFrame): void => {
      if (cancelled || failed) {
        return
      }
      // Record the host's choice; never echo it back as an activate (T-B2 loop guard).
      hostActiveRef.current = frame.activeTabId
      setHostSnapshot({
        tabs: hostTerminalTabsFromSnapshot(frame),
        activeTabId: frame.activeTabId
      })
    }

    setHostSnapshot(null)
    setDegraded(false)
    setSyncing(true)
    setNotice(null)
    hostActiveRef.current = null
    requestedActivationRef.current = null

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
      // B-令7: a persisted-but-handle-less row may still own a live PTY; claim
      // it before the stream's first frame would project the pending row.
      const adopted = await recoverSimpleWorkspaceTerminalOrphans({
        rpc: rpcRef.current,
        workspacePath,
        frame: initial,
        isCurrent: () => !cancelled && !failed
      }).catch(() => null)
      if (cancelled || failed) {
        return
      }
      const adoptedFrame = adopted === null ? null : readHostTabsFrame(adopted)
      if (adoptedFrame !== null) {
        apply(adoptedFrame)
      }
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
      supportedRef.current = false
      degradeRef.current = null
      subscription?.unsubscribe()
    }
    // Why only these: rpc/subscribe identity churns per render (see refs above).
  }, [restoreSupported, workspacePath])

  return {
    hostSnapshot,
    syncing,
    unsupported: !restoreSupported || degraded,
    actions
  }
}
