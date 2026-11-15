import * as React from 'react'
import { Button } from '@/components/ui/button'
import type { CloudSimpleWorkspaceTabsAction } from './cloud-simple-workspace-tabs'

/**
 * F-01 (design §4.4): closing a dirty file tab offers 保存/放弃/取消.
 * The save runs through the pane's own save path, so a conflict or write error
 * keeps the tab and its buffer instead of closing it.
 */

export type CloudSimpleWorkspaceSaveHandler = () => Promise<boolean>

export type CloudSimpleWorkspaceCloseConfirmState = { id: string; title: string }

export function useCloudSimpleWorkspaceCloseGuard(
  dirty: Record<string, boolean>,
  dispatch: React.Dispatch<CloudSimpleWorkspaceTabsAction>
): {
  confirm: CloudSimpleWorkspaceCloseConfirmState | null
  saving: boolean
  canSave: boolean
  registerSave: (tabId: string, save: CloudSimpleWorkspaceSaveHandler | null) => void
  requestClose: (tab: { id: string; title: string }) => void
  cancel: () => void
  discard: () => void
  saveAndClose: () => Promise<void>
} {
  const [confirm, setConfirm] = React.useState<CloudSimpleWorkspaceCloseConfirmState | null>(null)
  const [saving, setSaving] = React.useState(false)
  const handlers = React.useRef(new Map<string, CloudSimpleWorkspaceSaveHandler>())

  const registerSave = React.useCallback(
    (tabId: string, save: CloudSimpleWorkspaceSaveHandler | null) => {
      if (save) {
        handlers.current.set(tabId, save)
      } else {
        handlers.current.delete(tabId)
      }
    },
    []
  )

  const requestClose = React.useCallback(
    (tab: { id: string; title: string }) => {
      if (dirty[tab.id]) {
        setConfirm({ id: tab.id, title: tab.title })
        return
      }
      dispatch({ type: 'close', id: tab.id })
    },
    [dirty, dispatch]
  )

  const cancel = React.useCallback(() => setConfirm(null), [])

  const discard = React.useCallback(() => {
    if (confirm) {
      dispatch({ type: 'close', id: confirm.id })
    }
    setConfirm(null)
  }, [confirm, dispatch])

  const saveAndClose = React.useCallback(async () => {
    const save = confirm ? handlers.current.get(confirm.id) : undefined
    if (!confirm || !save || saving) {
      return
    }
    setSaving(true)
    let saved = false
    try {
      saved = await save()
    } catch {
      saved = false
    }
    setSaving(false)
    if (saved) {
      dispatch({ type: 'close', id: confirm.id })
    }
    setConfirm(null)
  }, [confirm, dispatch, saving])

  return {
    confirm,
    saving,
    canSave: confirm ? handlers.current.has(confirm.id) : false,
    registerSave,
    requestClose,
    cancel,
    discard,
    saveAndClose
  }
}

export function CloudSimpleWorkspaceCloseConfirm({
  confirm,
  canSave,
  saving,
  onSave,
  onDiscard,
  onCancel
}: {
  confirm: CloudSimpleWorkspaceCloseConfirmState | null
  canSave: boolean
  saving: boolean
  onSave: () => Promise<void>
  onDiscard: () => void
  onCancel: () => void
}): React.JSX.Element | null {
  if (!confirm) {
    return null
  }
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="cloud-simple-workspace-close-title"
      data-testid="cloud-simple-workspace-close-confirm"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
    >
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-border bg-card p-6 shadow-lg">
        <h2
          id="cloud-simple-workspace-close-title"
          className="text-base font-medium text-foreground"
        >
          关闭「{confirm.title}」？
        </h2>
        <p className="text-sm text-muted-foreground">
          该文件有未保存的更改。保存后再关闭，或放弃这些更改。
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="cloud-simple-workspace-close-confirm-cancel"
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="cloud-simple-workspace-close-confirm-discard"
            onClick={onDiscard}
          >
            放弃
          </Button>
          <Button
            size="sm"
            data-testid="cloud-simple-workspace-close-confirm-save"
            disabled={!canSave || saving}
            onClick={() => void onSave()}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}
