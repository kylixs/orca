import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import { chromium } from 'playwright'
import { closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { getTerminalContent } from './helpers/terminal'
import {
  adminTokenOf,
  cloudHostEnv,
  hostTokenOf,
  makeHostTls,
  readArray,
  readField,
  readString,
  readStringArray,
  startCloudPlatform,
  waitForHostOnline,
  type CloudPlatform
} from './helpers/cloud-platform-stack'

/**
 * W9b: the Orca Web golden journey (business-chain-tests §2, line B) as one
 * continuous run against real processes — the platform API, a real Orca host
 * process (its full production RPC method table, TLS, serving the built web
 * bundle) and a real Chromium. The admin half is the C4/C5 chain the journey
 * depends on, driven over the platform API.
 *
 *   B1  zhangsan signs in on the platform console; the project row shows the
 *       「Orca Web」 entry, live for an open-permission holder
 *   B2  clicking it really mints POST /v1/projects/{id}/web-handoff and opens
 *       the issued URL (`#handoff=<code>&project=<id>`) in a new tab
 *   B3  the new tab trades the code, wipes the hash and mounts the workspace
 *       with no sign-in form and no degraded-startup toast (W7c)
 *   B4  the cloud workspace view (W13): the session's bootstrap registers the
 *       project row and activates the host-managed checkout, while the desktop
 *       catalog RPC stays refused — the terminal/file-tree half of this step
 *       is the dedicated case below
 *   B5  the same link in a fresh browser profile redeems 410 and falls back to
 *       the sign-in form with the platform address pre-filled
 *   E1  every step is timed into a timeline JSON and key moments screenshotted
 *       into `cloud-platform/evidence/journey-golden-b/`
 *
 * Coverage map against business-chain-tests §2 (line B), so the two numbering
 * schemes are never conflated: this journey's B1–B5 are §2's B1–B5. §2-B6
 * (relay access, `/h/<routeKey>/`) is the W6 relay domain and is not part of
 * this journey — the entry here is the host's direct TLS address. §2-B3's
 * 「线路徽标正常」 renders with the workspace view, so it sits downstream of
 * the B4 workspace step below. §2-B7/B8 are covered by the W7b suites
 * (web-handoff/web-handoff-entry and the web session restore/renewal specs).
 * Evidence lands as step `E1-journey-evidence`, deliberately not numbered B6.
 *
 * Disclosure — the journey's shortcuts, none silent: the host TLS is
 * self-signed and ignored (production trust lives in the desktop/platform
 * fingerprint pinning, M108/M109), the platform runs plain http, the served
 * web bundle is the instrumented e2e build (VITE_EXPOSE_STORE, which is also
 * what installs the editor probe the streaming case asserts through), the
 * C4/C5 front matter rides the platform API instead of the wizards, the host
 * is seeded with a completed-onboarding profile (`orca-data.json`, the same
 * seed the A line uses) so the first-run wizard never covers the workspace
 * the assertions drive, and the host is headless. Every assertion beyond
 * those setup reductions runs the real product paths.
 */

/**
 * W13b landed the web cloud workspace view (host `workspace.info` + the
 * three-phase bootstrap; defect-ledger U16), so B4 asserts the workspace
 * surface instead of the pre-W13 boundary it used to record, and the
 * streaming + file-tree case below runs. The former
 * `W13_CLOUD_WORKSPACE_VIEW_LANDED` gate was deleted with this flip rather
 * than left `true` — a permanent flag would only invite a second one. The
 * boundary evidence it retired stays on record:
 * `cloud-platform/evidence/journey-golden-b/findings.json` (B4) and
 * `cloud-platform/evidence/w7c-startup-scope/w7c-change-manifest.json`.
 */

const HOST_NAME = 'journey-b-host'
const PROJECT_KEY = 'journey-web'
const PROJECT_NAME = 'journey-web'
const DEVELOPER = 'zhangsan'
const PASSWORD = 'Passw0rd!'
const RUN_MARKER = `orca-web-journey-${Date.now()}`
const FILE_NAME = 'journey-web-note.txt'
const FILE_MARKER = `${RUN_MARKER}-file`
/** A cold host heartbeats before it is usable; enrolment waits that full window. */
const HOST_ONLINE_TIMEOUT_MS = 120_000

const EVIDENCE_DIR =
  process.env.ORCA_JOURNEY_GOLDEN_B_EVIDENCE_DIR ??
  path.join(process.cwd(), 'cloud-platform', 'evidence', 'journey-golden-b')

type JourneyStep = {
  step: string
  label: string
  startedAt: string
  durationMs: number
  ok: boolean
  detail?: unknown
  error?: string
}

const timeline: JourneyStep[] = []
const shots: string[] = []

function writeEvidence(name: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(path.join(EVIDENCE_DIR, name), `${JSON.stringify(content, null, 2)}\n`)
}

async function journeyStep<T>(
  step: string,
  label: string,
  body: () => Promise<T>,
  detail?: (result: T) => unknown
): Promise<T> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  try {
    const result = await body()
    timeline.push({
      step,
      label,
      startedAt,
      durationMs: Date.now() - started,
      ok: true,
      ...(detail ? { detail: detail(result) } : {})
    })
    return result
  } catch (error) {
    timeline.push({
      step,
      label,
      startedAt,
      durationMs: Date.now() - started,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
    // A failed journey still has to hand over its timeline: that is the input
    // for the next integration round.
    writeEvidence('journey-timeline.json', {
      line: 'B-orca-web',
      workOrder: 'W9b',
      runMarker: RUN_MARKER,
      generatedAt: new Date().toISOString(),
      failedAt: step,
      steps: timeline,
      screenshots: shots
    })
    throw error
  }
}

async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const file = `${name}.png`
  await page.screenshot({ path: path.join(EVIDENCE_DIR, file) })
  shots.push(file)
}

type Stack = {
  platform: CloudPlatform
  host: ElectronApplication
  adminToken: string
  root: string
  projectPath: string
  projectId: string
  hostOrigin: string
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
  // The developer's machine has Orca set up already: the first-run wizard must
  // not cover the workspace this journey drives (same seed as the A line).
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
      // Why: the host and the browser run under one OS login session.
      ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1'
    }
  })
}

