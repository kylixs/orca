import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type ElectronApplication } from '@stablyai/playwright-test'
import {
  firstWindowWithStartupGuard,
  launchElectronAppWithStartupGuard
} from './helpers/electron-startup-guard'
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
  startCloudPlatform,
  startTcpDelayHop,
  waitForHostOnline,
  type CloudPlatform,
  type TcpDelayHop
} from './helpers/cloud-platform-stack'
import {
  fillCloudLoginDialog,
  openCloudLoginDialog,
  submitCloudLoginDialog
} from './helpers/cloud-status-bar-sign-in'

/**
 * M107 (AC-01 / G-12 remainder): the developer's native window — not the admin
 * browser page — reaching an interactive workbench within 1.5s P95 needs a real
 * platform, a real host Orca instance and a real client Orca instance.
 *
 * The first run of this stack found the host serving plain `ws://` while the
 * platform hands out `wss://`, so a developer's projects failed with EPROTO.
 * M107-0 now proves the host serves TLS and publishes the certificate it serves;
 * M107-1 measures the sign-in to project-row budget on that stack, signing in
 * through the W11 status-bar segment dialog like a user does.
 */

const CLIENT_BUDGET_MS = 1_500
const SAMPLES = 20
const CONTROL_SAMPLES = 3
const INJECTED_DELAY_MS = 1_800
const HOST_NAME = 'dev-native-001'
const PROJECT_NAME = 'checkout-service'
const EVIDENCE = path.join(process.cwd(), 'cloud-platform', 'evidence', 'm107-native-first-paint')

