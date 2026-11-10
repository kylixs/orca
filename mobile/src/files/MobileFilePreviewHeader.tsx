import { Pressable, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, Ellipsis, Save } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

export function MobileFilePreviewHeader(props: {
  title: string
  meta: string
  canSave: boolean
  saving: boolean
  actionsExpanded: boolean
  onBack: () => void
  onSave: () => void
  onActions: () => void
}) {
  return (
    <SafeAreaView style={styles.header} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={props.onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back to files"
        >
          <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            {props.title || 'Preview'}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {props.meta}
          </Text>
        </View>
        {props.canSave ? (
          <Pressable
            style={[styles.saveButton, props.saving && styles.saveButtonDisabled]}
            onPress={props.onSave}
            disabled={props.saving}
            hitSlop={8}
            accessibilityLabel="Save terminal artifact"
          >
            <Save size={18} color={colors.textPrimary} strokeWidth={2.2} />
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.saveButton, pressed && styles.backButtonPressed]}
          onPress={props.onActions}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="File actions"
          accessibilityState={{ expanded: props.actionsExpanded }}
        >
          <Ellipsis size={18} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      </View>
    </SafeAreaView>
  )
}
