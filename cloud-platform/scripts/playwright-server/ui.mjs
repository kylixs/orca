/**
 * First-layer semantic wrapper over Playwright. Thin by design: every helper
 * resolves a target, waits, calls the real Playwright API and records a step.
 * Second layer (`page`, locators, frames) is exposed as-is for escape hatches.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { attachUiExtensions } from './ui-extensions.mjs'

export const DEFAULT_ROLES = {
  admin: { username: 'admin', password: 'Adm1n!' },
  zhangsan: { username: 'zhangsan', password: 'Passw0rd!' },
  lisi: { username: 'lisi', password: 'Passw0rd!' }
}

export function roleMap() {
  const map = { ...DEFAULT_ROLES }
  if (process.env.ORCA_PW_ROLE_MAP) {
    const override = JSON.parse(process.env.ORCA_PW_ROLE_MAP)
    for (const [name, value] of Object.entries(override)) {
      map[name] = typeof value === 'string' ? { password: value, username: name } : value
    }
  }
  return map
}

export function resolveRole(name, opts = {}) {
  if (opts.username) {
    return { username: opts.username, password: opts.password }
  }
  const entry = roleMap()[name]
  if (!entry) {
    throw new Error(`unknown role "${name}"; add ORCA_PW_ROLE_MAP or pass credentials`)
  }
  return entry
}

function targetLocator(root, target) {
  if (typeof target === 'string') {
    return root.locator(target)
  }
  if (!target || typeof target !== 'object') {
    throw new Error(`unsupported target: ${String(target)}`)
  }
  if (target.testid) {
    return root.locator(`[data-testid="${target.testid}"]`)
  }
  if (target.css) {
    return root.locator(target.css)
  }
  if (target.role) {
    return root.getByRole(
      target.role,
      target.name === undefined ? {} : { name: target.name, exact: target.exact }
    )
  }
  if (target.label) {
    return root.getByLabel(target.label)
  }
  if (target.text) {
    return root.getByText(target.text, target.exact === undefined ? {} : { exact: target.exact })
  }
  throw new Error(`unsupported target: ${JSON.stringify(target)}`)
}

function describeTarget(target) {
  return typeof target === 'string' ? target : JSON.stringify(target)
}

export function createUi({
  page,
  baseUrl,
  profile = 'zhangsan',
  evidenceDir,
  mode = 'server',
  onLogin
}) {
  const steps = []
  const logs = []
  const shotsDir = path.join(evidenceDir, 'shots')

  const log = (...parts) => {
    const line = parts
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join(' ')
    logs.push(line)
    // stderr keeps standalone stdout a single JSON payload.
    console.error(`[journey] ${line}`)
  }

  const step = async (name, fn) => {
    const startedAt = Date.now()
    log(`step: ${name}`)
    try {
      const value = await fn()
      steps.push({ name, ok: true, durationMs: Date.now() - startedAt })
      return value
    } catch (error) {
      steps.push({
        name,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error.message
      })
      throw error
    }
  }

  const ui = {
    page,
    baseUrl,
    profile: () => profile,
    roles: roleMap,
    mode,
    steps,
    logs,
    step,
    log,
    locator: (target) => targetLocator(page, target),
    frame: (nameOrSubstring) => {
      const frames = page.frames().filter((frame) => frame !== page.mainFrame())
      const frame =
        frames.find((candidate) => candidate.name() === nameOrSubstring) ??
        frames.find((candidate) => candidate.url().includes(nameOrSubstring))
      if (!frame) {
        throw new Error(`frame not found: ${nameOrSubstring}`)
      }
      return frame
    },
    failedStep: () => steps.toReversed().find((entry) => !entry.ok) ?? null,

    async login(role = profile, opts = {}) {
      return step(`login:${role}`, async () => {
        const credentials = resolveRole(role, opts)
        await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
        // Both views start hidden; bootstrap reveals exactly one after /v1/me.
        await page.waitForFunction(
          () =>
            !document.querySelector('#view-login')?.hidden ||
            !document.querySelector('#view-app')?.hidden,
          null,
          { timeout: 20000 }
        )
        if (!(await page.locator('#view-login').isVisible())) {
          log(`already logged in as ${role}`)
          return { role, reused: true }
        }
        await page.locator('#username').waitFor({ state: 'visible', timeout: 10000 })
        await page.fill('#username', credentials.username)
        await page.fill('#password', credentials.password)
        await page.click('#loginBtn')
        await page.waitForSelector('#view-app:not([hidden])', {
          timeout: 20000
        })
        if (onLogin) {
          await onLogin()
        }
        log(`logged in as ${role}`)
        return { role, reused: false }
      })
    },

    async logout() {
      return step('logout', async () => {
        await page.click('#logoutBtn')
        await page.waitForSelector('#view-login:not([hidden])', {
          timeout: 10000
        })
      })
    },

    async navigateMenu(routeOrLabel) {
      return step(`navigateMenu:${routeOrLabel}`, async () => {
        const byRoute = page.locator(`.nav-item[data-route="${routeOrLabel}"]`)
        const hasRoute = (await byRoute.count()) > 0
        await (
          hasRoute ? byRoute.first() : page.getByRole('button', { name: routeOrLabel }).first()
        ).click()
        await page.waitForFunction(() => {
          const content = document.querySelector('#content')
          return content && !content.innerText.includes('加载中')
        })
      })
    },

    async goto(url) {
      return step(`goto:${url}`, async () => {
        const absolute = /^https?:\/\//.test(url)
          ? url
          : `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`
        await page.goto(absolute, { waitUntil: 'domcontentloaded' })
        return absolute
      })
    },

    async openProject(keyOrName) {
      return step(`openProject:${keyOrName}`, async () => {
        await ui.navigateMenu('workbench')
        const row = page.locator('tbody tr', { hasText: keyOrName }).first()
        await row.waitFor({ timeout: 10000 })
        await row.getByRole('button', { name: '打开' }).first().click()
        return true
      })
    },

    async click(target) {
      return step(`click:${describeTarget(target)}`, async () => {
        await targetLocator(page, target).first().click()
      })
    },

    async fill(target, value) {
      return step(`fill:${describeTarget(target)}`, async () => {
        await targetLocator(page, target).first().fill(String(value))
      })
    },

    async assertText(expected, scope) {
      return step(`assertText:${expected}`, async () => {
        const root = scope === undefined ? page.locator('body') : targetLocator(page, scope)
        const actual = await root.first().innerText()
        if (!actual.includes(expected)) {
          throw new Error(`expected text "${expected}" but saw "${actual.slice(0, 300)}"`)
        }
        return true
      })
    },

    async text(target) {
      return step(`text:${describeTarget(target)}`, async () => {
        return (await targetLocator(page, target).first().innerText()).trim()
      })
    },

    async screenshot(name = 'screenshot', opts = {}) {
      return step(`screenshot:${name}`, async () => {
        mkdirSync(shotsDir, { recursive: true })
        const file = path.join(shotsDir, `${name.replace(/[^\w.-]+/g, '-')}.png`)
        await page.screenshot({ path: file, fullPage: Boolean(opts.fullPage) })
        return file
      })
    }
  }

  return attachUiExtensions(ui, { page, baseUrl, evidenceDir, targetLocator, step, log })
}
