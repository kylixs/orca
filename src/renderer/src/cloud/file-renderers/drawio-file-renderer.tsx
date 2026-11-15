import * as React from 'react'
import type { CloudFileRendererProps } from './registry'

/** drawio degrades to source: the embedded viewer needs a third-party script. */
export function DrawioFileRenderer({ text }: CloudFileRendererProps): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <p
        data-testid="cloud-workspace-preview-drawio-degraded"
        className="shrink-0 border-b border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
      >
        drawio 嵌入查看器需要加载第三方脚本，简易工作区不加载；以下为文件源码，可在开发环境用 drawio
        打开。
      </p>
      <pre
        data-testid="cloud-workspace-preview-drawio-source"
        className="min-h-0 flex-1 overflow-auto scrollbar-editor p-3 font-mono text-xs text-foreground"
      >
        {text ?? ''}
      </pre>
    </div>
  )
}
