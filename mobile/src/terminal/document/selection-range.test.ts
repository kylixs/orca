// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  glyphStartBeforeCell,
  snapToGlyphEnd,
  snapToGlyphStart,
  stringIndexToCellCol
} from './cell-geometry'
import {
  finishSelectionDrag,
  seedWordSelection,
  selectionSpan,
  selectAllTerminal
} from './selection-range'
import { moveSelectionHandleToCell, repositionOverlay } from './selection-overlay'
import { createSelectionScope } from './terminal-cell-buffer.test-support'
import { resetTokenizerForTests } from './text-tokenizer'
import { checkEviction, logFeedAndEvict } from './selection-state-and-eviction'

function selectAt(
  line: string | string[],
  cell: number,
  row = 0,
  cols = 40
): ReturnType<typeof createSelectionScope> {
  const harness = createSelectionScope(Array.isArray(line) ? line : [line], cols)
  seedWordSelection(harness.scope, cell, row)
  return harness
}

function lastSelect(harness: ReturnType<typeof createSelectionScope>) {
  const calls = harness.selectCalls()
  return calls[calls.length - 1]
}

function anchors(harness: ReturnType<typeof createSelectionScope>) {
  const selection = harness.scope.sel
  if (!selection) {
    return null
  }
  return { anchor: selection.anchor, focus: selection.focus }
}

describe('glyph geometry', () => {
  it('snaps both halves of a wide glyph to its leading cell', () => {
    const { scope } = createSelectionScope(['中文abc'])
    expect(snapToGlyphStart(scope, 0, 0)).toBe(0)
    expect(snapToGlyphStart(scope, 0, 1)).toBe(0)
    expect(snapToGlyphStart(scope, 0, 3)).toBe(2)
    expect(snapToGlyphStart(scope, 0, 4)).toBe(4)
    // A blank cell is never treated as a continuation.
    expect(snapToGlyphStart(scope, 0, 8)).toBe(8)
  })

  it('snapToGlyphEnd advances by width, continuation, blank, and clamps at the line end', () => {
    const { scope } = createSelectionScope(['中文abc'], 6)
    expect(snapToGlyphEnd(scope, 0, 0)).toBe(2)
    expect(snapToGlyphEnd(scope, 0, 1)).toBe(2)
    expect(snapToGlyphEnd(scope, 0, 4)).toBe(5)
    expect(snapToGlyphEnd(scope, 0, 5)).toBe(6)
    const wrapped = createSelectionScope(['中'], 2).scope
    expect(snapToGlyphEnd(wrapped, 0, 0)).toBe(2)
  })

  it('maps UTF-16 boundaries to glyph-start cells and clamps past the line', () => {
    const { scope } = createSelectionScope(['中文😀English'])
    expect(stringIndexToCellCol(scope, 0, 0)).toBe(0)
    expect(stringIndexToCellCol(scope, 0, 1)).toBe(2)
    expect(stringIndexToCellCol(scope, 0, 2)).toBe(4)
    // Inside the surrogate pair still belongs to the emoji's cell.
    expect(stringIndexToCellCol(scope, 0, 3)).toBe(4)
    // After it is where English starts.
    expect(stringIndexToCellCol(scope, 0, 4)).toBe(6)
    expect(stringIndexToCellCol(scope, 0, 999)).toBe(scope.term!.cols)
    expect(glyphStartBeforeCell(scope, 0, 6)).toBe(4)
    expect(glyphStartBeforeCell(scope, 0, 5)).toBe(4)
  })
})

