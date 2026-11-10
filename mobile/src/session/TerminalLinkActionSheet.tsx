import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { Check, ChevronDown, ChevronUp, Copy, Monitor, Smartphone, X } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { presentTerminalLink, terminalLinkWarnings } from './terminal-link-presentation'
import type { TerminalLinkRemoteAvailability } from './terminal-link-open-policy'
import type { MobileTerminalLinkOpenMode } from '../storage/preferences'

type PreselectedMode = Exclude<MobileTerminalLinkOpenMode, 'ask'>

type Props = {
  visible: boolean
  url: string | null
  /** The legacy preference, shown once on the first sheet only. */
  preselect: PreselectedMode | null
  remote: TerminalLinkRemoteAvailability
  onOpenOnPhone: (remember: boolean) => void
  onOpenOnDesktop: (remember: boolean) => void
  onCopy: () => void
  onCancel: () => void
}

export function TerminalLinkActionSheet(props: Props): React.JSX.Element {
  const { visible, url, onCancel } = props
  return (
    <BottomDrawer visible={visible} onClose={onCancel} dragContentToDismiss>
      {/* Why: keying the body gives each URL/open a fresh expanded/Remember state without a
          post-paint reset that can show the previous sheet's state for a frame. */}
      <TerminalLinkSheetBody key={visible ? `open:${url ?? ''}` : 'closed'} {...props} />
    </BottomDrawer>
  )
}

function TerminalLinkSheetBody({
  url,
  preselect,
  remote,
  onOpenOnPhone,
  onOpenOnDesktop,
  onCopy,
  onCancel
}: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [remember, setRemember] = useState(false)
  const presentation = url ? presentTerminalLink(url) : null
  const warnings = presentation ? terminalLinkWarnings(presentation) : []

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.title}>Open link</Text>
        <Text style={styles.message}>Choose where to open this link.</Text>
      </View>

      {presentation ? (
        <View style={styles.urlBlock}>
          <Text style={styles.urlSummary} selectable>
            {expanded ? presentation.full : presentation.summary}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Show URL summary' : 'Show full URL'}
            accessibilityState={{ expanded }}
            hitSlop={8}
            style={styles.expandButton}
            onPress={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <ChevronUp size={14} color={colors.textSecondary} />
            ) : (
              <ChevronDown size={14} color={colors.textSecondary} />
            )}
            <Text style={styles.expandText}>{expanded ? 'Hide full URL' : 'Show full URL'}</Text>
          </Pressable>
          {warnings.map((warning) => (
            <Text key={warning} style={styles.warning}>
              {warning}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.actionGroup}>
        <ActionRow
          icon={<Smartphone size={16} color={colors.textSecondary} />}
          label="Open on this phone"
          selected={preselect === 'phone-browser'}
          onPress={() => onOpenOnPhone(remember)}
        />
        {remote.hidden ? null : (
          <>
            <View style={styles.separator} />
            <ActionRow
              icon={<Monitor size={16} color={colors.textSecondary} />}
              label="Open in Orca on desktop"
              hint={remote.hint ?? undefined}
              disabled={!remote.available}
              selected={preselect === 'orca-browser'}
              onPress={() => onOpenOnDesktop(remember)}
            />
          </>
        )}
        <View style={styles.separator} />
        <ActionRow
          icon={<Copy size={16} color={colors.textSecondary} />}
          label="Copy link"
          onPress={onCopy}
        />
        <View style={styles.separator} />
        <ActionRow
          icon={<X size={16} color={colors.textSecondary} />}
          label="Cancel"
          onPress={onCancel}
        />
      </View>

      <Pressable
        accessibilityRole="switch"
        accessibilityLabel="Remember my choice"
        accessibilityState={{ checked: remember }}
        style={styles.rememberRow}
        onPress={() => setRemember((value) => !value)}
      >
        <View style={styles.rememberText}>
          <Text style={styles.rememberLabel}>Remember my choice</Text>
          <Text style={styles.rememberHint}>You can change this in Settings › Browser.</Text>
        </View>
        <View pointerEvents="none">
          <Switch
            value={remember}
            onValueChange={setRemember}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
        </View>
      </Pressable>
    </View>
  )
}

function ActionRow({
  icon,
  label,
  hint,
  selected = false,
  disabled = false,
  onPress
}: {
  icon: ReactNode
  label: string
  hint?: string
  selected?: boolean
  disabled?: boolean
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.action,
        disabled && styles.actionDisabled,
        pressed && !disabled && styles.actionPressed
      ]}
      onPress={onPress}
    >
      {icon}
      <View style={styles.actionTextBlock}>
        <Text style={[styles.actionText, disabled && styles.actionTextDisabled]}>{label}</Text>
        {hint ? <Text style={styles.actionHint}>{hint}</Text> : null}
      </View>
      {selected ? <Check size={16} color={colors.statusGreen} /> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  sheet: {
    gap: spacing.sm
  },
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs
  },
  title: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textMuted
  },
  message: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2
  },
  urlBlock: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    padding: spacing.md
  },
  urlSummary: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  expandButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: 44,
    gap: 4,
    marginTop: 2
  },
  expandText: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  warning: {
    fontSize: typography.metaSize,
    color: colors.statusAmber,
    lineHeight: 17,
    marginTop: spacing.xs
  },
  actionGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    gap: spacing.sm + 2,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md + 2
  },
  actionDisabled: {
    opacity: 0.58
  },
  actionPressed: {
    backgroundColor: colors.bgRaised
  },
  actionTextBlock: {
    flex: 1,
    minWidth: 0
  },
  actionText: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  actionTextDisabled: {
    color: colors.textSecondary
  },
  actionHint: {
    marginTop: 2,
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  rememberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md + 2
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
    marginTop: 2,
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
})
