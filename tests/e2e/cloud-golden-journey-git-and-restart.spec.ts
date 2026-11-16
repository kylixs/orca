import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type ElectronApplication,
  type Frame,
  type Page
} from '@stablyai/playwright-test'
import { chromium } from 'playwright'
import { closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { getTerminalContent } from './helpers/terminal'
import { webBundleExposesStore } from './helpers/web-bundle-store-oracle'
import {
  adminTokenOf,
  cloudHostEnv,
  hostTokenOf,
  makeHostTls,
  readArray,
  readString,
  readStringArray,
  startCloudPlatform,
  waitForHostOnline,
  type CloudPlatform
} from './helpers/cloud-platform-stack'

/**
 * U91 closes the two coverage gaps journey-round5 kept on the books
 * (test-reports/journey-round5.md §P3-2): the cloud git panel and a client
 * restart had golden specs on neither line.
 *
 *   A-GIT      a real repository project → 简易工作区 (the console's embedded
 *              cloud-admin client) → Git 变更 tab lists one real modified and
 *              one real untracked file → opening the modified file renders the
 *              working-tree diff in Monaco → 左右/合并 switches the render and
 *              each side's text is asserted.
 *   A-RESTART  the same web client with a live session → reload the document →
 *              the persisted session restores the project (no sign-in form),
 *              the status bar reports 已连接 on the same checkout, and a fresh
 *              terminal tab reaches 实时 again — the host PTY reconnects.
 *
 * Both stations run the real product paths: a real platform process, a real
 * headless Orca host serving the built web bundle over TLS, and a real Chromium.
 * Disclosure: the host TLS is self-signed and ignored, the platform is plain
 * http, the host is headless, and it is seeded with a completed-onboarding
 * profile so the first-run wizard never covers the workspace.
 */

const HOST_NAME = 'u91-git-host'
const PROJECT_KEY = 'u91-git'
const PROJECT_NAME = 'u91-git'
const DEVELOPER = 'zhangsan'
const PASSWORD = 'Passw0rd!'
const README = 'README.md'
const UNTRACKED = 'u91-untracked.txt'
const MODIFIED_MARKER = `U91-GIT-MODIFIED-${Date.now()}`
const UNTRACKED_MARKER = `U91-GIT-UNTRACKED-${Date.now()}`
const RESTART_MARKER = `U91-RESTART-${Date.now()}`
const HOST_ONLINE_TIMEOUT_MS = 120_000
const WORKSPACE_TIMEOUT_MS = 180_000

const EVIDENCE_DIR =
  process.env.ORCA_U91_EVIDENCE_DIR ?? path.join(process.cwd(), 'evidence', 'u91-coverage')

function writeEvidence(name: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(path.join(EVIDENCE_DIR, name), `${JSON.stringify(content, null, 2)}\n`)
}

type Stack = {
  platform: CloudPlatform
  host: ElectronApplication
  adminToken: string
  root: string
  projectPath: string
  projectId: string
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

async function launchHost(
  extraEnv: Record<string, string>,
  userDataDir: string
): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  mkdirSync(path.join(userDataDir, 'home'), { recursive: true })
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  const isolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: { NODE_ENV: 'development' },
    extraEnv,
    userDataDir
  })
  return electron.launch({
    args: getOrcaElectronLaunchArgs(path.join(process.cwd(), 'out', 'main', 'index.js'), false),
    env: {
      ...isolation.env,
      ORCA_E2E_HEADLESS: '1',
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1'
    }
  })
}

let stack: Stack | null = null

