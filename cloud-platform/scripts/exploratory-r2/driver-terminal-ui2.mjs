/** UI terminal on the per-user checkout row (infra-tools main-2) — is session.tabs still used? */
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
  await wait(10000)
  out.probes.rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-worktree-id]')].map((el) => ({
      id: el.getAttribute('data-worktree-id'),
      text: (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
    }))
  )
  const clicked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-worktree-id]')]
    const row = rows.find((el) => /infra-tools/.test(el.innerText ?? '') && /main-2/.test(el.innerText ?? ''))
    if (!row) return null
    ;(row.querySelector('[data-worktree-card-surface]') ?? row).click()
    return row.getAttribute('data-worktree-id')
  })
  out.probes.clicked = clicked
  await wait(7000)
  out.probes.shellAfter = await readShell(page)
  await shoot(page, '60-per-user-active.png')
  await page.keyboard.press('Meta+t')
  await wait(7000)
  out.probes.afterMetaT = await readShell(page)
  out.probes.focused = await focusTerminal(page)
  await shoot(page, '61-per-user-terminal.png')
  if (out.probes.focused) {
    await typeInTerminal(page, 'pwd && echo UI_TERM_OK && echo 中文界面回声')
    await wait(5000)
    out.probes.term = await terminalText(page)
    await typeInTerminal(page, 'for i in $(seq 1 200); do echo UI_LONG_$i; done')
    await wait(6000)
    out.probes.long = await terminalText(page)
    out.probes.longSeen = (out.probes.long ?? '').includes('UI_LONG_200')
    await shoot(page, '62-per-user-terminal-output.png')
  }
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  out.logs = logs?.filter((l) => !l.includes('Electron Security Warning')).slice(0, 200)
  writeFileSync(path.join(EVIDENCE, 'terminal-ui2-stage.json'), JSON.stringify(out, null, 2))
  try { await app?.close() } catch {}
  console.log(JSON.stringify({
    error: out.error,
    rows: out.probes.rows,
    clicked: out.probes.clicked,
    after: { terms: out.probes.shellAfter?.terminals, tabs: out.probes.shellAfter?.tabs, body: (out.probes.shellAfter?.bodyText ?? '').slice(0, 400) },
    afterMetaT: { terms: out.probes.afterMetaT?.terminals, tabs: out.probes.afterMetaT?.tabs },
    focused: out.probes.focused,
    termTail: (out.probes.term ?? '').slice(-500),
    longSeen: out.probes.longSeen,
    logs: out.logs
  }, null, 2))
}
