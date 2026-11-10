import { useRef } from 'react'
import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  File,
  FileText,
  Folder,
  Image as ImageIcon
} from 'lucide-react-native'
import { triggerMediumImpact, triggerSelection } from '../platform/haptics'
import { colors, spacing } from '../theme/mobile-theme'
import { type FileExplorerRow, isMarkdownPath, type TreeNode } from './file-tree'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'
import { canPreviewMobileFileRow } from './mobile-file-preview-navigation'
import type { FileReadFailure } from './file-read-failures'

type Props = {
  item: FileExplorerRow
  expanded: ReadonlySet<string>
  onPreviewFile: (relativePath: string, displayName: string) => void
  onRetryDirectory: (relativePath: string) => void
  onToggleDirectory: (relativePath: string) => void
  onShowActions: (item: TreeNode) => void
  readFailure?: FileReadFailure
  /** Search results show the full relative path so two same-named files stay distinguishable. */
  showPath?: boolean
}

export function MobileFileExplorerRow(props: Props) {
  const { item, expanded, onPreviewFile, onRetryDirectory, onToggleDirectory } = props

  if (item.kind === 'loading') {
    return (
      <View style={[styles.inlineStatusRow, { paddingLeft: spacing.lg + item.depth * 18 }]}>
        <View style={styles.chevronSpacer} />
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={styles.inlineStatusText}>Loading...</Text>
      </View>
    )
  }

  if (item.kind === 'error') {
    return (
      <View style={[styles.inlineStatusRow, { paddingLeft: spacing.lg + item.depth * 18 }]}>
        <View style={styles.chevronSpacer} />
        <Text style={styles.inlineErrorText} numberOfLines={1}>
          {item.message || 'Unable to load folder'}
        </Text>
        <Pressable
          style={({ pressed }) => [styles.inlineRetryButton, pressed && styles.rowPressed]}
          onPress={() => {
            triggerSelection()
            onRetryDirectory(item.relativePath)
          }}
          accessibilityLabel={`Retry loading ${item.relativePath}`}
        >
          <Text style={styles.inlineRetryText}>Retry</Text>
        </Pressable>
      </View>
    )
  }

  if (isTreeNode(item)) {
    return (
      <TreeRow
        item={item}
        expanded={expanded}
        onPreviewFile={onPreviewFile}
        onToggleDirectory={onToggleDirectory}
        onShowActions={props.onShowActions}
        readFailure={props.readFailure}
        showPath={props.showPath}
      />
    )
  }

  return null
}

function isTreeNode(item: FileExplorerRow): item is TreeNode {
  return item.kind === 'directory' || item.kind === 'text' || item.kind === 'binary'
}

function TreeRow(props: {
  item: TreeNode
  expanded: ReadonlySet<string>
  onPreviewFile: (relativePath: string, displayName: string) => void
  onToggleDirectory: (relativePath: string) => void
  onShowActions: (item: TreeNode) => void
  readFailure?: FileReadFailure
  showPath?: boolean
}) {
  const { item, expanded, onPreviewFile, onToggleDirectory, onShowActions, readFailure } = props
  const isDirectory = item.kind === 'directory'
  const isExpanded = expanded.has(item.relativePath)
  const previewable =
    item.kind !== 'directory' &&
    canPreviewMobileFileRow({ kind: item.kind, relativePath: item.relativePath })
  const isImage = item.kind === 'binary' && classifyMobileArtifact(item.relativePath) === 'image'
  const markdown = item.kind === 'text' && isMarkdownPath(item.relativePath)

  // Per gesture, so a release after a long press cannot also preview while the next tap still can.
  const longPressFiredRef = useRef(false)

  const showActions = () => {
    longPressFiredRef.current = true
    triggerMediumImpact()
    onShowActions(item)
  }

  const accessibilityLabel = isDirectory
    ? `Open folder ${item.name}`
    : previewable
      ? `Preview file ${item.name}`
      : `File ${item.name}`

  return (
    <View style={styles.rowContainer}>
      <Pressable
        style={({ pressed }) => [
          styles.row,
          { paddingLeft: spacing.lg + item.depth * 18 },
          pressed && styles.rowPressed
        ]}
        onPressIn={() => {
          longPressFiredRef.current = false
        }}
        onPress={() => {
          if (longPressFiredRef.current) {
            return
          }
          triggerSelection()
          if (isDirectory) {
            onToggleDirectory(item.relativePath)
          } else if (previewable) {
            onPreviewFile(item.relativePath, item.name)
          }
        }}
        onLongPress={showActions}
        delayLongPress={500}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint="Long press for file actions"
      >
        {isDirectory ? (
          isExpanded ? (
            <ChevronDown size={16} color={colors.textSecondary} />
          ) : (
            <ChevronRight size={16} color={colors.textSecondary} />
          )
        ) : (
          <View style={styles.chevronSpacer} />
        )}
        {isDirectory ? (
          <Folder size={17} color={colors.textSecondary} />
        ) : markdown ? (
          <FileText size={17} color={colors.textSecondary} />
        ) : isImage ? (
          <ImageIcon size={17} color={colors.textSecondary} />
        ) : (
          <File size={17} color={colors.textSecondary} />
        )}
        <View style={styles.rowTextBlock}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.name}
          </Text>
          {readFailure ? (
            <Text style={styles.rowReadFailed}>Read failed</Text>
          ) : props.showPath && item.relativePath !== item.name ? (
            <Text style={styles.rowMeta} numberOfLines={1}>
              {item.relativePath}
            </Text>
          ) : item.filterNote ? (
            <Text style={styles.rowMeta}>{item.filterNote}</Text>
          ) : previewable || isDirectory ? null : (
            <Text style={styles.rowMeta}>No mobile preview</Text>
          )}
        </View>
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.rowActionsButton, pressed && styles.rowPressed]}
        onPress={() => {
          triggerSelection()
          onShowActions(item)
        }}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`File actions for ${item.name}`}
      >
        <Ellipsis size={18} color={colors.textSecondary} />
      </Pressable>
    </View>
  )
}