test.beforeAll(async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  // Why /tmp: macOS caps Unix socket paths at 104 bytes; deep TMPDIRs break the
  // runtime's RPC socket.
  const root = realpathSync(mkdtempSync('/tmp/u91-journey-'))
  const projectsRoot = path.join(root, 'projects')
  const projectPath = path.join(projectsRoot, PROJECT_NAME)
  mkdirSync(projectPath, { recursive: true })
  git(projectPath, 'init', '-q', '-b', 'main')
  git(projectPath, 'config', 'user.email', 'e2e@example.com')
  git(projectPath, 'config', 'user.name', 'e2e')
  writeFileSync(path.join(projectPath, README), `# ${PROJECT_NAME}\n`)
  git(projectPath, 'add', '.')
  git(projectPath, 'commit', '-qm', 'init')

  const platform = await startCloudPlatform()
  const adminToken = await adminTokenOf(platform.url)

  const tls = makeHostTls(HOST_NAME)
  const hostToken = await hostTokenOf(platform.url, adminToken)
  const host = await launchHost(
    cloudHostEnv({
      platformUrl: platform.url,
      hostToken,
      hostName: HOST_NAME,
      projectsRoot,
      tls: { certPath: tls.certPath, keyPath: tls.keyPath }
    }),
    mkdtempSync(path.join(root, 'host-ud-'))
  )
  await host.firstWindow({ timeout: HOST_ONLINE_TIMEOUT_MS })
  await waitForHostOnline(platform.url, adminToken, HOST_NAME, HOST_ONLINE_TIMEOUT_MS)
  const hostsBody: unknown = await (
    await fetch(`${platform.url}/v1/hosts`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })
  ).json()
  const record = (readArray(hostsBody, 'hosts') ?? []).find(
    (entry) => readString(entry, 'name') === HOST_NAME
  )
  expect(record, `host ${HOST_NAME} missing from /v1/hosts`).toBeTruthy()
  const hostId = readString(record, 'id') ?? ''
  const directAddrs = readStringArray(record, 'directAddrs') ?? []
  expect(directAddrs.length, 'host must publish a direct address').toBeGreaterThan(0)

  const created = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_NAME,
      hostId,
      path: projectPath
    })
  })
  expect(created.status, await created.clone().text()).toBe(201)
  const projectId = readString((await created.json()) as unknown, 'id') ?? ''
  expect(projectId.length, 'project id missing').toBeGreaterThan(0)
  const granted = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  expect(granted.status, await granted.clone().text()).toBe(200)
  // The seed project's grant against an offline host would occupy the first
  // project row; clear it so the row the journey drives is ours.
  const seedCleared = await fetch(`${platform.url}/v1/projects/proj_payment/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
  })
  expect(seedCleared.status).toBe(200)

  stack = { platform, host, adminToken, root, projectPath, projectId }
})

test.afterAll(async () => {
  if (stack) {
    await closeElectronAppForE2E(stack.host).catch(() => undefined)
    await stack.platform.stop()
  }
})

function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--ignore-certificate-errors']
  })
}

function newProfile(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US'
  })
}

async function openConsoleWorkbench(platformUrl: string, context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${platformUrl}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible', timeout: 20_000 })
  await page.fill('#username', DEVELOPER)
  await page.fill('#password', PASSWORD)
  await page.click('#loginBtn')
  await page.waitForFunction(
    () => document.querySelectorAll('#content table tbody tr').length > 0,
    undefined,
    { timeout: 20_000 }
  )
  return page
}

/** Mints an admin-surface handoff and opens it directly as the workspace document. */
async function mintEmbedUrl(platformUrl: string, projectId: string): Promise<string> {
  const login = await fetch(`${platformUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: DEVELOPER, password: PASSWORD, deviceName: 'u91-restart' })
  })
  expect(login.status, await login.clone().text()).toBe(200)
  const token = readString((await login.json()) as unknown, 'accessToken') ?? ''
  expect(token.length, 'developer login must mint a token').toBeGreaterThan(0)
  const minted = await fetch(`${platformUrl}/v1/projects/${projectId}/web-handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ surface: 'admin' })
  })
  expect(minted.status, await minted.clone().text()).toBe(201)
  const url = readString((await minted.json()) as unknown, 'url') ?? ''
  expect(url, 'the admin-surface handoff must target cloud-admin.html').toContain(
    '/cloud-admin.html'
  )
  return url
}

async function waitForWorkspaceFrame(page: Page): Promise<Frame> {
  await page.waitForSelector('#workspaceOverlay iframe', { timeout: 30_000 })
  await expect
    .poll(
      async () => page.frames().some((candidate) => candidate.url().includes('/cloud-admin.html')),
      { timeout: 60_000, message: 'the overlay never mounted the cloud-admin workspace frame' }
    )
    .toBe(true)
  const frame = page.frames().find((candidate) => candidate.url().includes('/cloud-admin.html'))
  if (!frame) {
    throw new Error('the cloud-admin workspace frame disappeared after mounting')
  }
  return frame
}

async function statusText(frame: Frame, testId: string): Promise<string> {
  return (await frame.locator(`[data-testid="${testId}"]`).textContent())?.trim() ?? ''
}

async function waitForWorkspaceConnected(frame: Frame): Promise<string> {
  const pathSelector = '[data-testid="cloud-simple-workspace-status-path"]'
  await frame.waitForSelector(pathSelector, { timeout: WORKSPACE_TIMEOUT_MS })
  let workspacePath = ''
  await expect
    .poll(
      async () => {
        workspacePath = await statusText(frame, 'cloud-simple-workspace-status-path')
        const connection = await statusText(frame, 'cloud-simple-workspace-status-connection')
        return connection.includes('已连接') && workspacePath.includes('/.orca-worktrees/')
      },
      {
        timeout: WORKSPACE_TIMEOUT_MS,
        message: 'the workspace never connected to a signed checkout'
      }
    )
    .toBe(true)
  return workspacePath
}

test('U91 A-GIT 云端简易工作区 Git 变更面板：真实变更列表 → diff 左右/合并渲染', async () => {
  test.setTimeout(420_000)
  expect(stack, 'stack must have started').toBeTruthy()
  const session = stack!
  const browser = await launchBrowser()
  try {
    const page = await openConsoleWorkbench(session.platform.url, await newProfile(browser))
    // The console's 「打开」 mounts the same-page overlay; the embed is the
    // simple workspace the cloud git panel lives in (U46-3/U46-4).
    await page.locator(`button[data-open="${session.projectId}"]`).first().click()
    const frame = await waitForWorkspaceFrame(page)
    const workspacePath = await waitForWorkspaceConnected(frame)

    // Real working-tree data in the host-managed checkout: one modified tracked
    // file and one untracked file. README's committed body stays the original
    // side, so the marker proves the modified side renders.
    const original = readFileSync(path.join(workspacePath, README), 'utf8')
    expect(original, 'the checkout must carry the committed README').toContain(`# ${PROJECT_NAME}`)
    writeFileSync(path.join(workspacePath, README), `${original}${MODIFIED_MARKER}\n`)
    writeFileSync(path.join(workspacePath, UNTRACKED), `${UNTRACKED_MARKER}\n`)

    await frame.locator('[data-testid="cloud-simple-workspace-right-tab-git"]').click()
    await frame.waitForSelector('[data-testid="cloud-workspace-git-panel"]', {
      timeout: 60_000
    })
    await frame.locator('[data-testid="cloud-workspace-git-refresh"]').click()
    const modifiedRow = frame.locator(`[data-testid="cloud-workspace-git-change-${README}"]`)
    const untrackedRow = frame.locator(`[data-testid="cloud-workspace-git-change-${UNTRACKED}"]`)
    await modifiedRow.waitFor({ timeout: 30_000 })
    await untrackedRow.waitFor({ timeout: 30_000 })
    await expect(modifiedRow).toBeVisible()
    await expect(untrackedRow).toBeVisible()
    await expect(frame.locator('[data-testid="cloud-workspace-git-group-modified"]')).toBeVisible()
    await expect(frame.locator('[data-testid="cloud-workspace-git-group-untracked"]')).toBeVisible()
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'a-git-changes.png') })

    await modifiedRow.click()
    await frame.waitForSelector('[data-testid="cloud-workspace-diff-tab"]', { timeout: 30_000 })
    await expect(frame.locator('[data-testid="cloud-workspace-diff-path"]')).toHaveText(README)
    await expect(frame.locator('[data-testid="cloud-workspace-diff-source"]')).toHaveText('工作区')
    const sideBySideButton = frame.locator('[data-testid="cloud-workspace-diff-mode-side-by-side"]')
    const inlineButton = frame.locator('[data-testid="cloud-workspace-diff-mode-inline"]')
    await expect(sideBySideButton).toHaveAttribute('aria-pressed', 'true')

    // Monaco paints each side in its own editor; the marker exists only on the
    // modified side, so this is the working-tree diff, not a stale buffer.
    const diffEditor = frame.locator('[data-testid="cloud-workspace-diff-monaco"]')
    const originalLines = diffEditor.locator('.editor.original .view-lines')
    const modifiedLines = diffEditor.locator('.editor.modified .view-lines')
    await expect
      .poll(async () => (await modifiedLines.count()) > 0, {
        timeout: 30_000,
        message: 'the side-by-side diff editor never mounted'
      })
      .toBe(true)
    await expect
      .poll(async () => (await modifiedLines.first().innerText()).includes(MODIFIED_MARKER), {
        timeout: 30_000,
        message: 'the modified side never rendered the real working-tree change'
      })
      .toBe(true)
    const originalText = await originalLines.first().innerText()
    // Why the project key, not the whole heading: Monaco paints spaces as nbsp.
    expect(originalText, 'the original side renders the committed README').toContain(PROJECT_NAME)
    expect(originalText, 'the original side must not carry the modification').not.toContain(
      MODIFIED_MARKER
    )
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'a-git-diff-side-by-side.png') })

    await inlineButton.click()
    await expect(inlineButton).toHaveAttribute('aria-pressed', 'true')
    await expect(sideBySideButton).toHaveAttribute('aria-pressed', 'false')
    // Why the whole editor's innerText: innerText drops the hidden original side,
    // so this reads exactly what the merged mode paints.
    await expect
      .poll(async () => (await diffEditor.innerText()).includes(MODIFIED_MARKER), {
        timeout: 30_000,
        message: 'the merged (inline) diff never rendered the modification'
      })
      .toBe(true)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'a-git-diff-inline.png') })

    writeEvidence('a-git.json', {
      station: 'A-GIT',
      workspacePath,
      changes: { modified: README, untracked: UNTRACKED },
      groups: ['modified', 'untracked'],
      diff: {
        source: '工作区',
        sideBySide: { original: `# ${PROJECT_NAME}`, modified: MODIFIED_MARKER },
        inline: { containsModified: true }
      },
      screenshots: ['a-git-changes.png', 'a-git-diff-side-by-side.png', 'a-git-diff-inline.png']
    })
    await page.context().close()
  } finally {
    await browser.close()
  }
})

