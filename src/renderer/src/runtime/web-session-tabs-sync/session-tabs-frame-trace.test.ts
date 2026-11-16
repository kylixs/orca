import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  SESSION_TABS_FRAME_TRACE_STORAGE_KEY,
  isSessionTabsFrameTraceEnabled,
  resetSessionTabsFrameTraceForTests,
  traceSessionTabsApplyDecision,
  traceSessionTabsCall,
  traceSessionTabsSubscription,
  type SessionTabsFrameTraceHandle,
  type SessionTabsTraceRequest,
  type SessionTabsSubscriptionCallbacks
} from './session-tabs-frame-trace'

// The node test env has no DOM storage; the module reads localStorage behind a try/catch.
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear()
})

let windowStub: { __orcaSessionTabsTrace?: SessionTabsFrameTraceHandle }

beforeEach(() => {
  resetSessionTabsFrameTraceForTests()
  storage.clear()
  windowStub = {}
  vi.stubGlobal('window', windowStub)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function enable(): void {
  storage.set(SESSION_TABS_FRAME_TRACE_STORAGE_KEY, '1')
  // The flag is read once per page load, so a reload is what makes a storage write take effect.
  resetSessionTabsFrameTraceForTests()
}

function snapshot(
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'repo::/worktree',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'tab-1',
    activeTabType: 'terminal',
    tabs: [],
    ...overrides
  }
}

function request(
  method = 'session.tabs.activate',
  worktree: string | null = 'id:repo::/worktree'
): SessionTabsTraceRequest {
  return {
    selector: 'env-1',
    method,
    params: {
      ...(worktree === null ? {} : { worktree }),
      tabId: 'tab-1',
      notifyClients: false,
      terminalContent: 'do not record this',
      apiKey: 'do not record this either'
    }
  }
}

function successResponse(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'r1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function failureResponse(code: string): RuntimeRpcResponse<unknown> {
  return { id: 'r2', ok: false, error: { code, message: 'refused' } }
}

function frames() {
  return [...(windowStub.__orcaSessionTabsTrace?.frames ?? [])]
}

describe('session-tabs-frame-trace', () => {
  it('records nothing and exposes nothing while the switch is off', async () => {
    const response = await traceSessionTabsCall(request(), () =>
      Promise.resolve(successResponse(snapshot()))
    )
    expect(response.ok).toBe(true)
    expect(isSessionTabsFrameTraceEnabled()).toBe(false)
    expect(windowStub.__orcaSessionTabsTrace).toBeUndefined()

    enable()
    await traceSessionTabsCall(request(), () => Promise.resolve(successResponse(snapshot())))
    expect(frames().map((frame) => frame.seq)).toEqual([1, 2])
    expect(windowStub.__orcaSessionTabsTrace).toBeDefined()
  })

  it('reads the switch once per page load and never again on the closed path', async () => {
    const getItem = vi.spyOn(localStorage, 'getItem')
    await traceSessionTabsCall(request(), () => Promise.resolve(successResponse(snapshot())))
    expect(getItem).toHaveBeenCalledTimes(1)

    getItem.mockClear()
    for (let index = 0; index < 50; index += 1) {
      await traceSessionTabsCall(request(), () => Promise.resolve(successResponse(snapshot())))
    }
    traceSessionTabsApplyDecision('env-1', snapshot(), true)
    expect(getItem).not.toHaveBeenCalled()
  })

  it('enables from the window handle at runtime and records from the next frame', async () => {
    enable()
    await traceSessionTabsCall(request(), () => Promise.resolve(successResponse(snapshot())))
    const handle = windowStub.__orcaSessionTabsTrace!
    expect(frames()).toHaveLength(2)

    handle.disable()
    expect(windowStub.__orcaSessionTabsTrace).toBeUndefined()
    await traceSessionTabsCall(request(), () => Promise.resolve(successResponse(snapshot())))
    expect(frames()).toHaveLength(0)

    handle.enable()
    expect(windowStub.__orcaSessionTabsTrace).toBeDefined()
    await traceSessionTabsCall(request(), () => Promise.resolve(successResponse(snapshot())))
    expect(frames().map((frame) => frame.seq)).toEqual([1, 2])
  })

  it('removes the window handle when tracing is disabled', async () => {
    enable()
    await traceSessionTabsCall(request(), () => Promise.resolve(successResponse(snapshot())))
    expect(windowStub.__orcaSessionTabsTrace).toBeDefined()

    windowStub.__orcaSessionTabsTrace!.disable()
    expect(windowStub.__orcaSessionTabsTrace).toBeUndefined()
    expect(isSessionTabsFrameTraceEnabled()).toBe(false)
  })


  it('associates a request with its response and records only allowlisted params', async () => {
    enable()
    const response = await traceSessionTabsCall(request(), () =>
      Promise.resolve(successResponse(snapshot()))
    )
    expect(response.ok).toBe(true)

    const [requestFrame, responseFrame] = frames()
    expect(requestFrame!.dir).toBe('req')
    expect(responseFrame!.dir).toBe('res')
    expect(responseFrame!.requestId).toBe(requestFrame!.requestId)
    expect(requestFrame!.method).toBe('session.tabs.activate')
    expect(requestFrame!.environmentId).toBe('env-1')
    expect(requestFrame!.worktree).toBe('id:repo::/worktree')
    expect(requestFrame!.tabId).toBe('tab-1')
    expect(requestFrame!.params).toEqual({ notifyClients: false, tabId: 'tab-1' })
    expect(responseFrame!.ok).toBe(true)
    expect(responseFrame!.runtimeId).toBe('runtime-1')
    expect(responseFrame!.result).toMatchObject({
      activeTabId: 'tab-1',
      activeGroupId: 'group-1',
      snapshotVersion: 1,
      publicationEpoch: 'epoch-1'
    })
  })

  it('records an error response with its error code', async () => {
    enable()
    await traceSessionTabsCall(request('session.tabs.close'), () =>
      Promise.resolve(failureResponse('tab_not_found'))
    )
    const responseFrame = frames()[1]!
    expect(responseFrame.requestId).toBe(frames()[0]!.requestId)
    expect(responseFrame.ok).toBe(false)
    expect(responseFrame.errorCode).toBe('tab_not_found')
  })

  it('records a thrown transport failure without its message', async () => {
    enable()
    await expect(
      traceSessionTabsCall(request(), () => Promise.reject(new Error('socket exploded')))
    ).rejects.toThrow('socket exploded')
    expect(frames()[1]).toMatchObject({ dir: 'res', ok: false, errorCode: 'transport_error' })
    expect(JSON.stringify(frames())).not.toContain('socket exploded')
  })

  it('evicts the oldest frames past the 300-frame ring', async () => {
    enable()
    for (let index = 0; index < 200; index += 1) {
      await traceSessionTabsCall(request(), () => Promise.resolve(successResponse(snapshot())))
    }
    const kept = frames()
    expect(kept).toHaveLength(300)
    expect(kept[0]!.seq).toBe(101)
    expect(kept.at(-1)!.seq).toBe(400)
  })

  it('backfills the apply verdict onto the frame that carried the snapshot', async () => {
    enable()
    await traceSessionTabsCall(request('session.tabs.list'), () =>
      Promise.resolve(
        successResponse(snapshot({ publicationEpoch: 'epoch-4', snapshotVersion: 4 }))
      )
    )
    await traceSessionTabsCall(request('session.tabs.list'), () =>
      Promise.resolve(
        successResponse(snapshot({ publicationEpoch: 'epoch-5', snapshotVersion: 5 }))
      )
    )

    traceSessionTabsApplyDecision(
      'env-1',
      snapshot({ publicationEpoch: 'epoch-4', snapshotVersion: 4 }),
      true,
      { hostActiveAuthoritative: true }
    )
    traceSessionTabsApplyDecision(
      'env-1',
      snapshot({ publicationEpoch: 'epoch-5', snapshotVersion: 5 }),
      false
    )

    const [firstRequest, firstResponse, , secondResponse] = frames()
    expect(firstRequest!.applied).toBeUndefined()
    expect(firstResponse!.applied).toBe(true)
    expect(firstResponse!.applyOptions).toEqual({
      hostActiveAuthoritative: true,
      adoptHostLayout: false
    })
    expect(secondResponse!.applied).toBe(false)
  })

  it('annotates the matching snapshot inside a listAll frame', async () => {
    enable()
    const first = snapshot({ publicationEpoch: 'epoch-a', snapshotVersion: 10 })
    const second = snapshot({ publicationEpoch: 'epoch-b', snapshotVersion: 11 })
    await traceSessionTabsCall(request('session.tabs.listAll'), () =>
      Promise.resolve(successResponse({ authoritative: true, snapshots: [first, second] }))
    )

    traceSessionTabsApplyDecision('env-1', second, true, { hostActiveAuthoritative: true })

    const [responseFrame] = frames().slice(1)
    expect(responseFrame!.applied).toBe(true)
    expect(responseFrame!.result?.snapshots?.[1]).toMatchObject({
      snapshotVersion: 11,
      applied: true
    })
    expect(responseFrame!.result?.snapshots?.[0]?.applied).toBeUndefined()
  })

  it('matches apply decisions by worktree when version and epoch collide', async () => {
    enable()
    const shared = { publicationEpoch: 'epoch-shared', snapshotVersion: 7 }
    const first = snapshot({ ...shared, worktree: 'repo::/wt-a' })
    const second = snapshot({ ...shared, worktree: 'repo::/wt-b' })
    await traceSessionTabsCall(request('session.tabs.listAll', 'id:repo::/wt-a'), () =>
      Promise.resolve(successResponse({ authoritative: true, snapshots: [first] }))
    )
    await traceSessionTabsCall(request('session.tabs.listAll', 'id:repo::/wt-b'), () =>
      Promise.resolve(successResponse({ authoritative: true, snapshots: [second] }))
    )

    traceSessionTabsApplyDecision('env-1', first, false)
    traceSessionTabsApplyDecision('env-1', second, true, { hostActiveAuthoritative: true })

    const [, firstResponse, , secondResponse] = frames()
    expect(firstResponse!.result?.snapshots?.[0]).toMatchObject({
      worktree: 'repo::/wt-a',
      applied: false
    })
    expect(secondResponse!.result?.snapshots?.[0]).toMatchObject({
      worktree: 'repo::/wt-b',
      applied: true
    })
    expect(firstResponse!.applied).toBe(false)
    expect(secondResponse!.applied).toBe(true)
  })

  it('annotates the worktree-matching snapshot when one listAll frame collides', async () => {
    enable()
    const first = snapshot({
      publicationEpoch: 'epoch-shared',
      snapshotVersion: 3,
      worktree: 'repo::/wt-a'
    })
    const second = snapshot({
      publicationEpoch: 'epoch-shared',
      snapshotVersion: 3,
      worktree: 'repo::/wt-b'
    })
    await traceSessionTabsCall(request('session.tabs.listAll', null), () =>
      Promise.resolve(successResponse({ authoritative: true, snapshots: [first, second] }))
    )

    traceSessionTabsApplyDecision('env-1', second, true, { hostActiveAuthoritative: true })

    const [responseFrame] = frames().slice(1)
    expect(responseFrame!.result?.snapshots?.[0]?.applied).toBeUndefined()
    expect(responseFrame!.result?.snapshots?.[1]).toMatchObject({
      worktree: 'repo::/wt-b',
      applied: true
    })
  })

  it('uses the final decision when the same snapshot is first accepted then rejected', async () => {
    enable()
    const carried = snapshot({ publicationEpoch: 'epoch-2', snapshotVersion: 2 })
    await traceSessionTabsCall(request('session.tabs.listAll', null), () =>
      Promise.resolve(successResponse({ authoritative: true, snapshots: [carried] }))
    )

    traceSessionTabsApplyDecision('env-1', carried, true, { hostActiveAuthoritative: true })
    traceSessionTabsApplyDecision('env-1', carried, false)

    const responseFrame = frames()[1]!
    expect(responseFrame.applied).toBe(false)
    expect(responseFrame.result?.snapshots?.[0]?.applied).toBe(false)
    expect(responseFrame.result?.snapshots?.[0]?.applyOptions).toBeUndefined()
  })

  it('dumps a JSON-serializable timeline and clears it on demand', async () => {
    enable()
    await traceSessionTabsCall(request(), () => Promise.resolve(successResponse(snapshot())))
    const handle = windowStub.__orcaSessionTabsTrace!
    const dump = handle.dump()
    expect(() => JSON.parse(dump)).not.toThrow()
    expect(dump).toContain('"capacity":300')
    expect(dump).toContain('"size":2')

    handle.clear()
    expect(frames()).toHaveLength(0)
    expect(handle.dump()).toContain('"size":0')
  })

  it('records the subscribe request and its stream frames', async () => {
    enable()
    const received: unknown[] = []
    const callbacks: SessionTabsSubscriptionCallbacks = {
      onResponse: (response) => received.push(response)
    }
    let tracedCallbacks: SessionTabsSubscriptionCallbacks | undefined
    const subscribe = vi.fn((given: SessionTabsSubscriptionCallbacks) => {
      tracedCallbacks = given
      return Promise.resolve({ unsubscribe: () => {} })
    })

    await traceSessionTabsSubscription(
      {
        selector: 'env-1',
        method: 'session.tabs.subscribe',
        params: { worktree: 'id:repo::/worktree' }
      },
      callbacks,
      subscribe
    )
    tracedCallbacks!.onResponse(
      successResponse(snapshot({ publicationEpoch: 'epoch-9', snapshotVersion: 9 }))
    )

    const [requestFrame, streamFrame] = frames()
    expect(requestFrame!.dir).toBe('req')
    expect(requestFrame!.method).toBe('session.tabs.subscribe')
    expect(streamFrame!.dir).toBe('stream')
    expect(streamFrame!.requestId).toBe(requestFrame!.requestId)
    expect(streamFrame!.streamSeq).toBe(1)
    expect(streamFrame!.result?.snapshotVersion).toBe(9)
    expect(received).toHaveLength(1)
  })

  it('passes the original callbacks through untouched while disabled', async () => {
    const callbacks: SessionTabsSubscriptionCallbacks = { onResponse: vi.fn() }
    const subscribe = vi.fn((_given: SessionTabsSubscriptionCallbacks) => Promise.resolve('handle'))
    const handle = await traceSessionTabsSubscription(
      request('session.tabs.subscribeAll'),
      callbacks,
      subscribe
    )
    expect(handle).toBe('handle')
    expect(subscribe).toHaveBeenCalledWith(callbacks)
    expect(windowStub.__orcaSessionTabsTrace).toBeUndefined()
  })
})
