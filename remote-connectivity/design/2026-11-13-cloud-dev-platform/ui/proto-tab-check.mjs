#!/usr/bin/env node
/**
 * U67 prototype tab regression: host drawer, project dialog, mobile project sheet.
 * Run: node ui/proto-tab-check.mjs   (exit 0 = all pass, 1 = failures; screenshots
 * only refresh when every assertion passes)
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const UI_DIR = import.meta.dirname
const SHOT_DIR = join(UI_DIR, 'screenshots')
const fileUrl = (name) => pathToFileURL(join(UI_DIR, name)).href

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail })
}

const shots = []
const shoot = async (page, name, aliases = []) => {
  shots.push({ names: [name, ...aliases], buffer: await page.screenshot() })
}

const browser = await chromium.launch({ headless: true })
let fatal = null
try {
  await runDesktop()
  await runMobile()
} catch (error) {
  fatal = error
} finally {
  await browser.close()
}

async function runDesktop() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push(`console: ${m.text()}`)
    }
  })
  await page.goto(fileUrl('prototype.html'))
  await page.fill('#loginAccount', 'zhangwei')
  await page.fill('#loginPassword', 'demo-pass')
  await page.click('#loginSubmit')
  await page.waitForSelector('#appShell:not([hidden])', { timeout: 5000 })

  /* ---------- host drawer ---------- */
  await page.evaluate(() => {
    location.hash = '#/hosts'
  })
  await page.waitForTimeout(400)
  await page.locator('[data-page="hosts"] [data-host-open]').first().click()
  await page.waitForSelector('#hostDrawerLayer:not([hidden])')

  const hostSnap = () =>
    page.evaluate(() => {
      const layer = document.querySelector('#hostDrawerLayer')
      const body = layer.querySelector('.drawer-body')
      const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight)
      return {
        activeTabs: [...layer.querySelectorAll('.detail-tab')]
          .filter((t) => t.classList.contains('is-active'))
          .map((t) => t.dataset.detailTab),
        panels: [...layer.querySelectorAll('.detail-panel')].map((p) => ({
          key: p.dataset.detailPanel,
          hidden: p.hidden,
          visible: isVisible(p)
        })),
        cards: [...layer.querySelectorAll('.perm-card[data-host-card]')].map((c) => ({
          key: c.dataset.hostCard,
          title: c.querySelector('.perm-card-title').textContent.trim(),
          count: Number(
            (c.querySelector('[data-card-count]')?.textContent ?? '').match(/\d+/)?.[0]
          ),
          chips: c.querySelectorAll('[data-card-chips] .perm-chip').length,
          cardVisible: isVisible(c),
          firstCardTop: c.getBoundingClientRect().top
        })),
        cardKeys: [
          ...new Set(
            [...layer.querySelectorAll('.perm-card[data-host-card]')].map((c) => c.dataset.hostCard)
          )
        ],
        scrollTop: body.scrollTop,
        scrollMax: body.scrollHeight - body.clientHeight
      }
    })

  const hostInitial = await hostSnap()
  check(
    'host: initial tab is info',
    JSON.stringify(hostInitial.activeTabs) === '["info"]',
    JSON.stringify(hostInitial.activeTabs)
  )
  check(
    'host: initial info panel visible, perm hidden',
    hostInitial.panels.some((p) => p.key === 'info' && !p.hidden && p.visible) &&
      hostInitial.panels.some((p) => p.key === 'perm' && p.hidden && !p.visible),
    JSON.stringify(hostInitial.panels)
  )
  check(
    'host: initial only one panel visible',
    hostInitial.panels.filter((p) => p.visible).length === 1,
    JSON.stringify(hostInitial.panels)
  )

  await page.evaluate(() => {
    const body = document.querySelector('#hostDrawerLayer .drawer-body')
    body.scrollTop = body.scrollHeight
  })
  const hostScrolled = await hostSnap()
  // The tab sits above the scrolled content, so reaching it scrolls the body up first.
  await page.click('#hostDrawerLayer [data-detail-tab="perm"]')
  const hostPerm = await hostSnap()

  check(
    'host: perm tab active after click',
    JSON.stringify(hostPerm.activeTabs) === '["perm"]',
    JSON.stringify(hostPerm.activeTabs)
  )
  check(
    'host: perm panel visible, info hidden',
    hostPerm.panels.some((p) => p.key === 'perm' && !p.hidden && p.visible) &&
      hostPerm.panels.some((p) => p.key === 'info' && p.hidden && !p.visible),
    JSON.stringify(hostPerm.panels)
  )
  check(
    'host: only one panel visible after switch',
    hostPerm.panels.filter((p) => p.visible).length === 1,
    JSON.stringify(hostPerm.panels)
  )
  check(
    'host: scroll resets to top after switching from scrolled info',
    hostScrolled.scrollTop > 0 && hostPerm.scrollTop === 0,
    `before=${hostScrolled.scrollTop} after=${hostPerm.scrollTop}`
  )
  check(
    'host: first perm card in view after switch',
    hostPerm.cards.length > 0 &&
      hostPerm.cards[0].cardVisible &&
      hostPerm.cards[0].firstCardTop > 0 &&
      hostPerm.cards[0].firstCardTop < 900,
    JSON.stringify(hostPerm.cards[0])
  )
  check(
    'host: three cards in view/ops/admin order',
    JSON.stringify(hostPerm.cards.map((c) => c.key)) === '["view","ops","admin"]',
    JSON.stringify(hostPerm.cards.map((c) => c.key))
  )
  check(
    'host: card titles are 查看/控制/管理',
    JSON.stringify(hostPerm.cards.map((c) => c.title)) === '["查看","控制","管理"]',
    JSON.stringify(hostPerm.cards.map((c) => c.title))
  )
  check(
    'host: card counts match rendered chips',
    hostPerm.cards.every((c) => c.count === c.chips),
    JSON.stringify(hostPerm.cards)
  )
  check(
    'host: card keys are unique',
    hostPerm.cardKeys.length === 3,
    JSON.stringify(hostPerm.cardKeys)
  )
  await shoot(page, 'u67-host-perm-clean.png', ['u67-host-drawer-perm-tab-clean.png'])

  await page.click('#hostDrawerLayer [data-detail-tab="info"]')
  const hostBack = await hostSnap()
  check(
    'host: switching back restores info panel',
    hostBack.panels.some((p) => p.key === 'info' && !p.hidden && p.visible) &&
      hostBack.panels.some((p) => p.key === 'perm' && p.hidden && !p.visible),
    JSON.stringify(hostBack.panels)
  )
  check(
    'host: switching back leaves one panel visible',
    hostBack.panels.filter((p) => p.visible).length === 1,
    JSON.stringify(hostBack.panels)
  )
  await page.click('#hostDrawerLayer [data-close-drawer="host"]')

  /* ---------- project dialog ---------- */
  await page.evaluate(() => {
    location.hash = '#/projects'
  })
  await page.waitForTimeout(400)
  await page.locator('[data-page="projects"] [data-project-detail]').first().click()
  await page.waitForSelector('.modal[data-modal="projectDetail"]:not([hidden])')

  const projectSnap = () =>
    page.evaluate(() => {
      const modal = document.querySelector('.modal[data-modal="projectDetail"]')
      const body = modal.querySelector('.modal-body')
      const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight)
      const notice = modal.querySelector('[data-pd-panel="perm"] .notice')
      return {
        activeTabs: [...modal.querySelectorAll('[data-pd-tab]')]
          .filter((t) => t.classList.contains('is-active'))
          .map((t) => t.dataset.pdTab),
        panels: [...modal.querySelectorAll('[data-pd-panel]')].map((p) => ({
          key: p.dataset.pdPanel,
          hidden: p.hidden,
          visible: isVisible(p)
        })),
        cards: [...modal.querySelectorAll('.perm-card[data-project-card]')].map((c) => ({
          key: c.dataset.projectCard,
          title: c.querySelector('.perm-card-title').textContent.trim(),
          count: Number(
            (c.querySelector('[data-card-count]')?.textContent ?? '').match(/\d+/)?.[0]
          ),
          chips: c.querySelectorAll('[data-card-chips] .perm-chip').length,
          derived: c.classList.contains('is-derived'),
          hasAddButton: !!c.querySelector('[data-card-add]')
        })),
        notice: notice ? notice.textContent.replace(/\s+/g, ' ').trim() : '',
        noticeVisible: notice ? isVisible(notice) : false,
        scrollTop: body.scrollTop,
        scrollMax: body.scrollHeight - body.clientHeight,
        firstInfoRowTop: modal
          .querySelector('[data-pd-panel="info"] .detail-row')
          ?.getBoundingClientRect().top
      }
    })

  const projectInitial = await projectSnap()
  check(
    'project: initial tab is info',
    JSON.stringify(projectInitial.activeTabs) === '["info"]',
    JSON.stringify(projectInitial.activeTabs)
  )
  check(
    'project: initial info panel visible, perm hidden',
    projectInitial.panels.some((p) => p.key === 'info' && !p.hidden && p.visible) &&
      projectInitial.panels.some((p) => p.key === 'perm' && p.hidden && !p.visible),
    JSON.stringify(projectInitial.panels)
  )
  check(
    'project: initial only one panel visible',
    projectInitial.panels.filter((p) => p.visible).length === 1,
    JSON.stringify(projectInitial.panels)
  )

  await page.click('.modal[data-modal="projectDetail"] [data-pd-tab="perm"]')
  const projectPerm = await projectSnap()
  check(
    'project: perm tab active after click',
    JSON.stringify(projectPerm.activeTabs) === '["perm"]',
    JSON.stringify(projectPerm.activeTabs)
  )
  check(
    'project: perm panel visible, info hidden',
    projectPerm.panels.some((p) => p.key === 'perm' && !p.hidden && p.visible) &&
      projectPerm.panels.some((p) => p.key === 'info' && p.hidden && !p.visible),
    JSON.stringify(projectPerm.panels)
  )
  check(
    'project: only one panel visible after switch',
    projectPerm.panels.filter((p) => p.visible).length === 1,
    JSON.stringify(projectPerm.panels)
  )
  check(
    'project: three cards in view/ops/admin order',
    JSON.stringify(projectPerm.cards.map((c) => c.key)) === '["view","ops","admin"]',
    JSON.stringify(projectPerm.cards.map((c) => c.key))
  )
  check(
    'project: card titles are 查看/控制/管理',
    JSON.stringify(projectPerm.cards.map((c) => c.title)) === '["查看","控制","管理"]',
    JSON.stringify(projectPerm.cards.map((c) => c.title))
  )
  check(
    'project: admin card is derived and read-only',
    projectPerm.cards.some((c) => c.key === 'admin' && c.derived && !c.hasAddButton),
    JSON.stringify(projectPerm.cards)
  )
  check(
    'project: card counts match rendered chips',
    projectPerm.cards.every((c) => c.count === c.chips),
    JSON.stringify(projectPerm.cards)
  )
  check(
    'project: scope notice visible and scoped to current project',
    projectPerm.noticeVisible &&
      projectPerm.notice.includes('仅影响当前项目') &&
      projectPerm.notice.includes('不扩大到'),
    projectPerm.notice
  )
  await shoot(page, 'u67-project-perm-clean.png', ['u67-project-dialog-perm-tab-clean.png'])

  // Shrink to force a scrollable modal body, then verify tab switch resets scroll.
  await page.setViewportSize({ width: 1440, height: 600 })
  await page.evaluate(() => {
    const body = document.querySelector('.modal[data-modal="projectDetail"] .modal-body')
    body.scrollTop = body.scrollHeight
  })
  const projectScrolled = await projectSnap()
  await page.click('.modal[data-modal="projectDetail"] [data-pd-tab="info"]')
  const projectBack = await projectSnap()
  check(
    'project: scroll resets to top after switching from scrolled perm',
    projectScrolled.scrollTop > 0 && projectBack.scrollTop === 0,
    `before=${projectScrolled.scrollTop} after=${projectBack.scrollTop} max=${projectScrolled.scrollMax}`
  )
  check(
    'project: first info row visible after scroll reset',
    projectBack.firstInfoRowTop !== undefined && projectBack.firstInfoRowTop < 600,
    JSON.stringify(projectBack.firstInfoRowTop)
  )
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.click('.modal[data-modal="projectDetail"] [data-close-modal]')
  await page.locator('[data-page="projects"] [data-project-detail]').first().click()
  const projectReopen = await projectSnap()
  check(
    'project: close/reopen returns to info tab',
    JSON.stringify(projectReopen.activeTabs) === '["info"]' &&
      projectReopen.panels.some((p) => p.key === 'info' && !p.hidden && p.visible),
    JSON.stringify({ tabs: projectReopen.activeTabs, panels: projectReopen.panels })
  )
  check(
    'project: close/reopen leaves one panel visible',
    projectReopen.panels.filter((p) => p.visible).length === 1,
    JSON.stringify(projectReopen.panels)
  )
  await page.click('.modal[data-modal="projectDetail"] [data-close-modal]')

  check('desktop: no page or console errors', errors.length === 0, errors.join(' | '))
  await page.close()
}

