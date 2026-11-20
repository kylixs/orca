/**
 * Reusable desktop exploratory-test harness (R2, link A).
 *
 * Launch rules (AGENTS.md): ORCA_BACKGROUND_LAUNCH=1, ORCA_E2E_HEADLESS=1,
 * isolated HOME/userData, no show()/focus()/OS activation. Screenshots are
 * taken through the hidden renderer via Playwright/CDP.
 *
 * Environment notes for the local platform at https://127.0.0.1:18787:
 * - The platform's dev CA must be trusted by the Electron main process:
 *   NODE_EXTRA_CA_CERTS=/Users/gongdewei/orca-local-env/tls/ca.pem
 * - ORCA_CLOUD_TLS_INSECURE=1 only covers host WebSocket upgrades today; HTTP
 *   control-plane fetches still verify TLS (see findings D-TLS-HTTP).
 * - Omit ORCA_CLOUD_API_URL to model "bare launch, typed address".
 */
import { _electron as electron } from '@stablyai/playwright-test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createElectronHomeIsolation } from '../../../tests/e2e/helpers/electron-home-isolation.ts'
import { getOrcaElectronLaunchArgs } from '../../../tests/e2e/helpers/electron-launch-args.ts'

export const REPO = '/Users/gongdewei/work/projects/orca'
export const EVIDENCE = path.join(REPO, 'cloud-platform/evidence/exploratory-r2')
export const SHOTS = path.join(EVIDENCE, 'screenshots')
export const PLATFORM_URL = 'https://127.0.0.1:18787'
export const DEV_CA = '/Users/gongdewei/orca-local-env/tls/ca.pem'

export function cloudTestEnv(extra = {}) {
  return {
    ORCA_CLOUD_TLS_INSECURE: '1',
    NODE_EXTRA_CA_CERTS: DEV_CA,
    ...extra
  }
}

function cleanEnv(keys) {
  const { ELECTRON_RUN_AS_NODE: _unused, ...clean } = process.env
  void _unused
  for (const key of Object.keys(clean)) if (keys.includes(key)) delete clean[key]
  return clean
}

/** Launch the built app from out/main; returns { app, page, logs }. */
export async function launchDesktop({ userDataDir, extraEnv = {}, headless = true }) {
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  const cloudKeys = Object.keys(process.env).filter(
    (k) =>
      k.startsWith('ORCA_CLOUD_') ||
      k === 'ORCA_DEFAULT_PLATFORM_URL' ||
      k === 'REMOTE_DEBUGGING_PORT'
  )
  const isolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv(cloudKeys),
    launchEnv: { NODE_ENV: 'development' },
    extraEnv,
    userDataDir
  })
  const app = await electron.launch({
    args: getOrcaElectronLaunchArgs(path.join(REPO, 'out', 'main', 'index.js'), false),
    env: {
      ...isolation.env,
      ORCA_E2E_HEADLESS: headless ? '1' : '0',
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1'
    },
    timeout: 120_000
  })
  const page = await app.firstWindow({ timeout: 120_000 })
  const logs = []
  page.on('console', (m) => {
    if (logs.length < 600) logs.push(`${m.type()}: ${m.text()}`)
  })
  page.on('pageerror', (e) => {
    if (logs.length < 600) logs.push(`pageerror: ${e.message}`)
  })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
  return { app, page, logs }
}

export async function dismissOnboarding(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const present = await page.evaluate(() =>
      Boolean(document.querySelector('[data-onboarding-overlay]'))
    )
    if (!present) return true
    await page.keyboard.press('Escape')
    await page.waitForTimeout(900)
    const clicked = await page.evaluate(() => {
      const dialog = [...document.querySelectorAll('[data-slot="dialog-content"]')].find((el) =>
        el.querySelector('button[data-variant="outline"]')
      )
      const button = dialog?.querySelector('button[data-variant="outline"]')
      if (!button) return null
      button.click()
      return button.textContent?.trim() ?? 'clicked'
    })
    if (!clicked) {
      await page.waitForTimeout(500)
      continue
    }
    await page.waitForTimeout(1800)
  }
  return !(await page.evaluate(() => Boolean(document.querySelector('[data-onboarding-overlay]'))))
}

export async function openLoginDialog(page, timeoutMs = 20_000) {
  await page.evaluate(() =>
    document.querySelector('[data-status-bar] [data-cloud-login-entry]')?.click()
  )
  await page.waitForSelector('[data-slot="dialog-content"] #cloud-username', { timeout: timeoutMs })
  await page.waitForTimeout(400)
}

export async function readLoginDialog(page) {
  return page.evaluate(() => {
    const d = [...document.querySelectorAll('[data-slot="dialog-content"]')].find((el) =>
      el.querySelector('#cloud-platform-address')
    )
    if (!d) return null
    const submit = d.querySelector('button[type="submit"]')
    return {
      address: d.querySelector('#cloud-platform-address')?.value ?? null,
      addressDisabled: d.querySelector('#cloud-platform-address')?.disabled ?? null,
      username: d.querySelector('#cloud-username')?.value ?? null,
      passwordFilled: Boolean(d.querySelector('#cloud-password')?.value),
      submitDisabled: submit?.disabled ?? null,
      submitText: submit?.textContent?.trim() ?? null,
      alerts: [...d.querySelectorAll('[role="alert"]')].map((a) => a.textContent.trim()),
      notices: [...d.querySelectorAll('[role="status"]')].map((a) => a.textContent.trim()),
      text: (d.innerText ?? '').replace(/\s+/g, ' ').slice(0, 600)
    }
  })
}

