import * as React from 'react'
import type { CloudFileRendererProps } from './registry'
import {
  STRUCTURED_TREE_CHILD_LIMIT,
  StructuredParseFallback,
  StructuredTreeView,
  type StructuredTreeCollection,
  type StructuredTreeEntry,
  structuredScalarText
} from './structured-tree-view'

type XmlPreview = { ok: true; root: StructuredTreeCollection } | { ok: false; error: string }

const TEXT_NODE = 3
const CDATA_SECTION_NODE = 4

function nodeText(node: Node): string {
  return node.textContent?.trim() ?? ''
}

function elementToTree(element: Element): StructuredTreeCollection {
  const children: StructuredTreeEntry[] = []
  for (const attribute of Array.from(element.attributes)) {
    children.push({ key: `@${attribute.name}`, value: structuredScalarText(attribute.value) })
  }
  const attributeCount = children.length
  const names = new Map<string, number>()
  const elements = Array.from(element.children)
  const shownElements = elements.slice(0, Math.max(0, STRUCTURED_TREE_CHILD_LIMIT - attributeCount))
  for (const child of shownElements) {
    const name = child.localName || child.nodeName
    const seen = names.get(name) ?? 0
    names.set(name, seen + 1)
    children.push({
      key: seen === 0 ? name : `${name}[${seen}]`,
      value: elementToTree(child)
    })
  }
  const text = Array.from(element.childNodes)
    .filter((node) => node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE)
    .map(nodeText)
    .filter((value) => value !== '')
    .join(' ')
  if (text !== '') {
    children.push({
      key: '#text',
      value: structuredScalarText(text.length > 2000 ? `${text.slice(0, 2000)}…` : text)
    })
  }
  return {
    kind: 'collection',
    collection: 'object',
    children,
    totalChildren: attributeCount + elements.length + (text === '' ? 0 : 1)
  }
}

function parseXmlPreview(text: string): XmlPreview {
  try {
    const document = new DOMParser().parseFromString(text, 'application/xml')
    const parserError = document.getElementsByTagName('parsererror')[0]
    if (parserError !== undefined) {
      return { ok: false, error: nodeText(parserError) || 'XML 语法错误' }
    }
    const root = document.documentElement
    if (root === null) {
      return { ok: false, error: '文档为空' }
    }
    return {
      ok: true,
      root: {
        kind: 'collection',
        collection: 'object',
        children: [{ key: root.localName || root.nodeName, value: elementToTree(root) }],
        totalChildren: 1
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** XML tree preview (L2-04): DOMParser + element tree, Monaco fallback on error. */
export function XmlFileRenderer(props: CloudFileRendererProps): React.JSX.Element {
  const parsed = React.useMemo(() => parseXmlPreview(props.text ?? ''), [props.text])
  if (!parsed.ok) {
    return (
      <StructuredParseFallback
        {...props}
        label="XML"
        error={parsed.error}
        testId="cloud-workspace-xml-error"
      />
    )
  }
  return (
    <StructuredTreeView
      root={parsed.root}
      defaultExpandDepth={3}
      testId="cloud-workspace-xml-tree"
    />
  )
}
