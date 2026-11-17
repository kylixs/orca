import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import {
  firstWindowWithStartupGuard,
  launchElectronAppWithStartupGuard
} from './helpers/electron-startup-guard'
import { chromium } from 'playwright'
import { closeElectronAppForE2E } from './helpers/electron-process-shutdown'
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
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import { launchPairedWebClient, type PairedWebClient } from './helpers/paired-electron-client'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'

/**
 * W13c-2: the cloud workspace view's negatives (W13b landed the surface; W13
 * design §4.4 fallback + §7.3 zero-regression rows). Every case drives the real
 * stack — the platform API, a real Orca host serving the built web bundle, a
 * real Chromium or the paired web client — and asserts the view degrades into
 * the states the design promises instead of a white screen or a lit workspace.
 *
 *   neg-1  workspace.info unavailable → the sidebar's cloud card carries the
 *          fallback, the shell stays mounted, nothing activates (no white screen)
 *   neg-2  a paired (non-cloud) web session never runs the cloud bootstrap: the
 *          desktop boot chain answers as it always did and the cloud card never
 *          appears
 *   neg-3  a handoff ticket that is missing or invalid falls back to the sign-in
 *          form (W7b entry semantics intact under the W13b view)
 */

const HOST_NAME = 'w13c2-negatives-host'
const PROJECT_KEY = 'w13c2-negatives'
const PROJECT_NAME = 'w13c2-negatives'
const DEVELOPER = 'zhangsan'
const PASSWORD = 'Passw0rd!'
/** A cold host heartbeats before it is usable; enrolment waits that full window. */
const HOST_ONLINE_TIMEOUT_MS = 120_000

const EVIDENCE_DIR =
  process.env.ORCA_W13C2_NEGATIVES_EVIDENCE_DIR ??
  path.join(process.cwd(), 'cloud-platform', 'evidence', 'w13c2-view-negatives')

type Stack = {
  platform: CloudPlatform
  host: ElectronApplication
  adminToken: string
  projectId: string
  hostOrigin: string
}

type ConsoleRecord = { type: string; text: string }

function writeEvidence(name: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(path.join(EVIDENCE_DIR, name), `${JSON.stringify(content, null, 2)}\n`)
}

async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`) })
}

function cloudDenialLogs(records: ConsoleRecord[]): string[] {
  return records
    .filter((entry) => entry.text.includes('not available to cloud sessions'))
    .map((entry) => entry.text)
}

function recordConsole(page: Page): ConsoleRecord[] {
  const records: ConsoleRecord[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      records.push({ type: message.type(), text: message.text() })
    }
  })
  return records
}

/** Same reduction as the golden journeys: headless Chrome that trusts the self-signed host TLS. */
async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--ignore-certificate-errors']
  })
}

function newProfile(browser: Browser): Promise<BrowserContext> {
  // Why the locale pin: the fallback copy is localized, so text assertions must
  // not depend on the host OS locale (golden-journey MIN-2 precedent).
  return browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US'
  })
}

/** Mints a fresh entry URL the way the console's Orca Web button does. */
async function mintEntryUrl(platformUrl: string, projectId: string): Promise<string> {
  const loginReply = await fetch(`${platformUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: DEVELOPER, password: PASSWORD, deviceName: 'w13c2-negatives' })
  })
  const loginBody = (await loginReply.json()) as { accessToken?: string }
  expect(loginBody.accessToken, 'developer login must succeed').toBeTruthy()
  const mintReply = await fetch(`${platformUrl}/v1/projects/${projectId}/web-handoff`, {
    method: 'POST',
    headers: { authorization: `Bearer ${loginBody.accessToken}` }
  })
  expect(mintReply.status, await mintReply.clone().text()).toBe(201)
  return ((await mintReply.json()) as { url: string }).url
}

let stack: Stack | null = null

