import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItem
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, X } from 'lucide-react-native'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useHostClient, useForceReconnect } from '../transport/client-context'
import { getWorktreeLabel } from '../session/worktree-label'
import type { FileExplorerRow, TreeNode } from './file-tree'
import { colors } from '../theme/mobile-theme'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'
import { MobileFileExplorerRow } from './mobile-file-explorer-row'
import {
  canPreviewMobileFileRow,
  navigateToMobileFilePreview
} from './mobile-file-preview-navigation'
import type { FileActionTarget } from './mobile-file-actions'
import { fileTargetKindForPath } from './mobile-file-target-kind'
import { MobileFileActionSheet } from './MobileFileActionSheet'
import { MobileFileOpenModeSheet } from './MobileFileOpenModeSheet'
import type { MobileHtmlPreviewMode } from './mobile-html-open-mode'
import { HostRouteNoticeBanner } from '../components/HostRouteNoticeBanner'
import { useMobileFileHtmlOpenMode } from './use-mobile-file-html-open-mode'
import { MobileFileSaveResultSheet } from './MobileFileSaveResultSheet'
import { MobileFileSearchBar } from './MobileFileSearchBar'
import { MobileFileFilterChips } from './MobileFileFilterChips'
import { MobileFileDownloadProgress } from './MobileFileDownloadProgress'
import { MobileFileSearchResults, mobileFileSearchNote } from './MobileFileSearchResults'
import {
  clearFileReadFailure,
  clearNetworkFileReadFailures,
  getFileReadFailure,
  getFileReadFailuresVersion,
  subscribeFileReadFailures,
  type FileReadFailureScope
} from './file-read-failures'
import { matchesFileCategory, type MobileFileCategory } from './file-category'
import { useMobileFileActions } from './use-mobile-file-actions'
import { useMobileFileExplorerDirectories } from './use-mobile-file-explorer-directories'
import { useMobileFileSearch } from './use-mobile-file-search'

