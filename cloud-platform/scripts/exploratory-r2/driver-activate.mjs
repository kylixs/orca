/** Stage: restart memory prefill → sign in → activate a cloud worktree → terminal echo. */
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
  PLATFORM_URL,
  readLoginDialog,
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
try {
  ;({ app, page, logs } = await launchDesktop({ userDataDir: USER_DATA, extraEnv: cloudTestEnv() }))
  await dismissOnboarding(page)
  await openLoginDialog(page)
  const prefill = await readLoginDialog(page)
  out.probes.restartPrefill = prefill
  await shoot(page, '20-restart-prefill.png')
  await fillLogin(page, { password: 'Passw0rd!' })
  await submitLogin(page)
  out.probes.signedIn = await waitSignedIn(page, 90_000)
  await page.waitForTimeout(9000)
  out.probes.afterHydration = await readShell(page)
  await shoot(page, '21-after-relogin.png')

  const clicked = await clickWorktree(page, ['zhangsan-demo', '主要'])
  out.probes.clickedWorktree = clicked
  await page.waitForTimeout(7000)
  out.probes.afterActivate = await readShell(page)
  out.probes.ui = await dumpUi(page)
  await shoot(page, '22-worktree-active.png')

  const focused = await focusTerminal(page)
  out.probes.terminalFocused = focused
  if (focused) {
    await typeInTerminal(page, 'pwd && echo EXPLORE_ECHO_OK')
    await page.waitForTimeout(5000)
    out.probes.terminalAfterPwd = await terminalText(page)
    await shoot(page, '23-terminal-pwd.png')
  } else {
    out.probes.terminalAfterPwd = null
  }
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  out.logs = logs?.slice(0, 200) ?? []
  out.finishedAt = new Date().toISOString()
  writeFileSync(path.join(EVIDENCE, 'activate-stage.json'), JSON.stringify(out, null, 2))
  try { await page?.screenshot({ path: path.join(EVIDENCE, 'screenshots', '29-activate-final.png') }) } catch {}
  try { await app?.close() } catch {}
  console.log(JSON.stringify({ error: out.error, prefill: out.probes.restartPrefill, clicked: out.probes.clickedWorktree, terminals: out.probes.afterActivate?.terminals, tabs: out.probes.afterActivate?.tabs, terminalTextTail: (out.probes.terminalAfterPwd ?? '').slice(-600), uiButtons: out.probes.ui?.buttons?.slice(0, 40) }, null, 2))
}
