#!/usr/bin/env node
// U96 release-1 smoke: platform HTTP, admin login, audit/hosts API, demo web workspace reachable.
import { chromium } from 'playwright'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const USER = 'admin'
const PASS = 'Adm1n!'
const OUT = path.resolve('evidence/u96-release-1')
const result = { base: BASE, steps: {}, errors: [] }
const agent = new https.Agent({ rejectUnauthorized: false })
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

const get = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, { agent, rejectUnauthorized: false }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        )
      })
      .on('error', reject)
  })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
page.on('dialog', (d) => d.accept())
page.on('pageerror', (e) => result.errors.push(String(e).slice(0, 300)))

try {
  const root = await get(BASE + '/')
  result.steps.platformRoot = {
    status: root.status,
    contentType: root.headers['content-type'],
    bytes: root.body.length
  }

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  const loginResp = page.waitForResponse((r) => /\/v1\/auth\/login/.test(r.url()))
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  await page.fill('#username', USER)
  await page.fill('#password', PASS)
  await page.click('#loginBtn')
  const lr = await loginResp
  result.steps.login = { status: lr.status(), ok: lr.ok() }
  await page.locator('#view-app').waitFor({ state: 'visible' })

  const api = (p, init = {}) =>
    page.evaluate(
      async ([url, opts]) => {
        const token = localStorage.getItem('orca.access')
        const r = await fetch(url, {
          ...opts,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
        })
        let json = null
        try {
          json = await r.json()
        } catch {}
        return { status: r.status, json }
      },
      [p, init]
    )

  const audit = await api('/v1/audit/status')
  result.steps.auditStatus = {
    status: audit.status,
    healthy: audit.json?.healthy ?? audit.json?.chain?.ok ?? null,
    persisted: audit.json?.persisted ?? null,
    chain: audit.json?.chain ?? null,
    keys: audit.json ? Object.keys(audit.json).slice(0, 12) : null
  }

  const hosts = await api('/v1/hosts')
  result.steps.hosts = {
    status: hosts.status,
    list: (hosts.json?.hosts ?? []).map((h) => ({
      name: h.name,
      online: h.online,
      relayOnline: h.relayOnline,
      addrs: h.directAddrs
    }))
  }

  await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
  const popup = await page.waitForEvent('popup', { timeout: 60_000 })
  popup.setDefaultTimeout(90_000)
  popup.on('dialog', (d) => d.accept())
  popup.on('pageerror', (e) => result.errors.push('[web] ' + String(e).slice(0, 300)))
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  result.steps.webWorkspace = { appLayout: true, url: popup.url().replace(/#.*/, '') }

  // Served app bundle must be byte-identical to this build (version alignment).
  const served = await popup.evaluate(async () => {
    const out = []
    for (const s of document.querySelectorAll('script[src]')) {
      const r = await fetch(s.src)
      const buf = await r.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', buf)
      out.push({
        src: new URL(s.src).pathname,
        hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        bytes: buf.byteLength
      })
    }
    return out
  })
  const localAssets = new Map()
  for (const name of fs.readdirSync(path.resolve('out/web/assets'))) {
    const p = path.resolve('out/web/assets', name)
    if (fs.statSync(p).isFile()) {
      localAssets.set(sha256(fs.readFileSync(p)), name)
    }
  }
  result.steps.assetAlignment = served.map((s) => ({
    src: s.src,
    bytes: s.bytes,
    matchesBuild: localAssets.get(s.hash) ?? null
  }))

  const ui = await popup.evaluate(() => ({
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].length,
    xterm: document.querySelectorAll('.xterm').length,
    title: document.title
  }))
  result.steps.webUi = ui
  await popup.screenshot({ path: path.join(OUT, 'web-workspace.png') })
  result.ok = true
} catch (error) {
  result.ok = false
  result.failure = String(error).slice(0, 800)
} finally {
  fs.writeFileSync(path.join(OUT, 'smoke.json'), JSON.stringify(result, null, 2))
  await browser.close()
}
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
