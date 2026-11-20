#!/usr/bin/env node
/**
 * r7 P2 polish batch verification against the persistent 18787 env.
 * Pairs with exploratory-r7-paths.md. Writes evidence/r7/*.json + screenshots.
 * Test mutations (host grants, roles, policy) are restored at the end.
 *
 * Usage:
 *   NODE_EXTRA_CA_CERTS=~/orca-local-env/tls/ca.pem ORCA_BACKGROUND_LAUNCH=1 \
 *     node cloud-platform/scripts/exploratory-r2/run-exploratory-r7.mjs
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../evidence/r7'
)
const SHOTS = path.join(OUT, 'screenshots')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const HOST2 = 'host_b58500c3'
const HOST3 = 'host_132a3c9d'
const USER = { admin: 'Adm1n!', zhangsan: 'Passw0rd!', lisi: 'Passw0rd!' }

const checks = []
const paths = { P1: true, P2: true, P3: true, P4: true, P5: true }
function check(pathId, id, ok, detail) {
  checks.push({ pathId, id, status: ok ? 'PASS' : 'FAIL', detail })
  if (!ok) paths[pathId] = false
  console.log(
    `${ok ? 'PASS' : 'FAIL'} [${pathId}] ${id}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  )
}
const writeJson = (name, value) =>
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2))

async function loginApi(username, password) {
  const res = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, token: body.accessToken, body }
}
async function api(token, p, method = 'GET', body) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* empty */
  }
  return { status: res.status, body: json }
}
const auditFind = (events, predicate) =>
  events
    .filter(predicate)
    .sort((a, b) => b.seq - a.seq)
    .at(0)
/** Local persistent env only: the host-side revocation channel is not a public API. */
function readPersistedUserRevocations() {
  try {
    const storePath =
      process.env.ORCA_QA_STORE ?? `${process.env.HOME}/orca-local-env/run/platform-store.json`
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    return (store.revocations ?? []).filter((r) => r.targetType === 'user')
  } catch {
    return null
  }
}

async function pageLogin(context, username, password) {
  const page = await context.newPage()
  page.setDefaultTimeout(25_000)
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.locator('#username').waitFor({ state: 'visible' })
  await page.fill('#username', username)
  await page.fill('#password', password)
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
  return page
}

const browser = await chromium.launch({ headless: true })
const out = { base: BASE, startedAt: new Date().toISOString(), checks, paths, steps: {} }
const restore = { hostGrants: [], roles: [], policy: null, lisiProjectGrant: null }
let admin = null
let adminContext = null

