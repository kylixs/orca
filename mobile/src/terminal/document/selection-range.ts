import {
  cellColToStringIndex,
  getLineText,
  glyphStartBeforeCell,
  snapToGlyphEnd,
  snapToGlyphStart,
  stringIndexToCellCol
} from './cell-geometry'
import type { TerminalDocumentScope, TerminalDocumentSelection } from './document-scope'
import { notify } from './host-notify'
import { repositionOverlay, stopEdgeScroll } from './selection-overlay'
import { tokenizeTerminalLine, type TerminalLineToken } from './text-tokenizer'

/** The cells between the selected anchors, with the end one past the last selected cell. */
export type SelectionSpan = {
  start: { row: number; col: number }
  endExclusive: { row: number; col: number }
}

/** How far either side of a punctuation/blank tap a token may sit, in cells. */
const NEARBY_TOKEN_GAP_CELLS = 8

/** The longest CJK window a single-character long press expands to. */
const CJK_WINDOW_CHARS = 5

export function isStartFirst(
  a: TerminalDocumentSelection['anchor'],
  b: TerminalDocumentSelection['anchor']
) {
  if (a.row !== b.row) {
    return a.row < b.row
  }
  return a.col <= b.col
}

/**
 * The rendered span of the two stored anchors.
 *
 * Both anchors are glyph-start cells; end-exclusive is derived here and never stored, so a wide
 * glyph's continuation cell is counted once by `snapToGlyphEnd` rather than by every producer.
 */
export function selectionSpan(scope: TerminalDocumentScope): SelectionSpan | null {
  if (!scope.sel) {
    return null
  }
  const first = isStartFirst(scope.sel.anchor, scope.sel.focus) ? scope.sel.anchor : scope.sel.focus
  const second = first === scope.sel.anchor ? scope.sel.focus : scope.sel.anchor
  const startCol = snapToGlyphStart(scope, first.row, first.col)
  const secondCol = snapToGlyphStart(scope, second.row, second.col)
  return {
    start: { row: first.row, col: startCol },
    endExclusive: { row: second.row, col: snapToGlyphEnd(scope, second.row, secondCol) }
  }
}

function isBlankAt(line: string, index: number): boolean {
  if (index < 0 || index >= line.length) {
    return true
  }
  return /\s/.test(line[index]!)
}

type ChosenSelection = { start: number; end: number }

function cjkWindow(
  line: string,
  token: TerminalLineToken,
  tapString: number,
  side: 'inside' | 'left' | 'right'
): ChosenSelection {
  if (token.kind !== 'cjk' || token.end - token.start <= CJK_WINDOW_CHARS) {
    return { start: token.start, end: token.end }
  }
  let start: number
  if (side === 'left') {
    start = token.end - CJK_WINDOW_CHARS
  } else if (side === 'right') {
    start = token.start
  } else {
    const offset = Math.min(
      Math.max(tapString - token.start, 0),
      token.end - token.start - CJK_WINDOW_CHARS
    )
    start = token.start + offset
  }
  return { start, end: start + CJK_WINDOW_CHARS }
}

function tokenCells(scope: TerminalDocumentScope, row: number, token: ChosenSelection) {
  const start = stringIndexToCellCol(scope, row, token.start)
  let end = stringIndexToCellCol(scope, row, token.end)
  if (end <= start) {
    end = snapToGlyphEnd(scope, row, start)
  }
  return { start, end }
}

function tokenSelection(
  line: string,
  token: TerminalLineToken,
  tapString: number,
  side: 'inside' | 'left' | 'right'
): ChosenSelection {
  return cjkWindow(line, token, tapString, side)
}

/**
 * The token under the tap, else the token nearest in cells, else one non-blank glyph.
 *
 * Edge distance is measured from the glyph start the tap snapped to: a token ending at that cell
 * is adjacent (0), and one starting after it has the cells between them counted. A tie goes left,
 * which is what makes a punctuation tap between two words pick the word it terminates.
 */
