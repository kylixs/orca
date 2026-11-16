import { isLocalSessionTabCloseOwned } from '@/runtime/local-session-tab-close-owner'
import { closeMobileSessionTabInStore } from '@/runtime/mobile-session-tab-close'
import {
  SESSION_TAB_CLOSE_CANCELED_ERROR,
  SESSION_TAB_CLOSE_FAILED_ERROR,
  SESSION_TAB_NOT_FOUND_ERROR,
  SESSION_TAB_CLOSE_TIMEOUT_ERROR
} from '../../../../shared/session-tab-close'
import {
  guardPinnedTabClose,
  isUnifiedTabPinned,
  resolvePinnedTabLabel
} from '../../store/pinned-tab-close-guard'
import { useAppStore } from '../../store'
import type { SessionTabMoveRequest } from '../../../../shared/session-tab-move'
import { resolveBrowserSessionTabTarget } from './browser-session-tab-target'
import { resolveWindowTabIdForHostTab } from './host-session-tab-target'

export function registerSessionTabIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onCloseSessionTab(({ tabId, worktreeId }) => {
      if (isLocalSessionTabCloseOwned(worktreeId, tabId)) {
        return
      }
      const localTabId = resolveWindowTabIdForHostTab(worktreeId, tabId)
      const store = useAppStore.getState()
      const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, localTabId)
      if (browserTarget) {
        guardPinnedTabClose({
          isPinned: isUnifiedTabPinned(store, worktreeId, browserTarget.workspaceId),
          tabLabel: resolvePinnedTabLabel(store, worktreeId, browserTarget.workspaceId),
          onClose: () => useAppStore.getState().closeBrowserTab(browserTarget.workspaceId)
        })
        return
      }
      guardPinnedTabClose({
        isPinned: isUnifiedTabPinned(store, worktreeId, localTabId),
        tabLabel: resolvePinnedTabLabel(store, worktreeId, localTabId),
        onClose: () => {
          const currentStore = useAppStore.getState()
          closeMobileSessionTabInStore(currentStore, worktreeId, localTabId)
        }
      })
    })
  )

  unsubs.push(
    window.api.ui.onSessionTabCloseRequest(({ requestId, tabId, worktreeId, expiresAt }) => {
      const localTabId = resolveWindowTabIdForHostTab(worktreeId, tabId)
      const store = useAppStore.getState()
      const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, localTabId)
      let cancelConfirmation: (() => void) | undefined
      let timeout: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const respond = (error?: string): void => {
        if (settled) {
          return
        }
        settled = true
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
        window.api.ui.respondSessionTabClose({ requestId, ...(error ? { error } : {}) })
      }
      if (expiresAt !== undefined) {
        timeout = setTimeout(
          () => {
            cancelConfirmation?.()
            respond(SESSION_TAB_CLOSE_TIMEOUT_ERROR)
          },
          Math.max(0, expiresAt - Date.now())
        )
      }
      const closeAndRespond = (): void => {
        if (expiresAt !== undefined && Date.now() >= expiresAt) {
          respond(SESSION_TAB_CLOSE_TIMEOUT_ERROR)
          return
        }
        try {
          if (browserTarget) {
            useAppStore.getState().closeBrowserTab(browserTarget.workspaceId)
            respond()
            return
          }
          const closed = closeMobileSessionTabInStore(
            useAppStore.getState(),
            worktreeId,
            localTabId
          )
          respond(closed ? undefined : SESSION_TAB_NOT_FOUND_ERROR)
        } catch (error) {
          respond(error instanceof Error ? error.message : SESSION_TAB_CLOSE_FAILED_ERROR)
        }
      }
      if (isLocalSessionTabCloseOwned(worktreeId, tabId)) {
        respond(
          expiresAt !== undefined && Date.now() >= expiresAt
            ? SESSION_TAB_CLOSE_TIMEOUT_ERROR
            : undefined
        )
        return
      }
      const visibleId = browserTarget?.workspaceId ?? localTabId
      cancelConfirmation = guardPinnedTabClose({
        isPinned: isUnifiedTabPinned(store, worktreeId, visibleId),
        tabLabel: resolvePinnedTabLabel(store, worktreeId, visibleId),
        onClose: closeAndRespond,
        onCancel: () => respond(SESSION_TAB_CLOSE_CANCELED_ERROR)
      })
    })
  )

  unsubs.push(
    window.api.ui.onMoveSessionTab((move) => {
      const applied = applyMobileSessionTabMoveInStore(useAppStore.getState(), move)
      if (move.requestId) {
        window.api.ui.respondSessionTabMove({ requestId: move.requestId, applied })
      }
    })
  )
}

/**
 * Apply a host-forwarded move to the window store, scoped to the payload's
 * worktree. Returns false when this window has no entry for that worktree or
 * when the store action itself dropped the move (silent no-op).
 */
function applyMobileSessionTabMoveInStore(
  store: ReturnType<typeof useAppStore.getState>,
  move: SessionTabMoveRequest
): boolean {
  const tabId = resolveWindowTabIdForHostTab(move.worktreeId, move.tabId)
  const worktreeTabs = store.unifiedTabsByWorktree[move.worktreeId]
  const worktreeGroups = store.groupsByWorktree[move.worktreeId]
  const tab = worktreeTabs?.find((candidate) => candidate.id === tabId)
  if (!tab) {
    return false
  }
  if (!worktreeGroups?.some((group) => group.id === move.targetGroupId)) {
    return false
  }
  if (move.kind === 'reorder') {
    // reorderUnifiedTabs is void; a delivered reorder to a published group counts as applied.
    store.reorderUnifiedTabs(move.targetGroupId, move.tabOrder)
    return true
  }
  if (!worktreeGroups.some((group) => group.id === tab.groupId)) {
    return false
  }
  // Why: dropUnifiedTab also returns false for legitimate no-ops (same group,
  // pane-column dedupe); entities are validated above, so only those remain.
  store.dropUnifiedTab(tabId, {
    groupId: move.targetGroupId,
    ...(move.kind === 'move-to-group' ? { index: move.index } : {}),
    ...(move.kind === 'split' ? { splitDirection: move.splitDirection } : {})
  })
  return true
}