test('U91 A-RESTART 客户端重载：持久会话自动恢复项目 + 终端重连', async () => {
  test.setTimeout(420_000)
  expect(stack, 'stack must have started').toBeTruthy()
  const session = stack!
  const browser = await launchBrowser()
  try {
    const context = await newProfile(browser)
    const page = await context.newPage()
    const url = await mintEmbedUrl(session.platform.url, session.projectId)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="cloud-simple-workspace"]', {
      timeout: WORKSPACE_TIMEOUT_MS
    })
    const beforePath = await waitForWorkspaceConnected(page.mainFrame())
    const beforeProject = await statusText(
      page.mainFrame(),
      'cloud-simple-workspace-status-project'
    )
    expect(beforeProject).toBe(PROJECT_NAME)

    // A live terminal makes this a session in progress, not an idle shell.
    await page.locator('[data-testid="cloud-simple-workspace-new-terminal"]').click()
    const terminalState = page.locator('[data-testid="cloud-terminal-state"]')
    await expect(terminalState).toHaveText('实时', { timeout: 60_000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'a-restart-before.png') })

    const requests: { method: string; path: string }[] = []
    page.on('request', (request) => {
      const parsed = new URL(request.url())
      if (parsed.pathname.startsWith('/v1/')) {
        requests.push({ method: request.method(), path: parsed.pathname })
      }
    })

    // Client restart: the workspace document reloads. The handoff code is gone
    // from the address bar, so only the persisted session can bring it back.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="cloud-simple-workspace"]', {
      timeout: WORKSPACE_TIMEOUT_MS
    })
    expect(
      await page.locator('#web-cloud-api-url').count(),
      'a reload must restore the session, never land on the sign-in form'
    ).toBe(0)
    const afterPath = await waitForWorkspaceConnected(page.mainFrame())
    const afterProject = await statusText(page.mainFrame(), 'cloud-simple-workspace-status-project')
    expect(afterPath, 'the restart must reopen the same checkout').toBe(beforePath)
    expect(afterProject).toBe(PROJECT_NAME)
    // Restoration is the saved token + refresh path; a login or a second handoff
    // exchange would mean the session was not actually restored.
    const reauth = requests.filter(
      (call) => call.path === '/v1/auth/login' || call.path === '/v1/web/handoff'
    )
    expect(reauth, 'a reload must not re-authenticate by login or handoff').toEqual([])

    // Terminal reconnect: a fresh pane must reach the live host stream again.
    await page.locator('[data-testid="cloud-simple-workspace-new-terminal"]').click()
    await expect(page.locator('[data-testid="cloud-terminal-state"]')).toHaveText('实时', {
      timeout: 90_000
    })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'a-restart-after.png') })

    writeEvidence('a-restart.json', {
      station: 'A-RESTART',
      entry: 'cloud-admin.html?embed=1&project=<id>',
      marker: RESTART_MARKER,
      before: { workspacePath: beforePath, project: beforeProject, terminal: '实时' },
      after: { workspacePath: afterPath, project: afterProject, terminal: '实时' },
      reauthenticationCalls: reauth,
      screenshots: ['a-restart-before.png', 'a-restart-after.png']
    })
    await context.close()
  } finally {
    await browser.close()
  }
})

