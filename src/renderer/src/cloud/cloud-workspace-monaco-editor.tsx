import * as React from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { installMonacoE2EProbe } from '@/components/editor/monaco-e2e-probe'
// Why: same loading shape as the orca web editor (components/editor/MonacoEditor):
// bundled Monaco, shared workers, and the W13b `__monacoEditorE2E` probe.
import '@/lib/monaco-setup'

/** Props the file tab drives; kept here so the tab can lazy-load this module. */
export type CloudWorkspaceEditorProps = {
  filePath: string
  value: string
  language: string
  readOnly: boolean
  onChange: (value: string) => void
  onSave: () => void
}

/**
 * Monaco surface for a workspace file (design §11.4: syntax highlighting).
 * `KeyMod.CtrlCmd` makes the save binding Cmd on macOS and Ctrl elsewhere.
 */
export function CloudWorkspaceMonacoEditor({
  filePath,
  value,
  language,
  readOnly,
  onChange,
  onSave
}: CloudWorkspaceEditorProps): React.JSX.Element {
  const dark = useSystemPrefersDark()
  const onSaveRef = React.useRef(onSave)
  const uninstallProbeRef = React.useRef<(() => void) | null>(null)
  onSaveRef.current = onSave

  React.useEffect(() => () => uninstallProbeRef.current?.(), [])

  const handleMount = React.useCallback<OnMount>(
    (editor, monaco) => {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current())
      // Same e2e oracle the orca web workbench exposes; disabled outside e2e builds.
      uninstallProbeRef.current = installMonacoE2EProbe(editor, filePath)
    },
    [filePath]
  )

  return (
    <div data-testid="cloud-workspace-file-monaco" className="min-h-0 flex-1 bg-editor-surface">
      <Editor
        language={language}
        value={value}
        onChange={(next) => onChange(next ?? '')}
        onMount={handleMount}
        theme={dark ? 'vs-dark' : 'light'}
        options={{
          readOnly,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 2
        }}
      />
    </div>
  )
}
