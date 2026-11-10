import { useCallback, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FolderX } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import {
  cleanupDownloadCacheOnStartup,
  clearDownloadCache,
  downloadCacheSize
} from '../files/mobile-file-download-cache'
import { formatPreviewByteLength } from '../files/mobile-file-preview-response'

export function FileDownloadCacheRow() {
  const [size, setSize] = useState(0)
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    try {
      cleanupDownloadCacheOnStartup()
      setSize(downloadCacheSize())
    } catch {
      // A filesystem the OS has not exposed yet reads as an empty cache.
      setSize(0)
    }
  }, [])

  const clear = useCallback(() => {
    try {
      clearDownloadCache()
      setSize(0)
      setCleared(true)
    } catch {
      setCleared(false)
    }
  }, [])

  return (
    <View style={styles.section}>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={clear}
        accessibilityRole="button"
        accessibilityLabel="Clear download cache"
      >
        <FolderX size={16} color={colors.textSecondary} />
        <View style={styles.textBlock}>
          <Text style={styles.label}>Clear download cache</Text>
          <Text style={styles.meta}>
            {cleared
              ? 'Download cache cleared'
              : size > 0
                ? `${formatPreviewByteLength(size)} cached for saving and opening files`
                : 'No downloaded files cached'}
          </Text>
        </View>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  textBlock: { flex: 1, minWidth: 0 },
  label: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  meta: {
    marginTop: 2,
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
})
