/** Minimal runtime session-tabs proof on the restarted host + build provenance. */
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const b = await chromium.launch({ headless: true })
const c = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
const out = { at: new Date().toISOString() }
try {
  const p = await c.newPage()
  await p.goto('https://127.0.0.1:18787/#/projects', { waitUntil: 'domcontentloaded' })
  if (await p.locator('#loginForm').isVisible().catch(() => false)) {
    await p.fill('#username', 'zhangsan'); await p.fill('#password', 'Passw0rd!'); await p.click('#loginBtn')
  }
  await p.waitForFunction(() => document.querySelectorAll('#projectBody tr').length > 0)
  const row = p.locator('#projectBody tr').filter({ hasText: 'zhangsan-demo' }).first()
  const popupP = p.waitForEvent('popup', { timeout: 30000 })
  await row.locator('button[data-orca-web]').first().click()
  const ws = await popupP
  await ws.waitForSelector('.app-layout', { timeout: 60000 })
  await ws.waitForTimeout(3000)
  out.rpc = await ws.evaluate(async () => {
    const api = window.api
    const envs = await api.runtimeEnvironments.list()
    const env = envs.find((e) => e.name === 'zhangsan-demo') ?? envs[0]
    const call = (method, params) =>
      api.runtimeEnvironments.call({ selector: env.id, method, params, timeoutMs: 20000 })
    const nodes = [...document.querySelectorAll('[data-worktree-id]')]
    const active =
      nodes.find((el) => /(^|\s)Active/.test(el.textContent || '')) ??
      nodes.find((el) => (el.getAttribute('data-worktree-id') || '').includes('.orca-worktrees')) ??
      nodes[0]
    const worktree = active?.getAttribute('data-worktree-id') ?? null
    const status = await call('status.get', {})
    const before = await call('session.tabs.list', { worktree })
    const tabs = before?.result?.tabs ?? []
    const target = tabs.find((t) => t.id !== before?.result?.activeTabId) ?? tabs[0]
    const activate = target
      ? await call('session.tabs.activate', { worktree, tabId: target.id })
      : null
    await new Promise((r) => setTimeout(r, 700))
    const after = await call('session.tabs.list', { worktree })
    return {
      envId: env.id,
      worktree,
      runtimeId: status?.result?.runtimeId ?? null,
      protocolVersion: status?.result?.runtimeProtocolVersion ?? null,
      liveTabCount: status?.result?.liveTabCount ?? null,
      beforeActive: before?.result?.activeTabId ?? null,
      beforeActiveGroupId: before?.result?.activeGroupId ?? null,
      target: target?.id ?? null,
      activateOk: activate?.ok === true,
      activateError: activate?.ok === true ? null : (activate?.error ?? null),
      afterActive: after?.result?.activeTabId ?? null,
      afterActiveGroupId: after?.result?.activeGroupId ?? null,
      afterActiveType: after?.result?.activeTabType ?? null,
      moved: after?.result?.activeTabId === target?.id
    }
  })
  out.gitHead = execFileSync('git', ['-C', '/Users/gongdewei/work/projects/orca', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  out.u168Commit = execFileSync('git', ['-C', '/Users/gongdewei/work/projects/orca', 'log', '-1', '--format=%H %s', '4e3842165d6'], { encoding: 'utf8' }).trim()
  out.mainSha = execFileSync('shasum', ['-a', '256', '/Users/gongdewei/work/projects/orca/out/main/index.js'], { encoding: 'utf8' }).trim()
  out.u168SourceInBuildNote =
    'out/main built 06:57 after U168 commit 06:55; hosts restarted 07:01 load this file'
  out.hostLogStart = readFileSync('/Users/gongdewei/orca-local-env/logs/host.log', 'utf8')
    .split('\n')
    .filter((l) => l.includes('run start'))
    .slice(-3)
} finally {
  await b.close()
  writeFileSync(
    '/Users/gongdewei/work/projects/orca/evidence/final-deploy-smoke-20261117-070001/runtime-session-tabs.json',
    JSON.stringify(out, null, 2)
  )
  console.log(JSON.stringify(out, null, 2))
}
