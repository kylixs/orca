import { useCallback, useMemo } from 'react'
import type { FileActionId, FileHtmlOpenMode } from './mobile-file-actions'
import { previewActionTarget } from './mobile-file-preview-action-target'
import type { MobileTerminalArtifactPreviewSource } from './mobile-terminal-artifact-grant-refresh'
import type { MobileFilePreviewRouteParams } from './mobile-file-preview-route'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import type { MobileFilePreviewSource } from './mobile-file-preview-request'
import type { FileReadFailureScope } from './file-read-failures'
import { clearFileReadFailure } from './file-read-failures'
import { useMobileFileActions } from './use-mobile-file-actions'

type PreviewActionInput = {
  client: MobileFilePreviewRpcSender | null
  params: MobileFilePreviewRouteParams | null
  title: string
  size: number | undefined
  previewSource: MobileFilePreviewSource | null
  readFailed: boolean
  terminalTooLarge: boolean
  htmlFile: boolean
  previewDisabled: boolean
  displayPath: string
  scope: FileReadFailureScope
  onPreviewSourceRefreshed: (source: MobileTerminalArtifactPreviewSource) => void
  onReload: () => void
  onChangeHtmlMode: (mode: FileHtmlOpenMode) => void
}

/**
 * The preview screen's action target and imperative actions, so the screen only renders them.
 * The sheet's availability comes from one HTML state, exactly as the list builds it.
 */
export function useMobileFilePreviewActions(input: PreviewActionInput) {
  const {
    client,
    displayPath,
    htmlFile,
    onChangeHtmlMode,
    onPreviewSourceRefreshed,
    onReload,
    params,
    previewDisabled,
    previewSource,
    readFailed,
    scope,
    size,
    terminalTooLarge,
    title
  } = input

  const actionTarget = useMemo(
    () =>
      previewActionTarget(params, {
        title,
        size,
        readOnly: previewSource?.source === 'terminalArtifact' && previewSource.readOnly === true,
        readFailed,
        terminalSource: previewSource?.source === 'terminalArtifact' ? previewSource : null,
        terminalTooLarge
      }),
    [params, previewSource, readFailed, size, terminalTooLarge, title]
  )

  const actions = useMobileFileActions({
    client,
    target: actionTarget,
    scope,
    onTerminalArtifactSourceRefreshed: onPreviewSourceRefreshed
  })

  const handleAction = useCallback(
    (id: FileActionId) => {
      switch (id) {
        case 'retry':
          clearFileReadFailure(scope, displayPath)
          onReload()
          return
        case 'preview':
          if (!previewDisabled) {
            onChangeHtmlMode('preview')
          }
          return
        case 'source':
          onChangeHtmlMode('source')
          return
        case 'save':
          if (!actions.busy) {
            void actions.save()
          }
          return
        case 'open':
          if (!actions.busy) {
            void actions.open()
          }
          return
        case 'copy-content':
          void actions.copyContent()
          return
        case 'copy-path':
          void actions.copyPath()
          return
        default:
          return
      }
    },
    [actions, displayPath, onChangeHtmlMode, onReload, previewDisabled, scope]
  )

  const htmlActionState = htmlFile
    ? {
        source:
          params?.source === 'terminalArtifact'
            ? ('terminalArtifact' as const)
            : ('worktree' as const),
        previewDisabled,
        readFailed
      }
    : undefined

  return {
    actionTarget,
    actions,
    handleAction,
    htmlActionState
  }
}
