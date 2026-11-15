/** Role-isolated drivers over the shared DOM inventory: prototype file:// and the running Web. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import {
  ADMIN_ROUTES,
  DEFAULT_COMPARE_ROLES,
  PROTOTYPE_ROUTES,
  defaultPrototypePath,
  extractDomInventory
} from './prototype-inventory.mjs'

/* ---------------- prototype driver ---------------- */

async function waitForPrototypeRoute(page, route) {
  await page.waitForFunction(
    (wanted) => {
      if (wanted === 'workspace') {
        return Boolean(document.querySelector('#projectShell:not([hidden])'))
      }
      return Boolean(document.querySelector(`[data-page="${wanted}"]:not([hidden])`))
    },
    route,
    { timeout: 10000 }
  )
  await page.waitForTimeout(80)
}

async function prototypeGoto(page, hash) {
  await page.evaluate((target) => {
    location.hash = target
  }, hash)
}

export async function collectPrototypeSide(page, { prototypeUrl, role }) {
  const fileUrl = pathToFileURL(prototypeUrl).href
  const reachability = {}
  const surfaces = {}

  await page.goto(`${fileUrl}#/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginScreen:not([hidden]), #appShell:not([hidden])', {
    timeout: 10000
  })
  surfaces.login = await extractDomInventory(page, { surface: 'login' })
  reachability.login = 'reached'

  await prototypeGoto(page, '#/workbench')
  await waitForPrototypeRoute(page, 'workbench')
  if (role === 'developer') {
    await page.evaluate(() =>
      document.querySelector('[data-role-switch="developer"]')?.click()
    )
    await page.waitForTimeout(200)
  }

  for (const route of PROTOTYPE_ROUTES) {
    await prototypeGoto(page, `#/${route}`)
    await page.waitForTimeout(250)
    const landed = await page.evaluate(() => location.hash.replace(/^#\/?/, '').split('/')[0])
    if (ADMIN_ROUTES.has(route) && role !== 'admin') {
      reachability[route] = landed === 'forbidden' ? 'forbidden' : 'missing'
      continue
    }
    await waitForPrototypeRoute(page, route)
    surfaces[route] = await extractDomInventory(page, { surface: route })
    reachability[route] = 'reached'
  }

  await prototypeGoto(page, '#/project/payment-service')
  await waitForPrototypeRoute(page, 'workspace')
  surfaces.workspace = await extractDomInventory(page, { surface: 'workspace' })
  reachability.workspace = 'reached'

  await prototypeGoto(page, '#/forbidden')
  await page.waitForTimeout(250)
  await waitForPrototypeRoute(page, 'forbidden')
  surfaces.forbidden = await extractDomInventory(page, { surface: 'forbidden' })
  reachability.forbidden = 'reached'

  return { side: 'prototype', role, reachability, surfaces }
}

/* ---------------- actual Web driver ---------------- */

const ACTUAL_TITLES = {
  workbench: '工作台',
  projects: '我的项目',
  hosts: '平台设置 / 主机',
  relays: '平台设置 / 中继',
  members: '成员与权限',
  audit: '审计日志',
  settings: '平台设置'
}

async function waitForActualRoute(page, crumbs) {
  await page
    .waitForFunction(
      (expected) => document.querySelector('#crumbs')?.innerText.trim() === expected,
      crumbs,
      { timeout: 10000 }
    )
    .catch(() => undefined)
  await page
    .waitForFunction(
      () => !document.querySelector('#content')?.innerText.includes('加载中…'),
      null,
      { timeout: 15000 }
    )
    .catch(() => undefined)
  await page.waitForTimeout(120)
}

async function clickActualNav(page, route, { force } = {}) {
  const selector = `.nav-item[data-route="${route}"]`
  if (force) {
    await page.evaluate((sel) => document.querySelector(sel)?.click(), selector)
    return
  }
  await page.locator(`${selector}:visible`).first().click()
}

export async function collectActualSide(page, { baseUrl, role, credentials }) {
  const reachability = {}
  const surfaces = {}
  const isAdmin = role === 'admin'

  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#view-login, #view-app', { state: 'visible', timeout: 15000 })
  if (await page.locator('#view-login').isVisible().catch(() => false)) {
    surfaces.login = await extractDomInventory(page, { surface: 'login' })
    reachability.login = 'reached'
    await page.fill('#username', credentials.username)
    await page.fill('#password', credentials.password)
    await page.click('#loginBtn')
    await page.waitForSelector('#view-app', { state: 'visible', timeout: 15000 })
  } else {
    surfaces.login = await extractDomInventory(page, { surface: 'login' })
    reachability.login = 'reached'
  }
  await waitForActualRoute(page, ACTUAL_TITLES.workbench)

  for (const route of PROTOTYPE_ROUTES) {
    if (route === 'diagnostics') {
      const before = await page.locator('#crumbs').innerText()
      await page.evaluate(() => {
        location.hash = '#/diagnostics'
      })
      await page.waitForTimeout(400)
      const after = await page.locator('#crumbs').innerText()
      if (after === before) {
        reachability.diagnostics = 'missing'
        continue
      }
      surfaces.diagnostics = await extractDomInventory(page, { surface: 'diagnostics' })
      reachability.diagnostics = 'reached'
      continue
    }
    if (ADMIN_ROUTES.has(route) && !isAdmin) {
      await clickActualNav(page, route, { force: true })
      await page.waitForTimeout(250)
      const forbidden = await page
        .locator('#content')
        .innerText()
        .then((value) => value.includes('无权访问'))
        .catch(() => false)
      reachability[route] = forbidden ? 'forbidden' : 'missing'
      await page.waitForTimeout(150)
      continue
    }
    await clickActualNav(page, route)
    await waitForActualRoute(page, ACTUAL_TITLES[route])
    surfaces[route] = await extractDomInventory(page, { surface: route })
    reachability[route] = 'reached'
  }

  // P3: the Web mounts a same-page overlay with cloud-admin.html in an iframe.
  await clickActualNav(page, 'projects')
  await waitForActualRoute(page, ACTUAL_TITLES.projects)
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button[data-open]')].find(
      (candidate) => !candidate.disabled
    )
    if (!button) {return false}
    button.click()
    return true
  })
  if (opened) {
    await page
      .waitForSelector('#workspaceOverlay', { state: 'visible', timeout: 15000 })
      .catch(() => undefined)
    await page
      .waitForFunction(
        () =>
          Boolean(document.querySelector('#workspaceOverlay iframe')) ||
          Boolean(document.querySelector('#workspaceOverlay .workspace-status[role="alert"]')),
        null,
        { timeout: 15000 }
      )
      .catch(() => undefined)
    await page.waitForTimeout(300)
    surfaces.workspace = await extractDomInventory(page, { surface: 'workspace' })
    reachability.workspace = 'reached'
    await page
      .evaluate(() => document.querySelector('[data-workspace-close]')?.click())
      .catch(() => undefined)
    await page.waitForTimeout(300)
  } else {
    reachability.workspace = 'missing'
  }

  await page.evaluate(() => document.querySelector('#open403')?.click())
  await page
    .waitForFunction(
      () => document.querySelector('#content')?.innerText.includes('无权访问'),
      null,
      { timeout: 10000 }
    )
    .catch(() => undefined)
  await page.waitForTimeout(120)
  surfaces.forbidden = await extractDomInventory(page, { surface: 'forbidden' })
  reachability.forbidden = 'reached'

  return { side: 'actual', role, reachability, surfaces }
}

