/**
 * Manual-review re-verification 1: desktop link.
 *
 * Replays cloud-platform/scripts/exploratory-r2/desktop-paths.md end to end and
 * keeps one screenshot + one innerText assertion per functional step under
 * cloud-platform/evidence/man-review/desktop/ (gitignored, not committed).
 *
 * Launch discipline (AGENTS.md): ORCA_BACKGROUND_LAUNCH=1, ORCA_E2E_HEADLESS=1,
 * isolated HOME/userData, no show()/focus()/OS activation, screenshots only
 * through the hidden renderer's Playwright/CDP session.
 *
 * No product code is changed. Findings are recorded, not fixed.
 */
import { writeFileSync, readFileSync, existsSync, copyFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import {
  cloudTestEnv,
  clickWorktree,
  dismissOnboarding,
  fillLogin,
  focusTerminal,
  launchDesktop,
  openLoginDialog,
  PLATFORM_URL,
  readLoginDialog,
  readShell,
  submitLogin,
  terminalText,
  typeInTerminal,
  waitSignedIn
} from './desktop-harness.mjs'

const REPO = '/Users/gongdewei/work/projects/orca'
const OUT = path.join(REPO, 'cloud-platform/evidence/man-review/desktop')
const DEV_CA = '/Users/gongdewei/orca-local-env/tls/ca.pem'
const USER_DATA = '/tmp/orca-man-review/ud-main'
const MAIN2 = '/Users/gongdewei/orca-local-env/host2/projects/infra-tools/.orca-worktrees/zhangsan/main-2'
const README = path.join(MAIN2, 'README.md')
const README_BAK = '/tmp/orca-man-review/README.main-2.bak'
const BIN = path.join(MAIN2, 'man-review-binary.bin')
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
mkdirSync('/tmp/orca-man-review', { recursive: true })

const steps = []
const findings = []
const deviations = []
const allLogs = []
const mem = {}
let app
let page
let logs = []
const wait = (ms) => page.waitForTimeout(ms)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function addFinding(id, level, title, detail, evidence) {
  findings.push({ id, level, title, detail, evidence, at: new Date().toISOString() })
}

function addDeviation(pathId, note) {
  deviations.push({ path: pathId, note, at: new Date().toISOString() })
}

async function shoot(name) {
  await page.screenshot({ path: path.join(OUT, name) })
}

async function bodyText() {
  return page.evaluate(() => (document.body.innerText ?? '').replace(/\s+/g, ' ').trim())
}

async function rowsSnapshot() {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-worktree-id]')].map((el) => ({
      id: el.getAttribute('data-worktree-id'),
      active:
        el.getAttribute('aria-current') === 'page' ||
        Boolean(el.querySelector('[data-worktree-card-active]')) ||
        /Active/.test(el.className ?? ''),
      text: (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
    }))
  )
}

async function clickAriaPrefix(prefix) {
  return page.evaluate((p) => {
    const els = [...document.querySelectorAll('[aria-label]')]
    const el = els.find(
      (e) => (e.getAttribute('aria-label') ?? '').startsWith(p) && (e.offsetParent !== null || e.getClientRects().length > 0)
    )
    if (!el) return null
    el.click()
    return el.getAttribute('aria-label')
  }, prefix)
}

async function clickWorktreeRow(fragments) {
  return page.evaluate((frags) => {
    const rows = [...document.querySelectorAll('[data-worktree-id]')]
    const row = rows.find((el) => {
      const text = (el.innerText ?? '').replace(/\s+/g, ' ')
      return frags.every((f) => text.includes(f))
    })
    if (!row) return null
    ;(row.querySelector('[data-worktree-card-surface]') ?? row).click()
    return row.getAttribute('data-worktree-id')
  }, fragments)
}

async function poll(fn, timeoutMs, intervalMs = 500) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  return last
}

async function doStep({ pathId, action, slug, read, expect, note, screenshotOnly = false }) {
  const n = String(steps.length + 1).padStart(2, '0')
  const screenshot = `${n}-${slug}.png`
  let actionError = null
  try {
    await action()
  } catch (error) {
    actionError = error instanceof Error ? `${error.message}` : String(error)
  }
  await wait(300)
  let shotError = null
  try {
    await shoot(screenshot)
  } catch (error) {
    shotError = error instanceof Error ? `${error.message}` : String(error)
  }
  let actual = null
  let readError = null
  if (read) {
    try {
      actual = await read()
    } catch (error) {
      readError = error instanceof Error ? `${error.message}` : String(error)
    }
  }
  let passed = null
  if (expect) {
    try {
      passed = Boolean(expect(actual))
    } catch {
      passed = false
    }
  }
  const result = actionError || shotError || readError ? 'error' : passed === null ? 'observed' : passed ? 'pass' : 'fail'
  const record = {
    step: steps.length + 1,
    path: pathId,
    action: note?.action ?? slug,
    screenshot,
    innerText: actual?.innerText ?? null,
    assertion: actual,
    expected: note?.expected ?? null,
    result,
    ...(actionError ? { actionError } : {}),
    ...(shotError ? { shotError } : {}),
    ...(readError ? { readError } : {})
  }
  steps.push(record)
  console.log(`[step ${n}] ${result} ${slug}${actionError ? ` ERR=${actionError}` : ''}`)
  return record
}

function httpsPostJson(urlString, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        ca: readFileSync(DEV_CA),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify(body ?? {}))
  })
}

async function launch(extraEnv = cloudTestEnv()) {
  const launched = await launchDesktop({ userDataDir: USER_DATA, extraEnv })
  app = launched.app
  page = launched.page
  logs = launched.logs
  allLogs.push(...launched.logs)
  await dismissOnboarding(page)
}

