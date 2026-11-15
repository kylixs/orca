import { useCallback, useMemo, useRef, useState } from 'react'
import { useClipboardWriter } from '../platform/clipboard'
import { fileActionCapabilities } from './file-action-capabilities'
import { fileActionPath, type FileActionTarget } from './mobile-file-actions'
import type { MobileFileActionRpcSender } from './mobile-file-action-operations'
import { FileActionError, type FileActionFailureCode } from './file-action-error'
import { readFileContentForCopy } from './mobile-file-copy-content'
import {
  mobileSavedFileName,
  reportMobileFileCopy,
  reportMobileFileCopyFailure,
  reportMobileFileSave
} from './mobile-file-event-capture'
import { savePreparedFileToPhone, type SavedPreparedFileResult } from './mobile-file-save'
import { openPreparedFile } from '../platform/open-file'
import {
  clearFileReadFailure,
  recordFileReadFailure,
  type FileReadFailureScope
} from './file-read-failures'
import { useFileActionTask } from './mobile-file-action-tasks'
import type { MobileTerminalArtifactPreviewSource } from './mobile-terminal-artifact-grant-refresh'

export type MobileFileActionNotice = {
  message: string
  tone: 'info' | 'error'
}

/**
 * The imperative half of the file action sheet: prepare, save, open, and copy.
 *
 * Read failures are published into the shared registry before the error is shown, so returning
 * from the preview lands on a row that still knows why the file could not be read.
 */
