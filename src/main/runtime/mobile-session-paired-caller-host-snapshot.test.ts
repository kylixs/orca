/**
 * U162: on a headless host `snapshot.activeTabId` is the durable host active a device with no
 * recorded selection resumes. A paired caller's activation persists that durable value, so the
 * in-memory snapshot must move with it or a new device reads a different tab.
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { publishHeadlessRuntimeGraph } from './headless-runtime-graph'
import { deriveHeadlessLegacyTerminalLeafId } from './mobile-session-layout-projection'

const WT = 'repo-1::/tmp/worktree-a'
const selector = `id:${WT}`

function leafOf(parentTabId: string): string {
  return deriveHeadlessLegacyTerminalLeafId(parentTabId)
}

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

function makeSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: 'tab-c',
    activeTabIdByWorktree: { [WT]: 'tab-c' },
    activeGroupIdByWorktree: { [WT]: 'group-1' },
    terminalLayoutsByTabId: {},
    tabsByWorktree: {
      [WT]: [makeTerminalTab('tab-a', 0), makeTerminalTab('tab-b', 1), makeTerminalTab('tab-c', 2)]
    },
    tabGroups: {
      [WT]: [
        {
          id: 'group-1',
          worktreeId: WT,
          activeTabId: 'tab-c',
          tabOrder: ['tab-a', 'tab-b', 'tab-c']
        }
      ]
    }
  }
}

type RuntimeInternals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
}

function createRuntime(initialSession: WorkspaceSessionState = makeSession()) {
  let session = initialSession
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  } as never)
  publishHeadlessRuntimeGraph(runtime)
  for (const id of ['tab-a', 'tab-b', 'tab-c']) {
    // Bind the spawn-time pane identity so the headless projection reads these as ready panes.
    runtime.registerPty(`pty-${id}`, WT, null, { tabId: id, leafId: leafOf(id) })
  }
  const snapshot = () =>
    (runtime as unknown as RuntimeInternals).mobileSessionTabsByWorktree.get(WT)
  return { runtime, getSession: () => session, snapshot }
}

function tabParent(snapshot: {
  activeTabId: string | null
  tabs: { id: string; parentTabId?: string }[]
}) {
  const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)
  return active?.parentTabId ?? active?.id ?? null
}

describe('U162 paired caller activation keeps the headless host snapshot in sync', () => {
  it('moves snapshot.activeTabId with the durable activation and a new device resumes it', async () => {
    const { runtime, getSession, snapshot } = createRuntime()
    await runtime.listMobileSessionTabs(selector)
    const before = snapshot()
    expect(before?.publicationEpoch).toMatch(/^headless-hydrated:/)
    expect(before?.activeTabId).toMatch(/^tab-c::/)

    const activated = await runtime.activateMobileSessionTab(selector, 'tab-b', undefined, {
      notifyClients: false,
      clientNavigationId: 'device-web',
      navigation: 'caller'
    })
    expect(activated.activeTabId).toMatch(/^tab-b::/)

    // The in-memory snapshot a new device resumes must agree with it.
    const after = snapshot()
    expect(after?.activeTabId).toMatch(/^tab-b::/)
    const activeGroup = after?.tabGroups?.find((group) => group.tabOrder.includes('tab-b'))
    expect(after?.activeGroupId).toBe(activeGroup?.id)
    expect(activeGroup?.activeTabId).toBe('tab-b')
    // Durable host active moved with the tap, including its group.
    expect(getSession().activeTabIdByWorktree?.[WT]).toBe('tab-b')
    expect(getSession().activeGroupIdByWorktree?.[WT]).toBe(activeGroup?.id)
    const activeTabs = after?.tabs.filter((tab) => tab.isActive) ?? []
    expect(activeTabs).toHaveLength(1)
    expect(activeTabs[0]).toMatchObject({ parentTabId: 'tab-b' })
    // Why: the headless/renderer publication owner keeps the epoch; only the active tab moves.
    expect(after?.publicationEpoch).toBe(before?.publicationEpoch)

    const hostView = await runtime.listMobileSessionTabs(selector)
    expect(hostView.activeTabId).toBe(after?.activeTabId)

    // New device with no recorded selection falls back to the host snapshot active (U138 line 91).
    const freshDevice = await runtime.listMobileSessionTabs(selector, 'device-new')
    expect(freshDevice.activeTabId).toBe(after?.activeTabId)
    expect(tabParent(freshDevice)).toBe('tab-b')
  })

  it('leaves another device projection on its own selection', async () => {
    const { runtime, snapshot } = createRuntime()
    await runtime.listMobileSessionTabs(selector)

    await runtime.activateMobileSessionTab(selector, 'tab-a', undefined, {
      notifyClients: false,
      clientNavigationId: 'device-b',
      navigation: 'caller'
    })
    await runtime.activateMobileSessionTab(selector, 'tab-b', undefined, {
      notifyClients: false,
      clientNavigationId: 'device-web',
      navigation: 'caller'
    })

    expect(tabParent(await runtime.listMobileSessionTabs(selector, 'device-b'))).toBe('tab-a')
    expect(tabParent(await runtime.listMobileSessionTabs(selector, 'device-web'))).toBe('tab-b')
    // The host snapshot follows the durable activation the last caller wrote.
    expect(tabParent(await runtime.listMobileSessionTabs(selector))).toBe('tab-b')
    expect(tabParent(snapshot()!)).toBe('tab-b')
  })

  it('never moves the headless snapshot for a mirror attach or materialize-only mount', async () => {
    const { runtime, getSession, snapshot } = createRuntime()
    await runtime.listMobileSessionTabs(selector)
    const before = snapshot()
    const sessionBefore = getSession()

    await runtime.activateMobileSessionTab(selector, 'tab-b', undefined, {
      notifyClients: false,
      navigation: 'caller',
      clientNavigationId: 'device-mirror',
      persistSelection: false
    })
    await runtime.activateMobileSessionTab(selector, 'tab-b', undefined, {
      notifyClients: false,
      navigation: 'caller',
      clientNavigationId: 'device-mount',
      materializeOnly: true
    })

    expect(getSession()).toBe(sessionBefore)
    expect(snapshot()).toBe(before)
    expect(before?.activeTabId).toMatch(/^tab-c::/)
  })

  it('leaves a renderer-published snapshot untouched while the activation stays durable', async () => {
    const { runtime, getSession, snapshot } = createRuntime()
    runtime.attachWindow(1)
    runtime.markGraphReady(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WT,
          publicationEpoch: 'renderer:host',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `tab-c::${leafOf('tab-c')}`,
          activeTabType: 'terminal',
          tabGroups: [
            { id: 'group-1', activeTabId: 'tab-c', tabOrder: ['tab-a', 'tab-b', 'tab-c'] }
          ],
          tabs: [
            {
              type: 'terminal' as const,
              id: `tab-a::${leafOf('tab-a')}`,
              parentTabId: 'tab-a',
              leafId: leafOf('tab-a'),
              ptyId: 'pty-tab-a',
              title: 'tab-a',
              isActive: false
            },
            {
              type: 'terminal' as const,
              id: `tab-b::${leafOf('tab-b')}`,
              parentTabId: 'tab-b',
              leafId: leafOf('tab-b'),
              ptyId: 'pty-tab-b',
              title: 'tab-b',
              isActive: false
            },
            {
              type: 'terminal' as const,
              id: `tab-c::${leafOf('tab-c')}`,
              parentTabId: 'tab-c',
              leafId: leafOf('tab-c'),
              ptyId: 'pty-tab-c',
              title: 'tab-c',
              isActive: true
            }
          ]
        }
      ]
    })
    const before = snapshot()

    await runtime.activateMobileSessionTab(selector, 'tab-b', undefined, {
      notifyClients: false,
      clientNavigationId: 'device-web',
      navigation: 'caller'
    })

    expect(getSession().activeTabIdByWorktree?.[WT]).toBe('tab-b')
    // The renderer owns the live publication, so the snapshot must not be reclassified.
    expect(snapshot()).toBe(before)
    expect(snapshot()?.activeTabId).toBe(`tab-c::${leafOf('tab-c')}`)
    expect(snapshot()?.publicationEpoch).toMatch(/^renderer:/)
  })
})
