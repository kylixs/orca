/**
 * One DOM inventory extractor for both sides of a prototype comparison:
 * `prototype.html` (file://) and the running Web app. Identical browser-side
 * code keeps the schema from drifting; the driver only differs in navigation.
 */
import path from 'node:path'

const HERE = import.meta.dirname

export const SURFACES = [
  'login',
  'workbench',
  'projects',
  'hosts',
  'relays',
  'members',
  'audit',
  'settings',
  'diagnostics',
  'forbidden',
  'workspace'
]

export const PROTOTYPE_ROUTES = [
  'workbench',
  'projects',
  'hosts',
  'relays',
  'members',
  'audit',
  'settings',
  'diagnostics'
]

export const ADMIN_ROUTES = new Set(['hosts', 'relays', 'members', 'audit', 'settings'])

/** admin / developer are prototype concepts; the Web maps developer to zhangsan. */
export const DEFAULT_COMPARE_ROLES = [
  { role: 'admin', account: 'admin' },
  { role: 'developer', account: 'zhangsan' }
]

export function defaultPrototypePath() {
  return path.resolve(
    HERE,
    '../../../remote-connectivity/design/2026-11-13-cloud-dev-platform/ui/prototype.html'
  )
}

/**
 * Inventory one page or frame. The function body runs in the browser, so it
 * cannot close over Node values; everything it needs arrives in `options`.
 * @example
 * const inventory = await extractDomInventory(page, { surface: 'workbench' })
 * inventory.tables[0].columns
 */