export function useMobileFileActions(args: {
  client: MobileFileActionRpcSender | null
  target: FileActionTarget | null
  scope: FileReadFailureScope
  onTerminalArtifactSourceRefreshed?: (source: MobileTerminalArtifactPreviewSource) => void
}) {
  const { client, target, scope } = args
  const clipboard = useClipboardWriter()
  const capabilities = useMemo(() => fileActionCapabilities(), [])
  const task = useFileActionTask(target ?? directoryPlaceholder(scope))
  const [saveResult, setSaveResult] = useState<SavedPreparedFileResult | null>(null)
  const [notice, setNotice] = useState<MobileFileActionNotice | null>(null)
  const [activeAction, setActiveAction] = useState<'save' | 'open' | null>(null)
  const busyRef = useRef(false)
  const busy = activeAction !== null || task.state.status === 'preparing'

  const fail = useCallback(
    (error: unknown, path: string, action: 'read' | 'action') => {
      const failure =
        error instanceof FileActionError
          ? error
          : new FileActionError(
              action === 'read' ? 'read_failed' : 'unavailable',
              error instanceof Error ? error.message : 'Unable to complete this action'
            )
      // A native share/clipboard error is not evidence the file could not be read.
      if (action === 'read' || failure.code === 'read_failed' || failure.code === 'changed') {
        recordFileReadFailure(scope, path, failure)
      }
      setNotice({ message: failure.message, tone: 'error' })
    },
    [scope]
  )

  const succeed = useCallback(
    (path: string, message: string, clearReadFailure = true) => {
      if (clearReadFailure) {
        clearFileReadFailure(scope, path)
      }
      setNotice(message ? { message, tone: 'info' } : null)
    },
    [scope]
  )

  const save = useCallback(async () => {
    if (!client || !target || busyRef.current) {
      return
    }
    busyRef.current = true
    setActiveAction('save')
    setNotice(null)
    try {
      if (task.state.status === 'failed') {
        task.reset()
      }
      const prepared = await task.start('save', client, args.onTerminalArtifactSourceRefreshed)
      const result = await savePreparedFileToPhone(prepared)
      // The bytes were used: the next Save/Open must not reuse a prepare from before an edit.
      task.forget()
      if (result.kind === 'saved') {
        void reportMobileFileSave(client, {
          target,
          outcome: 'saved',
          savedName: mobileSavedFileName(result.path, prepared.fileName),
          sizeBytes: prepared.size,
          sha256: prepared.sha256
        })
        setSaveResult(result)
        succeed(fileActionPath(target), 'Saved to phone')
      } else {
        // The share sheet resolves even when dismissed, so it cannot claim a completed save.
        void reportMobileFileSave(client, {
          target,
          outcome: 'shared',
          sizeBytes: prepared.size,
          sha256: prepared.sha256
        })
        setSaveResult(null)
        succeed(fileActionPath(target), 'Shared. Check your Files app to confirm the save.')
      }
    } catch (error) {
      if (error instanceof FileActionError && error.code === 'cancelled') {
        void reportMobileFileSave(client, { target, outcome: 'cancelled' })
        task.reset()
        setNotice(null)
        return
      }
      void reportMobileFileSave(client, {
        target,
        outcome: 'failed',
        reason: error instanceof FileActionError ? error.code : 'read_failed'
      })
      fail(error, fileActionPath(target), 'action')
    } finally {
      busyRef.current = false
      setActiveAction(null)
    }
  }, [args.onTerminalArtifactSourceRefreshed, client, fail, succeed, target, task])

  const open = useCallback(async () => {
    if (!client || !target || busyRef.current) {
      return
    }
    busyRef.current = true
    setActiveAction('open')
    setNotice(null)
    try {
      if (task.state.status === 'failed') {
        task.reset()
      }
      const prepared = await task.start('open', client, args.onTerminalArtifactSourceRefreshed)
      await openPreparedFile(prepared)
      task.forget()
      succeed(fileActionPath(target), '')
    } catch (error) {
      if (error instanceof FileActionError && error.code === 'cancelled') {
        task.reset()
        setNotice(null)
        return
      }
      fail(error, fileActionPath(target), 'action')
    } finally {
      busyRef.current = false
      setActiveAction(null)
    }
  }, [args.onTerminalArtifactSourceRefreshed, client, fail, succeed, target, task])

  const copyContent = useCallback(async () => {
    if (!client || !target) {
      return
    }
    setNotice(null)
    let copied: Awaited<ReturnType<typeof readFileContentForCopy>>
    try {
      copied = await readFileContentForCopy(client, target, {
        onTerminalArtifactSourceRefreshed: args.onTerminalArtifactSourceRefreshed
      })
    } catch (error) {
      fail(error, fileActionPath(target), 'read')
      void reportMobileFileCopyFailure(client, { target, reason: 'read_failed' })
      return
    }
    try {
      await clipboard.writeText(copied.content)
    } catch (error) {
      // The read succeeded; a clipboard failure must not mark the file as unreadable.
      fail(error, fileActionPath(target), 'action')
      void reportMobileFileCopyFailure(client, { target, reason: 'clipboard_write_failed' })
      return
    }
    void reportMobileFileCopy(client, { target, content: copied.content })
    succeed(fileActionPath(target), copied.truncated ? 'Copied first 512 KB' : 'Copied content')
  }, [args.onTerminalArtifactSourceRefreshed, client, clipboard, fail, succeed, target])

  const copyPath = useCallback(async () => {
    if (!target) {
      return
    }
    setNotice(null)
    try {
      await clipboard.writeText(fileActionPath(target))
      // Copying a path does not read the file, so an EACCES badge stays until a real Retry passes.
      succeed(fileActionPath(target), 'Copied path', false)
    } catch (error) {
      fail(error, fileActionPath(target), 'action')
    }
  }, [clipboard, fail, succeed, target])

  const dismissNotice = useCallback(() => setNotice(null), [])
  const dismissSaveResult = useCallback(() => setSaveResult(null), [])
  const retry = useCallback(() => {
    // Retry replays the action recorded in the shared task, so a failure raised from another
    // screen still retries here.
    if (task.state.status !== 'failed') {
      return
    }
    if (task.state.action === 'save') {
      void save()
    } else {
      void open()
    }
  }, [open, save, task.state])

  return {
    capabilities,
    busy,
    task,
    saveResult,
    notice,
    save,
    open,
    copyContent,
    copyPath,
    retry,
    dismissNotice,
    dismissSaveResult
  }
}

function directoryPlaceholder(scope: FileReadFailureScope): FileActionTarget {
  return {
    source: 'worktree',
    hostId: scope.hostId,
    worktreeId: scope.worktreeId,
    relativePath: '',
    name: '',
    kind: 'directory',
    previewable: false
  }
}

export type { FileActionFailureCode }
