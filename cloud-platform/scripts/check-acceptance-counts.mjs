#!/usr/bin/env node
// Deterministic invariants for the acceptance baseline docs (protocol §2-22).
// The counts drifted by hand three times; this makes every number self-deriving.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const dir = path.join(
  ROOT,
  'remote-connectivity/design/2026-11-13-cloud-dev-platform/current-state'
)

const failures = []
const fail = (message) => failures.push(message)

function read(name) {
  return readFileSync(path.join(dir, name), 'utf8')
}

function moduleTable(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const m = line.match(
      /^\|\s*(M\d+)\s*\|[^|]*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|\s*$/
    )
    if (m)
      rows.push({
        name: m[1],
        nums: m.slice(2).map((cell) => Number(cell.replace(/\*/g, '').trim()))
      })
    const t = line.match(
      /^\|\s*\*\*合计\*\*\s*\|[^|]*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|\s*$/
    )
    if (t)
      rows.push({
        name: 'TOTAL',
        nums: t.slice(1).map((cell) => Number(cell.replace(/\*/g, '').trim()))
      })
  }
  return rows
}

function checkAcceptanceCases() {
  const text = read('acceptance-cases.md')
  const rows = moduleTable(text)
  const mods = rows.filter((r) => r.name !== 'TOTAL')
  const total = rows.find((r) => r.name === 'TOTAL')
  if (mods.length !== 12) fail(`module rows: expected 12, got ${mods.length}`)
  if (!total) return fail('module totals row missing')
  const sum = [0, 0, 0, 0, 0, 0, 0]
  for (const row of mods) {
    const [cases, normal, abnormal, pin, auto, manual, uncovered] = row.nums
    if (cases !== normal + abnormal + pin)
      fail(`${row.name}: ${cases} != ${normal}+${abnormal}+${pin}`)
    if (cases !== auto + manual + uncovered)
      fail(`${row.name}: ${cases} != ${auto}+${manual}+${uncovered}`)
    row.nums.forEach((n, i) => (sum[i] += n))
  }
  const [tc, tn, ta, tp, tauto, tmanual, tunc] = total.nums
  if (tn !== sum[1] || ta !== sum[2] || tp !== sum[3])
    fail('totals: normal/abnormal/pin do not add up')
  if (tc !== sum[0] || tauto !== sum[4] || tmanual !== sum[5] || tunc !== sum[6])
    fail('totals row does not match column sums')
  if (tc !== tn + ta + tp) fail('totals: cases != normal+abnormal+pin')
  if (tc !== tauto + tmanual + tunc) fail('totals: cases != auto+manual+uncovered')

  // §13: every gap row counts once by its type cell.
  const gapSection = text.split('## 13.')[1]?.split('### 14')[0] ?? ''
  const gaps = gapSection.split('\n').filter((l) => /^\|\s*G\d+\s*\|/.test(l))
  const counts = { closed: 0, partial: 0, open: 0 }
  for (const line of gaps) {
    const cells = line
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim())
    const title = cells[1] ?? ''
    const type = cells[3] ?? ''
    if (type.startsWith('closed') || title.includes('closed')) counts.closed += 1
    else if (type.includes('部分') || title.includes('部分闭合')) counts.partial += 1
    else counts.open += 1
  }
  const conclusion = text.match(
    /已\s*closed\s*(\d+)\s*条[^；]*；\s*部分闭合\s*(\d+)\s*条[^；]*；\s*待裁定\/待实现\s*(\d+)\s*条/
  )
  if (!conclusion) fail('§13 conclusion counts not found')
  else {
    const [, closed, partial, open] = conclusion.map(Number)
    if (closed !== counts.closed) fail(`§13 closed: text ${closed} != rows ${counts.closed}`)
    if (partial !== counts.partial) fail(`§13 partial: text ${partial} != rows ${counts.partial}`)
    if (open !== counts.open) fail(`§13 open: text ${open} != rows ${counts.open}`)
    if (closed + partial + open !== gaps.length)
      fail(`§13 sum ${closed + partial + open} != ${gaps.length} gap rows`)
  }
  return {
    modules: mods.length,
    cases: tc,
    auto: tauto,
    manual: tmanual,
    uncovered: tunc,
    gaps: gaps.length,
    ...counts
  }
}

function checkBusinessFlows() {
  const text = read('business-flows.md')
  const rows = []
  let total = null
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*(F\d+)\s*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|/)
    if (m) rows.push({ name: m[1], nums: m.slice(2, 6).map((c) => Number(c.trim())) })
    const t = line.match(/^\|\s*\*\*合计\*\*\s*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|/)
    if (t) total = t.slice(1, 5).map((c) => Number(c.replace(/\*/g, '').trim()))
  }
  if (!total) return fail('business-flows totals row missing')
  const sum = [0, 0, 0, 0]
  for (const row of rows) {
    const [steps, branches, coveredSteps, coveredBranches] = row.nums
    if (coveredSteps > steps) fail(`${row.name}: covered steps ${coveredSteps} > ${steps}`)
    if (coveredBranches > branches)
      fail(`${row.name}: covered branches ${coveredBranches} > ${branches}`)
    row.nums.forEach((n, i) => (sum[i] += n))
  }
  total.forEach((n, i) => {
    if (n !== sum[i]) fail(`business-flows total[${i}] ${n} != sum ${sum[i]}`)
  })
  return {
    flows: rows.length,
    steps: total[0],
    branches: total[1],
    coveredSteps: total[2],
    coveredBranches: total[3]
  }
}

const acceptance = checkAcceptanceCases()
const flows = checkBusinessFlows()
if (failures.length > 0) {
  console.error('acceptance counts: FAIL')
  for (const f of failures) console.error(` - ${f}`)
  process.exit(1)
}
console.log('acceptance counts: PASS')
console.log(' cases', JSON.stringify(acceptance))
console.log(' flows', JSON.stringify(flows))