function chooseSelection(
  scope: TerminalDocumentScope,
  row: number,
  line: string,
  tapCell: number,
  tapString: number
): ChosenSelection | null {
  const tokens = tokenizeTerminalLine(line)
  const containing = tokens.find((token) => tapString >= token.start && tapString < token.end)
  if (containing) {
    return tokenSelection(line, containing, tapString, 'inside')
  }

  let best: { token: TerminalLineToken; side: 'left' | 'right'; gap: number } | null = null
  for (const token of tokens) {
    const cells = tokenCells(scope, row, token)
    let side: 'left' | 'right'
    let gap: number
    if (cells.end <= tapCell) {
      side = 'left'
      gap = tapCell - cells.end
    } else if (cells.start > tapCell) {
      side = 'right'
      gap = cells.start - tapCell - 1
    } else {
      continue
    }
    if (gap > NEARBY_TOKEN_GAP_CELLS) {
      continue
    }
    if (
      best === null ||
      gap < best.gap ||
      (gap === best.gap && side === 'left' && best.side === 'right')
    ) {
      best = { token, side, gap }
    }
  }
  if (best) {
    return tokenSelection(line, best.token, tapString, best.side)
  }

  // Why: only a non-blank glyph falls back. A blank or line end establishes no selection, while a
  // lone punctuation mark is still something the user pointed at and can copy.
  if (isBlankAt(line, tapString)) {
    return null
  }
  return { start: tapString, end: tapString + (line.codePointAt(tapString)! > 0xffff ? 2 : 1) }
}

/** Seeds a selection from the glyph under a long press. Returns false when there is none to show. */
export function seedWordSelection(
  scope: TerminalDocumentScope,
  col: number,
  absRow: number
): boolean {
  const snapped = snapToGlyphStart(scope, absRow, col)
  const line = getLineText(scope, absRow)
  if (!line) {
    scope.sel = null
    return false
  }
  const tapString = cellColToStringIndex(scope, absRow, snapped)
  const chosen = chooseSelection(scope, absRow, line, snapped, tapString)
  if (!chosen) {
    scope.sel = null
    return false
  }
  const startCell = stringIndexToCellCol(scope, absRow, chosen.start)
  const endExclusive = stringIndexToCellCol(scope, absRow, chosen.end)
  const lastCell = glyphStartBeforeCell(scope, absRow, Math.max(startCell + 1, endExclusive))
  scope.sel = {
    anchor: { col: startCell, row: absRow },
    focus: { col: lastCell, row: absRow },
    activeHandle: null
  }
  applyXtermSelection(scope)
  return true
}

export function applyXtermSelection(scope: TerminalDocumentScope) {
  if (!scope.term || !scope.sel) {
    return
  }
  const span = selectionSpan(scope)
  if (!span) {
    return
  }
  let length: number
  if (span.start.row === span.endExclusive.row) {
    length = span.endExclusive.col - span.start.col
  } else {
    const first = scope.term.cols - span.start.col
    const middle = Math.max(0, span.endExclusive.row - span.start.row - 1) * scope.term.cols
    length = first + middle + span.endExclusive.col
  }
  if (length <= 0) {
    return
  }
  try {
    scope.term.select(span.start.col, span.start.row, length)
  } catch {}
}

export function cancelSelect(scope: TerminalDocumentScope) {
  scope.selMode = 'navigate'
  scope.sel = null
  stopEdgeScroll(scope)
  if (scope.term) {
    try {
      scope.term.clearSelection()
    } catch {}
    // Why: some xterm renderers cache cells and skip repaint on
    // clearSelection alone, leaving the previously-highlighted cells
    // visually selected. Force a full refresh so the selection layer
    // actually clears on screen.
    try {
      scope.term.refresh(0, scope.term.rows - 1)
    } catch {}
  }
  scope.selectionOverlay!.classList.remove('active')
  notify(scope, { type: 'set-select-mode', enabled: false })
}

/** Only the release clears an equal pair; while dragging, the span is that single glyph. */
export function finishSelectionDrag(scope: TerminalDocumentScope) {
  if (!scope.sel) {
    return
  }
  const equal =
    scope.sel.anchor.row === scope.sel.focus.row && scope.sel.anchor.col === scope.sel.focus.col
  scope.sel.activeHandle = null
  if (equal) {
    cancelSelect(scope)
  }
}

export function enterSelect(scope: TerminalDocumentScope, col: number, absRow: number) {
  if (!seedWordSelection(scope, col, absRow)) {
    return
  }
  scope.selMode = 'select'
  scope.selectionOverlay!.classList.add('active')
  notify(scope, { type: 'set-select-mode', enabled: true })
  notify(scope, { type: 'haptic', kind: 'selection' })
  repositionOverlay(scope)
}

/** Select All stores two glyph-start anchors; the span reaches the grid's right edge. */
export function selectAllTerminal(scope: TerminalDocumentScope) {
  if (!scope.term) {
    return
  }
  try {
    scope.term.selectAll()
    const lastRow = scope.term.buffer.active.length - 1
    scope.selMode = 'select'
    scope.selectionOverlay!.classList.add('active')
    notify(scope, { type: 'set-select-mode', enabled: true })
    scope.sel = {
      anchor: { col: 0, row: 0 },
      focus: {
        col: snapToGlyphStart(scope, lastRow, scope.term.cols - 1),
        row: lastRow
      },
      activeHandle: null
    }
    repositionOverlay(scope)
  } catch {}
}
