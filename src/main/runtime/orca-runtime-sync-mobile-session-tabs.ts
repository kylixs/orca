/* eslint-disable unicorn/no-useless-spread */
// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithWriteOrchestrationPointerPty } from './orca-runtime-write-orchestration-pointer-pty'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getMobileSessionSnapshotTabIdentityKeys } from './mobile-session-tab-merge'
import {
  getMobileSessionAuthoredLayoutDigest,
  getMobileSessionTabGroupLayoutSignature
} from './mobile-session-tab-group-layout-signature'

export class OrcaRuntimeWithSyncMobileSessionTabs extends OrcaRuntimeWithWriteOrchestrationPointerPty {
  // Returns the worktrees whose stored snapshot object changed during this
  // sync, so the caller can fan out only actually-changed worktrees.
  protected syncMobileSessionTabs(
    snapshots: RuntimeMobileSessionTabsSnapshot[] | undefined,
    unchangedWorktreeIds?: string[],
    resyncWorktreeIds = new Set<string>(),
    rendererGeneration?: string | null
  ): Set<string> {
    const changedWorktreeIds = new Set<string>()
    if (snapshots === undefined) {
      return changedWorktreeIds
    }
    // Why: snapshots are immutable — every writer replaces the map entry with a
    // new object, and the accept gate below drops semantically-unchanged
    // renderer resends before they replace an entry — so reference identity
    // before/after detects exactly the entries that actually changed.
    const blockedRecreatedWorktreeIds = new Set<string>()
    const acceptedSnapshots = snapshots.filter((snapshot) => {
      const fence = this.removedMobileSessionWorktreeIds.get(snapshot.worktree)
      if (!fence) {
        return true
      }
      const reject = (): false => {
        blockedRecreatedWorktreeIds.add(snapshot.worktree)
        fence.rejectedPublication = true
        return false
      }
      const currentMeta = this.store?.getWorktreeMeta(snapshot.worktree)
      if (!currentMeta) {
        return reject()
      }
      if (snapshot.worktreeInstanceId !== undefined) {
        // Why: every catalog row carries an instanceId, so a mismatch against the
        // live meta is exactly "not the current occupant" — no removed-id memory needed.
        if (snapshot.worktreeInstanceId !== currentMeta.instanceId) {
          return reject()
        }
        // Why: the successor's identity proves the race window closed; the
        // instanceId mismatch alone fences any later frame from the old occupant.
        this.removedMobileSessionWorktreeIds.delete(snapshot.worktree)
        return true
      }
      // Identity-less frame: only the live renderer generation can speak for the
      // successor, and the generation that published the removed occupant never
      // can — a same-generation recreate stays fenced until the renderer reloads.
      if (
        (typeof rendererGeneration === 'string' &&
          snapshot.publicationEpoch !== rendererGeneration) ||
        snapshot.publicationEpoch === fence.removedPublicationEpoch
      ) {
        return reject()
      }
      return true
    })
    const before = new Map(this.mobileSessionTabsByWorktree)
    this.restoreLivePairedRendererSessionOwnedMobileTerminals(null, {
      missingSnapshotOnly: true,
      notify: false
    })
    // Why: graph sync must scan each persisted host session once, not once per workspace.
    const worktreeSessionsToHydrate = new Map<string, WorkspaceSessionState | null>(
      this.getWorkspaceSessionHydrationTargets(Boolean(this.offscreenBrowserBackend))
    )
    if (this.offscreenBrowserBackend) {
      for (const snapshot of acceptedSnapshots) {
        if (!worktreeSessionsToHydrate.has(snapshot.worktree)) {
          worktreeSessionsToHydrate.set(snapshot.worktree, null)
        }
      }
    }
    // Why: an empty renderer publication after HUB restart must not hide SSH panes persisted in this HUB's host partition.
    for (const [worktreeId, workspaceSession] of worktreeSessionsToHydrate) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true,
        ...(workspaceSession ? { runtimeOwnedTerminalCandidateKnown: true, workspaceSession } : {})
      })
    }
    const nextWorktrees = new Set<string>()
    const incomingWorktreeIds = new Set(acceptedSnapshots.map((snapshot) => snapshot.worktree))
    for (const worktreeId of blockedRecreatedWorktreeIds) {
      nextWorktrees.add(worktreeId)
    }
    // Why: the renderer withholds unchanged snapshots to keep the graph payload
    // small, so these worktrees are still live and must not fall into the prune
    // below. Ask for a republish when main no longer holds that accepted renderer
    // publication or a formerly-preserved runtime tab has gone stale.
    for (const worktreeId of unchangedWorktreeIds ?? []) {
      const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
      const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(worktreeId)
      if (existing) {
        nextWorktrees.add(worktreeId)
      }
      // Why: a headless-authored layout is host-owned; a renderer that merely
      // withheld this worktree never saw it. Asking for a republish would only
      // replay the renderer's stale frame and collapse the host's groups.
      if (existing && this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)) {
        continue
      }
      // Why: a fenced frame stays "published" renderer-side; asking for a
      // republish would only be fenced again on every sync.
      if (!existing && this.removedMobileSessionWorktreeIds.get(worktreeId)?.rejectedPublication) {
        nextWorktrees.add(worktreeId)
        continue
      }
      if (
        existing &&
        accepted &&
        (existing.publicationEpoch === accepted.publicationEpoch ||
          existing.publicationEpoch.startsWith(`${accepted.publicationEpoch}:headless-merge:`)) &&
        existing.tabs.length >= accepted.rendererTabCount &&
        (existing.tabs.length === accepted.rendererTabCount ||
          !this.storedMobileSnapshotHasStalePreservedTab(
            existing,
            accepted.rendererTabIdentityKeys
          ))
      ) {
        continue
      }
      if (!incomingWorktreeIds.has(worktreeId)) {
        resyncWorktreeIds.add(worktreeId)
      }
      // Why: the accept gate compares against the renderer's last accepted pair,
      // which outlives the dropped snapshot and would reject the republish.
      this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
    }
    for (const snapshot of acceptedSnapshots) {
      nextWorktrees.add(snapshot.worktree)
      const existing = this.mobileSessionTabsByWorktree.get(snapshot.worktree)
      // Why: a renderer frame can beat the first list/hydrate. The persisted
      // layout is still host-authored, but projecting its tabs here would
      // resurrect tabs the renderer owns, so only the layout is adopted.
      const persistedHostLayout =
        existing === undefined
          ? this.getPersistedMobileSessionHostLayout(snapshot.worktree)
          : undefined
      const hostLayoutBase = existing ?? persistedHostLayout
      // Why: judge renderer publication ordering against the renderer's own
      // last-accepted (epoch, version) — the renderer reuses one pair for
      // byte-identical content, so a same-epoch version <= the accepted one is
      // a no-op resend (or a stale frame) and must be skipped. Never compare
      // against the stored snapshot's version: main-local touches bump it
      // independently and would reject genuinely newer renderer revisions.
      const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(snapshot.worktree)
      if (
        accepted &&
        accepted.publicationEpoch === snapshot.publicationEpoch &&
        snapshot.snapshotVersion <= accepted.rendererVersion &&
        // Why: preservation is main-only state — a serve/SSH binding (or live
        // browser page) can disappear without the renderer bumping its version,
        // so a resend of the EXACT accepted revision (content-identical to the
        // accepted publication, safe to re-merge) must still fall through to
        // the merge, which prunes stale preserved tabs. Strictly-older frames
        // stay skipped: their content is outdated, and the next accepted-pair
        // resend performs the prune.
        !(
          existing &&
          snapshot.snapshotVersion === accepted.rendererVersion &&
          this.storedMobileSnapshotHasStalePreservedTab(existing, accepted.rendererTabIdentityKeys)
        )
      ) {
        continue
      }
      this.nativeChatDraftResolutions.reconcile(snapshot)
      const launchDraftFencedSnapshot = this.nativeChatDraftResolutions.applyFence(snapshot)
      const fencedSnapshot = this.applyMobileSessionRetirementFences(launchDraftFencedSnapshot)
      this.releaseRuntimeSessionOwnershipForRendererRetiredTabs(fencedSnapshot, existing)
      const mergedSnapshot = this.mergePreservedHeadlessMobileSessionTabs(fencedSnapshot, existing)
      // Why: within one generation, the digest (not the shape) tells a
      // content-only resend from a same-shape member/order change. Across a
      // renderer reload versions are incomparable, so the first frame is the new
      // generation's baseline and only a different tree takes over.
      const rawLayoutSignature = getMobileSessionTabGroupLayoutSignature(snapshot)
      const rawLayoutDigest = getMobileSessionAuthoredLayoutDigest(snapshot)
      const sameGeneration =
        accepted !== undefined && accepted.publicationEpoch === snapshot.publicationEpoch
      const shapeMatches =
        accepted !== undefined && rawLayoutSignature === accepted.rendererTabGroupLayoutSignature
      const digestMatches =
        accepted === undefined
          ? false
          : accepted.rendererAuthoredLayoutDigest === undefined
            ? shapeMatches
            : accepted.rendererAuthoredLayoutDigest === rawLayoutDigest
      // Why: on first open the accepted baseline is the host layout, so a
      // content/focus resend from the still-stale renderer compares unequal.
      // Keep the raw first-frame digest: only a raw layout change is takeover.
      const rendererLayoutUnchangedSinceHostPreservation =
        accepted !== undefined &&
        accepted.hostLayoutAuthorityPending === true &&
        accepted.rendererRawLayoutDigest !== undefined &&
        accepted.rendererRawLayoutDigest === rawLayoutDigest
      // Why: a fresh process has no accepted publication, but a persisted host
      // split is still host-authored layout. A serve-only hydrate synthesizes
      // one throwaway group, where the desktop renderer is the first real author.
      const hostLayoutIsHeadlessAuthored =
        existing !== undefined
          ? this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)
          : persistedHostLayout !== undefined
      const firstOpenHostLayoutAuthority =
        accepted === undefined &&
        hostLayoutBase !== undefined &&
        hostLayoutIsHeadlessAuthored &&
        ((hostLayoutBase.tabGroups?.length ?? 0) > 1 || hostLayoutBase.tabGroupLayout !== undefined)
      const preserveHostLayout =
        hostLayoutBase !== undefined &&
        (firstOpenHostLayoutAuthority ||
          (accepted !== undefined &&
            hostLayoutIsHeadlessAuthored &&
            (rendererLayoutUnchangedSinceHostPreservation ||
              (sameGeneration ? digestMatches : shapeMatches))))
      // Why: focus is adopted as a pair. A group that is not live in the host
      // tree, or an incoming active tab the group does not hold, would highlight
      // a group the tab is not in — keep the host's focus instead.
      // Why fencedSnapshot: a tab retired by a fence must not license its group.
      const incomingActiveTabTopLevelId =
        typeof fencedSnapshot.activeTabId === 'string' && fencedSnapshot.activeTabId.length > 0
          ? (this.resolveMobileSessionHostTabId(fencedSnapshot, fencedSnapshot.activeTabId) ??
            fencedSnapshot.activeTabId)
          : null
      const adoptIncomingActiveGroupId =
        fencedSnapshot.activeGroupId !== null &&
        hostLayoutBase !== undefined &&
        this.isApplicableHeadlessTabGroupTarget(hostLayoutBase, fencedSnapshot.activeGroupId) &&
        incomingActiveTabTopLevelId !== null &&
        (hostLayoutBase.tabGroups ?? []).some(
          (group) =>
            group.id === fencedSnapshot.activeGroupId &&
            group.tabOrder.length > 0 &&
            group.tabOrder.includes(incomingActiveTabTopLevelId)
        )
      const nextSnapshot = preserveHostLayout
        ? {
            ...mergedSnapshot,
            // Keep host ownership of the layout: the renderer still has to
            // author a changed layout before its groups take over.
            publicationEpoch:
              existing?.publicationEpoch ?? `headless-hydrated:${Date.now().toString(36)}`,
            tabGroups: hostLayoutBase.tabGroups,
            tabGroupLayout: hostLayoutBase.tabGroupLayout,
            activeGroupId: adoptIncomingActiveGroupId
              ? fencedSnapshot.activeGroupId
              : existing !== undefined
                ? existing.activeGroupId
                : mergedSnapshot.activeGroupId,
            // Why paired: a rejected focus must not leave any renderer frame
            // field behind, or the stored pair can name a tab outside the group.
            // A layout-only baseline has no tabs, so the incoming pair stands.
            activeTabId: adoptIncomingActiveGroupId
              ? mergedSnapshot.activeTabId
              : existing !== undefined
                ? existing.activeTabId
                : mergedSnapshot.activeTabId,
            activeTabType: adoptIncomingActiveGroupId
              ? mergedSnapshot.activeTabType
              : existing !== undefined
                ? existing.activeTabType
                : mergedSnapshot.activeTabType
          }
        : mergedSnapshot
      // Why: clients drop same-epoch frames whose version isn't strictly newer,
      // and main-local touches may already have emitted a higher version than
      // the renderer's counter — keep the stored version strictly monotonic so
      // the accepted content is never discarded as stale downstream.
      const storedVersion = existing
        ? Math.max(nextSnapshot.snapshotVersion, existing.snapshotVersion + 1)
        : nextSnapshot.snapshotVersion
      this.storeMobileSessionSnapshot(
        snapshot.worktree,
        storedVersion === nextSnapshot.snapshotVersion
          ? nextSnapshot
          : { ...nextSnapshot, snapshotVersion: storedVersion }
      )
      // Why: on first open there is no prior renderer baseline, and the frame
      // just failed to supersede the host layout — record the host layout as the
      // baseline so the renderer's own stale tree is never treated as authored.
      // The raw frame is kept alongside it (and survives every preserved resend)
      // so a content/focus-only frame cannot be mistaken for a layout takeover.
      const preservedRawLayoutSignature = firstOpenHostLayoutAuthority
        ? rawLayoutSignature
        : rendererLayoutUnchangedSinceHostPreservation
          ? accepted?.rendererRawLayoutSignature
          : undefined
      const preservedRawLayoutDigest = firstOpenHostLayoutAuthority
        ? rawLayoutDigest
        : rendererLayoutUnchangedSinceHostPreservation
          ? accepted?.rendererRawLayoutDigest
          : undefined
      const keepHostLayoutAuthority =
        hostLayoutBase !== undefined &&
        (firstOpenHostLayoutAuthority || rendererLayoutUnchangedSinceHostPreservation) &&
        preservedRawLayoutSignature !== undefined &&
        preservedRawLayoutDigest !== undefined
      const acceptedLayoutBase = keepHostLayoutAuthority ? hostLayoutBase : snapshot
      this.acceptedRendererMobileSnapshotByWorktree.set(snapshot.worktree, {
        publicationEpoch: snapshot.publicationEpoch,
        rendererVersion: snapshot.snapshotVersion,
        rendererTabCount: fencedSnapshot.tabs.length,
        rendererTabIdentityKeys: new Set(
          fencedSnapshot.tabs.flatMap((tab) => getMobileSessionSnapshotTabIdentityKeys(tab))
        ),
        rendererTabGroupLayoutSignature:
          getMobileSessionTabGroupLayoutSignature(acceptedLayoutBase),
        // Why: the raw frame (or host base on first open), so host-preserved
        // tabs never enter the renderer-authored digest.
        rendererAuthoredLayoutDigest: getMobileSessionAuthoredLayoutDigest(acceptedLayoutBase),
        ...(keepHostLayoutAuthority
          ? {
              rendererRawLayoutSignature: preservedRawLayoutSignature,
              rendererRawLayoutDigest: preservedRawLayoutDigest,
              hostLayoutAuthorityPending: true
            }
          : {})
      })
    }
    for (const [worktreeId, existing] of [...this.mobileSessionTabsByWorktree.entries()]) {
      if (!nextWorktrees.has(worktreeId)) {
        const preserved = this.buildPreservedHeadlessMobileSessionSnapshot(existing)
        if (preserved) {
          // Why: preservation filters existing.tabs in place (same objects) and
          // the merge epoch hashes the preserved identities idempotently, so an
          // equal epoch with every tab object retained means the recomputation
          // was a no-op — keep the entry so no-op syncs don't fan out.
          const preservedIsNoOp =
            preserved.publicationEpoch === existing.publicationEpoch &&
            preserved.tabs.length === existing.tabs.length &&
            preserved.tabs.every((tab, index) => tab === existing.tabs[index])
          if (!preservedIsNoOp) {
            this.storeMobileSessionSnapshot(worktreeId, preserved)
          }
          // Why: the stored entry is no longer the renderer's publication, so a
          // future renderer frame must be re-merged even if it reuses the pair.
          this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
          nextWorktrees.add(worktreeId)
        } else {
          this.mobileSessionTabsByWorktree.delete(worktreeId)
          this.mobileSessionTabsAgentStatusHeartbeat.removeWorktree(worktreeId)
          this.acceptedRendererMobileSnapshotByWorktree.delete(worktreeId)
          // Why: drop any pending coalesced notify so a stale snapshot can't land after the removed frame.
          this.cancelScheduledMobileSessionTabsChanged(worktreeId)
          this.notifyMobileSessionTabsRemoved(worktreeId)
        }
      }
    }
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      if (before.get(worktreeId) !== snapshot) {
        changedWorktreeIds.add(worktreeId)
      }
    }
    return changedWorktreeIds
  }

  // Why: a renderer frame can beat the first list/hydrate. The persisted split
  // is still host-authored, but projecting its tabs here would resurrect tabs
  // the renderer owns, so only the layout is adopted — and only a real split,
  // matching the hydrate criterion that restores persisted groups.
  protected getPersistedMobileSessionHostLayout(
    worktreeId: string
  ): Pick<RuntimeMobileSessionTabsSnapshot, 'tabGroups' | 'tabGroupLayout'> | undefined {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    const tabGroups = session?.tabGroups?.[worktreeId]
    if ((tabGroups?.length ?? 0) <= 1) {
      return undefined
    }
    return {
      tabGroups: tabGroups?.map((group) => ({
        id: group.id,
        activeTabId: group.activeTabId,
        tabOrder: [...group.tabOrder],
        ...(group.recentTabIds ? { recentTabIds: [...group.recentTabIds] } : {})
      })),
      tabGroupLayout: session?.tabGroupLayouts?.[worktreeId]
    }
  }
}
