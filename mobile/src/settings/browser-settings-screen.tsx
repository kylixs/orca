import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight, FileCode2, Globe } from 'lucide-react-native'
import { PickerModal, type PickerOption } from '../components/PickerModal'
import {
  loadMobileHtmlOpenMode,
  loadTerminalLinkOpenMode,
  saveMobileHtmlOpenMode,
  saveTerminalLinkOpenMode,
  type MobileTerminalLinkOpenMode
} from '../storage/preferences'
import type { MobileHtmlOpenMode } from '../files/mobile-html-open-mode'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

const LINK_MODE_OPTIONS: PickerOption<MobileTerminalLinkOpenMode>[] = [
  {
    value: 'ask',
    label: 'Ask every time',
    subtitle: 'Choose where each link opens.'
  },
  {
    value: 'orca-browser',
    label: 'Orca browser on desktop',
    subtitle: 'Open in the streamed browser from your paired desktop.'
  },
  {
    value: 'phone-browser',
    label: 'Phone browser',
    subtitle: 'Open in Safari, Chrome, or another browser on this phone.'
  }
]

const HTML_OPEN_MODE_OPTIONS: PickerOption<MobileHtmlOpenMode>[] = [
  {
    value: 'ask',
    label: 'Ask',
    subtitle: 'Show Preview / Source on the next HTML file'
  },
  {
    value: 'preview',
    label: 'Preview',
    subtitle: 'Open rendered HTML directly'
  },
  {
    value: 'source',
    label: 'Source',
    subtitle: 'Open the text view directly'
  }
]

function linkModeLabel(mode: MobileTerminalLinkOpenMode): string {
  return (
    LINK_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? LINK_MODE_OPTIONS[0]!.label
  )
}

function htmlOpenModeLabel(mode: MobileHtmlOpenMode): string {
  return (
    HTML_OPEN_MODE_OPTIONS.find((option) => option.value === mode)?.label ??
    HTML_OPEN_MODE_OPTIONS[0]!.label
  )
}

export default function BrowserSettingsScreen({
  onBack
}: {
  onBack?: () => void
}): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [linkMode, setLinkMode] = useState<MobileTerminalLinkOpenMode>('ask')
  const [htmlOpenMode, setHtmlOpenMode] = useState<MobileHtmlOpenMode>('ask')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [htmlPickerOpen, setHtmlPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void loadTerminalLinkOpenMode().then(
      (mode) => {
        if (active) {
          setLinkMode(mode)
        }
      },
      () => {
        if (active) {
          setError('Could not load browser preferences. Try again.')
        }
      }
    )
    // `loadMobileHtmlOpenMode` already falls back to `ask`; a corrupt store is not a screen error.
    void loadMobileHtmlOpenMode().then((mode) => {
      if (active) {
        setHtmlOpenMode(mode)
      }
    })
    return () => {
      active = false
    }
  }, [])

  const selectLinkMode = useCallback((mode: MobileTerminalLinkOpenMode) => {
    setError(null)
    // Optimistic, as base was: the row shows the tapped mode before the write lands.
    setLinkMode(mode)
    void saveTerminalLinkOpenMode(mode).catch(() =>
      setError('Could not save browser preferences. Try again.')
    )
  }, [])

  const selectHtmlOpenMode = useCallback(
    (mode: MobileHtmlOpenMode) => {
      const previous = htmlOpenMode
      setError(null)
      setHtmlOpenMode(mode)
      void saveMobileHtmlOpenMode(mode).catch(() => {
        // The stored value is what the next tap reads, so the row must not claim it changed.
        setHtmlOpenMode(previous)
        setError('Could not save HTML open mode. Try again.')
      })
    },
    [htmlOpenMode]
  )

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
          onPress={onBack ?? (() => router.back())}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Browser</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.groupHeading}>LINKS</Text>
        <Text style={styles.groupDescription}>
          Choose where HTTP(S) links tapped in terminal output open.
        </Text>
        {error && (
          <Text accessibilityRole="alert" style={styles.groupDescription}>
            {error}
          </Text>
        )}
        <View style={[styles.section, styles.sectionTopGap]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open terminal links"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setPickerOpen(true)}
          >
            <Globe size={16} color={colors.textSecondary} />
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Open terminal links</Text>
              <Text style={styles.rowSublabel}>{linkModeLabel(linkMode)}</Text>
            </View>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        </View>

        <Text style={[styles.groupHeading, styles.sectionTopGap]}>FILES</Text>
        <Text style={styles.groupDescription}>
          Choose how HTML files open from the file browser. This is the only place to reset the
          choice to Ask.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`HTML open mode, current value ${htmlOpenModeLabel(htmlOpenMode)}`}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setHtmlPickerOpen(true)}
          >
            <FileCode2 size={16} color={colors.textSecondary} />
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>HTML open mode</Text>
              <Text style={styles.rowSublabel}>{htmlOpenModeLabel(htmlOpenMode)}</Text>
            </View>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      </ScrollView>

      <PickerModal<MobileTerminalLinkOpenMode>
        visible={pickerOpen}
        title="Open terminal links"
        options={LINK_MODE_OPTIONS}
        selected={linkMode}
        onSelect={selectLinkMode}
        onClose={() => setPickerOpen(false)}
      />
      <PickerModal<MobileHtmlOpenMode>
        visible={htmlPickerOpen}
        title="HTML open mode"
        options={HTML_OPEN_MODE_OPTIONS}
        selected={htmlOpenMode}
        onSelect={selectHtmlOpenMode}
        onClose={() => setHtmlPickerOpen(false)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg,
    paddingTop: 0
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  scrollContent: {
    paddingBottom: spacing.xl
  },
  groupHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  groupDescription: {
    fontSize: typography.bodySize - 1,
    color: colors.textSecondary,
    lineHeight: 20,
    paddingHorizontal: spacing.xs
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  sectionTopGap: {
    marginTop: spacing.sm
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowContent: {
    flex: 1
  },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowSublabel: {
    fontSize: typography.bodySize - 2,
    color: colors.textSecondary,
    marginTop: 2
  }
})