type Stack = {
  platform: CloudPlatform
  adminToken: string
  host: ElectronApplication
  clientRoot: string
  clientEnv: Record<string, string>
  hostTls: { certPath: string; keyPath: string; fingerprint: string }
  hop: TcpDelayHop
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function createRepo(projectPath: string): void {
  mkdirSync(projectPath, { recursive: true })
  git(projectPath, 'init', '-q', '-b', 'main')
  git(projectPath, 'config', 'user.email', 'e2e@example.com')
  git(projectPath, 'config', 'user.name', 'e2e')
  writeFileSync(path.join(projectPath, 'README.md'), 'hello\n')
  git(projectPath, 'add', '.')
  git(projectPath, 'commit', '-qm', 'init')
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
  return launchElectronAppWithStartupGuard({
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

/** One host instance holding the project, plus a granted project on the platform. */
async function startStack(): Promise<Stack> {
  // Why /tmp: macOS caps Unix socket paths at 104 bytes and the runtime names its
  // RPC socket inside userData; a deep TMPDIR makes every launch fail with EINVAL.
  const root = realpathSync(mkdtempSync('/tmp/m107-'))
  const projectsRoot = path.join(root, 'projects')
  createRepo(path.join(projectsRoot, PROJECT_NAME))

  const platform = await startCloudPlatform()
  const adminToken = await adminTokenOf(platform.url)
  const hostToken = await hostTokenOf(platform.url, adminToken)
  const hostTls = makeHostTls(HOST_NAME)
  const host = await launchOrca(
    cloudHostEnv({
      platformUrl: platform.url,
      hostToken,
      hostName: HOST_NAME,
      projectsRoot,
      tls: { certPath: hostTls.certPath, keyPath: hostTls.keyPath }
    }),
    mkdtempSync(path.join(root, 'host-ud-'))
  )
  await firstWindowWithStartupGuard(host, { timeout: 120_000 })
  const hostId = (await waitForHostOnline(platform.url, adminToken, HOST_NAME, 120_000)).id

  const created = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      // Distinct from the seeded `payment-service` row, which no host serves.
      key: `${PROJECT_NAME}-e2e`,
      name: PROJECT_NAME,
      hostId,
      path: path.join(projectsRoot, PROJECT_NAME)
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

  // The platform seeds `proj_payment` on a host that does not exist; leaving it
  // granted would put an unrelated ENDPOINT_UNREACHABLE banner on every sample.
  const seedCleared = await fetch(`${platform.url}/v1/projects/proj_payment/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
  })
  expect(seedCleared.status, await seedCleared.clone().text()).toBe(200)

  // An Orca instance with a platform URL always acts as a host, so the developer's
  // own machine enrols too; the client gets its own credential, not the host's.
  const clientProjects = path.join(root, 'client-projects')
  mkdirSync(clientProjects, { recursive: true })
  // The client reaches the platform through a hop, so the control run can slow
  // every control-plane round trip the sign-in waits on.
  const hop = await startTcpDelayHop(platform.port)
  const clientEnv = cloudHostEnv({
    platformUrl: hop.url,
    hostToken: await hostTokenOf(platform.url, adminToken),
    hostName: `${HOST_NAME}-client`,
    projectsRoot: clientProjects
  })
  return { platform, adminToken, host, clientRoot: root, clientEnv, hostTls, hop }
}

async function stopStack(stack: Stack | null): Promise<void> {
  if (!stack) {
    return
  }
  await closeElectronAppForE2E(stack.host)
  await stack.hop.close()
  await stack.platform.stop()
}

/** Signs in on a fresh client instance and reports what the shell shows. */
async function signIn(
  stack: Stack,
  index: number
): Promise<{ elapsedMs: number; text: string; repos: string[] }> {
  const clientUserData = mkdtempSync(path.join(stack.clientRoot, `client-${index}-`))
  const app = await launchOrca(stack.clientEnv, clientUserData)
  try {
    const page = await firstWindowWithStartupGuard(app, { timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    // W11: sign-in lives in the status bar segment's dialog, not a full page.
    await openCloudLoginDialog(page)
    await fillCloudLoginDialog(page, { username: 'zhangsan', password: 'Passw0rd!' })
    const started = Date.now()
    await submitCloudLoginDialog(page, {
      displayName: DEVELOPER_DISPLAY_NAME,
      timeoutMs: 60_000
    })
    // User-visible signal: the project row is on screen. A failure banner names the
    // project with a trailing code in full-width parentheses, so that does not count.
    await page.waitForFunction(
      (name) => {
        const text = document.body.innerText
        return text.includes(name) && !text.includes(`${name}\uff08`)
      },
      PROJECT_NAME,
      { timeout: 60_000 }
    )
    const elapsedMs = Date.now() - started
    const state = await page.evaluate(() => ({
      text: document.body.innerText.slice(0, 600),
      repos: (window.__store?.getState().repos ?? []).map(
        (repo: { displayName?: string }) => repo.displayName ?? ''
      )
    }))
    return { elapsedMs, ...state }
  } finally {
    // Why best-effort: a failed sample must report its own error, not a teardown one.
    await closeElectronAppForE2E(app).catch(() => undefined)
  }
}

/**
 * The platform seed's profile for the developer account; the signed-in segment
 * shows it, which is how a sample knows the dialog round really signed in.
 */
const DEVELOPER_DISPLAY_NAME = '张伟'

let stack: Stack | null = null

test.beforeAll(async () => {
  stack = await startStack()
})

test.afterAll(async () => {
  await stopStack(stack)
})

test('M107-0 宿主以 TLS 提供运行时监听并上报证书指纹；明文 ws 连不上', async () => {
  test.setTimeout(240_000)
  const hostsBody: unknown = await (
    await fetch(`${stack!.platform.url}/v1/hosts`, {
      headers: { authorization: `Bearer ${stack!.adminToken}` }
    })
  ).json()
  const host = (readArray(hostsBody, 'hosts') ?? []).find(
    (entry) => readString(entry, 'name') === HOST_NAME
  )
  const directAddrs = readArray(host, 'directAddrs') ?? []
  const reportedFingerprint = readString(host, 'tlsFingerprint') ?? ''
  expect(readField(host, 'online')).toBe(true)
  expect(directAddrs.length).toBeGreaterThan(0)
  expect((readString(host, 'e2eePublicKey') ?? '').length).toBeGreaterThan(0)
  // The platform publishes exactly the certificate the host is serving.
  expect(reportedFingerprint).toBe(stack!.hostTls.fingerprint)

  // The listener really is TLS: a plain `ws://` upgrade dies at the handshake,
  // which is what made the native client fail with EPROTO before this change.
  const [hostName, port] = String(directAddrs[0]).split(':')
  const plainRefusal = await new Promise<string>((resolve) => {
    const socket = new WebSocket(`ws://${hostName}:${port}/`)
    socket.onopen = () => {
      socket.close()
      resolve('opened')
    }
    socket.onerror = () => resolve('refused')
  })
  expect(plainRefusal).toBe('refused')

  saveEvidence({
    host: { name: HOST_NAME, directAddrs, tlsFingerprint: reportedFingerprint },
    platformHandsClient: `wss://${String(directAddrs[0])}`,
    plainWsRefused: plainRefusal === 'refused'
  })
})

test('M107-1 原生客户端登录到项目可见 P95 ≤ 1.5s（真实平台 + 真实宿主 + TLS）', async () => {
  test.setTimeout(900_000)
  const samples: number[] = []
  for (let index = 1; index <= SAMPLES; index += 1) {
    const sample = await signIn(stack!, index)
    expect(sample.text, sample.text).toContain(PROJECT_NAME)
    if (process.env.ORCA_E2E_CLOUD_DEBUG === '1') {
      console.log('[m107] sample', JSON.stringify(sample))
    }
    samples.push(sample.elapsedMs)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] ?? Number.POSITIVE_INFINITY
  expect(p95).toBeLessThanOrEqual(CLIENT_BUDGET_MS)

  // Sensitivity control: the same measurement must notice a slow backend.
  stack!.hop.setDelayMs(INJECTED_DELAY_MS)
  const slow: number[] = []
  for (let index = 0; index < CONTROL_SAMPLES; index += 1) {
    slow.push((await signIn(stack!, SAMPLES + index + 1)).elapsedMs)
  }
  stack!.hop.setDelayMs(0)
  const slowSorted = [...slow].sort((a, b) => a - b)
  const slowP95 = slowSorted[Math.ceil(0.95 * slowSorted.length) - 1] ?? 0
  expect(slowP95).toBeGreaterThan(CLIENT_BUDGET_MS)

  saveEvidenceP95({
    samples,
    p95,
    control: { delayMs: INJECTED_DELAY_MS, samples: slow, p95: slowP95 }
  })
})

function saveEvidence(content: unknown): void {
  mkdirSync(EVIDENCE, { recursive: true })
  writeFileSync(path.join(EVIDENCE, 'host-tls.json'), JSON.stringify(content, null, 2))
}

function saveEvidenceP95(content: {
  samples: number[]
  p95: number
  control: { delayMs: number; samples: number[]; p95: number }
}): void {
  mkdirSync(EVIDENCE, { recursive: true })
  writeFileSync(
    path.join(EVIDENCE, 'native-first-paint.json'),
    JSON.stringify({ budgetMs: CLIENT_BUDGET_MS, ...content }, null, 2)
  )
}
