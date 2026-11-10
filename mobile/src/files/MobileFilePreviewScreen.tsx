import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { useRouteHandoff } from '../navigation/route-handoff'
import { getWorktreeLabel } from '../session/worktree-label'
import { spacing } from '../theme/mobile-theme'
import { useForceReconnect, useHostClient } from '../transport/client-context'
import { connectionRetryAction } from '../transport/connection-retry-action'
import {
  loadMobileFilePreview,
  previewError,
  saveMobileTerminalArtifactPreview,
  type MobileFilePreviewSource,
  type MobileFilePreviewResult
} from './mobile-file-preview-request'
import { MobileFilePreviewBody } from './MobileFilePreviewBody'
import {
  displayNameFromPreviewPath,
  type MobileFilePreviewRouteState
} from './mobile-file-preview-route'
import { previewSourceFromRoute, sourceKeyForPreview } from './mobile-file-preview-source'
import { normalizeMobileFilePreviewLineColumn } from './mobile-file-preview-line-column'
import {
  hasUnsavedMobileTerminalArtifactDraft,
  isEditableMobileTerminalArtifactPreview,
  shouldKeepDirtyDraftOnPreviewLoadResult
} from './mobile-file-preview-editability'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { useMobileFilePreviewBack } from './use-mobile-file-preview-back'
import { MobileFilePreviewHeader } from './MobileFilePreviewHeader'
import { MobileFilePreviewOverlays } from './MobileFilePreviewOverlays'
import { MobileFilePreviewHtmlControls } from './MobileFilePreviewHtmlControls'
import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import { MobileFileDownloadProgress } from './MobileFileDownloadProgress'
import { useMobileFilePreviewHtmlMode } from './use-mobile-file-preview-html-mode'
import { useMobileFilePreviewActions } from './use-mobile-file-preview-actions'
import {
  previewByteSize,
  saveErrorMessageFromPreviewResult
} from './mobile-file-preview-target-size'
import { recordMobileFilePreviewResult } from './mobile-file-preview-read-failure'
import {
  clearNetworkFileReadFailures,
  recordFileReadFailure,
  type FileReadFailureScope
} from './file-read-failures'

