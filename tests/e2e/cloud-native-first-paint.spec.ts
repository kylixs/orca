import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication
} from '@stablyai/playwright-test'
import { closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import {
  adminTokenOf,
  cloudHostEnv,
  hostTokenOf,
  readArray,
  readField,
  readString,
  startCloudPlatform,
  waitForHostOnline,
  type CloudPlatform
} from './helpers/cloud-platform-stack'

/**
 * M107 (AC-01 / G-12 remainder): the developer's native window — not the admin
 * browser page — reaching an interactive workbench within 1.5s P95 needs a real
 * platform, a real host Orca instance and a real client Orca instance.
 *
 * This spec stands that stack up for real and records what it finds: the host
 * enrols and reports its runtime endpoint, but the platform hands clients a
 * `wss://` URL for a port the host serves as plain `ws://`. A developer signing
 * in therefore gets `EPROTO` on the project and no workspace row, so the budget
 * cannot be measured until the host serves TLS (design §5.3 requires TLS for
 * every credential-carrying upgrade, internal networks included).
 */

const CLIENT_BUDGET_MS = 1_500
const SAMPLES = 20
const HOST_NAME = 'dev-native-001'
const PROJECT_NAME = 'payment-service'
const EVIDENCE = path.join(process.cwd(), 'cloud-platform', 'evidence', 'm107-native-first-paint')

type Stack = {
  platform: CloudPlatform
  adminToken: string
  host: ElectronApplication
  clientRoot: string
  clientEnv: Record<string, string>
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
  const host = await launchOrca(
    cloudHostEnv({ platformUrl: platform.url, hostToken, hostName: HOST_NAME, projectsRoot }),
    mkdtempSync(path.join(root, 'host-ud-'))
  )
  await host.firstWindow({ timeout: 120_000 })
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

  // An Orca instance with a platform URL always acts as a host, so the developer's
  // own machine enrols too; the client gets its own credential, not the host's.
  const clientProjects = path.join(root, 'client-projects')
  mkdirSync(clientProjects, { recursive: true })
  const clientEnv = cloudHostEnv({
    platformUrl: platform.url,
    hostToken: await hostTokenOf(platform.url, adminToken),
    hostName: `${HOST_NAME}-client`,
    projectsRoot: clientProjects
  })
  return { platform, adminToken, host, clientRoot: root, clientEnv }
}

async function stopStack(stack: Stack | null): Promise<void> {
  if (!stack) {
    return
  }
  await closeElectronAppForE2E(stack.host)
  await stack.platform.stop()
}

/** Signs in on a fresh client instance and reports what the shell shows. */
async function signIn(
  stack: Stack,
  index: number,
  waitForRepo: boolean
): Promise<{ elapsedMs: number; text: string; repos: string[] }> {
  const clientUserData = mkdtempSync(path.join(stack.clientRoot, `client-${index}-`))
  const app = await launchOrca(stack.clientEnv, clientUserData)
  try {
    const page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('#cloud-username', { state: 'visible', timeout: 60_000 })
    await page.fill('#cloud-username', 'zhangsan')
    await page.fill('#cloud-password', 'Passw0rd!')
    const started = Date.now()
    await page.click('button[type="submit"]')
    const ready = waitForRepo
    await (ready
      ? page.waitForFunction(
          (name) =>
            Boolean(
              window.__store
                ?.getState()
                .repos.some((repo: { displayName?: string }) => repo.displayName === name)
            ),
          PROJECT_NAME,
          { timeout: 60_000 }
        )
      : // Without a host row to wait for, the entry attempt settling is the signal.
        page.waitForFunction(
          () =>
            document.body.innerText.includes('准备失败') ||
            document.body.innerText.includes('重试'),
          undefined,
          { timeout: 60_000 }
        ))
    void ready
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

let stack: Stack | null = null

test.beforeAll(async () => {
  stack = await startStack()
})

test.afterAll(async () => {
  await stopStack(stack)
})

test('M107-0 原生宿主上线并上报运行时端点；平台下发的 wss 与宿主的 ws 不一致（阻塞记录）', async () => {
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
  expect(readField(host, 'online')).toBe(true)
  expect(directAddrs.length).toBeGreaterThan(0)
  expect((readString(host, 'e2eePublicKey') ?? '').length).toBeGreaterThan(0)

  const first = await signIn(stack!, 0, false)
  saveEvidence({
    host: { name: HOST_NAME, online: readField(host, 'online'), directAddrs },
    platformHandsClient: `wss://${String(directAddrs[0] ?? '')}`,
    clientText: first.text,
    clientRepos: first.repos,
    observation:
      'The host runtime WS listener is plain ws://; the platform always builds wss://, so the client fails TLS (EPROTO) and never registers the project.',
    blockedBudgetMs: CLIENT_BUDGET_MS
  })
  // The failure is the point of this record; silent success would mean the gap closed.
  expect(first.text).toMatch(/EPROTO|准备失败/)
  expect(first.repos).toEqual([])
})

test.fixme('M107-1 原生客户端登录到项目可见 P95 ≤ 1.5s（待宿主提供 TLS）', async () => {
  test.setTimeout(600_000)
  const samples: number[] = []
  for (let index = 1; index <= SAMPLES; index += 1) {
    const sample = await signIn(stack!, index, true)
    expect(sample.repos).toContain(PROJECT_NAME)
    samples.push(sample.elapsedMs)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] ?? Number.POSITIVE_INFINITY
  saveEvidenceP95({ samples, p95 })
  expect(p95).toBeLessThanOrEqual(CLIENT_BUDGET_MS)
})

function saveEvidence(content: unknown): void {
  mkdirSync(EVIDENCE, { recursive: true })
  writeFileSync(
    path.join(EVIDENCE, 'native-first-paint-blocked.json'),
    JSON.stringify(content, null, 2)
  )
}

function saveEvidenceP95(content: { samples: number[]; p95: number }): void {
  mkdirSync(EVIDENCE, { recursive: true })
  writeFileSync(
    path.join(EVIDENCE, 'native-first-paint.json'),
    JSON.stringify({ budgetMs: CLIENT_BUDGET_MS, ...content }, null, 2)
  )
}
