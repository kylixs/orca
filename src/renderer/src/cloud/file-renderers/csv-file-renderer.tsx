import * as React from 'react'
import { detectCsvDelimiter, parseCsv } from '@/components/editor/csv/csv-parse'
import type { CloudFileRendererProps } from './registry'

/** Read-only table cap; the host already bounds preview text to ~512KB. */
export const CSV_PREVIEW_ROW_LIMIT = 1000
const CSV_PREVIEW_CELL_LIMIT = 200_000
const CSV_PREVIEW_RECORD_LIMIT = 256 * 1024

type ParsedCsv =
  | { ok: true; rows: string[][]; maxColumns: number; delimiter: string }
  | { ok: false; error: string }

function parsePreview(text: string, path: string): ParsedCsv {
  const delimiter = detectCsvDelimiter(path, text)
  try {
    const { rows, maxColumns } = parseCsv(text, delimiter, {
      maxCells: CSV_PREVIEW_CELL_LIMIT,
      maxRecordLength: CSV_PREVIEW_RECORD_LIMIT
    })
    return { ok: true, rows, maxColumns, delimiter }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function cellsOf(row: string[] | undefined, width: number): string[] {
  const cells = row ? [...row] : []
  while (cells.length < width) {
    cells.push('')
  }
  return cells
}

/** CSV/TSV table preview (L2-01): RFC4180 parsing, first 1000 data rows. */
export function CsvFileRenderer({ path, text }: CloudFileRendererProps): React.JSX.Element {
  const parsed = React.useMemo(() => parsePreview(text ?? '', path), [path, text])

  if (!parsed.ok) {
    return (
      <p
        data-testid="cloud-workspace-csv-error"
        className="p-3 text-xs leading-relaxed text-destructive"
      >
        表格解析失败：{parsed.error}
      </p>
    )
  }
  if (parsed.rows.length === 0) {
    return (
      <p data-testid="cloud-workspace-csv-empty" className="p-3 text-xs text-muted-foreground">
        空表格。
      </p>
    )
  }

  const header = cellsOf(parsed.rows[0], parsed.maxColumns)
  const totalRows = Math.max(0, parsed.rows.length - 1)
  const bodyRows = parsed.rows.slice(1, 1 + CSV_PREVIEW_ROW_LIMIT)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        data-testid="cloud-workspace-csv-summary"
        className="shrink-0 border-b border-border px-3 py-1 text-[11px] text-muted-foreground"
      >
        共 {totalRows} 行 · {parsed.maxColumns} 列
        {totalRows > CSV_PREVIEW_ROW_LIMIT ? ` · 仅显示前 ${CSV_PREVIEW_ROW_LIMIT} 行` : ''}
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-editor">
        <table
          data-testid="cloud-workspace-csv-table"
          className="w-full border-collapse text-left font-mono text-xs"
        >
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th
                  key={index}
                  className="sticky top-0 border border-border bg-muted px-2 py-1 font-medium text-foreground"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, rowIndex) => (
              <tr key={rowIndex} data-testid="cloud-workspace-csv-row">
                {cellsOf(row, parsed.maxColumns).map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className="whitespace-pre border border-border px-2 py-1 text-foreground"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
