import * as React from 'react'
import { parse as parseYaml } from 'yaml'
import type { CloudFileRendererProps } from './registry'
import {
  jsonValueToTree,
  StructuredParseFallback,
  StructuredTreeView
} from './structured-tree-view'

type YamlPreview = { ok: true; value: unknown } | { ok: false; error: string }

function parseYamlPreview(text: string): YamlPreview {
  try {
    // `yaml` guards alias expansion; errors carry line/column already.
    return { ok: true, value: parseYaml(text) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** YAML tree preview (L2-05); a failed parse falls back to Monaco + banner. */
export function YamlFileRenderer(props: CloudFileRendererProps): React.JSX.Element {
  const parsed = React.useMemo(() => parseYamlPreview(props.text ?? ''), [props.text])
  if (!parsed.ok) {
    return (
      <StructuredParseFallback
        {...props}
        label="YAML"
        error={parsed.error}
        testId="cloud-workspace-yaml-error"
      />
    )
  }
  return (
    <StructuredTreeView root={jsonValueToTree(parsed.value)} testId="cloud-workspace-yaml-tree" />
  )
}