test.beforeAll(async () => {
  // Why /tmp: macOS caps Unix socket paths at 104 bytes; deep TMPDIRs break the
  // runtime's RPC socket (golden-journey precedent).
  const root = realpathSync(mkdtempSync('/tmp/w13c2-negatives-'))
  const projectsRoot = path.join(root, 'projects')
  const projectPath = path.join(projectsRoot, PROJECT_NAME)
  mkdirSync(projectPath, { recursive: true })
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: projectPath, stdio: 'ignore' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'e2e')
  writeFileSync(path.join(projectPath, 'README.md'), `# ${PROJECT_NAME}\n`)
  git('add', '.')
  git('commit', '-qm', 'init')

  const platform = await startCloudPlatform()
  const adminToken = await adminTokenOf(platform.url)
  const tls = makeHostTls(HOST_NAME)
  const hostToken = await hostTokenOf(platform.url, adminToken)
  const userDataDir = mkdtempSync(path.join(root, 'host-ud-'))
  mkdirSync(path.join(userDataDir, 'home'), { recursive: true })
  // The developer's machine has Orca set up already: the first-run wizard must
  // not cover the workspace these cases drive (same seed as the golden journeys).
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: { NODE_ENV: 'development' },
    extraEnv: cloudHostEnv({
      platformUrl: platform.url,
      hostToken,
      hostName: HOST_NAME,
      projectsRoot,
      tls: { certPath: tls.certPath, keyPath: tls.keyPath }
    }),
    userDataDir
  })
  const host = await launchElectronAppWithStartupGuard({
    args: getOrcaElectronLaunchArgs(path.join(process.cwd(), 'out', 'main', 'index.js'), false),
    env: {
      ...isolation.env,
      ORCA_E2E_HEADLESS: '1',
      ORCA_BACKGROUND_LAUNCH: '1',
      // Why: the host and the browser run under one OS login session.
      ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1'
    }
  })
  await firstWindowWithStartupGuard(host, { timeout: HOST_ONLINE_TIMEOUT_MS })
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
  const directAddrs = readStringArray(record, 'directAddrs') ?? []
  expect(directAddrs.length, 'directAddrs must not be empty').toBeGreaterThan(0)

  const created = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_NAME,
      hostId: readString(record, 'id') ?? '',
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

  stack = {
    platform,
    host,
    adminToken,
    projectId,
    hostOrigin: `https://${directAddrs[0] ?? ''}`
  }
})

test.afterAll(async () => {
  if (stack) {
    await closeElectronAppForE2E(stack.host).catch(() => undefined)
    await stack.platform.stop()
  }
  writeEvidence('negatives-run.json', {
    workOrder: 'W13c-2',
    generatedAt: new Date().toISOString(),
    cases: [
      'neg-1-workspace-info-unavailable-falls-back-to-cloud-card',
      'neg-2-paired-web-session-runs-no-cloud-bootstrap',
      'neg-3-handoff-ticket-missing-or-invalid-falls-back-to-sign-in'
    ]
  })
})

