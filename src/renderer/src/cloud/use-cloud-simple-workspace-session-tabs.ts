import * as React from 'react'
import { cloudWorktreeSelector, type CloudRpc } from '../../../shared/cloud-file-browser'
import { readField, readObjectValue, readString } from '../../../shared/json-fields'
import { CLOUD_SESSION_TABS_RESTORE_CAPABILITY } from '../../../shared/cloud-workspace-info'
import type { CloudTerminalSubscribe } from './cloud-terminal-panel'
import {
  hostTabCloseRefusalNotice,
  hostTerminalTabsFromSnapshot,
  readCloudSimpleHostTabsFrame,
  type CloudSimpleHostTabsFrame,
  type CloudSimpleHostTerminalTab
} from './cloud-simple-workspace-session-tabs'
import { recoverSimpleWorkspaceTerminalOrphans } from './cloud-simple-workspace-orphan-recovery'
import { closeHostSessionTabsForEnd } from './cloud-simple-workspace-end-close'
import {
  freshDegradedActions,
  isMissingTabFailure,
  isPermanentSyncFailure,
  type DegradedActions
} from './cloud-simple-workspace-session-tab-failure'
import { startSessionTabsStream } from './cloud-simple-workspace-session-tabs-stream'

/**
 * U96 B-令2: bootstrap the simple workspace from the host's session-tab
 * inventory (design §2.5). Capability-gated: a legacy host makes zero
 * `session.tabs.*` calls. A failed bootstrap degrades the session once — no
 * warn-loop — while transient stream drops retry with backoff (U112 D5) and a
 * failed action retires only that action (U112 D4).
 */

export type CloudSimpleWorkspaceHostSnapshot = {
  tabs: CloudSimpleHostTerminalTab[]
  activeTabId: string | null
}

/**
 * U96 B-令4 + U112 D4 close outcome. `local` means the host cannot be
 * coordinated with at all (capability absent / bootstrap degraded), so the shell
 * falls back to today's local tab close. `failed` means the host is there but
 * did not close the tab; the row must stay so a reopen cannot resurrect it.
 */
export type CloudSimpleWorkspaceHostCloseOutcome = 'closed' | 'refused' | 'failed' | 'local'