try {
  // ---------------- baseline ----------------
  admin = await loginApi('admin', USER.admin)
  if (!admin.token) throw new Error(`admin login failed: ${JSON.stringify(admin.body)}`)
  const zhangsanLogin = await loginApi('zhangsan', USER.zhangsan)
  const lisiLogin = await loginApi('lisi', USER.lisi)
  const [usersRes, hostsRes, relaysRes, policyRes, statusRes, grant2Res, grant3Res] =
    await Promise.all([
      api(admin.token, '/v1/users'),
      api(admin.token, '/v1/hosts'),
      api(admin.token, '/v1/relays'),
      api(admin.token, '/v1/policies/download'),
      api(admin.token, '/v1/audit/status'),
      api(admin.token, `/v1/hosts/${HOST2}/grants`),
      api(admin.token, `/v1/hosts/${HOST3}/grants`)
    ])
  const users = usersRes.body.users ?? []
  const zhangsan = users.find((u) => u.username === 'zhangsan')
  const lisi = users.find((u) => u.username === 'lisi')
  if (!zhangsan || !lisi) throw new Error('zhangsan/lisi missing')
  for (const g of [...(grant2Res.body.grants ?? []), ...(grant3Res.body.grants ?? [])]) {
    if (g.username === 'zhangsan') restore.hostGrants.push(g)
  }
  restore.roles.push({ id: zhangsan.id, role: zhangsan.role })
  restore.roles.push({ id: lisi.id, role: lisi.role })
  restore.policy = { downloadDefault: policyRes.body.downloadDefault }
  out.steps.baseline = {
    zhangsanToken: Boolean(zhangsanLogin.token),
    zhangsanRole: zhangsan.role,
    lisiRole: lisi.role,
    relays: (relaysRes.body.relays ?? []).length,
    policy: policyRes.body,
    chain: statusRes.body.chain,
    capacity: statusRes.body.capacity,
    persisted: statusRes.body.persisted,
    zhangsanGrantHost2: (grant2Res.body.grants ?? []).find((g) => g.username === 'zhangsan'),
    lisiGrantHost3: (grant3Res.body.grants ?? []).find((g) => g.username === 'lisi') ?? null
  }
  console.log('baseline', JSON.stringify(out.steps.baseline))

  const adminContextCreated = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  })
  adminContext = adminContextCreated
  const page = await pageLogin(adminContextCreated, 'admin', USER.admin)
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  // ================= P1 relay refresh failure =================
  try {
    let failRelays = false
    const relayRequests = []
    page.on('request', (r) => {
      if (r.method() === 'GET' && new URL(r.url()).pathname === '/v1/relays') {
        relayRequests.push(Date.now())
      }
    })
    await page.route('**/v1/relays', async (route) => {
      if (route.request().method() === 'GET' && failRelays) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'RELAY_UNAVAILABLE', message: '注入的 503：中继服务不可用' }
          })
        })
        return
      }
      await route.continue()
    })
    await page.goto(`${BASE}/#/relays`, { waitUntil: 'domcontentloaded' })
    await page.locator('#refreshRelaysBtn').waitFor({ state: 'visible' })
    await page.locator('#content table').waitFor({ state: 'visible' })
    const rowsBefore = await page.locator('#content tbody tr').count()
    const reqBefore = relayRequests.length
    failRelays = true
    await page.click('#refreshRelaysBtn')
    await page.locator('#relayRefreshWarning').waitFor({ state: 'visible' })
    const bannerText = (await page.locator('#relayRefreshWarning').innerText()).replace(/\s+/g, ' ')
    const rowsAfterFail = await page.locator('#content tbody tr').count()
    const toastOnFail = await page.locator('.toast').count()
    await page.screenshot({ path: path.join(SHOTS, 'p1-failure.png'), fullPage: true })
    const reqAtFail = relayRequests.length
    await sleep(1300)
    const reqAfterIdle = relayRequests.length
    failRelays = false
    await page.click('#retryRelaysBtn')
    await page.locator('#relayRefreshWarning').waitFor({ state: 'detached' })
    const rowsAfterRetry = await page.locator('#content tbody tr').count()
    const reqAfterRetry = relayRequests.length
    await page.screenshot({ path: path.join(SHOTS, 'p1-success.png'), fullPage: true })
    writeJson('p1-relay-refresh.json', {
      rowsBefore,
      bannerText,
      rowsAfterFail,
      rowsAfterRetry,
      toastOnFail,
      relayRequests: relayRequests.map((t) => t - relayRequests[0]),
      reqBefore,
      reqAtFail,
      reqAfterIdle,
      reqAfterRetry
    })
    check('P1', 'failure banner names the reason', /刷新失败：.*503.*中继服务不可用/.test(bannerText), bannerText)
    check('P1', 'table keeps the previous rows', rowsBefore === rowsAfterFail && rowsAfterFail > 0, {
      rowsBefore,
      rowsAfterFail
    })
    check('P1', 'no toast on refresh failure', toastOnFail === 0, { toastOnFail })
    check('P1', 'no automatic retry within 1.2s', reqAfterIdle - reqAtFail === 0, {
      duringIdle: reqAfterIdle - reqAtFail
    })
    check('P1', 'retry reloads and clears the banner', reqAfterRetry - reqAtFail === 1 && rowsAfterRetry === rowsBefore, {
      retryRequests: reqAfterRetry - reqAtFail,
      rowsAfterRetry
    })
  } catch (err) {
    check('P1', 'path completed', false, String(err))
  }

  // ================= P2 audit health/capacity/verify + auditor empty filters =================
  try {
    await page.goto(`${BASE}/#/audit`, { waitUntil: 'domcontentloaded' })
    await page.locator('#auditHealth').waitFor({ state: 'visible' })
    await page.locator('#auditHealth > summary').click()
    const healthText = (await page.locator('#auditHealth').innerText()).replace(/\s+/g, ' ')
    const verifyResponse = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/v1/audit/verify' && r.request().method() === 'GET',
      { timeout: 20_000 }
    )
    await page.click('#auditVerify')
    await verifyResponse
    await page.locator('#auditVerifyResult').filter({ hasText: '校验通过' }).waitFor({ state: 'visible' })
    const verifyText = (await page.locator('#auditVerifyResult').innerText()).replace(/\s+/g, ' ')
    await page.screenshot({ path: path.join(SHOTS, 'p2-audit-health-verify.png'), fullPage: true })
    check(
      'P2',
      'health/capacity block readable',
      /链健康：正常/.test(healthText) &&
        /最后序号 \d+/.test(healthText) &&
        /文件事件今日 \d+ \/ \d+/.test(healthText) &&
        /累计 \d+ \/ \d+/.test(healthText) &&
        /持久化：已写入本地审计文件/.test(healthText),
      healthText
    )
    check('P2', 'verify result inline success text', /校验通过：已校验 \d+ 条/.test(verifyText), verifyText)

    const promote = await api(admin.token, `/v1/users/${lisi.id}/roles`, 'PUT', { role: 'auditor' })
    check('P2', 'temporary auditor promotion (lisi)', promote.status === 200, {
      status: promote.status,
      roles: promote.body?.roles
    })
    // lisi is seeded with an explicit open grant on demo-app, so the empty-picker
    // copy cannot be observed until that one row is temporarily removed.
    const lisiVisible = await api(lisiLogin.token, '/v1/projects')
    const removedProjectGrants = []
    for (const project of lisiVisible.body.projects ?? []) {
      const grants = await api(admin.token, `/v1/projects/${project.id}/grants`)
      const row = (grants.body.grants ?? []).find(
        (g) => g.subjectType === 'user' && g.username === 'lisi'
      )
      if (!row) continue
      removedProjectGrants.push({ projectId: project.id, permissions: row.permissions })
      await api(admin.token, `/v1/projects/${project.id}/grants`, 'PUT', {
        subjectType: 'user',
        subjectId: 'lisi',
        permissions: []
      })
    }
    restore.lisiProjectGrant = removedProjectGrants
    const lisiContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 900 }
    })
    const lisiPage = await pageLogin(lisiContext, 'lisi', USER.lisi)
    await lisiPage.goto(`${BASE}/#/audit`, { waitUntil: 'domcontentloaded' })
    await lisiPage.locator('#auditProject').waitFor({ state: 'visible' })
    await lisiPage.locator('#content table').waitFor({ state: 'visible' })
    const projectOptions = await lisiPage.locator('#auditProject option').evaluateAll((options) =>
      options.map((o) => ({ text: o.textContent.trim(), disabled: o.disabled, value: o.value }))
    )
    const hostOptions = await lisiPage.locator('#auditHost option').evaluateAll((options) =>
      options.map((o) => ({ text: o.textContent.trim(), disabled: o.disabled, value: o.value }))
    )
    const eventRowCount = await lisiPage.locator('#content tbody tr').count()
    const eventBody = await lisiPage.locator('#content tbody').innerText()
    await lisiPage.screenshot({ path: path.join(SHOTS, 'p2-auditor-empty-filters.png'), fullPage: true })
    writeJson('p2-auditor.json', {
      healthText,
      verifyText,
      promoteStatus: promote.status,
      projectOptions,
      hostOptions,
      eventRowCount,
      eventBodyHead: eventBody.slice(0, 300),
      removedProjectGrants
    })
    check(
      'P2',
      'auditor project picker explains no visible project',
      projectOptions.some((o) => o.text === '无可见项目（需 open 授权）' && o.disabled),
      projectOptions
    )
    check(
      'P2',
      'auditor host picker explains no visible host',
      hostOptions.some((o) => o.text === '无可见主机（需主机权限）' && o.disabled),
      hostOptions
    )
    check(
      'P2',
      'auditor event list still renders',
      eventRowCount > 0 && !eventBody.includes('没有符合筛选条件'),
      { eventRowCount }
    )
    await lisiContext.close()
    for (const grant of restore.lisiProjectGrant) {
      await api(admin.token, `/v1/projects/${grant.projectId}/grants`, 'PUT', {
        subjectType: 'user',
        subjectId: 'lisi',
        permissions: grant.permissions
      })
    }
    restore.lisiProjectGrant = null
    const demote = await api(admin.token, `/v1/users/${lisi.id}/roles`, 'PUT', { role: 'developer' })
    check('P2', 'auditor role restored to developer', demote.status === 200, {
      status: demote.status,
      roles: demote.body?.roles
    })
  } catch (err) {
    check('P2', 'path completed', false, String(err))
  }

  // ================= P3 host grant shrink revokes =================
  try {
    const zhangsanToken = zhangsanLogin.token
    const beforeAvailable = await api(zhangsanToken, '/v1/hosts/available')
    const beforeHost2 = (beforeAvailable.body.hosts ?? []).find((h) => h.id === HOST2)
    const shrink = await api(admin.token, `/v1/hosts/${HOST2}/grants`, 'PUT', {
      subjectType: 'user',
      subjectId: 'zhangsan',
      permissions: ['view']
    })
    await sleep(150)
    const afterAvailable = await api(zhangsanToken, '/v1/hosts/available')
    const afterHost2 = (afterAvailable.body.hosts ?? []).find((h) => h.id === HOST2)
    const meAfter = await api(zhangsanToken, '/v1/me')
    const deniedProvision = await api(zhangsanToken, '/v1/projects/self', 'POST', {
      name: `r7-deny-${Date.now()}`,
      hostId: HOST2,
      dir: 'r7-deny'
    })
    const eventsAfterShrink = await api(
      admin.token,
      '/v1/audit/events?eventType=host_grant_update&limit=50'
    )
    const shrinkEvent = auditFind(
      eventsAfterShrink.body.events ?? [],
      (e) =>
        e.targetId === HOST2 &&
        e.result === 'success' &&
        e.metadata?.username === 'zhangsan' &&
        (e.metadata?.permissions ?? []).join(',') === 'view'
    )
    // Negative control: expanding lisi must not revoke her session.
    const lisiBefore = await api(lisiLogin.token, '/v1/me')
    const expand = await api(admin.token, `/v1/hosts/${HOST3}/grants`, 'PUT', {
      subjectType: 'user',
      subjectId: 'lisi',
      permissions: ['view', 'provision']
    })
    await sleep(150)
    const lisiAfter = await api(lisiLogin.token, '/v1/me')
    const eventsAfterExpand = await api(
      admin.token,
      '/v1/audit/events?eventType=host_grant_update&limit=50'
    )
    const expandEvent = auditFind(
      eventsAfterExpand.body.events ?? [],
      (e) =>
        e.targetId === HOST3 &&
        e.result === 'success' &&
        e.metadata?.username === 'lisi' &&
        (e.metadata?.permissions ?? []).join(',') === 'view,provision'
    )
    writeJson('p3-grant-shrink.json', {
      beforeAvailable: beforeHost2,
      afterAvailable: afterHost2,
      shrinkStatus: shrink.status,
      zhangsanMeAfterShrink: meAfter.status,
      deniedProvision: { status: deniedProvision.status, body: deniedProvision.body },
      shrinkEvent: shrinkEvent ?? null,
      expandStatus: expand.status,
      lisiBefore: lisiBefore.status,
      lisiAfter: lisiAfter.status,
      expandEvent: expandEvent ?? null,
      persistedUserRevocations: readPersistedUserRevocations()
    })
    check('P3', 'full grant downgraded to read-only', shrink.status === 200 && afterHost2?.accessLevel === 'read-only', {
      beforeLevel: beforeHost2?.accessLevel,
      afterLevel: afterHost2?.accessLevel,
      status: shrink.status
    })
    check(
      'P3',
      'host_grant_update carries removedPermissions/revokedUsers/accessLevel',
      shrinkEvent?.metadata?.removedPermissions?.includes('provision') === true &&
        shrinkEvent?.metadata?.revokedUsers === 1 &&
        shrinkEvent?.metadata?.accessLevel === 'read-only',
      shrinkEvent?.metadata ?? null
    )
    check('P3', 'old platform token still authenticated after shrink', meAfter.status === 200, {
      status: meAfter.status
    })
    check(
      'P3',
      'old token host request is 401 (as path states)',
      deniedProvision.status === 401,
      {
        expected: 401,
        observed: deniedProvision.status,
        code: deniedProvision.body?.error?.code,
        note: 'platform session survives; live host bits gate to 403 HOST_PROVISION_FORBIDDEN; host ticket revocation is the revokedUsers=1 record'
      }
    )
    check('P3', 'lisi expansion does not revoke her session', expand.status === 200 && lisiAfter.status === 200, {
      expandStatus: expand.status,
      before: lisiBefore.status,
      after: lisiAfter.status
    })
    check(
      'P3',
      'lisi expansion audit has no removals',
      expandEvent?.metadata?.removedPermissions?.length === 0 &&
        expandEvent?.metadata?.revokedUsers === 0 &&
        expandEvent?.metadata?.accessLevel === 'full',
      expandEvent?.metadata ?? null
    )
  } catch (err) {
    check('P3', 'path completed', false, String(err))
  }

  // ================= P4 download policy 409 =================
  try {
    const before = await api(admin.token, '/v1/policies/download')
    const versionN = before.body.version
    const original = before.body.downloadDefault
    const flip = original === 'allow' ? 'deny' : 'allow'
    await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
    await page.locator('#savePolicy').waitFor({ state: 'visible' })
    const pageVersionText = await page.locator('#content').innerText()
    const bWrite = await api(admin.token, '/v1/policies/download', 'PUT', {
      downloadDefault: flip,
      expectedVersion: versionN
    })
    if (bWrite.status !== 200) throw new Error(`B write failed: ${bWrite.status}`)
    const versionN1 = bWrite.body.version
    const staleResponse = page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' &&
        new URL(r.url()).pathname === '/v1/policies/download',
      { timeout: 20_000 }
    )
    await page.click('#savePolicy')
    const stale = await staleResponse
    const conflict = page.locator('#policyConflict')
    await conflict.waitFor({ state: 'visible' })
    const conflictText = (await conflict.innerText()).replace(/\s+/g, ' ')
    const keptChoice = await page.locator('input[name=dl]:checked').inputValue()
    const serverAfterConflict = await api(admin.token, '/v1/policies/download')
    await page.screenshot({ path: path.join(SHOTS, 'p4-conflict.png'), fullPage: true })
    const retryResponse = page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' &&
        new URL(r.url()).pathname === '/v1/policies/download',
      { timeout: 20_000 }
    )
    await page.click('#policyConflictRetry')
    const retried = await retryResponse
    await conflict.waitFor({ state: 'hidden' })
    const serverAfterRetry = await api(admin.token, '/v1/policies/download')
    await page.screenshot({ path: path.join(SHOTS, 'p4-after-retry.png'), fullPage: true })
    const auditEvents = await api(
      admin.token,
      '/v1/audit/events?eventType=policy_update&limit=50'
    )
    const failureEvent = auditFind(
      auditEvents.body.events ?? [],
      (e) =>
        e.result === 'failure' &&
        e.metadata?.reason === 'POLICY_VERSION_CONFLICT' &&
        e.metadata?.expectedVersion === versionN
    )
    const successB = auditFind(
      auditEvents.body.events ?? [],
      (e) =>
        e.result === 'success' &&
        e.metadata?.expectedVersion === versionN &&
        e.metadata?.resultVersion === versionN1
    )
    const successRetry = auditFind(
      auditEvents.body.events ?? [],
      (e) =>
        e.result === 'success' &&
        e.metadata?.expectedVersion === versionN1 &&
        e.metadata?.resultVersion === versionN1 + 1
    )
    writeJson('p4-policy-conflict.json', {
      versionN,
      original,
      flip,
      pageShowsVersion: new RegExp(`当前版本 v${versionN}\\b`).test(pageVersionText),
      bWrite: { status: bWrite.status, body: bWrite.body },
      staleResponse: stale.status(),
      conflictText,
      keptChoice,
      serverAfterConflict: serverAfterConflict.body,
      retried: retried.status(),
      serverAfterRetry: serverAfterRetry.body,
      failureEvent: failureEvent ?? null,
      successB: successB ?? null,
      successRetry: successRetry ?? null
    })
    check('P4', 'stale save gets 409', stale.status() === 409, { status: stale.status() })
    check(
      'P4',
      'conflict bar shows server version/value and kept choice',
      /策略已被他人修改/.test(conflictText) &&
        new RegExp(`服务端当前版本 v${versionN1}`).test(conflictText) &&
        /全局默认 禁止/.test(conflictText) &&
        /你选择的「允许」尚未保存/.test(conflictText) &&
        keptChoice === original,
      { conflictText, keptChoice }
    )
    check(
      'P4',
      'stale save did not overwrite the other admin',
      serverAfterConflict.body.downloadDefault === flip && serverAfterConflict.body.version === versionN1,
      serverAfterConflict.body
    )
    check(
      'P4',
      'refresh-retry saves successfully',
      retried.status() === 200 &&
        serverAfterRetry.body.downloadDefault === original &&
        serverAfterRetry.body.version === versionN1 + 1,
      { retried: retried.status(), serverAfterRetry: serverAfterRetry.body }
    )
    check(
      'P4',
      'audit records expectedVersion/resultVersion on conflict and success',
      failureEvent?.metadata?.expectedVersion === versionN &&
        failureEvent?.metadata?.resultVersion === versionN1 &&
        Boolean(successB) &&
        Boolean(successRetry),
      {
        failureEvent: failureEvent ?? null,
        successB: successB ?? null,
        successRetry: successRetry ?? null
      }
    )
  } catch (err) {
    check('P4', 'path completed', false, String(err))
  }

  // ================= P5 regression spot checks =================
  try {
    await page.goto(`${BASE}/#/hosts`, { waitUntil: 'domcontentloaded' })
    await page.locator(`[data-host="${HOST2}"]`).waitFor({ state: 'visible' })
    await page.locator(`[data-host="${HOST2}"]`).click()
    await page.locator('.drawer-backdrop .drawer').waitFor({ state: 'visible' })
    const revokeVisible = await page.locator('#revokeHostBtn').isVisible()
    const maintenanceVisible = await page.locator('#maintenanceBtn').isVisible()
    const revokeText = await page.locator('#revokeHostBtn').innerText()
    await page.screenshot({ path: path.join(SHOTS, 'p5-hosts.png'), fullPage: true })
    check('P5', 'hosts revoke/maintenance controls exist', revokeVisible && maintenanceVisible, {
      revokeText,
      maintenanceVisible
    })
    await page.click('.drawer-backdrop .drawer-head .icon-btn')

    await page.goto(`${BASE}/#/users`, { waitUntil: 'domcontentloaded' })
    await page.locator(`[data-user-detail="${zhangsan.id}"]`).waitFor({ state: 'visible' })
    await page.locator(`[data-user-detail="${zhangsan.id}"]`).click()
    await page.locator('.dialog-backdrop [data-detail-role]').last().waitFor({ state: 'visible' })
    const toAuditor = page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' &&
        new URL(r.url()).pathname === `/v1/users/${zhangsan.id}/roles`,
      { timeout: 20_000 }
    )
    await page.locator('.dialog-backdrop [data-detail-role]').last().selectOption('auditor')
    await page.locator('.dialog-backdrop').last().locator('[data-action="0"]').click()
    const auditorResp = await toAuditor
    await sleep(300)
    const toDeveloper = page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' &&
        new URL(r.url()).pathname === `/v1/users/${zhangsan.id}/roles`,
      { timeout: 20_000 }
    )
    await page.locator('.dialog-backdrop [data-detail-role]').last().selectOption('developer')
    await page.locator('.dialog-backdrop').last().locator('[data-action="0"]').click()
    const developerResp = await toDeveloper
    await sleep(300)
    const afterRoles = await api(admin.token, '/v1/users')
    const zhangsanRole = (afterRoles.body.users ?? []).find((u) => u.username === 'zhangsan')?.role
    await page.screenshot({ path: path.join(SHOTS, 'p5-users-role.png'), fullPage: true })
    await page
      .locator('.dialog-backdrop [data-action="close"]')
      .last()
      .click()
      .catch(() => {})

    await page.goto(`${BASE}/#/audit`, { waitUntil: 'domcontentloaded' })
    await page.locator('#auditType').waitFor({ state: 'visible' })
    const filterResponse = page.waitForResponse(
      (r) => {
        const url = new URL(r.url())
        return (
          url.pathname === '/v1/audit/events' && url.searchParams.get('eventType') === 'role_update'
        )
      },
      { timeout: 20_000 }
    )
    await page.locator('#auditType').selectOption('role_update')
    await page.click('#auditApply')
    const filterResp = await filterResponse
    await sleep(300)
    const filterRows = await page.locator('#content tbody tr').count()
    const filterBody = await page.locator('#content tbody').innerText()
    const filterUrl = new URL(filterResp.url())
    await page.screenshot({ path: path.join(SHOTS, 'p5-audit-filter.png'), fullPage: true })
    writeJson('p5-regression.json', {
      revokeVisible,
      revokeText,
      maintenanceVisible,
      roleChangeStatuses: { toAuditor: auditorResp.status(), toDeveloper: developerResp.status() },
      zhangsanRoleAfter: zhangsanRole,
      auditFilter: {
        status: filterResp.status(),
        eventType: filterUrl.searchParams.get('eventType'),
        rows: filterRows,
        bodyHead: filterBody.slice(0, 400)
      }
    })
    check(
      'P5',
      'users detail role change on enabled account returns 200',
      auditorResp.status() === 200 && developerResp.status() === 200 && zhangsanRole === 'developer',
      { toAuditor: auditorResp.status(), toDeveloper: developerResp.status(), finalRole: zhangsanRole }
    )
    check(
      'P5',
      'audit filter sends eventType=role_update and renders rows',
      filterUrl.searchParams.get('eventType') === 'role_update' &&
        filterRows > 0 &&
        filterBody.includes('role_update'),
      { rows: filterRows, sample: filterBody.slice(0, 160) }
    )
  } catch (err) {
    check('P5', 'path completed', false, String(err))
  }
} catch (err) {
  out.fatal = String(err)
  console.error('FATAL', err)
} finally {
  // ---- cleanup: restore grants/policy/roles ----
  try {
    if (admin?.token) {
      for (const grant of restore.lisiProjectGrant ?? []) {
        await api(admin.token, `/v1/projects/${grant.projectId}/grants`, 'PUT', {
          subjectType: 'user',
          subjectId: 'lisi',
          permissions: grant.permissions
        })
      }
      for (const grant of restore.hostGrants) {
        await api(admin.token, `/v1/hosts/${grant.hostId}/grants`, 'PUT', {
          subjectType: grant.subjectType,
          subjectId: grant.subjectId,
          permissions: grant.permissions
        })
      }
      // lisi had no host-3 grant before the test; removing it is the restore.
      await api(admin.token, `/v1/hosts/${HOST3}/grants`, 'PUT', {
        subjectType: 'user',
        subjectId: 'lisi',
        permissions: []
      })
      for (const role of restore.roles) {
        await api(admin.token, `/v1/users/${role.id}/roles`, 'PUT', { role: role.role })
      }
      if (restore.policy) {
        const current = await api(admin.token, '/v1/policies/download')
        if (current.body.downloadDefault !== restore.policy.downloadDefault) {
          await api(admin.token, '/v1/policies/download', 'PUT', {
            downloadDefault: restore.policy.downloadDefault,
            expectedVersion: current.body.version
          })
        }
      }
      const [g2, g3, usersFinal, policyFinal, demoGrants] = await Promise.all([
        api(admin.token, `/v1/hosts/${HOST2}/grants`),
        api(admin.token, `/v1/hosts/${HOST3}/grants`),
        api(admin.token, '/v1/users'),
        api(admin.token, '/v1/policies/download'),
        api(admin.token, '/v1/projects/proj_4b5721f0/grants')
      ])
      out.cleanup = {
        host2Grants: g2.body.grants,
        host3Grants: g3.body.grants,
        lisiDemoGrant: (demoGrants.body.grants ?? []).find(
          (g) => g.subjectType === 'user' && g.username === 'lisi'
        ),
        roles: (usersFinal.body.users ?? []).map((u) => ({ username: u.username, role: u.role })),
        policy: policyFinal.body
      }
      check(
        'P5',
        'test environment restored (grants/roles/policy)',
        (g2.body.grants ?? []).some(
          (g) => g.username === 'zhangsan' && (g.permissions ?? []).join(',') === 'view,provision'
        ) &&
          !(g3.body.grants ?? []).some((g) => g.username === 'lisi') &&
          (demoGrants.body.grants ?? []).some(
            (g) =>
              g.subjectType === 'user' &&
              g.username === 'lisi' &&
              (g.permissions ?? []).join(',') === 'open,file:read'
          ) &&
          (usersFinal.body.users ?? []).every(
            (u) =>
              (u.username === 'zhangsan' && u.role === 'developer') ||
              (u.username === 'lisi' && u.role === 'developer') ||
              u.username === 'admin'
          ) &&
          policyFinal.body.downloadDefault === restore.policy.downloadDefault,
        out.cleanup
      )
    }
  } catch (cleanupErr) {
    out.cleanupError = String(cleanupErr)
    console.error('CLEANUP ERROR', cleanupErr)
  }
  out.finishedAt = new Date().toISOString()
  out.ok = Object.values(paths).every(Boolean)
  writeJson('r7-summary.json', out)
  if (adminContext) await adminContext.close().catch(() => {})
  await browser.close()
  console.log('\nSUMMARY', JSON.stringify({ paths, checks: checks.length }))
  for (const c of checks) {
    console.log(`${c.status} ${c.pathId} ${c.id}`)
  }
  process.exitCode = out.ok ? 0 : 1
}
