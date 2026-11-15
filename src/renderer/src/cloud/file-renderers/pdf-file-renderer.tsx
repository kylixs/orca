import * as React from 'react'
import type { CloudFileRendererProps } from './registry'

/** PDF stays a placeholder until the L2 real-preview renderer lands. */
export function PdfFileRenderer({ testId }: CloudFileRendererProps): React.JSX.Element {
  return (
    <div
      data-testid={testId ?? 'cloud-workspace-preview-pdf'}
      className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-xs text-muted-foreground"
    >
      <p className="text-foreground">PDF 预览不在简易版范围。</p>
      <p className="break-all font-mono">application/pdf</p>
      <p>托管项目不提供下载；可在开发环境打开。</p>
    </div>
  )
}
