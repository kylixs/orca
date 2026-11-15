import * as React from 'react'
import { buildImageDataUri } from '../../../../shared/image-data-uri'
import type { CloudFileRendererProps } from './registry'

function fileName(relativePath: string): string {
  return relativePath.split(/[\\/]/).at(-1) ?? relativePath
}

/** Lightweight image renderer; deliberately avoids ImageViewer (imports pdfjs). */
export function ImageFileRenderer({ path, binary }: CloudFileRendererProps): React.JSX.Element {
  const [broken, setBroken] = React.useState(false)
  const src = broken ? null : buildImageDataUri(binary?.mimeType ?? undefined, binary?.base64 ?? '')
  if (src === null) {
    return (
      <div
        data-testid="cloud-workspace-preview-image-failed"
        className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-xs text-muted-foreground"
      >
        <p className="text-foreground">无法预览该图片。</p>
        <p>文件可能已损坏或尺寸超出预览限制。</p>
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto scrollbar-sleek p-3">
      <img
        data-testid="cloud-workspace-preview-image"
        src={src}
        alt={fileName(path)}
        className="max-h-full max-w-full object-contain"
        onError={() => setBroken(true)}
      />
    </div>
  )
}
