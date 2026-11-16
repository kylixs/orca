/**
 * U138 phase 8: every mounted pane (including hidden ones) mirror-attaches through
 * `session.tabs.activate` with `navigation: 'caller'`. That attach must materialize the PTY but
 * must NOT be mistaken for user navigation, or the last hidden pane to attach becomes the
 * durable active tab and overwrites the device's own selection.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PersistedMobileClientTabSelections } from '../../shared/persisted-state-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_LEAF_ID } from './orca-runtime-test-fixtures.spec'

const WT = 'repo-1::/tmp/worktree-a'
const selector = `id:${WT}`

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

function makeSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: 'tab-1',
    activeTabIdByWorktree: { [WT]: 'tab-1' },
    tabsByWorktree: {
      [WT]: [
        {
          id: 'tab-1',
          ptyId: 'pty-a',
          worktreeId: WT,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        },
        {
          id: 'tab-2',
          ptyId: 'pty-b',
          worktreeId: WT,
          title: 'Terminal 2',
          customTitle: null,
          color: null,
          sortOrder: 1,
          createdAt: 2
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': 'pty-a' }
      },
      'tab-2': {
        root: { type: 'leaf', leafId: 'leaf-2' },
        activeLeafId: 'leaf-2',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-2': 'pty-b' }
      }
    }
  }
}

/** Both panes bound to live graph leaves, so activation takes the ready (persisting) branch. */
function makeRendererSnapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WT,
    publicationEpoch: 'renderer:test-epoch',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'tab-1::leaf-1',
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group-1', activeTabId: 'tab-1', tabOrder: ['tab-1', 'tab-2'] }],
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1::leaf-1',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        ptyId: 'pty-a',
        title: 'Terminal 1',
        isActive: true
      },
      {
        type: 'terminal',
        id: 'tab-2::leaf-2',
        parentTabId: 'tab-2',
        leafId: 'leaf-2',
        ptyId: 'pty-b',
        title: 'Terminal 2',
        isActive: false
      }
    ]
  }
}

function createRuntime(session = makeSession()) {
  let currentSession = session
  const persisted: { state: PersistedMobileClientTabSelections } = { state: {} }
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => currentSession,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      currentSession = next
    },
    getMobileClientTabSelections: () => persisted.state,
    setMobileClientTabSelections: (next: PersistedMobileClientTabSelections) => {
      persisted.state = next
    }
  } as never)
  const spawn = vi.fn(async () => ({ id: 'spawned-pty' }))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [
      { tabId: 'tab-1', worktreeId: WT, leafId: 'leaf-1', paneRuntimeId: 1, ptyId: 'pty-a' },
      { tabId: 'tab-2', worktreeId: WT, leafId: 'leaf-2', paneRuntimeId: 2, ptyId: 'pty-b' }
    ] as never,
    mobileSessionTabs: [makeRendererSnapshot()]
  })
  return { runtime, getSession: () => currentSession, persisted, spawn }
}

function mirrorAttach(
  runtime: OrcaRuntimeService,
  tabId: string,
  leafId: string,
  deviceId = 'device-a'
): ReturnType<OrcaRuntimeService['activateMobileSessionTab']> {
  return runtime.activateMobileSessionTab(selector, tabId, leafId, {
    notifyClients: false,
    navigation: 'caller',
    clientNavigationId: deviceId,
    persistSelection: false
  })
}

function userActivate(
  runtime: OrcaRuntimeService,
  tabId: string,
  leafId: string,
  deviceId = 'device-a'
): ReturnType<OrcaRuntimeService['activateMobileSessionTab']> {
  return runtime.activateMobileSessionTab(selector, tabId, leafId, {
    notifyClients: false,
    navigation: 'caller',
    clientNavigationId: deviceId
  })
}

describe('U138 phase 8: mirror attach is not navigation', () => {
  it('does not move the durable active tab or the device selection', async () => {
    const { runtime, getSession, persisted } = createRuntime()

    await userActivate(runtime, 'tab-2', 'leaf-2')
    expect(getSession().activeTabId).toBe('tab-2')
    expect(persisted.state['device-a']?.[WT]?.activeTabId).toBe('tab-2::leaf-2')

    const attached = await mirrorAttach(runtime, 'tab-1', 'leaf-1')

    expect(attached.activeTabId).toBe('tab-2::leaf-2')
    expect(getSession().activeTabId).toBe('tab-2')
    expect(getSession().activeTabIdByWorktree?.[WT]).toBe('tab-2')
    expect(persisted.state['device-a']?.[WT]?.activeTabId).toBe('tab-2::leaf-2')
    expect((await runtime.listMobileSessionTabs(selector, 'device-a')).activeTabId).toBe(
      'tab-2::leaf-2'
    )
  })

  it('keeps the active tab stable while every pane, hidden ones included, attaches', async () => {
    const { runtime, getSession } = createRuntime()

    await userActivate(runtime, 'tab-2', 'leaf-2')
    for (const [tabId, leafId] of [
      ['tab-1', 'leaf-1'],
      ['tab-2', 'leaf-2'],
      ['tab-1', 'leaf-1'],
      ['tab-2', 'leaf-2']
    ] as const) {
      await mirrorAttach(runtime, tabId, leafId)
      expect(getSession().activeTabId).toBe('tab-2')
      expect((await runtime.listMobileSessionTabs(selector, 'device-a')).activeTabId).toBe(
        'tab-2::leaf-2'
      )
    }
  })

  it('still materializes a pending mirror-attached pane', async () => {
    const session = makeSession()
    session.tabsByWorktree = {
      [WT]: [
        {
          id: 'tab-1',
          ptyId: 'serve-dead-pty',
          worktreeId: WT,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
    session.terminalLayoutsByTabId = {
      'tab-1': {
        root: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
        activeLeafId: HEADLESS_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [HEADLESS_LEAF_ID]: 'serve-dead-pty' }
      }
    }
    const { runtime, getSession, spawn } = createRuntime(session)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    // Why: the launch scope is orthogonal here; keep worktree resolution out of the assertion.
    vi.spyOn(
      runtime as unknown as {
        resolveTerminalWorkspaceLaunchScope(selector: string): Promise<unknown>
      },
      'resolveTerminalWorkspaceLaunchScope'
    ).mockResolvedValue({
      id: WT,
      path: '/tmp/worktree-a',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })

    await mirrorAttach(runtime, 'tab-1', HEADLESS_LEAF_ID)

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'serve-dead-pty', worktreeId: WT })
    )
    expect(getSession().activeTabId).toBe('tab-1')
  })
})
