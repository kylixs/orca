/**
 * Fresh profile #3: editor edit/save round-trip, markdown mode, agents/skills,
 * rapid switching, and sign-out while a file tab is open.
 */
import { writeFileSync, readFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs'
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

const USER_DATA = '/tmp/orca-explore-r2/ud-final'
const MAIN2 = '/Users/gongdewei/orca-local-env/host2/projects/infra-tools/.orca-worktrees/zhangsan/main-2'
const README = path.join(MAIN2, 'README.md')
const BACKUP = '/tmp/orca-explore-r2/README.final.bak'
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
  if (existsSync(README)) copyFileSync(README, BACKUP)
  ;({ app, page, logs } = await launchDesktop({ userDataDir: USER_DATA, extraEnv: cloudTestEnv() }))
  await dismissOnboarding(page)
  await openLoginDialog(page)
  await fillLogin(page, { address: PLATFORM_URL, username: 'zhangsan', password: 'Passw0rd!' })
  await submitLogin(page)
  out.probes.signedIn = await waitSignedIn(page, 90_000)
  await wait(12000)
  out.probes.clickedMain2 = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-worktree-id]')].find(
      (el) => /infra-tools/.test(el.innerText ?? '') && /main-2/.test(el.innerText ?? '')
    )
    if (!row) return null
    ;(row.querySelector('[data-worktree-card-surface]') ?? row).click()
    return row.getAttribute('data-worktree-id')
  })
  await wait(8000)

  // Rapid project switching (no modal): per-user ↔ project root ↔ per-user.
  out.probes.rapidSwitchClicks = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-worktree-id]')]
    const root = rows.find((el) => /infra-tools/.test(el.innerText ?? '') && /主要/.test(el.innerText ?? ''))
    const perUser = rows.find((el) => /infra-tools/.test(el.innerText ?? '') && /main-2/.test(el.innerText ?? ''))
    const targets = [perUser, root, perUser, root, perUser].filter(Boolean)
    for (const row of targets) (row.querySelector('[data-worktree-card-surface]') ?? row).click()
    return targets.length
  })
  await wait(6000)
  out.probes.afterRapid = await readShell(page)
  await shoot(page, '90-rapid-switch.png')

  // Explorer + README.
  out.probes.explorerClicked = await clickAria('Explorer (⌘⇧E)')
  await wait(3500)
  out.probes.readmeOpen = await page.evaluate(() => {
    const shell = document.querySelector('[data-orca-explorer-shell]')
    const row = shell ? [...shell.querySelectorAll('button[data-file-explorer-row]')].find((el) => /README\.md/i.test(el.innerText ?? '')) : null
    if (!row) return null
    row.click()
    return (row.innerText ?? '').trim()
  })
  // Wait for either the rich editor or Monaco.
  for (let i = 0; i < 20; i += 1) {
    const ready = await page.evaluate(() => Boolean(document.querySelector('.ProseMirror, .monaco-editor')))
    if (ready) break
    await wait(1000)
  }
  out.probes.editorDom = await page.evaluate(() => ({
    proseMirror: Boolean(document.querySelector('.ProseMirror')),
    proseEditable: document.querySelector('.ProseMirror')?.getAttribute('contenteditable') ?? null,
    monaco: Boolean(document.querySelector('.monaco-editor')),
    headers: [...document.querySelectorAll('.editor-header-path')].map((el) => el.textContent?.trim()),
    toolbarButtons: [...document.querySelectorAll('button')]
      .filter((b) => b.getClientRects().length)
      .map((b) => ({ aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), text: (b.innerText ?? '').trim().slice(0, 30) }))
      .filter((b) => b.aria || b.title || b.text)
      .slice(0, 80)
  }))
  await shoot(page, '91-editor-ready.png')

  const marker = `EXPLORE_FINAL_EDIT_${Date.now()}`
  out.probes.edit = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror')
    if (pm) {
      pm.focus()
      return { kind: 'prosemirror' }
    }
    const ta = document.querySelector('.monaco-editor textarea')
    if (ta) {
      ta.focus()
      return { kind: 'monaco' }
    }
    return { kind: 'none' }
  })
  if (out.probes.edit.kind !== 'none') {
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.press('Meta+ArrowRight')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText(marker)
    await wait(1500)
    await page.keyboard.press('Meta+s')
    await wait(5000)
  }
  out.probes.fileAfterSave = existsSync(README) ? readFileSync(README, 'utf8') : null
  out.probes.saveRoundTrip = (out.probes.fileAfterSave ?? '').includes(marker)
  out.probes.saveUi = await page.evaluate(() => (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1000))
  await shoot(page, '92-editor-saved.png')
  if (out.probes.edit.kind === 'none') {
    finding('P1', 'D-EDITOR-UNAVAILABLE', '文件以预览打开，无可编辑表面', '主工作区（main-2）打开 README.md 后只有预览，无 .ProseMirror/.monaco-editor，无法编辑保存', '91-editor-ready.png')
  } else if (!out.probes.saveRoundTrip) {
    finding('P2', 'D-FILE-SAVE-FAIL', '编辑保存未落盘', `在 main-2 的 README.md 追加标记后 Cmd+S，磁盘内容未包含标记：${marker}`, '92-editor-saved.png')
  }

  // Agents panel.
  out.probes.agentsClicked = await clickAria('Agents')
  await wait(5000)
  out.probes.agents = await page.evaluate(() => ({
    body: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1600),
    methodDenials: [...(document.body.innerText ?? '').matchAll(/Method '([^']+)' is not available to cloud sessions/g)].map((m) => m[1]),
    empty: /未找到智能体会话/.test(document.body.innerText ?? '')
  }))
  await shoot(page, '93-agents.png')

  // Skills: open settings and then the "开放技能" entry if present.
  out.probes.settingsClicked = await clickAria('设置')
  await wait(3000)
  out.probes.skillsOpenClick = await page.evaluate(() => {
    const target = [...document.querySelectorAll('button, a, [role="button"]')].find((el) => /开放技能|Open skills/i.test(el.innerText ?? ''))
    if (!target) return null
    target.click()
    return (target.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  })
  await wait(4000)
  out.probes.skills = await page.evaluate(() => ({
    body: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1600),
    methodDenials: [...(document.body.innerText ?? '').matchAll(/Method '([^']+)' is not available to cloud sessions/g)].map((m) => m[1]),
    testids: [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].slice(0, 120)
  }))
  await shoot(page, '94-skills.png')

  // Sign out while a file tab is open (session-end boundary).
  out.probes.logout = await page.evaluate(async () => {
    try {
      return await window.api.cloud.logout()
    } catch (e) {
      return { error: String(e?.message ?? e) }
    }
  })
  await wait(5000)
  out.probes.afterLogout = await readShell(page)
  await shoot(page, '95-after-logout.png')
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  try {
    if (existsSync(BACKUP)) copyFileSync(BACKUP, README)
  } catch {}
  out.logs = logs?.filter((l) => !l.includes('Electron Security Warning')).slice(0, 300)
  out.finishedAt = new Date().toISOString()
  writeFileSync(path.join(EVIDENCE, 'final-stage.json'), JSON.stringify(out, null, 2))
  try { await page?.screenshot({ path: path.join(EVIDENCE, 'screenshots', '99-final.png') }) } catch {}
  try { await app?.close() } catch {}
  console.log(JSON.stringify({
    error: out.error,
    findings: out.findings,
    signedIn: out.probes.signedIn,
    clickedMain2: out.probes.clickedMain2,
    rapid: { clicks: out.probes.rapidSwitchClicks, alerts: out.probes.afterRapid?.alerts, body: (out.probes.afterRapid?.bodyText ?? '').slice(0, 400) },
    editor: { prose: out.probes.editorDom?.proseMirror, editable: out.probes.editorDom?.proseEditable, monaco: out.probes.editorDom?.monaco, headers: out.probes.editorDom?.headers },
    editKind: out.probes.edit?.kind,
    saveRoundTrip: out.probes.saveRoundTrip,
    agents: out.probes.agents,
    skillsOpenClick: out.probes.skillsOpenClick,
    skills: { body: out.probes.skills?.body?.slice(0, 800), denials: out.probes.skills?.methodDenials },
    logout: out.probes.logout,
    afterLogout: { signedIn: out.probes.afterLogout?.signedInSegment, cloudSegment: out.probes.afterLogout?.statusBar, body: (out.probes.afterLogout?.bodyText ?? '').slice(0, 700) },
    logs: out.logs
  }, null, 2))
}
