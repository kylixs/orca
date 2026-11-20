import { chromium } from 'playwright'
const BASE = 'https://127.0.0.1:18787'
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
const token = await p.evaluate(() => localStorage.getItem('orca.access'))
const proj = await p.evaluate(async () => {
  const r = await fetch('/v1/projects', {
    headers: { authorization: `Bearer ${localStorage.getItem('orca.access')}` }
  })
  return (await r.json()).projects.find((x) => x.key === 'zhangsan-demo')
})
const pp = ctx.waitForEvent('page')
await p.locator(`[data-orca-web="${proj.id}"]`).first().click()
const pop = await pp
await pop.waitForSelector('.app-layout', { timeout: 120000 })
await sleep(4000)
const out = await pop.evaluate(async () => {
  const envs = await window.api.runtimeEnvironments.list()
  const ids = [...document.querySelectorAll('[data-worktree-id]')].map((el) =>
    el.getAttribute('data-worktree-id')
  )
  let listAll
  try {
    listAll = (await window.api.worktrees.listAll()).map((w) => ({ id: w.id, path: w.path }))
  } catch (e) {
    listAll = 'ERR ' + e.message
  }
  let wl
  try {
    wl = await window.api.runtimeEnvironments.call({
      selector: envs[0].id,
      method: 'worktree.list',
      params: {},
      timeoutMs: 20000
    })
  } catch (e) {
    wl = 'ERR ' + e.message
  }
  return {
    envs,
    ids,
    listAll,
    wl: JSON.parse(JSON.stringify(wl)).error ?? {
      count: wl.result?.worktrees?.length,
      sample: wl.result?.worktrees?.slice(0, 3).map((w) => ({ id: w.id, path: w.path }))
    }
  }
})
console.log(JSON.stringify(out, null, 1))
await browser.close()
