#!/usr/bin/env node
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
const BASE = 'https://127.0.0.1:18787'
const SHOTS = path.resolve('cloud-platform/evidence/exploratory-r2/screenshots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1600, height: 1000 }
})
const page = await context.newPage()
page.setDefaultTimeout(15000)
page.on('dialog', (d) => {
  console.log('DIALOG', d.message())
  d.accept()
})
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
if (await page.locator('#username').count()) {
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('button:has-text("登录")')
}
await page.waitForSelector('text=demo-app')
const fr = () => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
const t = (id) => fr().locator(`[data-testid="${id}"]:visible`)
await page
  .locator('tr', { hasText: 'demo-app' })
  .getByRole('button', { name: '打开', exact: true })
  .click()
await page.locator('#workspaceOverlay iframe').waitFor()
await sleep(7000)
console.log('frame', !!fr())

for (const file of ['docs/design.md', 'src/webhook.js']) {
  console.log('--- opening', file)
  await t('cloud-simple-workspace-right-tab-files').click()
  console.log(
    'files tab clicked, tree visible?',
    await fr().locator('[data-testid="cloud-workspace-file-tree"]').isVisible()
  )
  const parts = file.split('/')
  for (let i = 0; i < parts.length - 1; i += 1) {
    const cur = parts.slice(0, i + 1).join('/')
    const expanded = await fr().evaluate((p) => {
      const btn = document.querySelector(
        `[data-testid="cloud-workspace-file-tree-node-${CSS.escape(p)}"]`
      )
      const item = btn?.closest('[role="treeitem"]')
      return { found: !!btn, expanded: item?.getAttribute('aria-expanded') }
    }, cur)
    console.log('dir', cur, expanded)
    if (expanded.expanded !== 'true') {
      await fr().evaluate(
        (p) =>
          document
            .querySelector(`[data-testid="cloud-workspace-file-tree-node-${CSS.escape(p)}"]`)
            ?.click(),
        cur
      )
      await sleep(700)
    }
  }
  const node = fr().locator(`[data-testid="cloud-workspace-file-tree-node-${file}"]`)
  console.log('node count', await node.count())
  await node.waitFor()
  await node.click()
  console.log('clicked file')
  await fr().locator('.monaco-editor:visible').first().waitFor({ timeout: 15000 })
  console.log('monaco visible')
  await sleep(600)
  await fr().locator('.monaco-editor:visible .view-lines').first().click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.type('\nr2-dirty-probe', { delay: 1 })
  await sleep(800)
  const dirty = await fr().evaluate(() =>
    [...document.querySelectorAll('[data-testid^="cloud-simple-workspace-tab-dirty-"]')].map((e) =>
      e.getAttribute('data-testid')
    )
  )
  console.log('dirty spans', dirty)
  const tabId = file.startsWith('docs/') ? `file:${file}` : `file:${file}`
  console.log('close button count', await t(`cloud-simple-workspace-tab-close-${tabId}`).count())
  await t(`cloud-simple-workspace-tab-close-${tabId}`).click()
  console.log('close clicked')
  try {
    await t('cloud-simple-workspace-close-confirm').waitFor({ timeout: 5000 })
    console.log(
      'CONFIRM TEXT',
      (await t('cloud-simple-workspace-close-confirm').innerText()).replaceAll('\n', ' | ')
    )
    await page.screenshot({
      path: path.join(SHOTS, `probe-dirty-confirm-${file.replaceAll('/', '_')}.png`)
    })
    await t('cloud-simple-workspace-close-confirm-discard').click()
    await sleep(500)
    console.log('discarded; tab count', await t(`cloud-simple-workspace-tab-${tabId}`).count())
  } catch (e) {
    console.log('NO CONFIRM', e.message.split('\n')[0])
    const body = await fr().evaluate(() => document.body.innerText.slice(0, 400))
    console.log('body', body)
    await page.screenshot({
      path: path.join(SHOTS, `probe-dirty-noconfirm-${file.replaceAll('/', '_')}.png`)
    })
  }
}
await browser.close()