export function MobileFileExplorerPanel(props: {
  hostId: string
  worktreeId: string
  name?: string
  embedded?: boolean
  onRequestClose?: () => void
}) {
  const { hostId, worktreeId, name, embedded, onRequestClose } = props
  const router = useRouteHandoff()
  const { client, state: connState } = useHostClient(hostId)
  const forceReconnect = useForceReconnect()
  const connected = connState === 'connected'
  const worktreeLabel = getWorktreeLabel(name, worktreeId)
  const readFailureScope = useMemo<FileReadFailureScope>(
    () => ({ hostId, worktreeId }),
    [hostId, worktreeId]
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [category, setCategory] = useState<MobileFileCategory>('all')
  const [actionTarget, setActionTarget] = useState<FileActionTarget | null>(null)
  const [actionSheetVisible, setActionSheetVisible] = useState(false)

  const directories = useMobileFileExplorerDirectories({
    hostId,
    worktreeId,
    client,
    connected,
    forceReconnect,
    category
  })
  const search = useMobileFileSearch({ client, worktreeId, query: searchQuery, connected })
  const actions = useMobileFileActions({
    client,
    target: actionTarget,
    scope: readFailureScope
  })

  // Why: the registry is module-level so a failure recorded by the preview route is visible here.
  const readFailuresVersion = useSyncExternalStore(
    subscribeFileReadFailures,
    getFileReadFailuresVersion,
    getFileReadFailuresVersion
  )
  const readFailureFor = useCallback(
    (relativePath: string) => getFileReadFailure(readFailureScope, relativePath),
    // The version is the subscription signal; the lookup itself reads the mutable registry.
    [readFailureScope, readFailuresVersion]
  )

  const previousConnectionStateRef = useRef(connState)
  useEffect(() => {
    const previous = previousConnectionStateRef.current
    previousConnectionStateRef.current = connState
    if (connected && previous !== 'connected') {
      // A reconnect can fix a dropped transport; it cannot fix EACCES/ENOENT.
      clearNetworkFileReadFailures(readFailureScope)
    }
  }, [connected, connState, readFailureScope])

  const filteredSearchResults = useMemo(
    () => search.results.filter((entry) => matchesFileCategory(entry.relativePath, category)),
    [category, search.results]
  )
  const searchRows = useMemo(
    () =>
      filteredSearchResults.map((entry): TreeNode => ({
        id: `search:${entry.relativePath}`,
        name: entry.basename,
        relativePath: entry.relativePath,
        depth: 0,
        kind: entry.kind
      })),
    [filteredSearchResults]
  )

  const openPreviewFile = useCallback(
    (relativePath: string, displayName: string, mode?: MobileHtmlPreviewMode) => {
      navigateToMobileFilePreview(
        router,
        {
          hostId,
          worktreeId,
          relativePath,
          name: displayName,
          worktreeName: name,
          ...(mode ? { mode } : {})
        },
        { embedded, onRequestClose }
      )
    },
    [embedded, hostId, name, onRequestClose, router, worktreeId]
  )

  const {
    previewFile,
    pending: pendingHtmlOpen,
    selectMode: selectHtmlOpenMode,
    notice: preferenceNotice,
    dismissNotice,
    closeChooser,
    dismissChooser
  } = useMobileFileHtmlOpenMode(openPreviewFile)

  const targetForRow = useCallback(
    (item: TreeNode): FileActionTarget => ({
      source: 'worktree',
      hostId,
      worktreeId,
      relativePath: item.relativePath,
      name: item.name,
      kind:
        item.kind === 'directory'
          ? 'directory'
          : fileTargetKindForPath(item.relativePath, item.kind),
      previewable:
        item.kind !== 'directory' &&
        canPreviewMobileFileRow({ kind: item.kind, relativePath: item.relativePath }),
      readFailed: Boolean(readFailureFor(item.relativePath))
    }),
    [hostId, readFailureFor, worktreeId]
  )

  const showActions = useCallback(
    (item: TreeNode) => {
      setActionTarget(targetForRow(item))
      setActionSheetVisible(true)
    },
    [targetForRow]
  )

  const handleAction = useCallback(
    (id: string) => {
      if (!actionTarget) {
        return
      }
      if (actionTarget.source === 'worktree') {
        switch (id) {
          case 'preview':
          case 'source':
            // A menu choice applies to this open only; it never writes the preference. `mode` is
            // the HTML open mode, so a non-HTML row's shared Preview must not carry one.
            openPreviewFile(
              actionTarget.relativePath,
              actionTarget.name,
              actionTarget.kind === 'html' ? id : undefined
            )
            return
          case 'retry':
            clearFileReadFailure(readFailureScope, actionTarget.relativePath)
            if (actionTarget.previewable) {
              openPreviewFile(actionTarget.relativePath, actionTarget.name)
            }
            return
          default:
            break
        }
      }
      switch (id) {
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
    [actionTarget, actions, openPreviewFile, readFailureScope]
  )

  const renderItem: ListRenderItem<FileExplorerRow> = ({ item }) => (
    <MobileFileExplorerRow
      item={item}
      expanded={directories.expanded}
      onPreviewFile={previewFile}
      onRetryDirectory={directories.retryDirectory}
      onToggleDirectory={directories.toggleDirectory}
      onShowActions={showActions}
      readFailure={
        item.kind === 'loading' || item.kind === 'error'
          ? undefined
          : readFailureFor(item.relativePath)
      }
      showPath={searchQuery.trim().length > 0}
    />
  )

  const headerBar = (
    <View style={styles.topBar}>
      {embedded ? (
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={() => onRequestClose?.()}
          hitSlop={8}
          accessibilityLabel="Close files"
        >
          <X size={20} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      ) : (
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back to session"
        >
          <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      )}
      <View style={styles.titleBlock}>
        <Text style={styles.title} numberOfLines={1}>
          Files
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {worktreeLabel}
          {directories.legacyListTruncated
            ? ' - Showing first 5000; results may be incomplete'
            : ''}
        </Text>
      </View>
    </View>
  )

  const searching = searchQuery.trim().length > 0
  const searchStatus = searching
    ? mobileFileSearchNote(search, category, filteredSearchResults.length)
    : null
  const body = searching ? (
    <MobileFileSearchResults
      status={search.status}
      error={search.error}
      rows={searchRows}
      note={searchStatus}
      onRetry={() => {
        if (!connected) {
          void forceReconnect?.(hostId)
        }
        search.retry()
      }}
      renderItem={renderItem}
    />
  ) : directories.loading ? (
    <View style={styles.state}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : directories.error ? (
    <View style={styles.state}>
      <Text style={styles.errorText}>{directories.error}</Text>
      {directories.rootRetry ? (
        <Pressable style={styles.retryButton} onPress={directories.rootRetry}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  ) : directories.rows.length === 0 ? (
    <View style={styles.state}>
      <Text style={styles.emptyText}>No files found</Text>
    </View>
  ) : (
    <FlatList
      data={directories.rows}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      style={styles.list}
    />
  )

  return (
    <View style={styles.container}>
      {embedded ? (
        <View style={styles.header}>{headerBar}</View>
      ) : (
        <SafeAreaView style={styles.header} edges={['top']}>
          {headerBar}
        </SafeAreaView>
      )}
      <MobileFileSearchBar
        value={searchQuery}
        onChangeText={setSearchQuery}
        onClear={() => setSearchQuery('')}
      />
      <MobileFileFilterChips selected={category} onSelect={setCategory} />
      <MobileFileDownloadProgress
        state={actions.task.state}
        notice={actions.notice}
        onCancel={actions.task.cancel}
        onRetry={actions.retry}
        onDismissNotice={actions.dismissNotice}
      />
      {preferenceNotice ? (
        <HostRouteNoticeBanner
          message={preferenceNotice}
          tone="failure"
          onDismiss={dismissNotice}
        />
      ) : null}
      {body}
      <MobileFileActionSheet
        visible={actionSheetVisible}
        target={actionTarget}
        context="list"
        capabilities={actions.capabilities}
        busy={actions.busy}
        htmlActionState={
          actionTarget?.kind === 'html'
            ? {
                source: actionTarget.source,
                previewDisabled: false,
                readFailed: Boolean(actionTarget.readFailed)
              }
            : undefined
        }
        onAction={handleAction}
        onClose={() => setActionSheetVisible(false)}
      />
      <MobileFileOpenModeSheet
        visible={pendingHtmlOpen !== null}
        fileLabel={pendingHtmlOpen?.name}
        onSelect={selectHtmlOpenMode}
        onClose={closeChooser}
        onDismiss={dismissChooser}
      />
      <MobileFileSaveResultSheet result={actions.saveResult} onClose={actions.dismissSaveResult} />
    </View>
  )
}
