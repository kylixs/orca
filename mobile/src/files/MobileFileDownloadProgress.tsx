import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { formatPreviewByteLength } from './mobile-file-preview-response'
import type { FileActionTaskState } from './mobile-file-action-tasks'
import type { MobileFileActionNotice } from './use-mobile-file-actions'

export function MobileFileDownloadProgress(props: {
  state: FileActionTaskState
  notice?: MobileFileActionNotice | null
  onCancel: () => void
  onRetry: () => void
  onDismissNotice: () => void
}) {
  const { state } = props
  return (
    <>
      {props.notice ? (
        <View style={[styles.banner, props.notice.tone === 'error' && styles.bannerError]}>
          <Text
            style={[styles.text, props.notice.tone === 'error' && styles.textError]}
            accessibilityLiveRegion="polite"
          >
            {props.notice.message}
          </Text>
          <Pressable
            onPress={props.onDismissNotice}
            hitSlop={10}
            accessibilityLabel="Dismiss message"
            style={styles.iconButton}
          >
            <X size={14} color={colors.textSecondary} />
          </Pressable>
        </View>
      ) : null}
      {state.status === 'preparing' ? (
        <View style={styles.banner}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <View style={styles.progressBlock}>
            <Text style={styles.text} accessibilityLiveRegion="polite">
              Preparing file… {formatPreviewByteLength(state.bytes)}
              {state.total !== null ? ` / ${formatPreviewByteLength(state.total)}` : ''}
            </Text>
            {state.total !== null && state.total > 0 ? (
              <View style={styles.track}>
                <View
                  style={[
                    styles.fill,
                    { width: `${Math.min(100, Math.round((state.bytes / state.total) * 100))}%` }
                  ]}
                />
              </View>
            ) : null}
          </View>
          <Pressable
            onPress={props.onCancel}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Cancel file action"
            style={styles.actionButton}
          >
            <Text style={styles.actionText}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      {state.status === 'failed' ? (
        <View style={[styles.banner, styles.bannerError]}>
          <Text style={[styles.text, styles.textError]}>{state.message}</Text>
          {state.retryable ? (
            <Pressable
              onPress={props.onRetry}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Retry file action"
              style={styles.actionButton}
            >
              <Text style={styles.actionText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.row,
    backgroundColor: colors.bgRaised
  },
  bannerError: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusRed
  },
  progressBlock: {
    flex: 1,
    minWidth: 0,
    gap: 4
  },
  text: {
    flex: 1,
    minWidth: 0,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  textError: {
    color: colors.statusRed
  },
  track: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  fill: {
    height: 3,
    backgroundColor: colors.textPrimary
  },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center'
  },
  actionButton: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm
  },
  actionText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
})
