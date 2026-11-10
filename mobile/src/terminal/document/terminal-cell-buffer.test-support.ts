import type { TerminalDocumentScope } from './document-scope'

/**
 * A width-aware buffer for selection tests.
 *
 * Real xterm cells answer `getChars()`/`getWidth()` and `translateToString` skips a wide glyph's
 * continuation cell. Reproducing those three rules here lets the selection code run against the
 * same geometry it reads in the WebView without starting an engine.
 */

export type TestCell = { chars: string; width: number }

type SelectCall = { col: number; row: number; length: number }

function graphemes(text: string): string[] {
  const result: string[] = []
  let current = ''
  for (const character of text) {
    if (current === '') {
      current = character
      continue
    }
    const code = character.codePointAt(0)!
    const joins =
      /\p{M}/u.test(character) ||
      code === 0x200d ||
      code === 0xfe0f ||
      code === 0xfe0e ||
      (code >= 0x1f3fb && code <= 0x1f3ff) ||
      current.endsWith(String.fromCharCode(0x200d))
    if (joins) {
      current += character
    } else {
      result.push(current)
      current = character
    }
  }
  if (current !== '') {
    result.push(current)
  }
  return result
}

function isWide(character: string): boolean {
  const code = character.codePointAt(0)!
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f000 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

export function cellsForLine(text: string, cols: number): TestCell[] {
  const cells: TestCell[] = []
  for (const glyph of graphemes(text)) {
    const width = isWide(glyph) ? 2 : 1
    cells.push({ chars: glyph, width })
    if (width === 2) {
      cells.push({ chars: '', width: 0 })
    }
  }
  while (cells.length < cols) {
    cells.push({ chars: ' ', width: 1 })
  }
  return cells.slice(0, cols)
}

export function createSelectionScope(lines: string[], cols = 20) {
  const cellLines = lines.map((line) => cellsForLine(line, cols))
  const calls: SelectCall[] = []
  let selected: SelectCall | null = null

  function selectionText(): string {
    if (!selected) {
      return ''
    }
    let row = selected.row
    let col = selected.col
    let remaining = selected.length
    let text = ''
    while (remaining > 0 && row < cellLines.length) {
      const line = cellLines[row]!
      if (col >= cols) {
        row += 1
        col = 0
        continue
      }
      const cell = line[col]!
      text += cell.chars === '' ? '' : cell.chars
      const width = Math.max(1, cell.width)
      col += width
      remaining -= width
    }
    return text
  }

  const term = {
    cols,
    rows: Math.max(1, cellLines.length),
    element: { scrollWidth: cols * 8, scrollHeight: Math.max(1, cellLines.length) * 15 },
    _core: {
      _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } }
    },
    buffer: {
      active: {
        length: cellLines.length,
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        type: 'normal' as const,
        getLine(row: number) {
          const cells = cellLines[row]
          if (!cells) {
            return undefined
          }
          return {
            length: cells.length,
            getCell(col: number) {
              const cell = cells[col]
              return cell
                ? {
                    getChars: () => cell.chars,
                    getWidth: () => cell.width
                  }
                : undefined
            },
            translateToString(trimRight?: boolean, start?: number, end?: number) {
              const first = start ?? 0
              const last = end ?? cells.length
              let text = ''
              let col = first
              while (col < last) {
                const cell = cells[col]
                if (!cell) {
                  break
                }
                text += cell.chars === '' ? ' ' : cell.chars
                col += Math.max(1, cell.width)
              }
              return trimRight ? text.trimEnd() : text
            }
          }
        }
      }
    },
    select(col: number, row: number, length: number) {
      const call = { col, row, length }
      calls.push(call)
      selected = call
    },
    selectAll() {
      selected = { col: 0, row: 0, length: cols * Math.max(1, cellLines.length) }
    },
    clearSelection() {
      selected = null
    },
    refresh() {},
    getSelection() {
      return selectionText()
    }
  }

  const overlay = document.createElement('div')
  const handleStart = document.createElement('div')
  const handleEnd = document.createElement('div')
  overlay.append(handleStart, handleEnd)

  const scope = {
    term,
    panX: 0,
    panY: 0,
    selMode: 'navigate',
    sel: null,
    selectionOverlay: overlay,
    handleStart,
    handleEnd,
    selMenu: document.createElement('div'),
    btnCopy: document.createElement('button'),
    btnSelAll: document.createElement('button'),
    edgeScrollTimer: null,
    edgeScrollDir: 0,
    edgeScrollClientX: 0,
    edgeScrollClientY: 0,
    linesEverWritten: 0,
    postToHost: () => {},
    viewportRect: () => ({ left: 0, top: 0, width: cols * 8, height: 600 })
  }

  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selection modules read only the scope fields built above.
    scope: scope as unknown as TerminalDocumentScope,
    overlay,
    handleStart,
    handleEnd,
    selectCalls: () => calls,
    selectedText: selectionText,
    cellLines
  }
}
