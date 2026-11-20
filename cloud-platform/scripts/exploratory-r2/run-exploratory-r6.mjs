#!/usr/bin/env node
/**
 * R6 incremental exploratory replay (pairs with exploratory-r6-paths.md):
 * P1'' permission UI (host 3 cards / project 2 cards + derived / user inline),
 * P2'' routing (deep links, overlay, filters-in-URL, 404/403, logout),
 * P3'' install wizard one-time token (verbatim command, second 401, Bearer).
 *
 * Usage: node cloud-platform/scripts/exploratory-r2/run-exploratory-r6.mjs
 * Env: ORCA_QA_BASE (default https://127.0.0.1:18787), ORCA_QA_USER/PASS.
 * Writes are add→remove only, cleaned at the end; no product code touched.
 */
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const USER = process.env.ORCA_QA_USER ?? 'admin'
const PASS = process.env.ORCA_QA_PASS ?? 'Adm1n!'
const ORIGIN = new URL(BASE).origin
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'evidence/exploratory-r6'
)
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/web')
// The persistent 18787 server snapshots its web release at boot. Opt-in pinning
// serves the working-tree console while every API call still hits 18787.
const PIN_WEBTREE = process.env.ORCA_QA_PIN_WEBTREE === '1'
const SHOTS = path.join(OUT, 'screenshots')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const HOST_ID = 'host_281843a9'
const PROJECT_ID = 'proj_369e97d1'
const PROJECT_KEY = 'demo-app'

