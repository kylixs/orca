import * as React from 'react'
import { CodeFileRenderer } from './code-file-renderer'
import type { CloudFileRendererProps } from './registry'

/** Shared collapsible tree for JSON/JSONC/YAML/XML previews (L2-03/04/05). */

export type StructuredTreeScalarType = 'string' | 'number' | 'boolean' | 'null'

export type StructuredTreeScalar = {
  kind: 'scalar'
  value: string
  scalarType: StructuredTreeScalarType
}

export type StructuredTreeEntry = { key: string; value: StructuredTreeValue }

export type StructuredTreeCollection = {
  kind: 'collection'
  collection: 'object' | 'array'
  children: StructuredTreeEntry[]
  totalChildren: number
}

export type StructuredTreeValue = StructuredTreeScalar | StructuredTreeCollection

/** A single expanded node never paints more than this many children. */
export const STRUCTURED_TREE_CHILD_LIMIT = 500

function scalar(value: string, scalarType: StructuredTreeScalarType): StructuredTreeScalar {
  return { kind: 'scalar', value, scalarType }
}

export function structuredScalarText(value: string): StructuredTreeScalar {
  return scalar(value, 'string')
}

/** Converts a parsed JSON/YAML value into the tree shape; order is preserved. */
export function jsonValueToTree(value: unknown): StructuredTreeValue {
  if (value === null || value === undefined) {
    return scalar('null', 'null')
  }
  if (typeof value === 'string') {
    return scalar(value, 'string')
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return scalar(String(value), 'number')
  }
  if (typeof value === 'boolean') {
    return scalar(String(value), 'boolean')
  }
  if (Array.isArray(value)) {
    return {
      kind: 'collection',
      collection: 'array',
      children: value
        .slice(0, STRUCTURED_TREE_CHILD_LIMIT)
        .map((child, index) => ({ key: `[${index}]`, value: jsonValueToTree(child) })),
      totalChildren: value.length
    }
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    return {
      kind: 'collection',
      collection: 'object',
      children: entries
        .slice(0, STRUCTURED_TREE_CHILD_LIMIT)
        .map(([key, child]) => ({ key, value: jsonValueToTree(child) })),
      totalChildren: entries.length
    }
  }
  return scalar(String(value), 'string')
}

function scalarClass(scalarType: StructuredTreeScalarType): string {
  if (scalarType === 'null') {
    return 'italic text-muted-foreground'
  }
  if (scalarType === 'boolean' || scalarType === 'number') {
    return 'text-foreground'
  }
  return 'whitespace-pre-wrap break-all text-foreground'
}

function CollectionRow({
  label,
  value,
  depth,
  defaultExpandDepth
}: {
  label: string | null
  value: StructuredTreeCollection
  depth: number
  defaultExpandDepth: number
}): React.JSX.Element {
  const [open, setOpen] = React.useState(depth < defaultExpandDepth)
  const brackets = value.collection === 'array' ? ['[', ']'] : ['{', '}']
  const summary =
    value.collection === 'array' ? `${value.totalChildren} 项` : `${value.totalChildren} 个字段`
  return (
    <div>
      <div className="flex items-start gap-1" style={{ paddingLeft: `${depth * 14}px` }}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="shrink-0 rounded px-1 text-muted-foreground hover:bg-muted"
        >
          {open ? '▾' : '▸'}
        </button>
        {label === null ? null : <span className="shrink-0 text-muted-foreground">{label}:</span>}
        <span className="text-muted-foreground">
          {brackets[0]}
          {open ? '' : ` … ${brackets[1]}`}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{summary}</span>
      </div>
      {open ? (
        <>
          {value.children.map((child) => (
            <TreeEntryRow
              key={child.key}
              entry={child}
              depth={depth + 1}
              defaultExpandDepth={defaultExpandDepth}
            />
          ))}
          {value.totalChildren > value.children.length ? (
            <p
              className="text-[11px] text-muted-foreground"
              style={{ paddingLeft: `${(depth + 1) * 14}px` }}
            >
              还有 {value.totalChildren - value.children.length} 项未显示
            </p>
          ) : null}
          <div className="text-muted-foreground" style={{ paddingLeft: `${depth * 14 + 18}px` }}>
            {brackets[1]}
          </div>
        </>
      ) : null}
    </div>
  )
}

function TreeEntryRow({
  entry,
  depth,
  defaultExpandDepth
}: {
  entry: StructuredTreeEntry
  depth: number
  defaultExpandDepth: number
}): React.JSX.Element {
  if (entry.value.kind === 'collection') {
    return (
      <CollectionRow
        label={entry.key}
        value={entry.value}
        depth={depth}
        defaultExpandDepth={defaultExpandDepth}
      />
    )
  }
  return (
    <div
      className="flex items-start gap-1"
      style={{ paddingLeft: `${depth * 14 + 18}px` }}
      data-testid="cloud-structured-tree-entry"
    >
      <span className="shrink-0 text-muted-foreground">{entry.key}:</span>
      <span className={scalarClass(entry.value.scalarType)}>{entry.value.value}</span>
    </div>
  )
}

/** Parse failures fall back to the read-only Monaco surface with a banner. */
export function StructuredParseFallback({
  label,
  error,
  testId,
  ...props
}: CloudFileRendererProps & {
  label: string
  error: string
  testId: string
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <p
        data-testid={testId}
        className="shrink-0 border-b border-border px-3 py-2 text-[11px] leading-relaxed text-destructive"
      >
        {label} 解析失败：{error}。已回退源码。
      </p>
      <div className="flex min-h-0 flex-1 flex-col">
        <CodeFileRenderer {...props} mode="source" />
      </div>
    </div>
  )
}

export function StructuredTreeView({
  root,
  defaultExpandDepth = 1,
  testId
}: {
  root: StructuredTreeValue
  defaultExpandDepth?: number
  testId: string
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className="min-h-0 flex-1 overflow-auto scrollbar-editor p-3 font-mono text-xs leading-relaxed"
    >
      {root.kind === 'collection' ? (
        <CollectionRow
          label={null}
          value={root}
          depth={0}
          defaultExpandDepth={Math.max(1, defaultExpandDepth)}
        />
      ) : (
        <span className={scalarClass(root.scalarType)}>{root.value}</span>
      )}
    </div>
  )
}
