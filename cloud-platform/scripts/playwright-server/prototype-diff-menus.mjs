/** Menu class: sidebar titles, actions, context menus and dialog/drawer buttons. */
import { matchLabels, normalizeLabel } from './prototype-diff-core.mjs'

function collectOverlay(side, key) {
  const seen = new Set()
  const out = []
  for (const surface of Object.values(side.surfaces)) {
    for (const item of surface[key] ?? []) {
      const name = normalizeLabel(item.name)
      if (seen.has(name)) {
        continue
      }
      seen.add(name)
      out.push(item)
    }
  }
  return out
}

function compareNavTitles({ add, role, prototype, actual }) {
  const prototypeSurface =
    prototype.surfaces.workbench ??
    Object.values(prototype.surfaces).find((surface) => surface.nav.length)
  const actualSurface =
    actual.surfaces.workbench ??
    Object.values(actual.surfaces).find((surface) => surface.nav.length)
  if (!prototypeSurface || !actualSurface) {
    return
  }
  for (const prototypeItem of prototypeSurface.nav) {
    if (!prototypeItem.route) {
      continue
    }
    const actualItem = actualSurface.nav.find((item) => item.route === prototypeItem.route)
    if (!actualItem) {
      continue
    }
    if (normalizeLabel(prototypeItem.label) !== normalizeLabel(actualItem.label)) {
      add({
        role,
        surface: 'nav',
        class: 'menu',
        kind: 'renamed',
        object: 'sidebar',
        severity: 'P2',
        prototype: { label: prototypeItem.label, route: prototypeItem.route },
        actual: { label: actualItem.label, route: actualItem.route },
        message: `侧栏项换名「${prototypeItem.label}」→「${actualItem.label}」`,
        suggestion: '别名表已记录，确认产品命名'
      })
    }
    const prototypeInventory = prototype.surfaces[prototypeItem.route]
    const actualInventory = actual.surfaces[prototypeItem.route]
    if (!prototypeInventory || !actualInventory) {
      continue
    }
    const prototypeTitle = normalizeLabel(prototypeInventory.title)
    const actualTitle = normalizeLabel(actualInventory.title)
    if (prototypeTitle && actualTitle && prototypeTitle !== actualTitle) {
      add({
        role,
        surface: prototypeItem.route,
        class: 'menu',
        kind: 'renamed',
        object: 'nav-title',
        severity: 'P2',
        prototype: { label: prototypeItem.label, title: prototypeInventory.title },
        actual: { label: actualItem.label, title: actualInventory.title },
        message: `导航「${prototypeItem.label}」页标题「${prototypeInventory.title}」→「${actualInventory.title}」`,
        suggestion: '确认页面标题口径；原型仍是旧命名时更新原型'
      })
    }
  }
}

function compareOverlays({ add, role, prototype, actual }) {
  compareOverlayKind({
    add,
    role,
    kind: 'dialog',
    prototypeItems: collectOverlay(prototype, 'dialogs'),
    actualItems: collectOverlay(actual, 'dialogs'),
    severity: 'P2'
  })
  compareOverlayKind({
    add,
    role,
    kind: 'drawer',
    prototypeItems: collectOverlay(prototype, 'drawers'),
    actualItems: collectOverlay(actual, 'drawers'),
    severity: 'P2'
  })
  compareOverlayKind({
    add,
    role,
    kind: 'context-menu',
    prototypeItems: collectOverlay(prototype, 'menus'),
    actualItems: collectOverlay(actual, 'menus'),
    severity: 'P1'
  })
}

function compareOverlayKind({ add, role, kind, prototypeItems, actualItems, severity }) {
  const match = matchLabels(
    prototypeItems.map((item) => item.name),
    actualItems.map((item) => item.name)
  )
  match.missing.forEach((index) =>
    add({
      role,
      surface: 'overlays',
      class: 'menu',
      kind: 'missing',
      object: kind,
      severity,
      prototype: { name: prototypeItems[index].name },
      actual: null,
      message: `${kind}「${prototypeItems[index].name}」在实际侧未清点到`,
      suggestion:
        kind === 'dialog' ? '对照时按需打开该 dialog 或用 aria 快照复核' : '确认该入口是否已移除'
    })
  )
  match.extra.forEach((index) =>
    add({
      role,
      surface: 'overlays',
      class: 'menu',
      kind: 'extra',
      object: kind,
      severity: 'P2',
      prototype: null,
      actual: { name: actualItems[index].name },
      message: `实际侧新增${kind}「${actualItems[index].name}」`,
      suggestion: '确认新增层已进入设计'
    })
  )
  for (const pair of match.pairs) {
    if (pair.via === 'exact') {
      continue
    }
    const prototypeItem = prototypeItems[pair.prototypeIndex]
    const actualItem = actualItems[pair.actualIndex]
    add({
      role,
      surface: 'overlays',
      class: 'menu',
      kind: 'renamed',
      object: kind,
      severity: 'P2',
      prototype: { name: prototypeItem.name },
      actual: { name: actualItem.name },
      message: `${kind}换名「${prototypeItem.name}」→「${actualItem.name}」`,
      suggestion: '统一层标题'
    })
  }
}

export { compareNavTitles, compareOverlays }