/** Mints the Orca Web (not admin-embed) handoff the reload station drives. */
async function mintOrcaWebUrl(platformUrl: string, projectId: string): Promise<string> {
  const login = await fetch(`${platformUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: DEVELOPER, password: PASSWORD, deviceName: 'u96-a8-web' })
  })
  expect(login.status, await login.clone().text()).toBe(200)
  const token = readString((await login.json()) as unknown, 'accessToken') ?? ''
  expect(token.length, 'developer login must mint a token').toBeGreaterThan(0)
  const minted = await fetch(`${platformUrl}/v1/projects/${projectId}/web-handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({})
  })
  expect(minted.status, await minted.clone().text()).toBe(201)
  const url = readString((await minted.json()) as unknown, 'url') ?? ''
  expect(url, 'the web handoff targets web-index.html').toContain('/web-index.html')
  return url
}

const U96_E2E_MARKER_ONE = `U96-A8-E2E-ONE-${Date.now()}`
const U96_E2E_MARKER_TWO = `U96-A8-E2E-TWO-${Date.now()}`

/** The renderer's local tab id for a host terminal surface (`web-terminal-<enc>`). */
function localWebTabId(hostParentTabId: string): string {
  return `web-terminal-${encodeURIComponent(hostParentTabId)}`
}