describe('long-press selection vectors G1..G18', () => {
  it('G1-G4: CJK taps on either half and a Latin tap do not drift', () => {
    for (const tap of [0, 1, 3]) {
      const harness = selectAt('中文abc', tap)
      expect(lastSelect(harness)).toEqual({ col: 0, row: 0, length: 4 })
      expect(anchors(harness)).toEqual({ anchor: { col: 0, row: 0 }, focus: { col: 2, row: 0 } })
      expect(harness.selectedText()).toBe('中文')
    }
    const latin = selectAt('中文abc', 4)
    expect(lastSelect(latin)).toEqual({ col: 4, row: 0, length: 3 })
    expect(latin.selectedText()).toBe('abc')
  })

  it('G5-G6: emoji and English start at the correct cell', () => {
    const emoji = selectAt('中文😀English', 5)
    expect(lastSelect(emoji)).toEqual({ col: 4, row: 0, length: 2 })
    expect(emoji.selectedText()).toBe('😀')

    const english = selectAt('中文😀English', 6)
    expect(lastSelect(english)).toEqual({ col: 6, row: 0, length: 7 })
    expect(english.selectedText()).toBe('English')
  })

  it('G7-G8: a space between tokens ties left', () => {
    const space = selectAt('中文 abc', 4)
    expect(lastSelect(space)).toEqual({ col: 0, row: 0, length: 4 })
    expect(space.selectedText()).toBe('中文')

    const word = selectAt('中文 abc', 5)
    expect(lastSelect(word)).toEqual({ col: 5, row: 0, length: 3 })
  })

  it('G9-G10: a full-width comma belongs to the token it terminates; the next run is whole', () => {
    for (const tap of [4, 5]) {
      const harness = selectAt('修复，登录流程', tap)
      expect(lastSelect(harness)).toEqual({ col: 0, row: 0, length: 4 })
      expect(harness.selectedText()).toBe('修复')
    }
    const right = selectAt('修复，登录流程', 6)
    expect(lastSelect(right)).toEqual({ col: 6, row: 0, length: 8 })
    expect(right.selectedText()).toBe('登录流程')
  })

  it('G11: gaps of one cell on both sides tie left', () => {
    const harness = selectAt('验证 权限边界 & token', 14)
    expect(lastSelect(harness)).toEqual({ col: 5, row: 0, length: 8 })
    expect(harness.selectedText()).toBe('权限边界')
  })

  it('G12-G13: URLs and paths stay whole', () => {
    const url = 'https://example.com/path?q=中文'
    const urlHarness = selectAt(url, 0)
    expect(lastSelect(urlHarness)).toEqual({ col: 0, row: 0, length: 31 })
    expect(urlHarness.selectedText()).toBe(url)

    const pathHarness = selectAt('src/main.ts:42', 2)
    expect(lastSelect(pathHarness)).toEqual({ col: 0, row: 0, length: 14 })
    expect(pathHarness.selectedText()).toBe('src/main.ts:42')
  })

  it('G12b-G13b: a trailing or leading separator survives the copy', () => {
    for (const line of ['https://example.com/', 'https://example.com/a/']) {
      const harness = selectAt(line, 0)
      expect(lastSelect(harness), line).toEqual({ col: 0, row: 0, length: line.length })
      expect(harness.selectedText(), line).toBe(line)
    }
    for (const line of ['/var/log/', '/tmp/', 'C:\\', './src/']) {
      const harness = selectAt(line, 0)
      expect(lastSelect(harness), line).toEqual({ col: 0, row: 0, length: line.length })
      expect(harness.selectedText(), line).toBe(line)
    }
  })

  it('G14-G15: combining sequences stay one glyph and full-width text is one token', () => {
    const combining = selectAt('éx'.normalize('NFD'), 0)
    expect(lastSelect(combining)).toEqual({ col: 0, row: 0, length: 1 })
    expect(combining.selectedText()).toBe('é'.normalize('NFD'))

    const fullwidth = selectAt('ＡＢＣ１２３', 3)
    expect(lastSelect(fullwidth)).toEqual({ col: 0, row: 0, length: 12 })
    expect(fullwidth.selectedText()).toBe('ＡＢＣ１２３')
  })

  it('G16-G18: only the current buffer line is seeded, including a wrapped wide glyph', () => {
    const wrapped = selectAt(['abcdefghij', 'KLMNOP'], 0, 1, 10)
    expect(lastSelect(wrapped)).toEqual({ col: 0, row: 1, length: 6 })
    expect(wrapped.selectedText()).toBe('KLMNOP')

    const wide = selectAt('abcd中', 5, 0, 6)
    expect(lastSelect(wide)).toEqual({ col: 4, row: 0, length: 2 })

    const nextRow = selectAt(['abcd', '中'], 1, 1, 5)
    expect(lastSelect(nextRow)).toEqual({ col: 0, row: 1, length: 2 })
    expect(nextRow.selectedText()).toBe('中')
  })
})

