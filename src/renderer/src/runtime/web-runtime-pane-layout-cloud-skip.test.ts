import { afterEach, describe, expect, it, vi } from 'vitest'
import { updateWebRuntimePaneLayout } from './web-runtime-terminal-actions'

const WORKTREE_ID = 'repo::/worktree'

type EnvRow = { id: string; cloudProject?: { projectId: string }; cloudLoginRequired?: boolean }

const storeState: { runtimeEnvironments?: EnvRow[] } = {}
let environmentId: string

vi.mock('../store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('../lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => environmentId
}))

const LAYOUT = {
  worktreeId: WORKTREE_ID,
  tabId: 'host-tab-1',
  root: { type: 'leaf' as const, leafId: 'leaf-a' },
  expandedLeafId: null
}

function stubCall(): ReturnType<typeof vi.fn> {
  const runtimeCall = vi.fn().mockResolvedValue({ id: 'p', ok: true, result: { updated: true } })
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })
  return runtimeCall
}

describe('updateWebRuntimePaneLayout on a cloud session (U119)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    storeState.runtimeEnvironments = undefined
  })

  it('sends no updatePaneLayout RPC for a cloud project row', async () => {
    environmentId = 'env-cloud'
    storeState.runtimeEnvironments = [{ id: environmentId, cloudProject: { projectId: 'proj' } }]
    const runtimeCall = stubCall()

    await expect(updateWebRuntimePaneLayout(LAYOUT)).resolves.toBe(true)
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('sends no updatePaneLayout RPC for a spent-ticket web row', async () => {
    environmentId = 'env-cloud-ticket'
    storeState.runtimeEnvironments = [{ id: environmentId, cloudLoginRequired: true }]
    const runtimeCall = stubCall()

    await expect(updateWebRuntimePaneLayout(LAYOUT)).resolves.toBe(true)
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('still pushes the layout for a native host', async () => {
    environmentId = 'env-native'
    storeState.runtimeEnvironments = [{ id: environmentId }]
    const runtimeCall = stubCall()

    await expect(updateWebRuntimePaneLayout(LAYOUT)).resolves.toBe(true)
    expect(runtimeCall).toHaveBeenCalledOnce()
    expect(runtimeCall.mock.calls[0][0].method).toBe('session.tabs.updatePaneLayout')
  })
})
