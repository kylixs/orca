// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCloseStructuredAgentSessionTab } from './orca-runtime-close-structured-agent-session-tab'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { buildHeadlessMobileSessionTabGroups } from './mobile-session-layout-projection'
import { collectTabGroupLayoutGroupIds } from '../../shared/workspace-layout/tab-group-moves'
import { appendRetiredTerminalSurfaceProofs } from './mobile-session-terminal-retirement-proof'
import { getMobileSessionTabGroupLayoutSignature } from './mobile-session-tab-group-layout-signature'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import type { RuntimeSessionTabCloseReason } from '../../shared/runtime-session-contracts'

export class OrcaRuntimeWithCloseHeadlessMobileTerminalTab extends OrcaRuntimeWithCloseStructuredAgentSessionTab {
  protected async closeHeadlessMobileTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab,
    options: {
      allowMissingPersistedTab?: boolean
      killPtys?: boolean
      authorizedPty?: RuntimePtyWorktreeRecord
      force?: boolean
      reason?: RuntimeSessionTabCloseReason
    } = {}
  ): Promise<void> {
    const closedParentTabId = tab.parentTabId
    const retirementProofs = snapshot.tabs.flatMap((candidate) => {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        return []
      }
      const proof = this.getMobileSessionTerminalRetirementProof(
        worktreeId,
        candidate,
        options.authorizedPty
      )
      return proof ? [proof] : []
    })
    const acknowledgeRetirement = this.captureTerminalTabRetirement(worktreeId, closedParentTabId)
    const projectedPtyIds = await this.closeTerminalSurface(
      worktreeId,
      { kind: 'tab', tabId: closedParentTabId },
      {
        allowMissing: options.allowMissingPersistedTab,
        force: options.force,
        reason: options.reason
      }
    )
    if (!acknowledgeRetirement().matches) {
      throw new Error('terminal_pane_owner_changed')
    }
    // Renderer frames may add other tabs while the durable close is in flight.
    snapshot = this.mobileSessionTabsByWorktree.get(worktreeId) ?? snapshot
    this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, closedParentTabId)
    if (options.authorizedPty) {
      options.authorizedPty.runtimeSessionOwned = false
      this.setPairedRendererSessionOwnership(options.authorizedPty.ptyId, false)
    }
    // Why: local provider ids can be reused after restart, so a dormant
    // persisted id is not kill authority. SSH relay ids remain durable exact
    // identities even before pane metadata reconnects.
    const ptyIdsToKill = new Set(projectedPtyIds.filter((ptyId) => parseAppSshPtyId(ptyId)))
    for (const candidate of snapshot.tabs) {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        continue
      }
      const authorizedPty =
        options.authorizedPty &&
        this.getMobileTerminalLeafPtyIds(candidate).includes(options.authorizedPty.ptyId)
          ? options.authorizedPty
          : null
      const livePty = this.findPtyForMobileTerminalTab(worktreeId, candidate) ?? authorizedPty
      const ptyId = livePty?.ptyId ?? candidate.ptyId
      const hasOtherOwner = snapshot.tabs.some(
        (other) =>
          other.type === 'terminal' &&
          other.parentTabId !== closedParentTabId &&
          other.ptyId === ptyId
      )
      if (ptyId && !hasOtherOwner && (livePty || parseAppSshPtyId(ptyId))) {
        // Why: a live serve leaf can exist before its debounced binding reaches
        // persistence. Include it from the authoritative snapshot so split
        // close cannot leave a provider process behind.
        ptyIdsToKill.add(ptyId)
      }
    }
    if (options.killPtys !== false) {
      for (const ptyId of ptyIdsToKill) {
        this.ptyController?.kill(ptyId)
      }
    }
    const nextTabs = snapshot.tabs.filter((candidate) => {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        return true
      }
      return false
    })
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    // A close is not a handover: the generation publishing this worktree still is. Minting an epoch
    // here published a stranger for a worktree the renderer owns, and a client that retires what it
    // displaces then rejected that renderer's own next frame. The sibling headless writers carry the
    // stored epoch forward for the same reason; `...snapshot` is what does it here.
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: buildHeadlessMobileSessionTabGroups(
        worktreeId,
        nextTabs,
        active,
        snapshot.tabGroups
      ),
      ...(retirementProofs.length > 0
        ? {
            retiredTerminalSurfaces: appendRetiredTerminalSurfaceProofs(
              snapshot.retiredTerminalSurfaces,
              retirementProofs
            )
          }
        : {}),
      tabs: nextTabs
    }
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  async moveMobileSessionTab(
    worktreeSelector: string,
    move: RuntimeMobileSessionTabMove
  ): Promise<RuntimeMobileSessionTabMoveResult> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      throw new Error('tab_not_found')
    }
    if (
      !this.notifier?.moveSessionTab ||
      !this.acceptedRendererMobileSessionLayoutMatchesHost(worktreeId, snapshot)
    ) {
      // Why: a window that never published this worktree has no store entry to
      // drop, so forwarding there is a silent no-op; the host must apply it.
      // A stale client snapshot can name a group this host has dropped: applying
      // would report success for nothing (or orphan the new group outside the tree).
      if (
        move.kind !== 'reorder' &&
        !this.isApplicableHeadlessTabGroupTarget(snapshot, move.targetGroupId)
      ) {
        return { moved: false }
      }
      return this.moveHeadlessMobileSessionTab(worktreeId, snapshot, move)
    }
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const publicSnapshot = this.toMobileSessionTabsResult(snapshot)
    const targetGroup = publicSnapshot.tabGroups?.find((group) => group.id === move.targetGroupId)
    if (!targetGroup) {
      throw new Error('target_group_not_found')
    }

    // Why: web clients address terminal surfaces as tab::leaf, while desktop
    // tab grouping is owned by the outer terminal tab id.
    if (move.kind === 'reorder') {
      const tabOrder = this.normalizeMobileSessionTabOrder(snapshot, targetGroup, move.tabOrder)
      if (!tabOrder.includes(hostTabId)) {
        throw new Error('invalid_tab_order')
      }
      const applied = await this.notifier.moveSessionTab(worktreeId, {
        ...move,
        tabId: hostTabId,
        tabOrder
      })
      return applied === false
        ? this.applyHeadlessMobileSessionTabMove(worktreeId, move)
        : { moved: true }
    }
    const applied = await this.notifier.moveSessionTab(worktreeId, {
      ...move,
      tabId: hostTabId
    })
    return applied === false
      ? this.applyHeadlessMobileSessionTabMove(worktreeId, move)
      : { moved: true }
  }

  // Why: an accepted publication can still refuse the drop (the window may be
  // gone, reloading, or not actually own the worktree). Leaving it unapplied
  // strands the client's optimistic layout, so the host applies it headlessly.
  protected applyHeadlessMobileSessionTabMove(
    worktreeId: string,
    move: RuntimeMobileSessionTabMove
  ): RuntimeMobileSessionTabMoveResult {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return { moved: false }
    }
    if (
      move.kind !== 'reorder' &&
      !this.isApplicableHeadlessTabGroupTarget(snapshot, move.targetGroupId)
    ) {
      return { moved: false }
    }
    try {
      return this.moveHeadlessMobileSessionTab(worktreeId, snapshot, move)
    } catch {
      // A renderer-only refusal (e.g. an invalid reorder) must stay an unapplied move.
      return { moved: false }
    }
  }

  // Why: only a renderer whose accepted snapshot still describes the host's
  // current group layout owns the groups the forwarded move names. A stale
  // renderer (e.g. one that never saw a headless split) would apply the move to
  // its older single-group layout and publish that back, collapsing the split.
  protected acceptedRendererMobileSessionLayoutMatchesHost(
    worktreeId: string,
    hostSnapshot: RuntimeMobileSessionTabsSnapshot
  ): boolean {
    const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(worktreeId)
    return (
      accepted !== undefined &&
      accepted.rendererTabGroupLayoutSignature ===
        getMobileSessionTabGroupLayoutSignature(hostSnapshot)
    )
  }

  // Why: a group only exists while it holds a tab AND is referenced by the tree;
  // a target that fails either invariant is stale and must not be applied.
  protected isApplicableHeadlessTabGroupTarget(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    targetGroupId: string
  ): boolean {
    if (!(snapshot.tabGroups ?? []).some((group) => group.id === targetGroupId)) {
      return false
    }
    return (
      !snapshot.tabGroupLayout ||
      collectTabGroupLayoutGroupIds(snapshot.tabGroupLayout).has(targetGroupId)
    )
  }

  // Why: pane geometry inside a tab (split ratios, expanded pane, pane titles)
  // is host-authoritative for remote-server tabs but had no push path, so a
  // client divider-drag / expand / pane-rename reverted on the next snapshot.
  // Persist the structural fields onto the tab's layout, keeping host-owned
  // pty bindings and active leaf.
  async updateMobileSessionPaneLayout(
    worktreeSelector: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      chatLeafId?: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Why: when a renderer is authoritative (desktop host reached via shared
    // control), it owns pane geometry and republishes it — a headless write here
    // would be overwritten and could fight the renderer. Persist only headlessly.
    if (this.getAvailableAuthoritativeWindow()) {
      return { updated: true }
    }
    // Why: resolve to the host tab id (older/raw-id clients) so the persisted
    // layout entry matches, matching setMobileSessionTabProps.
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    const resolvedArgs = { ...args, tabId: hostTabId }
    const acceptedLayout = this.persistHeadlessTerminalPaneLayout(worktreeId, resolvedArgs)
    if (acceptedLayout) {
      this.applyHeadlessTerminalPaneLayoutToSnapshot(worktreeId, {
        tabId: hostTabId,
        root: acceptedLayout.root,
        expandedLeafId: acceptedLayout.expandedLeafId,
        chatLeafId: acceptedLayout.chatLeafId ?? null,
        ...(acceptedLayout.titlesByLeafId ? { titlesByLeafId: acceptedLayout.titlesByLeafId } : {})
      })
    }
    return { updated: true }
  }

  // Why: tab color/pin are host-authoritative for remote-server tabs but had no
  // push path, so pinning or coloring a tab reverted on the next snapshot and
  // was never persisted. Persist to the workspace session + live snapshot.
  async setMobileSessionTabProps(
    worktreeSelector: string,
    args: {
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
    }
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Why: a renderer-authoritative host owns + republishes tab props, so a
    // headless write would be overwritten. Persist only when headless.
    if (this.getAvailableAuthoritativeWindow()) {
      return { updated: true }
    }
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    this.persistHeadlessSessionTabProps(worktreeId, hostTabId, args)
    this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, hostTabId, args)
    return { updated: true }
  }
}
