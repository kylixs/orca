/**
 * U138: a headless/cloud host has two sources of the active tab — the live in-memory snapshot
 * (which an explicit `session.tabs.activate` updates) and the persisted workspace session (which
 * terminal.create writes at focus time). Without a renderer window to republish focus, the host
 * must persist an explicit activation, or a rebuild restores the create-time tab instead.
 *
 * Precondition reproduced here: the active tab (tab-a) differs from the last focused-created tab
 * (tab-b). `session.tabs.activate` reaches this path as `activateMobileSessionTab` → the
 * headless activation branch; the methods below are that branch's two steps.
 */
import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { publishHeadlessRuntimeGraph } from './headless-runtime-graph'

const WT = 'repo-1::/tmp/worktree-a'

const storeBase = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [storeBase.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

function makeTerminalTab(id: string, sortOrder: number) {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: WT,
    title: `Terminal ${id}`,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

function makeSession(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

function createRuntime(initialSession: WorkspaceSessionState) {
  let session = initialSession
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  })
  return { runtime, getSession: () => session }
}

type RuntimeActivationInternals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  shouldPersistHeadlessMobileSessionActivation(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean
  activateHeadlessMobileSessionTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab
  ): void
}

/** The production headless branch of `session.tabs.activate` (see perform-mobile-session-pty-records-refresh). */
function activateExplicitlyOnHost(
  internals: RuntimeActivationInternals,
  worktreeId: string,
  tabId: string
): void {
  const snapshot = internals.mobileSessionTabsByWorktree.get(worktreeId)
  const tab = snapshot?.tabs.find(
    (candidate): candidate is RuntimeMobileSessionTerminalTab =>
      candidate.type === 'terminal' && candidate.id === tabId
  )
  if (!snapshot || !tab) {
    throw new Error('tab_not_found')
  }
  if (internals.shouldPersistHeadlessMobileSessionActivation(snapshot, tab)) {
    internals.activateHeadlessMobileSessionTerminalTab(worktreeId, snapshot, tab)
  }
}

function staleCreateTimeSession(): WorkspaceSessionState {
  return makeSession({
    activeTabId: 'tab-b',
    // create-time focused write (the last created tab), not the user's later selection.
    activeTabIdByWorktree: { [WT]: 'tab-b' },
    tabsByWorktree: { [WT]: [makeTerminalTab('tab-a', 0), makeTerminalTab('tab-b', 1)] }
  })
}

describe('mobile session active tab persistence authority (U138)', () => {
  it('persists an explicit activation even when a renderer graph never republishes focus', async () => {
    const { runtime } = createRuntime(staleCreateTimeSession())
    publishHeadlessRuntimeGraph(runtime)
    await runtime.listMobileSessionTabs(`id:${WT}`)

    const internals = runtime as unknown as RuntimeActivationInternals
    const snapshot = internals.mobileSessionTabsByWorktree.get(WT)
    const activeTerminal = snapshot?.tabs.find(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal' && tab.isActive
    )
    expect(activeTerminal?.parentTabId).toBe('tab-b')
    const tabA = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
        candidate.type === 'terminal' && candidate.parentTabId === 'tab-a'
    )
    expect(tabA).toBeDefined()
    // A headless host has no writable renderer window, so the host must own persistence.
    expect(internals.shouldPersistHeadlessMobileSessionActivation(snapshot!, tabA!)).toBe(true)
  })

  it('restores the explicitly activated tab, not the create-time tab, after a host rebuild', async () => {
    const { runtime, getSession } = createRuntime(staleCreateTimeSession())
    publishHeadlessRuntimeGraph(runtime)
    await runtime.listMobileSessionTabs(`id:${WT}`)
    const internals = runtime as unknown as RuntimeActivationInternals
    const tabA = internals.mobileSessionTabsByWorktree
      .get(WT)
      ?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' && candidate.parentTabId === 'tab-a'
      )
    expect(tabA).toBeDefined()

    activateExplicitlyOnHost(internals, WT, tabA!.id)

    // The explicit activate must win over the older create-time write in the durable session.
    expect(getSession().activeTabIdByWorktree?.[WT]).toBe('tab-a')

    // A fresh runtime over the same durable session is the reload/restart path.
    const { runtime: restarted } = createRuntime(getSession())
    publishHeadlessRuntimeGraph(restarted)
    const restored = await restarted.listMobileSessionTabs(`id:${WT}`)
    const restoredSnapshot = (restarted as unknown as RuntimeActivationInternals)
      .mobileSessionTabsByWorktree.get(WT)

    expect(
      restoredSnapshot?.tabs.find(
        (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal' && tab.isActive
      )?.parentTabId
    ).toBe('tab-a')
    expect(restored.tabGroups?.[0]?.activeTabId).toBe('tab-a')
    expect(String(restored.activeTabId)).toMatch(/^tab-a::/)
  })
})
