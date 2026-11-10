import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure } from '../transport/types'
import { connectionRetryAction } from '../transport/connection-retry-action'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import {
  beginDirectoryLoad,
  createDirectoryLoadRevisions,
  isCurrentDirectoryLoad,
  resetDirectoryLoadRevisions,
  type DirectoryLoadRevisions
} from './directory-load-revisions'
import { directoryCacheFromFileList } from './file-list-fallback'
import { fileDirectoryRead, legacyFileListRead } from './mobile-file-explorer-operations'
import {
  flattenDirectoryCache,
  getDirectoryCacheState,
  type DirectoryCache,
  type FileExplorerRow
} from './file-tree'
import type { MobileFileCategory } from './file-category'

/**
 * The explorer's lazy directory state: cache, expansions, retries, and the capped legacy fallback.
 *
 * The panel keeps only presentation and file actions; everything that turns a `files.readDir`
 * reply into rows lives here so the tree can be filtered without moving request policy.
 */
export function useMobileFileExplorerDirectories(args: {
  hostId: string
  worktreeId: string
  client: RpcClient | null
  connected: boolean
  forceReconnect: ((hostId: string) => unknown) | null | undefined
  category: MobileFileCategory
}) {
  const { hostId, worktreeId, client, connected, forceReconnect, category } = args
  const scopeRef = useRef('')
  const scope = `${hostId}:${worktreeId}`
  scopeRef.current = scope
  const directoryLoadRevisionsRef = useRef<DirectoryLoadRevisions>(createDirectoryLoadRevisions())
  const pendingDirectoryRetriesRef = useRef<Set<string>>(new Set())
  const directoryCacheRef = useRef<DirectoryCache>({})
  const [directoryCache, setDirectoryCache] = useState<DirectoryCache>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [legacyListTruncated, setLegacyListTruncated] = useState(false)

  const loadDirectory = useCallback(
    async (relativePath: string) => {
      const scope = scopeRef.current
      const loadToken = beginDirectoryLoad(directoryLoadRevisionsRef.current, scope, relativePath)
      const rootLoad = relativePath === ''

      if (!client || !connected) {
        const message = connected ? 'Connecting to desktop...' : 'Waiting for desktop...'
        if (rootLoad) {
          const hasLoadedRoot =
            (getDirectoryCacheState(directoryCacheRef.current, '')?.entries.length ?? 0) > 0
          setLoading(false)
          // Why: transient reconnects should not blank an already browsable tree.
          setError(hasLoadedRoot ? null : message)
        } else {
          setDirectoryCache((prev) => ({
            ...prev,
            [relativePath]: {
              entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
              error: message
            }
          }))
        }
        return
      }

      const hadLoadedRoot =
        rootLoad && (getDirectoryCacheState(directoryCacheRef.current, '')?.entries.length ?? 0) > 0
      if (rootLoad) {
        // Why: a reconnect refresh must not blank an already browsable tree —
        // the full-screen spinner unmounts the list and resets scroll.
        if (!hadLoadedRoot) {
          setLoading(true)
        }
        setError(null)
      }
      setDirectoryCache((prev) => ({
        ...prev,
        [relativePath]: {
          entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
          loading: true
        }
      }))

      try {
        const response = await fileDirectoryRead.request(client, {
          worktree: `id:${worktreeId}`,
          relativePath
        })
        const directory = fileDirectoryRead.interpret(response)
        if (!directory.accepted) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this policy skips only a refusal, so an unaccepted reply is a failure envelope.
          const refusal = (response as RpcFailure).error
          // Why: desktops that predate the files.readDir mobile allowlist
          // entry still serve the capped files.list; fall back so the Files
          // tab keeps working until the desktop updates.
          if (rootLoad && isMobileMethodUnavailableError(refusal?.code, refusal?.message)) {
            const legacyReply = await legacyFileListRead.request(client, {
              worktree: `id:${worktreeId}`
            })
            const legacy = legacyFileListRead.interpret(legacyReply)
            if (legacy.accepted) {
              if (
                !isCurrentDirectoryLoad(
                  directoryLoadRevisionsRef.current,
                  scopeRef.current,
                  loadToken
                )
              ) {
                return
              }
              const legacyResult = legacy.value
              setDirectoryCache(directoryCacheFromFileList(legacyResult.files))
              // Why: the capped list silently omits files past the cap — keep
              // the legacy explorer's "Showing first 5000" note.
              setLegacyListTruncated(legacyResult.truncated)
              return
            }
            throw new Error(
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this policy skips only a refusal, so an unaccepted reply is a failure envelope.
              (legacyReply as RpcFailure).error?.message ||
                refusal?.message ||
                'Unable to load files'
            )
          }
          throw new Error(refusal?.message || 'Unable to load files')
        }
        if (
          !isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken)
        ) {
          return
        }
        if (rootLoad) {
          setLegacyListTruncated(false)
        }
        setDirectoryCache((prev) => ({
          ...prev,
          [relativePath]: { entries: directory.value }
        }))
      } catch (err) {
        if (
          !isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken)
        ) {
          return
        }
        const message = err instanceof Error ? err.message : 'Unable to load files'
        if (rootLoad) {
          // Why: a failed background refresh keeps the cached tree browsable;
          // only a cold load surfaces the full-screen error.
          setError(hadLoadedRoot ? null : message)
        } else {
          setDirectoryCache((prev) => ({
            ...prev,
            [relativePath]: {
              entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
              error: message
            }
          }))
        }
      } finally {
        if (
          rootLoad &&
          isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken)
        ) {
          setLoading(false)
        }
      }
    },
    [client, connected, worktreeId]
  )

  useEffect(() => {
    scopeRef.current = scope
    resetDirectoryLoadRevisions(directoryLoadRevisionsRef.current)
    pendingDirectoryRetriesRef.current.clear()
    directoryCacheRef.current = {}
    setDirectoryCache({})
    setExpanded(new Set())
    setLoading(true)
    setError(null)
    setLegacyListTruncated(false)
  }, [scope])

  useEffect(() => {
    directoryCacheRef.current = directoryCache
  }, [directoryCache])

  useEffect(() => {
    void loadDirectory('')
  }, [hostId, loadDirectory])

  useEffect(() => {
    if (!connected || pendingDirectoryRetriesRef.current.size === 0) {
      return
    }
    const pending = [...pendingDirectoryRetriesRef.current]
    pendingDirectoryRetriesRef.current.clear()
    for (const relativePath of pending) {
      void loadDirectory(relativePath)
    }
  }, [connected, loadDirectory])

  const rows = useMemo(
    () => flattenDirectoryCache(directoryCache, expanded, category),
    [category, directoryCache, expanded]
  )

  const toggleDirectory = useCallback(
    (relativePath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(relativePath)) {
          next.delete(relativePath)
        } else {
          next.add(relativePath)
        }
        return next
      })
      const state = getDirectoryCacheState(directoryCache, relativePath)
      if (!expanded.has(relativePath) && !state?.loading && (!state?.entries || state.error)) {
        void loadDirectory(relativePath)
      }
    },
    [directoryCache, expanded, loadDirectory]
  )

  const retryDirectory = useCallback(
    (relativePath: string) => {
      if (!connected && hostId) {
        // Still worth a tap on the page, where nothing re-dials: the queued read runs when the
        // shell's client reconnects on its own.
        pendingDirectoryRetriesRef.current.add(relativePath)
        void forceReconnect?.(hostId)
        return
      }
      void loadDirectory(relativePath)
    },
    [connected, forceReconnect, hostId, loadDirectory]
  )

  // Why: while disconnected, re-sending the request is useless — revive the parked transport
  // instead (issue #5049); loadDirectory re-runs via its effect once the new client connects.
  const rootRetry = connectionRetryAction({
    hostId,
    needsReconnect: !connected,
    forceReconnect: forceReconnect ?? null,
    reload: () => void loadDirectory('')
  })

  return {
    rows,
    expanded,
    loading,
    error,
    legacyListTruncated,
    toggleDirectory,
    retryDirectory,
    rootRetry
  }
}

export type MobileFileExplorerDirectories = ReturnType<typeof useMobileFileExplorerDirectories>
export type { FileExplorerRow }