let stack: Stack | null = null

test.beforeAll(async () => {
  // Why /tmp: macOS caps Unix socket paths at 104 bytes; deep TMPDIRs break the
  // runtime's RPC socket and the host then heartbeats an empty endpoint.
  const root = realpathSync(mkdtempSync('/tmp/w9b-journey-'))
  const projectsRoot = path.join(root, 'projects')
  const projectPath = path.join(projectsRoot, PROJECT_NAME)
  mkdirSync(projectPath, { recursive: true })
  git(projectPath, 'init', '-q', '-b', 'main')
  git(projectPath, 'config', 'user.email', 'e2e@example.com')
  git(projectPath, 'config', 'user.name', 'e2e')
  writeFileSync(path.join(projectPath, 'README.md'), `# ${PROJECT_NAME}\n`)
  writeFileSync(path.join(projectPath, FILE_NAME), `${FILE_MARKER}\n`)
  git(projectPath, 'add', '.')
  git(projectPath, 'commit', '-qm', 'init')

  const admin = await journeyStep('S0-platform', '平台进程启动与管理员登录', async () => {
    const platform = await startCloudPlatform()
    return { platform, adminToken: await adminTokenOf(platform.url) }
  })
  const { platform, adminToken } = admin

  const enrolled = await journeyStep(
    'S1-host-enrol',
    '宿主注册：真实 Orca 宿主进程 TLS 上线，直连地址/E2EE 密钥齐备（production 方法表，伺服 out/web）',
    async () => {
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
      expect(readField(record, 'online'), 'host must report online').toBe(true)
      const directAddrs = readStringArray(record, 'directAddrs') ?? []
      expect(directAddrs.length, 'directAddrs must not be empty').toBeGreaterThan(0)
      const directAddr = directAddrs[0] ?? ''
      expect(directAddr, 'the first direct address must be host:port over TLS').toMatch(
        /^127\.0\.0\.1:\d+$/
      )
      return {
        host,
        hostId: readString(record, 'id') ?? '',
        hostOrigin: `https://${directAddr}`
      }
    },
    (result) => ({ hostId: result.hostId, hostOrigin: result.hostOrigin })
  )

  const projectId = await journeyStep(
    'S2-project-grant',
    '管理员建项目（绑定宿主）并授权 team-payment 组（C4/C5 前置）',
    async () => {
      const created = await fetch(`${platform.url}/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          key: PROJECT_KEY,
          name: PROJECT_NAME,
          hostId: enrolled.hostId,
          path: projectPath
        })
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const createdId = readString((await created.json()) as unknown, 'id') ?? ''
      expect(createdId.length, 'project id missing').toBeGreaterThan(0)
      const granted = await fetch(`${platform.url}/v1/projects/${createdId}/grants`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          subjectType: 'group',
          subjectId: 'team-payment',
          permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
        })
      })
      expect(granted.status, await granted.clone().text()).toBe(200)
      // The seed project carries the same group grant against an offline
      // placeholder host; clearing it keeps the developer's first project the
      // journey's own, so the row the journey drives is ours.
      const seedCleared = await fetch(`${platform.url}/v1/projects/proj_payment/grants`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
      })
      expect(seedCleared.status).toBe(200)
      return createdId
    },
    (createdId) => ({ projectId: createdId, grant: 'group:team-payment' })
  )

  stack = {
    platform,
    host: enrolled.host,
    adminToken,
    root,
    projectPath,
    projectId,
    hostOrigin: enrolled.hostOrigin
  }
})

test.afterAll(async () => {
  if (stack) {
    await closeElectronAppForE2E(stack.host).catch(() => undefined)
    await stack.platform.stop()
  }
  writeEvidence('journey-timeline.json', {
    line: 'B-orca-web',
    workOrder: 'W9b',
    runMarker: RUN_MARKER,
    generatedAt: new Date().toISOString(),
    steps: timeline,
    screenshots: shots
  })
})

/**
 * A real Chrome run. Shortcuts (all disclosed in the header): the self-signed
 * host TLS is ignored, and the browser runs headless under an isolated profile.
 */
async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--ignore-certificate-errors']
  })
}

function newProfile(browser: Browser): Promise<BrowserContext> {
  // Why the locale pin: the degraded-startup toast and other surfaced strings
  // are localized, so the text assertions must not depend on the host OS
  // locale (MIN-2).
  return browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US'
  })
}

/** Records every /v1 exchange a context makes, whatever page it came from. */
function watchPlatformTraffic(context: BrowserContext): {
  requests: { method: string; path: string }[]
  responses: { status: number; path: string }[]
} {
  const requests: { method: string; path: string }[] = []
  const responses: { status: number; path: string }[] = []
  context.on('request', (request) => {
    if (request.url().includes('/v1/')) {
      requests.push({ method: request.method(), path: new URL(request.url()).pathname })
    }
  })
  context.on('response', (response) => {
    if (response.url().includes('/v1/')) {
      responses.push({ status: response.status(), path: new URL(response.url()).pathname })
    }
  })
  return { requests, responses }
}

/** Signs zhangsan in on the platform console the way the user does. */
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

test('W9b Orca Web 黄金旅程：平台登录 → handoff 新标签自动进入 → 重放 410 回落', async () => {
  test.setTimeout(600_000)
  expect(stack, 'stack must have started').toBeTruthy()
  const session = stack!
  const browser = await launchBrowser()

  try {
    // ── B1 · 登录平台 Web，「Orca Web」入口可见可用 ──────────────────
    await journeyStep(
      'B1-console-login',
      'zhangsan 登录平台 Web，项目行出现可点击的「Orca Web」入口（open 权限）',
      async () => {
        const page = await openConsoleWorkbench(session.platform.url, await newProfile(browser))
        const entry = page.locator(`button[data-orca-web="${session.projectId}"]`)
        await expect(entry, 'the project row must carry the Orca Web entry').toBeVisible()
        await expect(entry, 'an online host keeps the entry clickable').toBeEnabled()
        await shoot(page, '01-console-orca-web-entry')
        await page.context().close()
        return { projectId: session.projectId }
      },
      (result) => ({ projectId: result.projectId, entry: 'button[data-orca-web]' })
    )

    // ── B2 · 点击入口：真实签发 handoff，新标签打开带 hash 的入口 URL ──
    // Why the log sink lives here: the entry tab's console must be recorded
    // from the moment the tab exists, so the B3 boot-chain observations cover
    // the bundle-evaluation window too (MIN-1).
    const entryTabConsoleLogs: string[] = []
    const issued = await journeyStep(
      'B2-handoff-new-tab',
      '点击「Orca Web」：真实调用 web-handoff，新标签打开 #handoff=<code>&project=<id> 入口',
      async () => {
        const context = await newProfile(browser)
        const traffic = watchPlatformTraffic(context)
        const page = await openConsoleWorkbench(session.platform.url, context)
        const entry = page.locator(`button[data-orca-web="${session.projectId}"]`)
        // Why retries: window.open can lose the race against a just-mounted row.
        let popup: Page | null = null
        for (let attempt = 1; attempt <= 3 && !popup; attempt += 1) {
          const popupPromise = page.waitForEvent('popup', { timeout: 10_000 }).then(
            (value) => value,
            () => null
          )
          await entry.click()
          popup = await popupPromise
        }
        expect(popup, 'clicking Orca Web must open the entry in a new tab').toBeTruthy()
        const entryTab = popup!
        entryTab.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning') {
            entryTabConsoleLogs.push(message.text())
          }
        })
        await entryTab.waitForLoadState('domcontentloaded')
        const url = new URL(entryTab.url())
        const handoffCall = traffic.requests.find(
          (call) =>
            call.method === 'POST' && call.path === `/v1/projects/${session.projectId}/web-handoff`
        )
        expect(handoffCall, 'the row must really mint a handoff code').toBeTruthy()
        expect(url.origin, 'the entry page is served by the host over TLS').toBe(session.hostOrigin)
        expect(url.pathname, 'the entry page is the web client').toBe('/web-index.html')
        expect(url.searchParams.get('api'), 'the page finds the platform through ?api=').toBe(
          session.platform.url
        )
        expect(url.hash, 'the hash must carry the one-time code and the project id').toMatch(
          new RegExp(`^#handoff=[A-Za-z0-9_-]+&project=${session.projectId}$`)
        )
        await shoot(page, '02-console-after-click')
        return { issuedUrl: `${url.origin}${url.pathname}${url.search}${url.hash}`, entryTab }
      },
      (result) => ({
        minted: 'POST /v1/projects/{id}/web-handoff',
        entryUrl: result.issuedUrl.replace(/#handoff=[A-Za-z0-9_-]+/, '#handoff=<redacted>')
      })
    )

    // ── B3 · 新标签自动进入工作区（无登录表单、hash 清空、无降级 toast）─
    await journeyStep(
      'B3-auto-enter-workspace',
      '新标签换码自动进入工作区：hash 清空、无登录表单、降级 toast=false、云侧栏空态、会话持久化',
      async () => {
        const tab = issued.entryTab
        await tab.waitForSelector('.app-layout', { timeout: 90_000 })
        // Why the settle: the degraded-startup toast (W7c) is sticky and fires
        // with the boot chain, so the pass has to survive the window it would
        // appear in, not just the first painted frame.
        await tab.waitForTimeout(8_000)
        const state = await tab.evaluate(() => {
          const storeState = window.__store?.getState?.() ?? null
          const storedEnvironment = window.localStorage.getItem('orca.web.runtimeEnvironment.v1')
          return {
            hash: window.location.hash,
            hasSignInForm: document.querySelector('#web-cloud-api-url') !== null,
            hasAppLayout: document.querySelector('.app-layout') !== null,
            degradedToast: document.body.innerText.includes('Session restore failed'),
            cloudSessionPersisted: window.localStorage.getItem('orca.webCloudSession') !== null,
            environment:
              storedEnvironment === null
                ? null
                : (JSON.parse(storedEnvironment) as { name?: string }),
            sidebarCloudEmptyState:
              document.querySelector('[data-worktree-sidebar-container] svg.lucide-cloud') !== null,
            repoCount: storeState?.repos?.length ?? null,
            activeWorktreeId: storeState?.activeWorktreeId ?? null
          }
        })
        expect(state.hash, 'the one-time code must leave the address bar').toBe('')
        expect(state.hasAppLayout, 'the workspace shell must mount').toBe(true)
        expect(state.hasSignInForm, 'no sign-in form may cover the workspace').toBe(false)
        expect(state.degradedToast, 'the startup chain must not boot degraded (W7c)').toBe(false)
        expect(state.cloudSessionPersisted, 'the exchanged session must persist').toBe(true)
        expect(
          state.environment?.name ?? '',
          'the adopted environment is the minted project'
        ).toContain(PROJECT_NAME)
        const denialLogs = entryTabConsoleLogs.filter((line) =>
          line.includes('not available to cloud sessions')
        )
        expect(denialLogs, 'the boot chain must not call cloud-refused RPCs (W7c)').toEqual([])
        await shoot(tab, '03-web-workspace-entered')
        return {
          ...state,
          denialLogCount: denialLogs.length,
          consoleLogCount: entryTabConsoleLogs.length
        }
      },
      (state) => ({
        hash: state.hash,
        signInForm: state.hasSignInForm,
        degradedToast: state.degradedToast,
        sessionPersisted: state.cloudSessionPersisted,
        environmentName: state.environment?.name ?? null,
        cloudDenialConsoleLogs: state.denialLogCount,
        consoleErrorWarningCount: state.consoleLogCount
      })
    )

    // ── B4 · 云工作区视图点亮（W13b：宿主 workspace.info + web 三阶段 bootstrap）──
    await journeyStep(
      'B4-cloud-workspace-view',
      'B4 工作区视图：bootstrap 登记项目行并激活宿主管理的本人 checkout，桌面目录仍按票据范围被拒',
      async () => {
        const tab = issued.entryTab
        const workspaceState = () =>
          tab.evaluate(() => {
            const storeState = window.__store?.getState?.() ?? null
            return {
              sidebarCloudEmptyState:
                document.querySelector('[data-worktree-sidebar-container] svg.lucide-cloud') !==
                null,
              repoCount: storeState?.repos?.length ?? null,
              activeWorktreeId: storeState?.activeWorktreeId ?? null,
              activeWorktreePath:
                Object.values(storeState?.worktreesByRepo ?? {})
                  .flat()
                  .find((entry) => entry.id === storeState?.activeWorktreeId)?.path ?? null,
              explorerShellMounted: document.querySelector('[data-orca-explorer-shell]') !== null
            }
          })
        // The bootstrap runs beside the boot chain and a first open clones, so the
        // wait has to cover a cold checkout, not just an already-ensured one.
        await expect
          .poll(
            async () => {
              const state = await workspaceState()
              return state.repoCount === 1 && state.activeWorktreeId !== null
            },
            {
              timeout: 180_000,
              message: 'the cloud workspace bootstrap never activated the checkout'
            }
          )
          .toBe(true)
        const state = await workspaceState()
        expect(
          state.sidebarCloudEmptyState,
          'the cloud card retires once the project row lands'
        ).toBe(false)
        expect(state.repoCount, 'the ticket registers exactly its own project').toBe(1)
        expect(state.activeWorktreeId, 'a checkout activates as the workspace').toBeTruthy()
        expect(
          state.activeWorktreePath ?? '',
          'the activated checkout is the host-managed per-user one'
        ).toContain(`${session.projectPath}/.orca-worktrees/${DEVELOPER}`)
        // The W7c boundary holds underneath: the row came from `repo.add` with the
        // ticket-pinned path, never from the desktop catalog.
        const catalogRefusal = await tab.evaluate(async () =>
          window.api.repos.list().then(
            () => 'unexpectedly allowed',
            (error: unknown) => (error instanceof Error ? error.message : String(error))
          )
        )
        expect(catalogRefusal, 'repo.list stays cloud-refused by design (W7c boundary)').toContain(
          "Method 'repo.list' is not available to cloud sessions"
        )
        const denialLogs = entryTabConsoleLogs.filter((line) =>
          line.includes('not available to cloud sessions')
        )
        expect(denialLogs, 'the workspace view must not call cloud-refused RPCs').toEqual([])
        await shoot(tab, '04-cloud-session-with-workspace-view')
        return {
          mode: 'w13',
          ...state,
          catalogRefusal,
          denialLogCount: denialLogs.length,
          consoleErrorWarningCount: entryTabConsoleLogs.length
        }
      },
      (state) => state
    )

    // ── B5 · 同一链接新 context 重放：410 回落登录表单（预填平台地址）──
    await journeyStep(
      'B5-replay-410-fallback',
      '同链接在全新浏览器档案重放：换码 410，回落登录表单并预填平台地址',
      async () => {
        const context = await newProfile(browser)
        const traffic = watchPlatformTraffic(context)
        const page = await context.newPage()
        await page.goto(issued.issuedUrl, { waitUntil: 'domcontentloaded' })
        await page.waitForSelector('#web-cloud-api-url', { timeout: 30_000 })
        await page.waitForTimeout(1_000)
        const state = await page.evaluate(() => ({
          hash: window.location.hash,
          hasSignInForm: document.querySelector('#web-cloud-api-url') !== null,
          hasAppLayout: document.querySelector('.app-layout') !== null,
          prefilledApiUrl: (document.querySelector('#web-cloud-api-url') as HTMLInputElement).value,
          cloudSessionPersisted: window.localStorage.getItem('orca.webCloudSession') !== null
        }))
        const redeem = traffic.responses.find((reply) => reply.path === '/v1/web/handoff')
        expect(redeem?.status, 'the spent code must redeem as 410').toBe(410)
        expect(state.hasSignInForm, 'the entry falls back to the sign-in form').toBe(true)
        expect(state.hasAppLayout, 'no workspace mounts for a spent code').toBe(false)
        expect(state.prefilledApiUrl, 'the sign-in form pre-fills the platform address').toBe(
          session.platform.url
        )
        expect(state.cloudSessionPersisted, 'a replay must not store a session').toBe(false)
        await shoot(page, '05-replay-410-sign-in')
        await context.close()
        return { redeemStatus: redeem?.status ?? null, ...state }
      },
      (state) => ({
        redeemStatus: state.redeemStatus,
        signInForm: state.hasSignInForm,
        prefilledApiUrl: state.prefilledApiUrl
      })
    )

    // ── E1 · 旅程证据落盘（不占 §2-B6 编号：那是中继访问，属 W6 域）──
    await journeyStep(
      'E1-journey-evidence',
      '旅程证据落盘：时间线与关键截图齐备（编号 E1，避开 §2-B6 中继步骤）',
      async () => {
        const missing = shots.filter((name) => !existsSync(path.join(EVIDENCE_DIR, name)))
        expect(missing, `screenshots missing on disk: ${missing.join(', ')}`).toEqual([])
        return { screenshots: shots.length, timelineSteps: timeline.length }
      },
      (result) => result
    )
  } finally {
    await browser.close()
  }
})

