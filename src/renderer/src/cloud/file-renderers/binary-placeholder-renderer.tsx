import * as React from 'react'
import type { CloudFileRendererProps } from './registry'

/** Unsupported binary placeholder (FS-1, design §L3). */
export function BinaryPlaceholderRenderer({
  path,
  binary,
  testId
}: CloudFileRendererProps): React.JSX.Element {
  const name = path.split(/[\\/]/).at(-1) ?? path
  return (
    <div
      data-testid={testId ?? 'cloud-workspace-preview-binary'}
      className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-xs text-muted-foreground"
    >
      <p className="text-foreground">该文件为二进制格式，简易工作区不支持预览。</p>
      <p className="break-all font-mono">{binary?.mimeType ?? name}</p>
      <p>托管项目不提供下载；可在开发环境打开。</p>
    </div>
  )
}
