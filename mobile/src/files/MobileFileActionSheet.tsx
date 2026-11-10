import {
  Clipboard,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  RotateCw,
  X,
  type LucideIcon
} from 'lucide-react-native'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import {
  buildFileActions,
  fileActionCapabilityNotice,
  type FileActionCapabilities,
  type FileActionContext,
  type FileActionId,
  type FileActionTarget
} from './mobile-file-actions'
import type { HtmlOpenActionState } from './mobile-file-open-mode-actions'

const ACTION_ICONS: Record<FileActionId, LucideIcon> = {
  retry: RotateCw,
  preview: Eye,
  source: FileCode2,
  save: Download,
  open: ExternalLink,
  'copy-content': Clipboard,
  'copy-path': Copy,
  cancel: X
}

export function MobileFileActionSheet(props: {
  visible: boolean
  target: FileActionTarget | null
  context: FileActionContext
  capabilities: FileActionCapabilities
  /** A prepare or share for this target is still running; Save/Open must not start again. */
  busy?: boolean
  htmlActionState?: HtmlOpenActionState
  notice?: string | null
  onAction: (id: FileActionId) => void
  onClose: () => void
}) {
  const { target, visible, onAction, onClose } = props
  if (!target) {
    return null
  }
  const actions = buildFileActions(target, {
    context: props.context,
    htmlActionState: props.htmlActionState,
    capabilities: props.capabilities
  })
  const sheetActions: ActionSheetAction[] = actions.map((action) => ({
    label: action.label,
    hint: action.hint,
    icon: ACTION_ICONS[action.id],
    disabled: Boolean(props.busy) && (action.id === 'save' || action.id === 'open'),
    closeBeforePress: action.id !== 'cancel',
    onPress: () => {
      if (action.id === 'cancel') {
        return
      }
      onAction(action.id)
    }
  }))
  const capabilityNotice = fileActionCapabilityNotice(target, {
    context: props.context,
    htmlActionState: props.htmlActionState,
    capabilities: props.capabilities
  })
  const message = [capabilityNotice, props.notice].filter(Boolean).join('\n')
  return (
    <ActionSheetModal
      visible={visible}
      title={target.name || 'File actions'}
      message={message || undefined}
      actions={sheetActions}
      onClose={onClose}
    />
  )
}
