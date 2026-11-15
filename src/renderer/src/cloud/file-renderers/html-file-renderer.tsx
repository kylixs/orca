import * as React from 'react'
import type { CloudFileRendererProps } from './registry'

function fileName(relativePath: string): string {
  return relativePath.split(/[\\/]/).at(-1) ?? relativePath
}

/** HTML preview (FS-1): empty sandbox, no scripts, no same-origin. */
export function HtmlFileRenderer({ path, mode, text }: CloudFileRendererProps): React.JSX.Element {
  // Legacy preview-tab source view stays read-only; the editor host uses Monaco.
  if (mode === 'source') {
    return (
      <pre
        data-testid="cloud-workspace-preview-html-source"
        className="min-h-0 flex-1 overflow-auto scrollbar-editor p-3 font-mono text-xs text-foreground"
      >
        {text ?? ''}
      </pre>
    )
  }
  return (
    <iframe
      data-testid="cloud-workspace-preview-html-frame"
      title={`预览 ${fileName(path)}`}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={text ?? ''}
      className="h-full w-full border-0"
    />
  )
}
