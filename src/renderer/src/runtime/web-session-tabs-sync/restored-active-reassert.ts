import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { useAppStore } from '../../store'
import { activateWebRuntimeSessionTab } from '../web-runtime-session'
import { captureWebSessionIntentOwner } from '../web-runtime-session-environment'
import { peekWebSessionFocusIntent } from '../web-session-focus-intent'
import { resolveLocalTabIdForHostSessionTab } from './tracking-mappings'

/**
 * U138 phase 5: adoption applies the host's active tab client-ward. A paired web client that
 * restored a different tab must tell the host once, or the host keeps the stale value and the next
 * reopen flips back. The restored value is captured at subscription entry (`restoredLocalTabId`),
 * never read off the store at adoption time: earlier frames have already rewritten it to the
 * host's answer by then, which made the comparison below a no-op.
 */
export function reassertRestoredActiveTab(args: {
  /** One shot per restored entry: a consumed id must never write back twice. */
  mutationId: string
  restoredLocalTabId: string | null
  hostActiveTabId: string | null
  /** The host's active tab projected back to this client, null when it has no mirror here. */
  hostActiveLocalTabId: string | null
  localTabIds: ReadonlySet<string>
  /** A caller-recorded focus intent already owns the host; restore must not override it. */
  hasPendingUserFocusIntent: boolean
  /**
   * Resolves true only when the host applied the request. The host's answer wins: a refusal must
   * not leave a restored value on screen that the host is about to overwrite with its own.
   */
  activate: (tabId: string) => boolean | Promise<boolean>
  applyLocalActive: (tabId: string) => void
}): Promise<boolean> {
  const restored = args.restoredLocalTabId
  if (!restored || args.hasPendingUserFocusIntent) {
    return Promise.resolve(false)
  }
  if (!args.hostActiveTabId || !args.hostActiveLocalTabId) {
    return Promise.resolve(false)
  }
  if (args.hostActiveLocalTabId === restored || !args.localTabIds.has(restored)) {
    return Promise.resolve(false)
  }
  if (consumedWriteBacks.has(args.mutationId)) {
    return Promise.resolve(false)
  }
  consumedWriteBacks.add(args.mutationId)
  return Promise.resolve(args.activate(restored)).then((accepted) => {
    if (accepted === false) {
      return false
    }
    args.applyLocalActive(restored)
    return true
  })
}

const consumedWriteBacks = new Set<string>()
let writeBackSequence = 0

export function resetRestoredActiveReassertForTests(): void {
  consumedWriteBacks.clear()
}

/**
 * Capture before any stream frame applies. Frames routinely rewrite the active tab to the host's
 * answer, so reading the store at adoption time loses the restore the client is trying to keep.
 */
export function captureRestoredActive(worktreeId: string): string | null {
  return useAppStore.getState().activeTabIdByWorktree?.[worktreeId] ?? null
}

/**
 * Called on the entry's adoption frame, after adoption applied the host layout. The restored active
 * is the snapshot taken when the subscription installed (or when the entry armed adoption).
 */
export function reassertRestoredActive(
  environmentId: string,
  worktreeId: string,
  recovered: RuntimeMobileSessionTabsResult,
  restoredLocalTabId: string | null
): void {
  writeBackSequence += 1
  const hostActiveTab = recovered.tabs.find((tab) => tab.id === recovered.activeTabId)
  // A terminal's active id is its leaf; the mirror is keyed by the parent tab.
  const hostActiveParentTabId =
    hostActiveTab && 'parentTabId' in hostActiveTab
      ? hostActiveTab.parentTabId
      : recovered.activeTabId
  const state = useAppStore.getState()
  void reassertRestoredActiveTab({
    mutationId: `entry:${environmentId}:${worktreeId}:${writeBackSequence}`,
    restoredLocalTabId,
    hostActiveTabId: recovered.activeTabId,
    hostActiveLocalTabId:
      typeof hostActiveParentTabId === 'string'
        ? resolveLocalTabIdForHostSessionTab({
            environmentId,
            worktreeId,
            hostTabId: hostActiveParentTabId
          })
        : null,
    localTabIds: new Set((state.unifiedTabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)),
    hasPendingUserFocusIntent:
      peekWebSessionFocusIntent(captureWebSessionIntentOwner(environmentId), worktreeId) !== null,
    applyLocalActive: (tabId) => {
      const next = useAppStore.getState()
      next.activateTab(tabId, { worktreeId, recordFocus: false })
      next.setActiveTab?.(tabId)
    },
    activate: (tabId) =>
      activateWebRuntimeSessionTab({ worktreeId, tabId, environmentId }).catch(() => false)
  })
}
