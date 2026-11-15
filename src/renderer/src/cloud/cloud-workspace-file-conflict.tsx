import * as React from 'react'
import { Button } from '@/components/ui/button'

/** Three-way conflict banner for the file tab (design §4.7). */
export function CloudWorkspaceFileConflictBanner({
  onReload,
  onOverwrite,
  onCancel
}: {
  onReload: () => void
  onOverwrite: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div
      role="alertdialog"
      aria-label="文件已在别处修改"
      data-testid="cloud-workspace-file-tab-conflict"
      className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-2 text-xs text-foreground"
    >
      <span className="min-w-0 flex-1">文件已在别处修改，请选择处理方式。</span>
      <Button
        variant="outline"
        size="sm"
        data-testid="cloud-workspace-file-tab-conflict-reload"
        onClick={onReload}
      >
        重新加载
      </Button>
      <Button
        variant="destructive"
        size="sm"
        data-testid="cloud-workspace-file-tab-conflict-overwrite"
        onClick={onOverwrite}
      >
        覆盖保存
      </Button>
      <Button
        variant="ghost"
        size="sm"
        data-testid="cloud-workspace-file-tab-conflict-cancel"
        onClick={onCancel}
      >
        取消
      </Button>
    </div>
  )
}
