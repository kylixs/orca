import { ConfirmModal } from '../components/ConfirmModal'
import { MobileFileActionSheet } from './MobileFileActionSheet'
import { MobileFileSaveResultSheet } from './MobileFileSaveResultSheet'
import type { FileActionCapabilities, FileActionId, FileActionTarget } from './mobile-file-actions'
import type { HtmlOpenActionState } from './mobile-file-open-mode-actions'
import type { SavedPreparedFileResult } from './mobile-file-save'

/** The sheet stack above the preview: shared actions, save result, and the discard guard. */
export function MobileFilePreviewOverlays(props: {
  actionSheetVisible: boolean
  onCloseActionSheet: () => void
  actionTarget: FileActionTarget | null
  capabilities: FileActionCapabilities
  busy?: boolean
  htmlActionState?: HtmlOpenActionState
  onAction: (id: FileActionId) => void
  saveResult: SavedPreparedFileResult | null
  onCloseSaveResult: () => void
  confirmingDiscard: boolean
  onConfirmDiscard: () => void
  onStay: () => void
}) {
  return (
    <>
      <MobileFileActionSheet
        visible={props.actionSheetVisible}
        target={props.actionTarget}
        context="preview"
        capabilities={props.capabilities}
        busy={props.busy}
        htmlActionState={props.htmlActionState}
        onAction={props.onAction}
        onClose={props.onCloseActionSheet}
      />
      <MobileFileSaveResultSheet result={props.saveResult} onClose={props.onCloseSaveResult} />
      <ConfirmModal
        visible={props.confirmingDiscard}
        title="Discard changes?"
        message="Unsaved edits will be lost."
        confirmLabel="Discard"
        cancelLabel="Stay"
        destructive
        onConfirm={props.onConfirmDiscard}
        onCancel={props.onStay}
      />
    </>
  )
}