export async function fillLogin(page, { address, username, password }) {
  if (address !== undefined) {
    await page.locator('[data-slot="dialog-content"] #cloud-platform-address').fill(address)
  }
  if (username !== undefined) {
    await page.locator('[data-slot="dialog-content"] #cloud-username').fill(username)
  }
  if (password !== undefined) {
    await page.locator('[data-slot="dialog-content"] #cloud-password').fill(password)
  }
}

export async function submitLogin(page) {
  await page.locator('[data-slot="dialog-content"] button[type="submit"]').click()
}

export async function waitSignedIn(page, timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const signed = await page.evaluate(
      () => !document.querySelector('[data-status-bar] [data-cloud-login-entry]')
    )
    if (signed) return true
    const alert = await page.evaluate(() => {
      const d = [...document.querySelectorAll('[data-slot="dialog-content"]')].find((el) =>
        el.querySelector('#cloud-platform-address')
      )
      return d ? (d.querySelector('[role="alert"]')?.textContent?.trim() ?? null) : null
    })
    if (alert) throw new Error(`sign-in rejected: ${alert}`)
    await page.waitForTimeout(300)
  }
  return false
}

export async function readShell(page) {
  return page.evaluate(() => {
    const text = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim()
    const pick = (selector) => [...document.querySelectorAll(selector)]
    return {
      bodyText: text(document.body).slice(0, 3000),
      statusBar: text(document.querySelector('[data-status-bar]')),
      signedInSegment: !document.querySelector('[data-status-bar] [data-cloud-login-entry]'),
      alerts: pick('[role="alert"]').map(text).filter(Boolean),
      statuses: pick('[role="status"]').map(text).filter(Boolean),
      toasts: pick('[data-sonner-toast], li[data-sonner-toast]').map(text).filter(Boolean),
      dialogs: pick('[data-slot="dialog-content"]').map((d) => text(d).slice(0, 300)),
      worktrees: pick('[data-worktree-id]').map((el) => ({
        id: el.getAttribute('data-worktree-id'),
        text: text(el).slice(0, 160),
        active: /Active/.test(el.className) || el.getAttribute('data-active') === 'true'
      })),
      tabs: pick('[role="tab"]').map((t) => text(t).slice(0, 100)),
      terminals: pick('.xterm').length,
      editors: pick('.editor-header-path').map(text),
      explorer: Boolean(document.querySelector('[data-orca-explorer-shell]'))
    }
  })
}

/** Click the sidebar worktree row whose text contains all fragments. */
export async function clickWorktree(page, fragments) {
  return page.evaluate((frags) => {
    const rows = [...document.querySelectorAll('[data-worktree-id]')]
    const row = rows.find((el) => {
      const text = (el.innerText ?? '').replace(/\s+/g, ' ')
      return frags.every((f) => text.includes(f))
    })
    if (!row) return null
    const surface = row.querySelector('[data-worktree-card-surface]') ?? row
    surface.click()
    return row.getAttribute('data-worktree-id')
  }, fragments)
}

/** Terminal helpers: active xterm helper textarea + rendered rows text. */
export async function focusTerminal(page) {
  return page.evaluate(() => {
    const textareas = [...document.querySelectorAll('.xterm-helper-textarea')]
    const textarea =
      textareas.find((el) => el.offsetParent !== null) ?? textareas[textareas.length - 1]
    if (!textarea) return false
    textarea.focus()
    return true
  })
}

export async function terminalText(page) {
  return page.evaluate(() => {
    const wrappers = [...document.querySelectorAll('.xterm')].filter(
      (el) => el.offsetParent !== null
    )
    const wrapper = wrappers[wrappers.length - 1] ?? null
    if (!wrapper) return ''
    const rows = [...wrapper.querySelectorAll('.xterm-rows > div')]
    return rows.map((r) => r.textContent ?? '').join('\n')
  })
}

export async function typeInTerminal(page, text, { pressEnter = true } = {}) {
  await focusTerminal(page)
  await page.keyboard.insertText(text)
  if (pressEnter) await page.keyboard.press('Enter')
}

/** Dump a compact UI inventory for selector discovery. */
export async function dumpUi(page) {
  return page.evaluate(() => {
    const text = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim()
    const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0
    return {
      buttons: [...document.querySelectorAll('button')]
        .filter(visible)
        .map((b) => ({
          text: text(b).slice(0, 50),
          aria: b.getAttribute('aria-label'),
          title: b.getAttribute('title'),
          testid: b.getAttribute('data-testid')
        }))
        .filter((b) => b.text || b.aria || b.title || b.testid)
        .slice(0, 120),
      testids: [
        ...new Set(
          [...document.querySelectorAll('[data-testid]')].map((el) =>
            el.getAttribute('data-testid')
          )
        )
      ].slice(0, 150),
      ariaLabels: [
        ...new Set(
          [...document.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'))
        )
      ].slice(0, 100),
      roles: [...document.querySelectorAll('[role]')]
        .map((el) => `${el.getAttribute('role')}:${text(el).slice(0, 40)}`)
        .slice(0, 80)
    }
  })
}

export async function shoot(page, name) {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, name) })
}
