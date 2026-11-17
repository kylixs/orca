/**
 * U161: a host-authoritative frame that predates the client's optimistic create must not steal
 * the new tab. The in-flight gesture is tracked per worktree, so the host-active follow stands
 * down until the create reply records its focus intent.
 *
 * The apply options are resolved through the real `resolveHostActiveApplyOptions`, so these pins
 * fail if the worktree gesture stops suppressing host authority.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import type { Tab } from '../../../../shared/tab-types'
import {
  consumeUserInitiatedTerminalCreate,
  markUserInitiatedTerminalCreate
} from '../web-session-user-initiated-create'
import { peekWebSessionFocusIntent, recordWebSessionFocusIntent } from '../web-session-focus-intent'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import { decideWebSessionTabsSnapshot } from './tracking-decisions'
import { resolveHostActiveApplyOptions } from './host-active-apply-options'
import type { WebSessionTabsSyncState } from './state'
import {
  ENV,
  NOW,
  WT,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'

const GROUP_ID = 'group-main'
const OLD_HOST = 'old-host'
const NEW_HOST = 'new-host'
const OLD_LEAF = '11111111-1111-4111-8111-111111111111'
const NEW_LEAF = '22222222-2222-4222-8222-222222222222'
const OLD_TAB = toWebTerminalSurfaceTabId(OLD_HOST)
const NEW_TAB = toWebTerminalSurfaceTabId(NEW_HOST)
// The click mints a bare UUID; the host create reply carries the same id, so the mirror rekey lands on `NEW_TAB`.
const PROVISIONAL_ID = NEW_HOST

function localTerminal(id: string, sortOrder: number, ptyId: string | null) {
  const unified: Tab = {
    id,
    entityId: id,
    groupId: GROUP_ID,
    worktreeId: WT,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: NOW + sortOrder,
    isPreview: false,
    isPinned: false
  }
  return {
    id,
    unified,
    storeTab: {
      id,
      ptyId,
      worktreeId: WT,
      title: id,
      customTitle: null,
      color: null,
      sortOrder,
      createdAt: NOW + sortOrder
    }
  }
}

/** Store state after the click: the provisional tab is created and optimistically active. */
function stateAfterOptimisticCreate(): WebSessionTabsSyncState {
  const old = localTerminal(OLD_TAB, 0, `remote:${ENV}@@old-pty`)
  // The pane binds the create reply before the host publishes the surface, so the local row owns a PTY id.
  const provisional = localTerminal(PROVISIONAL_ID, 1, `remote:${ENV}@@new-pty`)
  return makeState({
    activeTabId: PROVISIONAL_ID,
    activeTabIdByWorktree: { [WT]: PROVISIONAL_ID },
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { [WT]: 'terminal' },
    activeGroupIdByWorktree: { [WT]: GROUP_ID },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: GROUP_ID } },
    tabsByWorktree: { [WT]: [old.storeTab, provisional.storeTab] },
    unifiedTabsByWorktree: { [WT]: [old.unified, provisional.unified] },
    tabBarOrderByWorktree: { [WT]: [OLD_TAB, PROVISIONAL_ID] },
    groupsByWorktree: {
      [WT]: [
        {
          id: GROUP_ID,
          worktreeId: WT,
          activeTabId: PROVISIONAL_ID,
          tabOrder: [OLD_TAB, PROVISIONAL_ID],
          recentTabIds: [PROVISIONAL_ID, OLD_TAB]
        }
      ]
    }
  })
}

function hostTerminal(
  hostTabId: string,
  leafId: string,
  isActive: boolean,
  terminal: string
): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'terminal',
    id: `${hostTabId}::${leafId}`,
    title: hostTabId,
    parentTabId: hostTabId,
    leafId,
    isActive,
    status: 'ready',
    terminal
  }
}

function hostFrame(args: {
  version: number
  activeHostTabId: string
  tabs: RuntimeMobileSessionTabsResult['tabs']
}): RuntimeMobileSessionTabsResult {
  const active = args.tabs.find(
    (tab) => tab.type === 'terminal' && tab.parentTabId === args.activeHostTabId
  )
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: args.version,
    activeGroupId: GROUP_ID,
    activeTabId: active?.id ?? null,
    activeTabType: 'terminal',
    tabs: args.tabs,
    tabGroups: [
      {
        id: GROUP_ID,
        activeTabId: args.activeHostTabId,
        tabOrder: args.tabs.flatMap((tab) => (tab.type === 'terminal' ? [tab.parentTabId] : []))
      }
    ],
    tabGroupLayout: { type: 'leaf', groupId: GROUP_ID }
  }
}

