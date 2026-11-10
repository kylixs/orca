import { useCallback, useEffect, useRef, useState } from 'react'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import { filePathSearchRead, legacyFileListRead } from './mobile-file-explorer-operations'
import { getMobileFileKind, type MobileFileKind } from './file-tree'

export const FILE_SEARCH_DEBOUNCE_MS = 120
export const FILE_SEARCH_RESULT_LIMIT = 32
export const FILE_SEARCH_QUERY_MAX_CHARS = 256
const FILE_SEARCH_CACHE_LIMIT = 20
export const LEGACY_FILE_LIST_LIMIT = 5000

export type MobileFileSearchEntry = {
  relativePath: string
  basename: string
  kind: MobileFileKind
}

export type MobileFileSearchState = {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'offline'
  results: MobileFileSearchEntry[]
  /** Matches on the host, before the 32-result display cap. */
  totalCount: number
  /** Some cap applied: the display limit, the inventory cap, or the legacy list cap. */
  truncated: boolean
  /** The host's file inventory itself was capped (20k new-host cache, 5000 legacy list). */
  libraryTruncated: boolean
  legacyFallback: boolean
  error: string | null
}

const IDLE_STATE: MobileFileSearchState = {
  status: 'idle',
  results: [],
  totalCount: 0,
  truncated: false,
  libraryTruncated: false,
  legacyFallback: false,
  error: null
}

/** Pure ranking used by the legacy fallback, which has to search the capped list itself. */
export function rankFileSearchPaths(
  paths: readonly string[],
  query: string,
  limit = FILE_SEARCH_RESULT_LIMIT
): { paths: string[]; totalCount: number } {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return { paths: [], totalCount: 0 }
  }
  const scored: { path: string; score: number }[] = []
  for (const path of paths) {
    const lower = path.toLowerCase()
    const basename = lower.split('/').pop() ?? lower
    let score: number
    if (basename === normalized) {
      score = 100
    } else if (basename.startsWith(normalized)) {
      score = 80
    } else if (basename.includes(normalized)) {
      score = 60
    } else if (lower.startsWith(normalized)) {
      score = 50
    } else if (lower.includes(normalized)) {
      score = 20
    } else {
      continue
    }
    scored.push({ path, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return {
    paths: scored.slice(0, limit).map((entry) => entry.path),
    totalCount: scored.length
  }
}

/**
 * Debounced filename search over `files.searchPaths`, with the capped `files.list` inventory as
 * the fallback for hosts that do not allowlist the method. A capped result is always reported as
 * capped: `truncated` survives both readers and no copy claims the list is complete.
 */
export function useMobileFileSearch(args: {
  client: UnvalidatedRpcRequestPort | null
  worktreeId: string
  query: string
  connected: boolean
}): MobileFileSearchState & { retry: () => void } {
  const { client, worktreeId, query, connected } = args
  const [state, setState] = useState<MobileFileSearchState>(IDLE_STATE)
  const [retryNonce, setRetryNonce] = useState(0)
  const cacheRef = useRef(new Map<string, MobileFileSearchState>())
  const searchSupportedRef = useRef<boolean | null>(null)
  const inventoryRef = useRef<{ paths: string[]; truncated: boolean } | null>(null)
  const sequenceRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    sequenceRef.current += 1
    cacheRef.current.clear()
    searchSupportedRef.current = null
    inventoryRef.current = null
    setState(IDLE_STATE)
    return () => {
      // Invalidate anything still in flight for the worktree being left.
      sequenceRef.current += 1
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [client, worktreeId])

  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- The debounced async search has to invalidate in-flight requests and its cache/offline branches are not render-time values.
  useEffect(() => {
    // Every branch invalidates the previous request: a cached or offline result must never let a
    // still-pending query land under the current one.
    sequenceRef.current += 1
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const normalizedQuery = query.trim().slice(0, FILE_SEARCH_QUERY_MAX_CHARS)
    if (!normalizedQuery) {
      setState(IDLE_STATE)
      return
    }
    if (!client || !connected) {
      setState({
        ...IDLE_STATE,
        status: 'offline',
        error: connected ? 'Waiting for desktop...' : 'Offline'
      })
      return
    }
    const cached = cacheRef.current.get(normalizedQuery)
    if (cached) {
      setState(cached)
      return
    }
    const sequence = sequenceRef.current
    setState({ ...IDLE_STATE, status: 'loading' })
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void runSearch({
        client,
        worktreeId,
        query: normalizedQuery,
        sequence,
        sequenceRef,
        searchSupportedRef,
        inventoryRef,
        cacheRef,
        setState
      })
    }, FILE_SEARCH_DEBOUNCE_MS)
  }, [client, connected, query, retryNonce, worktreeId])

  const retry = useCallback(() => {
    cacheRef.current.clear()
    setRetryNonce((nonce) => nonce + 1)
  }, [])

  return { ...state, retry }
}

