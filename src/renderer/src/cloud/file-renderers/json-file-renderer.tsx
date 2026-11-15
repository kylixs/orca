import * as React from 'react'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import type { CloudFileRendererProps } from './registry'
import {
  jsonValueToTree,
  StructuredParseFallback,
  StructuredTreeView
} from './structured-tree-view'

type JsonPreview = { ok: true; value: unknown } | { ok: false; error: string }

/** JSONC accepts comments and trailing commas, matching the Monaco json language. */
function parseJsonPreview(text: string): JsonPreview {
  const errors: ParseError[] = []
  let value: unknown
  try {
    value = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const first = errors[0]
  if (first !== undefined) {
    return {
      ok: false,
      error: `${printParseErrorCode(first.error)}（偏移 ${first.offset}）`
    }
  }
  if (value === undefined) {
    return { ok: false, error: '文件内容为空' }
  }
  return { ok: true, value }
}

/** JSON/JSONC tree preview (L2-03). */
export function JsonFileRenderer(props: CloudFileRendererProps): React.JSX.Element {
  const parsed = React.useMemo(() => parseJsonPreview(props.text ?? ''), [props.text])
  if (!parsed.ok) {
    return (
      <StructuredParseFallback
        {...props}
        label="JSON"
        error={parsed.error}
        testId="cloud-workspace-json-error"
      />
    )
  }
  return (
    <StructuredTreeView root={jsonValueToTree(parsed.value)} testId="cloud-workspace-json-tree" />
  )
}
