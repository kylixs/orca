import * as React from 'react'
import type { CloudFileRendererProps } from './registry'

function fileName(relativePath: string): string {
  return relativePath.split(/[\\/]/).at(-1) ?? relativePath
}

/**
 * PDF preview (L2-02): the host returns PDF bytes as base64; hand them to the
 * browser's native viewer through a data URL, so no pdfjs chunk is needed.
 */
export function PdfFileRenderer({
  path,
  binary,
  testId
}: CloudFileRendererProps): React.JSX.Element {
  const base64 = binary?.base64 ?? ''
  if (base64 === '') {
    return (
      <div
        data-testid={testId ?? 'cloud-workspace-preview-pdf'}
        className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-xs text-muted-foreground"
      >
        <p className="text-foreground">无法预览该 PDF。</p>
        <p>宿主未返回文件内容，或文件超出预览大小限制。</p>
        <p className="break-all font-mono">application/pdf</p>
      </div>
    )
  }
  return (
    <iframe
      data-testid="cloud-workspace-pdf-frame"
      title={`预览 ${fileName(path)}`}
      src={`data:application/pdf;base64,${base64}`}
      className="h-full w-full border-0"
    />
  )
}
