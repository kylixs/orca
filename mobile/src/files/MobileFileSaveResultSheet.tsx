import { Check } from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import type { SavedPreparedFileResult } from './mobile-file-save'

export function MobileFileSaveResultSheet(props: {
  result: SavedPreparedFileResult | null
  onClose: () => void
}) {
  if (!props.result) {
    return null
  }
  return (
    <ActionSheetModal
      visible
      title="Saved to phone"
      message={[
        `Path: ${props.result.path}`,
        `SHA-256: ${props.result.sha256}`,
        'Cached copy kept for 24 hours'
      ].join('\n')}
      actions={[{ label: 'Done', icon: Check, onPress: () => {} }]}
      onClose={props.onClose}
    />
  )
}
