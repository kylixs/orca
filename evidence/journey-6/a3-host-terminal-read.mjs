import { chromium } from 'playwright'
import fs from 'node:fs'
const BASE = 'https://127.0.0.1:18787'
const OUT = 'evidence/journey-6'
const STAMP = Date.now()
const ONE = `J6-HOSTREAD-ONE-${STAMP}`
const TWO = `J6-HOSTREAD-TWO-${STAMP}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
const p = await ctx.newPage()
p.on('dialog', (d) => d.accept())
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await p.fill('#username', 'zhangsan')
await p.fill('#password', 'Passw0rd!')
await p.click('#loginBtn')
await p.locator('#view-app').waitFor({ state: 'visible', timeout: 30000 })
const proj = await p.evaluate(async () => {
  const r = await fetch('/v1/projects', {
    headers: { authorization: `Bearer ${localStorage.getItem('orca.access')}` }
  })
  return (await r.json()).projects.find((x) => x.key === 'zhangsan-demo')
})
const pp = ctx.waitForEvent('page')
await p.locator(`[data-orca-web="${proj.id}"]`).first().click()
const pop = await pp
await pop.waitForSelector('.app-layout', { timeout: 180000 })
const env = await pop.evaluate(async () => {
  const envs = await window.api.runtimeEnvironments.list()
  const ids = [...document.querySelectorAll('[data-worktree-id]')]
    .map((el) => el.getAttribute('data-worktree-id'))
    .filter(Boolean)
  const state = window.__store?.getState?.()
  return {
    envId: envs[0]?.id,
    worktree:
      state?.activeWorktreeId ?? ids.find((v) => v.includes('.orca-worktrees/zhangsan/')) ?? ids[0],
    storeExposed: Boolean(state)
  }
})
const call = (method, params) =>
  pop.evaluate(
    async ({ envId, method, params }) => {
      const r = await window.api.runtimeEnvironments.call({
        selector: envId,
        method,
        params,
        timeoutMs: 60000
      })
      if (!r.ok) throw new Error(`${method}: ${r.error.code} ${r.error.message}`)
      return r.result
    },
    { envId: env.envId, method, params }
  )
const wt = `id:${env.worktree}`
const created = []
for (const i of [1, 2]) {
  const r = await call('terminal.create', {
    worktree: wt,
    title: `J6 hostread ${i}`,
    tabId: `j6-hostread-${STAMP}-${i}`,
    leafId: `j6-hostread-leaf-${STAMP}-${i}`
  })
  created.push({ handle: r.terminal.handle, marker: i === 1 ? ONE : TWO })
}
for (const c of created)
  await call('terminal.send', { terminal: c.handle, text: `printf '${c.marker}\\n'\r` })
const reads = {}
for (const c of created) {
  const deadline = Date.now() + 30000
  let tail = ''
  for (;;) {
    const r = await call('terminal.read', { terminal: c.handle, limit: 200 })
    tail = (r?.terminal?.tail ?? []).join('\n')
    if (tail.includes(c.marker)) break
    if (Date.now() > deadline) break
    await sleep(300)
  }
  reads[c.marker] = { ok: tail.includes(c.marker), tail: tail.slice(-300) }
}
const dom = await pop.evaluate(() => ({
  appLayout: document.querySelector('.app-layout') !== null,
  tabs: document.querySelectorAll('[data-testid="sortable-tab"]').length,
  xterm: document.querySelectorAll('.xterm').length
}))
await pop.screenshot({ path: `${OUT}/a3-host-terminal-read.png` })
const out = {
  env,
  dom,
  markers: { ONE, TWO },
  reads,
  gates: {
    a3_host_read_markers: reads[ONE]?.ok === true && reads[TWO]?.ok === true,
    a1_app_layout_terminal: dom.appLayout && dom.tabs >= 1 && dom.xterm >= 1
  }
}
fs.writeFileSync(`${OUT}/a3-host-terminal-read.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
await browser.close()
process.exit(out.gates.a3_host_read_markers && out.gates.a1_app_layout_terminal ? 0 : 1)
