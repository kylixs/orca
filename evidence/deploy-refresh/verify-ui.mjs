#!/usr/bin/env node
// Deploy-refresh UI spot check: served v2.2 permission UI, not-found, deep-link reload.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/deploy-refresh')
const ADMIN = { username: 'admin', password: 'Adm1n!' }
const result = { base: BASE, build: null, steps: {}, errors: [], ok: false }

function save(name, value) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n')
}

async function login(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible', timeout: 30_000 })
  const resp = page.waitForResponse((r) => /\/v1\/auth\/login/.test(r.url()))
  await page.fill('#username', ADMIN.username)
  await page.fill('#password', ADMIN.password)
  await page.click('#loginBtn')
  const res = await resp
  await page.locator('#view-app').waitFor({ state: 'visible', timeout: 30_000 })
  return res.status()
}

async function api(page, pathname) {
  return page.evaluate(async (p) => {
    const r = await fetch(p, {
      headers: { authorization: `Bearer ${localStorage.getItem('orca.access')}` }
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, pathname)
}

async function hostCards(page) {
  await page.locator('#hostPermCards .perm-card').first().waitFor({ timeout: 30_000 })
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('#hostPermCards .perm-card')]
    return {
      hash: location.hash,
      cards: cards.map((card) => {
        const head = card.querySelector('.perm-card-head')
        return {
          key: card.dataset.card,
          headText: head?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          headBadges: [...(head?.querySelectorAll('.badge') ?? [])].map((b) =>
            b.textContent.trim()
          ),
          chips: [...card.querySelectorAll('.perm-chip')].map((chip) => ({
            text: chip.textContent.replace(/\s+/g, ' ').trim(),
            badges: [...chip.querySelectorAll('.badge')].map((b) => b.textContent.trim()),
            type: chip.querySelector('.muted')?.textContent?.trim() ?? ''
          }))
        }
      })
    }
  })
}

async function projectCards(page) {
  await page.locator('#projectPermCards .perm-card').first().waitFor({ timeout: 30_000 })
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('#projectPermCards .perm-card')]
    return {
      hash: location.hash,
      cards: cards.map((card) => {
        const head = card.querySelector('.perm-card-head')
        return {
          key: card.dataset.card,
          headText: head?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          headBadges: [...(head?.querySelectorAll('.badge') ?? [])].map((b) =>
            b.textContent.trim()
          ),
          hasAddInput: Boolean(card.querySelector('[data-perm-subject], [data-perm-add]')),
          hasRemove: Boolean(card.querySelector('.perm-chip-x')),
          jump: card.querySelector('[data-open-host-detail]')?.dataset.openHostDetail ?? null,
          chips: [...card.querySelectorAll('.perm-chip')].map((chip) =>
            chip.textContent.replace(/\s+/g, ' ').trim()
          )
        }
      })
    }
  })
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true })
const page = await context.newPage()
page.on('dialog', (d) => d.accept())
page.on('pageerror', (e) => result.errors.push(String(e).slice(0, 300)))
page.on('console', (m) => {
  if (m.type() === 'error') result.errors.push(m.text().slice(0, 300))
})
try {
  result.steps.loginStatus = await login(page)
  result.build = await page.evaluate(() => window.__orcaWebBuild ?? null)
  const servedBuild = await page.evaluate(async () => {
    const r = await fetch('/app.js')
    return r.headers.get('x-orca-web-build')
  })
  result.steps.servedBuild = servedBuild

  const hosts = await api(page, '/v1/hosts')
  const host =
    hosts.body.hosts.find((h) => h.name === 'dev-local-02' && h.online) ?? hosts.body.hosts[0]
  const projects = await api(page, '/v1/projects')
  const project =
    projects.body.projects.find((p) => p.key === 'zhangsan-demo') ??
    projects.body.projects.find((p) => p.hostId === host.id) ??
    projects.body.projects[0]

  // a) host detail permission tab: three cards, no position badges in heads.
  await page.goto(`${BASE}/#/hosts/${host.id}?tab=perms`, { waitUntil: 'domcontentloaded' })
  const hostView = await hostCards(page)
  result.steps.host = {
    hostId: host.id,
    hostName: host.name,
    ...hostView,
    threeCards: ['view', 'control', 'manage'].every((k) => hostView.cards.some((c) => c.key === k)),
    noHeadBitBadge: hostView.cards
      .filter((c) => ['view', 'control', 'manage'].includes(c.key))
      .every((c) => c.headBadges.length === 0)
  }
  save('host-perms.json', result.steps.host)

  // b) project dialog permission tab: derived management card read-only + jump.
  await page.goto(`${BASE}/#/projects/${project.id}?tab=perms`, { waitUntil: 'domcontentloaded' })
  const projView = await projectCards(page)
  const derived = projView.cards.find((c) => c.key === 'derived')
  result.steps.project = {
    projectId: project.id,
    projectKey: project.key,
    hostId: host.id,
    ...projView,
    threeCards: ['view', 'control', 'derived'].every((k) =>
      projView.cards.some((c) => c.key === k)
    ),
    noHeadBitBadge: projView.cards
      .filter((c) => ['view', 'control'].includes(c.key))
      .every((c) => c.headBadges.length === 0),
    derivedReadOnly: Boolean(derived) && !derived.hasAddInput && !derived.hasRemove,
    derivedJump: derived?.jump === host.id,
    derivedSourceBadge: derived?.headBadges.includes('主机推导 · 只读') ?? false
  }
  save('project-perms.json', result.steps.project)

  // c) jump from derived card -> host permission drawer.
  await page.locator('#projectPermCards [data-card="derived"] [data-open-host-detail]').click()
  await page.locator('#hostPermCards .perm-card').first().waitFor({ timeout: 30_000 })
  const afterJump = await page.evaluate(() => ({
    hash: location.hash,
    drawer: Boolean(document.querySelector('.drawer, .dialog')),
    cards: document.querySelectorAll('#hostPermCards .perm-card').length
  }))
  result.steps.jump = afterJump

  // d) deep-link reload keeps the host permission deep link and card view.
  await page.reload({ waitUntil: 'domcontentloaded' })
  const reloaded = await hostCards(page)
  result.steps.deepLinkReload = {
    hash: reloaded.hash,
    expectedHash: `#/hosts/${host.id}?tab=perms`,
    cards: reloaded.cards.map((c) => c.key),
    preserved: reloaded.hash === `#/hosts/${host.id}?tab=perms` && reloaded.cards.length === 3
  }

  // e) members route -> 404, address preserved.
  await page.goto(`${BASE}/#/members`, { waitUntil: 'domcontentloaded' })
  await page.locator('.forbidden .box h1').waitFor({ timeout: 20_000 })
  result.steps.members404 = await page.evaluate(() => ({
    hash: location.hash,
    heading: document.querySelector('.forbidden .box h1')?.textContent?.trim() ?? '',
    body: document.querySelector('.forbidden .box p')?.textContent?.trim() ?? ''
  }))

  const s = result.steps
  result.ok =
    s.loginStatus === 200 &&
    s.host.threeCards &&
    s.host.noHeadBitBadge &&
    s.project.threeCards &&
    s.project.noHeadBitBadge &&
    s.project.derivedReadOnly &&
    s.project.derivedJump &&
    s.project.derivedSourceBadge &&
    s.jump.cards === 3 &&
    s.members404.heading === '页面不存在' &&
    s.members404.hash === '#/members' &&
    s.deepLinkReload.preserved &&
    result.errors.length === 0
} catch (err) {
  result.fatal = String(err).slice(0, 1000)
} finally {
  save('verify-ui.json', result)
  await browser.close()
}
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
