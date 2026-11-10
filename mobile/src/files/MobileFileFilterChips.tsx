import { Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  MOBILE_FILE_CATEGORIES,
  MOBILE_FILE_CATEGORY_LABELS,
  type MobileFileCategory
} from './file-category'

export function MobileFileFilterChips(props: {
  selected: MobileFileCategory
  onSelect: (category: MobileFileCategory) => void
}) {
  return (
    <ScrollView
      horizontal
      // Why: a horizontal ScrollView defaults to flexGrow: 1, so inside the Files column it took
      // every remaining pixel and pushed the list off-screen. The row is content-sized.
      style={styles.scroll}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}
      accessibilityLabel="File type filters"
    >
      {MOBILE_FILE_CATEGORIES.map((category) => {
        const active = category === props.selected
        return (
          <Pressable
            key={category}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => props.onSelect(category)}
            hitSlop={{ top: 6, bottom: 6 }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Show ${MOBILE_FILE_CATEGORY_LABELS[category]} files`}
          >
            <Text style={[styles.label, active && styles.labelActive]}>
              {MOBILE_FILE_CATEGORY_LABELS[category]}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 0,
    flexShrink: 0
  },
  content: {
    gap: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs
  },
  chip: {
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md
  },
  chipActive: {
    backgroundColor: colors.bgRaised,
    borderColor: colors.textMuted
  },
  label: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  labelActive: {
    color: colors.textPrimary
  }
})
