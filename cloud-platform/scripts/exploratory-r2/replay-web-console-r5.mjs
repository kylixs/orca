#!/usr/bin/env node
/**
 * Replay U53②/④ on the admin console: logout must clear credentials, and a
 * duplicate grant must ask before overwriting. Runs against the platform in
 * ORCA_QA_BASE (a fresh instance is required: the long-lived 18787 process
 * pinned its web release at startup).
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE || 'http://127.0.0.1:18790'
const OUT = path.resolve('cloud-platform/evidence/r-fixes-verify')
const SHOTS = path.join(OUT, 'screenshots')
fs.mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(25000)
const puts = []
page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/grants')) puts.push(r.url()) })
page.on('dialog', (d) => d.accept())
const out = { check: 'U53② logout clears credentials · U53④ duplicate grant asks first', base: BASE, steps: {} }
try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor()
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
  out.steps.login = { usernameAfterSubmit: await page.inputValue('#username') }

  // ---- U53② logout ----
  await page.click('#logoutBtn')
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  out.steps.logout = {
    username: await page.inputValue('#username'),
    password: await page.inputValue('#password'),
    loginError: (await page.locator('#loginError').innerText().catch(() => '')).trim(),
    loginErrorHidden: await page.locator('#loginError').isHidden().catch(() => null),
    appHidden: await page.locator('#view-app').isHidden()
  }
  out.steps.logout.pass = out.steps.logout.username === '' && out.steps.logout.password === ''
  await page.screenshot({ path: path.join(SHOTS, 'p1-logout-empty-form.png') })

  // Log back in and seed a wide duplicate row through the page's own session.
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
  out.steps.seed = await page.evaluate(async () => {
    const token = localStorage.getItem('orca.access')
    const res = await fetch('/v1/projects/proj_payment/grants', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ subjectType: 'user', subjectId: 'zhangsan', permissions: ['open', 'file:read'] })
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  })
  const before = puts.length
  await page.locator('.nav-item[data-route="members"]').click()
  await page.locator('#memberProjectList').waitFor()
  await page.locator('#memberProjectList [data-material]', { hasText: 'payment-service' }).first().click()
  await page.locator('#grantSubject').waitFor()
  // The project click re-renders the panel asynchronously; let it settle so the
  // fill/click land on the final DOM and the wired handler.
  await page.waitForTimeout(1000)
  await page.selectOption('#grantType', 'user')
  await page.fill('#grantSubject', 'zhangsan')
  await page.click('#grantAdd')
  const dialog = page.locator('.dialog')
  const dialogVisible = await dialog.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)
  out.steps.duplicate = {
    dialogVisible,
    dialogText: dialogVisible ? (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 500) : null,
    putsBeforeConfirm: puts.length - before
  }
  if (dialogVisible) {
    await dialog.locator('[data-action="0"]').click()
    await page.waitForTimeout(1200)
  }
  out.steps.duplicate.putsAfterConfirm = puts.length - before
  out.steps.duplicate.after = await page.evaluate(async () => {
    const token = localStorage.getItem('orca.access')
    const res = await fetch('/v1/projects/proj_payment/grants', { headers: { authorization: `Bearer ${token}` } })
    const body = await res.json()
    const row = body.grants.find((g) => g.subjectType === 'user' && (g.username === 'zhangsan' || g.subjectId === 'zhangsan'))
    return { status: res.status, permissions: row ? [...row.permissions].sort() : null }
  })
  out.steps.duplicate.pass =
    dialogVisible === true &&
    /覆盖现有权限位/.test(out.steps.duplicate.dialogText ?? '') &&
    out.steps.duplicate.putsBeforeConfirm === 0 &&
    out.steps.duplicate.putsAfterConfirm === 1 &&
    JSON.stringify(out.steps.duplicate.after.permissions) === JSON.stringify(['open'])
  await page.screenshot({ path: path.join(SHOTS, 'p1-grant-overwrite-confirm.png') })
  // Cleanup the seeded row so the replay stays repeatable.
  await page.evaluate(async () => {
    const token = localStorage.getItem('orca.access')
    await fetch('/v1/projects/proj_payment/grants', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ subjectType: 'user', subjectId: 'zhangsan', permissions: [] })
    })
  })
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  out.pass = out.steps.logout?.pass === true && out.steps.duplicate?.pass === true
  out.generatedAt = new Date().toISOString()
  fs.writeFileSync(path.join(OUT, 'p1-logout-grant-confirm.json'), JSON.stringify(out, null, 2))
  await browser.close()
  console.log(`${out.pass ? 'PASS' : 'FAIL'} web-console-r5 ${JSON.stringify(out.steps).slice(0, 800)}`)
}
