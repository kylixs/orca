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
      async () =>
        page.frames().some((candidate) => candidate.url().includes('/cloud-admin.html')),
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
    const sideBySideButton = frame.locator(
      '[data-testid="cloud-workspace-diff-mode-side-by-side"]'
    )
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
      screenshots: [
        'a-git-changes.png',
        'a-git-diff-side-by-side.png',
        'a-git-diff-inline.png'
      ]
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
    const afterProject = await statusText(
      page.mainFrame(),
      'cloud-simple-workspace-status-project'
    )
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
