/**
 * Extraction-first helpers for the layer-1 `ui` wrapper (exploratory-testing-method
 * §9b): pull region text/state/tables and assert, instead of screenshotting.
 * Attached by ui-extensions.mjs so server injection and standalone journeys share
 * one namespace. Every helper is a thin Playwright wrapper; `page` remains the
 * escape hatch.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const fragment = (text, max = 1200) =>
  String(text ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .slice(0, max)

function slug(value) {
  return (
    String(value)
      .replace(/[^\w.-]+/g, '-')
      .slice(0, 80) || 'current'
  )
}

/** Status vocabulary the platform renders as text (badges, cells, hints). */
const STATE_GROUPS = {
  ready: ['就绪'],
  preparing: ['准备中'],
  failed: ['准备失败', '失败'],
  online: ['在线'],
  offline: ['离线', '主机离线'],
  maintenance: ['维护中'],
  revoked: ['已吊销'],
  archived: ['已归档'],
  dirty: ['未保存'],
  saved: ['已保存'],
  denied: ['禁止下载', '已禁用', '禁止'],
  allowed: ['允许下载', '允许']
}

/** `dt/dd` pairs from a dialog, drawer or page root. */
export const collectKv = (root) =>
  root.evaluate((rootEl) => {
    const out = []
    for (const dl of rootEl.querySelectorAll('dl.kv, dl')) {
      const section =
        dl.closest('.detail-section')?.querySelector('h1,h2,h3,p')?.innerText?.trim() ?? ''
      for (const dt of dl.querySelectorAll('dt')) {
        const dd = dt.nextElementSibling
        if (dd?.tagName !== 'DD') {
          continue
        }
        out.push({
          section,
          label: dt.innerText.trim(),
          value: dd.innerText.trim().replace(/\s+/g, ' ').slice(0, 500)
        })
      }
    }
    return out.slice(0, 120)
  })

