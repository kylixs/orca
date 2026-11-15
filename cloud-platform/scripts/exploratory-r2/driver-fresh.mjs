/** Fresh-profile first login: worktree catalog + terminal + explorer on an online project. */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  dismissOnboarding,
  EVIDENCE,
  fillLogin,
  focusTerminal,
  launchDesktop,
  openLoginDialog,
  PLATFORM_URL,
  readShell,
  shoot,
  submitLogin,
  terminalText,
  typeInTerminal,
  waitSignedIn
} from './desktop-harness.mjs'

const USER_DATA = '/tmp/orca-explore-r2/ud-fresh'
const out = { probes: {} }
let app
let page
let logs
const wait = (ms) => page.waitForTimeout(ms)
try {
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
  out.probes.shell = await readShell(page)
  await shoot(page, '70-fresh-after-login.png')
  const clicked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-worktree-id]')]
    const row = rows.find((el) => /infra-tools/.test(el.innerText ?? '') && /主要|main/.test(el.innerText ?? ''))
    if (!row) return null
    ;(row.querySelector('[data-worktree-card-surface]') ?? row).click()
    return row.getAttribute('data-worktree-id')
  })
  out.probes.clicked = clicked
  await wait(8000)
  out.probes.afterActivate = await readShell(page)
  await shoot(page, '71-fresh-active.png')

  // Real click on the + button via Playwright (not DOM .click()).
  const plus = page.locator('button[aria-label="新标签页"], button[aria-label="New tab"]').first()
  out.probes.plusVisible = await plus.isVisible().catch(() => false)
  if (out.probes.plusVisible) {
    await plus.click({ timeout: 5000 }).catch((e) => { out.probes.plusClickError = String(e.message) })
    await wait(1500)
  }
  out.probes.menu = await page.evaluate(() => {
    const text = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim()
    return {
      wrappers: [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].length,
      menus: [...document.querySelectorAll('[role="menu"]')].map((el) => text(el).slice(0, 1000)),
      items: [...document.querySelectorAll('[role="menuitem"]')].map((el) => ({ text: text(el), disabled: el.getAttribute('data-disabled') !== null }))
    }
  })
  await shoot(page, '72-fresh-plus-menu.png')
  const picked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    const target = items.find((el) => /新终端|New Terminal|终端/i.test(el.innerText ?? ''))
    if (!target) return null
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    target.click()
    return (target.innerText ?? '').replace(/\s+/g, ' ').trim()
  })
  out.probes.menuPicked = picked
  await wait(7000)
  out.probes.afterMenu = await readShell(page)
  out.probes.focused = await focusTerminal(page)
  await shoot(page, '73-fresh-terminal.png')
  if (out.probes.focused) {
    await typeInTerminal(page, 'pwd && echo FRESH_UI_OK && echo 中文首次回声')
    await wait(5000)
    out.probes.term = await terminalText(page)
    out.probes.long = null
    await typeInTerminal(page, 'for i in $(seq 1 300); do echo FRESH_LONG_$i; done')
    await wait(7000)
    out.probes.long = await terminalText(page)
    out.probes.longSeen = (out.probes.long ?? '').includes('FRESH_LONG_300')
    await shoot(page, '74-fresh-terminal-output.png')
  }

  // Explorer via rail button.
  out.probes.explorerClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button[aria-label^="Explorer"]')].find((b) => b.getClientRects().length)
    if (!btn) return false
    btn.click()
    return true
  })
  await wait(4000)
  out.probes.explorerRows = await page.evaluate(() => {
    const shell = document.querySelector('[data-orca-explorer-shell]')
    return shell ? [...shell.querySelectorAll('button[data-file-explorer-row]')].map((el) => (el.innerText ?? '').replace(/\s+/g, ' ').trim()).slice(0, 40) : null
  })
  await shoot(page, '75-fresh-explorer.png')
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  out.logs = logs?.filter((l) => !l.includes('Electron Security Warning')).slice(0, 300)
  writeFileSync(path.join(EVIDENCE, 'fresh-stage.json'), JSON.stringify(out, null, 2))
  try { await app?.close() } catch {}
  console.log(JSON.stringify({
    error: out.error,
    signedIn: out.probes.signedIn,
    rows: out.probes.rows,
    clicked: out.probes.clicked,
    afterActivate: { terms: out.probes.afterActivate?.terminals, tabs: out.probes.afterActivate?.tabs, body: (out.probes.afterActivate?.bodyText ?? '').slice(0, 500) },
    plusVisible: out.probes.plusVisible,
    plusClickError: out.probes.plusClickError,
    menu: out.probes.menu,
    menuPicked: out.probes.menuPicked,
    afterMenu: { terms: out.probes.afterMenu?.terminals, tabs: out.probes.afterMenu?.tabs },
    focused: out.probes.focused,
    termTail: (out.probes.term ?? '').slice(-500),
    longSeen: out.probes.longSeen,
    explorerRows: out.probes.explorerRows,
    logs: out.logs
  }, null, 2))
}