function resolveOptions(isCloudSession = true) {
  return resolveHostActiveApplyOptions({
    environmentId: ENV,
    worktreeId: WT,
    isCloudSession,
    pendingAdoption: false,
    hasHostGroups: true
  }).options
}

/** Mirrors the subscription: decide (consumes the version), then apply. */
function feedFrame(
  state: WebSessionTabsSyncState,
  frame: RuntimeMobileSessionTabsResult,
  isCloudSession = true
): { state: WebSessionTabsSyncState; applied: boolean } {
  const decision = decideWebSessionTabsSnapshot(frame, ENV)
  if (!decision.apply) {
    return { state, applied: false }
  }
  const patch = applyWebSessionTabsSnapshot(state, frame, ENV, NOW, resolveOptions(isCloudSession))
  return { state: { ...state, ...patch }, applied: true }
}

function activeGroupTabId(state: WebSessionTabsSyncState): string | null {
  return state.groupsByWorktree[WT]?.find((group) => group.id === GROUP_ID)?.activeTabId ?? null
}

function markCreateGesture(): void {
  markUserInitiatedTerminalCreate(PROVISIONAL_ID, WT, ENV)
}

function recordCreateIntent(expectedCurrentLocalTabId: string | null = PROVISIONAL_ID): void {
  recordWebSessionFocusIntent(
    { environmentId: ENV },
    WT,
    NEW_HOST,
    NEW_LEAF,
    expectedCurrentLocalTabId
  )
  consumeUserInitiatedTerminalCreate(PROVISIONAL_ID)
}

const OLD_ACTIVE_FRAME = hostFrame({
  version: 1,
  activeHostTabId: OLD_HOST,
  tabs: [hostTerminal(OLD_HOST, OLD_LEAF, true, 'old-pty')]
})

const NEW_ACTIVE_FRAME = hostFrame({
  version: 2,
  activeHostTabId: NEW_HOST,
  tabs: [
    hostTerminal(OLD_HOST, OLD_LEAF, false, 'old-pty'),
    hostTerminal(NEW_HOST, NEW_LEAF, true, 'new-pty')
  ]
})

