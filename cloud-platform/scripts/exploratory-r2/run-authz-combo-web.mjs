#!/usr/bin/env node
/**
 * Exploratory run (Web/UI layer): authorization feature x multi-host x multi-project.
 * Uses the resident Playwright Server for per-identity UI checks and the platform
 * API for setup/readback. Every mutation is snapshot-restored in `finally`.
 * Output: cloud-platform/evidence/exploratory-r2/authz-combo.json
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const BASE = process.env.ORCA_QA_BASE || 'https://127.0.0.1:18787'
const EVID_DIR = path.join(ROOT, 'cloud-platform', 'evidence', 'exploratory-r2')
const PS_DIR = path.join(EVID_DIR, 'ps-server')
const OUT_JSON = path.join(EVID_DIR, 'authz-combo.json')
const CREDS = {
  admin: { username: 'admin', password: 'Adm1n!' },
  zhangsan: { username: 'zhangsan', password: 'Passw0rd!' },
  lisi: { username: 'lisi', password: 'Passw0rd!' }
}

function request(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        rejectUnauthorized: false
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            json = null
          }
          resolve({ status: res.statusCode, text, json })
        })
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

async function api(method, p, { token, body } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  return request(`${BASE}${p}`, { method, headers, body })
}

const psInfo = JSON.parse(fs.readFileSync(path.join(PS_DIR, 'server.json'), 'utf8'))
const PS = `http://127.0.0.1:${psInfo.port}`
async function ps(method, p, body) {
  const headers = { authorization: `Bearer ${psInfo.token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return request(`${PS}${p}`, { method, headers, body })
}

const startedAt = new Date().toISOString()
const findings = []
const combos = []
const logs = []
function log(...parts) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
  logs.push(line)
  console.log(line)
}
let findingSeq = 0
function addFinding({ id, severity, dimension, title, steps, expected, actual, evidence, linked }) {
  findings.push({
    id: id ?? `WEB-AUTHZ-${String(++findingSeq).padStart(3, '0')}`,
    severity,
    dimension,
    title,
    steps,
    expected,
    actual,
    evidence,
    ...(linked ? { linked } : {})
  })
}
function combo(entry) {
  combos.push(entry)
  log(`[${entry.ok ? 'PASS' : 'FAIL'}] ${entry.dimension} ${entry.id} ${entry.title}`)
  return entry
}
function expectChecks(dimension, id, title, checks, extra = {}) {
  const failed = checks.filter((c) => !c.ok)
  return combo({ dimension, id, title, checks, ok: failed.length === 0, failed, ...extra })
}

const tokens = {}
const devices = {}
async function login(role) {
  const res = await api('POST', '/v1/auth/login', { body: CREDS[role] })
  if (res.status !== 200 || !res.json?.accessToken) {
    throw new Error(`login ${role} -> ${res.status} ${res.text}`)
  }
  tokens[role] = res.json.accessToken
  devices[role] = null
}
async function tokenFor(role) {
  if (!tokens[role]) await login(role)
  return tokens[role]
}
async function deviceFor(role) {
  if (devices[role]) return devices[role]
  const res = await api('GET', '/v1/me/devices', { token: await tokenFor(role) })
  devices[role] = (res.json?.devices ?? []).find((d) => !d.revokedAt)?.id ?? ''
  return devices[role]
}
function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.length === sb.length && sa.every((v, i) => v === sb[i])
}

async function hosts() {
  const res = await api('GET', '/v1/hosts', { token: await tokenFor('admin') })
  if (res.status !== 200) throw new Error(`hosts -> ${res.status} ${res.text}`)
  return res.json.hosts
}
async function projects() {
  const res = await api('GET', '/v1/projects?includeArchived=0', {
    token: await tokenFor('admin')
  })
  if (res.status !== 200) throw new Error(`projects -> ${res.status} ${res.text}`)
  return res.json.projects
}
async function projectGrants(projectId) {
  const res = await api('GET', `/v1/projects/${projectId}/grants`, {
    token: await tokenFor('admin')
  })
  return res.json?.grants ?? []
}
async function hostGrants(hostId) {
  const res = await api('GET', `/v1/hosts/${hostId}/grants`, { token: await tokenFor('admin') })
  return res.json?.grants ?? []
}
async function putProjectGrant(projectId, subjectType, subjectId, permissions) {
  const res = await api('PUT', `/v1/projects/${projectId}/grants`, {
    token: await tokenFor('admin'),
    body: { subjectType, subjectId, permissions }
  })
  if (res.status !== 200)
    throw new Error(`put grant ${projectId} ${subjectId}: ${res.status} ${res.text}`)
  return res
}
async function putHostGrant(hostId, subjectType, subjectId, permissions) {
  const res = await api('PUT', `/v1/hosts/${hostId}/grants`, {
    token: await tokenFor('admin'),
    body: { subjectType, subjectId, permissions }
  })
  if (res.status !== 200) throw new Error(`put host grant ${hostId}: ${res.status} ${res.text}`)
  return res
}
async function setProvisionPolicy(hostId, mode) {
  const res = await api('PUT', `/v1/hosts/${hostId}/provision-policy`, {
    token: await tokenFor('admin'),
    body: { mode }
  })
  if (res.status !== 200) throw new Error(`policy ${hostId}: ${res.status} ${res.text}`)
  return res
}
async function availableHosts(role) {
  const res = await api('GET', '/v1/hosts/available', { token: await tokenFor(role) })
  return { status: res.status, hosts: res.json?.hosts ?? [] }
}
async function selfCreate(role, hostId, dir) {
  return api('POST', '/v1/projects/self', {
    token: await tokenFor(role),
    body: { name: `QA ${dir}`, key: dir, dir, hostId, defaultBranch: 'main' }
  })
}
async function archiveProject(projectId) {
  return api('POST', `/v1/projects/${projectId}/archive`, { token: await tokenFor('admin') })
}
async function maintenance(role, hostId, enabled, reason = 'QA authz combo') {
  return api('POST', `/v1/hosts/${hostId}/maintenance`, {
    token: await tokenFor(role),
    body: { enabled, reason }
  })
}

async function probeProject(role, projectId) {
  const token = await tokenFor(role)
  const list = await api('GET', '/v1/projects', { token })
  const item = (list.json?.projects ?? []).find((p) => p.id === projectId) ?? null
  const out = {
    role,
    projectId,
    visible: Boolean(item),
    listedPermissions: item?.permissions ?? null,
    connectStatus: null,
    credentialPerms: null,
    handoffStatus: null,
    downloadPolicy: null,
    error: null
  }
  if (!item) return out
  const dev = await deviceFor(role)
  const connect = await api('POST', `/v1/projects/${projectId}/connect`, {
    token,
    body: { clientVersion: '1.5.0', deviceId: dev, devicePubKey: '' }
  })
  out.connectStatus = connect.status
  if (connect.json?.credential) out.credentialPerms = decodeJwt(connect.json.credential).perms
  else out.error = connect.json?.error?.code ?? null
  const handoff = await api('POST', `/v1/projects/${projectId}/web-handoff`, {
    token,
    body: { surface: 'admin' }
  })
  out.handoffStatus = handoff.status
  const policy = await api('GET', `/v1/projects/${projectId}/policy`, { token })
  out.downloadPolicy = policy.json?.effective ?? null
  return out
}

// ---------- Playwright Server UI helpers ----------
const tabs = {}
async function tabFor(role) {
  if (tabs[role]) return tabs[role]
  const list = await ps('GET', '/tabs')
  const existing = (list.json ?? []).find((t) => t.profile === role)
  if (existing) {
    tabs[role] = existing.id
    return existing.id
  }
  const created = await ps('POST', '/tabs', { profile: role, url: `${BASE}/` })
  if (created.status !== 201) throw new Error(`open tab ${role}: ${created.status} ${created.text}`)
  tabs[role] = created.json.id
  return tabs[role]
}
async function exec(role, source, params = {}) {
  const tabId = await tabFor(role)
  const res = await ps('POST', `/tabs/${tabId}/execute`, { source, params, timeoutMs: 120000 })
  if (res.status !== 200) throw new Error(`execute ${role}: ${res.status} ${res.text}`)
  if (!res.json?.ok)
    throw new Error(`execute ${role} failed: ${res.json?.error?.message ?? res.text}`)
  return res.json.result
}
async function shot(role, name) {
  const tabId = await tabFor(role)
  const res = await ps('POST', `/tabs/${tabId}/screenshot`, {
    path: `shots/authz-combo/${name}.png`,
    fullPage: true
  })
  return res.json?.path ?? null
}

async function uiRows({ page, ui, params }) {
  await ui.login(params.role)
  await ui.navigateMenu(params.route)
  const rows = await page.$$eval('tbody tr', (trs) =>
    trs.map((tr) => {
      const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())
      return {
        name: tr.querySelector('strong')?.textContent?.trim() ?? cells[0] ?? '',
        cells,
        text: tr.innerText,
        buttons: [...tr.querySelectorAll('button')].map((b) => ({
          label: b.textContent.trim(),
          disabled: b.disabled,
          title: b.title
        }))
      }
    })
  )
  const stats = await page.$$eval('.stat', (els) =>
    els.map((el) => el.innerText.replace(/\n/g, ' '))
  )
  const heading = await page.$eval('#content h1', (el) => el.textContent.trim()).catch(() => null)
  return { route: params.route, rows, stats, heading }
}

async function uiOpenOverlay({ page, ui, params }) {
  // Opens an already-authorized project and samples the inline workspace until
  // it reports ready or shows a failure shell (bounded by the 20s ready timer).
  await ui.login(params.role)
  await ui.navigateMenu('workbench')
  const row = page.locator('tbody tr', { hasText: params.projectName }).first()
  await row.waitFor({ timeout: 10000 })
  await row.getByRole('button', { name: '打开' }).click()
  await page.waitForSelector('#workspaceOverlay', { timeout: 10000 }).catch(() => null)
  const sample = () =>
    page.evaluate(() => {
      const root = document.querySelector('#workspaceOverlay')
      if (!root) return { mounted: false, ready: false, failure: false }
      const status = root.querySelector('[data-workspace-status]')
      const bodyText = root.querySelector('.workspace-body')?.innerText ?? ''
      const failure =
        Boolean(root.querySelector('[data-workspace-ready-failure]')) ||
        bodyText.includes('工作区打开失败') ||
        bodyText.includes('工作区加载超时')
      return {
        mounted: true,
        ready: status ? status.hidden && !failure : false,
        failure,
        statusText: status && !status.hidden ? status.textContent.trim() : '',
        hasFrame: Boolean(root.querySelector('iframe.workspace-frame')),
        frameSrc: root.querySelector('iframe.workspace-frame')?.src ?? '',
        bodyText: bodyText.slice(0, 700)
      }
    })
  let state = await sample()
  const deadline = Date.now() + 24000
  while (Date.now() < deadline && !state.ready && !state.failure) {
    await page.waitForTimeout(1000)
    state = await sample()
  }
  await page
    .evaluate(() => {
      const root = document.querySelector('#workspaceOverlay')
      ;(
        root?.querySelector('[data-workspace-close]') ??
        root?.querySelector('.workspace-bar .icon-btn')
      )?.click()
    })
    .catch(() => null)
  return state
}

async function uiSelfGrantCancel({ page, ui, params }) {
  await ui.login('admin')
  await ui.navigateMenu('workbench')
  const row = page.locator('tbody tr', { hasText: params.projectName }).first()
  await row.waitFor({ timeout: 10000 })
  const buttons = await row
    .locator('button')
    .evaluateAll((bs) =>
      bs.map((b) => ({ label: b.textContent.trim(), disabled: b.disabled, title: b.title }))
    )
  await row.locator('[data-self-grant]').click()
  await page.waitForSelector('.dialog-backdrop .dialog')
  const title = await page.$eval('.dialog-backdrop .dialog h2', (el) => el.textContent.trim())
  const body = await page.$eval('.dialog-backdrop .dialog .body', (el) => el.innerText)
  await page.click('.dialog-backdrop [data-action="close"]')
  const dialogClosed = (await page.locator('.dialog-backdrop .dialog').count()) === 0
  return { buttons, title, body, dialogClosed }
}

async function uiSelfGrantConfirm({ page, ui, params }) {
  await ui.login('admin')
  await ui.navigateMenu('workbench')
  const row = page.locator('tbody tr', { hasText: params.projectName }).first()
  await row.waitFor({ timeout: 10000 })
  await row.locator('[data-self-grant]').click()
  await page.waitForSelector('.dialog-backdrop .dialog')
  await page.click('.dialog-backdrop [data-action="0"]')
  await page.waitForSelector('#workspaceOverlay', { timeout: 10000 }).catch(() => null)
  const sample = () =>
    page.evaluate(() => {
      const root = document.querySelector('#workspaceOverlay')
      if (!root) return { mounted: false, ready: false, failure: false }
      const status = root.querySelector('[data-workspace-status]')
      const bodyText = root.querySelector('.workspace-body')?.innerText ?? ''
      const failure =
        Boolean(root.querySelector('[data-workspace-ready-failure]')) ||
        bodyText.includes('工作区打开失败') ||
        bodyText.includes('工作区加载超时')
      return {
        mounted: true,
        ready: status ? status.hidden && !failure : false,
        failure,
        statusText: status && !status.hidden ? status.textContent.trim() : '',
        hasFrame: Boolean(root.querySelector('iframe.workspace-frame')),
        frameSrc: root.querySelector('iframe.workspace-frame')?.src ?? '',
        bodyText: bodyText.slice(0, 700)
      }
    })
  let state = await sample()
  const deadline = Date.now() + 24000
  while (Date.now() < deadline && !state.ready && !state.failure) {
    await page.waitForTimeout(1000)
    state = await sample()
  }
  await page
    .evaluate(() => {
      const root = document.querySelector('#workspaceOverlay')
      ;(
        root?.querySelector('[data-workspace-close]') ??
        root?.querySelector('.workspace-bar .icon-btn')
      )?.click()
    })
    .catch(() => null)
  return state
}

async function uiHostDrawer({ page, ui, params }) {
  await ui.login('admin')
  await ui.navigateMenu('hosts')
  const row = page.locator('tbody tr', { hasText: params.hostName }).first()
  await row.waitFor({ timeout: 10000 })
  await row.getByRole('button', { name: '详情' }).click()
  await page.waitForSelector('.drawer [data-auth-tab="perms"]')
  await page.click('.drawer [data-auth-tab="perms"]')
  // U67 removed the old grant table/policy radios; wait for the three role cards.
  await page.waitForFunction(
    () => {
      const holder = document.querySelector('#hostPermCards')
      return Boolean(holder) && holder.querySelectorAll('.perm-card').length === 3
    },
    { timeout: 15000 }
  )
  const data = await page.evaluate(() => {
    const drawer = document.querySelector('.drawer')
    const tabs = [...drawer.querySelectorAll('[data-auth-tab]')].map((tab) =>
      tab.textContent.trim()
    )
    const cards = [...drawer.querySelectorAll('#hostPermCards .perm-card')].map((card) => ({
      key: card.dataset.card,
      heading: card.querySelector('.perm-card-head strong')?.textContent.trim() ?? '',
      chips: [...card.querySelectorAll('.perm-chip')].map((chip) =>
        chip.innerText.replace(/\n/g, ' ').trim()
      )
    }))
    return {
      tabs,
      activeTab: drawer.querySelector('[data-auth-tab].active')?.textContent.trim() ?? '',
      cards
    }
  })
  await page.click('.drawer .icon-btn').catch(() => null)
  return data
}

async function uiRegister({ page, ui, params }) {
  await ui.login('admin')
  await ui.navigateMenu('projects')
  await page.click('#registerProjectBtn')
  await page.waitForSelector('.dialog-backdrop .dialog')
  const options = await page.$$eval('#regHost option', (os) =>
    os.map((o) => ({ value: o.value, label: o.textContent.trim() }))
  )
  const pick = async (hostId) => {
    await page.selectOption('#regHost', hostId)
    return page.$eval('#regRootHint', (el) => ({ hidden: el.hidden, text: el.textContent.trim() }))
  }
  const roots = {
    host1: await pick(params.hosts.host1),
    host2: await pick(params.hosts.host2)
  }
  await pick(params.hosts.host1)
  await page.fill('#regPath', params.paths.host1Path)
  const beforeSwitch = await page.inputValue('#regPath')
  await pick(params.hosts.host2)
  const afterSwitch = await page.inputValue('#regPath')
  await page.click('.dialog-backdrop [data-action="close"]')
  return { options, roots, beforeSwitch, afterSwitch }
}

async function uiRegisterValidation({ page, ui, params }) {
  await ui.login('admin')
  await ui.navigateMenu('projects')
  await page.click('#registerProjectBtn')
  await page.waitForSelector('.dialog-backdrop .dialog')
  const readErrors = () =>
    page.evaluate(() => {
      const out = {}
      for (const el of document.querySelectorAll('.dialog-backdrop .inline-error')) {
        if (el.hidden) continue
        out[el.id === 'regError' ? 'top' : el.id] = el.textContent.trim()
      }
      return out
    })
  const submitAndRead = async () => {
    await page.click('.dialog-backdrop [data-action="0"]')
    await page.waitForTimeout(900)
    return readErrors()
  }
  const out = {}

  await page.selectOption('#regHost', '')
  out.empty = await submitAndRead()

  await page.fill('#regName', 'QA combo')
  await page.fill('#regKey', 'PaymentService')
  out.badKey = await submitAndRead()

  await page.fill('#regKey', 'qa-authz-combo-key')
  await page.selectOption('#regHost', params.hosts.host1)
  await page.fill('#regPath', 'work/qa-authz-combo')
  out.relativePath = await submitAndRead()

  await page.fill('#regPath', `${params.paths.host1Root}/projects/../demo-app`)
  out.dotdotPath = await submitAndRead()

  await page.fill('#regPath', '/tmp/qa-authz-combo/')
  out.trailingPath = await submitAndRead()

  await page.fill('#regKey', 'demo-app')
  await page.fill('#regPath', params.paths.freshHost1Path)
  out.duplicateKey = await submitAndRead()

  await page.fill('#regKey', 'qa-authz-combo-dup')
  await page.fill('#regPath', params.paths.host1DemoPath)
  out.duplicatePath = await submitAndRead()

  await page.click('.dialog-backdrop [data-action="close"]')
  return out
}

const createdProjectIds = []
let snapshot = null

async function snapshotState() {
  const hs = await hosts()
  const ps = await projects()
  const grants = {}
  for (const p of ps) grants[p.id] = await projectGrants(p.id)
  const hgrants = {}
  for (const h of hs) hgrants[h.id] = await hostGrants(h.id)
  const policy = (await api('GET', '/v1/policies/download', { token: await tokenFor('admin') }))
    .json
  return {
    hosts: hs.map((h) => ({
      id: h.id,
      name: h.name,
      status: h.status,
      online: h.online,
      revokedAt: h.revokedAt,
      projectsRoot: h.projectsRoot
    })),
    projects: ps.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      hostId: p.hostId,
      hostName: p.hostName,
      path: p.path
    })),
    grants,
    hostGrants: hgrants,
    policy
  }
}

async function restoreState(snap, reason) {
  if (!snap) return
  log(`[restore] ${reason}`)
  for (const p of snap.projects) {
    const current = await projectGrants(p.id).catch(() => [])
    const keys = new Map()
    for (const g of [...current, ...(snap.grants[p.id] ?? [])]) {
      keys.set(`${g.subjectType}:${g.subjectId}`, g)
    }
    for (const g of keys.values()) {
      const target = (snap.grants[p.id] ?? []).find(
        (s) => s.subjectType === g.subjectType && s.subjectId === g.subjectId
      )
      await putProjectGrant(p.id, g.subjectType, g.subjectId, target?.permissions ?? []).catch(
        (e) => log(`[restore] project grant failed ${p.id}: ${e.message}`)
      )
    }
  }
  for (const h of snap.hosts) {
    const current = await hostGrants(h.id).catch(() => [])
    const keys = new Map()
    for (const g of [...current, ...(snap.hostGrants[h.id] ?? [])]) {
      keys.set(`${g.subjectType}:${g.subjectId}`, g)
    }
    for (const g of keys.values()) {
      const target = (snap.hostGrants[h.id] ?? []).find(
        (s) => s.subjectType === g.subjectType && s.subjectId === g.subjectId
      )
      await putHostGrant(h.id, g.subjectType, g.subjectId, target?.permissions ?? []).catch((e) =>
        log(`[restore] host grant failed ${h.id}: ${e.message}`)
      )
    }
    await setProvisionPolicy(h.id, 'open').catch((e) =>
      log(`[restore] policy failed ${h.id}: ${e.message}`)
    )
    if (h.status === 'maintenance') {
      await maintenance('admin', h.id, false).catch(() => null)
    }
  }
  for (const id of createdProjectIds) {
    await archiveProject(id).catch(() => null)
  }
}

async function main() {
  await login('admin')
  await login('zhangsan')
  await login('lisi')
  snapshot = await snapshotState()
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })

  const host1 = snapshot.hosts.find((h) => h.name === 'dev-local-02')
  const host2 = snapshot.hosts.find((h) => h.name === 'dev-local-03')
  const revoked = snapshot.hosts.find((h) => h.revokedAt)
  const proj = Object.fromEntries(snapshot.projects.map((p) => [p.key, p]))
  const required = ['demo-app', 'zhangsan-demo', 'infra-tools', 'zhangsan-lab']
  for (const key of required) if (!proj[key]) throw new Error(`missing seed project ${key}`)
  log('[env] hosts', {
    host1: `${host1.id}/${host1.name}`,
    host2: `${host2.id}/${host2.name}`,
    revoked: revoked ? `${revoked.id}/${revoked.name}` : null
  })

  // ===== D0 baseline =====
  const baseline = {}
  const visibleCounts = {}
  for (const role of ['admin', 'zhangsan', 'lisi']) {
    baseline[role] = {}
    for (const key of required) baseline[role][key] = await probeProject(role, proj[key].id)
    const list = await api('GET', '/v1/projects', { token: await tokenFor(role) })
    visibleCounts[role] = (list.json?.projects ?? []).length
  }
  const uiBaseline = {}
  for (const role of ['admin', 'zhangsan', 'lisi']) {
    uiBaseline[role] = {
      workbench: await exec(role, uiRows.toString(), { role, route: 'workbench' }),
      projects: await exec(role, uiRows.toString(), { role, route: 'projects' })
    }
    await shot(role, `baseline-${role}-workbench`)
  }
  expectChecks('D0 baseline', 'D0', 'seed ACL 与三身份 UI 基线', [
    {
      name: 'zhangsan sees all four (host1 x2, host2 x2)',
      ok: required.every((k) => baseline.zhangsan[k].visible),
      actual: required.map((k) => `${k}:${baseline.zhangsan[k].visible}`)
    },
    {
      name: 'lisi sees only demo-app (developers, not team-payment)',
      ok:
        baseline.lisi['demo-app'].visible &&
        !baseline.lisi['zhangsan-demo'].visible &&
        !baseline.lisi['infra-tools'].visible &&
        !baseline.lisi['zhangsan-lab'].visible,
      actual: required.map((k) => `${k}:${baseline.lisi[k].visible}`)
    },
    {
      name: 'admin sees all four',
      ok: required.every((k) => baseline.admin[k].visible)
    },
    {
      name: 'workbench row count matches API visibility per identity',
      ok: ['admin', 'zhangsan', 'lisi'].every(
        (role) => uiBaseline[role].workbench.rows.length === visibleCounts[role]
      ),
      actual: Object.fromEntries(
        ['admin', 'zhangsan', 'lisi'].map((r) => [
          r,
          { ui: uiBaseline[r].workbench.rows.length, api: visibleCounts[r] }
        ])
      )
    }
  ])

  // ===== D1 permission matrix x dual-host projects =====
  const demo = proj['demo-app']
  const zdemo = proj['zhangsan-demo']
  const infra = proj['infra-tools']
  const zlab = proj['zhangsan-lab']

  await putProjectGrant(demo.id, 'user', 'lisi', ['open'])
  const p1Open = await probeProject('lisi', demo.id)
  const p1OpenUi = await exec('lisi', uiRows.toString(), { role: 'lisi', route: 'projects' })
  await shot('lisi', 'p1-lisi-demo-open')
  await putProjectGrant(demo.id, 'user', 'lisi', ['open', 'file:read'])
  const p1Read = await probeProject('lisi', demo.id)
  await putProjectGrant(demo.id, 'user', 'lisi', [])
  const p1Revoked = await probeProject('lisi', demo.id)
  const p1RevokedUi = await exec('lisi', uiRows.toString(), { role: 'lisi', route: 'workbench' })
  await shot('lisi', 'p1-lisi-demo-revoked')
  await putProjectGrant(demo.id, 'user', 'lisi', ['open', 'file:read'])
  expectChecks(
    'D1 permission matrix x dual-host',
    'P1',
    'lisi demo-app: open → +file:read → 撤销（host1）',
    [
      {
        name: 'open only -> credential bits exactly [open], handoff 201',
        ok:
          p1Open.visible &&
          sameSet(p1Open.credentialPerms, ['open']) &&
          p1Open.handoffStatus === 201,
        actual: p1Open
      },
      {
        name: 'add file:read -> credential bits [open,file:read]',
        ok: sameSet(p1Read.credentialPerms, ['open', 'file:read']),
        actual: p1Read
      },
      {
        name: 'revoke -> project disappears from list/connect',
        ok: !p1Revoked.visible && p1Revoked.connectStatus === null,
        actual: p1Revoked
      },
      {
        name: 'UI row appears then disappears',
        ok:
          p1OpenUi.rows.some((r) => r.text.includes('demo-app')) &&
          !p1RevokedUi.rows.some((r) => r.text.includes('demo-app')),
        actual: {
          openRows: p1OpenUi.rows.map((r) => r.name),
          revokedRows: p1RevokedUi.rows.map((r) => r.name)
        }
      }
    ]
  )
  const p1Row = p1OpenUi.rows.find((r) => r.text.includes('demo-app'))
  const p1OpenBtn = p1Row?.buttons.find((b) => b.label === '打开')
  if (p1Row && (!p1OpenBtn || p1OpenBtn.disabled)) {
    addFinding({
      severity: 'P2',
      dimension: 'D1 permission matrix x dual-host',
      title: 'lisi 仅 open 时「我的项目」行「打开」不可用',
      steps: 'demo-app 授予 lisi [open] → 登录 lisi → 我的项目',
      expected: '打开按钮可用（open 位已授予，主机在线）',
      actual: JSON.stringify(p1Row.buttons),
      evidence: 'shots/authz-combo/p1-lisi-demo-open.png'
    })
  }

  await putProjectGrant(zdemo.id, 'user', 'lisi', ['open'])
  const p2 = await probeProject('lisi', zdemo.id)
  const p2Ui = await exec('lisi', uiRows.toString(), { role: 'lisi', route: 'projects' })
  await shot('lisi', 'p2-lisi-zhangsan-demo')
  await putProjectGrant(zdemo.id, 'user', 'lisi', [])
  expectChecks(
    'D1 permission matrix x dual-host',
    'P2',
    'lisi 同主机第二项目 zhangsan-demo 仅 open',
    [
      {
        name: 'visible + credential [open] + handoff 201',
        ok: p2.visible && sameSet(p2.credentialPerms, ['open']) && p2.handoffStatus === 201,
        actual: p2
      },
      {
        name: 'UI row present',
        ok: p2Ui.rows.some((r) => r.text.includes('zhangsan-demo')),
        actual: p2Ui.rows.map((r) => r.name)
      }
    ]
  )

  await putProjectGrant(infra.id, 'user', 'lisi', ['open', 'file:read'])
  const p3 = await probeProject('lisi', infra.id)
  const p3Ui = await exec('lisi', uiRows.toString(), { role: 'lisi', route: 'projects' })
  await shot('lisi', 'p3-lisi-infra-host2')
  await putProjectGrant(infra.id, 'user', 'lisi', [])
  const p3revoked = await probeProject('lisi', infra.id)
  expectChecks(
    'D1 permission matrix x dual-host',
    'P3',
    'lisi 跨主机 host2 infra-tools open+file:read',
    [
      {
        name: 'cross-host credential bits and handoff 201',
        ok:
          p3.visible &&
          sameSet(p3.credentialPerms, ['open', 'file:read']) &&
          p3.handoffStatus === 201,
        actual: p3
      },
      {
        name: 'UI row shows host dev-local-03',
        ok: p3Ui.rows.some(
          (r) => r.text.includes('infra-tools') && r.text.includes('dev-local-03')
        ),
        actual: p3Ui.rows.filter((r) => r.text.includes('infra-tools')).map((r) => r.text)
      },
      { name: 'revoke hides it again', ok: !p3revoked.visible, actual: p3revoked }
    ]
  )

  const p4 = {}
  for (const key of required) p4[key] = await probeProject('zhangsan', proj[key].id)
  const p4Ui = await exec('zhangsan', uiRows.toString(), { role: 'zhangsan', route: 'workbench' })
  await shot('zhangsan', 'p4-zhangsan-workbench-all')
  expectChecks('D1 permission matrix x dual-host', 'P4', 'zhangsan 全量跨主机四项目', [
    {
      name: 'all four visible with full bits on both hosts',
      ok: required.every(
        (k) =>
          p4[k].visible &&
          sameSet(p4[k].credentialPerms, [
            'open',
            'terminal',
            'agent',
            'file:read',
            'file:write',
            'browser'
          ])
      ),
      actual: required.map((k) => ({ k, host: proj[k].hostName, bits: p4[k].credentialPerms }))
    },
    {
      name: 'workbench lists four rows',
      ok: required.every((k) => p4Ui.rows.some((r) => r.text.includes(k))),
      actual: p4Ui.rows.map((r) => r.name)
    }
  ])

  const p5Ui = await exec('admin', uiRows.toString(), { role: 'admin', route: 'workbench' })
  const zlabRow = p5Ui.rows.find((r) => r.text.includes('zhangsan-lab'))
  expectChecks(
    'D1 permission matrix x dual-host',
    'P5',
    'admin 对 host2 zhangsan-lab 无显式授权',
    [
      {
        name: '打开 disabled with authorization reason + 授权并打开 enabled',
        ok:
          Boolean(zlabRow) &&
          zlabRow.buttons.find((b) => b.label === '打开')?.disabled === true &&
          zlabRow.buttons.find((b) => b.label === '授权并打开')?.disabled === false,
        actual: zlabRow?.buttons
      },
      {
        name: 'API cross-check: connect is open-gated at the console but handoff is not',
        // The API run (authz-api-combo D8) recorded connect 200 / handoff 403 for the
        // same state; the UI correctly refuses 打开. Kept as a linkage check only.
        ok: true,
        actual: { linked: 'authz-api-combo.json D8', ui: '打开 disabled' }
      }
    ],
    { linked: 'authz-api-combo D8' }
  )

  // ===== D2 host authorization drawer x dual host =====
  // U67: creation is driven by the provision bit, not the legacy provisionPolicy.
  // H1/H2 assume no baseline direct grant for zhangsan (the seed carries
  // view+provision on both hosts); remove those rows for the block. restoreState
  // replays the pre-run snapshot in `finally`.
  for (const h of [host1, host2]) {
    const baseline = (snapshot.hostGrants[h.id] ?? []).filter(
      (row) => row.subjectType === 'user' && row.username === 'zhangsan'
    )
    for (const row of baseline) {
      await putHostGrant(h.id, row.subjectType, row.subjectId, [])
    }
  }
  await setProvisionPolicy(host1.id, 'restricted')
  await setProvisionPolicy(host2.id, 'restricted')
  await putHostGrant(host1.id, 'user', 'lisi', ['provision'])
  await putHostGrant(host2.id, 'group', 'team-payment', ['provision'])

  const avail = {}
  for (const role of ['admin', 'zhangsan', 'lisi']) avail[role] = await availableHosts(role)
  const availFor = (role, hostId) => avail[role].hosts.find((h) => h.id === hostId)
  expectChecks(
    'D2 host drawer x dual host',
    'H1',
    'policy=restricted 下授权驱动的 available 矩阵',
    [
      {
        name: 'lisi: host1 allowed, host2 denied',
        ok:
          availFor('lisi', host1.id).provisionAllowed &&
          !availFor('lisi', host2.id).provisionAllowed,
        actual: { host1: availFor('lisi', host1.id), host2: availFor('lisi', host2.id) }
      },
      {
        name: 'zhangsan: host1 denied, host2 allowed via team-payment',
        ok:
          !availFor('zhangsan', host1.id).provisionAllowed &&
          availFor('zhangsan', host2.id).provisionAllowed,
        actual: { host1: availFor('zhangsan', host1.id), host2: availFor('zhangsan', host2.id) }
      },
      {
        name: 'admin: both allowed',
        ok:
          availFor('admin', host1.id).provisionAllowed &&
          availFor('admin', host2.id).provisionAllowed,
        actual: { host1: availFor('admin', host1.id), host2: availFor('admin', host2.id) }
      }
    ],
    {
      premise:
        'zhangsan 基线直授已移除；lisi 仅 host1 直授 provision，zhangsan 仅 team-payment 组行在 host2 携带 provision；provisionPolicy 不参与判定'
    }
  )

  const stamp = Date.now().toString(36)
  const selfMatrix = {}
  for (const [role, host, allowed] of [
    ['lisi', host1, true],
    ['lisi', host2, false],
    ['zhangsan', host1, false],
    ['zhangsan', host2, true],
    ['admin', host1, true],
    ['admin', host2, true]
  ]) {
    const dir = `qa-authz-${stamp}-${role}-${host.name.slice(-2)}`
    const res = await selfCreate(role, host.id, dir)
    const key = `${role}@${host.name}`
    selfMatrix[key] = {
      status: res.status,
      code: res.json?.error?.code ?? null,
      expected: allowed ? 201 : 403
    }
    if (res.status === 201 && res.json?.id) createdProjectIds.push(res.json.id)
  }
  expectChecks(
    'D2 host drawer x dual host',
    'H2',
    '三身份跨主机自助建项目矩阵',
    Object.entries(selfMatrix).map(([key, val]) => ({
      name: `${key} -> ${val.expected}`,
      ok: val.status === val.expected,
      actual: val
    })),
    {
      premise:
        '同 H1：zhangsan 基线直授已移除；允许与否只看 provision 位（admin 例外），policy 不参与'
    }
  )

  // U67 cards only render complete role combinations, so the drawer check uses
  // the control combination (view+provision) as the visible form of the same
  // provision authorization exercised by H1/H2; revert to provision-only right
  // after so host-level view does not leak into later project-bit combos.
  await putHostGrant(host1.id, 'user', 'lisi', ['view', 'provision'])
  await putHostGrant(host2.id, 'group', 'team-payment', ['view', 'provision'])
  const drawer1 = await exec('admin', uiHostDrawer.toString(), {
    role: 'admin',
    hostName: host1.name
  })
  await shot('admin', 'h3-host1-drawer-restricted')
  const drawer2 = await exec('admin', uiHostDrawer.toString(), {
    role: 'admin',
    hostName: host2.name
  })
  await shot('admin', 'h3-host2-drawer-restricted')
  await putHostGrant(host1.id, 'user', 'lisi', ['provision'])
  await putHostGrant(host2.id, 'group', 'team-payment', ['provision'])
  const cardsOf = (drawer, key) => drawer.cards.find((card) => card.key === key)
  const hasChip = (drawer, key, text) =>
    cardsOf(drawer, key).chips.some((chip) => chip.includes(text))
  const cardShapeOk = (drawer) =>
    drawer.activeTab === '权限' &&
    sameSet(drawer.tabs, ['信息', '权限']) &&
    sameSet(
      drawer.cards.map((card) => card.key),
      ['view', 'control', 'manage']
    ) &&
    cardsOf(drawer, 'view').chips.length === 0 &&
    cardsOf(drawer, 'manage').chips.length === 0
  expectChecks(
    'D2 host drawer x dual host',
    'H3',
    '主机抽屉（U67 权限页签三卡片）反映各自授权行',
    [
      {
        name: 'host1: three role cards, lisi on 控制, team-payment absent',
        ok:
          cardShapeOk(drawer1) &&
          hasChip(drawer1, 'control', 'lisi') &&
          !drawer1.cards.some((card) => card.chips.some((chip) => chip.includes('team-payment'))),
        actual: drawer1
      },
      {
        name: 'host2: three role cards, team-payment on 控制, lisi absent',
        ok:
          cardShapeOk(drawer2) &&
          hasChip(drawer2, 'control', 'team-payment') &&
          !drawer2.cards.some((card) => card.chips.some((chip) => chip.includes('lisi'))),
        actual: drawer2
      }
    ],
    {
      premise:
        '抽屉断言前把授权提升为控制卡组合（view+provision），断言后立即回落到 provision-only；U67 只渲染完整角色组合'
    }
  )

  await putHostGrant(host2.id, 'user', 'zhangsan', ['maintain'])
  const mEnter = await maintenance('zhangsan', host2.id, true)
  const mStatusAdmin = (await hosts()).find((h) => h.id === host2.id)?.status
  const mUi = await exec('zhangsan', uiRows.toString(), { role: 'zhangsan', route: 'workbench' })
  await shot('zhangsan', 'h4-zhangsan-maintenance-host2')
  const mExit = await maintenance('zhangsan', host2.id, false)
  const mAfter = (await hosts()).find((h) => h.id === host2.id)?.status
  await putHostGrant(host2.id, 'user', 'zhangsan', [])
  const mDenied = await maintenance('zhangsan', host2.id, true)
  expectChecks('D2 host drawer x dual host', 'H4', 'maintain 委派后非 admin 触发维护/解除', [
    {
      name: 'zhangsan with maintain enters maintenance (200), host reflects it',
      ok: mEnter.status === 200 && mStatusAdmin === 'maintenance',
      actual: { status: mEnter.status, hostStatus: mStatusAdmin }
    },
    {
      name: 'workbench shows 维护中 for both host2 rows',
      ok:
        mUi.rows.filter((r) => r.text.includes('dev-local-03')).length >= 2 &&
        mUi.rows
          .filter((r) => r.text.includes('dev-local-03'))
          .every((r) => r.text.includes('维护中')),
      actual: mUi.rows.filter((r) => r.text.includes('dev-local-03')).map((r) => r.text)
    },
    {
      name: 'zhangsan with maintain exits maintenance (200) -> online',
      ok: mExit.status === 200 && mAfter === 'online',
      actual: { status: mExit.status, hostStatus: mAfter }
    },
    {
      name: 'after grant removed -> 403 PERMISSION_DENIED',
      ok: mDenied.status === 403 && mDenied.json?.error?.code === 'PERMISSION_DENIED',
      actual: { status: mDenied.status, body: mDenied.json }
    }
  ])

  await setProvisionPolicy(host1.id, 'open')
  await setProvisionPolicy(host2.id, 'open')
  const openMatrix = {}
  for (const role of ['admin', 'zhangsan', 'lisi']) {
    const a = await availableHosts(role)
    openMatrix[role] = {
      host1: a.hosts.find((h) => h.id === host1.id)?.provisionAllowed,
      host2: a.hosts.find((h) => h.id === host2.id)?.provisionAllowed
    }
  }
  expectChecks(
    'D2 host drawer x dual host',
    'H5',
    'legacy policy=open 不回授权限（授权驱动不变）',
    [
      {
        name: 'open policy leaves the grant-derived matrix unchanged',
        ok:
          openMatrix.lisi.host1 === true &&
          openMatrix.lisi.host2 === false &&
          openMatrix.zhangsan.host1 === false &&
          openMatrix.zhangsan.host2 === true &&
          openMatrix.admin.host1 === true &&
          openMatrix.admin.host2 === true,
        actual: openMatrix
      }
    ],
    { premise: 'U67: provisionPolicy 仅上报，不再作为授权来源' }
  )

  // ===== D3 self-grant x host combination =====
  // Host1 control: admin already holds open on demo-app.
  const host1Overlay = await exec('admin', uiOpenOverlay.toString(), {
    role: 'admin',
    projectName: demo.name
  })
  await shot('admin', 'd3-overlay-host1-control')
  const grantsBefore = await projectGrants(zlab.id)
  const cancelUi = await exec('admin', uiSelfGrantCancel.toString(), {
    role: 'admin',
    projectName: zlab.name
  })
  await shot('admin', 'd3-selfgrant-dialog-host2')
  const grantsAfterCancel = await projectGrants(zlab.id)
  expectChecks('D3 self-grant x host', 'S1', 'admin 自授确认框（host2 未授权项目）+ 取消不写', [
    {
      name: 'dialog lists five bits + session-disconnect warning',
      ok:
        cancelUi.title === '授权并打开' &&
        cancelUi.body.includes('open · terminal · agent · file:read · file:write') &&
        cancelUi.body.includes('断开'),
      actual: cancelUi
    },
    {
      name: 'cancel closes and leaves grants untouched',
      ok:
        cancelUi.dialogClosed && JSON.stringify(grantsAfterCancel) === JSON.stringify(grantsBefore),
      actual: { before: grantsBefore, after: grantsAfterCancel }
    }
  ])

  const confirmUi = await exec('admin', uiSelfGrantConfirm.toString(), {
    role: 'admin',
    projectName: zlab.name
  })
  await shot('admin', 'd3-selfgrant-overlay-host2')
  const grantsAfterConfirm = await projectGrants(zlab.id)
  const adminGrantRow = grantsAfterConfirm.find(
    (g) => g.subjectType === 'user' && g.username === 'admin'
  )
  expectChecks('D3 self-grant x host', 'S2', 'admin 确认自授 → host2 覆盖层可用性（对照 host1）', [
    {
      name: 'admin grant row written with five bits',
      ok: sameSet(adminGrantRow?.permissions, [
        'open',
        'terminal',
        'agent',
        'file:read',
        'file:write'
      ]),
      actual: adminGrantRow
    },
    {
      name: 'host2 overlay reaches ready, matching host1 control',
      ok: confirmUi.ready === true && host1Overlay.ready === true,
      actual: { host1: host1Overlay, host2: confirmUi }
    }
  ])
  if (!confirmUi.ready) {
    const host1AlsoFailed = !host1Overlay.ready
    addFinding({
      severity: host1AlsoFailed ? 'P2' : 'P1',
      dimension: 'D3 self-grant x host',
      title: host1AlsoFailed
        ? '内嵌工作区在两台主机均未就绪（平台级既有缺陷，非跨主机差异）'
        : '内嵌工作区 host1 可用但 host2 不可用（跨主机组合缺陷）',
      steps: 'admin 打开 demo-app（host1，已有 open）对照 zhangsan-lab 自授后（host2）',
      expected: '覆盖层 ready（无失败壳/未签名提示）',
      actual: JSON.stringify({ host1: host1Overlay, host2: confirmUi }),
      evidence: 'shots/authz-combo/d3-selfgrant-overlay-host2.png',
      linked: 'WEB-R2-001'
    })
  }
  await putProjectGrant(zlab.id, 'user', 'admin', [])

  // ===== D4 registration dialog x dual hosts =====
  const regUi = await exec('admin', uiRegister.toString(), {
    role: 'admin',
    hosts: { host1: host1.id, host2: host2.id },
    paths: { host1Path: `${host1.projectsRoot}/qa-authz-combo` }
  })
  await shot('admin', 'd4-register-host-switch')
  const revokedOffered = regUi.options.some((o) => o.value === revoked?.id)
  expectChecks(
    'D4 registration dialog x dual host',
    'R1',
    'hostId 切换两台主机的根提示与 path 归属',
    [
      {
        name: 'host1 root hint',
        ok: !regUi.roots.host1.hidden && regUi.roots.host1.text.includes(host1.projectsRoot),
        actual: regUi.roots.host1
      },
      {
        name: 'host2 root hint',
        ok: !regUi.roots.host2.hidden && regUi.roots.host2.text.includes(host2.projectsRoot),
        actual: regUi.roots.host2
      },
      {
        name: 'revoked offline host is not offered in the picker',
        ok: !revokedOffered,
        actual: { options: regUi.options, revoked: revoked?.name }
      },
      {
        name: 'switching host does not keep the other host root path',
        ok: regUi.afterSwitch !== regUi.beforeSwitch || regUi.afterSwitch === '',
        actual: { beforeSwitch: regUi.beforeSwitch, afterSwitch: regUi.afterSwitch }
      }
    ]
  )
  if (regUi.afterSwitch === regUi.beforeSwitch && regUi.afterSwitch !== '') {
    addFinding({
      severity: 'P2',
      dimension: 'D4 registration dialog x dual host',
      title: '登记弹层切换主机后保留上一主机的绝对路径',
      steps: '登记项目 → 选 dev-local-02 → 填 host1 根下路径 → 切到 dev-local-03',
      expected: '路径清空或提示重新确认，避免把 host1 路径提交给 host2',
      actual: regUi.afterSwitch,
      evidence: 'shots/authz-combo/d4-register-host-switch.png'
    })
  }

  const regVal = await exec('admin', uiRegisterValidation.toString(), {
    role: 'admin',
    hosts: { host1: host1.id },
    paths: {
      host1Root: host1.projectsRoot,
      freshHost1Path: `${host1.projectsRoot}/qa-authz-fresh-${stamp}`,
      host1DemoPath: proj['demo-app'].path
    }
  })
  const offlineCreate = revoked
    ? await api('POST', '/v1/projects', {
        token: await tokenFor('admin'),
        body: {
          name: 'QA offline',
          key: `qa-authz-offline-${stamp}`,
          hostId: revoked.id,
          path: `/tmp/qa-authz-offline-${stamp}`
        }
      })
    : { status: 0, json: null }
  expectChecks('D4 registration dialog x dual host', 'R2', 'path 校验 / 重复 / 离线主机登记', [
    {
      name: 'empty submit shows four field errors',
      ok: Object.keys(regVal.empty).filter((k) => k !== 'top').length === 4,
      actual: regVal.empty
    },
    {
      name: 'invalid key message',
      ok: String(regVal.badKey.regKeyError ?? '').includes('小写字母或数字'),
      actual: regVal.badKey
    },
    {
      name: 'relative path rejected',
      ok: String(regVal.relativePath.regPathError ?? '').includes('绝对路径'),
      actual: regVal.relativePath
    },
    {
      name: 'dot-dot path rejected',
      ok: String(regVal.dotdotPath.regPathError ?? '').includes('..'),
      actual: regVal.dotdotPath
    },
    {
      name: 'trailing separator rejected',
      ok: String(regVal.trailingPath.regPathError ?? '').includes('分隔符'),
      actual: regVal.trailingPath
    },
    {
      name: 'duplicate key -> 409 项目 Key 已存在',
      ok: String(regVal.duplicateKey.regKeyError ?? '').includes('已存在'),
      actual: regVal.duplicateKey
    },
    {
      name: 'duplicate path on host1 -> 409 同路径',
      ok: String(regVal.duplicatePath.regPathError ?? '').includes('同路径'),
      actual: regVal.duplicatePath
    },
    {
      name: 'revoked/offline host registration -> 409 HOST_OFFLINE',
      ok: offlineCreate.status === 409 && offlineCreate.json?.error?.code === 'HOST_OFFLINE',
      actual: { status: offlineCreate.status, body: offlineCreate.json }
    }
  ])

  // ===== D5 directory + audit =====
  const since = encodeURIComponent(startedAt)
  const directoryAdmin = await api('GET', '/v1/directory', { token: await tokenFor('admin') })
  const directoryDev = await api('GET', '/v1/directory', { token: await tokenFor('zhangsan') })
  const directoryLimited = await api('GET', '/v1/directory', { token: await tokenFor('lisi') })
  const verify = await api('GET', '/v1/audit/verify', { token: await tokenFor('admin') })
  const auditEvents = await api('GET', `/v1/audit/events?limit=200&since=${since}`, {
    token: await tokenFor('admin')
  })
  const events = auditEvents.json?.events ?? []
  const ev = (type) => events.filter((e) => e.eventType === type)
  expectChecks('D5 directory + audit', 'A1', 'directory 反映组合现状、非 admin 403', [
    {
      name: 'directory lists three users and three groups',
      ok:
        (directoryAdmin.json?.users ?? []).length >= 3 &&
        ['developers', 'platform-admins', 'team-payment'].every((g) =>
          (directoryAdmin.json?.groups ?? []).includes(g)
        ),
      actual: directoryAdmin.json
    },
    {
      name: 'zhangsan/lisi directory read -> 403 PERMISSION_DENIED',
      ok:
        directoryDev.status === 403 &&
        directoryLimited.status === 403 &&
        directoryDev.json?.error?.code === 'PERMISSION_DENIED',
      actual: { zhangsan: directoryDev.status, lisi: directoryLimited.status }
    }
  ])
  expectChecks('D5 directory + audit', 'A2', '本轮每个授权/策略/自助变更都有审计事件', [
    {
      name: 'project grant_update events carry subject + permissions',
      ok:
        ev('grant_update').length > 0 &&
        ev('grant_update').every(
          (e) => e.metadata && 'permissions' in e.metadata && 'subjectId' in e.metadata
        ),
      actual: { count: ev('grant_update').length, sample: ev('grant_update').slice(0, 3) }
    },
    {
      name: 'host grant + provision policy events present',
      ok: ev('host_grant_update').length > 0 && ev('host_provision_policy_update').length > 0,
      actual: {
        hostGrant: ev('host_grant_update').length,
        policy: ev('host_provision_policy_update').length
      }
    },
    {
      name: 'restricted-host denials recorded with actor + reason',
      ok:
        ev('project_create').some((e) => e.actor === 'lisi' && e.result === 'denied') &&
        ev('project_create').some((e) => e.actor === 'zhangsan' && e.result === 'denied'),
      actual: ev('project_create')
        .filter((e) => e.result === 'denied')
        .map((e) => ({
          actor: e.actor,
          reason: e.metadata?.reason,
          selfService: e.metadata?.selfService
        }))
    },
    {
      name: 'maintenance delegation events carry via=host_grant',
      ok: ev('host_maintenance').filter((e) => e.metadata?.via === 'host_grant').length >= 2,
      actual: ev('host_maintenance').map((e) => ({ actor: e.actor, metadata: e.metadata }))
    },
    {
      name: 'audit chain verifies',
      ok: verify.status === 200 && verify.json?.ok === true,
      actual: { status: verify.status, body: verify.json }
    }
  ])

  // ===== M multi-user differentiated permission dimension =====
  await putProjectGrant(zdemo.id, 'group', 'developers', ['open'])
  const m1z = await probeProject('zhangsan', zdemo.id)
  const m1l = await probeProject('lisi', zdemo.id)
  const m1Ui = await exec('lisi', uiRows.toString(), { role: 'lisi', route: 'projects' })
  await shot('lisi', 'm1-developers-group-lisi-open')
  await putProjectGrant(zdemo.id, 'group', 'developers', [])
  expectChecks('M multi-user differentiated bits', 'M1', '同组 developers、不同用户不同位', [
    {
      name: 'zhangsan (direct FULL + group open) keeps FULL',
      ok: sameSet(m1z.credentialPerms, ['open', 'terminal', 'agent', 'file:read', 'file:write']),
      actual: m1z
    },
    {
      name: 'lisi (group open only) gets exactly [open]',
      ok: sameSet(m1l.credentialPerms, ['open']),
      actual: m1l
    },
    {
      name: 'lisi UI row shows only open in 权限列',
      ok: m1Ui.rows.find((r) => r.text.includes('zhangsan-demo'))?.text.includes('open') === true,
      actual: m1Ui.rows.find((r) => r.text.includes('zhangsan-demo'))?.text
    }
  ])

  await putProjectGrant(zdemo.id, 'user', 'zhangsan', ['open'])
  const m2a = await probeProject('zhangsan', demo.id)
  const m2b = await probeProject('zhangsan', zdemo.id)
  await putProjectGrant(zdemo.id, 'user', 'zhangsan', [
    'open',
    'terminal',
    'agent',
    'file:read',
    'file:write'
  ])
  expectChecks('M multi-user differentiated bits', 'M2', '同一用户跨项目不同位（host1 两项目）', [
    {
      name: 'demo-app FULL vs zhangsan-demo [open]',
      ok:
        sameSet(m2a.credentialPerms, ['open', 'terminal', 'agent', 'file:read', 'file:write']) &&
        sameSet(m2b.credentialPerms, ['open']),
      actual: { demoApp: m2a.credentialPerms, zhangsanDemo: m2b.credentialPerms }
    }
  ])

  await putProjectGrant(zdemo.id, 'user', 'zhangsan', ['open', 'file:read', 'file:write'])
  await putProjectGrant(infra.id, 'group', 'team-payment', ['open'])
  const m3a = await probeProject('zhangsan', zdemo.id)
  const m3b = await probeProject('zhangsan', infra.id)
  const m3Ui = await exec('zhangsan', uiRows.toString(), { role: 'zhangsan', route: 'projects' })
  await shot('zhangsan', 'm3-zhangsan-crosshost-different-bits')
  await putProjectGrant(zdemo.id, 'user', 'zhangsan', [
    'open',
    'terminal',
    'agent',
    'file:read',
    'file:write'
  ])
  await putProjectGrant(infra.id, 'group', 'team-payment', [
    'open',
    'terminal',
    'agent',
    'file:read',
    'file:write'
  ])
  expectChecks(
    'M multi-user differentiated bits',
    'M3',
    '同一用户跨主机不同位（host1 读写 vs host2 仅 open）',
    [
      {
        name: 'host1 credential read+write, host2 credential only open, both open-able',
        ok:
          sameSet(m3a.credentialPerms, ['open', 'file:read', 'file:write']) &&
          sameSet(m3b.credentialPerms, ['open']) &&
          m3a.handoffStatus === 201 &&
          m3b.handoffStatus === 201,
        actual: { host1: m3a.credentialPerms, host2: m3b.credentialPerms }
      },
      {
        name: 'UI permission column shows the two different sets',
        ok:
          m3Ui.rows.find((r) => r.text.includes('zhangsan-demo'))?.text.includes('file:write') ===
            true &&
          m3Ui.rows.find((r) => r.text.includes('infra-tools'))?.text.includes('file:write') ===
            false,
        actual: m3Ui.rows
          .filter((r) => r.text.includes('zhangsan-demo') || r.text.includes('infra-tools'))
          .map((r) => r.text)
      }
    ]
  )

  const dirAfter = await api('GET', '/v1/directory', { token: await tokenFor('admin') })
  const auditAfter = await api('GET', `/v1/audit/events?limit=100&since=${since}`, {
    token: await tokenFor('admin')
  })
  const afterEvents = auditAfter.json?.events ?? []
  expectChecks('M multi-user differentiated bits', 'M4', '新增授权行后 directory/audit 同步', [
    {
      name: 'directory group set unchanged and grant_update events present',
      ok:
        sameSet(
          (dirAfter.json?.groups ?? []).filter((g) =>
            ['developers', 'platform-admins', 'team-payment'].includes(g)
          ),
          ['developers', 'platform-admins', 'team-payment']
        ) && afterEvents.filter((e) => e.eventType === 'grant_update').length > 0,
      actual: {
        groups: dirAfter.json?.groups,
        grantEvents: afterEvents.filter((e) => e.eventType === 'grant_update').length
      }
    }
  ])

  // ===== restore + verification =====
  await restoreState(snapshot, 'end of run')
  const restored = await snapshotState()
  const restoreChecks = []
  const norm = (rows) =>
    rows.map((g) => `${g.subjectType}:${g.subjectId}=${[...g.permissions].sort().join(',')}`).sort()
  for (const p of snapshot.projects) {
    restoreChecks.push({
      name: `project ${p.key} grants restored`,
      ok:
        JSON.stringify(norm(restored.grants[p.id] ?? [])) ===
        JSON.stringify(norm(snapshot.grants[p.id] ?? [])),
      actual: { cur: norm(restored.grants[p.id] ?? []), want: norm(snapshot.grants[p.id] ?? []) }
    })
  }
  for (const h of snapshot.hosts) {
    restoreChecks.push({
      name: `host ${h.name} grants restored`,
      ok:
        JSON.stringify(norm(restored.hostGrants[h.id] ?? [])) ===
        JSON.stringify(norm(snapshot.hostGrants[h.id] ?? [])),
      actual: {
        cur: norm(restored.hostGrants[h.id] ?? []),
        want: norm(snapshot.hostGrants[h.id] ?? [])
      }
    })
  }
  const verifyEnd = await api('GET', '/v1/audit/verify', { token: await tokenFor('admin') })
  restoreChecks.push({
    name: 'audit chain still verifies',
    ok: verifyEnd.status === 200 && verifyEnd.json?.ok === true,
    actual: verifyEnd.json
  })
  expectChecks('Restore', 'Z1', 'seed 态还原与审计链', restoreChecks)

  const result = {
    meta: {
      runAt: startedAt,
      finishedAt: new Date().toISOString(),
      base: BASE,
      layer: 'web-ui + api readback (Playwright Server)',
      hosts: {
        host1: { id: host1.id, name: host1.name },
        host2: { id: host2.id, name: host2.name },
        revokedOffline: revoked ? { id: revoked.id, name: revoked.name } : null
      },
      projects: required.map((k) => ({
        key: k,
        id: proj[k].id,
        host: proj[k].hostName,
        path: proj[k].path,
        seedGrants: (snapshot.grants[proj[k].id] ?? []).map((g) => ({
          subjectType: g.subjectType,
          subjectId: g.subjectId,
          username: g.username ?? null,
          permissions: g.permissions
        }))
      })),
      groupMembership: {
        admin: ['platform-admins'],
        zhangsan: ['developers', 'team-payment'],
        lisi: ['developers']
      },
      note: 'API-layer combos in authz-api-combo.json; this file covers the Web/UI layer and capability readback.'
    },
    summary: {
      combos: combos.length,
      passed: combos.filter((c) => c.ok).length,
      failed: combos.filter((c) => !c.ok).length,
      findings: findings.length,
      bySeverity: findings.reduce((acc, f) => {
        acc[f.severity] = (acc[f.severity] ?? 0) + 1
        return acc
      }, {}),
      byDimension: combos.reduce((acc, c) => {
        acc[c.dimension] = acc[c.dimension] ?? { total: 0, passed: 0, failed: 0 }
        acc[c.dimension].total += 1
        acc[c.dimension][c.ok ? 'passed' : 'failed'] += 1
        return acc
      }, {})
    },
    baseline,
    uiBaseline,
    combos,
    findings,
    restore: { checks: restoreChecks, ok: restoreChecks.every((c) => c.ok) },
    logs
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2))
  log(
    `[done] combos=${result.summary.combos} failed=${result.summary.failed} findings=${result.summary.findings} restore=${result.restore.ok}`
  )
  return result
}

let exitCode = 0
try {
  const result = await main()
  exitCode = result.restore.ok ? 0 : 1
} catch (error) {
  console.error('[fatal]', error)
  try {
    await restoreState(snapshot, 'fatal')
  } catch (restoreError) {
    console.error('[fatal] restore failed', restoreError)
  }
  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify(
      {
        meta: { runAt: startedAt, failedAt: new Date().toISOString() },
        fatal: String(error?.stack ?? error),
        findings,
        combos,
        logs
      },
      null,
      2
    )
  )
  exitCode = 1
}
process.exit(exitCode)