export async function extractDomInventory(target, options = {}) {
  const payload = {
    surface: options.surface ?? 'current',
    includeHiddenOverlays: options.includeHiddenOverlays ?? true
  }
  return target.evaluate((opts) => {
    const norm = (value) =>
      String(value ?? '')
        .replace(/ /g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    const text = (el) => norm(el?.innerText ?? el?.textContent ?? '')
    const cleanLabel = (el) => {
      if (!el) {
        return ''
      }
      const clone = el.cloneNode(true)
      for (const noise of clone.querySelectorAll('.section-count, .nav-count, .badge, .count')) {
        noise.remove()
      }
      return text(clone)
    }
    const isVisible = (el) => {
      if (!el || el.hidden) {
        return false
      }
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.opacity !== '0'
      )
    }
    const overlayVisible = (el) => opts.includeHiddenOverlays || isVisible(el)
    const uniqBy = (items, keyFn) => {
      const seen = new Set()
      const out = []
      for (const item of items) {
        const key = keyFn(item)
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        out.push(item)
      }
      return out
    }
    const labelOf = (el) =>
      norm(
        el.getAttribute('aria-label') ||
          el.innerText ||
          el.value ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          ''
      )
    const labelFor = (el) => {
      if (el.getAttribute('aria-label')) {
        return norm(el.getAttribute('aria-label'))
      }
      if (el.id) {
        const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id
        const label = document.querySelector(`label[for="${escaped}"]`)
        if (label) {
          return text(label)
        }
      }
      const wrap = el.closest('label')
      if (wrap) {
        return norm(wrap.innerText || wrap.textContent)
      }
      return norm(el.getAttribute('placeholder') || el.name || el.id || '')
    }
    const shapeOf = (value) => {
      const v = norm(value)
      if (!v) {
        return 'empty'
      }
      if (/^[\d,.\s/]+$/.test(v)) {
        return 'number'
      }
      if (/\d/.test(v)) {
        return 'text-with-number'
      }
      return 'text'
    }
    const loginMode =
      opts.surface === 'login' ||
      Boolean(document.querySelector('#loginScreen:not([hidden]), #view-login:not([hidden])'))
    const bodyRoot =
      document.querySelector('#contentArea, #content, main .content, main') ?? document.body
    const visiblePage = [...document.querySelectorAll('[data-page]')].find(
      (el) => !el.hidden && isVisible(el)
    )
    const projectShell = document.querySelector('#projectShell:not([hidden])')
    const scope = loginMode ? document.body : (visiblePage ?? projectShell ?? bodyRoot)

    let title = loginMode
      ? text(document.querySelector('#loginScreen:not([hidden]) h1, #view-login:not([hidden]) h1'))
      : text(scope.querySelector('h1'))
    const overlayTitle = text(document.querySelector('#workspaceOverlay .workspace-title'))
    title = overlayTitle || title
    title = title || norm(document.title.replace(/·.*$/, ''))

    const crumbEl = document.querySelector('#breadcrumbs, #crumbs')
    const crumbParts = crumbEl ? [...crumbEl.querySelectorAll('.crumb')].map(text) : []
    const breadcrumb = crumbParts.length ? crumbParts.join(' / ') : text(crumbEl)

    const navEls = uniqBy(
      [
        ...document.querySelectorAll(
          '.side-nav .nav-item, nav .nav-item, #nav .nav-item, aside.sidebar .nav-item'
        )
      ].filter(isVisible),
      (el) => `${el.dataset.route ?? labelOf(el)}:${labelOf(el)}`
    )
    const groupOf = (el) => {
      let node = el.previousElementSibling
      while (node) {
        if (node.matches('.nav-group-label, .nav-label')) {
          return text(node)
        }
        const inner = node.querySelector?.('.nav-group-label, .nav-label')
        if (inner) {
          return text(inner)
        }
        node = node.previousElementSibling
      }
      return ''
    }
    const nav = navEls.map((el, index) => ({
      label: cleanLabel(el),
      group: groupOf(el),
      route: el.dataset.route ?? null,
      adminOnly:
        el.classList.contains('admin-only') ||
        Boolean(el.closest('#adminNav, .admin-nav, [data-admin-only]')),
      order: index
    }))

    const kindOf = (heading) => {
      if (heading.closest('.stat-grid, .stat-card')) {
        return 'stat'
      }
      if (heading.closest('table, .table-card, .table-wrap')) {
        return 'table-section'
      }
      if (heading.closest('form')) {
        return 'form'
      }
      if (heading.closest('.card, section')) {
        return 'card'
      }
      return 'list'
    }
    const sections = uniqBy(
      [...scope.querySelectorAll('h2, h3')]
        .filter((el) => isVisible(el) && !el.closest('[role="dialog"], .drawer'))
        .map((el, index) => ({ label: cleanLabel(el), kind: kindOf(el), order: index })),
      (entry) => entry.label
    )

    const statCards = [...scope.querySelectorAll('.stat-card, .card.stat, .stat')].filter(
      (el) => isVisible(el) && !el.closest('[role="dialog"], .drawer')
    )
    const stats = uniqBy(
      statCards.map((el) => {
        const valueEl = el.querySelector('.stat-value')
        return {
          label: norm(
            el.querySelector('.stat-label')?.innerText ??
              el.querySelector('.stat-top')?.innerText ??
              el.innerText
          ),
          valueShape: shapeOf(text(valueEl)),
          value: text(valueEl).slice(0, 40)
        }
      }),
      (entry) => entry.label
    )

    const headings = [...scope.querySelectorAll('h1, h2, h3')].filter(
      (el) => isVisible(el) && !el.closest('[role="dialog"], .drawer')
    )
    const nameForTable = (table) => {
      const explicit =
        text(table.getAttribute('aria-label')) || text(table.querySelector('caption'))
      if (explicit) {
        return explicit
      }
      const cardHeading = cleanLabel(table.closest('.card, section')?.querySelector('h1, h2, h3'))
      if (cardHeading) {
        return cardHeading
      }
      const before = headings.filter(
        (heading) => heading.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING
      )
      return before.length ? cleanLabel(before.at(-1)) : ''
    }
    const tables = [...scope.querySelectorAll('table')]
      .filter((el) => isVisible(el) && !el.closest('[role="dialog"], .drawer'))
      .slice(0, 12)
      .map((table) => {
        const rows = [...table.querySelectorAll('tbody tr')]
        return {
          name: nameForTable(table),
          columns: [...table.querySelectorAll('thead th')].map(text),
          rowCount: rows.length,
          sampleRow: rows[0]
            ? [...rows[0].querySelectorAll('td')].map((td) => text(td).slice(0, 60))
            : []
        }
      })

    const fields = [...scope.querySelectorAll('input:not([type="hidden"]), select, textarea')]
      .filter((el) => isVisible(el) && !el.closest('[role="dialog"], .drawer'))
      .slice(0, 150)
      .map((el) => ({
        label: labelFor(el),
        id: el.id || null,
        name: el.getAttribute('name') || null,
        type:
          el.tagName === 'SELECT'
            ? 'select'
            : el.tagName === 'TEXTAREA'
              ? 'textarea'
              : el.getAttribute('type') || 'text',
        required: Boolean(el.required),
        disabled: Boolean(el.disabled),
        readonly: Boolean(el.readOnly),
        placeholder: el.getAttribute('placeholder') || null,
        options:
          el.tagName === 'SELECT' ? [...el.options].map((option) => text(option)) : undefined,
        help:
          norm(
            el
              .closest('.field, label, .form-row')
              ?.querySelector('.hint, .field-help, [data-help], .form-help')?.innerText
          ) || null
      }))

    const actions = [
      ...document.querySelectorAll(
        'button, [role="button"], input[type="submit"], input[type="button"], a.btn'
      )
    ]
      .filter(
        (el) =>
          isVisible(el) &&
          !el.closest(
            '.sidebar, .side-nav, nav.nav, #nav, [role="dialog"], .drawer, .context-menu, .role-demo'
          ) &&
          (loginMode
            ? Boolean(el.closest('#loginScreen, #view-login'))
            : !el.closest('#loginScreen, #view-login'))
      )
      .slice(0, 200)
      .map((el) => ({
        label: labelOf(el),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        disabled:
          Boolean(el.disabled) ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.classList.contains('is-disabled'),
        title: el.getAttribute('title') || null
      }))
      .filter((entry) => entry.label)

    const menuEls = uniqBy(
      [...document.querySelectorAll('[role="menu"], .context-menu')].filter(overlayVisible),
      (el) => el.id || labelOf(el) || 'menu'
    )
    const menus = menuEls.map((menu, index) => ({
      name: norm(menu.getAttribute('aria-label')) || menu.id || `menu-${index}`,
      items: uniqBy(
        [...menu.querySelectorAll('.menu-item, [role="menuitem"], button, a')]
          .map((item) => ({
            label: labelOf(item),
            disabled:
              item.getAttribute('aria-disabled') === 'true' ||
              item.classList.contains('is-disabled') ||
              Boolean(item.disabled),
            danger: item.classList.contains('is-danger')
          }))
          .filter((item) => item.label),
        (item) => item.label
      )
    }))

    const dialogRoots = uniqBy(
      [
        ...document.querySelectorAll(
          '[role="dialog"], .dialog, .modal, .dialog-backdrop > .dialog, .modal-layer > .modal'
        )
      ].filter((el) => !el.parentElement?.closest('[role="dialog"], .dialog, .modal')),
      (el) => el.id || `${el.className}:${labelOf(el).slice(0, 40)}`
    )
    const describeOverlay = (el, index) => ({
      name:
        norm(
          text(
            el.querySelector(
              '.modal-title, .dialog-title, .drawer-title, .workspace-title, h1, h2, h3'
            )
          )
        ) ||
        norm(el.getAttribute('aria-label')) ||
        el.id ||
        `dialog-${index}`,
      title: text(el.querySelector('.modal-title, .dialog-title, .drawer-title, h1, h2, h3')),
      fields: [...el.querySelectorAll('input:not([type="hidden"]), select, textarea')].map(
        (field) => ({
          label: labelFor(field),
          type: field.tagName === 'SELECT' ? 'select' : field.getAttribute('type') || 'text',
          required: Boolean(field.required),
          disabled: Boolean(field.disabled),
          readonly: Boolean(field.readOnly),
          placeholder: field.getAttribute('placeholder') || null
        })
      ),
      buttons: [...el.querySelectorAll('button, [role="button"], a.btn')]
        .map((button) => ({
          label: labelOf(button),
          role: button.getAttribute('role') || button.tagName.toLowerCase(),
          disabled: Boolean(button.disabled),
          danger: button.classList.contains('is-danger')
        }))
        .filter((button) => button.label)
    })
    const drawers = dialogRoots
      .filter((el) => el.matches('.drawer') || el.closest('.drawer-layer'))
      .map(describeOverlay)
    const dialogs = dialogRoots
      .filter((el) => !el.matches('.drawer') && !el.closest('.drawer-layer'))
      .map(describeOverlay)

    const frames = [...document.querySelectorAll('iframe')].map((el) => ({
      kind: 'iframe',
      src: el.getAttribute('src') || el.src || '',
      title: el.getAttribute('title') || el.title || '',
      visible: isVisible(el)
    }))

    const bodyStyle = getComputedStyle(document.body)
    const sidebarEl = document.querySelector('.sidebar, aside.sidebar')
    const contentEl = document.querySelector('#contentArea, #content, main .content, main')
    const cardEl = scope.querySelector('.card, .stat-card')
    const tokens = [
      { role: 'body', fontSize: bodyStyle.fontSize, fontWeight: bodyStyle.fontWeight }
    ]
    if (sidebarEl) {
      tokens.push({
        role: 'sidebar',
        width: Math.round(sidebarEl.getBoundingClientRect().width),
        fontSize: getComputedStyle(sidebarEl).fontSize
      })
    }
    if (contentEl) {
      tokens.push({ role: 'content', padding: getComputedStyle(contentEl).padding })
    }
    if (cardEl) {
      tokens.push({ role: 'card', radius: getComputedStyle(cardEl).borderRadius })
    }

    return {
      surface: opts.surface,
      title,
      breadcrumb,
      nav,
      sections,
      stats,
      tables,
      fields,
      actions,
      menus,
      dialogs,
      drawers,
      frames,
      tokens
    }
  }, payload)
}
