import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './harness.ts'

/**
 * U114 D5 (audit B, U86): regression contract for the audit query grid.
 *
 * happy-dom has no layout, so the actual row geometry (three y-aligned rows,
 * control height, right-aligned actions) can only be asserted on the real
 * stack. That measurement already exists as a one-off probe:
 *   - scripts/exploratory-r2/exploratory-r5-paths.md §P2' (rowGroups / y = 204/244/284)
 *   - evidence/u86-fix/after-layout.json
 * What this file pins is the static contract those probes relied on: the 12-col
 * base grid, the row span arithmetic (4+2+2+2+2 / 3+3+3+3 / 3+9), and the
 * 1100px (6-col) and 700px (2-col) breakpoints.
 */

const css = readFileSync(join(ROOT, 'apps/web/styles.css'), 'utf8')
const app = readFileSync(join(ROOT, 'apps/web/app.js'), 'utf8')

/** Balanced-brace block starting at the first `{` at or after `from`. */
function blockAt(source: string, from: number): string {
  const open = source.indexOf('{', from)
  assert.notEqual(open, -1, 'selector must have a body')
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error('unbalanced braces')
}

const compact = (text: string): string => text.replace(/\s+/g, ' ').trim()

function mediaBlock(maxWidth: number): string {
  const header = `@media (max-width: ${maxWidth}px)`
  let from = 0
  for (;;) {
    const at = css.indexOf(header, from)
    assert.notEqual(at, -1, `missing ${header}`)
    const body = compact(blockAt(css, at))
    if (body.includes('.audit-filter')) return body
    from = at + header.length
  }
}

test('U86 基础网格：12 列 + span 类 + 三行跨度合计 12', () => {
  const base = compact(blockAt(css, css.indexOf('\n.audit-filter {')))
  assert.match(base, /display: grid/)
  assert.match(base, /grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/)
  assert.match(base, /gap: 8px 10px/)

  // The span rules are siblings of the grid rule, so match the whole sheet.
  const sheet = compact(css)
  assert.match(sheet, /\.audit-filter \.span-2 \{ grid-column: span 2; \}/)
  assert.match(sheet, /\.audit-filter \.span-3 \{ grid-column: span 3; \}/)
  assert.match(sheet, /\.audit-filter \.span-4 \{ grid-column: span 4; \}/)
  assert.match(sheet, /\.audit-filter-actions \{ grid-column: span 9;/)

  // Markup order is the row grouping: spans are consumed left-to-right in
  // chunks of 12 columns, so these three sums are the three visual rows.
  const markup = app.slice(
    app.indexOf('<div class="audit-filter" role="search"'),
    app.indexOf('<p class="inline-error" id="auditError"')
  )
  const spans = [...markup.matchAll(/class="[^"]*span-(\d)[^"]*"/g)].map((m) => Number(m[1]))
  assert.deepEqual(spans, [4, 2, 2, 2, 2, 3, 3, 3, 3, 3])
  const rows = [spans.slice(0, 5), spans.slice(5, 9), spans.slice(9)]
  assert.equal(rows[0].reduce((a, b) => a + b, 0), 12, 'row 1: keyword + range + since + until + type')
  assert.equal(rows[1].reduce((a, b) => a + b, 0), 12, 'row 2: actor + project + host + fileName')
  assert.equal(rows[2].reduce((a, b) => a + b, 0) + 9, 12, 'row 3: result + actions(span 9)')
})

test('U86 响应式断点：1100px 收 6 列，700px 收 2 列，span 同步收敛', () => {
  const wide = mediaBlock(1100)
  assert.match(wide, /\.audit-filter \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\); \}/)
  assert.match(wide, /\.audit-filter \.span-4 \{ grid-column: span 6; \}/)
  assert.match(wide, /\.audit-filter \.span-3, \.audit-filter \.span-2 \{ grid-column: span 3; \}/)
  assert.match(wide, /\.audit-filter-actions \{ grid-column: span 3; \}/)

  const narrow = mediaBlock(700)
  assert.match(narrow, /\.audit-filter \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
  assert.match(
    narrow,
    /\.audit-filter \.span-4, \.audit-filter \.span-3, \.audit-filter \.span-2 \{ grid-column: span 2; \}/
  )
  assert.match(narrow, /\.audit-filter-actions \{ grid-column: span 2; \}/)
})