describe('U161 optimistic create vs host-active authority', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps the just-created tab active through the pre-create frame and adopts its intent', () => {
    markCreateGesture()
    const early = feedFrame(stateAfterOptimisticCreate(), OLD_ACTIVE_FRAME)
    expect(early.applied).toBe(true)
    expect(
      early.state.activeTabIdByWorktree[WT],
      'the pre-create host active must not undo the optimistic tab'
    ).toBe(PROVISIONAL_ID)

    recordCreateIntent()
    const echoed = feedFrame(early.state, NEW_ACTIVE_FRAME)
    expect(echoed.applied).toBe(true)
    expect(echoed.state.activeTabIdByWorktree[WT]).toBe(NEW_TAB)
    expect(activeGroupTabId(echoed.state)).toBe(NEW_TAB)
  })

  it('follows the host active for a passive mount (no user create gesture)', () => {
    const adopted = feedFrame(stateAfterOptimisticCreate(), OLD_ACTIVE_FRAME)
    expect(
      adopted.state.activeTabIdByWorktree[WT],
      'without a gesture the host stays the active authority'
    ).toBe(OLD_TAB)
    expect(activeGroupTabId(adopted.state)).toBe(OLD_TAB)
  })

  it('never follows host active when the environment is not a cloud session', () => {
    markCreateGesture()
    const before = stateAfterOptimisticCreate()
    const patch = applyWebSessionTabsSnapshot(
      before,
      OLD_ACTIVE_FRAME,
      ENV,
      NOW,
      resolveOptions(false)
    )
    const after = { ...before, ...patch }
    expect(after.activeTabIdByWorktree[WT]).toBe(PROVISIONAL_ID)
    expect(activeGroupTabId(after)).toBe(PROVISIONAL_ID)
  })

  it('scopes the in-flight gesture to its environment when worktreeIds collide (R3)', () => {
    markCreateGesture()

    const ownOptions = resolveHostActiveApplyOptions({
      environmentId: ENV,
      worktreeId: WT,
      isCloudSession: true,
      pendingAdoption: false,
      hasHostGroups: true
    }).options
    const otherOptions = resolveHostActiveApplyOptions({
      environmentId: 'other-environment',
      worktreeId: WT,
      isCloudSession: true,
      pendingAdoption: false,
      hasHostGroups: true
    }).options

    expect(ownOptions, 'the gesture owns its own environment').toBeUndefined()
    expect(
      otherOptions,
      'another environment with the same worktreeId must keep following host active'
    ).toEqual({ hostActiveAuthoritative: true })
  })

  it('cancels the intent when the user switches to a third tab during the round trip (U154)', () => {
    markCreateGesture()
    const early = feedFrame(stateAfterOptimisticCreate(), OLD_ACTIVE_FRAME)
    recordCreateIntent()
    const switched: WebSessionTabsSyncState = {
      ...early.state,
      activeTabIdByWorktree: { [WT]: OLD_TAB },
      activeGroupIdByWorktree: { [WT]: GROUP_ID },
      groupsByWorktree: {
        [WT]: (early.state.groupsByWorktree[WT] ?? []).map((group) => ({
          ...group,
          activeTabId: OLD_TAB
        }))
      }
    }

    const firstReject = feedFrame(switched, NEW_ACTIVE_FRAME)
    expect(firstReject.applied).toBe(true)
    expect(
      peekWebSessionFocusIntent({ environmentId: ENV }, WT),
      'a single rejected frame keeps the intent armed (U161)'
    ).not.toBeNull()

    const secondReject = feedFrame(firstReject.state, NEW_ACTIVE_FRAME)
    expect(secondReject.applied, 'the deferred frame stays replayable').toBe(true)
    expect(
      peekWebSessionFocusIntent({ environmentId: ENV }, WT),
      'a second rejection means the user moved away, so the intent cancels'
    ).toBeNull()
    expect(secondReject.state.activeTabIdByWorktree[WT]).toBe(OLD_TAB)
  })

  it('does not leave the intent permanently unhandled after a rejected frame', () => {
    markCreateGesture()
    const early = feedFrame(stateAfterOptimisticCreate(), OLD_ACTIVE_FRAME)
    recordCreateIntent()

    // The user is on another tab when the intent frame lands, so the guard defers the intent.
    const elsewhere: WebSessionTabsSyncState = {
      ...early.state,
      activeTabIdByWorktree: { [WT]: OLD_TAB },
      groupsByWorktree: {
        [WT]: (early.state.groupsByWorktree[WT] ?? []).map((group) => ({
          ...group,
          activeTabId: OLD_TAB
        }))
      }
    }
    const rejected = feedFrame(elsewhere, NEW_ACTIVE_FRAME)
    expect(rejected.applied).toBe(true)
    expect(peekWebSessionFocusIntent({ environmentId: ENV }, WT)).not.toBeNull()

    // The rejected frame stays replayable; the second rejection retires the stale intent.
    const replay = feedFrame(rejected.state, NEW_ACTIVE_FRAME)
    expect(replay.applied, 'the rejected intent frame must not burn the version').toBe(true)
    expect(peekWebSessionFocusIntent({ environmentId: ENV }, WT)).toBeNull()

    // Host authority is live again instead of the intent pinning it forever.
    const later = feedFrame(
      replay.state,
      hostFrame({
        version: 3,
        activeHostTabId: OLD_HOST,
        tabs: [
          hostTerminal(OLD_HOST, OLD_LEAF, true, 'old-pty'),
          hostTerminal(NEW_HOST, NEW_LEAF, false, 'new-pty')
        ]
      })
    )
    expect(later.applied).toBe(true)
    expect(later.state.activeTabIdByWorktree[WT]).toBe(OLD_TAB)
    expect(activeGroupTabId(later.state)).toBe(OLD_TAB)
  })

  it('exposes the adopted tab on every user-visible surface', () => {
    markCreateGesture()
    const early = feedFrame(stateAfterOptimisticCreate(), OLD_ACTIVE_FRAME)
    recordCreateIntent()
    const echoed = feedFrame(early.state, NEW_ACTIVE_FRAME)

    const visibleTabs = echoed.state.unifiedTabsByWorktree[WT] ?? []
    // Group row (rendered strip), store active row, and the per-worktree visible type.
    expect(activeGroupTabId(echoed.state)).toBe(NEW_TAB)
    expect(echoed.state.activeTabIdByWorktree[WT]).toBe(NEW_TAB)
    expect(echoed.state.activeTabTypeByWorktree[WT]).toBe('terminal')
    expect(echoed.state.tabBarOrderByWorktree[WT]).toContain(NEW_TAB)
    expect(visibleTabs.find((tab) => tab.id === NEW_TAB)?.groupId).toBe(GROUP_ID)
  })
})
