/**
 * Stage: online worktree (infra-tools) — terminal create/echo/Chinese/long/multi-tab,
 * explorer → editor → save → markdown preview, binary open, Agents panel.
 */
import { writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  clickWorktree,
  dismissOnboarding,
  dumpUi,
  EVIDENCE,
  fillLogin,
  focusTerminal,
  launchDesktop,
  openLoginDialog,
  readShell,
  shoot,
  submitLogin,
  terminalText,
  typeInTerminal,
  waitSignedIn
} from './desktop-harness.mjs'

const USER_DATA = '/tmp/orca-explore-r2/ud-main'
const WORKTREE_PATH = '/Users/gongdewei/orca-local-env/host2/projects/infra-tools'
const BIN_FILE = path.join(WORKTREE_PATH, 'explore-binary.bin')
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
  ;({ app, page, logs } = await launchDesktop({ userDataDir: USER_DATA, extraEnv: cloudTestEnv() }))
  await dismissOnboarding(page)
  await openLoginDialog(page)
  await fillLogin(page, { password: 'Passw0rd!' })
  await submitLogin(page)
  out.probes.signedIn = await waitSignedIn(page)
  await wait(9000)
  out.probes.clicked = await clickWorktree(page, ['infra-tools', '主要'])
  await wait(7000)
  out.probes.shellAfterActivate = await readShell(page)
  out.probes.settings = await page.evaluate(async () => {
    try {
      const s = await window.api.settings.get()
      return { activeRuntimeEnvironmentId: s.activeRuntimeEnvironmentId ?? null }
    } catch (e) {
      return { error: String(e?.message ?? e) }
    }
  })
  out.probes.runtimeStatus = await page.evaluate(async () => {
    try {
      const envs = await window.api.runtimeEnvironments.list()
      const env = envs.find((e) => e.name === 'infra-tools')
      const call = await window.api.runtimeEnvironments.call({
        selector: env.id,
        method: 'status.get',
        params: {}
      })
      return { envId: env.id, call }
    } catch (e) {
      return { error: String(e?.message ?? e) }
    }
  })

  // 1) Terminal via Meta+T (tab.newTerminal).
  await page.keyboard.press('Meta+t')
  await wait(6000)
  out.probes.afterMetaT = await readShell(page)
  out.probes.focusedMetaT = await focusTerminal(page)
  await shoot(page, '50-after-meta-t.png')

  // 2) Terminal via + menu, selecting "New Terminal" if the menu opens.
  out.probes.plusClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button[aria-label="新标签页"], button[aria-label="New tab"]')].find(
      (b) => b.getClientRects().length
    )
    if (!btn) return false
    btn.click()
    return true
  })
  await wait(1200)
  out.probes.menuDump = await page.evaluate(() => {
    const text = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim()
    return {
      menuWrappers: [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].length,
      items: [...document.querySelectorAll('[role="menuitem"], [data-slot="dropdown-menu-item"]')].map(
        (el) => ({ text: text(el), disabled: el.getAttribute('data-disabled') !== null })
      ),
      menuTexts: [...document.querySelectorAll('[role="menu"]')].map((el) => text(el).slice(0, 800))
    }
  })
  await shoot(page, '51-plus-menu.png')
  const picked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menuitem"], [data-slot="dropdown-menu-item"]')]
    const target = items.find((el) => /新终端|终端|New Terminal/i.test(el.innerText ?? ''))
    if (!target) return null
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    target.click()
    return target.innerText?.replace(/\s+/g, ' ').trim() ?? 'clicked'
  })
  out.probes.menuPicked = picked
  await wait(6000)
  out.probes.afterMenu = await readShell(page)
  out.probes.focusedMenu = await focusTerminal(page)
  await shoot(page, '52-after-menu-terminal.png')

  if (await focusTerminal(page)) {
    await typeInTerminal(page, 'pwd && echo INFRA_ECHO_OK')
    await wait(5000)
    out.probes.echo = await terminalText(page)
    await typeInTerminal(page, 'echo 中文输入回声_基础设施')
    await wait(4000)
    out.probes.chinese = await terminalText(page)
    await typeInTerminal(page, "for i in $(seq 1 400); do echo LONG_LINE_$i; done")
    await wait(8000)
    out.probes.long = await terminalText(page)
    out.probes.longTailSeen = (out.probes.long ?? '').includes('LONG_LINE_400')
    await shoot(page, '53-terminal-long.png')
    // second tab via Meta+T
    await page.keyboard.press('Meta+t')
    await wait(5000)
    out.probes.afterSecond = await readShell(page)
    await shoot(page, '54-two-terminals.png')
  }

  // 3) Explorer.
  out.probes.explorerClicked = await clickAria('Explorer (⌘⇧E)')
  await wait(3000)
  out.probes.explorerRows = await page.evaluate(() => {
    const shell = document.querySelector('[data-orca-explorer-shell]')
    if (!shell) return null
    return [...shell.querySelectorAll('button[data-file-explorer-row]')].map((el) => (el.innerText ?? '').replace(/\s+/g, ' ').trim()).slice(0, 40)
  })
  await shoot(page, '55-explorer.png')

  // 4) Open README.md → assert editor content.
  out.probes.readmeOpen = await page.evaluate(() => {
    const shell = document.querySelector('[data-orca-explorer-shell]')
    if (!shell) return null
    const row = [...shell.querySelectorAll('button[data-file-explorer-row]')].find((el) =>
      /README\.md/i.test(el.innerText ?? '')
    )
    if (!row) return null
    row.click()
    return (row.innerText ?? '').trim()
  })
  await wait(6000)
  out.probes.editorAfterOpen = await page.evaluate(() => ({
    headers: [...document.querySelectorAll('.editor-header-path')].map((el) => el.textContent?.trim()),
    monaco: Boolean(document.querySelector('.monaco-editor')),
    body: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 900)
  }))
  await shoot(page, '56-editor-open.png')

  // 5) Markdown preview toggle (find a button whose aria/title mentions preview).
  out.probes.previewButton = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length)
    const target = buttons.find((b) => /预览|preview/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.innerText ?? ''}`))
    if (!target) return null
    const label = `${target.getAttribute('aria-label') ?? ''} ${target.getAttribute('title') ?? ''}`.trim()
    target.click()
    return label
  })
  await wait(3500)
  out.probes.previewState = await page.evaluate(() => {
    const body = (document.body.innerText ?? '').replace(/\s+/g, ' ')
    return {
      hasRenderedHeading: /基础设施运维工具集/.test(body),
      hasMarkdownSource: /# infra-tools/.test(body),
      body: body.slice(0, 900)
    }
  })
  await shoot(page, '57-md-preview.png')

  // 6) Binary: create locally in the host workspace, refresh explorer, open.
  writeFileSync(BIN_FILE, Buffer.from([0, 1, 2, 3, 255, 254, 0, 66, 67]))
  out.probes.binaryCreated = true
  out.probes.refreshClicked = await page.evaluate(() => {
    const shell = document.querySelector('[data-orca-explorer-shell]')
    if (!shell) return false
    const btn = [...shell.querySelectorAll('button')].find(
      (b) => /刷新|refresh/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''}`)
    )
    if (!btn) return false
    btn.click()
    return true
  })
  await wait(3000)
  out.probes.binaryRows = await page.evaluate(() => {
    const shell = document.querySelector('[data-orca-explorer-shell]')
    return shell
      ? [...shell.querySelectorAll('button[data-file-explorer-row]')]
          .map((el) => (el.innerText ?? '').replace(/\s+/g, ' ').trim())
          .filter((t) => /explore-binary/.test(t))
      : null
  })
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
  out.probes.binaryState = await page.evaluate(() => ({
    body: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 900),
    hasBinaryNotice: /二进制|binary|不支持|unsupported/i.test(document.body.innerText ?? '')
  }))
  await shoot(page, '58-binary.png')

  // 7) Agents panel.
  out.probes.agentsClicked = await clickAria('Agents')
  await wait(4000)
  out.probes.agentsPanel = await page.evaluate(() => {
    const body = (document.body.innerText ?? '').replace(/\s+/g, ' ')
    return { body: body.slice(0, 1400), testids: [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].slice(0, 80) }
  })
  out.probes.uiAgents = await dumpUi(page)
  await shoot(page, '59-agents.png')
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  try {
    if (readFileSync) {
      const fs = await import('node:fs')
      if (fs.existsSync(BIN_FILE)) fs.unlinkSync(BIN_FILE)
    }
  } catch {}
  out.logs = logs?.filter((l) => !l.includes('Electron Security Warning')).slice(0, 300)
  out.finishedAt = new Date().toISOString()
  writeFileSync(path.join(EVIDENCE, 'infra-stage.json'), JSON.stringify(out, null, 2))
  try { await page?.screenshot({ path: path.join(EVIDENCE, 'screenshots', '59-infra-final.png') }) } catch {}
  try { await app?.close() } catch {}
  console.log(
    JSON.stringify(
      {
        error: out.error,
        findings: out.findings,
        signedIn: out.probes.signedIn,
        clicked: out.probes.clicked,
        settings: out.probes.settings,
        runtimeStatus: out.probes.runtimeStatus,
        afterMetaT: { terms: out.probes.afterMetaT?.terminals, tabs: out.probes.afterMetaT?.tabs, body: (out.probes.afterMetaT?.bodyText ?? '').slice(0, 400) },
        focusedMetaT: out.probes.focusedMetaT,
        menu: out.probes.menuDump,
        menuPicked: out.probes.menuPicked,
        afterMenu: { terms: out.probes.afterMenu?.terminals, tabs: out.probes.afterMenu?.tabs },
        focusedMenu: out.probes.focusedMenu,
        echoTail: (out.probes.echo ?? '').slice(-300),
        chineseTail: (out.probes.chinese ?? '').slice(-300),
        longTailSeen: out.probes.longTailSeen,
        explorerRows: out.probes.explorerRows,
        readmeOpen: out.probes.readmeOpen,
        editor: { headers: out.probes.editorAfterOpen?.headers, monaco: out.probes.editorAfterOpen?.monaco },
        previewButton: out.probes.previewButton,
        previewState: { rendered: out.probes.previewState?.hasRenderedHeading, source: out.probes.previewState?.hasMarkdownSource },
        binaryRows: out.probes.binaryRows,
        binaryOpen: out.probes.binaryOpen,
        binaryNotice: out.probes.binaryState?.hasBinaryNotice,
        agentsClicked: out.probes.agentsClicked,
        agentsBody: out.probes.agentsPanel?.body?.slice(0, 900),
        logs: out.logs?.filter((l) => /error|warn|CloudRuntime|terminal|session\.tabs/.test(l)).slice(0, 80)
      },
      null,
      2
    )
  )
}
