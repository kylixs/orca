import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import { closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import {
  adminTokenOf,
  cloudClientEnv,
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
import { ensureTerminalVisible } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { clickFileInExplorer, openFileExplorer } from './helpers/file-explorer'
import {
  fillCloudLoginDialog,
  openCloudLoginDialog,
  submitCloudLoginDialog
} from './helpers/cloud-status-bar-sign-in'

/**
 * W9a: the desktop golden journey (business-chain-tests §1, line A) as one
 * continuous run against real processes — the platform API, a real Orca host
 * (TLS + PTY + projectsRoot) and a real client signing in. The admin half is
 * the C3/C4/C5 chain the journey depends on, driven over the platform API the
 * same way the install wizard and the admin console drive it.
 *
 * Sign-in follows the W11 user path: the workspace shell lands first and the
 * status bar's cloud segment opens the sign-in dialog — there is no full-page
 * login takeover any more.
 *
 * Every step is timed into a timeline JSON and key moments are screenshotted,
 * so a run leaves `cloud-platform/evidence/journey-golden-a/` behind.
 */

const HOST_NAME = 'journey-a-host'
const PROJECT_KEY = 'journey-payment'
const PROJECT_NAME = 'journey-payment'
const DEVELOPER = 'zhangsan'
/** The platform seed's profile for the developer account; the signed-in segment shows it. */
const DEVELOPER_DISPLAY_NAME = '张伟'
const PASSWORD = 'Passw0rd!'
const RUN_MARKER = `orca-journey-${Date.now()}`
const FILE_NAME = 'journey-note.txt'
const FILE_MARKER = `${RUN_MARKER}-file`
/** First open provisions the checkout on a real host; a cold host can be slow. */
const CHECKOUT_TIMEOUT_MS = 180_000

const EVIDENCE_DIR =
  process.env.ORCA_JOURNEY_GOLDEN_A_EVIDENCE_DIR ??
  path.join(process.cwd(), 'cloud-platform', 'evidence', 'journey-golden-a')

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
      line: 'A-desktop',
      workOrder: 'W9a',
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

type HostRecord = {
  hostId: string
  directAddr: string
  tlsFingerprint: string
  app: ElectronApplication
}

type OpenedProject = {
  projectId: string
  repoExecutionHostId: string | null
  activeWorktreePath: string | null
  open: {
    ok: boolean
    route: string | null
    connectDiagnostics: unknown
  } | null
}

type Stack = {
  platform: CloudPlatform
  host: ElectronApplication
  root: string
  projectPath: string
  projectId: string
  hostDirectAddr: string
  hostTlsFingerprint: string
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

async function launchOrca(
  extraEnv: Record<string, string>,
  userDataDir: string,
  options: { completedOnboarding?: boolean } = {}
): Promise<ElectronApplication> {
  if (options.completedOnboarding) {
    // The developer's machine has Orca set up already: the first-run wizard
    // must not cover the workspace the journey drives.
    writeFileSync(
      path.join(userDataDir, 'orca-data.json'),
      `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
    )
  }
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

let stack: Stack | null = null

test.beforeAll(async () => {
  // Why /tmp: macOS caps Unix socket paths at 104 bytes; deep TMPDIRs break the
  // runtime's RPC socket and the host then heartbeats an empty endpoint.
  const root = realpathSync(mkdtempSync('/tmp/w9a-journey-'))
  const projectsRoot = path.join(root, 'projects')
  const projectPath = path.join(projectsRoot, PROJECT_NAME)
  mkdirSync(projectPath, { recursive: true })
  git(projectPath, 'init', '-q', '-b', 'main')
  git(projectPath, 'config', 'user.email', 'e2e@example.com')
  git(projectPath, 'config', 'user.name', 'e2e')
  writeFileSync(path.join(projectPath, 'README.md'), '# journey-payment\n')
  writeFileSync(path.join(projectPath, FILE_NAME), `${FILE_MARKER}\n`)
  mkdirSync(path.join(projectPath, 'src'), { recursive: true })
  writeFileSync(path.join(projectPath, 'src', 'main.ts'), 'export const main = 1\n')
  git(projectPath, 'add', '.')
  git(projectPath, 'commit', '-qm', 'init')

  const admin = await journeyStep('S0-platform', '平台进程启动与管理员登录', async () => {
    const platform = await startCloudPlatform()
    return { platform, adminToken: await adminTokenOf(platform.url) }
  })
  const { platform, adminToken } = admin

  const enrolled = await journeyStep(
    'S1-host-enrol',
    '宿主注册：令牌换取、TLS 上线，直连地址/E2EE 密钥/指纹齐备',
    async (): Promise<HostRecord> => {
      const tls = makeHostTls(HOST_NAME)
      const app = await launchOrca(
        cloudHostEnv({
          platformUrl: platform.url,
          hostToken: await hostTokenOf(platform.url, adminToken),
          hostName: HOST_NAME,
          projectsRoot,
          tls: { certPath: tls.certPath, keyPath: tls.keyPath }
        }),
        mkdtempSync(path.join(root, 'host-ud-'))
      )
      await app.firstWindow({ timeout: 120_000 })
      await waitForHostOnline(platform.url, adminToken, HOST_NAME, 120_000)
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
      const e2eeKey = readString(record, 'e2eePublicKey') ?? ''
      expect(e2eeKey.length, 'e2eePublicKey must not be empty').toBeGreaterThan(0)
      const tlsFingerprint = readString(record, 'tlsFingerprint') ?? ''
      expect(tlsFingerprint.length, 'tlsFingerprint must not be empty').toBeGreaterThan(0)
      return {
        hostId: readString(record, 'id') ?? '',
        directAddr: directAddrs[0] ?? '',
        tlsFingerprint,
        app
      }
    },
    (result) => ({
      hostId: result.hostId,
      directAddr: result.directAddr,
      tlsFingerprint: result.tlsFingerprint
    })
  )

  const projectId = await journeyStep(
    'S2-project-grant',
    '管理员建项目（绑定宿主）并授权 team-payment 组',
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
      // journey's own, so the entry opens ours.
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
    host: enrolled.app,
    root,
    projectPath,
    projectId,
    hostDirectAddr: enrolled.directAddr,
    hostTlsFingerprint: enrolled.tlsFingerprint
  }
})

test.afterAll(async () => {
  if (stack) {
    await closeElectronAppForE2E(stack.host).catch(() => undefined)
    await stack.platform.stop()
  }
  writeEvidence('journey-timeline.json', {
    line: 'A-desktop',
    workOrder: 'W9a',
    runMarker: RUN_MARKER,
    generatedAt: new Date().toISOString(),
    steps: timeline,
    screenshots: shots
  })
})

test('W9a 桌面黄金旅程：登录 → 打开项目（直连）→ 终端 → 文件树', async () => {
  test.setTimeout(600_000)
  expect(stack, 'stack must have started').toBeTruthy()
  const session = stack!

  // ── A2 · 开发者登录（W11：状态栏 segment → 弹框）───────────────────
  const entered = await journeyStep(
    'A2-login',
    '开发者登录（状态栏「登录云端平台」segment → 弹框，平台地址预填）',
    async () => {
      const client = await launchOrca(
        cloudClientEnv(session.platform.url),
        mkdtempSync(path.join(session.root, 'client-ud-')),
        { completedOnboarding: true }
      )
      const page = await client.firstWindow({ timeout: 120_000 })
      await page.waitForLoadState('domcontentloaded')
      // W11: the workspace shell lands first; the sign-in dialog hangs off the
      // status bar segment, and the address comes from the runtime login context.
      const shownAddress = await openCloudLoginDialog(page)
      expect(shownAddress, 'platform address must be prefilled from the runtime env').toBe(
        session.platform.url
      )
      await shoot(page, '01-login-dialog')
      await fillCloudLoginDialog(page, { username: DEVELOPER, password: PASSWORD })
      await submitCloudLoginDialog(page, { displayName: DEVELOPER_DISPLAY_NAME })
      await shoot(page, '02-signed-in')
      return { client, page }
    },
    () => ({
      platformUrl: session.platform.url,
      developer: DEVELOPER,
      entry: 'status-bar-segment-dialog'
    })
  )
  const { client, page } = entered

  try {
    // ── A3 · 打开项目（工作区 + 直连线路）────────────────────────────
    await journeyStep(
      'A3-open-project',
      '打开项目：工作区落在本人 checkout，线路为直连',
      async (): Promise<OpenedProject> => {
        // The entry registers every project as a repo, opens the first one and
        // activates the checkout it created; wait for the checkout itself, not
        // just for any worktree row.
        const checkoutActivated = (): Promise<boolean> =>
          page.evaluate(
            ({ projectPath, developer }) => {
              const state = window.__store?.getState()
              const activeWorktreeId = state?.activeWorktreeId ?? null
              const worktree = Object.values(state?.worktreesByRepo ?? {})
                .flat()
                .find((entry) => entry.id === activeWorktreeId)
              const path = typeof worktree?.path === 'string' ? worktree.path : null
              return Boolean(path?.includes(`${projectPath}/.orca-worktrees/${developer}`))
            },
            { projectPath: session.projectPath, developer: DEVELOPER }
          )
        try {
          await expect
            .poll(checkoutActivated, {
              timeout: CHECKOUT_TIMEOUT_MS,
              message: 'the client never activated the per-user checkout of the project'
            })
            .toBe(true)
        } catch (error) {
          // A red journey must hand over the store state that failed to
          // converge: that state is the integration finding.
          const clientState = await page
            .evaluate(() => {
              const state = window.__store?.getState()
              return {
                repos: (state?.repos ?? []).map((repo) => ({
                  path: repo.path,
                  executionHostId: repo.executionHostId
                })),
                activeWorktreeId: state?.activeWorktreeId,
                worktreeKeys: Object.keys(state?.worktreesByRepo ?? {})
              }
            })
            .catch(() => null)
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; client store: ${JSON.stringify(clientState)}`
          )
        }
        const result = await page.evaluate(
          async ({ projectKey, projectPath }) => {
            type CloudBridge = {
              listProjects: () => Promise<Record<string, unknown>[]>
              openProject: (id: string) => Promise<Record<string, unknown>>
            }
            const bridge = (window as unknown as { api?: { cloud?: CloudBridge } }).api?.cloud
            if (!bridge) {
              throw new Error('cloud bridge missing on the client')
            }
            const projects = await bridge.listProjects()
            const project = projects.find((entry) => entry.key === projectKey)
            if (!project) {
              throw new Error(`project ${projectKey} not in the signed-in project list`)
            }
            const state = window.__store?.getState()
            const repo = (state?.repos ?? []).find((entry) => entry.path === projectPath)
            const activeWorktreeId = state?.activeWorktreeId ?? null
            const worktree = Object.values(state?.worktreesByRepo ?? {})
              .flat()
              .find((entry) => entry.id === activeWorktreeId)
            const open = await bridge.openProject(String(project.id))
            return {
              projectId: String(project.id),
              repoExecutionHostId:
                typeof repo?.executionHostId === 'string' ? repo.executionHostId : null,
              activeWorktreePath: typeof worktree?.path === 'string' ? worktree.path : null,
              open: {
                ok: open.ok === true,
                route: typeof open.route === 'string' ? open.route : null,
                connectDiagnostics: open.connectDiagnostics ?? null
              }
            }
          },
          { projectKey: PROJECT_KEY, projectPath: session.projectPath }
        )
        expect(result.repoExecutionHostId, 'repo must be runtime-backed').toMatch(/^runtime:/)
        expect(
          result.activeWorktreePath,
          'the opened workspace must be the per-user checkout under the project'
        ).toContain(`${PROJECT_NAME}/.orca-worktrees/${DEVELOPER}`)
        expect(result.open?.ok, JSON.stringify(result.open)).toBe(true)
        expect(result.open?.route, 'the chosen line must be direct').toBe('direct')
        expect(
          Array.isArray((result.open?.connectDiagnostics as { probes?: unknown[] })?.probes),
          'connect diagnostics must carry the probe list'
        ).toBe(true)
        // W9A-1 regression: the row appeared and vanished moments after sign-in
        // once the startup catalog load pruned it — it has to survive the settle.
        await page.waitForTimeout(2_000)
        expect(
          await page.evaluate(
            (projectPath) =>
              (window.__store?.getState()?.repos ?? []).some((repo) => repo.path === projectPath),
            session.projectPath
          ),
          'the cloud project row must survive the post-open settle window'
        ).toBe(true)
        await shoot(page, '02-workspace-opened')
        return result
      },
      (result) => ({
        projectId: result.projectId,
        repoExecutionHostId: result.repoExecutionHostId,
        workspacePath: result.activeWorktreePath,
        route: result.open?.route,
        probes: result.open?.connectDiagnostics
      })
    )

    // ── A4 · 终端输入与回显 ─────────────────────────────────────────
    await journeyStep(
      'A4-terminal',
      '终端输入 echo orca-journey && ls，断言回显与输出',
      async () => {
        await ensureTerminalVisible(page, 30_000)
        await waitForActiveTerminalManager(page, 30_000)
        const ptyId = await waitForActivePanePtyId(page, 60_000)
        const bound = await page.evaluate((id) => window.api.pty.hasPty(id), ptyId)
        expect(bound, 'the pane must hold a live PTY binding').toBe(true)
        await focusActiveTerminalInput(page)
        const sentAt = Date.now()
        await page.keyboard.type(`echo ${RUN_MARKER} && ls`)
        await page.keyboard.press('Enter')
        let outputMs = -1
        await expect
          .poll(
            async () => {
              const content = await getTerminalContent(page, 8000)
              if (content.includes(FILE_NAME) && content.includes('README.md') && outputMs < 0) {
                outputMs = Date.now() - sentAt
              }
              return content.includes(FILE_NAME) && content.includes('README.md')
            },
            { timeout: 60_000, message: 'ls output never reached the pane' }
          )
          .toBe(true)
        const content = await getTerminalContent(page, 8000)
        expect(
          content.split(RUN_MARKER).length - 1,
          'the marker must appear in the echoed command and in its output'
        ).toBeGreaterThanOrEqual(2)
        await shoot(page, '03-terminal-output')
        return { ptyId, outputMs }
      },
      (result) => ({ ptyId: result.ptyId, commandOutputMs: result.outputMs })
    )

    // ── A5 · 文件树浏览并打开文件 ────────────────────────────────────
    await journeyStep(
      'A5-file-tree',
      '文件树浏览 → 打开文件 → 内容断言',
      async () => {
        await openFileExplorer(page)
        await expect(page.locator('[data-orca-explorer-shell]')).toBeVisible({ timeout: 15_000 })
        await expect
          .poll(
            async () =>
              (await page.locator('[data-orca-explorer-shell]').innerText()).includes(FILE_NAME),
            { timeout: 30_000, message: 'the explorer tree never listed the seeded file' }
          )
          .toBe(true)
        const clicked = await clickFileInExplorer(page, [FILE_NAME])
        expect(clicked, 'the seeded file must be openable').not.toBeNull()
        await expect
          .poll(
            async () => page.evaluate(() => window.__store?.getState()?.activeTabType ?? null),
            {
              timeout: 15_000
            }
          )
          .toBe('editor')
        await expect(page.locator('.editor-header-path').first()).toContainText(FILE_NAME, {
          timeout: 30_000
        })
        await expect
          .poll(
            async () => page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail ?? ''),
            { timeout: 30_000, message: 'editor never rendered the file content' }
          )
          .toBe(FILE_MARKER)
        await shoot(page, '04-file-opened')
        return { file: FILE_NAME }
      },
      (result) => ({ file: result.file, expectedContent: FILE_MARKER })
    )

    // ── A6 · 旅程证据落盘（时间线 + 关键截图）────────────────────────
    await journeyStep(
      'A6-evidence',
      '旅程证据落盘：时间线与关键截图齐备',
      async () => {
        const missing = shots.filter((name) => !existsSync(path.join(EVIDENCE_DIR, name)))
        expect(missing, `screenshots missing on disk: ${missing.join(', ')}`).toEqual([])
        return { screenshots: shots.length, timelineSteps: timeline.length }
      },
      (result) => result
    )
  } finally {
    await closeElectronAppForE2E(client).catch(() => undefined)
  }
})
