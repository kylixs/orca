import { useSyncExternalStore } from 'react'
import type { FileActionTarget } from './mobile-file-actions'
import { fileActionTargetKey } from './mobile-file-actions'
import { FileActionError, type FileActionFailureCode } from './file-action-error'
import { prepareFileForAction, type PrepareProgress } from './mobile-file-prepare'
import type { MobileFileActionRpcSender } from './mobile-file-action-operations'
import {
  deletePreparedCacheFile,
  downloadCacheDirectoryName,
  subscribeDownloadCacheInvalidation,
  type PreparedCachedFile
} from './mobile-file-download-cache'
import type { MobileTerminalArtifactPreviewSource } from './mobile-terminal-artifact-grant-refresh'

export type FileActionTaskAction = 'save' | 'open'

export type FileActionTaskState =
  | { status: 'idle' }
  | {
      status: 'preparing'
      action: FileActionTaskAction
      bytes: number
      total: number | null
    }
  | {
      status: 'ready'
      action: FileActionTaskAction
      prepared: PreparedCachedFile
    }
  | {
      status: 'failed'
      action: FileActionTaskAction
      message: string
      code: FileActionFailureCode
      retryable: boolean
    }

const IDLE: FileActionTaskState = { status: 'idle' }
const states = new Map<string, FileActionTaskState>()
const inFlight = new Map<
  string,
  { promise: Promise<PreparedCachedFile>; controller: AbortController }
>()
const listeners = new Set<() => void>()

/**
 * Single-flight prepare shared by the explorer and the preview screen.
 *
 * The two screens are separate React trees, so the task cannot live in either one: a save started
 * from the list must still be cancellable from the preview that opens while it runs.
 */
export function useFileActionTask(target: FileActionTarget): {
  state: FileActionTaskState
  start: (
    action: FileActionTaskAction,
    client: MobileFileActionRpcSender,
    onTerminalArtifactSourceRefreshed?: (source: MobileTerminalArtifactPreviewSource) => void
  ) => Promise<PreparedCachedFile>
  cancel: () => void
  reset: () => void
  /** Drop the ready state after its bytes were used, keeping the cached directory for sharing. */
  forget: () => void
} {
  const key = fileActionTargetKey(target)
  const state = useSyncExternalStore(
    subscribeFileActionTasks,
    () => taskStateFor(key),
    () => taskStateFor(key)
  )
  return {
    state,
    start: (action, client, onSourceRefreshed) =>
      startFileActionTask(target, action, client, onSourceRefreshed),
    cancel: () => cancelFileActionTask(key),
    reset: () => resetFileActionTask(key),
    forget: () => forgetFileActionTask(key)
  }
}

export function taskStateFor(key: string): FileActionTaskState {
  return states.get(key) ?? IDLE
}

export async function startFileActionTask(
  target: FileActionTarget,
  action: FileActionTaskAction,
  client: MobileFileActionRpcSender,
  onTerminalArtifactSourceRefreshed?: (source: MobileTerminalArtifactPreviewSource) => void
): Promise<PreparedCachedFile> {
  const key = fileActionTargetKey(target)
  const existing = inFlight.get(key)
  if (existing) {
    return existing.promise
  }
  const ready = states.get(key)
  if (ready?.status === 'ready') {
    return ready.prepared
  }
  const controller = new AbortController()
  const updateProgress = (progress: PrepareProgress): void => {
    setTaskState(key, {
      status: 'preparing',
      action: progress.action,
      bytes: progress.bytes,
      total: progress.total
    })
  }
  setTaskState(key, {
    status: 'preparing',
    action,
    bytes: 0,
    total: target.size ?? null
  })
  const promise = prepareFileForAction(client, target, {
    action,
    signal: controller.signal,
    onProgress: updateProgress,
    ...(onTerminalArtifactSourceRefreshed ? { onTerminalArtifactSourceRefreshed } : {})
  })
    .then((prepared) => {
      setTaskState(key, { status: 'ready', action, prepared })
      return prepared
    })
    .catch((error: unknown) => {
      const failure =
        error instanceof FileActionError
          ? error
          : new FileActionError(
              'read_failed',
              error instanceof Error ? error.message : 'Unable to prepare this file'
            )
      if (failure.code !== 'cancelled') {
        setTaskState(key, {
          status: 'failed',
          action,
          message: failure.message,
          code: failure.code,
          retryable: true
        })
      } else {
        setTaskState(key, IDLE)
      }
      throw failure
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, { promise, controller })
  return promise
}

export function cancelFileActionTask(key: string): void {
  inFlight.get(key)?.controller.abort()
}

/** Drops a ready/error task and its cache directory, for a cancelled save or a retry. */
export function resetFileActionTask(key: string): void {
  inFlight.get(key)?.controller.abort()
  const state = states.get(key)
  if (state?.status === 'ready') {
    deletePreparedCacheFile(state.prepared)
  }
  states.delete(key)
  emit()
}

/**
 * Forgets a prepared result after Save/Open used it, without deleting the cache directory: the
 * share target may still read it, but the next action must re-stat and re-read the file.
 */
export function forgetFileActionTask(key: string): void {
  if (states.delete(key)) {
    emit()
  }
}

export function resetAllFileActionTasks(): void {
  for (const key of states.keys()) {
    resetFileActionTask(key)
  }
}

export function subscribeFileActionTasks(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

subscribeDownloadCacheInvalidation((directoryNames) => {
  let changed = false
  for (const [key, state] of states) {
    if (state.status !== 'ready') {
      continue
    }
    if (
      directoryNames !== null &&
      !directoryNames.has(downloadCacheDirectoryName(state.prepared.directoryUri))
    ) {
      continue
    }
    states.delete(key)
    changed = true
  }
  if (changed) {
    emit()
  }
})

function setTaskState(key: string, state: FileActionTaskState): void {
  states.set(key, state)
  emit()
}

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}
