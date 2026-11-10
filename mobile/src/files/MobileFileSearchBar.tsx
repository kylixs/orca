import { View, StyleSheet } from 'react-native'
import { MobileSearchField } from '../components/MobileSearchField'
import { spacing } from '../theme/mobile-theme'

export function MobileFileSearchBar(props: {
  value: string
  onChangeText: (text: string) => void
  onClear: () => void
}) {
  return (
    <View style={styles.container}>
      <MobileSearchField
        value={props.value}
        onChangeText={props.onChangeText}
        onClear={props.onClear}
        placeholder="Search files"
        clearAccessibilityLabel="Clear file search"
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm
  }
})