test('W13c-2 neg-1: workspace.info 不可用 → 云卡回落，壳不白屏，不激活任何工作区', async () => {
  test.setTimeout(240_000)
  expect(stack, 'stack must have started').toBeTruthy()
  const session = stack!
  const entryUrl = await mintEntryUrl(session.platform.url, session.projectId)
  const browser = await launchBrowser()
  try {
    const context = await newProfile(browser)
    // Fault injection at the exact seam the bootstrap reads: a client the W13
    // namespace never reached. `installWebPreloadApi` assigns window.api once, so
    // the trap rewrites that one assignment — the namespace becomes undefined, so
    // the production `window.api?.cloudWorkspace ?? null` answers null and the
    // bootstrap must take its own `unavailable` fallback (W13 §4.4). Why set and
    // not delete: window.api is a withFallback Proxy, and a deleted key would
    // come back as a fallback proxy instead of undefined.
    await context.addInitScript(() => {
      Object.defineProperty(window, 'api', {
        configurable: true,
        get: () => undefined,
        set: (value: unknown) => {
          if (value !== null && typeof value === 'object') {
            Reflect.set(value, 'cloudWorkspace', undefined)
          }
          Object.defineProperty(window, 'api', { value, configurable: true, writable: true })
        }
      })
    })
    const page = await context.newPage()
    const consoleRecords = recordConsole(page)
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.app-layout', { timeout: 90_000 })
    await page.waitForTimeout(8_000)

    const readState = (): Promise<{
      appLayout: boolean
      signInForm: boolean
      hash: string
      cloudCard: boolean
      fallbackCopy: boolean
      retryButton: boolean
      repoCount: number | null
      activeWorktreeId: string | null
      degradedToast: boolean
      sessionPersisted: boolean
    }> =>
      page.evaluate(() => {
        const storeState = window.__store?.getState?.() ?? null
        const card = document.querySelector('[data-worktree-sidebar-container]')
        return {
          appLayout: document.querySelector('.app-layout') !== null,
          signInForm: document.querySelector('#web-cloud-api-url') !== null,
          hash: window.location.hash,
          cloudCard: card !== null && card.querySelector('svg.lucide-cloud') !== null,
          fallbackCopy: (card?.textContent ?? '').includes(
            'The cloud workspace is not available in this client.'
          ),
          retryButton: (card?.textContent ?? '').includes('Retry'),
          repoCount: storeState?.repos?.length ?? null,
          activeWorktreeId: storeState?.activeWorktreeId ?? null,
          degradedToast: document.body.innerText.includes('Session restore failed'),
          sessionPersisted: window.localStorage.getItem('orca.webCloudSession') !== null
        }
      })

    const state = await readState()
    expect(state.appLayout, 'the workspace shell must stay mounted (no white screen)').toBe(true)
    expect(state.cloudCard, 'the sidebar must show the cloud card fallback, not a blank list').toBe(
      true
    )
    expect(state.fallbackCopy, 'the fallback must name the unavailable reason').toBe(true)
    expect(
      state.retryButton,
      'an unavailable client is not retryable, so no Retry button may render'
    ).toBe(false)
    expect(state.repoCount, 'a failed bootstrap must not register a repo row').toBe(0)
    expect(state.activeWorktreeId, 'a failed bootstrap must not activate a workspace').toBeNull()
    expect(state.signInForm, 'the session is valid, so no sign-in form may cover the app').toBe(
      false
    )
    expect(state.hash, 'the one-time code must still leave the address bar').toBe('')
    expect(state.sessionPersisted, 'the exchanged session itself is unaffected').toBe(true)
    expect(state.degradedToast, 'the W7c boot chain must not boot degraded').toBe(false)
    expect(cloudDenialLogs(consoleRecords), 'the fallback must stay off refused RPCs').toEqual([])

    // Why a second read: a crash-white-screen inside this window would still pass
    // the first snapshot; the fallback must be stable, not transient.
    await page.waitForTimeout(5_000)
    const settled = await readState()
    expect(settled.appLayout, 'the shell must still be mounted after the settle window').toBe(true)
    expect(settled.cloudCard, 'the fallback card must persist').toBe(true)

    await shoot(page, 'neg-1-workspace-info-unavailable-cloud-card')
    writeEvidence('neg-1-workspace-info-unavailable.json', {
      case: 'workspace.info unavailable → CloudSessionEmptyState fallback',
      injection: 'window.api.cloudWorkspace stripped before installWebPreloadApi assigns it',
      assertedState: settled,
      cloudDenialLogs: cloudDenialLogs(consoleRecords),
      consoleErrorWarningCount: consoleRecords.length
    })
    await context.close()
  } finally {
    await browser.close()
  }
})

