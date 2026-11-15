#!/usr/bin/env node
/**
 * Replayable read-only checks for the Orca Cloud admin web console (R2).
 * Usage: node cloud-platform/scripts/exploratory-r2/web-console-paths.mjs
 * Env: ORCA_QA_BASE, ORCA_QA_USER, ORCA_QA_PASS
 * Never mutates grants/policies/hosts; only logs in, navigates, searches, opens dialogs, and logs out.
 */
import { chromium } from 'playwright'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const USER = process.env.ORCA_QA_USER ?? 'admin'
const PASS = process.env.ORCA_QA_PASS ?? 'Adm1n!'
const checks = []

function check(id, ok, detail, knownFinding = null) {
  checks.push({ id, status: ok ? 'PASS' : 'FAIL', knownFinding, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${knownFinding ? ` (${knownFinding})` : ''}: ${detail}`)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  const text = async (sel) => (await page.locator(sel).first().innerText()).trim()
  const api = (path) =>
    page.evaluate(async (p) => {
      const t = localStorage.getItem('orca.access')
      const r = await fetch(p, { headers: { authorization: `Bearer ${t}` } })
      return { status: r.status, body: await r.json() }
    }, path)

  try {
    // ---- login ----
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.locator('#loginForm').waitFor({ state: 'visible' })
    await page.click('#loginBtn')
    const emptyErr = (await text('#loginError')).trim()
    check('L1 empty submit', emptyErr.includes('请输入域账号和密码'), emptyErr)

    await page.fill('#username', '   ')
    await page.fill('#password', 'x')
    await page.click('#loginBtn')
    check('L2 whitespace username', (await text('#loginError')).includes('请输入域账号和密码'), 'client-side blocked')

    await page.fill('#username', USER)
    await page.fill('#password', PASS)
    await page.click('#loginBtn')
    await page.locator('#view-app').waitFor({ state: 'visible' })
    check('L6 admin login', (await text('#roleChip')) === '平台管理员', await text('#roleChip'))

    // ---- workbench data consistency ----
    const stats = await page.locator('.stat').allInnerTexts()
    const rows = await page.locator('#content tbody tr').count()
    const apiProjects = await api('/v1/projects?includeArchived=1')
    const projects = apiProjects.body.projects ?? []
    const online = projects.filter((p) => p.hostStatus === 'online').length
    const archived = projects.filter((p) => p.status === 'archived').length
    const statNum = (label) => {
      const line = stats.find((s) => s.includes(label)) ?? ''
      return Number((line.match(/(\d+)/) ?? [])[1] ?? NaN)
    }
    check(
      'W1 stats match API',
      statNum('可访问项目') === projects.length && statNum('主机在线') === online && rows === projects.length,
      `dom=${statNum('可访问项目')}/${statNum('主机在线')}/${rows} api=${projects.length}/${online}`
    )
    check(
      'W1b archived excluded from stats',
      archived === 0,
      `archived=${archived} of ${projects.length} still counted/rendered`,
      archived > 0 ? 'WEB-R2-003' : null
    )

    // ---- projects search ----
    await page.getByRole('button', { name: '我的项目' }).click()
    await page.locator('#projectSearch').waitFor({ state: 'visible' })
    await page.fill('#projectSearch', 'zhang')
    const zhangRows = await page.locator('#projectBody tr').count()
    check('P1 search by name', zhangRows >= 2, `rows=${zhangRows}`)
    await page.fill('#projectSearch', 'dev-local-03')
    check('P1b search by host', (await page.locator('#projectBody tr').count()) >= 1, 'rows>=1')
    await page.fill('#projectSearch', 'no-such-project-r2')
    check('P1c empty state', (await page.locator('#projectBody').innerText()).includes('没有匹配的项目'), 'empty row')
    await page.fill('#projectSearch', '')
    await page.waitForTimeout(200)

    // ---- register dialog (client validation only) ----
    await page.getByRole('button', { name: '登记项目' }).click()
    await page.locator('#regName').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '登记', exact: true }).click()
    const regErrors = (await page.locator('.dialog .body').innerText()).replace(/\s+/g, ' ')
    check(
      'P2 register empty validation',
      ['项目名称不能为空', '长度必须为 1–64', '请选择目标主机', '项目路径不能为空'].every((s) => regErrors.includes(s)),
      regErrors.slice(0, 140)
    )
    await page.fill('#regKey', 'PaymentService')
    await page.locator('#regKey').blur()
    check('P2b key blur validation', (await text('#regKeyError')).includes('必须以小写字母或数字开头'), await text('#regKeyError'))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)

    // ---- project detail ----
    const demoRow = page.locator('#projectBody tr').filter({ hasText: 'demo-app' }).first()
    await demoRow.getByRole('button', { name: '详情' }).click()
    const detail = (await text('.dialog .body')).replace(/\s+/g, ' ')
    check(
      'D1 detail fields',
      ['项目 Key', '项目 ID', '创建者', '运行配置', '宿主状态', '授权与策略', '下载策略'].every((s) => detail.includes(s)),
      detail.slice(0, 160)
    )
    check('D2 detail status ready', detail.includes('就绪'), '项目状态=就绪')
    await page.keyboard.press('Escape')

    // ---- hosts ----
    await page.getByRole('button', { name: '主机' }).click()
    await page.locator('#registerHostBtn').waitFor({ state: 'visible' })
    const hostRows = await page.locator('#content tbody tr').count()
    check('H1 hosts listed', hostRows >= 3, `rows=${hostRows}`)
    const blankHost = (await page.locator('#content tbody tr').allInnerTexts()).some((t) => /^\s*intranet\s*—/m.test(t))
    check('H1b blank host name guarded', !blankHost, blankHost ? 'nameless host row rendered' : 'no blank row', blankHost ? 'WEB-R2-006' : null)
    const dev2Row = page.locator('#content tbody tr').filter({ hasText: 'dev-local-02' }).first()
    if ((await dev2Row.count()) > 0) {
      await dev2Row.getByRole('button', { name: '详情' }).click()
      const drawer = (await text('.drawer')).replace(/\s+/g, ' ')
      const hostsApi = await api('/v1/hosts')
      const dev2 = (hostsApi.body.hosts ?? []).find((h) => h.name === 'dev-local-02')
      check(
        'H2 drawer shows TLS fingerprint',
        Boolean(dev2?.tlsFingerprint) && drawer.includes(dev2.tlsFingerprint),
        `tlsFingerprint=${dev2?.tlsFingerprint ?? '(none)'}`,
        dev2?.tlsFingerprint && !drawer.includes(dev2.tlsFingerprint) ? 'WEB-R2-007' : null
      )
      // The drawer has no Esc handler; its header ✕ is the documented close path.
      await page.locator('.drawer .icon-btn').click()
      await page.waitForTimeout(150)
    }

    // ---- members ----
    await page.getByRole('button', { name: '成员与权限' }).click()
    await page.locator('#grantPanel').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'demo-app' }).click()
    await page.waitForTimeout(300)
    const headers = (await page.locator('#grantPanel thead th').allInnerTexts()).map((h) => h.trim().toLowerCase())
    check('M1 matrix 7 permissions', ['open', 'terminal', 'agent', 'file:read', 'file:write', 'browser', 'download'].every((p) => headers.includes(p)), headers.join(','))
    const grantRows = await page.locator('#grantPanel tbody tr').count()
    check('M2 grants listed', grantRows >= 3, `rows=${grantRows}`)

    // ---- audit ----
    await page.getByRole('button', { name: '审计日志' }).click()
    await page.locator('#auditApply').waitFor({ state: 'visible' })
    const auditHeader = await text('#content .page-head p')
    check('A1 audit first page', auditHeader.includes('已显示 50 条'), auditHeader)
    await page.locator('#auditType').selectOption('login')
    await page.click('#auditApply')
    await page.waitForTimeout(300)
    const types = await page.locator('#content tbody tr td:nth-child(3)').allInnerTexts()
    check('A2 event filter', types.length > 0 && types.every((t) => t.trim() === 'login'), `rows=${types.length}`)
    await page.click('#auditReset')
    await page.waitForTimeout(300)
    await page.click('#auditMore')
    await page.waitForTimeout(400)
    check('A3 load more', (await text('#content .page-head p')).includes('已显示 100 条'), await text('#content .page-head p'))
    const traceDupes = await page.evaluate(() => {
      const counts = new Map()
      for (const tr of document.querySelectorAll('#content tbody tr')) {
        const key = tr.cells[5]?.textContent?.trim()
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return [...counts.values()].filter((n) => n > 3).length
    })
    check('A4 trace uniqueness', traceDupes === 0, `${traceDupes} traceId(s) repeated >3 times`, traceDupes ? 'WEB-R2-010' : null)

    // ---- settings ----
    await page.getByRole('button', { name: '平台设置' }).click()
    await page.locator('#savePolicy').waitFor({ state: 'visible' })
    const scope = await text('#policyScope')
    const overrides = await page.locator('[data-policy-select]').count()
    check('S1 policy scope rendered', /跟随全局默认.*个项目.*独立覆盖.*个项目/.test(scope.replace(/\s+/g, '')), scope.replace(/\s+/g, ' '))
    check('S2 overrides table matches count', scope.includes(String(overrides)), `selects=${overrides} scope=${scope.replace(/\s+/g, ' ')}`)

    // ---- forbidden preview ----
    await page.getByRole('button', { name: '查看无权限页' }).click()
    const forbidden = (await text('#content')).replace(/\s+/g, ' ')
    check('F1 forbidden page', forbidden.includes('无权访问') && forbidden.includes('返回工作台'), forbidden.slice(0, 80))
    await page.getByRole('button', { name: '返回工作台' }).click()

    // ---- logout credential retention ----
    await page.click('#logoutBtn')
    await page.locator('#loginForm').waitFor({ state: 'visible' })
    const retained = await page.evaluate(() => ({
      username: document.querySelector('#username').value,
      password: document.querySelector('#password').value,
      access: localStorage.getItem('orca.access')
    }))
    check(
      'X1 logout clears form',
      retained.username === '' && retained.password === '',
      `username='${retained.username}' passwordLength=${retained.password.length} tokensCleared=${retained.access === null}`,
      retained.username !== '' || retained.password !== '' ? 'WEB-R2-002' : null
    )
  } catch (err) {
    console.error('FATAL', err)
    check('RUN', false, String(err))
  } finally {
    await context.close()
    await browser.close()
  }

  const summary = {
    base: BASE,
    user: USER,
    passed: checks.filter((c) => c.status === 'PASS').length,
    failed: checks.filter((c) => c.status === 'FAIL').length,
    knownFindings: [...new Set(checks.map((c) => c.knownFinding).filter(Boolean))],
    consoleErrors: consoleErrors.slice(0, 20)
  }
  console.log('\nSUMMARY ' + JSON.stringify(summary, null, 2))
}

main()
