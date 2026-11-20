/** Probe: new-tab menu items + terminal creation on an ONLINE worktree (infra-tools). */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  clickWorktree,
  dismissOnboarding,
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
const out = { probes: {} }
let app
let page
let logs
const wait = (ms) => page.waitForTimeout(ms)
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
  // Open the + menu and list items.
  out.probes.menuOpened = await page.evaluate(() => {
    const btn = [
      ...document.querySelectorAll('button[aria-label="新标签页"], button[aria-label="New tab"]')
    ].find((b) => b.getClientRects().length)
    if (!btn) return false
    btn.click()
    return true
  })
  await wait(1200)
  out.probes.menuItems = await page.evaluate(() => {
    return [
      ...document.querySelectorAll('[role="menuitem"], [data-slot="dropdown-menu-item"]')
    ].map((el) => ({
      text: (el.innerText ?? '').replace(/\s+/g, ' ').trim(),
      testid: el.getAttribute('data-testid'),
      disabled: el.getAttribute('data-disabled') !== null
    }))
  })
  await shoot(page, '40-newtab-menu.png')
  const selected = await page.evaluate(() => {
    const items = [
      ...document.querySelectorAll('[role="menuitem"], [data-slot="dropdown-menu-item"]')
    ]
    const target = items.find((el) => /终端|Terminal/i.test(el.innerText ?? ''))
    if (!target) return null
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    target.click()
    return target.innerText?.replace(/\s+/g, ' ').trim() ?? 'clicked'
  })
  out.probes.selectedMenu = selected
  await wait(6000)
  out.probes.afterSelect = await readShell(page)
  out.probes.focused = await focusTerminal(page)
  if (out.probes.focused) {
    await typeInTerminal(page, 'pwd && echo MENU_TERM_OK')
    await wait(5000)
    out.probes.term = await terminalText(page)
  }
  await shoot(page, '41-terminal-from-menu.png')
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  out.logs = logs?.filter((l) => !l.includes('Electron Security Warning')).slice(0, 200)
  writeFileSync(path.join(EVIDENCE, 'menuprobe-stage.json'), JSON.stringify(out, null, 2))
  try {
    await app?.close()
  } catch {}
  console.log(
    JSON.stringify(
      {
        error: out.error,
        clicked: out.probes.clicked,
        menuOpened: out.probes.menuOpened,
        menuItems: out.probes.menuItems,
        selectedMenu: out.probes.selectedMenu,
        afterSelect: {
          terms: out.probes.afterSelect?.terminals,
          tabs: out.probes.afterSelect?.tabs,
          body: (out.probes.afterSelect?.bodyText ?? '').slice(0, 600)
        },
        focused: out.probes.focused,
        termTail: (out.probes.term ?? '').slice(-400),
        logs: out.logs
      },
      null,
      2
    )
  )
}
