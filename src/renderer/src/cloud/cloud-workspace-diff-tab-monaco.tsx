import * as React from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
// Why: same bundled-Monaco/worker pipeline as the file tab and orca web (U46-7a).
import '@/lib/monaco-setup'

/** Props the diff tab drives; kept here so the tab can lazy-load Monaco. */
export type CloudWorkspaceDiffEditorProps = {
  filePath: string
  original: string
  modified: string
  language: string
  sideBySide: boolean
}

export function CloudWorkspaceDiffMonaco({
  original,
  modified,
  language,
  sideBySide
}: CloudWorkspaceDiffEditorProps): React.JSX.Element {
  const dark = useSystemPrefersDark()
  return (
    <div data-testid="cloud-workspace-diff-monaco" className="min-h-0 flex-1 bg-editor-surface">
      <DiffEditor
        original={original}
        modified={modified}
        language={language}
        theme={dark ? 'vs-dark' : 'light'}
        options={{
          readOnly: true,
          renderSideBySide: sideBySide,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          renderOverviewRuler: false
        }}
      />
    </div>
  )
}
