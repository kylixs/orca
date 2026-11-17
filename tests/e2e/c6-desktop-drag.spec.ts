/**
 * C6 manual-acceptance spot check: cloud session tab drag + group reorder on a
 * paired desktop client. The oracle is the runtime's paired-session inventory
 * (`session.tabs.list`, which `session.tabs.move` updates); the window.__store
 * shortcut is deliberately not used.
 *
 * Run against a prebuilt production bundle with SKIP_BUILD=1; `pnpm test:e2e`
 * rebuilds in e2e mode, which is recorded in the report flavor.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
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
  readString,
  startCloudPlatform,
  waitForHostOnline,
  type CloudPlatform
} from './helpers/cloud-platform-stack'
import {
  fillCloudLoginDialog,
  openCloudLoginDialog,
  submitCloudLoginDialog
} from './helpers/cloud-status-bar-sign-in'

const HOST_NAME = 'c6-drag-host'
const PROJECT_KEY = 'c6-drag-project'
const DEVELOPER = 'zhangsan'
const DEVELOPER_DISPLAY_NAME = '张伟'
const PASSWORD = 'Passw0rd!'
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const EVIDENCE_DIR =
  process.env.ORCA_C6_EVIDENCE_DIR ??
  path.join(process.cwd(), 'cloud-platform', 'evidence', `c6-desktop-drag-${STAMP}`)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  build: {
    entry: path.join(process.cwd(), 'out', 'main', 'index.js'),
    // Why: the flavor is measured, not declared — `pnpm test:e2e` builds in e2e
    // mode (VITE_EXPOSE_STORE) while SKIP_BUILD=1 uses whatever is in `out/`.
    flavor: process.env.SKIP_BUILD === '1' ? 'prebuilt (SKIP_BUILD=1)' : 'e2e (globalSetup build)',
    rebuilt: process.env.ORCA_C6_REBUILT === '1'
  },
  steps: []
}

function writeEvidence(name: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(path.join(EVIDENCE_DIR, name), `${JSON.stringify(content, null, 2)}\n`)
}

function step<T>(name: string, body: () => Promise<T>): Promise<T> {
  const started = Date.now()
  return body().then(
    (result) => {
      ;(report.steps as unknown[]).push({ name, ok: true, ms: Date.now() - started })
      writeEvidence('c6-report.json', report)
      return result
    },
    (error) => {
      ;(report.steps as unknown[]).push({
        name,
        ok: false,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error)
      })
      writeEvidence('c6-report.json', report)
      throw error
    }
  )
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
      ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1'
    }
  })
}

async function dismissOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    if ((await page.locator('[data-slot="dialog-overlay"][data-state="open"]').count()) === 0) {
      return
    }
    const gotIt = page
      .getByRole('button', { name: /^(Got it|知道了|跳过|Skip|Continue|继续)$/i })
      .first()
    await (
      (await gotIt.count()) > 0 ? gotIt.click({ timeout: 3000 }) : page.keyboard.press('Escape')
    ).catch(() => {})
    await sleep(400)
  }
}

const domStrips = (
  page: Page
): Promise<
  { stripHostGroupId: string | null; worktreeId: string | null; tabs: (string | null)[] }[]
> =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-tab-group-strip-id]')].map((strip) => ({
      stripHostGroupId: strip.getAttribute('data-tab-group-strip-id'),
      worktreeId: strip.getAttribute('data-worktree-id'),
      tabs: [...strip.querySelectorAll('[data-tab-id]')].map((t) => t.getAttribute('data-tab-id'))
    }))
  )

const domBodies = (
  page: Page
): Promise<
  {
    bodyGroupId: string | null
    worktreeId: string | null
    x: number
    y: number
    w: number
    h: number
  }[]
> =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-tab-group-body-id]')].map((el) => {
      const r = el.getBoundingClientRect()
      return {
        bodyGroupId: el.getAttribute('data-tab-group-body-id'),
        worktreeId: el.getAttribute('data-worktree-id'),
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height
      }
    })
  )

async function splitRight(page: Page, tabId: string): Promise<void> {
  const tab = page.locator(`[data-tab-id="${tabId}"]`).first()
  const box = (await tab.boundingBox())!
  await tab.dispatchEvent('contextmenu', {
    button: 2,
    clientX: box.x + 10,
    clientY: box.y + box.height / 2
  })
  const menu = page.getByRole('menuitem', { name: /Move Tab to Split|将标签页移至拆分/i }).first()
  await menu.waitFor({ timeout: 10_000 })
  await menu.hover()
  await page
    .getByRole('menuitem', { name: /^(Right|右)$/ })
    .first()
    .click({ timeout: 10_000 })
}

async function dragTo(
  page: Page,
  sourceTabId: string,
  target: { x: number; y: number }
): Promise<void> {
  const src = page.locator(`[data-tab-id="${sourceTabId}"]`).first()
  const sb = (await src.boundingBox())!
  const sx = sb.x + Math.min(12, sb.width / 2)
  const sy = sb.y + sb.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  for (let i = 1; i <= 24; i += 1) {
    await page.mouse.move(sx + ((target.x - sx) * i) / 24, sy + ((target.y - sy) * i) / 24, {
      steps: 4
    })
    await sleep(55)
  }
  await sleep(350)
  await page.mouse.move(target.x, target.y)
  await sleep(200)
  await page.mouse.up()
  await sleep(600)
  report.dragDispatched = true
}

function readSessionTabs(
  page: Page,
  worktreeId: string
): Promise<{
  activeGroupId: string | null
  tabGroups: { id: string; tabOrder: string[] }[]
  tabs: { parentTabId?: string; tabId?: string; title?: string }[]
}> {
  return page.evaluate(async (wt) => {
    const response = await window.api.runtime.call({
      method: 'session.tabs.list',
      params: { worktree: `id:${wt}` }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result as unknown as {
      activeGroupId: string | null
      tabGroups: { id: string; tabOrder: string[] }[]
      tabs: { parentTabId?: string; tabId?: string; title?: string }[]
    }
  }, worktreeId)
}

const snapToasts = (page: Page): Promise<{ type: string | null; text: string }[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-sonner-toast]')]
      .filter((el) => {
        // Why: sonner keeps exiting nodes in the DOM; counting them reported
        // toasts that were no longer on screen.
        if (el.getAttribute('data-removed') === 'true') {
          return false
        }
        if (el.getAttribute('data-visible') === 'false') {
          return false
        }
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      .map((el) => ({
        type: el.getAttribute('data-type'),
        text: (el as HTMLElement).innerText
      }))
  )

async function recordToastStage(page: Page, stage: string): Promise<void> {
  const seen = (report.toastsByStage as Record<string, unknown>) ?? {}
  seen[stage] = await snapToasts(page)
  report.toastsByStage = seen
  writeEvidence('c6-report.json', report)
}

const tabMatches = (hostId: string | null | undefined, domTabId: string): boolean =>
  Boolean(hostId) && (hostId === domTabId || hostId!.replace(/^web-terminal-/, '') === domTabId)

/** Host ids may carry the web-terminal prefix/encoding; DOM ids are canonical. */
const normalizeOrder = (ids: readonly (string | null)[]): string[] =>
  ids.map((id) => {
    if (!id) {
      return ''
    }
    const stripped = id.replace(/^web-terminal-/, '')
    try {
      return decodeURIComponent(stripped)
    } catch {
      return stripped
    }
  })

