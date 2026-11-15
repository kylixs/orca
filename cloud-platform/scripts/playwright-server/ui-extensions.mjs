/**
 * Extended semantic helpers on top of the layer-1 `ui` wrapper: identity,
 * navigation, direct project/workspace operations, workspace tabs and form
 * filling. Extraction/assert/discovery live in ui-extract.mjs; both attach here
 * so server injection and standalone journeys share one namespace.
 */
import { attachExtraction, collectKv, fragment } from './ui-extract.mjs'

const WORKSPACE_FRAME_MARK = 'cloud-admin.html'

export function attachUiExtensions(ui, ctx) {
  const { page, baseUrl, targetLocator, step, log } = ctx
  attachExtraction(ui, ctx)

  const workspaceFrame = () => {
    const frame = page.frames().find((candidate) => candidate.url().includes(WORKSPACE_FRAME_MARK))
    if (!frame) {
      throw new Error(
        'workspace frame not found; call ui.openWorkspace(projectId) and wait for the overlay first'
      )
    }
    return frame
  }

  const wsVisible = (frame, testid) => frame.locator(`[data-testid="${testid}"]:visible`).first()

  /**
   * Log in as a role key or account username. Reuses the resident context and
   * returns early when the app is already open unless `opts.relogin` is set.
   * @example
   * await ui.login('admin')
   * await ui.login('lisi', { relogin: true })
   */
  async function login(username = ui.profile(), opts = {}) {
    return step(`login:${username}`, async () => {
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
      if (
        opts.relogin &&
        (await page
          .locator('#view-app')
          .isVisible()
          .catch(() => false))
      ) {
        await ui.logout()
      }
      if (
        await page
          .locator('#view-app')
          .isVisible()
          .catch(() => false)
      ) {
        log(`already logged in as ${username}`)
        return { username, reused: true }
      }
      const roleMap = ui.roles()
      const byUsername = Object.entries(roleMap).find(([, entry]) => entry.username === username)
      const entry = roleMap[username] ?? byUsername?.[1]
      const credentials = entry ?? (opts.password ? { username, password: opts.password } : null)
      if (!credentials) {
        throw new Error(`unknown account "${username}"; pass {password} or add ORCA_PW_ROLE_MAP`)
      }
      await page.fill('#username', credentials.username)
      await page.fill('#password', credentials.password)
      await page.click('#loginBtn')
      await page.waitForSelector('#view-app:not([hidden])', { timeout: 20000 })
      if (opts.onLogin) {
        await opts.onLogin()
      }
      log(`logged in as ${credentials.username}`)
      return { username: credentials.username, reused: false }
    })
  }

  /** Log out when logged in; a no-op on the login screen.
   * @example await ui.logout()
   */
  async function logout() {
    return step('logout', async () => {
      if (
        !(await page
          .locator('#logoutBtn')
          .isVisible()
          .catch(() => false))
      ) {
        return { reused: true }
      }
      await page.click('#logoutBtn')
      await page.waitForSelector('#view-login:not([hidden])', { timeout: 10000 })
      return { reused: false }
    })
  }

  /** Navigate by route id (`workbench`, `audit`, …) or nav label.
   * @example await ui.navigateMenu('members')
   */
  async function navigateMenu(pageIdOrLabel) {
    return step(`navigateMenu:${pageIdOrLabel}`, async () => {
      const byRoute = page.locator(`.nav-item[data-route="${pageIdOrLabel}"]`)
      const target =
        (await byRoute.count()) > 0
          ? byRoute.first()
          : page.getByRole('button', { name: pageIdOrLabel }).first()
      await target.click()
      await page.waitForFunction(() => {
        const content = document.querySelector('#content')
        return content && !content.innerText.includes('加载中')
      })
      return (
        await page
          .locator('#crumbs')
          .innerText()
          .catch(() => '')
      ).trim()
    })
  }

  /**
   * Jump to the project list and resolve one project row/card by id.
   * @example const project = await ui.openProject('proj_4fb40a8b')
   */
  async function openProject(id) {
    return step(`openProject:${id}`, async () => {
      if (!(await page.locator('[data-open]').count())) {
        await ui.navigateMenu('workbench')
      }
      const button = page.locator(`[data-open="${id}"]`).first()
      if (await button.count()) {
        const row = button.locator('xpath=ancestor::tr[1]')
        const card = button.locator('xpath=ancestor::div[contains(@class,"project-card")][1]')
        const container = (await row.count()) ? row : card
        const text = await container
          .first()
          .innerText()
          .catch(() => '')
        return { id, found: true, text: fragment(text, 1200) }
      }
      const row = page.locator('tbody tr, .project-card', { hasText: id }).first()
      if (await row.count()) {
        return { id, found: true, text: fragment(await row.innerText(), 1200) }
      }
      throw new Error(`project not found: ${id}`)
    })
  }

  /**
   * Open a project's read-only detail dialog (admin) and return its text + kv.
   * The dialog is left open so the caller can extract; press Escape to close.
   * @example
   * const detail = await ui.openDetail('proj_4fb40a8b')
   * detail.kv.find((row) => row.label === '项目状态')?.value
   */
  async function openDetail(id) {
    return step(`openDetail:${id ?? 'first'}`, async () => {
      let button =
        id === undefined
          ? page.locator('[data-detail]:visible').first()
          : page.locator(`[data-detail="${id}"]`).first()
      if (!(await button.count())) {
        if (id !== undefined) {
          await ui.openProject(id)
          button = page.locator(`[data-detail="${id}"]`).first()
        }
      }
      await button.waitFor({ state: 'visible', timeout: 10000 })
      await button.click()
      const dialog = page.locator('.dialog[role="dialog"]:visible').first()
      await dialog.waitFor({ timeout: 10000 })
      const title = await dialog
        .locator('h2')
        .first()
        .innerText()
        .catch(() => '')
      const text = fragment(await dialog.innerText(), 100000)
      return { id: id ?? null, title: title.trim(), text, kv: await collectKv(dialog) }
    })
  }

  /**
   * Open the embedded workspace overlay for a project. Reports ready/failure
   * instead of throwing, because an old host bundle may never signal ready.
   * @example
   * const workspace = await ui.openWorkspace('proj_4fb40a8b')
   * workspace.status // 'ready' | 'failed' | 'pending' | 'blocked'
   */
  async function openWorkspace(id, opts = {}) {
    return step(`openWorkspace:${id}`, async () => {
      await ui.openProject(id)
      const trigger = page.locator(`[data-open="${id}"]`).first()
      if (await trigger.isDisabled().catch(() => false)) {
        return { id, status: 'blocked', reason: await trigger.getAttribute('title') }
      }
      await trigger.click()
      const overlay = page.locator('#workspaceOverlay')
      await overlay.waitFor({ timeout: 15000 })
      const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 25000
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (await overlay.locator('[data-workspace-ready-failure]').count()) {
          return { id, status: 'failed', text: fragment(await overlay.innerText(), 2000) }
        }
        const status = overlay.locator('[data-workspace-status]')
        const iframe = overlay.locator('iframe.workspace-frame')
        if ((await iframe.count()) && !(await status.isVisible().catch(() => false))) {
          return {
            id,
            status: 'ready',
            frameUrl: await iframe.first().getAttribute('src'),
            route: fragment(
              await overlay
                .locator('[data-workspace-route]')
                .innerText()
                .catch(() => ''),
              200
            )
          }
        }
        await page.waitForTimeout(250)
      }
      return { id, status: 'pending', text: fragment(await overlay.innerText(), 2000) }
    })
  }

  async function expandTreeParents(frame, relPath) {
    const parts = relPath.split('/')
    let current = ''
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = current ? `${current}/${parts[index]}` : parts[index]
      await frame.evaluate((nodePath) => {
        const button = document.querySelector(
          `[data-testid="cloud-workspace-file-tree-node-${CSS.escape(nodePath)}"]`
        )
        const item = button?.closest('[role="treeitem"]')
        if (button && item?.getAttribute('aria-expanded') !== 'true') {
          button.click()
        }
      }, current)
      await page.waitForTimeout(300)
    }
  }

  /**
   * Switch a workspace surface or activate/open a tab inside the iframe.
   * types: `files`/`git` (right rail), `file` (tree path), `diff` (git change path),
   * `terminal` (new when `arg` omitted, else tab id), `activate` (raw tab id).
   * @example
   * await ui.openTab('files')
   * await ui.openTab('file', 'README.md')
   * await ui.openTab('diff', 'README.md')
   * await ui.openTab('terminal')
   */
  async function openTab(type, arg) {
    return step(`openTab:${type}${arg === undefined ? '' : `:${arg}`}`, async () => {
      const frame = workspaceFrame()
      const clickId = async (testid) => {
        const locator = wsVisible(frame, testid)
        await locator.waitFor({ timeout: 20000 })
        await locator.click()
      }
      if (type === 'files' || type === 'git') {
        await clickId(`cloud-simple-workspace-right-tab-${type}`)
      } else if (type === 'file') {
        if (!arg) {
          throw new Error('openTab("file", relPath) needs a path')
        }
        await clickId('cloud-simple-workspace-right-tab-files').catch(() => {})
        await expandTreeParents(frame, arg)
        await clickId(`cloud-workspace-file-tree-node-${arg}`)
      } else if (type === 'diff') {
        if (!arg) {
          throw new Error('openTab("diff", relPath) needs a path')
        }
        await clickId('cloud-simple-workspace-right-tab-git').catch(() => {})
        await clickId(`cloud-workspace-git-change-${arg}`)
      } else if (type === 'terminal') {
        await clickId(
          arg === undefined
            ? 'cloud-simple-workspace-new-terminal'
            : `cloud-simple-workspace-tab-${arg}`
        )
      } else if (type === 'activate') {
        if (!arg) {
          throw new Error('openTab("activate", tabId) needs a tab id')
        }
        await clickId(`cloud-simple-workspace-tab-${arg}`)
      } else {
        throw new Error(`unsupported openTab type: ${type}`)
      }
      const active = await frame.evaluate(() => {
        const tab = document.querySelector(
          '[role="tab"][aria-selected="true"][data-testid^="cloud-simple-workspace-tab-"]'
        )
        return tab?.getAttribute('data-testid')?.replace('cloud-simple-workspace-tab-', '') ?? null
      })
      return { type, arg: arg ?? null, activeTab: active }
    })
  }

  /**
   * Click the visible file tab's Save and wait for it to become clean.
   * @example await ui.saveFile()
   */
  async function saveFile() {
    return step('saveFile', async () => {
      const frame = workspaceFrame()
      const save = wsVisible(frame, 'cloud-workspace-file-tab-save')
      await save.waitFor({ timeout: 15000 })
      await save.click()
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const dirty = await frame
          .locator('[data-testid^="cloud-simple-workspace-tab-dirty-"]:visible')
          .count()
        if (!dirty) {
          break
        }
        await page.waitForTimeout(200)
      }
      return {
        saved: true,
        dirtyTabs: await frame
          .locator('[data-testid^="cloud-simple-workspace-tab-dirty-"]:visible')
          .count()
      }
    })
  }

  /**
   * Toggle an open diff tab between side-by-side and inline.
   * @example await ui.switchDiff('inline'); await ui.switchDiff('side-by-side')
   */
  async function switchDiff(mode) {
    return step(`switchDiff:${mode}`, async () => {
      const normalized = mode === 'inline' || mode === 'side-by-side' ? mode : null
      if (!normalized) {
        throw new Error('switchDiff(mode): use "inline" or "side-by-side"')
      }
      const frame = workspaceFrame()
      await wsVisible(frame, 'cloud-workspace-diff-tab').waitFor({ timeout: 20000 })
      await wsVisible(frame, `cloud-workspace-diff-mode-${normalized}`).click()
      await frame
        .locator(
          `[data-testid="cloud-workspace-diff-mode-${normalized}"]:visible[aria-pressed="true"]`
        )
        .waitFor({ timeout: 5000 })
      return { mode: normalized }
    })
  }

  /**
   * Fill several form controls and optionally submit. Keys resolve as label,
   * id/name, placeholder, or role name; `$submit` clicks that button.
   * @example
   * await ui.fillForm({ 项目名称: '支付服务', regKey: 'payment-service', $submit: '保存' })
   */
  async function fillForm(fieldMap, opts = {}) {
    return step('fillForm', async () => {
      const scope = opts.scope ? targetLocator(page, opts.scope).first() : page
      const filled = []
      for (const [key, value] of Object.entries(fieldMap ?? {})) {
        if (key.startsWith('$')) {
          continue
        }
        let control = scope.getByLabel(key, { exact: false })
        if (!(await control.count())) {
          control = scope.locator(`#${key}, [name="${key}"]`)
        }
        if (!(await control.count())) {
          control = scope.locator(`[placeholder*="${key}"]`)
        }
        if (!(await control.count())) {
          control = scope.getByRole('textbox', { name: key, exact: false })
        }
        const target = control.first()
        if (!(await target.count())) {
          throw new Error(`fillForm: no control matched "${key}"`)
        }
        const tag = await target.evaluate((el) => el.tagName.toLowerCase())
        const type = await target.getAttribute('type')
        if (tag === 'select') {
          await target.selectOption(String(value))
        } else if (type === 'checkbox' || type === 'radio') {
          await (value ? target.check() : target.uncheck())
        } else {
          await target.fill(String(value))
        }
        filled.push(key)
      }
      const submitName = opts.submit ?? fieldMap?.$submit
      if (submitName) {
        await scope.getByRole('button', { name: submitName }).first().click()
      }
      return { filled, submitted: submitName ?? null }
    })
  }

  Object.assign(ui, {
    login,
    logout,
    navigateMenu,
    openProject,
    openDetail,
    openWorkspace,
    openTab,
    saveFile,
    switchDiff,
    fillForm
  })
  return ui
}