/* ---------------- two-role collection ---------------- */

export function resolveCredentials(accounts, account) {
  const entry = accounts?.[account]
  if (entry) {return entry}
  if (account === 'admin') {return { username: 'admin', password: 'Adm1n!' }}
  return { username: account === 'developer' ? 'zhangsan' : account, password: 'Passw0rd!' }
}

/**
 * Run the same extractor over prototype.html and the running Web for each role,
 * each in its own isolated BrowserContext.
 * @example
 * const result = await collectComparison({ browser, baseUrl, evidenceDir })
 */
export async function collectComparison({
  browser,
  baseUrl,
  prototypeUrl = defaultPrototypePath(),
  evidenceDir,
  roles = DEFAULT_COMPARE_ROLES,
  accounts
}) {
  const result = {
    generatedAt: new Date().toISOString(),
    prototypeUrl,
    baseUrl,
    roles: []
  }
  for (const spec of roles) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
    try {
      const page = await context.newPage()
      const prototype = await collectPrototypeSide(page, { prototypeUrl, role: spec.role })
      const actual = await collectActualSide(page, {
        baseUrl,
        role: spec.role,
        credentials: resolveCredentials(accounts, spec.account)
      })
      result.roles.push({ role: spec.role, account: spec.account, prototype, actual })
    } finally {
      await context.close().catch(() => undefined)
    }
  }
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true })
    for (const entry of result.roles) {
      writeFileSync(
        path.join(evidenceDir, `inventory-prototype-${entry.role}.json`),
        JSON.stringify(entry.prototype, null, 2)
      )
      writeFileSync(
        path.join(evidenceDir, `inventory-actual-${entry.role}.json`),
        JSON.stringify(entry.actual, null, 2)
      )
    }
  }
  return result
}

