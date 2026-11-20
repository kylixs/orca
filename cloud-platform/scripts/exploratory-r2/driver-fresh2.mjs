/**
 * Fresh profile #2: per-user checkout row → file tree → editor edit/save round-trip →
 * markdown preview → binary → agents/skills → rapid project switching.
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  dismissOnboarding,
  dumpUi,
  EVIDENCE,
  fillLogin,
  launchDesktop,
  openLoginDialog,
  PLATFORM_URL,
  readShell,
  shoot,
  submitLogin,
  waitSignedIn
} from './desktop-harness.mjs'

const USER_DATA = '/tmp/orca-explore-r2/ud-fresh2'
const MAIN2 =
  '/Users/gongdewei/orca-local-env/host2/projects/infra-tools/.orca-worktrees/zhangsan/main-2'
const README = path.join(MAIN2, 'README.md')
const README_BACKUP = '/tmp/orca-explore-r2/README.main-2.bak'
const BIN = path.join(MAIN2, 'explore-binary.bin')
const out = { startedAt: new Date().toISOString(), probes: {}, findings: [] }
let app
let page
let logs
const wait = (ms) => page.waitForTimeout(ms)
const finding = (id, level, title, detail, evidence) =>
  out.findings.push({ id, level, title, detail, evidence, at: new Date().toISOString() })

async function clickAria(aria) {
  return page.evaluate((label) => {
    const el = [...document.querySelectorAll(`[aria-label="${label}"]`)].find(
      (e) => e.offsetParent !== null || e.getClientRects().length > 0
    )
    if (!el) return false
    el.click()
    return true
  }, aria)
}

try {
  if (existsSync(README)) copyFileSync(README, README_BACKUP)
  ;({ app, page, logs } = await launchDesktop({ userDataDir: USER_DATA, extraEnv: cloudTestEnv() }))
  await dismissOnboarding(page)
  await openLoginDialog(page)
  await fillLogin(page, { address: PLATFORM_URL, username: 'zhangsan', password: 'Passw0rd!' })
  await submitLogin(page)
  out.probes.signedIn = await waitSignedIn(page, 90_000)
  await wait(12000)
  out.probes.rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-worktree-id]')].map((el) => ({
      id: el.getAttribute('data-worktree-id'),
      text: (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
    }))
  )
  // Click the per-user checkout row (infra-tools main-2).
  out.probes.clickedMain2 = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-worktree-id]')].find(
      (el) => /infra-tools/.test(el.innerText ?? '') && /main-2/.test(el.innerText ?? '')
    )
    if (!row) return null
    ;(row.querySelector('[data-worktree-card-surface]') ?? row).click()
    return row.getAttribute('data-worktree-id')
  })
  await wait(8000)
  out.probes.afterMain2 = await readShell(page)
  await shoot(page, '80-main2-active.png')

  // Terminal via menu on main-2.
  const plus = page.locator('button[aria-label="新标签页"], button[aria-label="New tab"]').first()
  if (await plus.isVisible().catch(() => false)) {
    await plus.click({ timeout: 5000 }).catch(() => {})
    await wait(1200)
  }
  out.probes.menuPicked = await page.evaluate(() => {
    const target = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
      /新终端|New Terminal/i.test(el.innerText ?? '')
    )
    if (!target) return null
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    target.click()
    return (target.innerText ?? '').replace(/\s+/g, ' ').trim()
  })
  await wait(6000)
  out.probes.afterTerminalAttempt = await readShell(page)
  await shoot(page, '81-main2-terminal-attempt.png')

  // Explorer + README.
  out.probes.explorerClicked = await clickAria('Explorer (⌘⇧E)')
  await wait(4000)
  out.probes.explorerRows = await page.evaluate(() => {
    const shell = document.querySelector('[data-orca-explorer-shell]')
    return shell
      ? [...shell.querySelectorAll('button[data-file-explorer-row]')]
          .map((el) => (el.innerText ?? '').replace(/\s+/g, ' ').trim())
          .slice(0, 40)
      : null
  })
  out.probes.readmeOpen = await page.evaluate(() => {
    const shell = document.querySelector('[data-orca-explorer-shell]')
    const row = shell
      ? [...shell.querySelectorAll('button[data-file-explorer-row]')].find((el) =>
          /README\.md/i.test(el.innerText ?? '')
        )
      : null
    if (!row) return null
    row.click()
    return (row.innerText ?? '').trim()
  })
  await wait(6000)
  out.probes.editor = await page.evaluate(() => ({
    headers: [...document.querySelectorAll('.editor-header-path')].map((el) =>
      el.textContent?.trim()
    ),
    monaco: Boolean(document.querySelector('.monaco-editor')),
    body: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 900)
  }))
  await shoot(page, '82-main2-editor.png')

  // Edit: append marker via keyboard inside Monaco.
  const marker = `EXPLORE_R2_EDIT_${Date.now()}`
  out.probes.editorFocus = await page.evaluate(() => {
    const ta = document.querySelector('.monaco-editor textarea')
    if (!ta) return false
    ta.focus()
    const el = [...document.querySelectorAll('.monaco-editor .view-lines')].pop()
    el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    el?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    return true
  })
  if (out.probes.editorFocus) {
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.press('Meta+ArrowRight')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText(marker)
    await wait(1000)
    await page.keyboard.press('Meta+s')
    await wait(4000)
  }
  out.probes.fileAfterSave = existsSync(README) ? readFileSync(README, 'utf8') : null
  out.probes.saveRoundTrip = (out.probes.fileAfterSave ?? '').includes(marker)
  out.probes.saveUi = await page.evaluate(() =>
    (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 800)
  )
  await shoot(page, '83-main2-saved.png')
  if (!out.probes.saveRoundTrip) {
    finding(
      'P2',
      'D-FILE-SAVE-FAIL',
      '编辑保存未落盘',
      `在 main-2 的 README.md 追加标记后 Cmd+S，磁盘内容未包含标记：${marker}`,
      '83-main2-saved.png'
    )
  }

  // Markdown preview toggle.
  out.probes.previewButton = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')].filter(
      (b) => b.getClientRects().length
    )
    const target = buttons.find((b) =>
      /预览|preview/i.test(
        `${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.innerText ?? ''}`
      )
    )
    if (!target) return null
    const label =
      `${target.getAttribute('aria-label') ?? ''} ${target.getAttribute('title') ?? ''} ${target.innerText ?? ''}`.trim()
    target.click()
    return label.slice(0, 120)
  })
  await wait(4000)
  out.probes.previewState = await page.evaluate(() => {
    const body = (document.body.innerText ?? '').replace(/\s+/g, ' ')
    return {
      rendered: /基础设施运维工具集/.test(body),
      source: /# infra-tools/.test(body),
      body: body.slice(0, 900)
    }
  })
  await shoot(page, '84-main2-preview.png')

  // Binary.
  writeFileSync(BIN, Buffer.from([0, 1, 2, 3, 255, 254, 0, 66, 67]))
  out.probes.refreshClicked = await page.evaluate(() => {
    const shell = document.querySelector('[data-orca-explorer-shell]')
    const btn = shell
      ? [...shell.querySelectorAll('button')].find((b) =>
          /刷新|refresh/i.test(
            `${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''}`
          )
        )
      : null
    if (!btn) return false
    btn.click()
    return true
  })
  await wait(3500)
  out.probes.binaryOpen = await page.evaluate(() => {
    const shell = document.querySelector('[data-orca-explorer-shell]')
    const row = shell
      ? [...shell.querySelectorAll('button[data-file-explorer-row]')].find((el) =>
          /explore-binary\.bin/i.test(el.innerText ?? '')
        )
      : null
    if (!row) return null
    row.click()
    return (row.innerText ?? '').trim()
  })
  await wait(4000)
  out.probes.binaryState = await page.evaluate(() => {
    const body = (document.body.innerText ?? '').replace(/\s+/g, ' ')
    return {
      hasControlChars: /[\u0000-\u0008\u000e-\u001f]/.test(body),
      hasNotice: /二进制|不支持|unsupported|binary file/i.test(body),
      body: body.slice(0, 900)
    }
  })
  await shoot(page, '85-main2-binary.png')
  if (out.probes.binaryState?.hasControlChars && !out.probes.binaryState?.hasNotice) {
    finding(
      'P2',
      'D-BINARY-RAW',
      '二进制文件按文本渲染',
      '打开 .bin 文件时编辑器显示原始控制字符，未给出二进制/不支持提示',
      '85-main2-binary.png'
    )
  }

  // Agents panel + settings/skills.
  out.probes.agentsClicked = await clickAria('Agents')
  await wait(4000)
  out.probes.agents = await page.evaluate(() => ({
    body: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1400),
    testids: [
      ...new Set(
        [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))
      )
    ].slice(0, 100)
  }))
  await shoot(page, '86-agents.png')
  out.probes.settingsClicked = await clickAria('设置')
  await wait(3500)
  out.probes.settings = await page.evaluate(() => ({
    body: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1400),
    dialogs: [...document.querySelectorAll('[data-slot="dialog-content"], [role="dialog"]')].map(
      (d) => (d.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300)
    )
  }))
  await shoot(page, '87-settings.png')
  // Find and open the Skills pane if the settings text names it.
  out.probes.skillsNav = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, [role="tab"], [role="menuitem"], a')].find(
      (b) => /技能|Skills/i.test(b.innerText ?? '')
    )
    if (!el) return null
    el.click()
    return (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  })
  await wait(3500)
  out.probes.skills = await page.evaluate(() => ({
    body: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1400),
    testids: [
      ...new Set(
        [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))
      )
    ].slice(0, 100)
  }))
  await shoot(page, '88-skills.png')

  // Rapid project switching boundary.
  const switched = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-worktree-id]')]
    const root = rows.find(
      (el) => /infra-tools/.test(el.innerText ?? '') && /主要/.test(el.innerText ?? '')
    )
    const perUser = rows.find(
      (el) => /infra-tools/.test(el.innerText ?? '') && /main-2/.test(el.innerText ?? '')
    )
    const surfaces = [root, perUser, root, perUser].filter(Boolean)
    for (const row of surfaces) (row.querySelector('[data-worktree-card-surface]') ?? row).click()
    return surfaces.length
  })
  out.probes.rapidSwitches = switched
  await wait(6000)
  out.probes.afterRapid = await readShell(page)
  await shoot(page, '89-rapid-switch.png')
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  try {
    if (existsSync(README_BACKUP)) copyFileSync(README_BACKUP, README)
    if (existsSync(BIN)) unlinkSync(BIN)
  } catch {}
  out.logs = logs?.filter((l) => !l.includes('Electron Security Warning')).slice(0, 300)
  out.finishedAt = new Date().toISOString()
  writeFileSync(path.join(EVIDENCE, 'fresh2-stage.json'), JSON.stringify(out, null, 2))
  try {
    await page?.screenshot({ path: path.join(EVIDENCE, 'screenshots', '89-fresh2-final.png') })
  } catch {}
  try {
    await app?.close()
  } catch {}
  console.log(
    JSON.stringify(
      {
        error: out.error,
        findings: out.findings,
        signedIn: out.probes.signedIn,
        clickedMain2: out.probes.clickedMain2,
        rows: out.probes.rows,
        menuPicked: out.probes.menuPicked,
        afterTerminalAttempt: {
          terms: out.probes.afterTerminalAttempt?.terminals,
          tabs: out.probes.afterTerminalAttempt?.tabs,
          body: (out.probes.afterTerminalAttempt?.bodyText ?? '').slice(0, 400)
        },
        explorerRows: out.probes.explorerRows,
        readmeOpen: out.probes.readmeOpen,
        editor: { headers: out.probes.editor?.headers, monaco: out.probes.editor?.monaco },
        editorFocus: out.probes.editorFocus,
        saveRoundTrip: out.probes.saveRoundTrip,
        previewButton: out.probes.previewButton,
        preview: {
          rendered: out.probes.previewState?.rendered,
          source: out.probes.previewState?.source
        },
        binaryOpen: out.probes.binaryOpen,
        binaryState: {
          control: out.probes.binaryState?.hasControlChars,
          notice: out.probes.binaryState?.hasNotice
        },
        agentsClicked: out.probes.agentsClicked,
        agentsBody: out.probes.agents?.body?.slice(0, 700),
        settingsClicked: out.probes.settingsClicked,
        skillsNav: out.probes.skillsNav,
        skillsBody: out.probes.skills?.body?.slice(0, 700),
        rapidSwitches: out.probes.rapidSwitches,
        afterRapid: {
          alerts: out.probes.afterRapid?.alerts,
          body: (out.probes.afterRapid?.bodyText ?? '').slice(0, 500)
        },
        logs: out.logs
      },
      null,
      2
    )
  )
}
