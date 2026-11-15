import * as React from 'react'
import {
  CloudWorkspaceMonacoEditor,
  type CloudWorkspaceEditorProps
} from '../cloud-workspace-monaco-editor'
import type { CloudFileRendererProps } from './registry'

/** Source-mode surface shared by every text format. */
export function CodeFileRenderer(props: CloudFileRendererProps): React.JSX.Element {
  const editorProps: CloudWorkspaceEditorProps = {
    filePath: props.path,
    value: props.text ?? '',
    language: props.language ?? 'plaintext',
    readOnly: props.readOnly,
    onChange: props.onChange ?? (() => undefined),
    onSave: props.onSave ?? (() => undefined)
  }
  return <CloudWorkspaceMonacoEditor {...editorProps} />
}
