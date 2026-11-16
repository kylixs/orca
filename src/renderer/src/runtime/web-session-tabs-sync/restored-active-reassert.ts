import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { AppState } from '../../store'
import { useAppStore } from '../../store'
import { activateWebRuntimeSessionTab } from '../web-runtime-session'
import { captureWebSessionIntentOwner } from '../web-runtime-session-environment'
import { peekWebSessionFocusIntent } from '../web-session-focus-intent'
import { resolveLocalTabIdForHostSessionTab } from './tracking-mappings'

/**
 * U138 phase 3: adoption copies the host's active tab client-ward, so a paired web client that
 * restored a different active tab never told the host. The host keeps the stale value and the
 * next reopen flips back. Write the restored tab through the paired activate path once per entry;
 * the adoption that carries this frame is already one-shot, so an echoed frame cannot loop.
 */
export function reassertRestoredActiveTab(args: {
  restoredLocalTabId: string | null
  hostActiveTabId: string | null
  /** The host's active tab projected back to this client, null when it has no mirror here. */
  hostActiveLocalTabId: string | null
  localTabIds: ReadonlySet<string>
  /** A caller-recorded focus intent already owns the host; restore must not override it. */
  hasPendingUserFocusIntent: boolean
  applyLocalActive: (tabId: string) => void
  activate: (tabId: string) => void
}): boolean {
  const restored = args.restoredLocalTabId
  if (!restored || args.hasPendingUserFocusIntent) {
    return false
  }
  if (!args.hostActiveTabId || !args.hostActiveLocalTabId) {
    return false
  }
  if (args.hostActiveLocalTabId === restored || !args.localTabIds.has(restored)) {
    return false
  }
  args.applyLocalActive(restored)
  args.activate(restored)
  return true
}

/**
 * Called once on the entry's adoption frame, before the applied state changes again. `preApplyState`
 * is the store snapshot captured before adoption overwrote the client's restored active.
 */
export function reassertRestoredActive(
  environmentId: string,
  worktreeId: string,
  recovered: RuntimeMobileSessionTabsResult,
  preApplyState: Pick<AppState, 'activeTabIdByWorktree'>
): void {
  const restoredLocalTabId = preApplyState.activeTabIdByWorktree?.[worktreeId] ?? null
  const hostActiveTab = recovered.tabs.find((tab) => tab.id === recovered.activeTabId)
  // A terminal's active id is its leaf; the mirror is keyed by the parent tab.
  const hostActiveParentTabId =
    hostActiveTab && 'parentTabId' in hostActiveTab
      ? hostActiveTab.parentTabId
      : recovered.activeTabId
  const state = useAppStore.getState()
  reassertRestoredActiveTab({
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
    activate: (tabId) => {
      void activateWebRuntimeSessionTab({ worktreeId, tabId, environmentId })
    }
  })
}
