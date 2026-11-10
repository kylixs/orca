import { useRef, useState } from 'react'
import { StyleSheet, Switch, Text, View } from 'react-native'
import { Code, Eye, X } from 'lucide-react-native'
import { ActionSheetContent, type ActionSheetAction } from '../components/ActionSheetModal'
import { BottomDrawer } from '../components/BottomDrawer'
import { colors, spacing, typography } from '../theme/mobile-theme'
import type { MobileHtmlPreviewMode } from './mobile-html-open-mode'

/**
 * The automatic chooser: only the two open modes and Cancel, plus the remember switch.
 *
 * External actions belong to the shared file action sheet and never appear here. Selecting Cancel
 * and selecting an external action both leave `orca:mobileHtmlOpenMode` untouched; only a mode
 * chosen while the switch is on is written by the caller.
 */
export function MobileFileOpenModeSheet(props: {
  visible: boolean
  fileLabel?: string
  previewDisabled?: boolean
  onSelect: (mode: MobileHtmlPreviewMode, remember: boolean) => void
  onClose: () => void
  /** A close with no mode choice, so the caller can drop its captured target. */
  onDismiss?: () => void
}) {
  const [remember, setRemember] = useState(false)
  const [wasVisible, setWasVisible] = useState(props.visible)
  const pendingChoiceRef = useRef<{ mode: MobileHtmlPreviewMode; remember: boolean } | null>(null)
  // Reset on close during render; an effect would paint the previous choice once.
  if (wasVisible !== props.visible) {
    setWasVisible(props.visible)
    if (!props.visible) {
      setRemember(false)
    }
  }

  const choose = (mode: MobileHtmlPreviewMode) => {
    pendingChoiceRef.current = { mode, remember }
  }

  const close = () => {
    const selecting = pendingChoiceRef.current !== null
    props.onClose()
    if (!selecting) {
      props.onDismiss?.()
    }
  }

  const actions: ActionSheetAction[] = [
    {
      label: 'Preview',
      icon: Eye,
      disabled: props.previewDisabled,
      onPress: () => {
        if (!props.previewDisabled) {
          choose('preview')
        }
      }
    },
    { label: 'Source', icon: Code, onPress: () => choose('source') },
    { label: 'Cancel', icon: X, onPress: () => undefined }
  ]

  return (
    <BottomDrawer
      visible={props.visible}
      onClose={close}
      // Why: iOS cannot present the preview screen's native modal until this drawer has fully
      // unmounted, so navigation waits for the close to land.
      onAfterClose={() => {
        const pending = pendingChoiceRef.current
        pendingChoiceRef.current = null
        if (pending) {
          props.onSelect(pending.mode, pending.remember)
        }
      }}
      dragContentToDismiss
    >
      <View style={styles.header}>
        <Text style={styles.title}>Open HTML file</Text>
        {props.fileLabel ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {props.fileLabel}
          </Text>
        ) : null}
      </View>
      <ActionSheetContent actions={actions} onClose={close} />
      <View style={styles.rememberRow}>
        <View style={styles.rememberText}>
          <Text style={styles.rememberLabel}>Remember my choice</Text>
          <Text style={styles.rememberHint}>Applies to Preview and Source only</Text>
        </View>
        <Switch
          value={remember}
          onValueChange={setRemember}
          accessibilityRole="switch"
          accessibilityLabel="Remember my choice for HTML Preview or Source"
          accessibilityState={{ checked: remember }}
          trackColor={{ false: colors.bgRaised, true: colors.accentBlue }}
        />
      </View>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textMuted
  },
  subtitle: {
    marginTop: 2,
    fontSize: 11,
    color: colors.textMuted
  },
  rememberRow: {
    minHeight: 44,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: 12,
    backgroundColor: colors.bgPanel
  },
  rememberText: {
    flex: 1,
    minWidth: 0
  },
  rememberLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rememberHint: {
    marginTop: 1,
    fontSize: 11,
    color: colors.textMuted
  }
})
