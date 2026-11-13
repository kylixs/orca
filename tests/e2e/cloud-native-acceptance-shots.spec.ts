import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  chromium,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import { closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import {
  adminTokenOf,
  cloudHostEnv,
  hostTokenOf,
  makeHostTls,
  readArray,
  readString,
  startCloudPlatform,
  waitForHostOnline,
  type CloudPlatform
} from './helpers/cloud-platform-stack'

/**
 * M113: the native half of the acceptance screenshots — the developer's own
 * window, not the admin web. Captured from the real stack: real platform, a real
 * host Orca instance serving TLS, a real client signing in. Hidden window; the
 * frames come off CDP, so nothing is ever shown on the user's screen.
 */

const HOST_NAME = 'dev-shots-001'
const PROJECT_NAME = 'payment-service'
const SHOTS = path.join(
  process.cwd(),
  'remote-connectivity',
  'design',
  '2026-11-13-cloud-dev-platform',
  'test-reports',
  'screenshots',
  'native'
)

type Stack = {
  platform: CloudPlatform
  host: ElectronApplication
  clientRoot: string
  clientEnv: Record<string, string>
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

async function launchOrca(
  extraEnv: Record<string, string>,
  userDataDir: string
): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
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
      // Why: the host and the client run under one OS login session.
      ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1'
    }
  })
}

async function startStack(): Promise<Stack> {
  // Why /tmp: macOS caps Unix socket paths at 104 bytes; deep TMPDIRs break the
  // runtime's RPC socket and the host then heartbeats an empty endpoint.
  const root = realpathSync(mkdtempSync('/tmp/m113-'))
  const projectsRoot = path.join(root, 'projects')
  const projectPath = path.join(projectsRoot, PROJECT_NAME)
  mkdirSync(projectPath, { recursive: true })
  git(projectPath, 'init', '-q', '-b', 'main')
  git(projectPath, 'config', 'user.email', 'e2e@example.com')
  git(projectPath, 'config', 'user.name', 'e2e')
  writeFileSync(path.join(projectPath, 'README.md'), 'hello\n')
  git(projectPath, 'add', '.')
  git(projectPath, 'commit', '-qm', 'init')

  const platform = await startCloudPlatform()
  const adminToken = await adminTokenOf(platform.url)
  const tls = makeHostTls(HOST_NAME)
  const host = await launchOrca(
    cloudHostEnv({
      platformUrl: platform.url,
      hostToken: await hostTokenOf(platform.url, adminToken),
      hostName: HOST_NAME,
      projectsRoot,
      tls: { certPath: tls.certPath, keyPath: tls.keyPath }
    }),
    mkdtempSync(path.join(root, 'host-ud-'))
  )
  await host.firstWindow({ timeout: 120_000 })
  const hostId = (await waitForHostOnline(platform.url, adminToken, HOST_NAME, 120_000)).id

  const created = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: `${PROJECT_NAME}-shots`,
      name: PROJECT_NAME,
      hostId,
      path: projectPath
    })
  })
  expect(created.status, await created.clone().text()).toBe(201)
  const projectId = readString(await created.json(), 'id') ?? ''
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

  const seedCleared = await fetch(`${platform.url}/v1/projects/proj_payment/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
  })
  expect(seedCleared.status).toBe(200)

  const clientProjects = path.join(root, 'client-projects')
  mkdirSync(clientProjects, { recursive: true })
  const clientEnv = cloudHostEnv({
    platformUrl: platform.url,
    hostToken: await hostTokenOf(platform.url, adminToken),
    hostName: `${HOST_NAME}-client`,
    projectsRoot: clientProjects,
    tls: { certPath: tls.certPath, keyPath: tls.keyPath }
  })
  return { platform, host, clientRoot: root, clientEnv }
}

async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

async function fillCredentials(page: Page): Promise<void> {
  const enabled = (): boolean =>
    !document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.fill('#cloud-username', 'zhangsan')
    await page.fill('#cloud-password', 'Passw0rd!')
    await page.waitForTimeout(100)
    if (await page.evaluate(enabled)) {
      return
    }
  }
  throw new Error('login form never became submittable')
}

let stack: Stack | null = null

test.beforeAll(async () => {
  stack = await startStack()
})

test.afterAll(async () => {
  if (stack) {
    await closeElectronAppForE2E(stack.host)
    await stack.platform.stop()
  }
})

test('M113-2 原生桌面：登录页、已登录工作区、连接诊断面板截图', async () => {
  test.setTimeout(600_000)
  const client = await launchOrca(
    stack!.clientEnv,
    mkdtempSync(path.join(stack!.clientRoot, 'client-'))
  )
  try {
    const page = await client.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('#cloud-username', { state: 'visible', timeout: 60_000 })
    await shoot(page, 'cloud-native-login')

    await fillCredentials(page)
    await page.click('button[type="submit"]')
    await page.waitForFunction(
      (name) => {
        const text = document.body.innerText
        return text.includes(name) && !text.includes(`${name}（`)
      },
      PROJECT_NAME,
      { timeout: 120_000 }
    )
    // Let entry settle (workspace registration, first paint) before framing; the
    // native shell has no cloud header — that lives on the admin session page.
    await page.waitForTimeout(2_000)
    await shoot(page, 'cloud-native-workspace')
  } finally {
    await closeElectronAppForE2E(client).catch(() => undefined)
  }

  // The route badge and the diagnostics panel belong to the admin session page
  // (cloud-admin.html, served by the host) — capture it in a real browser.
  const hostsBody: unknown = await (
    await fetch(`${stack!.platform.url}/v1/hosts`, {
      headers: { authorization: `Bearer ${await adminTokenOf(stack!.platform.url)}` }
    })
  ).json()
  const direct = readArray(
    (readArray(hostsBody, 'hosts') ?? []).find((entry) => readString(entry, 'name') === HOST_NAME),
    'directAddrs'
  )
  const hostPort = String(direct?.[0] ?? '').split(':')[1]

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true
    })
    const page = await context.newPage()
    await page.goto(`https://127.0.0.1:${hostPort}/cloud-admin.html?api=${stack!.platform.url}`, {
      waitUntil: 'domcontentloaded'
    })
    await page.waitForSelector('#cloud-username', { state: 'visible', timeout: 60_000 })
    await page.fill('#cloud-username', 'zhangsan')
    await page.fill('#cloud-password', 'Passw0rd!')
    await page.click('button[type="submit"]')
    await page.waitForSelector('[data-testid="cloud-route"]', { timeout: 120_000 })
    await page.waitForTimeout(1_000)
    await shoot(page, 'cloud-admin-session-workspace')
    await page.click('[data-testid="cloud-open-diagnostics"]')
    await page.waitForSelector('[data-testid="cloud-diagnostics-steps"]', { timeout: 15_000 })
    await shoot(page, 'cloud-admin-session-diagnostics')
    await context.close()
  } finally {
    await browser.close()
  }
})
