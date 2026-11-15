import * as React from 'react'

/**
 * What the workspace shows when it cannot show a tab (design §4.4/§4.9): the
 * ordinary empty state, and the permission-degraded page that replaces broken
 * ensure results instead of an empty iframe.
 */

export function CloudSimpleWorkspaceEmptyState({
  canUseTerminal
}: {
  canUseTerminal: boolean
}): React.JSX.Element {
  return (
    <div
      data-testid="cloud-simple-workspace-empty"
      className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center"
    >
      <p className="text-sm text-foreground">
        {canUseTerminal
          ? '从右侧文件树打开文件，或新建终端'
          : '当前项目未授予终端权限，无法新建终端'}
      </p>
      {canUseTerminal ? (
        <p className="text-xs text-muted-foreground">标签会在这里打开，切换不会丢失内容。</p>
      ) : (
        <p className="text-xs text-muted-foreground">文件读取仍按项目授权决定是否可用。</p>
      )}
    </div>
  )
}

export type CloudSimpleWorkspaceDegradedInfo = {
  code: string
  message?: string
  /** The standalone admin page, kept as the explicit way out. */
  fallbackHref?: string
}

export function CloudSimpleWorkspaceDegraded({
  code,
  message,
  fallbackHref
}: CloudSimpleWorkspaceDegradedInfo): React.JSX.Element {
  return (
    <div
      role="alert"
      data-testid="cloud-simple-workspace-degraded"
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h2 className="text-sm font-medium text-foreground">
        当前项目未授予终端权限，无法创建工作区
      </h2>
      <p className="text-xs text-muted-foreground">{message ? `${code}：${message}` : code}</p>
      {fallbackHref ? (
        <a
          data-testid="cloud-simple-workspace-degraded-fallback"
          className="text-xs text-foreground underline underline-offset-2"
          href={fallbackHref}
          target="_blank"
          rel="noreferrer"
        >
          在独立页打开
        </a>
      ) : null}
    </div>
  )
}

/** Placeholder used when the shell was handed no file-tree renderer yet. */
export function CloudSimpleWorkspaceFileTreePlaceholder({
  reason
}: {
  reason: 'slot' | 'no-permission' | 'no-workspace'
}): React.JSX.Element {
  const text =
    reason === 'no-permission'
      ? '当前项目未授予文件读取权限，文件面板不可用。'
      : reason === 'no-workspace'
        ? '工作区尚未创建，无法打开文件面板。'
        : '文件树将在后续版本接入。'
  return (
    <p
      data-testid={`cloud-simple-workspace-file-tree-${reason}`}
      className="p-3 text-xs leading-relaxed text-muted-foreground"
    >
      {text}
    </p>
  )
}