test('W9b-B4 终端流式回显与文件树打开（W13 云工作区视图）', async () => {
  test.setTimeout(300_000)
  expect(stack, 'stack must have started').toBeTruthy()
  const session = stack!
  const browser = await launchBrowser()
  try {
    // The entry mints a fresh code over the API the same way the console does.
    const loginReply = await fetch(`${session.platform.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: DEVELOPER, password: PASSWORD, deviceName: 'w9b-b4' })
    })
    const loginBody = (await loginReply.json()) as { accessToken?: string }
    expect(loginBody.accessToken, 'developer login must succeed').toBeTruthy()
    const mintReply = await fetch(
      `${session.platform.url}/v1/projects/${session.projectId}/web-handoff`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${loginBody.accessToken}` }
      }
    )
    expect(mintReply.status, await mintReply.clone().text()).toBe(201)
    const minted = ((await mintReply.json()) as { url: string }).url

    const context = await newProfile(browser)
    const traffic = watchPlatformTraffic(context)
    const tab = await context.newPage()
    await tab.goto(minted, { waitUntil: 'domcontentloaded' })
    await tab.waitForSelector('.app-layout', { timeout: 90_000 })

    // W13: the workspace view mounts the cloud project's checkout. Its terminal
    // pane subscribes through the W5c re-signed child ticket (one fresh
    // /connect mint on top of the entry's own), and the file tree opens the
    // seeded file. Streaming oracle: the marker is typed after the subscription
    // opens, so it exists in no scrollback buffer — its arrival on the pane is
    // the live stream, not a buffered read.
    await expect
      .poll(
        async () =>
          traffic.requests.filter(
            (call) =>
              call.method === 'POST' && call.path === `/v1/projects/${session.projectId}/connect`
          ).length,
        {
          // Why as long as B4's wait: a first open clones the project before any
          // pane exists to subscribe.
          timeout: 180_000,
          message: 'the terminal subscription must re-sign its own ticket (W5c)'
        }
      )
      .toBeGreaterThanOrEqual(2)
    // A first-run feature tip can still cover the workspace; the user reads it,
    // dismisses it, and moves on.
    await tab
      .getByRole('button', { name: 'Got it' })
      .click({ timeout: 10_000 })
      .catch(() => undefined)
    // The user's first act is clicking the pane; keystrokes go to the xterm
    // input only once it has focus.
    await tab.locator('.xterm').first().click()
    await tab.keyboard.type(`echo ${RUN_MARKER}`)
    await tab.keyboard.press('Enter')
    // The buffer oracle is the pane's SerializeAddon (exposed by the instrumented
    // bundle); xterm paints rows on a canvas here, so the DOM rows carry no text.
    await expect
      .poll(async () => getTerminalContent(tab, 8000), {
        timeout: 30_000,
        message: 'the streamed echo never reached the terminal pane'
      })
      .toContain(RUN_MARKER)

    // W5c semantics: the re-signed ticket must never be refused as a replay.
    const auditReply = await fetch(
      `${session.platform.url}/v1/audit/events?eventType=host.connection_rejected`,
      { headers: { authorization: `Bearer ${session.adminToken}` } }
    )
    expect(auditReply.status, await auditReply.clone().text()).toBe(200)
    const auditBody = readArray(await auditReply.json(), 'events') ?? []
    const replayed = auditBody.filter(
      (event) => readString(readField(event, 'metadata'), 'reason') === 'replayed'
    )
    expect(replayed, 'the subscription must not be refused as a replay').toEqual([])

    const explorerFile = tab.locator('[data-orca-explorer-shell]').getByText(FILE_NAME)
    await expect(explorerFile).toBeVisible({ timeout: 30_000 })
    await explorerFile.click()
    await expect(tab.locator('.editor-header-path').first()).toContainText(FILE_NAME, {
      timeout: 30_000
    })
    // The editor oracle is the probe: the instrumented web build defines
    // VITE_EXPOSE_STORE, which installs it (W13b) where the production bundle
    // never would. The rendered lines stay asserted too — that is the artifact
    // the user reads, and Monaco only paints the viewport.
    await expect
      .poll(
        async () => await tab.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail ?? ''),
        { timeout: 30_000, message: 'the editor model never received the file content' }
      )
      .toContain(FILE_MARKER)
    await expect
      .poll(async () => tab.locator('.view-lines').innerText(), {
        timeout: 30_000,
        message: 'editor never rendered the file content'
      })
      .toContain(FILE_MARKER)
    await shoot(tab, '06-b4-terminal-stream-and-file')
    await context.close()
  } finally {
    await browser.close()
  }
})
