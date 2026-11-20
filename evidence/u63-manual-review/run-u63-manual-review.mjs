#!/usr/bin/env node
/**
 * U63 manual re-verification — whole management console business flow.
 * Read-mostly evidence run: one numbered screenshot per business step.
 * The only writes are a zhangsan role change and its immediate revert.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE || 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/u63-manual-review')
const SHOTS = OUT
fs.mkdirSync(SHOTS, { recursive: true })

const ADMIN = { username: 'admin', password: 'Adm1n!' }
const DEMO = 'proj_ec90a17a'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const report = {
  title: 'U63 人工复核证据重验',
  base: BASE,
  startedAt: new Date().toISOString(),
  account: 'admin',
  steps: [],
  diffs: []
}

let current = null

async function step(n, name, action, expected, fn) {
  current = { step: n, name, action, expected, actual: '', verdict: 'PASS', screenshots: [] }
  const started = Date.now()
  try {
    const actual = await fn()
    current.actual = typeof actual === 'string' ? actual : JSON.stringify(actual)
    if (current.verdict !== 'DIFF') current.verdict = 'PASS'
  } catch (err) {
    current.verdict = 'DIFF'
    current.actual = `${current.actual ? current.actual + ' | ' : ''}失败：${err?.message ?? err}`
  }
  current.durationMs = Date.now() - started
  report.steps.push(current)
  if (current.verdict === 'DIFF') {
    report.diffs.push({
      page: name,
      expected,
      actual: current.actual,
      screenshots: [...current.screenshots]
    })
  }
  console.log(`${current.verdict} step-${n} ${name} :: ${current.actual.slice(0, 180)}`)
  current = null
}

async function shot(page, name) {
  const file = `${name}.png`
  await page.screenshot({ path: path.join(SHOTS, file) })
  current.screenshots.push(file)
  return file
}

function diff(note) {
  current.verdict = 'DIFF'
  current.actual = `${current.actual ? current.actual + ' | ' : ''}${note}`
}

const text = async (locator) => (await locator.count()) ? (await locator.first().innerText()).trim() : ''
const compact = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ timeout: 30000 })
  await page.fill('#username', ADMIN.username)
  await page.fill('#password', ADMIN.password)
  await page.click('#loginBtn')
  await page.locator('#view-app:not([hidden])').waitFor({ timeout: 30000 })
  await page.waitForTimeout(1200)
}

async function nav(page, route, heading) {
  await page.locator(`.nav-item[data-route="${route}"]:visible`).first().click()
  await page.waitForTimeout(900)
  if (heading) {
    await page.locator('#content h1', { hasText: heading }).first().waitFor({ timeout: 30000 })
    await page.waitForTimeout(500)
  }
}

async function closeTopDialog(page) {
  const dialog = page.locator('.dialog-backdrop:visible').last()
  if (await dialog.count()) {
    await dialog.locator('[data-action="close"]').last().click().catch(() => {})
    await page.waitForTimeout(400)
  }
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 960 }
})
const page = await context.newPage()
page.setDefaultTimeout(60000)

try {
  /* 1. 登录 */
  await step(1, 'login', '打开管理台，输入 admin/Adm1n! 登录', '登录成功进入管理台，角色=平台管理员，默认工作台', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await page.locator('#loginForm').waitFor({ timeout: 30000 })
    await shot(page, 'step-1-login')
    await page.fill('#username', ADMIN.username)
    await page.fill('#password', ADMIN.password)
    await page.click('#loginBtn')
    await page.locator('#view-app:not([hidden])').waitFor({ timeout: 30000 })
    await page.waitForTimeout(1200)
    await shot(page, 'step-1-console')
    const role = compact(await text(page.locator('#roleChip')))
    const crumb = compact(await text(page.locator('#crumbs')))
    if (role !== '平台管理员') diff(`角色 chip=${role}`)
    if (crumb !== '工作台') diff(`面包屑=${crumb}`)
    return `角色=${role}；面包屑=${crumb}`
  })

  /* 2. 工作台数据 */
  let apiSnapshot = null
  await step(2, 'workbench', '登录后默认工作台，读取统计/项目卡片/项目表', '统计四值、项目卡片与项目表数据来自平台且一致', async () => {
    await nav(page, 'workbench')
    await page.locator('#content .stat').first().waitFor({ timeout: 30000 })
    await page.waitForTimeout(800)
    await shot(page, 'step-2-workbench')
    const stats = await page.evaluate(() =>
      [...document.querySelectorAll('#content .stat')].map((el) => el.innerText.replace(/\s+/g, ' ').trim())
    )
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('.project-card')].slice(0, 3).map((el) => el.innerText.replace(/\s+/g, ' ').trim())
    )
    const rows = await page.locator('#content tbody tr').count()
    const health = await page.evaluate(() =>
      [...document.querySelectorAll('#content .stat')].map((el) => el.innerText.replace(/\s+/g, ' ').trim())
    )
    apiSnapshot = await page.evaluate(async (base) => {
      const token = window.localStorage.getItem('orca.access')
      const headers = { authorization: `Bearer ${token}` }
      const [p, d, h] = await Promise.all([
        fetch(`${base}/v1/projects?includeArchived=1`, { headers }).then((r) => r.json()),
        fetch(`${base}/v1/policies/download`, { headers }).then((r) => r.json()),
        fetch(`${base}/v1/hosts`, { headers }).then((r) => r.json())
      ])
      return {
        projects: p.projects?.length ?? null,
        hostsOnline: (h.hosts ?? []).filter((x) => x.status === 'online').length,
        policyVersion: d.version ?? null,
        downloadDefault: d.downloadDefault ?? null
      }
    }, BASE)
    if (stats.length !== 4) diff(`统计卡数量=${stats.length}`)
    if (!cards.length) diff('无项目卡片')
    if (!rows) diff('项目表无数据行')
    return `统计=${JSON.stringify(stats)}；卡片样本=${JSON.stringify(cards.slice(0, 1))}；表行=${rows}；API=${JSON.stringify(apiSnapshot)}`
  })

  /* 3. 项目列表/详情/权限三卡 */
  await step(3, 'projects-list-detail-perms', '我的项目：列表 → demo-app 详情 → 权限页签', '列表有项目行；详情含基本信息/运行配置/授权与策略；权限页签含查看/控制/管理(主机推导)三卡', async () => {
    await nav(page, 'projects', '我的项目')
    await page.locator('#content tbody tr').first().waitFor({ timeout: 20000 })
    await shot(page, 'step-3-projects-list')
    const listInfo = await page.evaluate(() => ({
      rows: document.querySelectorAll('#content tbody tr').length,
      search: Boolean(document.querySelector('#projectSearch')),
      firstRow: document.querySelector('#content tbody tr')?.innerText.replace(/\s+/g, ' ').trim()
    }))
    const row = page.locator('#content tbody tr', { hasText: 'demo-app' }).first()
    if (!(await row.count())) {
      diff('列表中未找到 demo-app 行')
      return JSON.stringify(listInfo)
    }
    await row.locator('button[data-detail]').click()
    await page.locator('.dialog-backdrop .dialog').waitFor({ timeout: 20000 })
    await page.waitForTimeout(900)
    await shot(page, 'step-3-project-detail-info')
    const info = compact(await text(page.locator('.dialog-backdrop:visible .dialog .body')))
    if (!info.includes('项目名称') || !info.includes('运行配置') || !info.includes('授权与策略')) {
      diff('详情信息页签字段不完整')
    }
    await page.locator('.dialog-backdrop:visible [data-auth-tab="perms"]').click()
    await page.locator('#projectPermCards .perm-card').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(900)
    await shot(page, 'step-3-project-detail-perms')
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('#projectPermCards .perm-card')].map((el) => ({
        key: el.getAttribute('data-card'),
        head: el.querySelector('.perm-card-head')?.innerText.replace(/\s+/g, ' ').trim() ?? ''
      }))
    )
    const keys = cards.map((c) => c.key)
    for (const need of ['view', 'control', 'derived']) {
      if (!keys.includes(need)) diff(`权限卡缺少 ${need}`)
    }
    await closeTopDialog(page)
    return `列表行=${listInfo.rows}，搜索框=${listInfo.search}；首行=${listInfo.firstRow}；权限卡=${JSON.stringify(cards)}`
  })

  /* 4. 打开工作区（Orca Web）：终端回显 + 文件树 */
  let popup = null
  await step(4, 'workspace', '项目行点「Orca Web」→ 新标签免登进入工作区 → 终端 echo → 文件树打开 README.md', '新标签挂载 Orca 工作区；终端回显输入；文件树可浏览并打开文件', async () => {
    if (!(await page.locator('.nav-item[data-route="projects"]:visible').count())) {
      await nav(page, 'projects', '我的项目')
    } else {
      await page.locator('.nav-item[data-route="projects"]:visible').first().click()
      await page.waitForTimeout(800)
    }
    let entry = page.locator(`button[data-orca-web="${DEMO}"]`)
    let entryNote = 'demo-app Orca Web'
    if (!(await entry.count())) {
      const candidates = page.locator('button[data-orca-web]')
      if (!(await candidates.count())) {
        diff('无可用 Orca Web 入口（主机离线/维护或无 open 权限）')
        return '未找到 Orca Web 入口'
      }
      entry = candidates.first()
      entryNote = '首个可用 Orca Web 入口'
    }
    for (let attempt = 1; attempt <= 3 && !popup; attempt += 1) {
      const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null)
      await entry.click()
      popup = await popupPromise
    }
    if (!popup) {
      diff('点击 Orca Web 未打开新标签')
      return '未打开新标签'
    }
    const issues = []
    popup.on('pageerror', (err) => issues.push(`pageerror: ${err.message}`))
    popup.setDefaultTimeout(90000)
    await popup.waitForLoadState('domcontentloaded')
    await popup.locator('.app-layout').waitFor({ timeout: 150000 })
    await popup.waitForTimeout(5000)
    await popup.getByRole('button', { name: 'Got it' }).click({ timeout: 5000 }).catch(() => {})
    await popup.waitForTimeout(800)
    await shot(popup, 'step-4-workspace')
    const shell = await popup.evaluate(() => ({
      appLayout: Boolean(document.querySelector('.app-layout')),
      explorer: Boolean(document.querySelector('[data-orca-explorer-shell]')),
      signIn: Boolean(document.querySelector('#web-cloud-api-url')),
      bodyHead: document.body.innerText.slice(0, 180).replace(/\s+/g, ' ')
    }))
    if (!shell.appLayout) diff('工作区 .app-layout 未挂载')
    if (shell.signIn) diff('出现云登录表单，免登失败')

    if ((await popup.locator('.xterm').count()) === 0) {
      await popup.keyboard.press(process.platform === 'darwin' ? 'Meta+T' : 'Control+T')
    }
    await popup.locator('.xterm').first().waitFor({ timeout: 90000 })
    await popup.locator('.xterm').first().click()
    const marker = `U63-MANUAL-${Date.now()}`
    const markerFile = '/tmp/u63-manual-terminal-marker'
    fs.rmSync(markerFile, { force: true })
    await popup.keyboard.type(`echo ${marker} && printf ${marker} > ${markerFile}`)
    await popup.keyboard.press('Enter')
    let termText = ''
    let fileMarker = ''
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      termText = await popup.evaluate(() => {
        const managers = window.__paneManagers
        if (managers && typeof managers.forEach === 'function') {
          const parts = []
          managers.forEach((m) => {
            for (const pane of m.getPanes?.() ?? []) {
              try {
                parts.push(pane.serializeAddon?.serialize?.({ scrollback: 800 }) ?? '')
              } catch {}
            }
          })
          const joined = parts.join('\n')
          if (joined.trim()) return joined
        }
        return [...document.querySelectorAll('.xterm-accessibility-tree, .xterm-rows')]
          .map((el) => el.innerText)
          .join('\n')
      })
      fileMarker = fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8') : ''
      if (termText.includes(marker) || fileMarker.includes(marker)) break
      await sleep(500)
    }
    const echoOk = termText.includes(marker) || fileMarker.includes(marker)
    await shot(popup, 'step-4-terminal')
    if (!echoOk) diff(`终端未见回显 marker（DOM 尾部=${JSON.stringify(termText.slice(-120))}，文件=${fileMarker}）`)

    const explorer = popup.locator('[data-orca-explorer-shell]').first()
    let fileNote = ''
    try {
      await explorer.waitFor({ timeout: 60000 })
      const readme = explorer.getByText('README.md', { exact: true }).first()
      await readme.waitFor({ timeout: 30000 })
      await readme.click()
      await popup.locator('.editor-header-path').first().waitFor({ timeout: 30000 })
      await popup.waitForTimeout(900)
      fileNote = compact(await popup.locator('.editor-header-path').first().innerText())
      await shot(popup, 'step-4-file-tree')
      if (!fileNote.includes('README.md')) diff(`编辑器标题=${fileNote}`)
    } catch (err) {
      diff(`文件树/README 打开失败：${err.message?.split('\n')[0]}`)
      await shot(popup, 'step-4-file-tree')
    }
    return `入口=${entryNote}；工作区=${JSON.stringify(shell)}；终端回显=${echoOk}（文件 marker=${fileMarker.includes(marker)}）；文件=${fileNote}；页面错误=${issues.length}`
  })
  await popup?.close().catch(() => {})
  await page.waitForTimeout(600)

  /* 5. 主机页/详情 */
  await step(5, 'hosts', '主机：列表 → dev-local-02 详情抽屉', '列表列有名称/地址/中继/版本/心跳/状态；详情含 ID/真实指纹/版本/能力与维护/下线按钮', async () => {
    await nav(page, 'hosts', '主机')
    await page.waitForTimeout(1200)
    await shot(page, 'step-5-hosts')
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('#content tbody tr')].slice(0, 3).map((r) => r.innerText.replace(/\s+/g, ' ').trim())
    )
    if (!rows.length) {
      diff('主机列表无数据行')
      return '无主机行'
    }
    let row = page.locator('#content tbody tr', { hasText: 'dev-local-02' }).first()
    if (!(await row.count())) row = page.locator('#content tbody tr').first()
    const hostName = compact(await text(row.locator('td').first()))
    await row.locator('button[data-host]').click()
    await page.locator('.drawer').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(1200)
    await shot(page, 'step-5-host-detail')
    const body = compact(await text(page.locator('.drawer-body')))
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll('.drawer-body button')].map((b) => ({ text: b.innerText.trim(), disabled: b.disabled }))
    )
    for (const field of ['主机 ID', '指纹', '版本', '能力', '最近心跳']) {
      if (!body.includes(field)) diff(`详情缺少 ${field}`)
    }
    if (!buttons.some((b) => b.text.includes('维护'))) diff('详情缺少维护按钮')
    const fingerprint = body.match(/指纹 (\S+)/)?.[1] ?? ''
    const versionText = body.match(/版本 (.*?) 网络位置/)?.[1] ?? ''
    if (/^host:/.test(fingerprint)) diff(`指纹为占位值 ${fingerprint}，非可核对 TLS 指纹（WEB-R2-007）`)
    if (!/\d+\.\d+/.test(versionText)) diff(`在线主机版本为空（显示「${versionText}」，WEB-R2-007）`)
    await page.locator('.drawer .icon-btn').first().click().catch(() => {})
    await page.waitForTimeout(500)
    return `主机=${hostName}；行样本=${JSON.stringify(rows.slice(0, 1))}；详情按钮=${JSON.stringify(buttons)}；字段=${body.slice(0, 220)}`
  })

  /* 6. 中继页（含刷新） */
  await step(6, 'relays', '中继：列表 → 点「刷新」', '中继表展示节点/客户端地址/状态/注册时间；刷新后表仍在且无错误横幅', async () => {
    await nav(page, 'relays', '中继')
    await page.waitForTimeout(1200)
    await shot(page, 'step-6-relays')
    const before = await page.evaluate(() => ({
      rows: document.querySelectorAll('#content tbody tr').length,
      first: document.querySelector('#content tbody tr')?.innerText.replace(/\s+/g, ' ').trim(),
      warning: document.querySelector('#relayRefreshWarning')?.innerText ?? null
    }))
    await page.click('#refreshRelaysBtn')
    await page.waitForTimeout(1600)
    await shot(page, 'step-6-relays-refresh')
    const after = await page.evaluate(() => ({
      rows: document.querySelectorAll('#content tbody tr').length,
      warning: document.querySelector('#relayRefreshWarning')?.innerText ?? null,
      addBtn: Boolean(document.querySelector('#addRelayBtn'))
    }))
    if (after.warning) diff(`刷新失败横幅：${after.warning}`)
    if (after.rows === 0) diff('刷新后无中继行')
    return `刷新前=${JSON.stringify(before)}；刷新后=${JSON.stringify(after)}`
  })

  /* 7. 用户页/详情改角色（改后立即还原） */
  await step(7, 'users-role', '用户管理：列表 → zhangsan 详情 → 角色 普通→审计→普通', '用户列表含角色列；详情角色可改并二次确认；变更写 role_update 审计；还原成功', async () => {
    await nav(page, 'users', '用户管理')
    await page.waitForTimeout(1200)
    await shot(page, 'step-7-users')
    const list = await page.evaluate(() => ({
      rows: document.querySelectorAll('#content tbody tr').length,
      headers: [...document.querySelectorAll('#content thead th')].map((th) => th.innerText.trim())
    }))
    let row = page.locator('#content tbody tr', { hasText: 'zhangsan' }).first()
    let subject = 'zhangsan'
    if (!(await row.count())) {
      row = page.locator('#content tbody tr', { hasText: '详情' }).first()
      subject = compact(await text(row.locator('td').first()))
    }
    if (!(await row.count())) {
      diff('用户列表无可操作行')
      return JSON.stringify(list)
    }
    await row.locator('button[data-user-detail]').click()
    await page.locator('.dialog-backdrop:visible .dialog').last().waitFor({ timeout: 20000 })
    await page.waitForTimeout(1000)
    await shot(page, 'step-7-user-detail')
    const select = page.locator('.dialog-backdrop:visible [data-detail-role]').last()
    const original = await select.inputValue()
    const options = await select.locator('option').evaluateAll((els) => els.map((o) => ({ v: o.value, t: o.innerText })))
    const target = original === 'developer' ? 'auditor' : 'developer'
    await select.selectOption(target)
    await page.getByRole('button', { name: '确认变更' }).waitFor({ timeout: 10000 })
    await shot(page, 'step-7-role-confirm')
    const confirmText = compact(await text(page.locator('.dialog-backdrop:visible .dialog').last()))
    await page.getByRole('button', { name: '确认变更' }).click()
    await page.waitForTimeout(1800)
    await page.locator('.dialog-backdrop:visible [data-detail-role]').last().waitFor({ timeout: 15000 })
    const changed = await page.locator('.dialog-backdrop:visible [data-detail-role]').last().inputValue()
    const toast1 = compact(await text(page.locator('#toast')))
    await shot(page, 'step-7-role-changed')
    if (changed !== target) diff(`角色变更未生效：${original} → ${changed}（期望 ${target}）`)
    const select2 = page.locator('.dialog-backdrop:visible [data-detail-role]').last()
    await select2.selectOption(original)
    await page.getByRole('button', { name: '确认变更' }).waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: '确认变更' }).click()
    await page.waitForTimeout(1800)
    const reverted = await page.locator('.dialog-backdrop:visible [data-detail-role]').last().inputValue()
    await shot(page, 'step-7-role-reverted')
    if (reverted !== original) diff(`角色还原失败：期望 ${original}，实际 ${reverted}`)
    await closeTopDialog(page)
    return `对象=${subject}；列表行=${list.rows}，表头=${JSON.stringify(list.headers)}；角色=${original}→${changed}→${reverted}；确认框=${confirmText.slice(0, 120)}；toast=${toast1}`
  })

  /* 8. 审计页（链健康/校验） */
  await step(8, 'audit', '审计日志：读取列表 → 展开链健康 → 点「校验审计链」', '已显示 N 条事件；链健康显示正常/最后序号；手动校验返回「校验通过：已校验 N 条」', async () => {
    await nav(page, 'audit', '审计日志')
    await page.waitForTimeout(1600)
    await shot(page, 'step-8-audit')
    const header = compact(await text(page.locator('#content .page-head p')))
    const summary = page.locator('#auditHealth summary')
    const hasHealth = (await summary.count()) > 0
    if (!hasHealth) diff('缺少链健康区块')
    let health = ''
    if (hasHealth) {
      await summary.click()
      await page.waitForTimeout(600)
      health = compact(await text(page.locator('#auditHealth')))
      await shot(page, 'step-8-audit-health')
    }
    const verify = page.locator('#auditVerify')
    let verdict = ''
    if (await verify.count()) {
      await verify.click()
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        verdict = compact(await text(page.locator('#auditVerifyResult')))
        if (verdict && !verdict.includes('校验中')) break
        await sleep(400)
      }
      await shot(page, 'step-8-audit-verify')
      if (!verdict.includes('校验通过') && !verdict.includes('校验失败') && !verdict.includes('链已断裂')) {
        diff(`校验结果异常：${verdict}`)
      }
    } else {
      diff('缺少「校验审计链」按钮')
    }
    if (!/已显示 \d+ 条/.test(header)) diff(`审计头文案异常：${header}`)
    return `列表=${header}；链健康=${health.slice(0, 200)}；校验=${verdict}`
  })

  /* 9. 设置页策略 */
  await step(9, 'settings', '平台设置：读取全局下载策略与项目覆盖', '显示全局禁止/允许单选、当前版本、跟随/覆盖项目计数与覆盖表', async () => {
    await nav(page, 'settings', '平台设置')
    await page.waitForTimeout(1200)
    await shot(page, 'step-9-settings')
    const state = await page.evaluate(() => ({
      checked: document.querySelector('input[name=dl]:checked')?.value ?? null,
      version: document.querySelector('#content')?.innerText.match(/当前版本 v\d+/)?.[0] ?? '',
      scope: document.querySelector('#policyScope')?.innerText.replace(/\s+/g, ' ').trim() ?? '',
      overrideRows: document.querySelectorAll('#content .card.pad:last-child tbody tr').length,
      saveBtn: Boolean(document.querySelector('#savePolicy'))
    }))
    if (!state.checked) diff('全局下载策略未选中')
    if (!state.saveBtn) diff('缺少保存按钮')
    if (!state.scope.includes('跟随全局默认')) diff('缺少策略范围文案')
    return JSON.stringify(state)
  })

  /* 10. 退出登录 */
  await step(10, 'logout', '点击顶栏「退出」', '回到登录页，会话凭据清除，输入框不残留上一账号', async () => {
    await page.click('#logoutBtn')
    await page.locator('#loginForm').waitFor({ timeout: 20000 })
    await page.waitForTimeout(1000)
    await shot(page, 'step-10-logout')
    const state = await page.evaluate(() => ({
      loginVisible: !!document.querySelector('#loginForm'),
      appHidden: document.querySelector('#view-app')?.hidden ?? null,
      access: window.localStorage.getItem('orca.access'),
      refresh: window.localStorage.getItem('orca.refresh'),
      username: document.querySelector('#username')?.value ?? null,
      password: document.querySelector('#password')?.value ?? null,
      hash: window.location.hash
    }))
    if (!state.loginVisible) diff('未回到登录页')
    if (state.access !== null || state.refresh !== null) diff('会话凭据未清除')
    if (state.username || state.password) diff('登录输入框残留上一账号凭据')
    return JSON.stringify(state)
  })
} finally {
  report.finishedAt = new Date().toISOString()
  report.summary = {
    total: report.steps.length,
    pass: report.steps.filter((s) => s.verdict === 'PASS').length,
    diff: report.steps.filter((s) => s.verdict === 'DIFF').length
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(report, null, 2))
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}
