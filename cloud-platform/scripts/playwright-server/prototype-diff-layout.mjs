/** Layout class: page/nav/section order (LCS), stats and table columns. */
import { compareOrdered, labelEvidence, matchLabels } from './prototype-diff-core.mjs'

function compareSurface({ add, role, surface, prototypeInventory, actualInventory }) {
  const p = prototypeInventory
  const a = actualInventory

  // Sidebar is global chrome: compare it once on the workbench surface.
  const navPrototype = surface === 'workbench' ? p.nav : []
  const navActual = surface === 'workbench' ? a.nav : []
  const nav = compareOrdered(
    navPrototype.map((item) => item.label),
    navActual.map((item) => item.label)
  )
  nav.missing.forEach((index) =>
    add({
      role,
      surface,
      class: 'layout',
      kind: 'missing',
      object: 'nav',
      severity: 'P0',
      prototype: { label: labelEvidence(navPrototype, index) },
      actual: null,
      message: `侧栏缺少主导航「${labelEvidence(navPrototype, index)}」`,
      suggestion: '恢复导航项或把原型分组调整写回设计'
    })
  )
  nav.extra.forEach((index) =>
    add({
      role,
      surface,
      class: 'layout',
      kind: 'extra',
      object: 'nav',
      severity: 'P1',
      prototype: null,
      actual: { label: labelEvidence(navActual, index) },
      message: `实际侧新增导航「${labelEvidence(navActual, index)}」`,
      suggestion: '确认新增量已同步到设计'
    })
  )
  if (nav.reordered) {
    add({
      role,
      surface,
      class: 'layout',
      kind: 'reordered',
      object: 'nav',
      severity: 'P2',
      prototype: p.nav.map((item) => item.label),
      actual: a.nav.map((item) => item.label),
      message: '侧栏导航顺序与原型不一致',
      suggestion: '按原型顺序调整导航'
    })
  }

  const sections = compareOrdered(
    p.sections.map((item) => item.label),
    a.sections.map((item) => item.label)
  )
  sections.missing.forEach((index) =>
    add({
      role,
      surface,
      class: 'layout',
      kind: 'missing',
      object: 'section',
      severity: 'P1',
      prototype: { label: labelEvidence(p.sections, index) },
      actual: null,
      message: `页面区块「${labelEvidence(p.sections, index)}」在实际侧缺失`,
      suggestion: '补齐区块或更新原型'
    })
  )
  sections.extra.forEach((index) =>
    add({
      role,
      surface,
      class: 'layout',
      kind: 'extra',
      object: 'section',
      severity: 'P1',
      prototype: null,
      actual: { label: labelEvidence(a.sections, index) },
      message: `实际侧新增区块「${labelEvidence(a.sections, index)}」`,
      suggestion: '确认新增区块是否已进入设计'
    })
  )
  if (sections.reordered) {
    add({
      role,
      surface,
      class: 'layout',
      kind: 'reordered',
      object: 'section',
      severity: 'P2',
      prototype: p.sections.map((item) => item.label),
      actual: a.sections.map((item) => item.label),
      message: '页面区块顺序与原型不一致',
      suggestion: '按原型顺序调整区块'
    })
  }

  compareStats({ add, role, surface, p, a })
  compareTables({ add, role, surface, p, a })
  compareWorkspace({ add, role, surface, p, a })
}

function compareStats({ add, role, surface, p, a }) {
  const match = matchLabels(
    p.stats.map((stat) => stat.label),
    a.stats.map((stat) => stat.label)
  )
  const pairedPrototype = new Set()
  const pairedActual = new Set()
  for (const pair of match.pairs) {
    pairedPrototype.add(pair.prototypeIndex)
    pairedActual.add(pair.actualIndex)
    if (pair.via === 'exact') {continue}
    add({
      role,
      surface,
      class: 'layout',
      kind: 'renamed',
      object: 'stat',
      severity: 'P2',
      prototype: { label: labelEvidence(p.stats, pair.prototypeIndex) },
      actual: { label: labelEvidence(a.stats, pair.actualIndex) },
      message: `统计卡换名「${labelEvidence(p.stats, pair.prototypeIndex)}」→「${labelEvidence(
        a.stats,
        pair.actualIndex
      )}」`,
      suggestion: '统一统计卡业务口径与文案'
    })
  }
  const leftoverPrototype = p.stats
    .map((_, index) => index)
    .filter((index) => !pairedPrototype.has(index))
  const leftoverActual = a.stats
    .map((_, index) => index)
    .filter((index) => !pairedActual.has(index))
  if (leftoverPrototype.length && leftoverPrototype.length === leftoverActual.length) {
    leftoverPrototype.forEach((prototypeIndex, offset) => {
      const actualIndex = leftoverActual[offset]
      add({
        role,
        surface,
        class: 'layout',
        kind: 'renamed',
        object: 'stat',
        severity: 'P2',
        prototype: {
          label: labelEvidence(p.stats, prototypeIndex),
          valueShape: p.stats[prototypeIndex].valueShape
        },
        actual: {
          label: labelEvidence(a.stats, actualIndex),
          valueShape: a.stats[actualIndex].valueShape
        },
        message: `统计卡换名「${labelEvidence(p.stats, prototypeIndex)}」→「${labelEvidence(
          a.stats,
          actualIndex
        )}」`,
        suggestion: '统一统计卡业务口径与文案'
      })
    })
    return
  }
  leftoverPrototype.forEach((index) =>
    add({
      role,
      surface,
      class: 'layout',
      kind: 'missing',
      object: 'stat',
      severity: 'P1',
      prototype: { label: labelEvidence(p.stats, index) },
      actual: null,
      message: `统计卡「${labelEvidence(p.stats, index)}」在实际侧缺失`,
      suggestion: '补齐统计卡或更新设计'
    })
  )
  leftoverActual.forEach((index) =>
    add({
      role,
      surface,
      class: 'layout',
      kind: 'extra',
      object: 'stat',
      severity: 'P1',
      prototype: null,
      actual: { label: labelEvidence(a.stats, index) },
      message: `实际侧新增统计卡「${labelEvidence(a.stats, index)}」`,
      suggestion: '确认新增指标是否已进入设计'
    })
  )
}