export function attachExtraction(ui, { page, evidenceDir, targetLocator, step }) {
  /**
   * Structured text for one scope — whole page or a region.
   * @example
   * const pageText = await ui.extractText()
   * const dialogText = await ui.extractText('.dialog .body')
   * const detail = await ui.extractText('.dialog', '.detail-section')
   * detail.text.includes('项目状态') // status words are directly assertable
   */
  async function extractText(scope, selector) {
    return step(`extractText:${scope ?? 'body'}`, async () => {
      let root = scope === undefined ? page.locator('body') : targetLocator(page, scope).first()
      if (selector) {
        root = root.locator(selector).first()
      }
      const text = fragment(await root.innerText(), 100000)
      const sections = await root.evaluate((rootEl) => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }
        const clean = (value) => (value ?? '').replace(/[ \t]+\n/g, '\n').trim()
        const candidates = rootEl.matches('.dialog, .drawer, .card, .stat, .detail-section')
          ? [rootEl]
          : [
              ...rootEl.querySelectorAll(
                '.stat, .project-card, .card, .detail-section, .dialog .body, .drawer .body, .section-head, .table-wrap, table'
              )
            ]
        const sections = []
        const seen = new Set()
        for (const el of candidates) {
          if (sections.length >= 60 || seen.has(el) || !visible(el)) {
            continue
          }
          const body = clean(el.innerText)
          if (!body) {
            continue
          }
          seen.add(el)
          const label = clean(
            el.querySelector('h1,h2,h3,.stat-label,dt,th,caption')?.innerText ?? ''
          )
          sections.push({
            kind: (el.className || el.tagName).toString().trim().split(/\s+/)[0],
            label: label.slice(0, 120),
            text: body.slice(0, 1600)
          })
        }
        return sections
      })
      return {
        scope: scope ?? 'body',
        selector: selector ?? null,
        text,
        sections,
        kv: await collectKv(root)
      }
    })
  }

  /**
   * Page block tree, navigation and grid rectangles (prototype-comparison input).
   * Passing pageId navigates there first via `navigateMenu`.
   * @example
   * const layout = await ui.extractLayout('workbench')
   * layout.nav.map((item) => item.label) // ['工作台', '我的项目', ...]
   * layout.blocks.filter((b) => b.kind === 'card').length
   */
  async function extractLayout(pageId) {
    return step(`extractLayout:${pageId ?? 'current'}`, async () => {
      if (pageId) {
        await ui.navigateMenu(pageId)
      }
      return page.evaluate(() => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        }
        const labelOf = (el) =>
          (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120)
        const rectOf = (el) => {
          const rect = el.getBoundingClientRect()
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        }
        const nav = [...document.querySelectorAll('.nav-item, .nav-group')]
          .filter(visible)
          .map((el, order) => {
            const isGroup = el.classList.contains('nav-group')
            const group =
              (isGroup
                ? el.querySelector('.nav-label')
                : el.closest('.nav-group')?.querySelector('.nav-label')
              )?.innerText?.trim() ?? null
            return {
              label: isGroup ? (group ?? '') : labelOf(el),
              route: el.getAttribute('data-route') ?? null,
              group,
              active: el.classList.contains('active'),
              order,
              rect: rectOf(el)
            }
          })
        const selectors = [
          '.page-head',
          '.grid-4',
          '.grid-3',
          '.section-head',
          '.card',
          '.table-wrap',
          '.dialog',
          '.drawer',
          '.workspace-overlay',
          '#content'
        ]
        const blocks = [...document.querySelectorAll(selectors.join(','))]
          .filter(visible)
          .slice(0, 120)
          .map((el, order) => ({
            kind: (el.className || el.tagName).toString().trim().split(/\s+/)[0],
            label: labelOf(el.querySelector('h1,h2,h3') ?? el),
            testid: el.getAttribute('data-testid'),
            order,
            rect: rectOf(el)
          }))
        return {
          route: document.querySelector('#crumbs')?.innerText?.trim() ?? null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          nav,
          blocks
        }
      })
    })
  }

  /**
   * Aggregate business state words, badges, counts and stat cards from visible text.
   * @example
   * const state = await ui.extractState()
   * state.states.find((s) => s.group === 'maintenance')?.count
   * state.stats.map((s) => `${s.label}=${s.value}`)
   */
  async function extractState() {
    return step('extractState', async () =>
      page.evaluate((groups) => {
        const text = document.body.innerText
        const lines = text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        const states = Object.entries(groups)
          .map(([group, words]) => {
            const samples = lines.filter((line) => words.some((word) => line.includes(word)))
            return { group, words, count: samples.length, samples: samples.slice(0, 5) }
          })
          .filter((entry) => entry.count > 0)
        const visible = (el) => {
          const rect = el.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }
        const badges = [
          ...document.querySelectorAll(
            '[class*="badge"], .dot.online, .dot.offline, .role-chip, [data-workspace-dirty], [data-unsaved]'
          )
        ]
          .filter((el) => visible(el) && !el.hidden)
          .map((el) => ({
            text: el.innerText?.trim().slice(0, 80) ?? '',
            classes: el.className?.toString().trim() ?? '',
            testid: el.getAttribute('data-testid')
          }))
          .filter((badge) => badge.text)
          .slice(0, 120)
        const counts = [
          ...text.matchAll(
            /(\d+)\s*(个未保存文件|个可访问项目|个未保存|条|项|个(?:项目|在线|跳转|失败|成功)?)/g
          )
        ]
          .map((match) => ({ value: Number(match[1]), unit: match[2] }))
          .slice(0, 80)
        const stats = [...document.querySelectorAll('.stat')].filter(visible).map((el) => ({
          label: el.querySelector('.stat-label')?.innerText?.trim() ?? '',
          value: el.querySelector('.stat-value')?.innerText?.trim() ?? '',
          hint: el.querySelector('.stat-hint')?.innerText?.trim() ?? ''
        }))
        return { states, badges, counts, stats }
      }, STATE_GROUPS)
    )
  }

  /**
   * Tables as columns + rows. Defaults to every visible table.
   * @example
   * const [projects] = await ui.extractTable('#content table')
   * projects.columns // ['项目', '仓库', '主机', '可见范围', '状态', '操作']
   * projects.rows[0].cells[0] // first project name
   */
  async function extractTable(selector) {
    return step(`extractTable:${selector ?? 'all'}`, async () => {
      const locator = selector ? targetLocator(page, selector) : page.locator('table')
      return locator.evaluateAll((tables) => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }
        return tables
          .filter(visible)
          .slice(0, 8)
          .map((table) => {
            const heading =
              table.closest('.table-wrap')?.previousElementSibling?.querySelector?.('h1,h2,h3')
                ?.innerText ??
              table.closest('section, .detail-section')?.querySelector?.('h1,h2,h3')?.innerText ??
              table.querySelector('caption')?.innerText ??
              ''
            return {
              name: heading.trim().slice(0, 120),
              testid: table.getAttribute('data-testid'),
              columns: [...table.querySelectorAll('thead th')].map((th) => th.innerText.trim()),
              rowCount: table.querySelectorAll('tbody tr').length,
              rows: [...table.querySelectorAll('tbody tr')].slice(0, 100).map((tr) => ({
                cells: [...tr.querySelectorAll('td')].map((td) =>
                  td.innerText.replace(/\s+/g, ' ').trim().slice(0, 300)
                ),
                testid: tr.getAttribute('data-testid')
              }))
            }
          })
      })
    })
  }

  /**
   * Wait until visible text contains `text`; returns the matching line.
   * @example await ui.waitForState('就绪')
   */
  async function waitForState(text, opts = {}) {
    return step(`waitForState:${text}`, async () => {
      const timeout = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000
      await page.waitForFunction((needle) => document.body.innerText.includes(needle), text, {
        timeout
      })
      const line = await page.evaluate(
        (needle) => document.body.innerText.split('\n').find((row) => row.includes(needle)) ?? '',
        text
      )
      return { found: text, line: line.trim() }
    })
  }

  /**
   * Control inventory by role + label: buttons, inputs, links, tables, tabs.
   * @example
   * const inventory = await ui.discover()
   * inventory.controls.tables[0].columns
   * inventory.controls.buttons.map((b) => b.label)
   */
  async function discover() {
    return step('discover', async () =>
      page.evaluate(() => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        }
        const labelOf = (el) =>
          (
            el.getAttribute('aria-label') ||
            el.innerText ||
            el.value ||
            el.getAttribute('title') ||
            el.getAttribute('placeholder') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120)
        const labelledBy = (el) => {
          if (el.id) {
            const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
            if (label) {
              return label.innerText.trim()
            }
          }
          return el.closest('label')?.innerText?.trim() ?? ''
        }
        const buttons = [
          ...document.querySelectorAll(
            'button, [role="button"], input[type="submit"], input[type="button"]'
          )
        ]
          .filter(visible)
          .slice(0, 150)
          .map((el) => ({
            label: labelOf(el),
            role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
            testid: el.getAttribute('data-testid'),
            disabled: Boolean(el.disabled),
            title: el.getAttribute('title')
          }))
          .filter((entry) => entry.label)
        const inputs = [
          ...document.querySelectorAll('input:not([type="hidden"]), select, textarea')
        ]
          .filter(visible)
          .slice(0, 150)
          .map((el) => ({
            label: (
              el.getAttribute('aria-label') ||
              labelledBy(el) ||
              el.getAttribute('placeholder') ||
              el.name ||
              el.id ||
              ''
            )
              .trim()
              .slice(0, 120),
            name: el.name || el.id || el.getAttribute('data-testid'),
            type: el.tagName === 'SELECT' ? 'select' : el.type || el.tagName.toLowerCase(),
            required: Boolean(el.required),
            disabled: Boolean(el.disabled),
            readonly: Boolean(el.readOnly),
            placeholder: el.getAttribute('placeholder'),
            value: el.tagName === 'SELECT' ? el.value : undefined,
            options:
              el.tagName === 'SELECT'
                ? [...el.options].map((option) => ({
                    label: option.text.trim(),
                    value: option.value
                  }))
                : undefined
          }))
        const links = [...document.querySelectorAll('a[href]')]
          .filter(visible)
          .slice(0, 100)
          .map((el) => ({
            label: labelOf(el),
            href: el.getAttribute('href'),
            target: el.getAttribute('target')
          }))
          .filter((entry) => entry.label)
        const tabs = [...document.querySelectorAll('[role="tab"]')]
          .filter(visible)
          .slice(0, 100)
          .map((el) => ({
            label: labelOf(el),
            testid: el.getAttribute('data-testid'),
            selected: el.getAttribute('aria-selected') === 'true'
          }))
        const tables = [...document.querySelectorAll('table')]
          .filter(visible)
          .slice(0, 12)
          .map((table) => ({
            columns: [...table.querySelectorAll('thead th')].map((th) => th.innerText.trim()),
            rowCount: table.querySelectorAll('tbody tr').length,
            testid: table.getAttribute('data-testid'),
            className: table.className
          }))
        return {
          url: location.href,
          title: document.title,
          route: document.querySelector('#crumbs')?.innerText?.trim() ?? null,
          controls: { buttons, inputs, links, tables, tabs }
        }
      })
    )
  }

  /**
   * Prototype-diff hook. PS-4 is not implemented yet, so this captures the same
   * DOM inventory shape a diff will consume and writes it to the evidence dir.
   * @example
   * const parity = await ui.compareWithPrototype('workbench')
   * parity.status // 'not-implemented'; parity.inventoryFile is the captured JSON
   */
  async function compareWithPrototype(pageId = 'current') {
    return step(`compareWithPrototype:${pageId}`, async () => {
      const inventory = await discover()
      mkdirSync(evidenceDir, { recursive: true })
      const file = path.join(evidenceDir, `prototype-compare-${slug(pageId)}.json`)
      writeFileSync(
        file,
        JSON.stringify(
          { pageId, capturedAt: new Date().toISOString(), prototypeRoute: pageId, inventory },
          null,
          2
        )
      )
      return {
        status: 'not-implemented',
        pageId,
        inventoryFile: file,
        next: 'PS-4 wires this inventory into prototype.html extraction and diff',
        inventory
      }
    })
  }

  Object.assign(ui, {
    extractText,
    extractLayout,
    extractState,
    extractTable,
    waitForState,
    discover,
    compareWithPrototype
  })
  return ui
}