export type CloudSimpleWorkspaceSessionTabActions = {
  /** User gesture only; never called while applying a host frame (loop guard). */
  activate: (tabId: string) => void
  close: (tabId: string) => Promise<CloudSimpleWorkspaceHostCloseOutcome>
  /** T-B1: create the PTY with the client-generated tab/leaf ids, then activate it. */
  createTerminal: (tabId: string, leafId: string, title: string) => Promise<boolean>
  /** U112 D1: explicit end retires every host-backed terminal row. */
  closeAll: () => Promise<void>
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
  const [hostSnapshot, setHostSnapshot] = React.useState<CloudSimpleWorkspaceHostSnapshot | null>(
    null
  )
  const [syncing, setSyncing] = React.useState(false)
  const [degraded, setDegraded] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  // Why refs: the cloud bridge hands in fresh rpc/subscribe closures on every
  // parent render; depending on them would retry a degraded session in a loop.
  const rpcRef = React.useRef(rpc)
  rpcRef.current = rpc
  const subscribeRef = React.useRef(subscribe)
  subscribeRef.current = subscribe
  const worktreeRef = React.useRef<string | null>(null)
  const supportedRef = React.useRef(false)
  // Loop guard (T-B2): the host active tab we last observed, plus the one this
  // client asked for. Applying a frame never calls activate.
  const hostActiveRef = React.useRef<string | null>(null)
  const requestedActivationRef = React.useRef<string | null>(null)
  const degradedActionsRef = React.useRef<DegradedActions>(freshDegradedActions())

  const activate = React.useCallback((tabId: string): void => {
    const worktree = worktreeRef.current
    if (!supportedRef.current || !worktree || degradedActionsRef.current.activate) {
      return
    }
    // The host already has it (or this exact request is still in flight).
    if (hostActiveRef.current === tabId || requestedActivationRef.current === tabId) {
      return
    }
    requestedActivationRef.current = tabId
    rpcRef
      .current('session.tabs.activate', { worktree, tabId, notifyClients: true })
      .then((outcome) => {
        // In-flight, not "ever requested": a peer switch must not swallow the
        // next click on this same tab (U112 D3).
        if (requestedActivationRef.current === tabId) {
          requestedActivationRef.current = null
        }
        if (outcome.ok) {
          // The host accepted it; its next frame remains authoritative.
          hostActiveRef.current = tabId
          return
        }
        // A peer retired the row: the frame converges, nothing to degrade.
        if (isMissingTabFailure(outcome)) {
          return
        }
        if (isPermanentSyncFailure(outcome)) {
          degradedActionsRef.current.activate = true
        }
      })
      .catch(() => {
        if (requestedActivationRef.current === tabId) {
          requestedActivationRef.current = null
        }
      })
  }, [])

  const close = React.useCallback(
    async (tabId: string): Promise<CloudSimpleWorkspaceHostCloseOutcome> => {
      const worktree = worktreeRef.current
      if (!supportedRef.current || !worktree) {
        return 'local'
      }
      if (degradedActionsRef.current.close) {
        setNotice('连接不可用，未关闭该终端。')
        return 'failed'
      }
      const outcome = await rpcRef
        .current('session.tabs.close', {
          worktree,
          tabId,
          reason: 'user'
        })
        .catch(() => null)
      if (outcome === null) {
        setNotice('连接不可用，未关闭该终端。')
        return 'failed'
      }
      if (!outcome.ok) {
        // The peer closed it first: idempotent success, never a channel degrade.
        if (isMissingTabFailure(outcome)) {
          setNotice(null)
          return 'closed'
        }
        if (isPermanentSyncFailure(outcome)) {
          degradedActionsRef.current.close = true
        }
        setNotice('连接不可用，未关闭该终端。')
        return 'failed'
      }
      const result = readObjectValue(outcome.result)
      if (result !== null && readField(result, 'refused') === true) {
        setNotice(hostTabCloseRefusalNotice(readString(result, 'refusalReason')))
        return 'refused'
      }
      setNotice(null)
      return 'closed'
    },
    []
  )

  // Why the capability gate (not supportedRef): the end cleanup must still run
  // when the stream never established, and it reads the inventory fresh.
  const closeAll = React.useCallback(
    () => closeHostSessionTabsForEnd({ rpc: rpcRef.current, workspacePath }, restoreSupported),
    [restoreSupported, workspacePath]
  )

  const createTerminal = React.useCallback(
    async (tabId: string, leafId: string, title: string): Promise<boolean> => {
      const worktree = worktreeRef.current
      if (!supportedRef.current || !worktree || degradedActionsRef.current.create) {
        return false
      }
      const outcome = await rpcRef
        .current('terminal.create', {
          worktree,
          tabId,
          leafId,
          title,
          clientMutationId: tabId
        })
        .catch(() => null)
      if (outcome === null) {
        return false
      }
      if (!outcome.ok) {
        if (isPermanentSyncFailure(outcome)) {
          degradedActionsRef.current.create = true
        }
        return false
      }
      requestedActivationRef.current = tabId
      const activated = await rpcRef
        .current('session.tabs.activate', {
          worktree,
          tabId,
          notifyClients: true
        })
        .catch(() => null)
      if (activated === null || !activated.ok) {
        requestedActivationRef.current = null
        if (activated !== null && isPermanentSyncFailure(activated)) {
          degradedActionsRef.current.activate = true
        }
      } else {
        hostActiveRef.current = tabId
        requestedActivationRef.current = null
      }
      return true
    },
    []
  )

  const actions = React.useMemo<CloudSimpleWorkspaceSessionTabActions>(
    () => ({
      activate,
      close,
      createTerminal,
      closeAll,
      notice,
      dismissNotice: () => setNotice(null)
    }),
    [activate, close, createTerminal, closeAll, notice]
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
    let stream: { stop: () => void } | null = null

    const degrade = (): void => {
      if (cancelled || failed) {
        return
      }
      failed = true
      supportedRef.current = false
      setSyncing(false)
      setDegraded(true)
      stream?.stop()
    }

    const apply = (frame: CloudSimpleHostTabsFrame): void => {
      if (cancelled || failed) {
        return
      }
      // A frame that confirms our request ends the in-flight guard; a frame that
      // moves elsewhere leaves it to the RPC completion (U112 D3).
      if (frame.activeTabId !== null && frame.activeTabId === requestedActivationRef.current) {
        requestedActivationRef.current = null
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
    degradedActionsRef.current = freshDegradedActions()

    const establish = async (): Promise<void> => {
      const listed = await rpcRef.current('session.tabs.list', { worktree }).catch(() => null)
      if (cancelled) {
        return
      }
      const initial = listed?.ok ? readCloudSimpleHostTabsFrame(listed.result) : null
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
      const adoptedFrame = adopted === null ? null : readCloudSimpleHostTabsFrame(adopted)
      if (adoptedFrame !== null) {
        apply(adoptedFrame)
      }
      stream = startSessionTabsStream({
        subscribe: subscribeStream,
        worktree,
        onFrame: (event) => {
          const frame = readCloudSimpleHostTabsFrame(event)
          if (frame !== null) {
            apply(frame)
          }
        },
        onSyncing: setSyncing,
        onDegraded: degrade,
        isStopped: () => cancelled || failed
      })
    }

    void establish()
    return () => {
      cancelled = true
      supportedRef.current = false
      stream?.stop()
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