try {
  if (existsSync(README)) copyFileSync(README, README_BAK)

  // ---------------------------------------------------------------------------
  // Path A: bare launch -> login -> hydration
  // ---------------------------------------------------------------------------
  await launch()

  await doStep({
    pathId: 'A.0',
    slug: 'bare-shell',
    note: { action: '裸启动（无 ORCA_CLOUD_API_URL）进入原生 shell', expected: '状态栏有 登录云端平台，未登录' },
    action: async () => {},
    read: async () => {
      const shell = await readShell(page)
      return {
        innerText: shell.statusBar,
        signedIn: shell.signedInSegment,
        loginEntry: await page.evaluate(() => Boolean(document.querySelector('[data-status-bar] [data-cloud-login-entry]'))),
        worktreeRows: shell.worktrees.length
      }
    },
    expect: (a) => a && a.signedIn === false && a.loginEntry === true && a.worktreeRows === 0
  })

  await doStep({
    pathId: 'A.2',
    slug: 'login-dialog-empty',
    note: { action: '点击「登录云端平台」打开登录对话框', expected: '地址/用户名为空，空表单提交禁用' },
    action: async () => openLoginDialog(page),
    read: async () => {
      const d = await readLoginDialog(page)
      return { innerText: d?.text ?? null, address: d?.address, username: d?.username, submitDisabled: d?.submitDisabled }
    },
    expect: (a) => a && a.address === '' && a.username === '' && a.submitDisabled === true
  })

  await doStep({
    pathId: 'A.3',
    slug: 'login-wrong-password',
    note: { action: '输入地址/账号与错误密码并提交', expected: '对话框 role=alert 显示 账号或密码不正确。' },
    action: async () => {
      await fillLogin(page, { address: PLATFORM_URL, username: 'zhangsan', password: 'WrongPass!000' })
      await submitLogin(page)
      await poll(
        () =>
          page.evaluate(() => {
            const d = [...document.querySelectorAll('[data-slot="dialog-content"]')].find((el) =>
              el.querySelector('#cloud-platform-address')
            )
            return d?.querySelector('[role="alert"]')?.textContent?.trim() ?? null
          }),
        15000
      )
    },
    read: async () => {
      const d = await readLoginDialog(page)
      return { innerText: d?.text ?? null, alerts: d?.alerts, notices: d?.notices }
    },
    expect: (a) => a && Array.isArray(a.alerts) && a.alerts.some((t) => t.includes('账号或密码不正确'))
  })

  await doStep({
    pathId: 'A.4',
    slug: 'login-signed-in',
    note: { action: '输入正确密码并提交', expected: '状态栏不再有登录入口，出现 张伟 / 登出' },
    action: async () => {
      await fillLogin(page, { password: 'Passw0rd!' })
      await submitLogin(page)
      await waitSignedIn(page, 90_000)
      await wait(2000)
    },
    read: async () => {
      const shell = await readShell(page)
      return {
        innerText: shell.statusBar,
        signedIn: shell.signedInSegment,
        loginEntry: await page.evaluate(() => Boolean(document.querySelector('[data-status-bar] [data-cloud-login-entry]')))
      }
    },
    expect: (a) => a && a.signedIn === true && a.loginEntry === false && /张伟/.test(a.innerText) && /登出/.test(a.innerText)
  })

  await doStep({
    pathId: 'A.5',
    slug: 'project-list-hydrated',
    note: { action: '等待注册/水合（8-15s）', expected: '侧栏出现云端项目工作树行；失败 banner 仅列真实失败项' },
    action: async () => {
      await poll(async () => ((await rowsSnapshot()).length > 0 ? true : null), 45_000)
      await wait(3000)
    },
    read: async () => {
      const shell = await readShell(page)
      const rows = await rowsSnapshot()
      return {
        innerText: [shell.statusBar, ...rows.map((r) => r.text)].join(' || '),
        rowCount: rows.length,
        rows: rows.map((r) => r.text),
        alerts: shell.alerts,
        toasts: shell.toasts,
        statuses: shell.statuses
      }
    },
    expect: (a) => a && a.rowCount > 0
  })

  if (steps[steps.length - 1]?.assertion?.alerts?.length) {
    addDeviation('A.5', `登录后失败 banner 非空：${JSON.stringify(steps[steps.length - 1].assertion.alerts)}（payment-service 为离线 seed 项；需人工判断是否仅列真实失败项）`)
  }
  if (steps[steps.length - 1]?.assertion?.toasts?.length) {
    addDeviation('A.5', `登录后出现 toast：${JSON.stringify(steps[steps.length - 1].assertion.toasts)}（路径检查点要求网络/主机失败不出现英文 toast）`)
  }

  // ---------------------------------------------------------------------------
  // Path B: open project and route
  // ---------------------------------------------------------------------------
  await doStep({
    pathId: 'B.1',
    slug: 'project-opened',
    note: { action: '点击侧栏 infra-tools / main-2 工作树卡片表面', expected: '该工作树成为活动工作区并出现标签页' },
    action: async () => {
      const clicked = await clickWorktreeRow(['infra-tools', 'main-2'])
      if (!clicked) throw new Error('infra-tools main-2 row not found')
      await wait(8000)
    },
    read: async () => {
      const shell = await readShell(page)
      const active = await page.evaluate(() =>
        [...document.querySelectorAll('[data-worktree-card-active]')].map(
          (el) => el.closest('[data-worktree-id]')?.getAttribute('data-worktree-id') ?? null
        )
      )
      const current = await page.evaluate(() =>
        [...document.querySelectorAll('[data-worktree-id][aria-current="page"]')].map((el) =>
          el.getAttribute('data-worktree-id')
        )
      )
      return {
        innerText: shell.statusBar,
        active,
        current,
        tabs: shell.tabs,
        terminals: shell.terminals
      }
    },
    expect: (a) => a && (a.active.length > 0 || a.current.length > 0)
  })

  let openResult = null
  await doStep({
    pathId: 'B.2',
    slug: 'open-workspace-route',
    note: { action: '调用 window.api.cloud.openWorkspace(infra-tools)', expected: 'ok=true，route=direct|relay，workspacePath 位于每人 checkout' },
    action: async () => {
      openResult = await page.evaluate(async () => {
        const state = await window.api.cloud.getState()
        const project = state.projects?.find((p) => p.key === 'infra-tools')
        if (!project) return { error: 'infra-tools project missing', projects: state.projects?.map((p) => p.key) }
        const opened = await window.api.cloud.openWorkspace(project.id)
        return { projectId: project.id, opened }
      })
      await wait(2000)
    },
    read: async () => {
      const opened = openResult?.opened
      return {
        innerText: JSON.stringify(opened ?? openResult ?? {}),
        projectId: openResult?.projectId ?? null,
        ok: opened?.ok ?? null,
        route: opened?.route ?? null,
        workspacePath: opened?.workspacePath ?? null,
        code: opened?.code ?? null,
        message: opened?.message ?? null
      }
    },
    expect: (a) =>
      a &&
      a.ok === true &&
      ['direct', 'relay'].includes(a.route) &&
      typeof a.workspacePath === 'string' &&
      a.workspacePath.includes('/.orca-worktrees/zhangsan')
  })

  if (steps[steps.length - 1]?.result !== 'pass') {
    addFinding('D-OPEN-WORKSPACE', 'P1', 'openWorkspace 未返回可用工作区', JSON.stringify(steps[steps.length - 1]?.assertion ?? {}), steps[steps.length - 1]?.screenshot)
  }

  await doStep({
    pathId: 'B.3',
    slug: 'route-badge-check',
    note: { action: '检查活动工作区上的直连/中继徽标', expected: '线路只能从桥接结果读取（已记为 P3，无 UI 徽标）' },
    action: async () => {},
    read: async () => {
      const badges = await page.evaluate(() => {
        const text = (document.body.innerText ?? '').replace(/\s+/g, ' ')
        return {
          directText: /直连/.test(text),
          relayText: /中继/.test(text),
          routeFromBridge: null
        }
      })
      return { innerText: JSON.stringify(badges), ...badges, routeFromBridge: openResult?.opened?.route ?? null }
    },
    expect: () => true
  })
  addDeviation('B.3', '桌面原生 shell 无直连/中继徽标；route 仅能从 openWorkspace 桥接结果读取（P3，与路径清单一致）。')

  await doStep({
    pathId: 'B.4',
    slug: 'open-idempotent',
    note: { action: '并发两次打开同一项目，再打开另一项目，再打开回原项目', expected: '均 ok=true；同一项目同一 workspacePath；无重复行' },
    action: async () => {
      await page.evaluate(async () => {
        const bridge = window.api.cloud
        const state = await bridge.getState()
        const online = (state.projects ?? []).filter((p) => p.hostStatus === 'online')
        const target = online.find((p) => p.key === 'infra-tools') ?? online[0]
        const other = online.find((p) => p.id !== target.id) ?? target
        window.__manReviewIdempotent = {
          target: target.key,
          other: other.key,
          concurrent: await Promise.all([bridge.openWorkspace(target.id), bridge.openWorkspace(target.id)]),
          different: await bridge.openWorkspace(other.id),
          again: await bridge.openWorkspace(target.id)
        }
      })
      await wait(3000)
    },
    read: async () => {
      const result = await page.evaluate(() => window.__manReviewIdempotent)
      const rows = await rowsSnapshot()
      const pick = (r) => r && { ok: r.ok, route: r.route, workspacePath: r.workspacePath, code: r.code }
      return {
        innerText: `rows=${rows.length}`,
        target: result?.target,
        other: result?.other,
        concurrent: (result?.concurrent ?? []).map(pick),
        different: pick(result?.different),
        again: pick(result?.again),
        rowCount: rows.length,
        duplicateIds: rows.length - new Set(rows.map((r) => r.id)).size
      }
    },
    expect: (a) =>
      a &&
      a.concurrent.length === 2 &&
      a.concurrent.every((r) => r.ok === true) &&
      a.concurrent[0].workspacePath === a.concurrent[1].workspacePath &&
      a.again?.ok === true &&
      a.again?.workspacePath === a.concurrent[0]?.workspacePath &&
      a.duplicateIds === 0
  })

  // ---------------------------------------------------------------------------
  // Path C: terminal UI and RPC
  // ---------------------------------------------------------------------------
  await doStep({
    pathId: 'C.1',
    slug: 'terminal-ui-attempt',
    note: { action: '选中云工作区后点击「新标签页」→「新终端」', expected: '应出现 .xterm 与 .xterm-helper-textarea' },
    action: async () => {
      const plus = page.locator('button[aria-label="新标签页"], button[aria-label="New tab"]').first()
      if (await plus.isVisible().catch(() => false)) {
        await plus.click({ timeout: 5000 }).catch(() => {})
        await wait(1200)
      }
      const picked = await page.evaluate(() => {
        const target = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
          /新终端|New Terminal/i.test(el.innerText ?? '')
        )
        if (!target) return null
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
        target.click()
        return (target.innerText ?? '').replace(/\s+/g, ' ').trim()
      })
      if (!picked) {
        await page.keyboard.press(`${MOD}+t`).catch(() => {})
      }
      await wait(7000)
    },
    read: async () => {
      const shell = await readShell(page)
      const denial = allLogs.filter((l) => /createTerminal|terminal/i.test(l)).slice(-10)
      return {
        innerText: shell.statusBar,
        terminals: shell.terminals,
        tabs: shell.tabs,
        denials: denial
      }
    },
    expect: (a) => a && a.terminals > 0
  })
  if (steps[steps.length - 1]?.result !== 'pass') {
    const denial = (steps[steps.length - 1]?.assertion?.denials ?? []).join(' | ')
    addFinding(
      'D-UI-TERMINAL-DENIED',
      'P0',
      '云工作区 UI 无法创建终端',
      `点击新终端后 .xterm 数量为 0。控制台相关日志：${denial || '(未捕获)'}`,
      steps[steps.length - 1]?.screenshot
    )
  }

  await doStep({
    pathId: 'C.2',
    slug: 'terminal-ui-input',
    note: { action: '聚焦 UI 终端并输入 pwd / 中文回声', expected: '终端输出包含 MAN_REVIEW_UI 与 中文界面回声（若 UI 终端未能创建则记录阻塞）' },
    action: async () => {
      const focused = await focusTerminal(page)
      if (focused) {
        await typeInTerminal(page, 'pwd && echo MAN_REVIEW_UI && echo 中文界面回声')
        await wait(5000)
      }
      mem.uiTermText = focused ? await terminalText(page) : ''
    },
    read: async () => {
      const text = mem.uiTermText ?? ''
      const shell = await readShell(page)
      return {
        innerText: text.slice(-800),
        terminals: shell.terminals,
        innerTextSeen: text.includes('MAN_REVIEW_UI'),
        chineseSeen: text.includes('中文界面回声')
      }
    },
    expect: (a) => a && a.innerTextSeen === true && a.chineseSeen === true
  })

  let rpc = { envId: null, handle: null }
  await doStep({
    pathId: 'C.3',
    slug: 'terminal-rpc-created',
    note: { action: '在每人 checkout 上调用 terminal.create（RPC 路径）', expected: 'create ok=true 且返回终端句柄' },
    action: async () => {
      rpc = await page.evaluate(async () => {
        const bridge = window.api.cloud
        const state = await bridge.getState()
        const project = state.projects?.find((p) => p.key === 'infra-tools')
        const opened = await bridge.openWorkspace(project.id)
        const envs = await window.api.runtimeEnvironments.list()
        const env = envs.find((e) => e.name === 'infra-tools')
        if (!opened.ok || !env) return { opened, envId: env?.id ?? null, created: null, handle: null }
        const created = await window.api.runtimeEnvironments.call({
          selector: env.id,
          method: 'terminal.create',
          params: { worktree: `path:${opened.workspacePath}`, clientMutationId: 'man-review-desktop' },
          timeoutMs: 25000
        })
        const handle =
          created?.result?.terminal?.handle ??
          created?.result?.terminal?.terminal ??
          created?.result?.terminal ??
          created?.terminal?.terminal ??
          created?.terminal ??
          (typeof created?.result === 'string' ? created.result : null)
        return { opened, envId: env.id, created, handle: typeof handle === 'string' ? handle : null }
      })
      await wait(1000)
    },
    read: async () => {
      return {
        innerText: JSON.stringify({ created: rpc.created, handle: rpc.handle }),
        openedOk: rpc.opened?.ok ?? null,
        workspacePath: rpc.opened?.workspacePath ?? null,
        envId: rpc.envId,
        createdOk: rpc.created?.ok ?? null,
        handle: rpc.handle,
        created: rpc.created
      }
    },
    expect: (a) => a && a.openedOk === true && a.createdOk === true && typeof a.handle === 'string'
  })
  if (steps[steps.length - 1]?.result !== 'pass') {
    addFinding('D-RPC-TERMINAL-CREATE', 'P1', '宿主 RPC 终端创建失败', JSON.stringify(steps[steps.length - 1]?.assertion ?? {}), steps[steps.length - 1]?.screenshot)
  }

  let rpcReadText = ''
  await doStep({
    pathId: 'C.4',
    slug: 'terminal-rpc-input',
    note: { action: '通过 RPC send/read 输入 pwd、MAN_RPC_ECHO、中文直连回声', expected: '读回包含 MAN_RPC_ECHO 与 中文直连回声' },
    action: async () => {
      if (!rpc.handle) return
      const result = await page.evaluate(async ({ envId, handle }) => {
        const call = (method, params) =>
          window.api.runtimeEnvironments.call({ selector: envId, method, params, timeoutMs: 25000 })
        const send = await call('terminal.send', {
          terminal: handle,
          text: 'pwd && echo MAN_RPC_ECHO && echo 中文直连回声',
          enter: true
        })
        await new Promise((resolve) => setTimeout(resolve, 3000))
        const read = await call('terminal.read', { terminal: handle })
        return { send, read, text: typeof read?.result === 'string' ? read.result : JSON.stringify(read?.result ?? '') }
      }, { envId: rpc.envId, handle: rpc.handle })
      rpcReadText = result.text
      mem.rpcEcho = result
    },
    read: async () => {
      const result = mem.rpcEcho ?? {}
      return {
        innerText: (rpcReadText ?? '').slice(-900),
        sendOk: result.send?.ok ?? null,
        readOk: result.read?.ok ?? null,
        echoSeen: (rpcReadText ?? '').includes('MAN_RPC_ECHO'),
        chineseSeen: (rpcReadText ?? '').includes('中文直连回声')
      }
    },
    expect: (a) => a && a.sendOk === true && a.readOk === true && a.echoSeen === true && a.chineseSeen === true
  })

  await doStep({
    pathId: 'C.5',
    slug: 'terminal-rpc-long',
    note: { action: '通过 RPC 输入 300 行长输出并读取', expected: '读回包含 RPC_LONG_300' },
    action: async () => {
      if (!rpc.handle) return
      const result = await page.evaluate(async ({ envId, handle }) => {
        const call = (method, params) =>
          window.api.runtimeEnvironments.call({ selector: envId, method, params, timeoutMs: 25000 })
        const send = await call('terminal.send', {
          terminal: handle,
          text: 'for i in $(seq 1 300); do echo RPC_LONG_$i; done',
          enter: true
        })
        await new Promise((resolve) => setTimeout(resolve, 4000))
        const read = await call('terminal.read', { terminal: handle, limit: 200000 })
        return { send, read, text: typeof read?.result === 'string' ? read.result : JSON.stringify(read?.result ?? '') }
      }, { envId: rpc.envId, handle: rpc.handle })
      mem.rpcLong = result
    },
    read: async () => {
      const result = mem.rpcLong ?? {}
      const text = result.text ?? ''
      return {
        innerText: text.slice(-500),
        sendOk: result.send?.ok ?? null,
        readOk: result.read?.ok ?? null,
        longSeen: text.includes('RPC_LONG_300')
      }
    },
    expect: (a) => a && a.sendOk === true && a.longSeen === true
  })

  await doStep({
    pathId: 'C.6',
    slug: 'terminal-rpc-closed',
    note: { action: '通过 RPC 关闭终端', expected: 'close ok=true' },
    action: async () => {
      if (!rpc.handle) return
      mem.rpcClose = await page.evaluate(
        async ({ envId, handle }) =>
          window.api.runtimeEnvironments.call({
            selector: envId,
            method: 'terminal.close',
            params: { terminal: handle },
            timeoutMs: 25000
          }),
        { envId: rpc.envId, handle: rpc.handle }
      )
      await wait(1000)
    },
    read: async () => {
      const close = mem.rpcClose ?? {}
      return { innerText: JSON.stringify(close), closeOk: close.ok ?? null }
    },
    expect: (a) => a && a.closeOk === true
  })

  // ---------------------------------------------------------------------------
  // Path D: file tree / editor / save / preview / binary
  // ---------------------------------------------------------------------------
  await doStep({
    pathId: 'D.1',
    slug: 'explorer-open',
    note: { action: '点击右栏 Explorer 按钮', expected: '[data-orca-explorer-shell] 出现且文件行可用' },
    action: async () => {
      const label = await clickAriaPrefix('Explorer')
      if (!label) throw new Error('Explorer rail button not found')
      await wait(4000)
    },
    read: async () => {
      const shell = await page.evaluate(() => {
        const root = document.querySelector('[data-orca-explorer-shell]')
        return root
          ? [...root.querySelectorAll('button[data-file-explorer-row]')]
              .map((el) => (el.innerText ?? '').replace(/\s+/g, ' ').trim())
              .slice(0, 40)
          : null
      })
      return { innerText: JSON.stringify(shell ?? []), shellPresent: Array.isArray(shell), rows: shell }
    },
    expect: (a) => a && a.shellPresent === true && Array.isArray(a.rows) && a.rows.length > 0
  })

  await doStep({
    pathId: 'D.2',
    slug: 'file-opened',
    note: { action: '单击 README.md', expected: '.editor-header-path 指向每人 checkout；可编辑表面为 ProseMirror 或 Monaco' },
    action: async () => {
      const opened = await page.evaluate(() => {
        const shell = document.querySelector('[data-orca-explorer-shell]')
        const row = shell
          ? [...shell.querySelectorAll('button[data-file-explorer-row]')].find((el) => /README\.md/i.test(el.innerText ?? ''))
          : null
        if (!row) return null
        row.click()
        return (row.innerText ?? '').trim()
      })
      if (!opened) throw new Error('README.md row not found')
      await poll(
        () => page.evaluate(() => Boolean(document.querySelector('.ProseMirror[contenteditable="true"], .monaco-editor'))),
        20_000
      )
      await wait(1500)
    },
    read: async () => {
      const dom = await page.evaluate(() => ({
        proseMirror: Boolean(document.querySelector('.ProseMirror')),
        proseEditable: document.querySelector('.ProseMirror')?.getAttribute('contenteditable') ?? null,
        monaco: Boolean(document.querySelector('.monaco-editor')),
        headers: [...document.querySelectorAll('.editor-header-path')].map((el) => el.textContent?.trim()),
        body: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 600)
      }))
      return {
        innerText: dom.headers.join(' | '),
        ...dom
      }
    },
    expect: (a) =>
      a &&
      a.headers.some((h) => (h ?? '').includes('main-2/README.md')) &&
      ((a.proseMirror === true && a.proseEditable === 'true') || a.monaco === true)
  })

  const marker = `MAN_REVIEW_EDIT_${Date.now()}`
  await doStep({
    pathId: 'D.3',
    slug: 'file-edited',
    note: { action: '聚焦编辑面，末尾追加标记文本', expected: '编辑器内容包含新标记（尚未保存）' },
    action: async () => {
      const kind = await page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror')
        if (pm) {
          pm.focus()
          return 'prosemirror'
        }
        const ta = document.querySelector('.monaco-editor textarea')
        if (ta) {
          ta.focus()
          return 'monaco'
        }
        return 'none'
      })
      if (kind === 'none') return
      await page.keyboard.press(`${MOD}+ArrowDown`)
      await page.keyboard.press(`${MOD}+ArrowRight`)
      await page.keyboard.press('Enter')
      await page.keyboard.insertText(marker)
      await wait(1200)
    },
    read: async () => {
      const text = await bodyText()
      return { innerText: text.slice(0, 900), marker, markerInEditor: text.includes(marker) }
    },
    expect: (a) => a && a.markerInEditor === true
  })

  await doStep({
    pathId: 'D.4',
    slug: 'file-saved',
    note: { action: '按 Cmd/Ctrl+S 保存', expected: '磁盘 README.md 包含标记（落盘回环）' },
    action: async () => {
      await page.keyboard.press(`${MOD}+s`)
      await wait(5000)
    },
    read: async () => {
      const disk = existsSync(README) ? readFileSync(README, 'utf8') : ''
      const text = await bodyText()
      return {
        innerText: text.slice(0, 900),
        marker,
        saveRoundTrip: disk.includes(marker)
      }
    },
    expect: (a) => a && a.saveRoundTrip === true
  })
  if (steps[steps.length - 1]?.result !== 'pass') {
    addFinding('D-FILE-SAVE-FAIL', 'P2', '编辑保存未落盘', `追加标记后 Cmd+S，磁盘 README.md 未包含 ${marker}`, steps[steps.length - 1]?.screenshot)
  }

  await doStep({
    pathId: 'D.5',
    slug: 'md-preview',
    note: { action: '切换到 Markdown 预览模式', expected: '正文渲染标题/正文（基础设施运维工具集）' },
    action: async () => {
      mem.toggleLabels = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[data-slot="toggle-group-item"]')]
        return items.map((el) => el.getAttribute('aria-label'))
      })
      const clicked = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[data-slot="toggle-group-item"]')]
        const target = items.find((el) => /预览|Preview/i.test(el.getAttribute('aria-label') ?? ''))
        if (!target) return null
        target.click()
        return target.getAttribute('aria-label')
      })
      mem.previewClicked = clicked
      await wait(3500)
    },
    read: async () => {
      const state = await page.evaluate(() => {
        const body = (document.body.innerText ?? '').replace(/\s+/g, ' ')
        return {
          previewShell: Boolean(document.querySelector('.markdown-preview-shell')),
          renderedHeading: /基础设施运维工具集/.test(body),
          sourceHeading: /# infra-tools/.test(body)
        }
      })
      return {
        innerText: (await bodyText()).slice(0, 800),
        clicked: mem.previewClicked ?? null,
        toggleLabels: mem.toggleLabels ?? [],
        ...state
      }
    },
    expect: (a) => a && a.renderedHeading === true
  })
  if (!steps[steps.length - 1]?.assertion?.clicked) {
    addDeviation('D.5', `未找到 Markdown 预览切换控件；编辑器切换组标签=${JSON.stringify(steps[steps.length - 1]?.assertion?.toggleLabels ?? [])}。渲染标题检查仍执行。`)
  }

  await doStep({
    pathId: 'D.6',
    slug: 'binary-check',
    note: { action: '写入含 0x00/0xFF 的 .bin，刷新 Explorer 后打开', expected: '给出二进制/不支持提示，不按文本展示控制字符' },
    action: async () => {
      writeFileSync(BIN, Buffer.from([0, 1, 2, 3, 255, 254, 0, 66, 67]))
      await page.evaluate(() => {
        const shell = document.querySelector('[data-orca-explorer-shell]')
        const btn = shell
          ? [...shell.querySelectorAll('button')].find((b) =>
              /刷新|refresh/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''}`)
            )
          : null
        btn?.click()
      })
      await wait(3500)
      const opened = await page.evaluate(() => {
        const shell = document.querySelector('[data-orca-explorer-shell]')
        const row = shell
          ? [...shell.querySelectorAll('button[data-file-explorer-row]')].find((el) => /man-review-binary\.bin/i.test(el.innerText ?? ''))
          : null
        if (!row) return null
        row.click()
        return (row.innerText ?? '').trim()
      })
      mem.binaryOpened = opened
      await wait(4000)
    },
    read: async () => {
      const body = await bodyText()
      return {
        innerText: body.slice(0, 800),
        opened: mem.binaryOpened ?? null,
        hasControlChars: /[\u0000-\u0008\u000e-\u001f]/.test(body),
        hasBinaryNotice: /二进制|不支持|unsupported|binary file/i.test(body)
      }
    },
    expect: (a) => a && a.hasBinaryNotice === true && a.hasControlChars === false
  })
  if (steps[steps.length - 1]?.result !== 'pass') {
    addFinding(
      'D-BINARY-RAW',
      'P2',
      '二进制文件按文本渲染',
      '打开含 NUL/0xFF 的 .bin 时未见二进制/不支持提示，正文出现原始控制字符',
      steps[steps.length - 1]?.screenshot
    )
  }

  // ---------------------------------------------------------------------------
  // Path G: rapid switching (run before Path E so the sidebar stays clickable)
  // ---------------------------------------------------------------------------
  await doStep({
    pathId: 'G.1',
    slug: 'rapid-switch',
    note: { action: '连续切换 5 次不同工作树（main-2 ↔ 项目根）', expected: '进程不崩，最终仍有活动工作区' },
    action: async () => {
      const count = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-worktree-id]')]
        const root = rows.find((el) => /infra-tools/.test(el.innerText ?? '') && /主要/.test(el.innerText ?? ''))
        const perUser = rows.find((el) => /infra-tools/.test(el.innerText ?? '') && /main-2/.test(el.innerText ?? ''))
        const targets = [perUser, root, perUser, root, perUser].filter(Boolean)
        for (const row of targets) (row.querySelector('[data-worktree-card-surface]') ?? row).click()
        return targets.length
      })
      mem.rapidCount = count
      await wait(6000)
    },
    read: async () => {
      const shell = await readShell(page)
      const active = await page.evaluate(
        () => document.querySelectorAll('[data-worktree-card-active], [data-worktree-id][aria-current="page"]').length
      )
      return {
        innerText: shell.statusBar,
        clicks: mem.rapidCount ?? 0,
        activeCount: active,
        responsive: await page.evaluate(() => document.readyState)
      }
    },
    expect: (a) => a && a.clicks > 0 && a.activeCount >= 1 && a.responsive !== 'loading'
  })
  addDeviation('G', 'Path G 快速切换在 Path E（Agents/设置）之前执行，避免设置面板遮挡侧栏行；属重放顺序调整。')

  // ---------------------------------------------------------------------------
  // Path E: agents / settings / skills
  // ---------------------------------------------------------------------------
  await doStep({
    pathId: 'E.1',
    slug: 'agents-panel',
    note: { action: '点击右栏 Agents', expected: '显示 未找到智能体会话；method denial 只进日志' },
    action: async () => {
      const label = await clickAriaPrefix('Agents')
      if (!label) throw new Error('Agents rail button not found')
      await wait(4500)
    },
    read: async () => {
      const text = await bodyText()
      const denials = await page.evaluate(() =>
        [...(document.body.innerText ?? '').matchAll(/Method '([^']+)' is not available to cloud sessions/g)].map((m) => m[1])
      )
      return {
        innerText: text.slice(0, 900),
        emptyState: /未找到智能体会话/.test(text),
        visibleMethodDenials: denials
      }
    },
    expect: (a) => a && a.emptyState === true
  })
  if (steps[steps.length - 1]?.assertion?.visibleMethodDenials?.length) {
    addFinding('D-AGENT-METHOD-DENIAL-UI', 'P2', '智能体面板把 method denial 暴露到 UI', JSON.stringify(steps[steps.length - 1].assertion.visibleMethodDenials), steps[steps.length - 1]?.screenshot)
  }

  await doStep({
    pathId: 'E.2',
    slug: 'settings-panel',
    note: { action: '点击「设置」', expected: '打开设置面板（含 分享技能 入口）' },
    action: async () => {
      const label = await clickAriaPrefix('设置')
      if (!label) throw new Error('Settings button not found')
      await wait(3500)
    },
    read: async () => {
      const text = await bodyText()
      return {
        innerText: text.slice(0, 900),
        settingsVisible: /设置/.test(text) && /返回应用/.test(text),
        hasSkillsEntry: /分享技能|开放技能|Skills/i.test(text)
      }
    },
    expect: (a) => a && a.settingsVisible === true
  })

  await doStep({
    pathId: 'E.3',
    slug: 'skills-entry',
    note: { action: '在设置中打开「分享技能」', expected: '进入 Orca 账号技能分享页（非云会话技能列表）' },
    action: async () => {
      const clicked = await page.evaluate(() => {
        const target = [...document.querySelectorAll('button, a, [role="button"]')].find(
          (el) => /分享技能|开放技能|Open skills/i.test(el.innerText ?? '') && (el.offsetParent !== null || el.getClientRects().length > 0)
        )
        if (!target) return null
        target.click()
        return (target.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
      })
      mem.skillsClicked = clicked
      await wait(4000)
    },
    read: async () => {
      const text = await bodyText()
      return {
        innerText: text.slice(0, 900),
        clicked: mem.skillsClicked ?? null,
        hasSkillSharing: /技能|Skills/i.test(text)
      }
    },
    expect: (a) => a && a.hasSkillSharing === true
  })

  // ---------------------------------------------------------------------------
  // Path F: sign-out, restart memory, auto restore, session revoke
  // ---------------------------------------------------------------------------
  await doStep({
    pathId: 'F.1',
    slug: 'ui-logout',
    note: { action: '点击状态栏「登出」', expected: '状态栏回到 登录云端平台，云项目行清空' },
    action: async () => {
      const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('[data-status-bar] button')].find((b) => /登出|Sign out/i.test(b.innerText ?? ''))
        if (!btn) return false
        btn.click()
        return true
      })
      mem.logoutClicked = clicked
      await wait(8000)
    },
    read: async () => {
      const shell = await readShell(page)
      const rows = await rowsSnapshot()
      return {
        innerText: shell.statusBar,
        clicked: mem.logoutClicked ?? null,
        signedIn: shell.signedInSegment,
        loginEntry: await page.evaluate(() => Boolean(document.querySelector('[data-status-bar] [data-cloud-login-entry]'))),
        rowCount: rows.length,
        body: (shell.bodyText ?? '').slice(0, 400)
      }
    },
    expect: (a) => a && a.signedIn === false && a.loginEntry === true && a.rowCount === 0
  })
  if (steps[steps.length - 1]?.result !== 'pass') {
    addFinding('D-LOGOUT-UI-STALE', 'P1', 'UI 登出后状态栏/项目行未回到未登录态', JSON.stringify(steps[steps.length - 1]?.assertion ?? {}), steps[steps.length - 1]?.screenshot)
  }

  await doStep({
    pathId: 'F.2',
    slug: 'restart-prefill',
    note: { action: '关闭后同 profile 重启（不带 ORCA_CLOUD_API_URL），打开登录对话框', expected: '地址/用户名预填、密码为空、signed-out' },
    action: async () => {
      try {
        await app.close()
      } catch {}
      await sleep(2500)
      await launch()
      await openLoginDialog(page, 30_000)
      await wait(1000)
    },
    read: async () => {
      const d = await readLoginDialog(page)
      const shell = await readShell(page)
      return {
        innerText: d?.text ?? shell.statusBar,
        address: d?.address,
        username: d?.username,
        passwordFilled: d?.passwordFilled,
        signedIn: shell.signedInSegment
      }
    },
    expect: (a) =>
      a &&
      a.signedIn === false &&
      a.address === PLATFORM_URL &&
      a.username === 'zhangsan' &&
      a.passwordFilled === false
  })

  await doStep({
    pathId: 'F.2b',
    slug: 'relogin-before-restore',
    note: { action: '在重启后的对话框补密码并登录', expected: '重新 signed-in（为 A3 自动恢复准备会话文件）' },
    action: async () => {
      await fillLogin(page, { password: 'Passw0rd!' })
      await submitLogin(page)
      await waitSignedIn(page, 90_000)
      await wait(9000)
    },
    read: async () => {
      const shell = await readShell(page)
      const rows = await rowsSnapshot()
      return { innerText: shell.statusBar, signedIn: shell.signedInSegment, rowCount: rows.length }
    },
    expect: (a) => a && a.signedIn === true
  })

  await doStep({
    pathId: 'F.3',
    slug: 'auto-restore',
    note: { action: '关闭后带 ORCA_CLOUD_API_URL 重启', expected: '无需登录对话框，直接 signed-in（restoreSession）' },
    action: async () => {
      try {
        await app.close()
      } catch {}
      await sleep(2500)
      await launch(cloudTestEnv({ ORCA_CLOUD_API_URL: PLATFORM_URL }))
      await wait(12_000)
      await poll(async () => ((await readShell(page)).signedInSegment ? true : null), 30_000)
      await wait(2000)
    },
    read: async () => {
      const shell = await readShell(page)
      const dialog = await readLoginDialog(page)
      const rows = await rowsSnapshot()
      return {
        innerText: shell.statusBar,
        signedIn: shell.signedInSegment,
        loginDialogOpen: dialog !== null,
        rowCount: rows.length
      }
    },
    expect: (a) => a && a.signedIn === true && a.loginDialogOpen === false
  })

  await doStep({
    pathId: 'F.4',
    slug: 'session-revoked',
    note: { action: '读取会话文件并用 accessToken 调 POST /v1/auth/logout，再调 listProjects/openWorkspace', expected: '操作报 session expired/NOT_SIGNED_IN；UI 不应仍显示已登录' },
    action: async () => {
      const savedPath = path.join(USER_DATA, 'orca-cloud-session.json')
      const saved = JSON.parse(readFileSync(savedPath, 'utf8'))
      const revoke = await httpsPostJson(`${PLATFORM_URL}/v1/auth/logout`, {}, saved.accessToken)
      mem.revoke = revoke
      await wait(1500)
      mem.afterRevoke = await page.evaluate(async () => {
        const bridge = window.api.cloud
        const result = {}
        try {
          result.state = await bridge.getState()
        } catch (error) {
          result.stateError = String(error?.message ?? error)
        }
        try {
          result.projects = await bridge.listProjects()
        } catch (error) {
          result.listError = String(error?.message ?? error)
        }
        try {
          result.open = await bridge.openWorkspace('proj_fc96a124')
        } catch (error) {
          result.openError = String(error?.message ?? error)
        }
        return result
      })
      await wait(6000)
    },
    read: async () => {
      const after = mem.afterRevoke ?? {}
      const shell = await readShell(page)
      return {
        innerText: shell.statusBar,
        revoke: mem.revoke ?? null,
        listError: after.listError ?? null,
        listProjects: after.projects ?? null,
        open: after.open ?? null,
        openError: after.openError ?? null,
        stateStatus: after.state?.status ?? null,
        uiSignedIn: shell.signedInSegment,
        statusBar: shell.statusBar,
        notices: shell.statuses,
        alerts: shell.alerts
      }
    },
    expect: (a) =>
      a && a.revoke?.status === 200 && a.uiSignedIn === false
  })
  if (steps[steps.length - 1]?.result !== 'pass') {
    addFinding(
      'D-REVOKE-UI-STALE',
      'P1',
      '平台会话吊销后桌面 UI 仍显示已登录',
      `revoke=${JSON.stringify(steps[steps.length - 1]?.assertion?.revoke)}; listError=${steps[steps.length - 1]?.assertion?.listError}; uiSignedIn=${steps[steps.length - 1]?.assertion?.uiSignedIn}`,
      steps[steps.length - 1]?.screenshot
    )
  }
} catch (error) {
  console.error('FATAL', error)
  findings.push({
    id: 'FATAL-REPLAY',
    level: 'P0',
    title: '重放中断',
    detail: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
    evidence: null,
    at: new Date().toISOString()
  })
} finally {
  try {
    if (existsSync(README_BAK)) copyFileSync(README_BAK, README)
    if (existsSync(BIN)) unlinkSync(BIN)
  } catch {}
  try {
    await app?.close()
  } catch {}
  try {
    writeFileSync(path.join(OUT, 'console.log'), allLogs.join('\n'))
  } catch {}
  const summary = {
    totalSteps: steps.length,
    screenshots: steps.filter((s) => s.screenshot).length,
    passed: steps.filter((s) => s.result === 'pass').length,
    failed: steps.filter((s) => s.result === 'fail').length,
    errored: steps.filter((s) => s.result === 'error').length,
    observed: steps.filter((s) => s.result === 'observed').length,
    findings: findings.map((f) => ({ id: f.id, level: f.level, title: f.title }))
  }
  writeFileSync(
    path.join(OUT, 'steps.json'),
    JSON.stringify(
      {
        meta: {
          run: 'manual-review re-verification 1: desktop link',
          date: new Date().toISOString(),
          platform: PLATFORM_URL,
          account: 'zhangsan / Passw0rd!',
          build: 'pnpm build:electron-vite (exit 0) -> out/main/index.js',
          launch: 'Playwright _electron, ORCA_BACKGROUND_LAUNCH=1, ORCA_E2E_HEADLESS=1, isolated HOME/userData, CDP screenshots only',
          repo: REPO,
          pathsSource: 'cloud-platform/scripts/exploratory-r2/desktop-paths.md',
          userDataDir: USER_DATA
        },
        summary,
        steps,
        findings,
        deviations
      },
      null,
      2
    )
  )
  writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify({ findings, summary }, null, 2))
  writeFileSync(
    path.join(OUT, 'path-deviations.md'),
    [
      '# 路径重放偏差记录（桌面链路）',
      '',
      `- 执行时间：${new Date().toISOString()}`,
      '- 路径来源：`cloud-platform/scripts/exploratory-r2/desktop-paths.md`',
      '- 纪律：`ORCA_BACKGROUND_LAUNCH=1` / `ORCA_E2E_HEADLESS=1` / 隔离 HOME+userData / 仅 CDP 截图，无 show/focus。',
      '',
      ...(deviations.length
        ? deviations.map((d) => `- **${d.path}**：${d.note}`)
        : ['- 无路径重放偏差。']),
      ''
    ].join('\n')
  )
  console.log('SUMMARY', JSON.stringify(summary, null, 2))
  console.log('FINDINGS', JSON.stringify(findings, null, 2))
}