async function runSearch(args: {
  client: UnvalidatedRpcRequestPort
  worktreeId: string
  query: string
  sequence: number
  sequenceRef: { current: number }
  searchSupportedRef: { current: boolean | null }
  inventoryRef: { current: { paths: string[]; truncated: boolean } | null }
  cacheRef: { current: Map<string, MobileFileSearchState> }
  setState: (state: MobileFileSearchState) => void
}): Promise<void> {
  const {
    client,
    worktreeId,
    query,
    sequence,
    sequenceRef,
    searchSupportedRef,
    inventoryRef,
    cacheRef,
    setState
  } = args
  const apply = (next: MobileFileSearchState): void => {
    if (sequenceRef.current !== sequence) {
      return
    }
    if (next.status === 'ready') {
      cacheRef.current.set(query, next)
      while (cacheRef.current.size > FILE_SEARCH_CACHE_LIMIT) {
        const oldest = cacheRef.current.keys().next().value
        if (oldest === undefined) {
          break
        }
        cacheRef.current.delete(oldest)
      }
    }
    setState(next)
  }

  try {
    if (searchSupportedRef.current !== false) {
      const reply = await filePathSearchRead.request(client, {
        worktree: `id:${worktreeId}`,
        query,
        limit: FILE_SEARCH_RESULT_LIMIT
      })
      const accepted = filePathSearchRead.interpret(reply)
      if (accepted.accepted) {
        searchSupportedRef.current = true
        const value = accepted.value
        const results = toSearchEntries(value.files)
        const totalCount = value.totalCount ?? results.length
        apply({
          status: 'ready',
          results,
          totalCount,
          truncated: value.truncated,
          // Older hosts only send `truncated`; with every match returned it can only mean the
          // inventory stopped at its own cap.
          libraryTruncated:
            value.libraryTruncated ?? (value.truncated && totalCount <= results.length),
          legacyFallback: false,
          error: null
        })
        return
      }
      if (!reply.ok) {
        if (!isMobileMethodUnavailableError(reply.error.code, reply.error.message)) {
          apply({
            ...IDLE_STATE,
            status: 'error',
            error: reply.error.message || 'Search failed'
          })
          return
        }
      }
      searchSupportedRef.current = false
    }

    const inventory = inventoryRef.current ?? (await loadLegacyInventory(client, worktreeId))
    if (!inventory) {
      apply({ ...IDLE_STATE, status: 'error', error: 'Unable to load files' })
      return
    }
    inventoryRef.current = inventory
    const ranked = rankFileSearchPaths(inventory.paths, query)
    apply({
      status: 'ready',
      results: ranked.paths.map(toSearchEntry),
      totalCount: ranked.totalCount,
      truncated: inventory.truncated || ranked.totalCount > ranked.paths.length,
      libraryTruncated: inventory.truncated,
      legacyFallback: true,
      error: null
    })
  } catch (error) {
    if (sequenceRef.current !== sequence) {
      return
    }
    apply({
      ...IDLE_STATE,
      status: 'error',
      error: error instanceof Error ? error.message : 'Search failed'
    })
  }
}

async function loadLegacyInventory(
  client: UnvalidatedRpcRequestPort,
  worktreeId: string
): Promise<{ paths: string[]; truncated: boolean } | null> {
  const reply = await legacyFileListRead.request(client, { worktree: `id:${worktreeId}` })
  const accepted = legacyFileListRead.interpret(reply)
  if (!accepted.accepted) {
    return null
  }
  const value = accepted.value
  return {
    paths: value.files.map((file) => file.relativePath).slice(0, LEGACY_FILE_LIST_LIMIT),
    truncated: value.truncated
  }
}

function toSearchEntries(
  files: readonly { relativePath: string; basename?: string }[]
): MobileFileSearchEntry[] {
  return files.map((file) => toSearchEntry(file.relativePath))
}

function toSearchEntry(relativePath: string): MobileFileSearchEntry {
  return {
    relativePath,
    basename: relativePath.split('/').findLast(Boolean) ?? relativePath,
    kind: getMobileFileKind(relativePath)
  }
}
