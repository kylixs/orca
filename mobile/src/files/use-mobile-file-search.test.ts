import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import type { RpcResponse } from '../transport/types'
import {
  rankFileSearchPaths,
  useMobileFileSearch,
  type MobileFileSearchState
} from './use-mobile-file-search'

function ok(result: unknown): RpcResponse {
  return { id: 'response-id', ok: true, result, _meta: { runtimeId: 'runtime-id' } }
}

function refusal(code: string, message = 'refused'): RpcResponse {
  return {
    id: 'response-id',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'runtime-id' }
  }
}

function client(
  sendRequest: (method: string, params: unknown) => Promise<RpcResponse>
): UnvalidatedRpcRequestPort {
  return { sendRequest: vi.fn(sendRequest) }
}

const latest: { state: MobileFileSearchState | null } = { state: null }

function Harness(props: {
  client: UnvalidatedRpcRequestPort | null
  query: string
  connected?: boolean
}) {
  latest.state = useMobileFileSearch({
    client: props.client,
    worktreeId: 'wt-1',
    query: props.query,
    connected: props.connected ?? true
  })
  return null
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160))
  })
}

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  latest.state = null
  vi.restoreAllMocks()
})

describe('useMobileFileSearch', () => {
  it('requests at most 32 results and reports totalCount/truncated', async () => {
    const api = client(async () =>
      ok({
        files: [{ relativePath: 'src/app.ts' }, { relativePath: 'src/app.test.ts' }],
        totalCount: 148,
        truncated: true
      })
    )
    await act(async () => {
      tree = create(createElement(Harness, { client: api, query: 'app' }))
    })
    await settle()

    expect(api.sendRequest).toHaveBeenCalledWith('files.searchPaths', {
      worktree: 'id:wt-1',
      query: 'app',
      limit: 32
    })
    expect(latest.state).toMatchObject({
      status: 'ready',
      totalCount: 148,
      truncated: true,
      legacyFallback: false
    })
    expect(latest.state?.results.map((entry) => entry.relativePath)).toEqual([
      'src/app.ts',
      'src/app.test.ts'
    ])
  })

  it('falls back to the capped files.list when the host does not expose searchPaths', async () => {
    const api = client(async (method) => {
      if (method === 'files.searchPaths') {
        return refusal('method_not_found', 'Unknown method')
      }
      return ok({
        files: [
          { relativePath: 'src/app.ts' },
          { relativePath: 'docs/app.md' },
          { relativePath: 'src/other.ts' }
        ],
        totalCount: 6000,
        truncated: true
      })
    })
    await act(async () => {
      tree = create(createElement(Harness, { client: api, query: 'app' }))
    })
    await settle()

    expect(api.sendRequest).toHaveBeenCalledWith('files.list', { worktree: 'id:wt-1' })
    expect(latest.state).toMatchObject({
      status: 'ready',
      legacyFallback: true,
      truncated: true,
      libraryTruncated: true,
      totalCount: 2
    })
    expect(latest.state?.results.map((entry) => entry.relativePath)).toEqual([
      'docs/app.md',
      'src/app.ts'
    ])
  })

  it('treats forbidden as the same old-host refusal', async () => {
    const api = client(async (method) =>
      method === 'files.searchPaths'
        ? refusal('forbidden', 'not available to mobile clients')
        : ok({ files: [{ relativePath: 'src/app.ts' }], totalCount: 1, truncated: false })
    )
    await act(async () => {
      tree = create(createElement(Harness, { client: api, query: 'app' }))
    })
    await settle()

    expect(api.sendRequest).toHaveBeenCalledWith('files.list', { worktree: 'id:wt-1' })
    expect(latest.state?.legacyFallback).toBe(true)
  })

  it('shows offline and sends nothing without a connected client', async () => {
    const api = client(async () => ok({ files: [], totalCount: 0, truncated: false }))
    await act(async () => {
      tree = create(createElement(Harness, { client: api, query: 'app', connected: false }))
    })
    await settle()

    expect(api.sendRequest).not.toHaveBeenCalled()
    expect(latest.state?.status).toBe('offline')
  })

  it('returns to idle when the query is cleared', async () => {
    const api = client(async () => ok({ files: [], totalCount: 0, truncated: false }))
    await act(async () => {
      tree = create(createElement(Harness, { client: api, query: 'app' }))
    })
    await settle()
    await act(async () => {
      tree?.update(createElement(Harness, { client: api, query: '' }))
    })
    expect(latest.state?.status).toBe('idle')
  })

  it('separates a capped inventory from truncated matches on a new host', async () => {
    const api = client(async () =>
      ok({
        files: [{ relativePath: 'src/zzz.ts' }],
        totalCount: 1,
        truncated: true,
        libraryTruncated: true
      })
    )
    await act(async () => {
      tree = create(createElement(Harness, { client: api, query: 'zzz' }))
    })
    await settle()

    expect(latest.state).toMatchObject({
      status: 'ready',
      totalCount: 1,
      truncated: true,
      libraryTruncated: true
    })
  })

  it('counts every legacy match even though it displays only 32', async () => {
    const paths = Array.from({ length: 40 }, (_, index) => `src/app-${index}.ts`)
    const api = client(async (method) =>
      method === 'files.searchPaths'
        ? refusal('method_not_found', 'Unknown method')
        : ok({
            files: paths.map((relativePath) => ({ relativePath })),
            totalCount: 5000,
            truncated: false
          })
    )
    await act(async () => {
      tree = create(createElement(Harness, { client: api, query: 'app' }))
    })
    await settle()

    expect(latest.state).toMatchObject({
      status: 'ready',
      legacyFallback: true,
      totalCount: 40,
      truncated: true,
      libraryTruncated: false
    })
    expect(latest.state?.results).toHaveLength(32)
  })

  it('ignores an in-flight response once the current query is served from cache', async () => {
    let resolveSlow: ((reply: RpcResponse) => void) | undefined
    const api = client((_method, params) => {
      const query =
        typeof params === 'object' && params !== null && 'query' in params
          ? String(params.query)
          : ''
      if (query === 'app2') {
        return new Promise<RpcResponse>((resolve) => {
          resolveSlow = resolve
        })
      }
      return Promise.resolve(
        ok({ files: [{ relativePath: 'src/app.ts' }], totalCount: 1, truncated: false })
      )
    })
    await act(async () => {
      tree = create(createElement(Harness, { client: api, query: 'app' }))
    })
    await settle()
    expect(latest.state?.results.map((entry) => entry.relativePath)).toEqual(['src/app.ts'])

    await act(async () => {
      tree?.update(createElement(Harness, { client: api, query: 'app2' }))
    })
    await settle()

    await act(async () => {
      tree?.update(createElement(Harness, { client: api, query: 'app' }))
    })
    await act(async () => {
      resolveSlow?.(
        ok({ files: [{ relativePath: 'src/app2.ts' }], totalCount: 1, truncated: false })
      )
      await Promise.resolve()
    })

    expect(latest.state?.results.map((entry) => entry.relativePath)).toEqual(['src/app.ts'])
  })

  it('ignores an in-flight response after the connection drops', async () => {
    let resolvePending: ((reply: RpcResponse) => void) | undefined
    const api = client(
      () =>
        new Promise<RpcResponse>((resolve) => {
          resolvePending = resolve
        })
    )
    await act(async () => {
      tree = create(createElement(Harness, { client: api, query: 'app' }))
    })
    await settle()

    await act(async () => {
      tree?.update(createElement(Harness, { client: api, query: 'app', connected: false }))
    })
    expect(latest.state?.status).toBe('offline')

    await act(async () => {
      resolvePending?.(
        ok({ files: [{ relativePath: 'src/app.ts' }], totalCount: 1, truncated: false })
      )
      await Promise.resolve()
    })
    expect(latest.state?.status).toBe('offline')
  })
})

describe('rankFileSearchPaths', () => {
  it('keeps basename matches, compares case-insensitively, and drops non-matches', () => {
    const ranked = rankFileSearchPaths(
      ['docs/app-notes.md', 'src/app.ts', 'src/App.tsx', 'src/other.ts'],
      'APP'
    )
    expect(ranked.paths).toHaveLength(3)
    expect(ranked.totalCount).toBe(3)
    expect(ranked.paths).toEqual(
      expect.arrayContaining(['docs/app-notes.md', 'src/app.ts', 'src/App.tsx'])
    )
    expect(ranked.paths).not.toContain('src/other.ts')
  })

  it('respects the display limit but still counts every match', () => {
    const paths = Array.from({ length: 40 }, (_, index) => `src/app-${index}.ts`)
    const ranked = rankFileSearchPaths(paths, 'app')
    expect(ranked.paths).toHaveLength(32)
    expect(ranked.totalCount).toBe(40)
  })
})
