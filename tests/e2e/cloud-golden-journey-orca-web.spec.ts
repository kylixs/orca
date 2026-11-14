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
 *   B4  the cloud-session workspace boundary, recorded as red-line evidence —
 *       the web cloud session has no workspace view yet, so no terminal or file
 *       tree can be driven; the streaming half of this step lives in the
 *       dedicated case below and stays skipped until W13 lands
 *   B5  the same link in a fresh browser profile redeems 410 and falls back to
 *       the sign-in form with the platform address pre-filled
 *   B6  every step is timed into a timeline JSON and key moments screenshotted
 *       into `cloud-platform/evidence/journey-golden-b/`
 */

/** W13 owns the web cloud workspace view (host workspace.info + web file tree/terminal). */
const W13_CLOUD_WORKSPACE_VIEW_LANDED = false

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

/** A real Chrome run; ignoring the self-signed host TLS is the journey's only shortcut. */
async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--ignore-certificate-errors']
  })
}

function newProfile(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
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
        const logs: string[] = []
        tab.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning') {
            logs.push(message.text())
          }
        })
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
        const denialLogs = logs.filter((line) => line.includes('not available to cloud sessions'))
        expect(denialLogs, 'the boot chain must not call cloud-refused RPCs (W7c)').toEqual([])
        await shoot(tab, '03-web-workspace-entered')
        return state
      },
      (state) => ({
        hash: state.hash,
        signInForm: state.hasSignInForm,
        degradedToast: state.degradedToast,
        sessionPersisted: state.cloudSessionPersisted,
        environmentName: state.environment?.name ?? null
      })
    )

    // ── B4 · 云会话工作区边界（红线证据：W13 前无终端/文件树用户路径）──
    await journeyStep(
      'B4-cloud-workspace-boundary',
      'B4 边界（红线）：Orca Web 云会话暂无工作区视图——侧栏为云空态、目录与工作树为空、目录 RPC 按票据范围被拒',
      async () => {
        if (W13_CLOUD_WORKSPACE_VIEW_LANDED) {
          // W13 落地后本步改为要求工作区表面存在；流式与文件断言由下方专用用例驱动。
          throw new Error('W13 landed: flip this step to assert the workspace view surface')
        }
        const tab = issued.entryTab
        const state = await tab.evaluate(async () => {
          const storeState = window.__store?.getState?.() ?? null
          const catalogRefusal = await window.api.repos.list().then(
            () => 'unexpectedly allowed',
            (error: unknown) => (error instanceof Error ? error.message : String(error))
          )
          const worktreeCatalog = await window.api.worktrees.listAll().then(
            (value: unknown) => `listed:${JSON.stringify(value).length}`,
            (error: unknown) => (error instanceof Error ? error.message : String(error))
          )
          return {
            sidebarCloudEmptyState:
              document.querySelector('[data-worktree-sidebar-container] svg.lucide-cloud') !== null,
            repoCount: storeState?.repos?.length ?? null,
            activeWorktreeId: storeState?.activeWorktreeId ?? null,
            worktreeCatalogs: Object.keys(storeState?.worktreesByRepo ?? {}),
            catalogRefusal,
            worktreeCatalog
          }
        })
        expect(state.sidebarCloudEmptyState, 'the sidebar presents the cloud empty state').toBe(
          true
        )
        expect(state.repoCount, 'the ticket carries no desktop catalog').toBe(0)
        expect(state.activeWorktreeId, 'no workspace opens in a cloud session today').toBeNull()
        expect(
          state.catalogRefusal,
          'repo.list is cloud-refused by design (W7c boundary)'
        ).toContain("Method 'repo.list' is not available to cloud sessions")
        await shoot(tab, '04-cloud-session-without-workspace-view')
        return {
          ...state,
          rootCause: [
            '宿主无 workspace.info 实现：cloud-rpc-permission.ts 把它列为 session 方法，但 runtime 方法表没有该方法，云会话拿不到项目工作区信息',
            'web 云会话未挂工作区视图：web-index 的 App 仅有侧栏云空态（CloudSessionEmptyState），无文件树/终端入口（W13）',
            '已知边界来源：cloud-platform/evidence/w7c-startup-scope/w7c-change-manifest.json（cloudMethodTable.extended=false 的裁定）'
          ],
          pendingWorkOrder: 'W13 orca web 云工作区视图（宿主 workspace.info 实现 + web 工作区视图）'
        }
      },
      (state) => ({
        repoCount: state.repoCount,
        activeWorktreeId: state.activeWorktreeId,
        catalogRefusal: state.catalogRefusal,
        worktreeCatalog: state.worktreeCatalog,
        rootCause: state.rootCause,
        pendingWorkOrder: state.pendingWorkOrder
      })
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

    // ── B6 · 旅程证据落盘 ───────────────────────────────────────────
    await journeyStep(
      'B6-evidence',
      '旅程证据落盘：时间线与关键截图齐备',
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

test('W9b-B4 终端流式回显与文件树打开（待 W13 云工作区视图落地后启用）', async () => {
  test.skip(
    !W13_CLOUD_WORKSPACE_VIEW_LANDED,
    '待 W13（orca web 云工作区视图：宿主 workspace.info 实现 + web 工作区视图挂文件树/终端）落地后启用；' +
      '边界证据见 cloud-platform/evidence/journey-golden-b/journey-timeline.json 的 B4 步，' +
      '与 cloud-platform/evidence/w7c-startup-scope/w7c-change-manifest.json'
  )
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
          timeout: 60_000,
          message: 'the terminal subscription must re-sign its own ticket (W5c)'
        }
      )
      .toBeGreaterThanOrEqual(2)
    await tab.keyboard.type(`echo ${RUN_MARKER}`)
    await tab.keyboard.press('Enter')
    await expect
      .poll(async () => tab.locator('.xterm-rows').innerText(), {
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
    await expect
      .poll(async () => window_snapshotEditorValueTail(tab), {
        timeout: 30_000,
        message: 'editor never rendered the file content'
      })
      .toBe(FILE_MARKER)
    await shoot(tab, '06-b4-terminal-stream-and-file')
    await context.close()
  } finally {
    await browser.close()
  }
})

/** The editor's rendered tail, read through the E2E probe the web build exposes. */
async function window_snapshotEditorValueTail(tab: Page): Promise<string> {
  return tab.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail ?? '')
}
