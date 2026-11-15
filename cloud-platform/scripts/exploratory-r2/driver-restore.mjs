/** Stage: restart with ORCA_CLOUD_API_URL → auto session restore → UI logout while a tab is open. */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  dismissOnboarding,
  EVIDENCE,
  launchDesktop,
  openLoginDialog,
  PLATFORM_URL,
  readLoginDialog,
  readShell,
  shoot,
  waitSignedIn
} from './desktop-harness.mjs'

const USER_DATA = '/tmp/orca-explore-r2/ud-fresh2'
const out = { probes: {} }
let app
let page
let logs
const wait = (ms) => page.waitForTimeout(ms)
try {
  ;({ app, page, logs } = await launchDesktop({
    userDataDir: USER_DATA,
    extraEnv: cloudTestEnv({ ORCA_CLOUD_API_URL: PLATFORM_URL })
  }))
  await dismissOnboarding(page)
  await wait(12000)
  out.probes.shellAfterRestore = await readShell(page)
  out.probes.autoSignedIn = out.probes.shellAfterRestore.signedInSegment
  out.probes.loginDialog = await readLoginDialog(page)
  await shoot(page, '96-auto-restore.png')

  if (!out.probes.autoSignedIn) {
    // Record whether the dialog at least opened, then wait longer for restore.
    for (let i = 0; i < 30; i += 1) {
      await wait(1000)
      const shell = await readShell(page)
      if (shell.signedInSegment) {
        out.probes.autoSignedIn = true
        out.probes.shellAfterRestore = shell
        out.probes.restoreDelayMs = (i + 1) * 1000
        break
      }
    }
  }

  // Activate a worktree so a tab is open, then use the UI sign-out segment.
  if (out.probes.autoSignedIn) {
    out.probes.clicked = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-worktree-id]')].find((el) => /infra-tools/.test(el.innerText ?? '') && /main-2/.test(el.innerText ?? ''))
      if (!row) return null
      ;(row.querySelector('[data-worktree-card-surface]') ?? row).click()
      return row.getAttribute('data-worktree-id')
    })
    await wait(8000)
    out.probes.tabsBeforeLogout = await readShell(page)
    await shoot(page, '97-before-ui-logout.png')
    out.probes.logoutClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('[data-status-bar] button')].find((b) => /登出|Sign out/i.test(b.innerText ?? ''))
      if (!btn) return false
      btn.click()
      return true
    })
    await wait(8000)
    out.probes.afterLogout = await readShell(page)
    out.probes.rowsAfterLogout = await page.evaluate(() =>
      [...document.querySelectorAll('[data-worktree-id]')].map((el) => (el.innerText ?? '').replace(/\s+/g, ' ').trim()).slice(0, 20)
    )
    out.probes.loginDialogAfter = await readLoginDialog(page)
    await shoot(page, '98-after-ui-logout.png')
  }
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  out.logs = logs?.filter((l) => !l.includes('Electron Security Warning')).slice(0, 300)
  writeFileSync(path.join(EVIDENCE, 'restore-stage.json'), JSON.stringify(out, null, 2))
  try { await app?.close() } catch {}
  console.log(JSON.stringify({
    error: out.error,
    autoSignedIn: out.probes.autoSignedIn,
    restoreDelayMs: out.probes.restoreDelayMs,
    signedInSegment: out.probes.shellAfterRestore?.signedInSegment,
    statusBar: out.probes.shellAfterRestore?.statusBar,
    loginDialog: out.probes.loginDialog,
    clicked: out.probes.clicked,
    tabsBeforeLogout: out.probes.tabsBeforeLogout?.tabs,
    logoutClicked: out.probes.logoutClicked,
    afterLogout: { signedIn: out.probes.afterLogout?.signedInSegment, statusBar: out.probes.afterLogout?.statusBar, body: (out.probes.afterLogout?.bodyText ?? '').slice(0, 600) },
    rowsAfterLogout: out.probes.rowsAfterLogout,
    loginDialogAfter: out.probes.loginDialogAfter,
    logs: out.logs
  }, null, 2))
}
