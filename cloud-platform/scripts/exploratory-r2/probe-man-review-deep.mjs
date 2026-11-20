/** Targeted disambiguation probe for man-review desktop findings (no product changes). */
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  dismissOnboarding,
  fillLogin,
  focusTerminal,
  launchDesktop,
  openLoginDialog,
  PLATFORM_URL,
  submitLogin,
  terminalText,
  typeInTerminal,
  waitSignedIn
} from './desktop-harness.mjs'

const OUT = '/Users/gongdewei/work/projects/orca/cloud-platform/evidence/man-review/desktop'
const USER_DATA = '/tmp/orca-man-review/ud-probe'
const result = { startedAt: new Date().toISOString() }
let app
let page
let logs = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const wait = (ms) => page.waitForTimeout(ms)

async function rowsDetailed() {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-worktree-id]')].map((el) => ({
      id: el.getAttribute('data-worktree-id'),
      rowKey: el.getAttribute('data-worktree-row-key'),
      hostIdentity: el.getAttribute('data-worktree-host-identity'),
      text: (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
    }))
  )
}

try {
  ;({ app, page, logs } = await launchDesktop({ userDataDir: USER_DATA, extraEnv: cloudTestEnv() }))
  await dismissOnboarding(page)
  await openLoginDialog(page)
  await fillLogin(page, { address: PLATFORM_URL, username: 'zhangsan', password: 'Passw0rd!' })
  await submitLogin(page)
  result.signedIn = await waitSignedIn(page, 90_000)
  for (let i = 0; i < 60; i += 1) {
    if ((await rowsDetailed()).length > 0) break
    await wait(1000)
  }
  await wait(4000)
  result.rowsBefore = await rowsDetailed()

  result.opens = await page.evaluate(async () => {
    const bridge = window.api.cloud
    const state = await bridge.getState()
    const online = (state.projects ?? []).filter((p) => p.hostStatus === 'online')
    const target = online.find((p) => p.key === 'infra-tools') ?? online[0]
    const other = online.find((p) => p.id !== target.id) ?? target
    return {
      target: target.key,
      other: other.key,
      concurrent: await Promise.all([
        bridge.openWorkspace(target.id),
        bridge.openWorkspace(target.id)
      ]),
      different: await bridge.openWorkspace(other.id),
      again: await bridge.openWorkspace(target.id)
    }
  })
  await wait(5000)
  result.rowsAfter = await rowsDetailed()

  // Activate main-2 and open the UI terminal.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-worktree-id]')].find(
      (el) => /infra-tools/.test(el.innerText ?? '') && /main-2/.test(el.innerText ?? '')
    )
    ;(row?.querySelector('[data-worktree-card-surface]') ?? row)?.click()
  })
  await wait(8000)
  const plus = page.locator('button[aria-label="新标签页"], button[aria-label="New tab"]').first()
  if (await plus.isVisible().catch(() => false)) {
    await plus.click({ timeout: 5000 }).catch(() => {})
    await wait(1200)
  }
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
      /新终端|New Terminal/i.test(el.innerText ?? '')
    )
    if (!item) return
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    item.click()
  })
  await wait(7000)

  result.termDomBefore = await page.evaluate(() => {
    const wrapper = document.querySelector('.xterm')
    return {
      xtermCount: document.querySelectorAll('.xterm').length,
      rowsDivs: wrapper ? wrapper.querySelectorAll('.xterm-rows > div').length : 0,
      accessibilityRows: wrapper
        ? wrapper.querySelectorAll('.xterm-accessibility-tree > div').length
        : 0,
      helperTextarea: wrapper ? wrapper.querySelectorAll('.xterm-helper-textarea').length : 0,
      xtermInnerText: wrapper ? (wrapper.innerText ?? '').slice(-500) : '',
      screenTextContent: wrapper
        ? (wrapper.querySelector('.xterm-screen')?.textContent ?? '').slice(-500)
        : ''
    }
  })
  result.focused = await focusTerminal(page)
  if (result.focused) {
    await typeInTerminal(page, 'pwd && echo MAN_PROBE_UI && echo 中文探针回声')
    await wait(6000)
  }
  result.harnessTerminalText = await terminalText(page)
  result.termDomAfter = await page.evaluate(() => {
    const wrappers = [...document.querySelectorAll('.xterm')]
    const wrapper = wrappers[wrappers.length - 1]
    const rowTexts = wrapper
      ? [...wrapper.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent ?? '')
      : []
    const a11y = wrapper
      ? [...wrapper.querySelectorAll('.xterm-accessibility-tree > div')].map(
          (r) => r.textContent ?? ''
        )
      : []
    return {
      xtermCount: wrappers.length,
      rowTexts: rowTexts.slice(-20),
      rowTextJoinedTail: rowTexts.join('\n').slice(-800),
      a11yTextJoinedTail: a11y.join('\n').slice(-800),
      xtermInnerTextTail: wrapper ? (wrapper.innerText ?? '').slice(-800) : ''
    }
  })
  await page.screenshot({ path: path.join(OUT, 'probe-terminal-dom.png') })
} catch (error) {
  result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  mkdirSync(OUT, { recursive: true })
  result.logs = logs.filter((l) => !l.includes('Electron Security Warning')).slice(-80)
  result.finishedAt = new Date().toISOString()
  writeFileSync(path.join(OUT, 'probe-disambiguation.json'), JSON.stringify(result, null, 2))
  try {
    await app?.close()
  } catch {}
  console.log(
    JSON.stringify(
      {
        error: result.error,
        signedIn: result.signedIn,
        rowsBefore: result.rowsBefore?.length,
        rowsAfter: result.rowsAfter?.length,
        dupIdsAfter: result.rowsAfter
          ? result.rowsAfter.length - new Set(result.rowsAfter.map((r) => r.id)).size
          : null,
        duplicateDetails: result.rowsAfter
          ? Object.entries(
              result.rowsAfter.reduce((acc, r) => {
                acc[r.id] = acc[r.id] ?? []
                acc[r.id].push({ rowKey: r.rowKey, hostIdentity: r.hostIdentity })
                return acc
              }, {})
            )
              .filter(([, v]) => v.length > 1)
              .map(([id, v]) => ({ id, occurrences: v }))
          : null,
        focused: result.focused,
        harnessTerminalTextTail: (result.harnessTerminalText ?? '').slice(-300),
        termDomBefore: result.termDomBefore,
        termDomAfter: result.termDomAfter
      },
      null,
      2
    )
  )
}
