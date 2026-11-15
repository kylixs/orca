/** Probe: worktree row interactive structure + right sidebar buttons. */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  dismissOnboarding,
  EVIDENCE,
  fillLogin,
  launchDesktop,
  openLoginDialog,
  readShell,
  shoot,
  submitLogin,
  waitSignedIn
} from './desktop-harness.mjs'

const USER_DATA = '/tmp/orca-explore-r2/ud-main'
const out = {}
let app
let page
try {
  ;({ app, page } = await launchDesktop({ userDataDir: USER_DATA, extraEnv: cloudTestEnv() }))
  await dismissOnboarding(page)
  await openLoginDialog(page)
  await fillLogin(page, { password: 'Passw0rd!' })
  await submitLogin(page)
  await waitSignedIn(page)
  await page.waitForTimeout(9000)
  out.shellBefore = await readShell(page)
  out.rowDom = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-worktree-id]')]
    const row = rows.find((el) => (el.innerText ?? '').includes('zhangsan-demo'))
    if (!row) return null
    const describe = (el) => ({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 160),
      text: (el.innerText ?? '').replace(/\s+/g, ' ').slice(0, 100),
      aria: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      testid: el.getAttribute('data-testid'),
      data: Object.fromEntries([...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value.slice(0, 80)]))
    })
    return {
      row: describe(row),
      ancestors: (() => { const list = []; let e = row.parentElement; for (let i = 0; i < 4 && e; i++, e = e.parentElement) list.push(describe(e)); return list })(),
      descendants: [...row.querySelectorAll('*')].slice(0, 40).map(describe)
    }
  })
  out.sidebarDom = await page.evaluate(() => {
    const text = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim()
    const rail = [...document.querySelectorAll('[aria-label="Explorer (⌘⇧E)"], [aria-label="Agents"], [aria-label="Source Control (⌘⇧G)"]')].map((el) => el.closest('button')?.outerHTML.slice(0, 300))
    return { rail }
  })
  await shoot(page, '24-rowdom.png')
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  writeFileSync(path.join(EVIDENCE, 'rowdom-stage.json'), JSON.stringify(out, null, 2))
  try { await app?.close() } catch {}
  console.log(JSON.stringify({ error: out.error, row: out.rowDom?.row, descendants: out.rowDom?.descendants, ancestors: out.rowDom?.ancestors, rail: out.sidebarDom?.rail }, null, 2))
}
