import * as React from 'react'
import { CloudWorkspaceMarkdownPreview } from '../cloud-workspace-markdown-preview'
import type { CloudFileRendererProps } from './registry'

/** Markdown preview renderer (FS-1); sanitization lives in MarkdownPreviewBody. */
export function MarkdownFileRenderer({ text }: CloudFileRendererProps): React.JSX.Element {
  return <CloudWorkspaceMarkdownPreview content={text ?? ''} />
}