async function runMobile() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push(`console: ${m.text()}`)
    }
  })
  await page.goto(fileUrl('prototype-mobile.html'))
  await page.evaluate(() => show('login'))
  await page.fill('#mLoginAccount', 'zhangwei')
  await page.fill('#mLoginPassword', 'demo-pass')
  await page.click('#loginForm button[type="submit"]')
  await page.waitForTimeout(300)
  await page.evaluate(() => show('projects'))
  await page.locator('[data-page="projects"] [data-open-sheet="sheetProject"]').first().click()
  await page.waitForSelector('#sheetProject:not([hidden])')

  const mobileSnap = () =>
    page.evaluate(() => {
      const sheet = document.querySelector('#sheetProject')
      const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight)
      return {
        activeTabs: [...sheet.querySelectorAll('.seg [data-tab]')]
          .filter((b) => b.classList.contains('is-on'))
          .map((b) => b.dataset.tab),
        panes: [...sheet.querySelectorAll('.tabpane')].map((p) => ({
          id: p.id,
          hidden: p.hidden,
          visible: isVisible(p)
        })),
        cards: [...sheet.querySelectorAll('#pPerm .perm-card')].map((c) => ({
          title: c.querySelector('.perm-card-title').textContent.trim(),
          derived: c.classList.contains('is-derived')
        }))
      }
    })

  const mobileInitial = await mobileSnap()
  check(
    'mobile: initial segment is pInfo',
    JSON.stringify(mobileInitial.activeTabs) === '["pInfo"]',
    JSON.stringify(mobileInitial.activeTabs)
  )
  check(
    'mobile: initial pInfo pane visible, pPerm hidden',
    mobileInitial.panes.some((p) => p.id === 'pInfo' && !p.hidden && p.visible) &&
      mobileInitial.panes.some((p) => p.id === 'pPerm' && p.hidden && !p.visible),
    JSON.stringify(mobileInitial.panes)
  )
  check(
    'mobile: initial only one pane visible',
    mobileInitial.panes.filter((p) => p.visible).length === 1,
    JSON.stringify(mobileInitial.panes)
  )

  await page.click('#sheetProject [data-tab="pPerm"]')
  const mobilePerm = await mobileSnap()
  check(
    'mobile: pPerm active after click',
    JSON.stringify(mobilePerm.activeTabs) === '["pPerm"]',
    JSON.stringify(mobilePerm.activeTabs)
  )
  check(
    'mobile: pPerm pane visible, pInfo hidden',
    mobilePerm.panes.some((p) => p.id === 'pPerm' && !p.hidden && p.visible) &&
      mobilePerm.panes.some((p) => p.id === 'pInfo' && p.hidden && !p.visible),
    JSON.stringify(mobilePerm.panes)
  )
  check(
    'mobile: only one pane visible after switch',
    mobilePerm.panes.filter((p) => p.visible).length === 1,
    JSON.stringify(mobilePerm.panes)
  )
  check(
    'mobile: three cards titled 查看/控制/管理',
    JSON.stringify(mobilePerm.cards.map((c) => c.title)) === '["查看","控制","管理"]',
    JSON.stringify(mobilePerm.cards.map((c) => c.title))
  )
  check(
    'mobile: admin card is derived read-only',
    mobilePerm.cards.length === 3 &&
      mobilePerm.cards[2].title === '管理' &&
      mobilePerm.cards[2].derived,
    JSON.stringify(mobilePerm.cards)
  )
  await shoot(page, 'u67-mobile-project-perm-clean.png')

  check('mobile: no page errors', errors.length === 0, errors.join(' | '))
  await page.close()
}

if (fatal) {
  check('script completed without exception', false, String(fatal.stack || fatal))
}
const failures = results.filter((r) => !r.pass)

for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`)
}

if (failures.length === 0 && !fatal) {
  mkdirSync(SHOT_DIR, { recursive: true })
  for (const shot of shots) {
    for (const name of shot.names) {
      writeFileSync(join(SHOT_DIR, name), shot.buffer)
    }
  }
  console.log(`screenshots: ${shots.map((s) => s.names[0]).join(', ')}`)
} else if (shots.length) {
  console.log('screenshots: skipped (assertions failed, stale files left untouched)')
}

console.log(
  `TOTAL ${results.length} PASS ${results.length - failures.length} FAIL ${failures.length}`
)
if (failures.length) {
  console.log('FAILED:')
  for (const f of failures) {
    console.log(`  - ${f.name}${f.detail ? ` :: ${f.detail}` : ''}`)
  }
}
process.exit(failures.length ? 1 : 0)
