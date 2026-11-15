/** Stage: activate worktree → open terminal → echo / Chinese / long output / multi-tab / close. */
import { writeFileSync } from 'node:fs'
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
const out = { startedAt: new Date().toISOString(), probes: {} }
let app
let page
let logs
const wait = (ms) => page.waitForTimeout(ms)

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
  out.probes.signedIn = await waitSignedIn(page, 90_000)
  await wait(9000)
  out.probes.clicked = await clickWorktree(page, ['zhangsan-demo', '主要'])
  await wait(6000)
  out.probes.afterActivate = await readShell(page)

  // New tab; usually the default terminal.
  out.probes.newTabClicked = await clickAria('新标签页')
  await wait(5000)
  out.probes.afterNewTab = await readShell(page)
  out.probes.uiAfterNewTab = await dumpUi(page)
  await shoot(page, '30-terminal-open.png')

  let focused = await focusTerminal(page)
  if (!focused) {
    // Try command palette style tab creation via keyboard shortcut as fallback.
    await page.keyboard.press('Meta+t')
    await wait(4000)
    focused = await focusTerminal(page)
    out.probes.fallbackCmdT = focused
    await shoot(page, '31-terminal-cmdt.png')
  }
  out.probes.terminalFocused = focused

  if (focused) {
    await typeInTerminal(page, 'pwd && echo EXPLORE_ECHO_OK')
    await wait(5000)
    out.probes.echo = await terminalText(page)
    await shoot(page, '32-terminal-echo.png')

    // Chinese input through the xterm textarea (insertText triggers input events).
    await typeInTerminal(page, 'echo 中文输入回声_测试')
    await wait(4000)
    out.probes.chinese = await terminalText(page)
    await shoot(page, '33-terminal-chinese.png')

    // Long output: scrollback must hold the tail.
    await typeInTerminal(page, "for i in $(seq 1 400); do echo LONG_LINE_$i; done")
    await wait(8000)
    out.probes.longOutput = await terminalText(page)
    out.probes.longTailSeen = (out.probes.longOutput ?? '').includes('LONG_LINE_400')
    await page.evaluate(() => {
      const t = [...document.querySelectorAll('.xterm')].find((el) => el.offsetParent !== null)
      t?.querySelector('.xterm-viewport')?.scrollTo(0, 999999)
    })
    await wait(1000)
    out.probes.scrolledBottom = await terminalText(page)
    await shoot(page, '34-terminal-long.png')

    // Multi-tab: second new tab.
    out.probes.secondTabClicked = await clickAria('新标签页')
    await wait(5000)
    out.probes.afterSecondTab = await readShell(page)
    out.probes.terminalsAfterSecond = out.probes.afterSecondTab.terminals
    await shoot(page, '35-terminal-two-tabs.png')
    out.probes.uiTwoTabs = await dumpUi(page)

    // Close the active tab via its close control if discoverable.
    out.probes.closedTab = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[tabs.length - 1]
      if (!active) return null
      const close = active.querySelector('[aria-label*="关闭"], [aria-label*="Close"], button')
      if (!close) return { noClose: true, tab: active.textContent?.slice(0, 60) }
      close.click()
      return { tab: active.textContent?.slice(0, 60) }
    })
    await wait(4000)
    out.probes.afterClose = await readShell(page)
    await shoot(page, '36-terminal-after-close.png')
  }
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  out.logs = logs?.slice(0, 200) ?? []
  out.finishedAt = new Date().toISOString()
  writeFileSync(path.join(EVIDENCE, 'terminal-stage.json'), JSON.stringify(out, null, 2))
  try { await page?.screenshot({ path: path.join(EVIDENCE, 'screenshots', '39-terminal-final.png') }) } catch {}
  try { await app?.close() } catch {}
  console.log(JSON.stringify({
    error: out.error,
    signedIn: out.probes.signedIn,
    clicked: out.probes.clicked,
    afterActivate: { terms: out.probes.afterActivate?.terminals, tabs: out.probes.afterActivate?.tabs, body: (out.probes.afterActivate?.bodyText ?? '').slice(0, 400) },
    newTabClicked: out.probes.newTabClicked,
    afterNewTab: { terms: out.probes.afterNewTab?.terminals, tabs: out.probes.afterNewTab?.tabs, body: (out.probes.afterNewTab?.bodyText ?? '').slice(0, 500) },
    terminalFocused: out.probes.terminalFocused,
    echoTail: JSON.stringify((out.probes.echo ?? '').slice(-400)),
    chineseTail: JSON.stringify((out.probes.chinese ?? '').slice(-400)),
    longTailSeen: out.probes.longTailSeen,
    longTail: JSON.stringify((out.probes.scrolledBottom ?? '').slice(-600)),
    terminalsAfterSecond: out.probes.terminalsAfterSecond,
    afterCloseTabs: out.probes.afterClose?.tabs,
    closedTab: out.probes.closedTab
  }, null, 2))
}