test('W13c-2 neg-2: 配对（非云）web 会话不跑云 bootstrap，桌面启动链零变化', async () => {
  test.setTimeout(300_000)
  test.skip(
    process.env.ORCA_E2E_WEB_CLIENT !== '1',
    'Run with ORCA_E2E_WEB_CLIENT=1 so the paired web client is built'
  )
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost()
  let client: PairedWebClient | null = null
  try {
    // Why waitForWorkspace: false — the paired runtime ships zero repos here, so
    // the sidebar renders the native empty state and never the viewport listbox
    // that the helper waits for. The native empty state IS this case's oracle.
    client = await launchPairedWebClient(host.app, host.offer, { waitForWorkspace: false })
    const page = client.page
    const consoleRecords = recordConsole(page)
    await page.waitForSelector('[data-worktree-sidebar-container]', { timeout: 60_000 })
    await expect
      .poll(
        async () => page.evaluate(() => window.__store?.getState()?.workspaceSessionReady ?? null),
        {
          timeout: 60_000,
          message: 'the paired web boot chain must reach workspaceSessionReady'
        }
      )
      .toBe(true)

    // The sidebar read: the listing region is judged structurally (a
    // `[data-worktree-sidebar-container]` rendered, no `svg.lucide-cloud` inside
    // any of them) because the paired client speaks the hub's locale — the
    // empty-state copy is localized, so text oracles would be brittle. The empty
    // state's own copy stays in evidence via containerTexts.
    const readSidebar = (): Promise<{
      cloudCard: boolean
      containerCount: number
      containerTexts: string[]
    }> =>
      page.evaluate(() => {
        const containers = Array.from(
          document.querySelectorAll('[data-worktree-sidebar-container]')
        )
        return {
          cloudCard: containers.some((container) => container.querySelector('svg.lucide-cloud')),
          containerCount: containers.length,
          containerTexts: containers.map((container) => (container.textContent ?? '').slice(0, 120))
        }
      })

    // Why a poll: the paired client's catalog hydration can keep the sidebar in a
    // placeholder state long after workspaceSessionReady; what must hold is where
    // it lands, and that the W13 cloud card never shows up there.
    const settleStart = Date.now()
    let settled: Awaited<ReturnType<typeof readSidebar>> | null = null
    let lastRead: Awaited<ReturnType<typeof readSidebar>> | null = null
    while (Date.now() - settleStart < 45_000) {
      const state = await readSidebar()
      lastRead = state
      if (state.containerCount > 0 && !state.cloudCard) {
        settled = state
        break
      }
      await page.waitForTimeout(1_000)
    }
    if (settled === null) {
      // Why inline: the failure message is the fastest way to see what the page
      // actually held when the sidebar never settled.
      const where = await page.evaluate(() => ({
        href: window.location.href,
        title: document.title,
        appLayout: document.querySelector('.app-layout') !== null
      }))
      throw new Error(
        `the paired session never settled on the native empty sidebar; last=${JSON.stringify(lastRead)} where=${JSON.stringify(where)}`
      )
    }
    expect(settled?.cloudCard, 'the W13 cloud card must never light for a non-cloud session').toBe(
      false
    )
    // Why a second read: the card must stay absent across the settle window too.
    await page.waitForTimeout(5_000)
    const afterSettle = await readSidebar()
    expect(
      afterSettle.cloudCard,
      'the W13 cloud card must still be absent after the settle window'
    ).toBe(false)

    const rawEnvironment = await page.evaluate(() =>
      window.localStorage.getItem('orca.web.runtimeEnvironment.v1')
    )
    const storedEnvironment = rawEnvironment
      ? (JSON.parse(rawEnvironment) as { cloudLoginRequired?: boolean })
      : {}
    expect(
      storedEnvironment.cloudLoginRequired !== true,
      'the paired environment must not be a cloud (ticket) session'
    ).toBe(true)
    // The desktop-owned catalog RPC answers here — the discriminator against a
    // cloud session, where the same call is refused by design (W7c).
    const catalogReply = await page.evaluate(async () => {
      try {
        const repos = await window.api.repos.list()
        return { ok: true, count: Array.isArray(repos) ? repos.length : -1, error: null }
      } catch (error) {
        return { ok: false, count: null, error: String(error) }
      }
    })
    expect(catalogReply.ok, 'the paired session keeps the desktop catalog RPC').toBe(true)
    expect(
      await page.evaluate(() => window.__store?.getState()?.activeWorktreeId ?? null),
      'no cloud workspace activation may happen'
    ).toBeNull()
    // Why no degraded-toast text oracle here: the paired client speaks the hub's
    // locale, so the toast copy is localized; workspaceSessionReady plus the
    // answering catalog RPC are the locale-free proof the boot was not degraded.
    expect(cloudDenialLogs(consoleRecords), 'a paired session must hit no cloud refusals').toEqual(
      []
    )

    await shoot(page, 'neg-2-paired-web-no-cloud-bootstrap')
    writeEvidence('neg-2-paired-web-no-cloud-bootstrap.json', {
      case: 'paired (non-cloud) web session → bootstrap never runs, desktop chain unchanged',
      settledSidebar: settled,
      storedEnvironment,
      catalogReply,
      cloudDenialLogs: cloudDenialLogs(consoleRecords),
      consoleErrorWarningCount: consoleRecords.length
    })
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})

test('W13c-2 neg-3: handoff 票据缺失/无效 → 回落登录表单（W7b 语义不回归）', async () => {
  test.setTimeout(180_000)
  expect(stack, 'stack must have started').toBeTruthy()
  const session = stack!
  const minted = new URL(await mintEntryUrl(session.platform.url, session.projectId))
  const bareEntry = `${minted.origin}${minted.pathname}${minted.search}`
  const browser = await launchBrowser()
  try {
    // Missing ticket: no hash at all — the page has nothing to trade. No prefill
    // is expected here: the form's platform address comes only from a failed
    // handoff attempt (main.tsx hands `handoffFailure.apiUrl` to the form).
    const missingContext = await newProfile(browser)
    const missingPage = await missingContext.newPage()
    await missingPage.goto(bareEntry, { waitUntil: 'domcontentloaded' })
    await missingPage.waitForSelector('#web-cloud-api-url', { timeout: 30_000 })
    const missingState = await readSignInState(missingPage)
    expect(missingState.signInForm, 'a missing ticket must land on the sign-in form').toBe(true)
    expect(missingState.appLayout, 'no workspace may mount without a ticket').toBe(false)
    expect(missingState.sessionPersisted, 'no session may be stored without a ticket').toBe(false)
    await shoot(missingPage, 'neg-3a-handoff-missing-sign-in')
    await missingContext.close()

    // Invalid ticket: a code the platform never minted must redeem 410 and fall
    // back with the same sign-in semantics (W7b HANDOFF_GONE).
    const invalidContext = await newProfile(browser)
    const invalidPage = await invalidContext.newPage()
    await invalidPage.goto(`${bareEntry}#handoff=w13c2-no-such-code&project=${session.projectId}`, {
      waitUntil: 'domcontentloaded'
    })
    await invalidPage.waitForSelector('#web-cloud-api-url', { timeout: 30_000 })
    await expect
      .poll(async () => (await readSignInState(invalidPage)).prefilledApiUrl, {
        timeout: 10_000,
        message: 'the sign-in form never pre-filled the platform address'
      })
      .toBe(session.platform.url)
    await invalidPage.waitForTimeout(2_000)
    const invalidState = await readSignInState(invalidPage)
    const notice = await invalidPage.evaluate(() => document.body.innerText)
    expect(invalidState.signInForm, 'an invalid ticket must land on the sign-in form').toBe(true)
    expect(invalidState.appLayout, 'no workspace may mount for an invalid ticket').toBe(false)
    expect(invalidState.prefilledApiUrl, 'the form still pre-fills the platform address').toBe(
      session.platform.url
    )
    const noticeExplains =
      notice.includes('expired or was already used') ||
      notice.includes('could not be opened automatically')
    expect(noticeExplains, 'the entry must say why it fell back').toBe(true)
    expect(invalidState.hash, 'the bogus code must leave the address bar').toBe('')
    expect(invalidState.sessionPersisted, 'an invalid trade must not store a session').toBe(false)
    await shoot(invalidPage, 'neg-3b-handoff-invalid-sign-in')
    writeEvidence('neg-3-handoff-ticket-missing-or-invalid.json', {
      case: 'handoff ticket missing/invalid → sign-in form fallback (W7b semantics)',
      missing: missingState,
      invalid: invalidState,
      invalidNoticeExplains: noticeExplains
    })
    await invalidContext.close()
  } finally {
    await browser.close()
  }
})

function readSignInState(page: Page): Promise<{
  hash: string
  signInForm: boolean
  appLayout: boolean
  prefilledApiUrl: string
  sessionPersisted: boolean
}> {
  return page.evaluate(() => ({
    hash: window.location.hash,
    signInForm: document.querySelector('#web-cloud-api-url') !== null,
    appLayout: document.querySelector('.app-layout') !== null,
    prefilledApiUrl:
      (document.querySelector('#web-cloud-api-url') as HTMLInputElement | null)?.value ?? '',
    sessionPersisted: window.localStorage.getItem('orca.webCloudSession') !== null
  }))
}