type Props = {
  route: MobileFilePreviewRouteState
}
export function MobileFilePreviewScreen({ route }: Props) {
  const router = useRouteHandoff()
  const previewParams = route.ok ? route.params : null
  const { client, state: connState } = useHostClient(previewParams?.hostId)
  const forceReconnect = useForceReconnect()
  const [preview, setPreview] = useState<MobileFilePreviewResult>(() =>
    route.ok ? { status: 'loading', message: 'Loading preview...' } : previewError(route.message)
  )
  const [draftContent, setDraftContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionSheetVisible, setActionSheetVisible] = useState(false)
  const draftContentRef = useRef(draftContent)
  const savedContentRef = useRef(savedContent)
  const draftSourceKeyRef = useRef<string | null>(null)
  const { width, height } = useWindowDimensions()
  const routePreviewSource = useMemo(
    () => (previewParams ? previewSourceFromRoute(previewParams) : null),
    [previewParams]
  )
  const [previewSource, setPreviewSource] = useState<MobileFilePreviewSource | null>(
    routePreviewSource
  )
  const previewSourceKey = useMemo(() => sourceKeyForPreview(previewSource), [previewSource])
  const routePreviewSourceKey = useMemo(
    () => sourceKeyForPreview(routePreviewSource),
    [routePreviewSource]
  )
  const previewSourceKeyRef = useRef(previewSourceKey)
  const lineColumn = useMemo(
    () =>
      previewParams
        ? normalizeMobileFilePreviewLineColumn(previewParams.line, previewParams.column)
        : null,
    [previewParams]
  )
  const terminalArtifact = previewParams?.source === 'terminalArtifact'
  const htmlFilePath = terminalArtifact ? previewParams?.absolutePath : previewParams?.relativePath
  const htmlFile = Boolean(htmlFilePath && classifyMobileArtifact(htmlFilePath) === 'html')
  const htmlTruncated = preview.status === 'ready' && preview.kind === 'html' && preview.truncated
  const previewReadFailed = preview.status === 'error' || preview.status === 'waiting'
  const {
    mode: htmlMode,
    setMode: setHtmlMode,
    sheetVisible: htmlModeSheetVisible,
    closeSheet: closeHtmlModeSheet,
    notice: preferenceNotice,
    setNotice: setPreferenceNotice,
    selectMode: handleHtmlModeSelect
  } = useMobileFilePreviewHtmlMode({
    params: previewParams,
    htmlFile,
    terminalArtifact,
    truncated: htmlTruncated,
    readFailed: previewReadFailed
  })

  useEffect(() => {
    setPreviewSource(routePreviewSource)
    draftSourceKeyRef.current = null
  }, [routePreviewSource])

  useEffect(() => {
    previewSourceKeyRef.current = previewSourceKey
  }, [previewSourceKey])

  useEffect(() => {
    draftContentRef.current = draftContent
  }, [draftContent])

  useEffect(() => {
    savedContentRef.current = savedContent
  }, [savedContent])

  const displayPath =
    previewParams?.source === 'terminalArtifact'
      ? (previewParams.absolutePath ?? '')
      : (previewParams?.relativePath ?? '')
  const title = previewParams?.name ?? displayNameFromPreviewPath(displayPath)
  const readFailureScope = useMemo<FileReadFailureScope>(
    () => ({
      hostId: previewParams?.hostId,
      worktreeId: previewParams?.worktreeId ?? ''
    }),
    [previewParams?.hostId, previewParams?.worktreeId]
  )

  const recordPreviewResult = useCallback(
    (result: MobileFilePreviewResult) =>
      recordMobileFilePreviewResult(readFailureScope, displayPath, result),
    [displayPath, readFailureScope]
  )

  const loadPreview = useCallback(async () => {
    const loadSourceKey = previewSourceKey
    if (!previewParams || !previewSource || loadSourceKey !== routePreviewSourceKey) {
      setPreview(previewError(route.ok ? 'Unable to load preview' : route.message))
      return
    }
    const preserveDirtyDraft =
      draftSourceKeyRef.current === previewSourceKey &&
      draftContentRef.current !== savedContentRef.current
    if (!client || connState !== 'connected') {
      if (preserveDirtyDraft) {
        setSaveError('Waiting for desktop...')
        return
      }
      const waiting: MobileFilePreviewResult = {
        status: 'waiting',
        message: 'Waiting for desktop...',
        reconnect: true
      }
      setPreview(waiting)
      recordPreviewResult(waiting)
      return
    }
    if (!preserveDirtyDraft) {
      setPreview({ status: 'loading', message: 'Loading preview...' })
    }
    setSaveError('')
    try {
      const result = await loadMobileFilePreview(client, previewSource, undefined, {
        onTerminalArtifactSourceRefreshed: setPreviewSource,
        refreshGrant: true
      })
      if (previewSourceKeyRef.current !== loadSourceKey) {
        return
      }
      if (shouldKeepDirtyDraftOnPreviewLoadResult(preserveDirtyDraft, result)) {
        setSaveError(result.message)
        recordPreviewResult(result)
        return
      }
      const loadedContent =
        result.status === 'ready' && result.kind !== 'image' && result.kind !== 'media'
          ? result.content
          : result.status === 'empty'
            ? ''
            : null
      if (loadedContent !== null) {
        if (!preserveDirtyDraft) {
          setDraftContent(loadedContent)
          setSavedContent(loadedContent)
        }
        draftSourceKeyRef.current = previewSourceKey
      }
      setPreview(result)
      recordPreviewResult(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load preview'
      if (preserveDirtyDraft) {
        setSaveError(message)
        recordFileReadFailure(readFailureScope, displayPath, message)
        return
      }
      const failed = previewError(message)
      setPreview(failed)
      recordPreviewResult(failed)
    }
  }, [
    client,
    connState,
    displayPath,
    previewParams,
    previewSource,
    previewSourceKey,
    readFailureScope,
    recordPreviewResult,
    route,
    routePreviewSourceKey
  ])

  useEffect(() => {
    void loadPreview()
  }, [loadPreview])

  const previousConnectionStateRef = useRef(connState)
  useEffect(() => {
    const previous = previousConnectionStateRef.current
    previousConnectionStateRef.current = connState
    if (connState === 'connected' && previous !== 'connected') {
      clearNetworkFileReadFailures(readFailureScope)
    }
  }, [connState, readFailureScope])

  const retry = useMemo(
    () =>
      connectionRetryAction({
        hostId: previewParams?.hostId,
        needsReconnect:
          preview.status === 'waiting' ||
          (preview.status === 'error' && preview.reconnect) ||
          connState !== 'connected',
        forceReconnect,
        reload: () => void loadPreview()
      }),
    [connState, forceReconnect, loadPreview, preview, previewParams]
  )

  const worktreeLabel = getWorktreeLabel(
    previewParams?.worktreeName,
    previewParams?.worktreeId ?? ''
  )
  const meta = previewParams ? `${worktreeLabel} - ${displayPath}` : 'Preview'
  const isEditableTerminalArtifact =
    previewSource?.source === 'terminalArtifact' &&
    isEditableMobileTerminalArtifactPreview(preview, previewSource.readOnly === true)
  const canSaveArtifact =
    isEditableTerminalArtifact &&
    draftSourceKeyRef.current === previewSourceKey &&
    draftContent !== savedContent
  const hasUnsavedTerminalArtifactDraft = hasUnsavedMobileTerminalArtifactDraft({
    source: previewSource?.source,
    draftSourceKey: draftSourceKeyRef.current,
    previewSourceKey,
    draftContent,
    savedContent
  })

  const previewSize = useMemo(() => previewByteSize(preview), [preview])
  const sourceTruncated =
    preview.status === 'ready' &&
    preview.kind !== 'media' &&
    preview.kind !== 'image' &&
    preview.truncated
  const truncatedNote = htmlFile && sourceTruncated ? 'Showing first 512 KB' : undefined
  const terminalTooLarge =
    preview.status === 'error' &&
    preview.message.toLowerCase().includes('too large') &&
    previewParams?.source === 'terminalArtifact'

  const { actionTarget, actions, handleAction, htmlActionState } = useMobileFilePreviewActions({
    client,
    params: previewParams,
    title,
    size: previewSize,
    previewSource,
    readFailed: previewReadFailed,
    terminalTooLarge,
    htmlFile,
    previewDisabled: htmlTruncated,
    displayPath,
    scope: readFailureScope,
    onPreviewSourceRefreshed: setPreviewSource,
    onReload: () => void loadPreview(),
    onChangeHtmlMode: setHtmlMode
  })

  const saveArtifact = useCallback(async () => {
    if (!client || previewSource?.source !== 'terminalArtifact' || !canSaveArtifact || saving) {
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const result = await saveMobileTerminalArtifactPreview(client, previewSource, draftContent, {
        baseContent: savedContent,
        onTerminalArtifactSourceRefreshed: setPreviewSource
      })
      if (result.status === 'saved') {
        setSavedContent(draftContent)
      } else {
        setSaveError(saveErrorMessageFromPreviewResult(result))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to save file'
      setSaveError(message)
    } finally {
      setSaving(false)
    }
  }, [canSaveArtifact, client, draftContent, previewSource, savedContent, saving])

  const leave = useCallback(() => router.back(), [router])
  const { confirmingDiscard, requestBack, stay, discard } = useMobileFilePreviewBack({
    hasUnsavedDraft: hasUnsavedTerminalArtifactDraft,
    leave
  })

  return (
    <View style={styles.container}>
      <MobileFilePreviewHeader
        title={title || 'Preview'}
        meta={meta}
        canSave={canSaveArtifact}
        saving={saving}
        actionsExpanded={actionSheetVisible}
        onBack={requestBack}
        onSave={() => void saveArtifact()}
        onActions={() => setActionSheetVisible(true)}
      />
      <MobileFileDownloadProgress
        state={actions.task.state}
        notice={actions.notice}
        onCancel={actions.task.cancel}
        onRetry={actions.retry}
        onDismissNotice={actions.dismissNotice}
      />
      <MobileFilePreviewHtmlControls
        htmlFile={htmlFile}
        sourceOnly={terminalArtifact}
        readFailed={previewReadFailed}
        mode={htmlMode}
        truncated={htmlTruncated}
        notice={preferenceNotice}
        fileLabel={title}
        sheetVisible={htmlModeSheetVisible}
        onChangeMode={setHtmlMode}
        onSelectMode={handleHtmlModeSelect}
        onDismissNotice={() => setPreferenceNotice(null)}
        onCloseSheet={closeHtmlModeSheet}
      />
      <MobileFilePreviewBody
        preview={preview}
        client={client}
        relativePath={displayPath}
        title={title || 'File'}
        editable={isEditableTerminalArtifact}
        draftContent={draftContent}
        saveError={saveError}
        lineColumn={lineColumn}
        imageWidth={Math.max(1, width - spacing.md * 2)}
        imageHeight={Math.max(240, height - 160)}
        htmlMode={htmlMode}
        htmlRenderable={preview.status === 'ready' && preview.kind === 'html' && !htmlTruncated}
        sourceOnly={terminalArtifact}
        truncatedNote={truncatedNote}
        onDraftChange={setDraftContent}
        onImageError={() =>
          setPreview({ status: 'error', message: 'Unable to load preview', reconnect: false })
        }
        onRetry={retry}
      />
      <MobileFilePreviewOverlays
        actionSheetVisible={actionSheetVisible}
        onCloseActionSheet={() => setActionSheetVisible(false)}
        actionTarget={actionTarget}
        capabilities={actions.capabilities}
        busy={actions.busy}
        htmlActionState={htmlActionState}
        onAction={handleAction}
        saveResult={actions.saveResult}
        onCloseSaveResult={actions.dismissSaveResult}
        confirmingDiscard={confirmingDiscard}
        onConfirmDiscard={discard}
        onStay={stay}
      />
    </View>
  )
}
