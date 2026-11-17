import assert from 'node:assert/strict'
import test from 'node:test'
import { checkLedgerTable } from './check-ledger-table.mjs'

const HEADER = '| # | 状态 | 问题 | 根因 | 处置 |\n| --- | --- | --- | --- | --- |\n'

test('accepts a contiguous five-column table', () => {
  const text = `# ledger\n\n${HEADER}| U1 | 🟢 | p | r | a |\n\n## 流程整改\n`
  assert.deepEqual(checkLedgerTable(text), [])
})

test('reports a blank line that splits the table', () => {
  const text = `${HEADER}| U1 | 🟢 | p | r | a |\n\n| U2 | 🟢 | p | r | a |\n`
  const issues = checkLedgerTable(text)
  assert.ok(issues.some((issue) => issue.includes('blank line inside the ledger table')))
})

test('reports a merged row (two rows on one line)', () => {
  const text = `${HEADER}| U1 | 🟢 | p | r | a || U2 | 🟡 | p | r | a |\n`
  const issues = checkLedgerTable(text)
  assert.ok(issues.some((issue) => issue.includes('merged or malformed row')))
})

test('reports an invalid status glyph', () => {
  const text = `${HEADER}| U1 | green | p | r | a |\n`
  const issues = checkLedgerTable(text)
  assert.ok(issues.some((issue) => issue.includes('invalid status')))
})

test('reports a missing header', () => {
  assert.deepEqual(checkLedgerTable('# empty\n'), ['ledger table header (| # |) not found'])
})