/**
 * U96 A-8 / A1 — Orca Web page reload station.
 *
 * The A-RESTART station above proves the simple workspace reconnects. This one
 * drives the real Orca Web tab surface: three live terminals are grouped into
 * two panes through the host's own `session.tabs.move` split/move-to-group
 * path (the U99 fix), typed into, and then the document reloads. The pass
 * asserts what the user sees afterwards — tab count, both panes/groups, the
 * same active tab, and each live PTY's marker text in its pane — not merely
 * that the workspace came back.
 */
test('U96 A1 Orca Web 页面重载：2 组 3 标签、活动标签与活 PTY marker 恢复', async () => {
  test.setTimeout(600_000)
  expect(stack, 'stack must have started').toBeTruthy()
  // Why: the setup drives the host through the page's own preload RPC and reads
  // window.__store, both of which only exist in the instrumented e2e bundle.
  expect(
    webBundleExposesStore(path.join(process.cwd(), 'out', 'web')),
    'out/web lacks the instrumented-build marker — rebuild with: VITE_EXPOSE_STORE=true pnpm run build:web'
  ).toBe(true)
  const session = stack!
  const browser = await launchBrowser()
  try {
    const context = await newProfile(browser)
    const page = await context.newPage()
    await page.goto(await mintOrcaWebUrl(session.platform.url, session.projectId), {
      waitUntil: 'domcontentloaded'
    })
    await page.waitForSelector('.app-layout', { timeout: WORKSPACE_TIMEOUT_MS })

    // The cloud bootstrap registers the project and activates the host-managed
    // per-user checkout; the tab work starts only once that worktree exists.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const state = window.__store?.getState?.()
            return {
              repos: state?.repos?.length ?? 0,
              activeWorktreeId: state?.activeWorktreeId ?? null
            }
          }),
        { timeout: WORKSPACE_TIMEOUT_MS, message: 'the Orca Web checkout never activated' }
      )
      .toEqual({ repos: 1, activeWorktreeId: expect.any(String) })

    const setup = await page.evaluate(
      async ({ markerOne, markerTwo }) => {
        const state = window.__store?.getState?.()
        if (!state?.activeWorktreeId) {
          throw new Error('no active worktree to drive')
        }
        const environmentId = state.runtimeEnvironments?.[0]?.id
        if (!environmentId) {
          throw new Error('no runtime environment to drive')
        }
        const worktreeId = state.activeWorktreeId
        const worktree = `id:${worktreeId}`
        const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
          const reply = (await window.api.runtimeEnvironments.call({
            selector: environmentId,
            method,
            params,
            timeoutMs: 60_000
          })) as
            | { ok: true; result: unknown }
            | { ok: false; error: { code: string; message: string } }
          if (!reply.ok) {
            throw new Error(`${method}: ${reply.error.code} ${reply.error.message}`)
          }
          return reply.result
        }
        type Result = Record<string, unknown>
        const field = (source: unknown, key: string): unknown =>
          source !== null && typeof source === 'object' ? Reflect.get(source, key) : undefined
        const text = (source: unknown, key: string): string | null => {
          const value = field(source, key)
          return typeof value === 'string' ? value : null
        }
        const list = async (): Promise<Result> =>
          (await call('session.tabs.list', { worktree })) as Result
        // The host applies a move through the renderer notifier, so the next list
        // lags the RPC — mirror the layout oracle's move wait (15s) with a poll.
        const waitForList = async (predicate: (snapshot: Result) => boolean): Promise<Result> => {
          const deadline = Date.now() + 20_000
          for (;;) {
            const snapshot = await list()
            if (predicate(snapshot)) {
              return snapshot
            }
            if (Date.now() > deadline) {
              throw new Error(`session.tabs.list never matched: ${JSON.stringify(snapshot)}`)
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
          }
        }
        const groupIds = (snapshot: Result): string[] =>
          ((field(snapshot, 'tabGroups') as unknown[]) ?? [])
            .map((group) => text(group, 'id'))
            .filter((id): id is string => id !== null)

        const before = await list()
        const beforeIds = new Set(
          ((field(before, 'tabs') as unknown[]) ?? [])
            .map((tab) => text(tab, 'id'))
            .filter((id): id is string => id !== null)
        )
        const created: { handle: string; parentTabId: string; surfaceId: string }[] = []
        for (const index of [1, 2, 3]) {
          const result = (await call('terminal.create', {
            worktree,
            title: `U96 A8 e2e terminal ${index}`,
            tabId: `u96-a8-e2e-tab-${index}`,
            leafId: `u96-a8-e2e-leaf-${index}`
          })) as Result
          const terminal = field(result, 'terminal')
          const handle = text(terminal, 'handle')
          const parentTabId = text(terminal, 'tabId')
          if (!handle || !parentTabId) {
            throw new Error(`terminal.create ${index} returned no handle/tabId`)
          }
          created.push({ handle, parentTabId, surfaceId: '' })
        }
        const afterCreate = await list()
        const fresh = ((field(afterCreate, 'tabs') as unknown[]) ?? []).filter((tab) => {
          const id = text(tab, 'id')
          return id !== null && !beforeIds.has(id)
        })
        for (const entry of created) {
          const surface = fresh.find((tab) => text(tab, 'id')?.startsWith(`${entry.parentTabId}::`))
          const surfaceId = surface ? text(surface, 'id') : null
          if (!surfaceId) {
            throw new Error(`no surface for created tab ${entry.parentTabId}`)
          }
          entry.surfaceId = surfaceId
        }
        const groups = (field(afterCreate, 'tabGroups') as unknown[]) ?? []
        const firstGroupId = text(groups[0], 'id')
        if (!firstGroupId) {
          throw new Error('the created tabs have no group to split from')
        }
        const groupIdsBeforeSplit = new Set(groupIds(afterCreate))

        // Group 2: split the second terminal right, then move the third in.
        await call('session.tabs.move', {
          kind: 'split',
          worktree,
          tabId: created[1]!.surfaceId,
          targetGroupId: firstGroupId,
          splitDirection: 'right'
        })
        // Identify the new group by id diff, not by "not the first id" — the
        // workspace may already own groups besides the one we split from.
        const afterSplit = await waitForList((snapshot) =>
          groupIds(snapshot).some((id) => !groupIdsBeforeSplit.has(id))
        )
        const secondGroupId = groupIds(afterSplit).find((id) => !groupIdsBeforeSplit.has(id))
        if (!secondGroupId) {
          throw new Error('the split created no second group')
        }
        await call('session.tabs.move', {
          kind: 'move-to-group',
          worktree,
          tabId: created[2]!.surfaceId,
          targetGroupId: secondGroupId
        })
        await call('session.tabs.activate', {
          worktree,
          tabId: created[1]!.surfaceId
        })
        await call('terminal.send', {
          terminal: created[0]!.handle,
          text: `printf '${markerOne}\\n'\r`
        })
        await call('terminal.send', {
          terminal: created[1]!.handle,
          text: `printf '${markerTwo}\\n'\r`
        })

        const beforeReload = await waitForList(
          (snapshot) =>
            groupIds(snapshot).length >= 2 &&
            text(snapshot, 'activeTabId') === created[1]!.surfaceId
        )
        const beforeTabs = ((field(beforeReload, 'tabs') as unknown[]) ?? []).map((tab) => ({
          id: text(tab, 'id'),
          title: text(tab, 'title')
        }))
        const beforeGroups = ((field(beforeReload, 'tabGroups') as unknown[]) ?? []).map(
          (group) => ({
            id: text(group, 'id'),
            tabOrder: (field(group, 'tabOrder') as string[]) ?? []
          })
        )
        return {
          worktreeId,
          environmentId,
          created,
          beforeTabs,
          beforeGroups,
          activeHostTabId: text(beforeReload, 'activeTabId'),
          activeGroupId: text(beforeReload, 'activeGroupId')
        }
      },
      { markerOne: U96_E2E_MARKER_ONE, markerTwo: U96_E2E_MARKER_TWO }
    )

    const expectedTabCount = setup.beforeTabs.length
    expect(setup.beforeGroups.length, 'two groups exist before the reload').toBe(2)
    expect(setup.activeHostTabId, 'the split-group terminal is the active tab').toBe(
      setup.created[1]!.surfaceId
    )
    const activeLocalId = localWebTabId(setup.created[1]!.parentTabId)
    const firstCreatedLocalId = localWebTabId(setup.created[0]!.parentTabId)

    // Why: once a worktree has client groups, placement is client-owned —
    // snapshots append tabs but never re-apply host order/active/layout
    // (apply-preparation-groups.ts). So the 2-pane split asserted above is a
    // host-side contract, not a local mirror contract. Only wait for the
    // created tabs to reach the visible strip before the reload under test.
    await expect
      .poll(
        async () =>
          page.evaluate(
            ({ worktreeId }) => {
              const state = window.__store?.getState?.()
              return {
                tabs: (state?.tabsByWorktree?.[worktreeId] ?? []).length,
                domTabs: document.querySelectorAll('[data-testid="sortable-tab"]').length
              }
            },
            { worktreeId: setup.worktreeId }
          ),
        { timeout: 120_000, message: 'the created tabs never reached the Orca Web tab strip' }
      )
      .toEqual({ tabs: expectedTabCount, domTabs: expectedTabCount })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u96-a1-before-reload.png') })

    const requests: { method: string; path: string }[] = []
    page.on('request', (request) => {
      const parsed = new URL(request.url())
      if (parsed.pathname.startsWith('/v1/')) {
        requests.push({ method: request.method(), path: parsed.pathname })
      }
    })
    // KNOWN RED until the product decides whether a web reload resumes the host
    // session (today it lands on the sign-in shell). The reload assertions below
    // are kept as the target contract for that fix.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.app-layout', { timeout: WORKSPACE_TIMEOUT_MS })

    // What the user sees after the reload: same checkout, same three-terminal
    // layout in two panes, the same tab selected.
    await expect
      .poll(
        async () =>
          page.evaluate(
            ({ worktreeId, activeTabId }) => {
              const state = window.__store?.getState?.()
              const tabs = state?.tabsByWorktree?.[worktreeId] ?? []
              return {
                repos: state?.repos?.length ?? 0,
                tabs: tabs.length,
                groups: (state?.groupsByWorktree?.[worktreeId] ?? []).length,
                active: state?.activeTabIdByWorktree?.[worktreeId] ?? null,
                domTabs: document.querySelectorAll('[data-testid="sortable-tab"]').length,
                domStrips: document.querySelectorAll('.terminal-tab-strip').length,
                domActive:
                  document
                    .querySelector('[data-testid="sortable-tab"][data-active="true"]')
                    ?.getAttribute('data-tab-id') ?? null,
                expectedActive: activeTabId,
                signIn: document.querySelector('#web-cloud-api-url') !== null
              }
            },
            { worktreeId: setup.worktreeId, activeTabId: activeLocalId }
          ),
        { timeout: 180_000, message: 'the reload did not restore the tab group layout' }
      )
      .toEqual({
        repos: 1,
        tabs: expectedTabCount,
        groups: 2,
        active: activeLocalId,
        domTabs: expectedTabCount,
        domStrips: 2,
        domActive: activeLocalId,
        expectedActive: activeLocalId,
        signIn: false
      })

    // Group membership, not just the count: each pane keeps its own tabs.
    const restoredGroups = await page.evaluate(
      ({ worktreeId }) => {
        const state = window.__store?.getState?.()
        return (state?.groupsByWorktree?.[worktreeId] ?? []).map((group) => [...group.tabOrder])
      },
      { worktreeId: setup.worktreeId }
    )
    expect(restoredGroups.length).toBe(2)
    expect(
      restoredGroups.every((order) => order.length > 0),
      'no group lost its tabs'
    ).toBe(true)

    const reauth = requests.filter(
      (call) => call.path === '/v1/auth/login' || call.path === '/v1/web/handoff'
    )
    expect(reauth, 'a reload must not re-authenticate by login or handoff').toEqual([])

    // Live PTY content: select each restored terminal and read its pane. The
    // marker exists in no client buffer — the host stream replays it.
    const readMarker = async (localTabId: string, marker: string): Promise<void> => {
      await page.locator(`[data-testid="sortable-tab"][data-tab-id="${localTabId}"]`).click()
      await expect
        .poll(async () => getTerminalContent(page, 10_000), {
          timeout: 120_000,
          message: `the live PTY marker never rendered in the restored pane ${localTabId}`
        })
        .toContain(marker)
    }
    await readMarker(firstCreatedLocalId, U96_E2E_MARKER_ONE)
    await readMarker(activeLocalId, U96_E2E_MARKER_TWO)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u96-a1-after-reload.png') })

    writeEvidence('u96-a1-orca-web-reload.json', {
      station: 'U96-A1',
      entry: 'web-index.html?api=<platform>#handoff=<code>',
      markerOne: U96_E2E_MARKER_ONE,
      markerTwo: U96_E2E_MARKER_TWO,
      worktreeId: setup.worktreeId,
      createdHostTabIds: setup.created.map((entry) => entry.parentTabId),
      before: {
        tabCount: expectedTabCount,
        groupCount: setup.beforeGroups.length,
        groups: setup.beforeGroups,
        activeTabId: setup.activeHostTabId,
        activeGroupId: setup.activeGroupId
      },
      after: {
        tabCount: expectedTabCount,
        groupCount: restoredGroups.length,
        groups: restoredGroups,
        activeLocalTabId: activeLocalId,
        markersVisible: [U96_E2E_MARKER_ONE, U96_E2E_MARKER_TWO],
        reauthenticationCalls: reauth
      },
      screenshots: ['u96-a1-before-reload.png', 'u96-a1-after-reload.png']
    })
    await context.close()
  } finally {
    await browser.close()
  }
})
