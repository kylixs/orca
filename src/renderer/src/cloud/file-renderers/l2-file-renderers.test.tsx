// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSV_PREVIEW_ROW_LIMIT, CsvFileRenderer } from './csv-file-renderer'
import { JsonFileRenderer } from './json-file-renderer'
import { XmlFileRenderer } from './xml-file-renderer'
import { YamlFileRenderer } from './yaml-file-renderer'
import { MermaidFileRenderer } from './mermaid-file-renderer'
import { PdfFileRenderer } from './pdf-file-renderer'

vi.mock('./code-file-renderer', () => ({
  CodeFileRenderer: () => <div data-testid="structured-source-fallback" />
}))

vi.mock('@/components/editor/MermaidViewer', () => ({
  default: ({ content, filePath }: { content: string; filePath: string }) => (
    <div data-testid="mermaid-viewer-stub" data-path={filePath}>
      {content}
    </div>
  )
}))

afterEach(cleanup)

const props = { mode: 'preview' as const, readOnly: true }

describe('CSV/TSV 表格渲染器', () => {
  it('解析引号、逗号与转义双引号', () => {
    render(
      <CsvFileRenderer
        {...props}
        path="data/table.csv"
        text={'name,note\n"a,b","line ""one"""\n'}
      />
    )
    expect(screen.getByTestId('cloud-workspace-csv-table')).toBeTruthy()
    const rows = screen.getAllByTestId('cloud-workspace-csv-row')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('a,b')).toBeTruthy()
    expect(within(rows[0]).getByText('line "one"')).toBeTruthy()
  })

  it('TSV 按制表符分列', () => {
    render(<CsvFileRenderer {...props} path="data/table.tsv" text={'a\tb\n1\t2\n'} />)
    expect(screen.getByTestId('cloud-workspace-csv-summary').textContent).toContain('2 列')
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('超过 1000 行只渲染前 1000 行并提示总数', () => {
    const lines = ['v']
    for (let index = 0; index < CSV_PREVIEW_ROW_LIMIT + 20; index += 1) {
      lines.push(String(index))
    }
    render(<CsvFileRenderer {...props} path="data/big.csv" text={lines.join('\n')} />)
    expect(screen.getAllByTestId('cloud-workspace-csv-row')).toHaveLength(CSV_PREVIEW_ROW_LIMIT)
    const summary = screen.getByTestId('cloud-workspace-csv-summary').textContent ?? ''
    expect(summary).toContain(`共 ${CSV_PREVIEW_ROW_LIMIT + 20} 行`)
    expect(summary).toContain(`仅显示前 ${CSV_PREVIEW_ROW_LIMIT} 行`)
  })

  it('记录过长时显示解析错误而不是崩溃', () => {
    render(<CsvFileRenderer {...props} path="data/bad.csv" text={`"${'a'.repeat(300 * 1024)}"`} />)
    expect(screen.getByTestId('cloud-workspace-csv-error').textContent).toContain('表格解析失败')
  })
})

describe('JSON/YAML/XML 树渲染器', () => {
  it('JSON 树展示键值并可展开集合', () => {
    render(
      <JsonFileRenderer
        {...props}
        path="config/app.json"
        text='{"name":"orca","count":3,"nested":{"ok":true},"list":[1,2]}'
      />
    )
    const tree = screen.getByTestId('cloud-workspace-json-tree')
    expect(tree.textContent).toContain('name')
    expect(tree.textContent).toContain('orca')
    expect(tree.textContent).toContain('nested')
    expect(tree.textContent).toContain('list')
  })

  it('JSONC 允许注释与尾逗号', () => {
    render(
      <JsonFileRenderer {...props} path="config/tsconfig.jsonc" text={'{\n  // c\n  "a": 1,\n}'} />
    )
    expect(screen.getByTestId('cloud-workspace-json-tree').textContent).toContain('a')
    expect(screen.queryByTestId('cloud-workspace-json-error')).toBeNull()
  })

  it('非法 JSON 回退源码并给出错误提示', () => {
    render(<JsonFileRenderer {...props} path="config/bad.json" text='{"a": ' />)
    expect(screen.getByTestId('cloud-workspace-json-error').textContent).toContain('JSON 解析失败')
    expect(screen.getByTestId('structured-source-fallback')).toBeTruthy()
  })

  it('超大数组按节点上限截断', () => {
    const values = Array.from({ length: 600 }, (_, index) => index)
    render(<JsonFileRenderer {...props} path="config/big.json" text={JSON.stringify(values)} />)
    expect(screen.getByTestId('cloud-workspace-json-tree').textContent).toContain(
      '还有 100 项未显示'
    )
  })

  it('YAML 树复用结构化展示', () => {
    render(
      <YamlFileRenderer
        {...props}
        path="config/app.yml"
        text={'name: orca\nnested:\n  ok: true\nlist:\n  - 1\n  - 2\n'}
      />
    )
    const tree = screen.getByTestId('cloud-workspace-yaml-tree')
    expect(tree.textContent).toContain('name')
    expect(tree.textContent).toContain('orca')
    expect(tree.textContent).toContain('nested')
  })

  it('非法 YAML 回退源码并给出错误提示', () => {
    render(<YamlFileRenderer {...props} path="config/bad.yml" text="a: [unclosed" />)
    expect(screen.getByTestId('cloud-workspace-yaml-error').textContent).toContain('YAML 解析失败')
    expect(screen.getByTestId('structured-source-fallback')).toBeTruthy()
  })

  it('XML 展示元素、属性与文本', () => {
    render(
      <XmlFileRenderer
        {...props}
        path="pom.xml"
        text='<project id="1"><name>orca</name></project>'
      />
    )
    const tree = screen.getByTestId('cloud-workspace-xml-tree')
    expect(tree.textContent).toContain('project')
    expect(tree.textContent).toContain('@id')
    expect(tree.textContent).toContain('name')
    expect(tree.textContent).toContain('orca')
  })

  it('非法 XML 回退源码并给出错误提示', () => {
    render(<XmlFileRenderer {...props} path="bad.xml" text="<root><a></root>" />)
    expect(screen.getByTestId('cloud-workspace-xml-error').textContent).toContain('XML 解析失败')
    expect(screen.getByTestId('structured-source-fallback')).toBeTruthy()
  })
})

describe('Mermaid 与 PDF 渲染器', () => {
  it('Mermaid 交给 MermaidViewer 渲染全文', () => {
    render(<MermaidFileRenderer {...props} path="design/flow.mmd" text={'graph TD\nA-->B'} />)
    const viewer = screen.getByTestId('mermaid-viewer-stub')
    expect(viewer.getAttribute('data-path')).toBe('design/flow.mmd')
    expect(viewer.textContent).toContain('A-->B')
  })

  it('PDF 以 data URL iframe 交给浏览器原生查看器', () => {
    render(
      <PdfFileRenderer
        {...props}
        path="docs/spec.pdf"
        binary={{ base64: 'JVBERi0=', mimeType: 'application/pdf' }}
      />
    )
    const frame = screen.getByTestId('cloud-workspace-pdf-frame')
    expect(frame.getAttribute('src')).toBe('data:application/pdf;base64,JVBERi0=')
  })

  it('PDF 无内容时显示不可预览提示', () => {
    render(<PdfFileRenderer {...props} path="docs/spec.pdf" />)
    expect(screen.getByTestId('cloud-workspace-preview-pdf').textContent).toContain('无法预览')
  })
})