const checks = []
const paths = { "P1''": true, "P2''": true, "P3''": true }
function check(pathId, id, ok, detail) {
  checks.push({ pathId, id, status: ok ? 'PASS' : 'FAIL', detail })
  if (!ok) paths[pathId] = false
  console.log(
    `${ok ? 'PASS' : 'FAIL'} [${pathId}] ${id}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  )
}
const norm = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
const dialog = (page) => page.locator('.dialog-backdrop').last()
const dialogTitle = (page) => dialog(page).locator('.dialog h2').innerText()
const dialogBody = (page) => dialog(page).locator('.dialog .body').innerText()
const hashNow = (page) => page.evaluate(() => location.hash)

/** curl -isk via the real binary (self-signed local cert). */
function curl(args) {
  try {
    return execFileSync('curl', ['-isk', ...args], { encoding: 'utf8', timeout: 30_000 })
  } catch (error) {
    return `${error.stdout ?? ''}`
  }
}
function curlStatus(raw) {
  return Number((raw.match(/^HTTP\/[\d.]+ (\d{3})/m) ?? [])[1] ?? 0)
}
function curlBody(raw) {
  const index = raw.indexOf('\r\n\r\n')
  return index === -1 ? '' : raw.slice(index + 4)
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
if (PIN_WEBTREE) {
  const types = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8'
  }
  await context.route('**/*', async (route) => {
    const request = route.request()
    if (request.method() !== 'GET') return route.continue()
    const url = new URL(request.url())
    if (url.origin !== ORIGIN) return route.continue()
    const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '')
    if (!['index.html', 'app.js', 'styles.css', 'router/routes.js'].includes(file)) {
      return route.continue()
    }
    const body = fs.readFileSync(path.join(WEB_ROOT, file))
    await route.fulfill({
      status: 200,
      contentType: types[path.extname(file)] ?? 'text/plain',
      body
    })
  })
}
const page = await context.newPage()
page.setDefaultTimeout(25_000)
const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => consoleErrors.push(String(e)))
const puts = []
page.on('request', (r) => {
  if (r.method() === 'PUT' && /\/grants$/.test(new URL(r.url()).pathname)) puts.push(r.url())
})

const apiGet = (p) =>
  page.evaluate(async (url) => {
    const token = localStorage.getItem('orca.access')
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }, p)
const apiSend = (p, method, body) =>
  page.evaluate(
    async ({ url, method, body }) => {
      const token = localStorage.getItem('orca.access')
      const res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body)
      })
      return { status: res.status, body: await res.json().catch(() => ({})) }
    },
    { url: p, method, body }
  )

async function login() {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#view-login').waitFor({ state: 'visible' })
  if (
    await page
      .locator('#view-app')
      .isVisible()
      .catch(() => false)
  ) {
    await page
      .locator('#logoutBtn')
      .click()
      .catch(() => {})
    await page.locator('#loginForm').waitFor({ state: 'visible' })
  }
  await page.fill('#username', USER)
  await page.fill('#password', PASS)
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
}

const waitPut = () =>
  page.waitForResponse(
    (r) => r.request().method() === 'PUT' && /\/grants$/.test(new URL(r.url()).pathname),
    { timeout: 20_000 }
  )

const out = { base: BASE, viewport: 'desktop 1440x900', checks, paths: {}, steps: {} }
let baseline = null
try {
  await login()

  // ---------------- §2-16 baseline probe ----------------
  const [me, projectsApi, hostsApi, usersApi, directory] = await Promise.all([
    apiGet('/v1/me'),
    apiGet('/v1/projects'),
    apiGet('/v1/hosts'),
    apiGet('/v1/users'),
    apiGet('/v1/directory')
  ])
  const projects = projectsApi.body.projects ?? []
  const hosts = hostsApi.body.hosts ?? []
  const users = usersApi.body.users ?? []
  const demoProject = projects.find((p) => p.id === PROJECT_ID)
  const targetHost = hosts.find((h) => h.id === HOST_ID)
  const adminUser = users.find((u) => u.username === 'admin')
  baseline = {
    me: me.body.user?.username,
    permissions: me.body.user?.permissions,
    projects: projects.length,
    hosts: hosts.length,
    onlineHosts: hosts.filter((h) => !h.revokedAt && h.online).length,
    demoProject: Boolean(demoProject),
    targetHost: Boolean(targetHost),
    targetHostOnline: Boolean(targetHost?.online),
    adminUser: Boolean(adminUser),
    directoryGroups: directory.body.groups ?? []
  }
  out.steps.baseline = baseline
  const baselineOk =
    me.body.user?.username === 'admin' &&
    (me.body.user?.permissions ?? []).includes('platform:admin') &&
    baseline.onlineHosts >= 1 &&
    Boolean(demoProject) &&
    Boolean(targetHost) &&
    Boolean(adminUser) &&
    ['developers', 'team-payment'].every((g) => baseline.directoryGroups.includes(g))
  check("P1''", 'baseline probe (§2-16)', baselineOk, baseline)
  if (!baselineOk) throw new Error(`baseline incomplete: ${JSON.stringify(baseline)}`)

  // ---------------- P1''-1 host permission cards ----------------
  await page.goto(`${BASE}/#/hosts`, { waitUntil: 'domcontentloaded' })
  await page.locator(`[data-host="${HOST_ID}"]`).waitFor({ state: 'visible' })
  await page.locator(`[data-host="${HOST_ID}"]`).click()
  await page.locator('.drawer-backdrop .drawer').waitFor({ state: 'visible' })
  await page.locator('.drawer-backdrop [data-auth-tab="perms"]').click()
  await page.locator('#hostPermCards .perm-card').first().waitFor({ state: 'visible' })
  const hostGrantsApi = await apiGet(`/v1/hosts/${HOST_ID}/grants`)
  const hostGrantRows = hostGrantsApi.body.grants ?? []
  const hostCards = await page.locator('#hostPermCards .perm-card').evaluateAll((cards) =>
    cards.map((card) => {
      const clean = (value) =>
        String(value ?? '')
          .replace(/\s+/g, ' ')
          .trim()
      return {
        key: card.dataset.card,
        label: clean(card.querySelector('.perm-card-head strong')?.textContent),
        headBadges: card.querySelectorAll('.perm-card-head .badge').length,
        chips: [...card.querySelectorAll('.perm-chip')].map((chip) => ({
          key: chip.dataset.chip,
          text: clean(chip.textContent),
          levelBadges: chip.querySelectorAll('.badge').length
        })),
        adds: card.querySelectorAll('[data-perm-add]').length
      }
    })
  )
  out.steps.hostCards = hostCards
  const roleOf = (perms) => {
    const has = (b) => perms.includes(b)
    if (has('provision') && has('maintain')) return 'manage'
    if (has('view') && has('provision')) return 'control'
    if (has('view')) return 'view'
    return null
  }
  const expectedHostCounts = ['view', 'control', 'manage'].map(
    (key) => hostGrantRows.filter((g) => roleOf(g.permissions) === key).length
  )
  const actualHostCounts = ['view', 'control', 'manage'].map(
    (key, i) => hostCards[i]?.chips.length ?? -1
  )
  const zhangsanRow = hostGrantRows.find((g) => g.username === 'zhangsan')
  check(
    "P1''",
    'P1-1 host exactly three role cards',
    hostCards.map((c) => c.key).join(',') === 'view,control,manage' &&
      hostCards.map((c) => c.label).join(',') === '查看,控制,管理',
    hostCards.map((c) => `${c.key}:${c.label}`).join(' ')
  )
  check(
    "P1''",
    'P1-1 host card counts == API role derivation',
    JSON.stringify(actualHostCounts) === JSON.stringify(expectedHostCounts),
    { actualHostCounts, expectedHostCounts }
  )
  check(
    "P1''",
    'P1-1 host chips clean (no bits/level badge)',
    hostCards.every((c) => c.headBadges === 0 && c.chips.every((chip) => chip.levelBadges === 0)),
    hostCards
      .map((c) => `head${c.headBadges}/chip${c.chips.map((x) => x.levelBadges).join('')}`)
      .join(' ')
  )
  check(
    "P1''",
    'P1-1 zhangsan sits in control card (position=role)',
    Boolean(zhangsanRow) &&
      roleOf(zhangsanRow.permissions) === 'control' &&
      hostCards[1].chips.some((c) => c.key === `user:${zhangsanRow.subjectId}`),
    { zhangsan: zhangsanRow?.permissions, controlChips: hostCards[1]?.chips.map((c) => c.key) }
  )
  await page.screenshot({ path: path.join(SHOTS, 'p1-host-perms.png') })

  // ---------------- P1''-2 host add → remove ----------------
  const hostSubject = ['developers', 'team-payment', 'platform-admins'].find(
    (group) => !hostGrantRows.some((g) => g.subjectType === 'group' && g.subjectId === group)
  )
  if (!hostSubject) throw new Error('no free group subject for host grant add/remove')
  const putsBeforeHostAdd = puts.length
  await page.locator('#hostPermCards [data-perm-type="view"]').selectOption('group')
  await page.locator('#hostPermCards [data-perm-subject="view"]').fill(hostSubject)
  const hostAddPut = waitPut()
  await page.locator('#hostPermCards [data-perm-add="view"]').click()
  const hostAddResponse = await hostAddPut
  await sleep(400)
  const hostAfterAdd = (await apiGet(`/v1/hosts/${HOST_ID}/grants`)).body.grants ?? []
  const hostAdded = hostAfterAdd.find(
    (g) => g.subjectType === 'group' && g.subjectId === hostSubject
  )
  await page
    .locator(`#hostPermCards .perm-card[data-card="view"] [data-chip="group:${hostSubject}"]`)
    .waitFor({ state: 'visible' })
  check(
    "P1''",
    'P1-2 host add writes target card bits',
    hostAddResponse.status() === 200 &&
      JSON.stringify(hostAdded?.permissions) === JSON.stringify(['view']) &&
      (await page
        .locator(`#hostPermCards .perm-card[data-card="view"] [data-chip="group:${hostSubject}"]`)
        .count()) === 1,
    { status: hostAddResponse.status(), permissions: hostAdded?.permissions }
  )
  const hostRemovePut = waitPut()
  await page.locator(`#hostPermCards [data-perm-remove="group:${hostSubject}"]`).click()
  await dialog(page).waitFor({ state: 'visible' })
  const removeTitle = await dialogTitle(page)
  const removeBody = await dialogBody(page)
  const removeConfirmLabel = norm(
    await dialog(page).locator('.dialog .foot [data-action="0"]').innerText()
  )
  check(
    "P1''",
    'P1-2 host remove confirmation copy',
    removeTitle === '移除全部授权' &&
      removeBody.includes(
        `宿主无法解析组成员，将断开该主机当前全部在线会话（≤60 秒内生效，FR-1.7）。`
      ) &&
      removeConfirmLabel === '确认移除' &&
      (
        await dialog(page).locator('.dialog .foot [data-action="0"]').getAttribute('class')
      ).includes('danger'),
    { removeTitle, removeBody, removeConfirmLabel }
  )
  await dialog(page).locator('.dialog .foot [data-action="0"]').click()
  await hostRemovePut
  await page
    .locator(`#hostPermCards .perm-card[data-card="view"] [data-chip="group:${hostSubject}"]`)
    .waitFor({ state: 'detached' })
  const hostFinal = (await apiGet(`/v1/hosts/${HOST_ID}/grants`)).body.grants ?? []
  check(
    "P1''",
    'P1-2 host remove cleans baseline',
    !hostFinal.some((g) => g.subjectType === 'group' && g.subjectId === hostSubject) &&
      puts.length - putsBeforeHostAdd === 2,
    { puts: puts.length - putsBeforeHostAdd, remaining: hostFinal.length }
  )

  // ---------------- P1''-3 host adjust dialog (no write) ----------------
  const putsBeforeAdjust = puts.length
  await page
    .locator('#hostPermCards .perm-card[data-card="control"] .perm-chip-adjust')
    .first()
    .click()
  await dialog(page).waitFor({ state: 'visible' })
  const adjustTitle = await dialogTitle(page)
  const adjustBody = await dialogBody(page)
  const adjustActions = await dialog(page)
    .locator('.dialog .foot [data-action]')
    .evaluateAll((buttons) =>
      buttons.map((b) =>
        String(b.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
      )
    )
  await dialog(page).locator('.dialog .foot [data-action="close"]').click()
  await dialog(page).waitFor({ state: 'detached' })
  check(
    "P1''",
    'P1-3 host adjust chain (cancel, 0 PUT)',
    adjustTitle === '调整角色' &&
      adjustBody.includes('当前角色为「控制」') &&
      adjustActions.includes('改为「查看」') &&
      adjustActions.includes('改为「管理」') &&
      adjustBody.includes(
        '管理=provision+maintain（不含 view）：保存会丢失 view 带来的项目可见性。'
      ) &&
      puts.length === putsBeforeAdjust &&
      (await page.locator('.drawer-backdrop .drawer').count()) === 1,
    { adjustTitle, adjustActions, extraPuts: puts.length - putsBeforeAdjust }
  )
  await page.locator('.drawer-backdrop .drawer-head .icon-btn').click()
  await page.locator('.drawer-backdrop').waitFor({ state: 'detached' })

  // ---------------- P1''-4 project cards + derived read-only + jump ----------------
  await page.goto(`${BASE}/#/projects/${PROJECT_ID}?tab=perms`, { waitUntil: 'domcontentloaded' })
  await page.locator('#projectPermCards .perm-card').first().waitFor({ state: 'visible' })
  const projectGrantsApi = await apiGet(`/v1/projects/${PROJECT_ID}/grants`)
  const projectGrantRows = projectGrantsApi.body.grants ?? []
  const projectCards = await page.locator('#projectPermCards .perm-card').evaluateAll((cards) =>
    cards.map((card) => {
      const clean = (value) =>
        String(value ?? '')
          .replace(/\s+/g, ' ')
          .trim()
      return {
        key: card.dataset.card,
        label: clean(card.querySelector('.perm-card-head strong')?.textContent),
        headBadges: card.querySelectorAll('.perm-card-head .badge').length,
        headText: clean(card.querySelector('.perm-card-head')?.textContent),
        desc: clean(card.querySelector('.perm-card-desc')?.textContent),
        adds: card.querySelectorAll('[data-perm-add]').length,
        removes: [...card.querySelectorAll('.perm-chip-x')].map((b) => b.disabled),
        chips: [...card.querySelectorAll('.perm-chip')].map((c) => clean(c.textContent))
      }
    })
  )
  out.steps.projectCards = projectCards
  check(
    "P1''",
    'P1-4 project two writable cards + derived card',
    projectCards.map((c) => c.key).join(',') === 'view,control,derived' &&
      projectCards.map((c) => c.label).join(',') === '查看,控制,管理' &&
      projectCards.slice(0, 2).every((c) => c.headBadges === 0 && c.adds === 1),
    projectCards.map((c) => `${c.key}:${c.label}:badge${c.headBadges}:add${c.adds}`).join(' ')
  )
  const hostControlHolders = (
    (await apiGet(`/v1/hosts/${HOST_ID}/grants`)).body.grants ?? []
  ).filter((g) => ['control', 'manage'].includes(roleOf(g.permissions)))
  const derived = projectCards.find((c) => c.key === 'derived')
  check(
    "P1''",
    'P1-4 derived card read-only + host-derived subjects',
    derived &&
      derived.headText.includes('主机推导 · 只读') &&
      derived.desc.includes('项目级无「管理」权限位') &&
      derived.adds === 0 &&
      derived.removes.every(Boolean) &&
      hostControlHolders.every((g) =>
        derived.chips.some((text) => text.includes(g.username ?? g.subjectId))
      ) &&
      derived.chips.some((text) => text.includes('来源：控制卡')),
    { derived, hostControlHolders: hostControlHolders.map((g) => g.username ?? g.subjectId) }
  )
  const projectAndHostViewOnly = hostGrantRows.filter((g) => roleOf(g.permissions) === 'view')
  check(
    "P1''",
    'P1-4 view-only host holders excluded from derived',
    projectAndHostViewOnly.every(
      (g) => !derived?.chips.some((text) => text.includes(g.username ?? g.subjectId))
    ),
    projectAndHostViewOnly.map((g) => g.username ?? g.subjectId)
  )
  await page.screenshot({ path: path.join(SHOTS, 'p1-project-perms.png') })

  // ---------------- P1''-5 project add → remove ----------------
  const projectSubject = ['developers', 'team-payment', 'platform-admins'].find(
    (group) => !projectGrantRows.some((g) => g.subjectType === 'group' && g.subjectId === group)
  )
  if (!projectSubject) throw new Error('no free group subject for project grant add/remove')
  const putsBeforeProject = puts.length
  await page.locator('#projectPermCards [data-perm-subject="view"]').fill(projectSubject)
  const projectAddPut = waitPut()
  await page.locator('#projectPermCards [data-perm-add="view"]').click()
  const projectAddResponse = await projectAddPut
  await page.locator(`#projectPermCards [data-chip="group:${projectSubject}"]`).waitFor({
    state: 'visible'
  })
  const projectAfterAdd = (await apiGet(`/v1/projects/${PROJECT_ID}/grants`)).body.grants ?? []
  const projectAdded = projectAfterAdd.find(
    (g) => g.subjectType === 'group' && g.subjectId === projectSubject
  )
  check(
    "P1''",
    'P1-5 project add unions view bits',
    projectAddResponse.status() === 200 &&
      JSON.stringify(projectAdded?.permissions) === JSON.stringify(['file:read', 'open']) &&
      (await page
        .locator(
          `#projectPermCards .perm-card[data-card="view"] [data-chip="group:${projectSubject}"]`
        )
        .count()) === 1,
    { status: projectAddResponse.status(), permissions: projectAdded?.permissions }
  )
  const projectRemovePut = waitPut()
  await page.locator(`#projectPermCards [data-perm-remove="group:${projectSubject}"]`).click()
  await dialog(page).waitFor({ state: 'visible' })
  const projectRemoveBody = await dialogBody(page)
  await dialog(page).locator('.dialog .foot [data-action="0"]').click()
  await projectRemovePut
  await page.locator(`#projectPermCards [data-chip="group:${projectSubject}"]`).waitFor({
    state: 'detached'
  })
  const projectFinal = (await apiGet(`/v1/projects/${PROJECT_ID}/grants`)).body.grants ?? []
  check(
    "P1''",
    'P1-5 project remove confirmation + cleanup',
    projectRemoveBody.includes(
      '宿主无法解析组成员，将断开该项目当前全部在线会话（≤60 秒内生效，FR-1.7）。'
    ) &&
      !projectFinal.some((g) => g.subjectType === 'group' && g.subjectId === projectSubject) &&
      puts.length - putsBeforeProject === 2,
    { puts: puts.length - putsBeforeProject, remaining: projectFinal.length }
  )

  // Jump to host detail from derived card.
  await page.locator('#projectPermCards [data-open-host-detail]').click()
  await page.locator(`#hostPermCards .perm-card`).first().waitFor({ state: 'visible' })
  const jumpHash = await hashNow(page)
  const jumpTabActive = await page
    .locator('.drawer-backdrop [data-auth-tab="perms"].active')
    .count()
  check(
    "P1''",
    'P1-4 derived jump opens host perms drawer',
    jumpHash === `#/hosts/${HOST_ID}?tab=perms` && jumpTabActive === 1,
    { jumpHash, jumpTabActive }
  )
  await page.screenshot({ path: path.join(SHOTS, 'p1-derived-jump.png') })
  await page.locator('.drawer-backdrop .drawer-head .icon-btn').click()
  await page.locator('.drawer-backdrop').waitFor({ state: 'detached' })

  // ---------------- P1''-6/P1-7 users deep link + missing member ----------------
  const adminId = adminUser.id
  await page.goto(`${BASE}/#/users/${adminId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.dialog-backdrop .dialog h2').waitFor({ state: 'visible' })
  const userTitle = await dialogTitle(page)
  const userListControls = await page.locator('#usersBody input, #usersBody select').count()
  const roleSelectCount = await dialog(page).locator('select[data-detail-role]').count()
  const userDl = await dialog(page).locator('.dialog .body dl.kv dd').allInnerTexts()
  check(
    "P1''",
    'P1-6 user detail inline edit, list read-only',
    userTitle === '用户详情 · 李静' &&
      userListControls === 0 &&
      roleSelectCount === 1 &&
      userDl.length >= 7 &&
      !(await dialogBody(page)).includes('最近登录') &&
      !(await dialogBody(page)).includes('创建时间'),
    { userTitle, userListControls, roleSelectCount, fields: userDl.length }
  )
  await page.screenshot({ path: path.join(SHOTS, 'p1-user-detail.png') })
  await dialog(page).locator('.dialog .foot [data-action="close"]').click()

  await page.goto(`${BASE}/#/users/user_does_not_exist`, { waitUntil: 'domcontentloaded' })
  await page.locator('#content h1').waitFor({ state: 'visible' })
  const missingUserText = norm(await page.locator('#content').innerText())
  check(
    "P1''",
    'P1-7 missing member detail 404 (hash preserved)',
    missingUserText.includes('页面不存在') &&
      missingUserText.includes('链接里的用户不存在或当前账号不可见。地址保留，刷新会重新校验。') &&
      missingUserText.includes('返回用户管理') &&
      (await hashNow(page)) === '#/users/user_does_not_exist' &&
      (await page.locator('.dialog-backdrop').count()) === 0,
    { text: missingUserText.slice(0, 160), hash: await hashNow(page) }
  )
  await page.screenshot({ path: path.join(SHOTS, 'p1-missing-user-404.png') })

  // ---------------- P2''-1 three deep links + ?tab=perms refresh ----------------
  await page.goto(`${BASE}/#/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.dialog-backdrop .dialog h2').waitFor({ state: 'visible' })
  const projectDeepTitle = await dialogTitle(page)
  await dialog(page).locator('.dialog .foot [data-action="close"]').click()
  await page.goto(`${BASE}/#/hosts/${HOST_ID}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.drawer-backdrop .drawer h2').waitFor({ state: 'visible' })
  const hostDeepTitle = norm(await page.locator('.drawer-backdrop .drawer h2').innerText())
  await page.locator('.drawer-backdrop .drawer-head .icon-btn').click()
  await page.goto(`${BASE}/#/users/${adminId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.dialog-backdrop .dialog h2').waitFor({ state: 'visible' })
  const userDeepTitle = await dialogTitle(page)
  check(
    "P2''",
    'P2-1 three detail deep links',
    projectDeepTitle === '项目详情' &&
      hostDeepTitle.includes('dev-local-02') &&
      userDeepTitle === '用户详情 · 李静',
    { projectDeepTitle, hostDeepTitle, userDeepTitle }
  )

  await page.goto(`${BASE}/#/projects/${PROJECT_ID}?tab=perms`, { waitUntil: 'domcontentloaded' })
  await page.locator('#projectPermCards .perm-card').first().waitFor({ state: 'visible' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('#projectPermCards .perm-card').first().waitFor({ state: 'visible' })
  const projectPermsAfterReload = {
    hash: await hashNow(page),
    active: await page.locator('.dialog-backdrop [data-auth-tab="perms"].active').count(),
    panelVisible: await page.locator('.dialog-backdrop [data-auth-panel="perms"]').isVisible()
  }
  await dialog(page).locator('.dialog .foot [data-action="close"]').click()

  await page.goto(`${BASE}/#/hosts/${HOST_ID}?tab=perms`, { waitUntil: 'domcontentloaded' })
  await page.locator('#hostPermCards .perm-card').first().waitFor({ state: 'visible' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('#hostPermCards .perm-card').first().waitFor({ state: 'visible' })
  const hostPermsAfterReload = {
    hash: await hashNow(page),
    active: await page.locator('.drawer-backdrop [data-auth-tab="perms"].active').count(),
    panelVisible: await page.locator('.drawer-backdrop [data-auth-panel="perms"]').isVisible()
  }
  await page.locator('.drawer-backdrop .drawer-head .icon-btn').click()
  check(
    "P2''",
    'P2-1 ?tab=perms survives reload',
    projectPermsAfterReload.hash === `#/projects/${PROJECT_ID}?tab=perms` &&
      projectPermsAfterReload.active === 1 &&
      projectPermsAfterReload.panelVisible &&
      hostPermsAfterReload.hash === `#/hosts/${HOST_ID}?tab=perms` &&
      hostPermsAfterReload.active === 1 &&
      hostPermsAfterReload.panelVisible,
    { projectPermsAfterReload, hostPermsAfterReload }
  )

  // ---------------- P2''-2 overlay route ----------------
  await page.goto(`${BASE}/#/workspace/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' })
  await page.locator('#workspaceOverlay').waitFor({ state: 'visible', timeout: 30_000 })
  const overlayHash = await hashNow(page)
  await page.evaluate(() => {
    location.hash = '#/projects'
  })
  await page.locator('#workspaceOverlay').waitFor({ state: 'detached', timeout: 15_000 })
  const overlayGone = (await page.locator('#workspaceOverlay').count()) === 0
  await page.goto(`${BASE}/#/workspace/proj_nope`, { waitUntil: 'domcontentloaded' })
  await page.locator('#content h1').waitFor({ state: 'visible' })
  const badWorkspaceText = norm(await page.locator('#content').innerText())
  check(
    "P2''",
    'P2-2 workspace overlay route + removal + unknown 404',
    overlayHash === `#/workspace/${PROJECT_ID}` &&
      overlayGone &&
      badWorkspaceText.includes('页面不存在') &&
      badWorkspaceText.includes('链接里的项目不存在或当前账号不可见') &&
      (await hashNow(page)) === '#/workspace/proj_nope',
    { overlayHash, overlayGone, text: badWorkspaceText.slice(0, 160) }
  )
  await page.screenshot({ path: path.join(SHOTS, 'p2-workspace-404.png') })

  // ---------------- P2''-3 filter in URL ----------------
  await page.goto(`${BASE}/#/users`, { waitUntil: 'domcontentloaded' })
  await page.locator('#usersBody tr').first().waitFor({ state: 'visible' })
  const totalUsers = (await apiGet('/v1/users')).body.users?.length ?? 0
  const historyBeforeType = await page.evaluate(() => history.length)
  await page.fill('#userSearch', '张伟')
  await sleep(250)
  const filterHash = await hashNow(page)
  const filteredRows = await page.locator('#usersBody tr').count()
  const historyAfterType = await page.evaluate(() => history.length)
  // Fallback path: programmatic value without input event, then explicit 查询 must push.
  await page.evaluate(() => {
    document.querySelector('#userSearch').value = 'lisi'
  })
  const historyBeforePush = await page.evaluate(() => history.length)
  await page.click('#userFilterApply')
  await sleep(250)
  const pushHash = await hashNow(page)
  const pushRows = await page.locator('#usersBody tr').count()
  const historyAfterPush = await page.evaluate(() => history.length)
  await page.click('#userFilterReset')
  await sleep(200)
  const resetHash = await hashNow(page)
  const resetRows = await page.locator('#usersBody tr').count()
  check(
    "P2''",
    'P2-3 list filters in URL (replace/push/reset)',
    filterHash === '#/users?query=%E5%BC%A0%E4%BC%9F' &&
      filteredRows === 1 &&
      historyAfterType === historyBeforeType &&
      pushHash === '#/users?query=lisi' &&
      pushRows === 1 &&
      historyAfterPush === historyBeforePush + 1 &&
      resetHash === '#/users' &&
      resetRows === totalUsers,
    {
      filterHash,
      filteredRows,
      historyBeforeType,
      historyAfterType,
      pushHash,
      pushRows,
      historyBeforePush,
      historyAfterPush,
      resetHash,
      resetRows,
      totalUsers
    }
  )

  // ---------------- P2''-4 404 five shapes ----------------
  const notFoundHashes = [
    '#/nope',
    '#/projects/x/y',
    '#projects',
    '#/projects/%E0%A4%A',
    '#/workspace/',
    '#/not-found'
  ]
  const notFoundResults = []
  for (const hash of notFoundHashes) {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' })
    await page.locator('#content h1').waitFor({ state: 'visible' })
    notFoundResults.push({
      hash,
      title: norm(await page.locator('#content h1').innerText()),
      crumbs: norm(await page.locator('#crumbs').innerText()),
      body: norm(await page.locator('#content').innerText()),
      current: await hashNow(page)
    })
  }
  check(
    "P2''",
    'P2-4 404 five shapes (not-fallback)',
    notFoundResults.every(
      (r) =>
        r.title === '页面不存在' &&
        r.crumbs === '页面不存在' &&
        r.body.includes(r.hash) &&
        r.current === r.hash
    ),
    notFoundResults.map((r) => `${r.hash}=>${r.title}/${r.current}`)
  )
  await page.screenshot({ path: path.join(SHOTS, 'p2-404-shapes.png') })

  // ---------------- P2''-5 403 vs 404 separation ----------------
  await page.goto(`${BASE}/#/forbidden`, { waitUntil: 'domcontentloaded' })
  await page.locator('#content h1').waitFor({ state: 'visible' })
  const forbidden = {
    title: norm(await page.locator('#content h1').innerText()),
    crumbs: norm(await page.locator('#crumbs').innerText()),
    body: norm(await page.locator('#content').innerText()),
    hash: await hashNow(page)
  }
  await page.goto(`${BASE}/#/nope`, { waitUntil: 'domcontentloaded' })
  await page.locator('#content h1').waitFor({ state: 'visible' })
  const missing = {
    title: norm(await page.locator('#content h1').innerText()),
    crumbs: norm(await page.locator('#crumbs').innerText())
  }
  check(
    "P2''",
    'P2-5 403 distinct from 404',
    forbidden.title === '无权访问' &&
      forbidden.crumbs === '无权访问' &&
      forbidden.body.includes('当前账号没有平台管理权限') &&
      forbidden.hash === '#/forbidden' &&
      missing.title === '页面不存在' &&
      missing.crumbs === '页面不存在',
    { forbidden: forbidden.title, missing: missing.title }
  )

  // ---------------- P2''-6 logout clears hash ----------------
  await page.goto(`${BASE}/#/users`, { waitUntil: 'domcontentloaded' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('#usersBody tr').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.click('#logoutBtn')
  await page.locator('#view-login').waitFor({ state: 'visible' })
  const logoutState = await page.evaluate(() => ({
    hash: location.hash,
    access: localStorage.getItem('orca.access'),
    refresh: localStorage.getItem('orca.refresh'),
    user: localStorage.getItem('orca.user')
  }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('#view-login').waitFor({ state: 'visible' })
  const afterReload = {
    hash: await hashNow(page),
    loginVisible: await page.locator('#view-login').isVisible()
  }
  check(
    "P2''",
    'P2-6 logout clears tokens + hash survives reload',
    logoutState.hash === '#/login' &&
      logoutState.access === null &&
      logoutState.refresh === null &&
      logoutState.user === null &&
      afterReload.hash === '#/login' &&
      afterReload.loginVisible,
    { logoutState, afterReload }
  )

  // ---------------- P3'' install wizard ----------------
  await login()
  await page.goto(`${BASE}/#/hosts`, { waitUntil: 'domcontentloaded' })
  await page.locator('#registerHostBtn').click()
  await page.locator('#installCmd').waitFor({ state: 'visible' })
  const wizardText = norm(await dialogBody(page))
  const installCmd = (await page.locator('#installCmd').innerText()).trim()
  const cmdMatch = installCmd.match(/^bash <\(curl -fsSL (\S+)\)$/)
  const cmdUrl = cmdMatch?.[1] ?? ''
  const cmdParsed = cmdUrl ? new URL(cmdUrl) : null
  check(
    "P3''",
    'P3-1 host command verbatim from wizard',
    Boolean(cmdParsed) &&
      cmdParsed.origin === ORIGIN &&
      cmdParsed.pathname === '/install/host.sh' &&
      Boolean(cmdParsed.searchParams.get('download')) &&
      Boolean(cmdParsed.searchParams.get('token')) &&
      wizardText.includes('命令 10 分钟内有效且只能下载一次') &&
      wizardText.includes('注册令牌 24 小时内有效且只能使用一次'),
    { installCmd, wizardText: wizardText.slice(0, 160) }
  )
  await page.screenshot({ path: path.join(SHOTS, 'p3-install-wizard.png') })

  // ---------------- P3''-2 verbatim URL: first 200, second 401 ----------------
  const firstRaw = curl([cmdUrl])
  const firstStatus = curlStatus(firstRaw)
  const firstBody = curlBody(firstRaw)
  const secondRaw = curl([cmdUrl])
  const secondStatus = curlStatus(secondRaw)
  const registrationToken = cmdParsed?.searchParams.get('token') ?? ''
  check(
    "P3''",
    'P3-2 verbatim URL 200 then 401',
    firstStatus === 200 &&
      firstBody.startsWith('#!/usr/bin/env bash') &&
      firstBody.includes(registrationToken) &&
      secondStatus === 401,
    {
      firstStatus,
      secondStatus,
      contentType: (firstRaw.match(/^content-type:.*$/im) ?? [''])[0],
      bodyHead: firstBody.slice(0, 50)
    }
  )

  // ---------------- P3''-3 Bearer compatible ----------------
  const access = await page.evaluate(() => localStorage.getItem('orca.access'))
  const tokenRes = await apiSend('/v1/hosts/tokens', 'POST')
  const bearerToken = tokenRes.body.token ?? ''
  const bearerRaw = curl([
    '-H',
    `authorization: Bearer ${access}`,
    `${ORIGIN}/install/host.sh?token=${bearerToken}`
  ])
  const bearerStatus = curlStatus(bearerRaw)
  const bearerBody = curlBody(bearerRaw)
  check(
    "P3''",
    'P3-3 Bearer path still issues script',
    tokenRes.status === 201 &&
      Boolean(bearerToken) &&
      bearerStatus === 200 &&
      bearerBody.includes(bearerToken),
    { tokenStatus: tokenRes.status, bearerStatus, hasToken: bearerBody.includes(bearerToken) }
  )

  // ---------------- cleanup guard ----------------
  const hostClean = (await apiGet(`/v1/hosts/${HOST_ID}/grants`)).body.grants ?? []
  const projectClean = (await apiGet(`/v1/projects/${PROJECT_ID}/grants`)).body.grants ?? []
  const cleanOk =
    !hostClean.some((g) => g.subjectType === 'group' && g.subjectId === hostSubject) &&
    !projectClean.some((g) => g.subjectType === 'group' && g.subjectId === projectSubject)
  check("P1''", 'cleanup: no residual test grants', cleanOk, {
    hostClean: hostClean.length,
    projectClean: projectClean.length
  })
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  check("P1''", 'RUN', false, out.error)
} finally {
  out.paths = paths
  out.webSource = PIN_WEBTREE ? 'working tree (pinned via route)' : '18787 server release'
  out.consoleErrors = consoleErrors.slice(0, 20)
  out.puts = puts.length
  out.generatedAt = new Date().toISOString()
  out.pass = Object.values(paths).every(Boolean)
  fs.writeFileSync(path.join(OUT, 'r6-findings.json'), JSON.stringify(out, null, 2))
  await browser.close().catch(() => {})
  console.log(
    `\n${out.pass ? 'PASS' : 'FAIL'} exploratory-r6 ${JSON.stringify(paths)} checks=${checks.length}`
  )
  process.exitCode = out.pass ? 0 : 1
}