function compareTables({ add, role, surface, p, a }) {
  if (!p.tables.length && !a.tables.length) {return}
  const names = matchLabels(
    p.tables.map((table) => table.name),
    a.tables.map((table) => table.name)
  )
  const pairedActual = new Set(names.pairs.map((pair) => pair.actualIndex))
  const pairs = [...names.pairs]
  names.missing.forEach((prototypeIndex) => {
    const fallback = a.tables.findIndex((_, index) => !pairedActual.has(index))
    if (fallback !== -1) {
      pairedActual.add(fallback)
      pairs.push({ prototypeIndex, actualIndex: fallback, via: 'position' })
      return
    }
    add({
      role,
      surface,
      class: 'layout',
      kind: 'missing',
      object: 'table',
      severity: 'P1',
      prototype: { name: labelEvidence(p.tables, prototypeIndex) },
      actual: null,
      message: `表格「${labelEvidence(p.tables, prototypeIndex)}」在实际侧缺失`,
      suggestion: '补齐表格或更新设计'
    })
  })
  pairs.forEach((pair) => {
    const prototypeTable = p.tables[pair.prototypeIndex]
    const actualTable = a.tables[pair.actualIndex]
    if (!prototypeTable || !actualTable) {return}
    if (pair.via !== 'exact') {
      add({
        role,
        surface,
        class: 'layout',
        kind: 'renamed',
        object: 'table',
        severity: 'P2',
        prototype: { name: prototypeTable.name },
        actual: { name: actualTable.name },
        message: `表格换名「${prototypeTable.name}」→「${actualTable.name}」`,
        suggestion: '统一表格标题'
      })
    }
    const columns = compareOrdered(prototypeTable.columns, actualTable.columns)
    columns.missing.forEach((index) =>
      add({
        role,
        surface,
        class: 'layout',
        kind: 'missing',
        object: 'table-column',
        severity: 'P1',
        prototype: {
          table: prototypeTable.name,
          column: prototypeTable.columns[index]
        },
        actual: { table: actualTable.name, columns: actualTable.columns },
        message: `表格「${prototypeTable.name}」缺少列「${prototypeTable.columns[index]}」`,
        suggestion: '补齐列或更新原型列定义'
      })
    )
    columns.extra.forEach((index) =>
      add({
        role,
        surface,
        class: 'layout',
        kind: 'extra',
        object: 'table-column',
        severity: 'P1',
        prototype: { table: prototypeTable.name, columns: prototypeTable.columns },
        actual: { table: actualTable.name, column: actualTable.columns[index] },
        message: `表格「${actualTable.name}」新增列「${actualTable.columns[index]}」`,
        suggestion: '确认新增列是否已进入设计'
      })
    )
    if (columns.reordered) {
      add({
        role,
        surface,
        class: 'layout',
        kind: 'reordered',
        object: 'table-column',
        severity: 'P2',
        prototype: { table: prototypeTable.name, columns: prototypeTable.columns },
        actual: { table: actualTable.name, columns: actualTable.columns },
        message: `表格「${prototypeTable.name}」列顺序与原型不一致`,
        suggestion: '按原型顺序调整列'
      })
    }
  })
}


function compareWorkspace({ add, role, surface, p, a }) {
  if (surface !== 'workspace') {return}
  const prototypeIframe = p.frames.some((frame) => /cloud-admin|iframe/.test(frame.src))
  const actualFrame = a.frames.find((frame) => /cloud-admin/.test(frame.src))
  if (!prototypeIframe && actualFrame) {
    const overlayDialog = a.dialogs.find((dialog) =>
      /工作区|workspace|payment|order|risk|settlement/i.test(dialog.name)
    )
    add({
      role,
      surface,
      class: 'layout',
      kind: 'layout_drift',
      object: 'workspace',
      severity: 'P1',
      prototype: {
        route: 'full IDE route (#/project/:id)',
        frames: p.frames.map((frame) => frame.src),
        dialogs: p.dialogs.map((dialog) => dialog.name)
      },
      actual: {
        route: 'same-page overlay + iframe',
        frames: a.frames.map((frame) => frame.src),
        dialogs: a.dialogs.map((dialog) => dialog.name),
        overlayDialog: overlayDialog?.name ?? null
      },
      message:
        'P3 项目视图结构变化：原型为完整 IDE 路由（无 iframe），实际为同页 overlay + cloud-admin.html iframe',
      suggestion: '对照时以实际 overlay + iframe 为准；工作区内部控件需进入 iframe 清点'
    })
  }
}


export { compareSurface as compareLayoutSurface }
