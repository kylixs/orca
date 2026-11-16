// @vitest-environment happy-dom
/**
 * U161 user-visible-face pin: after the create echo, the group row, the store active tab, and
 * the rendered tab strip all point at the new tab — not only the host projection.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalController } from '../../components/use-terminal-controller'

const store = vi.hoisted(() => {
  let state: Record<string, unknown> = {}
  return {
    replace: (next: Record<string, unknown>) => {
      state = next
    },
    current: () => state,
    useAppStore: Object.assign(
      (selector: (value: Record<string, unknown>) => unknown) => selector(state),
      {
        getState: () => state,
        setState: (next: Record<string, unknown>) => {
          state = { ...state, ...next }
        }
      }
    )
  }
})

vi.mock('../../store', () => ({ useAppStore: store.useAppStore }))
vi.mock('../../components/tab-bar/TabBar', () => ({
  default: (props: {
    tabs: { id: string }[]
    activeTabId: string | null
    tabBarOrder?: string[]
  }) => (
    <div>
      {(props.tabBarOrder ?? props.tabs.map((tab) => tab.id)).map((tabId) => (
        <div key={tabId} data-tab-id={tabId} data-active={String(props.activeTabId === tabId)} />
      ))}
    </div>
  )
}))

import { TerminalTitlebarTabs } from '../../components/TerminalTitlebarTabs'
import {
  consumeUserInitiatedTerminalCreate,
  markUserInitiatedTerminalCreate
} from '../web-session-user-initiated-create'
import { recordWebSessionFocusIntent } from '../web-session-focus-intent'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
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
const PROVISIONAL_ID = NEW_HOST

function localTerminal(id: string, sortOrder: number, ptyId: string) {
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

function optimisticState(): WebSessionTabsSyncState {
  const old = localTerminal(OLD_TAB, 0, `remote:${ENV}@@old-pty`)
  const provisional = localTerminal(PROVISIONAL_ID, 1, `remote:${ENV}@@new-pty`)
  return makeState({
    activeTabId: PROVISIONAL_ID,
    activeTabIdByWorktree: { [WT]: PROVISIONAL_ID },
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

function hostFrame(version: number, activeHostTabId: string): RuntimeMobileSessionTabsResult {
  const terminal = (hostTabId: string, leafId: string) => ({
    type: 'terminal' as const,
    id: `${hostTabId}::${leafId}`,
    title: hostTabId,
    parentTabId: hostTabId,
    leafId,
    isActive: hostTabId === activeHostTabId,
    status: 'ready' as const,
    terminal: `${hostTabId === OLD_HOST ? 'old' : 'new'}-pty`
  })
  const tabs = [terminal(OLD_HOST, OLD_LEAF), terminal(NEW_HOST, NEW_LEAF)]
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: version,
    activeGroupId: GROUP_ID,
    activeTabId: tabs.find((tab) => tab.isActive)?.id ?? null,
    activeTabType: 'terminal',
    tabs: version === 1 ? tabs.slice(0, 1) : tabs,
    tabGroups: [
      {
        id: GROUP_ID,
        activeTabId: activeHostTabId,
        tabOrder: version === 1 ? [OLD_HOST] : [OLD_HOST, NEW_HOST]
      }
    ],
    tabGroupLayout: { type: 'leaf', groupId: GROUP_ID }
  }
}

function options() {
  return resolveHostActiveApplyOptions({
    environmentId: ENV,
    worktreeId: WT,
    isCloudSession: true,
    pendingAdoption: false,
    hasHostGroups: true
  }).options
}

function apply(
  state: WebSessionTabsSyncState,
  frame: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(state, frame, ENV, NOW, options())
  return { ...state, ...patch }
}

function renderStrip(state: WebSessionTabsSyncState): HTMLElement {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock store only serves the seeded sync slice; component selectors read tabsByWorktree.
  store.replace(state as unknown as Record<string, unknown>)
  const target = document.createElement('div')
  const container = document.createElement('div')
  document.body.append(target, container)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture supplies only the controller fields the titlebar strip reads.
  const controller = {
    activeBrowserTabId: null,
    activeFileId: null,
    activeTabId: state.activeTabIdByWorktree[WT] ?? null,
    activeTabType: 'terminal',
    effectiveActiveLayout: null,
    expandedPaneByTabId: {},
    handleActivateBrowserTab: vi.fn(),
    handleActivateTab: vi.fn(),
    handleCloseAllFiles: vi.fn(),
    handleCloseBrowserTab: vi.fn(),
    handleCloseFile: vi.fn(),
    handleCloseOthers: vi.fn(),
    handleCloseTab: vi.fn(),
    handleCloseTabsToLeft: vi.fn(),
    handleCloseTabsToRight: vi.fn(),
    handleDuplicateBrowserTab: vi.fn(),
    handleNewBrowserTab: vi.fn(),
    handleNewFile: vi.fn(),
    handleNewSimulatorTab: vi.fn(),
    handleNewTab: vi.fn(),
    handleOpenEntry: vi.fn(),
    handleTogglePaneExpand: vi.fn(),
    makePreviewFilePermanent: vi.fn(),
    mobileEmulatorEnabled: false,
    pinFile: vi.fn(),
    renderedActiveWorktreeId: WT,
    setActiveFile: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabColor: vi.fn(),
    setTabCustomTitle: vi.fn(),
    tabBarOrder: state.tabBarOrderByWorktree[WT] ?? [],
    titlebarTabsTarget: target,
    worktreeBrowserTabs: [],
    worktreeClientHostedBrowserRows: [],
    worktreeFiles: []
  } as unknown as TerminalController
  const root = createRoot(container)
  act(() => root.render(<TerminalTitlebarTabs controller={controller} />))
  return target
}

describe('U161 visible tab strip', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('renders the new tab active after the create echo', () => {
    markUserInitiatedTerminalCreate(PROVISIONAL_ID, WT)
    let state = apply(optimisticState(), hostFrame(1, OLD_HOST))
    recordWebSessionFocusIntent({ environmentId: ENV }, WT, NEW_HOST, NEW_LEAF, PROVISIONAL_ID)
    consumeUserInitiatedTerminalCreate(PROVISIONAL_ID)
    state = apply(state, hostFrame(2, NEW_HOST))

    const strip = renderStrip(state)
    const activeRow = strip.querySelector('[data-active="true"]')
    expect(state.activeTabIdByWorktree[WT]).toBe(NEW_TAB)
    expect(state.groupsByWorktree[WT]?.find((group) => group.id === GROUP_ID)?.activeTabId).toBe(
      NEW_TAB
    )
    expect(activeRow?.getAttribute('data-tab-id')).toBe(NEW_TAB)
    expect(strip.querySelectorAll('[data-active="true"]')).toHaveLength(1)
  })
})
