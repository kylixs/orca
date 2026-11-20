// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'

const recover = vi.hoisted(() =>
  vi.fn(
    async (_state: unknown, snapshot: RuntimeMobileSessionTabsResult, _environmentId: string) =>
      snapshot
  )
)

vi.mock('../web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: recover
}))

import { loadInitialWebSessionTabs } from './load-initial'

const CLOUD_ENVIRONMENT_ID = 'cloud-u96'

function cloudSnapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'repo_1::/srv/work/payment-service/.orca-worktrees/zhangsan/main',
    tabs: [],
    tabGroups: [],
    activeTabId: null,
    activeGroupId: null
    // SAFETY: the listAll predicate only requires a snapshots array; recovery is mocked before use.
  } as unknown as RuntimeMobileSessionTabsResult
}

afterEach(() => {
  recover.mockClear()
  Object.assign(window, { api: undefined })
})

describe('cloud initial inventory orphan recovery (U96 A-5)', () => {
  it('routes every cloud snapshot through orphan recovery before applying it', async () => {
    const snapshot = cloudSnapshot()
    const call = vi.fn(async () => ({
      ok: true,
      result: { snapshots: [snapshot], authoritative: true }
    }))
    Object.assign(window, { api: { runtimeEnvironments: { call } } })

    loadInitialWebSessionTabs({
      environmentId: CLOUD_ENVIRONMENT_ID,
      expectedEnvironmentConnectionGeneration: 1,
      expectedEnvironmentPairingRevision: undefined,
      expectedTrackingGeneration: 0,
      isCurrent: () => true
    })

    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1))
    expect(recover.mock.calls[0]![2]).toBe(CLOUD_ENVIRONMENT_ID)
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ selector: CLOUD_ENVIRONMENT_ID, method: 'session.tabs.listAll' })
    )
  })
})
