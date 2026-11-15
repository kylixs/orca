import * as React from 'react'
import MermaidViewer from '@/components/editor/MermaidViewer'
import type { CloudFileRendererProps } from './registry'

/**
 * Mermaid diagram preview (L2-06). MermaidViewer lazily loads mermaid, renders
 * through DOMPurify, and shows the source + an error banner for bad syntax.
 */
export function MermaidFileRenderer({ path, text }: CloudFileRendererProps): React.JSX.Element {
  return <MermaidViewer content={text ?? ''} filePath={path} />
}
