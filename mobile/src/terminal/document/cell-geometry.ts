import { getCellHeight } from './fit-scale'
import { getCellWidth, getTotalScale } from './viewport-transform'
import type { TerminalDocumentLine, TerminalDocumentScope } from './document-scope'

export function cellToViewportPx(scope: TerminalDocumentScope, col: number, absRow: number) {
  if (!scope.term) {
    return { x: 0, y: 0 }
  }
  const cellW = getCellWidth(scope)
  const cellH = getCellHeight(scope)
  const viewportRow = absRow - scope.term.buffer.active.viewportY
  const sx = col * cellW
  const sy = viewportRow * cellH
  const total = getTotalScale(scope)
  return { x: sx * total + scope.panX, y: sy * total + scope.panY }
}

export function getLineText(scope: TerminalDocumentScope, absRow: number) {
  if (!scope.term) {
    return ''
  }
  const line = scope.term.buffer.active.getLine(absRow)
  if (!line) {
    return ''
  }
  return line.translateToString(false)
}

// Why: getLineText collapses wide chars (emoji, CJK) to one string char, so a
// tap's CELL column no longer equals the STRING index that url/path matchers use.
// Convert by measuring the string length up to the tapped cell (the count of
// string chars before it). Without this, taps on lines with a leading wide char
// (e.g. agent output prefixed with ⏺) resolve to the wrong column and miss.
export function cellColToStringIndex(scope: TerminalDocumentScope, absRow: number, col: number) {
  if (!scope.term) {
    return col
  }
  const line = scope.term.buffer.active.getLine(absRow)
  if (!line) {
    return col
  }
  return line.translateToString(false, 0, col).length
}

function cellWidth(line: TerminalDocumentLine | undefined, col: number) {
  return line?.getCell?.(col)?.getWidth?.() ?? 1
}

/**
 * The column of the leading cell of the glyph under this one.
 *
 * A wide glyph owns its continuation cell (`getWidth() === 0`); taps there must resolve to the
 * glyph's first cell or the cell-to-string conversion lands after the glyph. Blank cells are never
 * continuations, whatever their `getChars()` answer.
 */
export function snapToGlyphStart(
  scope: TerminalDocumentScope,
  absRow: number,
  col: number
): number {
  if (!scope.term) {
    return Math.max(0, col)
  }
  const line = scope.term.buffer.active.getLine(absRow)
  if (!line) {
    return Math.max(0, col)
  }
  let snapped = Math.max(0, Math.min(col, scope.term.cols - 1))
  while (snapped > 0 && cellWidth(line, snapped) === 0) {
    if (cellWidth(line, snapped - 1) !== 2) {
      break
    }
    snapped -= 1
  }
  return snapped
}

/**
 * One past the last cell of the glyph under this one.
 *
 * A glyph's own cell advances by its width; a continuation cell first resolves to its start; a
 * blank advances one; the line end clamps to the grid width.
 */
export function snapToGlyphEnd(scope: TerminalDocumentScope, absRow: number, col: number): number {
  if (!scope.term) {
    return Math.max(0, col)
  }
  const line = scope.term.buffer.active.getLine(absRow)
  if (!line) {
    return Math.max(0, col)
  }
  const start = snapToGlyphStart(scope, absRow, col)
  const width = cellWidth(line, start)
  const end = start + (width > 0 ? width : 1)
  return Math.max(start + 1, Math.min(end, scope.term.cols))
}

/**
 * The cell column at a UTF-16 string boundary.
 *
 * The cursor advances by each glyph's actual code-unit count while the cell cursor advances by its
 * display width, so a surrogate pair or a combining sequence is one glyph on both sides. An index
 * exactly on a glyph boundary is the next glyph's start, which is what end-exclusive token spans
 * need.
 */
export function stringIndexToCellCol(
  scope: TerminalDocumentScope,
  absRow: number,
  stringIndex: number
): number {
  if (!scope.term) {
    return Math.max(0, stringIndex)
  }
  const line = scope.term.buffer.active.getLine(absRow)
  if (!line) {
    return Math.max(0, stringIndex)
  }
  const target = Math.max(0, stringIndex)
  let stringCursor = 0
  let col = 0
  while (col < scope.term.cols) {
    const cell = line.getCell?.(col)
    const chars = cell?.getChars?.() ?? ' '
    const length = chars.length || 1
    if (target < stringCursor + length) {
      return col
    }
    stringCursor += length
    const width = cell?.getWidth?.() ?? 1
    col += Math.max(1, width)
    if (target === stringCursor) {
      return Math.min(col, scope.term.cols)
    }
  }
  return scope.term.cols
}

/** The leading cell of the last glyph that ends before `endExclusiveCell`. */
export function glyphStartBeforeCell(
  scope: TerminalDocumentScope,
  absRow: number,
  endExclusiveCell: number
): number {
  if (!scope.term) {
    return Math.max(0, endExclusiveCell - 1)
  }
  const line = scope.term.buffer.active.getLine(absRow)
  if (!line) {
    return Math.max(0, endExclusiveCell - 1)
  }
  let col = Math.max(0, Math.min(endExclusiveCell - 1, scope.term.cols - 1))
  while (col > 0 && cellWidth(line, col) === 0) {
    col -= 1
  }
  return col
}

// File-path-under-tap detection (matchFilePathAtColumn). See path-tap.ts;
// mirrors the unit-tested terminal-path-tap.ts.