describe('nearby phrase and atomic selection vectors G22..G30', () => {
  it('G22-G22e: join-set and suffix tokens stay whole', () => {
    const vectors = [
      ['foo-bar', 7],
      ['key=value', 9],
      ['a@b.com', 7],
      ['C++', 3],
      ['100%', 4],
      ['a#b', 3]
    ] as const
    for (const [line, length] of vectors) {
      const harness = selectAt(line, 1)
      expect(lastSelect(harness), line).toEqual({ col: 0, row: 0, length })
      expect(harness.selectedText(), line).toBe(line)
    }
  })

  it('G23-G24: ZWJ emoji is one grapheme and punctuation is a boundary', () => {
    const family = '👨‍👩‍👧‍👦 family'
    const emoji = selectAt(family, 0)
    expect(emoji.selectedText()).toBe('👨‍👩‍👧‍👦')

    const punct = selectAt('中文。abc', 4)
    expect(punct.selectedText()).toBe('中文')
  })

  it('G25: a long token eight cells away still wins', () => {
    const line = 'abcdefghijklmnopqrst' + '        &'
    const harness = selectAt(line, 28)
    expect(lastSelect(harness)?.length).toBe(20)
    expect(harness.selectedText()).toBe('abcdefghijklmnopqrst')
  })

  it('G26-G28: long CJK runs take a five-character window', () => {
    const people = selectAt('中华人民共和国万岁', 4)
    expect(lastSelect(people)).toEqual({ col: 4, row: 0, length: 10 })
    expect(people.selectedText()).toBe('人民共和国')

    const country = selectAt('中华人民共和国万岁', 12)
    expect(lastSelect(country)).toEqual({ col: 8, row: 0, length: 10 })
    expect(country.selectedText()).toBe('共和国万岁')

    const seasons = selectAt('春夏秋冬风花雪', 8)
    expect(lastSelect(seasons)).toEqual({ col: 4, row: 0, length: 10 })
    expect(seasons.selectedText()).toBe('秋冬风花雪')
  })

  it('G29: whitespace establishes no selection, and blanks never snap left', () => {
    const harness = selectAt('        ', 3)
    expect(harness.scope.sel).toBeNull()
    expect(harness.selectCalls()).toEqual([])
    expect(snapToGlyphStart(harness.scope, 0, 3)).toBe(3)
  })

  it('G30: a lone non-blank glyph falls back to itself', () => {
    const harness = selectAt('          &          ', 10)
    expect(lastSelect(harness)).toEqual({ col: 10, row: 0, length: 1 })
    expect(harness.selectedText()).toBe('&')
  })
})

describe('Chrome 74 tokenizer fallback', () => {
  it('produces the same selections without Intl.Segmenter or Array.prototype.at', () => {
    const segmenterDescriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')
    const atDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'at')
    try {
      Reflect.deleteProperty(Intl, 'Segmenter')
      Reflect.deleteProperty(Array.prototype, 'at')
      resetTokenizerForTests()

      const cjk = selectAt('中华人民共和国万岁', 12)
      expect(lastSelect(cjk)).toEqual({ col: 8, row: 0, length: 10 })
      expect(cjk.selectedText()).toBe('共和国万岁')

      const url = selectAt('https://example.com/', 0)
      expect(url.selectedText()).toBe('https://example.com/')

      const path = selectAt('/var/log/', 0)
      expect(path.selectedText()).toBe('/var/log/')
    } finally {
      if (segmenterDescriptor) {
        Object.defineProperty(Intl, 'Segmenter', segmenterDescriptor)
      }
      if (atDescriptor) {
        Reflect.defineProperty(Array.prototype, 'at', atDescriptor)
      }
      resetTokenizerForTests()
    }
  })
})

