// Supplemental: disambiguate the users status-filter count (empty-state row vs real rows).
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const BASE = 'https://127.0.0.1:18787'
const OUT = path.dirname(new URL(import.meta.url).pathname)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })
const page = await (
  await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } })
).newPage()
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.fill('#username', 'admin')
await page.fill('#password', 'Adm1n!')
await page.click('#loginBtn')
await page.waitForSelector('text=demo-app', { timeout: 30000 })
await page.click('button[data-route="users"]')
await page.waitForSelector('#userSearch')
await sleep(500)

const snap = () =>
  page.evaluate(() => ({
    realRows: [...document.querySelectorAll('#usersBody tr')].filter(
      (tr) => tr.querySelector('td:nth-child(4)') && !tr.querySelector('.table-empty')
    ).length,
    emptyRow: document.querySelectorAll('#usersBody tr .table-empty').length,
    texts: [...document.querySelectorAll('#usersBody tr')].map((tr) =>
      tr.innerText.replace(/\s+/g, ' ').trim()
    )
  }))

const statuses = {}
for (const status of ['active', 'disabled']) {
  await page.selectOption('#userStatusFilter', status)
  await sleep(300)
  statuses[status] = await snap()
}
// restore and verify real rows after reset
await page.click('#userFilterReset')
await sleep(400)
const afterReset = await snap()
const out = { statuses, afterReset }
fs.writeFileSync(path.join(OUT, 'u94-u81b-status-filter.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
await browser.close()
