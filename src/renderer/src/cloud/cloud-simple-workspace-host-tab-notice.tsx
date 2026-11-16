import type * as React from 'react'

/** U96 B-令4: host refusal notice (e.g. `live-host-pty`), dismissible, above the panes. */
export function CloudSimpleWorkspaceHostTabNotice({
  notice,
  onDismiss
}: {
  notice: string
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div
      role="status"
      data-testid="cloud-simple-workspace-host-tab-notice"
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-3 py-1.5 text-xs text-muted-foreground"
    >
      <span>{notice}</span>
      <button
        type="button"
        aria-label="关闭提示"
        className="text-muted-foreground hover:text-foreground"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  )
}
