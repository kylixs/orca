import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Code, Eye } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { MobileHtmlPreviewMode } from './mobile-html-open-mode'

/**
 * The file preview's second-row mode toolbar. The header keeps one overflow entry; this is the
 * only Preview/Source control on the screen.
 */
export function MobileFileHtmlModeToolbar(props: {
  mode: MobileHtmlPreviewMode
  previewDisabled: boolean
  onChange: (mode: MobileHtmlPreviewMode) => void
}) {
  const previewSelected = props.mode === 'preview'
  const sourceSelected = props.mode === 'source'
  return (
    <View style={styles.container}>
      <View style={styles.toolbar} accessibilityRole="tablist">
        <Pressable
          style={[
            styles.toggle,
            previewSelected && styles.toggleActive,
            props.previewDisabled && styles.toggleDisabled
          ]}
          onPress={() => props.onChange('preview')}
          disabled={props.previewDisabled}
          hitSlop={8}
          accessibilityRole="tab"
          accessibilityState={{ selected: previewSelected, disabled: props.previewDisabled }}
          aria-selected={previewSelected}
          accessibilityLabel="Preview rendered HTML"
        >
          <Eye
            size={14}
            color={previewSelected ? colors.textPrimary : colors.textSecondary}
            strokeWidth={2.2}
          />
          <Text style={styles.toggleText}>Preview</Text>
        </Pressable>
        <Pressable
          style={[styles.toggle, sourceSelected && styles.toggleActive]}
          onPress={() => props.onChange('source')}
          hitSlop={8}
          accessibilityRole="tab"
          accessibilityState={{ selected: sourceSelected }}
          aria-selected={sourceSelected}
          accessibilityLabel="View HTML source"
        >
          <Code
            size={14}
            color={sourceSelected ? colors.textPrimary : colors.textSecondary}
            strokeWidth={2.2}
          />
          <Text style={styles.toggleText}>Source</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.editorSurface
  },
  toolbar: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    gap: spacing.sm
  },
  toggle: {
    minWidth: 44,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  toggleActive: {
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  toggleDisabled: {
    opacity: 0.5
  },
  toggleText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  }
})