describe('selection handle model', () => {
  function seeded(line: string, anchorCol: number, focusCol: number) {
    const harness = createSelectionScope([line])
    harness.scope.selMode = 'select'
    harness.overlay.classList.add('active')
    harness.scope.sel = {
      anchor: { col: anchorCol, row: 0 },
      focus: { col: focusCol, row: 0 },
      activeHandle: 'start'
    }
    return harness
  }

  it('B17b: crossing handles sort and survive the equal point', () => {
    const first = seeded('abcdef', 1, 2)
    moveSelectionHandleToCell(first.scope, 'start', { row: 0, col: 2 })
    expect(first.scope.sel).not.toBeNull()
    expect(lastSelect(first)).toEqual({ col: 2, row: 0, length: 1 })
    moveSelectionHandleToCell(first.scope, 'start', { row: 0, col: 5 })
    expect(lastSelect(first)).toEqual({ col: 2, row: 0, length: 4 })
    expect(first.selectedText()).toBe('cdef')

    const second = seeded('abcdef', 1, 3)
    moveSelectionHandleToCell(second.scope, 'end', { row: 0, col: 1 })
    expect(second.scope.sel).not.toBeNull()
    moveSelectionHandleToCell(second.scope, 'end', { row: 0, col: 0 })
    expect(lastSelect(second)).toEqual({ col: 0, row: 0, length: 2 })
    expect(second.selectedText()).toBe('ab')

    const third = seeded('中文abc', 2, 4)
    moveSelectionHandleToCell(third.scope, 'start', { row: 0, col: 4 })
    expect(third.scope.sel).not.toBeNull()
    moveSelectionHandleToCell(third.scope, 'start', { row: 0, col: 6 })
    expect(lastSelect(third)).toEqual({ col: 4, row: 0, length: 3 })
    expect(third.selectedText()).toBe('abc')
  })

  it('B17b2: crossing onto a fixed wide upper anchor includes the whole glyph', () => {
    const harness = seeded('中文abc', 2, 4)
    moveSelectionHandleToCell(harness.scope, 'end', { row: 0, col: 0 })
    expect(lastSelect(harness)).toEqual({ col: 0, row: 0, length: 4 })
    expect(harness.selectedText()).toBe('中文')
  })

  it('B17d: only releasing on an equal pair clears the selection', () => {
    const harness = seeded('abcdef', 3, 3)
    finishSelectionDrag(harness.scope)
    expect(harness.scope.sel).toBeNull()
    expect(harness.scope.selMode).toBe('navigate')
    expect(harness.overlay.classList.contains('active')).toBe(false)
  })

  it('B17e: seeding stores the leading cell of each included glyph', () => {
    expect(anchors(selectAt('中文abc', 1))).toEqual({
      anchor: { col: 0, row: 0 },
      focus: { col: 2, row: 0 }
    })
    expect(anchors(selectAt('中文abc', 4))).toEqual({
      anchor: { col: 4, row: 0 },
      focus: { col: 6, row: 0 }
    })
    expect(anchors(selectAt('ＡＢＣ１２３', 3))).toEqual({
      anchor: { col: 0, row: 0 },
      focus: { col: 10, row: 0 }
    })
  })
})

describe('selection lifecycle', () => {
  it('applies a multi-line end-exclusive length', () => {
    const harness = createSelectionScope(['abcdefghij', 'ABCDEFGHIJ'], 10)
    harness.scope.selMode = 'select'
    harness.scope.sel = {
      anchor: { col: 8, row: 0 },
      focus: { col: 2, row: 1 },
      activeHandle: null
    }
    const span = selectionSpan(harness.scope)
    expect(span).toEqual({
      start: { row: 0, col: 8 },
      endExclusive: { row: 1, col: 3 }
    })
    harness.scope.term!.select(span!.start.col, span!.start.row, 5)
    expect(harness.selectedText()).toBe('ijABC')
  })

  it('selectAll stores glyph-start anchors and reaches the right edge', () => {
    const harness = createSelectionScope(['abc', '12345678中'], 10)
    selectAllTerminal(harness.scope)
    expect(harness.scope.sel).toEqual({
      anchor: { col: 0, row: 0 },
      focus: { col: 8, row: 1 },
      activeHandle: null
    })
    expect(selectionSpan(harness.scope)).toEqual({
      start: { row: 0, col: 0 },
      endExclusive: { row: 1, col: 10 }
    })
  })

  it('pins a right-edge end handle to the viewport while keeping the exclusive column', () => {
    const harness = createSelectionScope(['abcdefghij'], 10)
    harness.scope.selMode = 'select'
    harness.scope.sel = {
      anchor: { col: 0, row: 0 },
      focus: { col: 9, row: 0 },
      activeHandle: null
    }
    harness.scope.currentScale = 1
    harness.scope.userScale = 1.5
    repositionOverlay(harness.scope)

    expect(selectionSpan(harness.scope)?.endExclusive).toEqual({ row: 0, col: 10 })
    expect(harness.handleEnd.style.left).toBe('80px')
  })

  it('moves stored anchors up on eviction and clears when the oldest row leaves', () => {
    const harness = createSelectionScope(['one', 'two', 'three'], 10)
    harness.scope.selMode = 'select'
    harness.scope.sel = {
      anchor: { col: 0, row: 1 },
      focus: { col: 3, row: 2 },
      activeHandle: null
    }
    harness.scope.linesEverWritten = 5000 + harness.scope.term!.rows
    logFeedAndEvict(harness.scope)
    expect(harness.scope.sel).toMatchObject({
      anchor: { row: 0 },
      focus: { row: 1 }
    })

    harness.scope.sel!.anchor.row = -1
    checkEviction(harness.scope)
    expect(harness.scope.sel).toBeNull()
  })
})