test('C6 desktop: drag a cloud session tab across groups (paired client)', async () => {
  test.setTimeout(180_000)
  const root = realpathSync(mkdtempSync('/tmp/c6-drag-'))
  const projectsRoot = path.join(root, 'projects')
  const projectPath = path.join(projectsRoot, PROJECT_KEY)
  mkdirSync(projectPath, { recursive: true })
  git(projectPath, 'init', '-q', '-b', 'main')
  git(projectPath, 'config', 'user.email', 'e2e@example.com')
  git(projectPath, 'config', 'user.name', 'e2e')
  writeFileSync(path.join(projectPath, 'README.md'), '# c6 drag\n')
  git(projectPath, 'add', '.')
  git(projectPath, 'commit', '-qm', 'init')

  const platform: CloudPlatform = await step('start-platform', () => startCloudPlatform())
  const adminToken = await step('admin-login', () => adminTokenOf(platform.url))
  const hostToken = await step('host-token', () => hostTokenOf(platform.url, adminToken))
  const tls = makeHostTls(HOST_NAME)
  const hostUserDataDir = mkdtempSync(path.join(root, 'host-ud-'))
  const host = await step('launch-host', () =>
    launchOrca(
      cloudHostEnv({
        platformUrl: platform.url,
        hostToken,
        hostName: HOST_NAME,
        projectsRoot,
        tls: { certPath: tls.certPath, keyPath: tls.keyPath }
      }),
      hostUserDataDir
    )
  )
  await host.firstWindow({ timeout: 120_000 })
  const hostRecord = await step('wait-host-online', () =>
    waitForHostOnline(platform.url, adminToken, HOST_NAME, 120_000)
  )

  const created = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId: hostRecord.id,
      path: projectPath
    })
  })
  expect(created.status, await created.clone().text()).toBe(201)
  const projectId = readString((await created.json()) as unknown, 'id') ?? ''
  const granted = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  expect(granted.status).toBe(200)
  // Keep the journey's project the first one the developer sees.
  await fetch(`${platform.url}/v1/projects/proj_payment/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
  })

  const client = await step('launch-client', () =>
    launchOrca(cloudClientEnv(platform.url), mkdtempSync(path.join(root, 'client-ud-')), {
      completedOnboarding: true
    })
  )

  try {
    const page = await client.firstWindow({ timeout: 120_000 })
    const consoleLogs: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        consoleLogs.push(`${message.type()}: ${message.text()}`)
      }
    })
    report.consoleLogs = consoleLogs
    await page.waitForLoadState('domcontentloaded')

    await step('sign-in', async () => {
      await openCloudLoginDialog(page)
      await fillCloudLoginDialog(page, { username: DEVELOPER, password: PASSWORD })
      await submitCloudLoginDialog(page, { displayName: DEVELOPER_DISPLAY_NAME })
    })

    await step('open-project', async () => {
      const opened = await page.evaluate(async (id) => {
        type Bridge = { openProject: (id: string) => Promise<unknown> }
        const bridge = (window as unknown as { api?: { cloud?: Bridge } }).api?.cloud
        if (!bridge) {
          throw new Error('cloud bridge missing')
        }
        await bridge.openProject(id)
        return true
      }, projectId)
      expect(opened).toBe(true)
      await page.waitForSelector('.app-layout', { timeout: 120_000 })
      // A freshly opened cloud workspace starts with no session tabs.
      await expect
        .poll(() => page.evaluate(() => document.querySelectorAll('[data-worktree-id]').length), {
          timeout: 120_000
        })
        .toBeGreaterThan(0)
      await dismissOverlays(page)
    })

    const createTab = async (): Promise<void> => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await dismissOverlays(page)
        await page
          .getByRole('button', { name: /^(New tab|新标签页|新建标签页)$/i })
          .first()
          .click({ timeout: 10_000 })
        const item = page
          .getByRole('menuitem', { name: /^(New Terminal|新终端|新建终端)/i })
          .first()
        try {
          await item.waitFor({ timeout: 6000 })
          await item.click()
          await sleep(1200)
          return
        } catch {
          await page.keyboard.press('Escape').catch(() => {})
          await sleep(1000)
        }
      }
      throw new Error('the New tab menu never produced a New Terminal item')
    }

    await step('create-first-tab', async () => {
      await createTab()
      await expect
        .poll(() => page.evaluate(() => document.querySelectorAll('[data-tab-id]').length), {
          timeout: 45_000
        })
        .toBeGreaterThanOrEqual(1)
    })

    await step('create-second-tab', async () => {
      await createTab()
      await expect
        .poll(() => page.evaluate(() => document.querySelectorAll('[data-tab-id]').length), {
          timeout: 30_000
        })
        .toBeGreaterThanOrEqual(2)
    })

    const tabIds = await page.evaluate(() =>
      [...document.querySelectorAll('[data-tab-id]')].map((el) => el.getAttribute('data-tab-id')!)
    )
    report.tabsBeforeSplit = tabIds

    await step('split-right', async () => {
      await splitRight(page, tabIds[1]!)
      await expect
        .poll(
          () => page.evaluate(() => document.querySelectorAll('[data-tab-group-body-id]').length),
          {
            timeout: 30_000
          }
        )
        .toBe(2)
    })
    await recordToastStage(page, 'after-split')

    const stripsBefore = await domStrips(page)
    const bodiesBefore = await domBodies(page)
    const sourceStrip = stripsBefore.find((s) => s.tabs.includes(tabIds[0]!)) ?? stripsBefore[0]!
    const movedTabId = tabIds[0]!
    const targetBody =
      bodiesBefore.find((b) => b.bodyGroupId !== sourceStrip.stripHostGroupId) ?? bodiesBefore[1]!
    report.layoutBeforeDrag = { strips: stripsBefore, bodies: bodiesBefore }

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '01-before-drag.png') })
    await step('drag-across-groups', () =>
      dragTo(page, movedTabId, {
        x: targetBody.x + targetBody.w / 2,
        y: targetBody.y + targetBody.h / 2
      })
    )
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '02-after-drag.png') })
    await recordToastStage(page, 'after-drag')

    const stripsAfter = await domStrips(page)
    report.layoutAfterDrag = stripsAfter
    const movedHost = stripsAfter
      .flatMap((s) => s.tabs.map((t) => ({ group: s.stripHostGroupId, tab: t })))
      .find((entry) => entry.tab === movedTabId)
    report.domAssertion = {
      movedTabId,
      presentAfter: Boolean(movedHost),
      groupAfter: movedHost?.group ?? null,
      targetGroup: targetBody.bodyGroupId
    }
    expect(movedHost, 'the dragged tab must remain in a DOM strip').toBeTruthy()
    expect(movedHost!.group, 'the dragged tab must land in the target group').toBe(
      targetBody.bodyGroupId
    )

    // Host-side truth for a paired desktop session is the runtime inventory
    // (session.tabs.list). The host's profile-state.db persists only the host
    // instance's own local UI session (groupId is null for paired tabs), so it
    // is not an oracle for this journey and is deliberately not collected.
    const worktreeId = sourceStrip.worktreeId!
    let rpcSession = await readSessionTabs(page, worktreeId)
    for (let i = 0; i < 15; i += 1) {
      const group = rpcSession.tabGroups.find((g) => g.id === targetBody.bodyGroupId)
      if (group?.tabOrder.some((id) => tabMatches(id, movedTabId))) {
        break
      }
      await sleep(1000)
      rpcSession = await readSessionTabs(page, worktreeId)
    }
    const rpcHostTab = rpcSession.tabs.find((t) => tabMatches(t.parentTabId ?? t.tabId, movedTabId))
    const rpcTargetGroup = rpcSession.tabGroups.find((g) => g.id === targetBody.bodyGroupId)
    report.hostAssertion = {
      oracle: 'session.tabs.list',
      worktreeId,
      rpcHostTab: rpcHostTab ?? null,
      rpcTargetGroups: rpcSession.tabGroups
    }
    expect(rpcHostTab, 'the host runtime inventory must know the dragged tab').toBeTruthy()
    expect(rpcTargetGroup, 'the target group must exist in the host inventory').toBeTruthy()
    expect(rpcTargetGroup!.tabOrder.some((id) => tabMatches(id, movedTabId))).toBe(true)

    await step('reorder-within-group', async () => {
      const groupTabs = stripsAfter.find((s) => s.stripHostGroupId === targetBody.bodyGroupId)!.tabs
      const first = groupTabs[0]!
      const second = groupTabs[1]!
      const secondBox = (await page.locator(`[data-tab-id="${second}"]`).first().boundingBox())!
      await dragTo(page, first, {
        x: secondBox.x + secondBox.width / 2,
        y: secondBox.y + secondBox.height / 2
      })
      await sleep(1200)
      const order = await page.evaluate(
        (group) =>
          [
            ...(document
              .querySelector(`[data-tab-group-strip-id="${group}"]`)
              ?.querySelectorAll('[data-tab-id]') ?? [])
          ].map((el) => el.getAttribute('data-tab-id')),
        targetBody.bodyGroupId
      )
      let hostOrder =
        (await readSessionTabs(page, worktreeId)).tabGroups.find(
          (g) => g.id === targetBody.bodyGroupId
        )?.tabOrder ?? []
      for (let i = 0; i < 12; i += 1) {
        hostOrder =
          (await readSessionTabs(page, worktreeId)).tabGroups.find(
            (g) => g.id === targetBody.bodyGroupId
          )?.tabOrder ?? []
        if (normalizeOrder(hostOrder).join(',') === normalizeOrder(order).join(',')) {
          break
        }
        await sleep(1000)
      }
      report.reorder = { beforeOrder: groupTabs, domOrder: order, hostOrder }
      // Why: a reorder that never fired would leave both lists in their pre-drag
      // order and still pass length-only assertions.
      expect(normalizeOrder(order), 'the drag must change the DOM order').not.toEqual(
        normalizeOrder(groupTabs)
      )
      expect(normalizeOrder(hostOrder), 'the host must echo the DOM order').toEqual(
        normalizeOrder(order)
      )
    })

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '03-after-reorder.png') })
    await recordToastStage(page, 'after-reorder')
    await sleep(4500)
    await recordToastStage(page, 'after-reorder-settle')

    const toasts = await snapToasts(page)
    report.toasts = toasts
    // Why: sonner toasts expire, so the acceptance criterion is checked over
    // every stage, not just what happens to still be on screen at the end.
    const errorToasts = [
      ...new Set(
        Object.values(
          (report.toastsByStage as Record<string, { type: string | null; text: string }[]>) ?? {}
        )
          .flat()
          .filter((toast) => toast.type === 'error')
          .map((toast) => `${toast.type}|${toast.text}`)
      )
    ]
    report.errorToasts = errorToasts
    expect(errorToasts, 'no error toast may fire during split/drag/reorder').toEqual([])

    report.verdict = 'PASS'
  } catch (error) {
    report.verdict = 'FAIL'
    report.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    writeEvidence('c6-report.json', report)
    await closeElectronAppForE2E(client).catch(() => undefined)
    await closeElectronAppForE2E(host).catch(() => undefined)
    await platform.stop().catch(() => undefined)
  }
})
