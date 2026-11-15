import * as React from 'react'
import type { Components } from 'react-markdown'
import { MarkdownPreviewBody } from '@/components/editor/MarkdownPreviewBody'

/**
 * Markdown preview for a workspace file tab (design §11.4).
 *
 * Reuses the orca web preview pipeline (`MarkdownPreviewBody` +
 * `markdown-preview-plugins`): GFM, sanitized raw HTML (`rehype-sanitize`),
 * URL transform that drops `javascript:` links. This surface only overrides
 * link handling so a repository link opens in a new tab instead of navigating
 * the embedded workspace iframe.
 */
const cloudMarkdownComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  )
}

const previewClassName =
  'scrollbar-sleek min-h-0 flex-1 overflow-auto bg-editor-surface px-6 py-4 text-sm text-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_img]:max-w-full [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_table]:my-2 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5'

export function CloudWorkspaceMarkdownPreview({ content }: { content: string }): React.JSX.Element {
  return (
    <div data-testid="cloud-workspace-markdown-preview" className={previewClassName}>
      <MarkdownPreviewBody content={content} components={cloudMarkdownComponents} />
    </div>
  )
}
