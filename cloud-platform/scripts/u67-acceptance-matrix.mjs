#!/usr/bin/env node
/**
 * U67-6 acceptance matrix against the deployed local platform (default :18787).
 *
 * Four identities x two hosts:
 * - admin: host permission tab mapping (GET grants -> 查看/控制/管理) and the
 *   add/adjust/remove write path on both hosts; project tab on zhangsan-demo.
 * - zhangsan (developer) / lisi (read-only): route gates and direct-API 403.
 * - auditor: lisi promoted via the users page contract, audit visible, admin
 *   pages hidden, grants writes 403. The role is restored in `finally`.
 *
 * Every mutation is reverted: probe rows start and end empty, and lisi's role
 * returns to developer. Evidence JSON + DOM snapshots go to
 * cloud-platform/evidence/u67-authz-refactor/<stamp>/ (gitignored).
 *
 * Run: NODE_EXTRA_CA_CERTS=$HOME/orca-local-env/tls/ca.pem \
 *      node cloud-platform/scripts/u67-acceptance-matrix.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadWebConsolePage } from '../test/e2e/web-console-page.ts'

const HERE = import.meta.dirname
const ROOT = path.resolve(HERE, '..')
const BASE = process.env.ORCA_LOCAL_PLATFORM_URL || 'https://127.0.0.1:18787'
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const OUT = path.join(ROOT, 'evidence/u67-authz-refactor', STAMP)
mkdirSync(OUT, { recursive: true })

const PEOPLE = {
  admin: { username: 'admin', password: 'Adm1n!' },
  zhangsan: { username: 'zhangsan', password: 'Passw0rd!' },
  lisi: { username: 'lisi', password: 'Passw0rd!' }
}
const results = {
  startedAt: new Date().toISOString(),
  base: BASE,
  combos: {},
  gates: {},
  defects: []
}
const tokens = {}
let lisiId = ''

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sorted = (list) => [...new Set(list)].sort()
const subjectOf = (row) => row.username ?? row.subjectId

async function api(pathname, { token, method = 'GET', body } = {}) {
  const init = {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${BASE}${pathname}`, init)
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function login(name) {
  const res = await api('/v1/auth/login', { method: 'POST', body: PEOPLE[name] })
  if (res.status !== 200) {
    throw new Error(`login ${name} failed: ${JSON.stringify(res.body)}`)
  }
  tokens[name] = res.body.accessToken
  return res.body
}

function save(name, data) {
  writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2))
}

function saveDom(page, name) {
  writeFileSync(
    path.join(OUT, `${name}.html`),
    page.window.document.querySelector('#content')?.innerHTML ?? ''
  )
}

// ---- page helpers (same selectors the e2e suites drive) ----
const drawer = (page) => page.window.document.querySelector('.drawer')
const permCard = (page, key) =>
  drawer(page).querySelector(`[data-perm-cards] > [data-card="${key}"]`)
const projectCard = (page, key) =>
  page.window.document.querySelector(`#projectPermCards [data-perm-cards] > [data-card="${key}"]`)
const topDialog = (page) =>
  [...page.window.document.querySelectorAll('.dialog-backdrop .dialog')].at(-1)
const cardSubjects = (card) =>
  [...card.querySelectorAll('.perm-chip')].map((chip) => chip.querySelector('.mono')?.textContent)
const chipOf = (card, name) =>
  [...card.querySelectorAll('.perm-chip')].find(
    (chip) => chip.querySelector('.mono')?.textContent === name
  )

async function openHostPermTab(page, hostId) {
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('hosts')
  const button = [...page.window.document.querySelectorAll('button[data-host]')].find(
    (candidate) => candidate.dataset.host === hostId
  )
  if (!button) {
    throw new Error(`hosts page has no row for ${hostId}`)
  }
  button.click()
  await page.settle()
  const tab = drawer(page)?.querySelector('[data-auth-tab="perms"]')
  if (!tab) {
    throw new Error('host drawer has no 权限 tab')
  }
  tab.click()
  await page.settle()
}

async function addToCard(page, card, subjectType, subject) {
  card.querySelector('[data-perm-subject]').value = subject
  const select = card.querySelector('[data-perm-type]')
  select.value = subjectType
  select.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  card.querySelector('[data-perm-add]').click()
  await page.settle()
}

const HOST_CARD_KEYS = ['view', 'control', 'manage', 'other']

function hostCardMap(page) {
  const map = {}
  for (const key of ['view', 'control', 'manage']) {
    map[key] = cardSubjects(permCard(page, key))
  }
  // 无卡片认领的位组合落到「其他位组合」卡（与 app.js leftovers 同源）。
  const other = drawer(page).querySelector('[data-perm-cards] > [data-card="other"]')
  map.other = other ? cardSubjects(other) : []
  return map
}

/** 与 app.js hostRoleOf 严格同源：未匹配任何卡位的行落 other（不是回落 view）。 */
function expectedCard(permissions) {
  const has = (bit) => permissions.includes(bit)
  if (has('provision') && has('maintain')) {
    return 'manage'
  }
  if (has('view') && has('provision')) {
    return 'control'
  }
  if (has('view')) {
    return 'view'
  }
  return 'other'
}

async function hostGrants(hostId, token = tokens.admin) {
  const res = await api(`/v1/hosts/${hostId}/grants`, { token })
  if (res.status !== 200) {
    throw new Error(`GET host grants ${hostId}: ${JSON.stringify(res.body)}`)
  }
  return res.body.grants
}

async function projectGrants(projectId, token = tokens.admin) {
  const res = await api(`/v1/projects/${projectId}/grants`, { token })
  if (res.status !== 200) {
    throw new Error(`GET project grants: ${JSON.stringify(res.body)}`)
  }
  return res.body.grants
}

async function hostCombination(host, subject) {
  const grantsPath = `/v1/hosts/${host.id}/grants`
  const page = loadWebConsolePage(BASE)
  await openHostPermTab(page, host.id)
  const before = await hostGrants(host.id)
  const uiBefore = hostCardMap(page)
  // 严格两向断言：每条 API 行恰落一张预期卡，且 UI 上的每个主体都有对应 API 行。
  const uiCardsBySubject = {}
  for (const key of HOST_CARD_KEYS) {
    for (const subject of uiBefore[key]) {
      ;(uiCardsBySubject[subject] ??= []).push(key)
    }
  }
  const mapped = before.map((row) => {
    const subject = row.username ?? row.subjectId
    const uiCards = uiCardsBySubject[subject] ?? []
    return {
      subject,
      permissions: row.permissions,
      expectedCard: expectedCard(row.permissions),
      uiCards,
      uiCard: uiCards.length === 1 ? uiCards[0] : null
    }
  })
  const apiSubjects = new Set(mapped.map((row) => row.subject))
  const uiOnlySubjects = Object.keys(uiCardsBySubject).filter(
    (subject) => !apiSubjects.has(subject)
  )
  const mappingOk =
    mapped.every((row) => row.uiCards.length === 1 && row.uiCards[0] === row.expectedCard) &&
    uiOnlySubjects.length === 0
  if (!mappingOk) {
    results.defects.push({
      severity: 'P1',
      title: `host card mapping mismatch on ${host.name}`,
      detail: {
        rows: mapped
          .filter((row) => row.uiCards.length !== 1 || row.uiCards[0] !== row.expectedCard)
          .map((row) => ({
            subject: row.subject,
            expectedCard: row.expectedCard,
            uiCards: row.uiCards
          })),
        uiOnlySubjects
      }
    })
  }
  save(`admin-${host.name}-host-tab.json`, { host, before, uiBefore, mapped, mappingOk })
  saveDom(page, `admin-${host.name}-host-perm`)

  // add to 查看 -> remove (only card) -> add again -> adjust to 控制 -> remove
  const rowOf = (rows) =>
    rows.find((candidate) => (candidate.username ?? candidate.subjectId) === subject)

  await addToCard(page, permCard(page, 'view'), 'user', subject)
  let rows = await hostGrants(host.id)
  let row = rowOf(rows)
  const addOk = sorted(row?.permissions ?? []).join(',') === 'view'
  const addChipOk = cardSubjects(permCard(page, 'view')).includes(subject)

  // AC-U67-3: a 查看-only subject's removal is the whole-row danger confirm.
  chipOf(permCard(page, 'view'), subject)?.querySelector('.perm-chip-x')?.click()
  await page.settle()
  const viewRemoveCopy = topDialog(page)?.textContent ?? ''
  topDialog(page)?.querySelector('[data-action="0"]')?.click()
  await page.settle()
  rows = await hostGrants(host.id)
  const viewRemoveOk =
    !rowOf(rows) && /移除全部授权/.test(viewRemoveCopy) && /≤60 秒/.test(viewRemoveCopy)

  await addToCard(page, permCard(page, 'view'), 'user', subject)
  await addToCard(page, permCard(page, 'control'), 'user', subject)
  const adjustDialog = topDialog(page)?.textContent ?? ''
  topDialog(page)?.querySelector('[data-action="0"]')?.click()
  await page.settle()
  rows = await hostGrants(host.id)
  row = rowOf(rows)
  const adjustOk = sorted(row?.permissions ?? []).join(',') === 'provision,view'
  const adjustCardOk =
    cardSubjects(permCard(page, 'control')).includes(subject) &&
    !cardSubjects(permCard(page, 'view')).includes(subject)
  const adjustCopyOk = /只读 → 全权/.test(adjustDialog)

  // Removing the control chip empties the row: danger confirm, then gone.
  chipOf(permCard(page, 'control'), subject)?.querySelector('.perm-chip-x')?.click()
  await page.settle()
  const dangerCopy = topDialog(page)?.textContent ?? ''
  topDialog(page)?.querySelector('[data-action="0"]')?.click()
  await page.settle()
  rows = await hostGrants(host.id)
  const removeOk = !rowOf(rows)
  const dangerOk = /移除全部授权/.test(dangerCopy) && /≤60 秒/.test(dangerCopy)

  const combo = {
    host: host.name,
    mappingOk,
    writePath: {
      addOk,
      addChipOk,
      viewRemoveOk,
      adjustOk,
      adjustCardOk,
      adjustCopyOk,
      removeOk,
      dangerOk
    },
    residualRows: rows,
    calls: page.calls().filter((call) => call.includes(grantsPath))
  }
  save(`admin-${host.name}-host-writepath.json`, combo)
  return combo
}

async function projectCombination(project, subject) {
  const page = loadWebConsolePage(BASE)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('workbench')
  const row = [...page.window.document.querySelectorAll('#content tbody tr')].find((candidate) =>
    candidate.textContent?.includes(project.key)
  )
  const detail = [...(row?.querySelectorAll('button, a') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === '详情'
  )
  detail?.click()
  await page.settle()
  page.window.document.querySelector('.dialog-backdrop [data-auth-tab="perms"]')?.click()
  await page.settle()

  const cards = [
    ...page.window.document.querySelectorAll('#projectPermCards [data-perm-cards] > .perm-card')
  ]
  const cardKeys = cards.map((card) => card.dataset.card)
  const derived = projectCard(page, 'derived')
  const derivedText = derived?.textContent ?? ''
  const derivedOk = Boolean(
    derived &&
    !derived.querySelector('[data-perm-add]') &&
    !derived.querySelector('.perm-chip-x') &&
    /主机推导 · 只读/.test(derivedText) &&
    /项目级无「管理」权限位/.test(derivedText) &&
    derived.querySelector('[data-open-host-detail]')?.textContent?.trim() === '前往主机详情弹框 →'
  )
  const header = page.window.document.querySelector('#projectPermCards > .note')?.textContent ?? ''
  const headerOk = /FR-9\.11③/.test(header)
  saveDom(page, `admin-project-${project.key}-perm`)

  await addToCard(page, projectCard(page, 'view'), 'user', subject)
  let rows = await projectGrants(project.id)
  let grant = rows.find((candidate) => (candidate.username ?? candidate.subjectId) === subject)
  const viewOk = sorted(grant?.permissions ?? []).join(',') === 'file:read,open'
  const viewChipOk = cardSubjects(projectCard(page, 'view')).includes(subject)

  await addToCard(page, projectCard(page, 'control'), 'user', subject)
  const adjustDialog = topDialog(page)?.textContent ?? ''
  topDialog(page)?.querySelector('[data-action="0"]')?.click()
  await page.settle()
  rows = await projectGrants(project.id)
  grant = rows.find((candidate) => (candidate.username ?? candidate.subjectId) === subject)
  const controlOk =
    sorted(grant?.permissions ?? []).join(',') ===
    'agent,browser,download,file:read,file:write,open,terminal'
  // §2.3 project cards are disjoint bit layers (view=open+file:read,
  // control=5 op bits), so a full row legitimately renders in both cards.
  const controlChipOk = cardSubjects(projectCard(page, 'control')).includes(subject)
  const viewLayerKept = cardSubjects(projectCard(page, 'view')).includes(subject)
  const copyOk = /查看 → 查看\+控制/.test(adjustDialog)

  chipOf(projectCard(page, 'control'), subject)?.querySelector('.perm-chip-x')?.click()
  await page.settle()
  rows = await projectGrants(project.id)
  grant = rows.find((candidate) => (candidate.username ?? candidate.subjectId) === subject)
  const downgradeOk = sorted(grant?.permissions ?? []).join(',') === 'file:read,open'

  chipOf(projectCard(page, 'view'), subject)?.querySelector('.perm-chip-x')?.click()
  await page.settle()
  const dangerCopy = topDialog(page)?.textContent ?? ''
  topDialog(page)?.querySelector('[data-action="0"]')?.click()
  await page.settle()
  rows = await projectGrants(project.id)
  const removeOk = !rows.some(
    (candidate) => (candidate.username ?? candidate.subjectId) === subject
  )

  const combo = {
    project: project.key,
    cardKeys,
    derivedOk,
    headerOk,
    writePath: {
      viewOk,
      viewChipOk,
      controlOk,
      controlChipOk,
      viewLayerKept,
      copyOk,
      downgradeOk,
      removeOk
    },
    dangerOk: /≤60 秒/.test(dangerCopy),
    residualRows: rows
  }
  save(`admin-project-${project.key}.json`, combo)
  return combo
}

async function uiGate(person, host) {
  const page = loadWebConsolePage(BASE)
  await page.settle()
  await page.submitLogin(person, PEOPLE[person].password)
  await page.clickNav('hosts')
  const content = page.text('#content')
  const hostCalls = page.calls().filter((call) => call === 'GET /v1/hosts').length
  const gate = {
    identity: person,
    host: host.name,
    forbiddenPage: /无权访问/.test(content),
    drawer: Boolean(drawer(page)),
    hostCalls,
    grantCalls: page.calls().filter((call) => call.includes(`/v1/hosts/${host.id}/grants`)).length
  }
  save(`gate-${person}-${host.name}.json`, gate)
  return gate
}

async function apiGate(person, host) {
  const token = tokens[person]
  const get = await api(`/v1/hosts/${host.id}/grants`, { token })
  const put = await api(`/v1/hosts/${host.id}/grants`, {
    token,
    method: 'PUT',
    body: { subjectType: 'user', subjectId: person, permissions: ['view'] }
  })
  return { identity: person, host: host.name, get: get.status, put: put.status }
}

try {
  await login('admin')
  await login('zhangsan')
  await login('lisi')
  const users = (await api('/v1/users', { token: tokens.admin })).body.users
  lisiId = users.find((user) => user.username === 'lisi').id

  const hostList = (await api('/v1/hosts', { token: tokens.admin })).body.hosts
  const hosts = ['dev-local-02', 'dev-local-03'].map((name) => {
    const host = hostList.find((candidate) => candidate.name === name)
    if (!host) {
      throw new Error(`host ${name} missing`)
    }
    return host
  })
  const projects = (await api('/v1/projects', { token: tokens.admin })).body.projects
  const zdemo = projects.find((project) => project.key === 'zhangsan-demo')
  if (!zdemo) {
    throw new Error('zhangsan-demo project missing')
  }

  // ---- admin: host tab mapping + write path on both hosts ----
  results.combos.hostDev02 = await hostCombination(hosts[0], 'lisi')
  results.combos.hostDev03 = await hostCombination(hosts[1], 'lisi')
  results.combos.projectZdemo = await projectCombination(zdemo, 'lisi')

  // ---- gates: zhangsan / lisi (developers) ----
  results.gates.zhangsanDev02 = await uiGate('zhangsan', hosts[0])
  results.gates.zhangsanDev03 = await uiGate('zhangsan', hosts[1])
  results.gates.lisiDev02 = await uiGate('lisi', hosts[0])
  results.gates.lisiDev03 = await uiGate('lisi', hosts[1])
  results.gates.apiZhangsan = await Promise.all(hosts.map((host) => apiGate('zhangsan', host)))
  results.gates.apiLisi = await Promise.all(hosts.map((host) => apiGate('lisi', host)))

  // read-only visibility: lisi sees only explicitly granted projects, no terminal
  const lisiProjects = (await api('/v1/projects', { token: tokens.lisi })).body.projects
  results.gates.lisiVisibility = {
    projects: lisiProjects.map((project) => ({
      key: project.key,
      permissions: project.permissions
    })),
    onlyExplicit: lisiProjects.every((project) => project.key === 'demo-app'),
    noTerminal: lisiProjects.every((project) => !project.permissions.includes('terminal'))
  }

  // ---- auditor: promote lisi, verify the audit-only surface, restore ----
  const promote = await api(`/v1/users/${lisiId}/roles`, {
    token: tokens.admin,
    method: 'PUT',
    body: { role: 'auditor' }
  })
  const auditorLogin = await login('lisi')
  const auditorPage = loadWebConsolePage(BASE)
  await auditorPage.settle()
  await auditorPage.submitLogin('lisi', 'Passw0rd!')
  const navs = [...auditorPage.window.document.querySelectorAll('[data-route]')].map((item) => ({
    route: item.dataset.route,
    hidden: item.hidden ?? item.classList.contains('hidden')
  }))
  await auditorPage.clickNav('audit')
  const auditVisible = /审计/.test(auditorPage.text('#content'))
  await auditorPage.clickNav('users')
  const usersForbidden = /无权访问|无权限/.test(auditorPage.text('#content'))
  const auditApi = await api('/v1/audit/events?limit=1', { token: tokens.lisi })
  const usersApi = await api('/v1/users', { token: tokens.lisi })
  const auditorHostPut = await api(`/v1/hosts/${hosts[0].id}/grants`, {
    token: tokens.lisi,
    method: 'PUT',
    body: { subjectType: 'user', subjectId: 'lisi', permissions: ['view'] }
  })
  // 项目 grants 写入口口径（审计 O3）：不可见项目 → 404（资源隐藏，不泄露存在性）；
  // 可见但无权限 → 403。下面用的是 lisi 可见的 zdemo，故预期 403；主机 grants 一律 403。
  const auditorProjectPut = await api(`/v1/projects/${zdemo.id}/grants`, {
    token: tokens.lisi,
    method: 'PUT',
    body: { subjectType: 'user', subjectId: 'lisi', permissions: ['open'] }
  })
  results.gates.auditor = {
    promote: { status: promote.status, roles: promote.body?.roles, source: promote.body?.source },
    loginRoles: auditorLogin.user.roles,
    navs,
    auditVisible,
    usersForbidden,
    auditApi: auditApi.status,
    usersApi: usersApi.status,
    hostGrantsPut: auditorHostPut.status,
    projectGrantsPut: auditorProjectPut.status
  }
  saveDom(auditorPage, 'auditor-users-route')

  // denied audit chain: the direct 403s above must be recorded
  const denied = await api('/v1/audit/events?result=denied&limit=200', { token: tokens.admin })
  const deniedEvents = denied.body?.events ?? denied.body?.items ?? []
  const platformDenials = deniedEvents.filter(
    (event) => event.metadata?.reason === 'PERMISSION_DENIED'
  )
  results.gates.deniedAudit = {
    status: denied.status,
    total: deniedEvents.length,
    lisiDenied: platformDenials.filter((event) => event.actor === 'lisi').length,
    zhangsanDenied: platformDenials.filter((event) => event.actor === 'zhangsan').length,
    sample: platformDenials.slice(-3)
  }
} catch (error) {
  results.error = String(error?.stack ?? error)
  results.defects.push({ severity: 'P0', title: 'matrix run aborted', detail: String(error) })
} finally {
  // restore probe rows and lisi's role; failure here is itself a defect
  try {
    for (const host of (await api('/v1/hosts', { token: tokens.admin })).body?.hosts ?? []) {
      if (!['dev-local-02', 'dev-local-03'].includes(host.name)) {
        continue
      }
      await api(`/v1/hosts/${host.id}/grants`, {
        token: tokens.admin,
        method: 'PUT',
        body: { subjectType: 'user', subjectId: 'lisi', permissions: [] }
      })
    }
    const projects = (await api('/v1/projects', { token: tokens.admin })).body?.projects ?? []
    const zdemo = projects.find((project) => project.key === 'zhangsan-demo')
    if (zdemo) {
      await api(`/v1/projects/${zdemo.id}/grants`, {
        token: tokens.admin,
        method: 'PUT',
        body: { subjectType: 'user', subjectId: 'lisi', permissions: [] }
      })
    }
    if (lisiId) {
      const restore = await api(`/v1/users/${lisiId}/roles`, {
        token: tokens.admin,
        method: 'PUT',
        body: { role: 'developer' }
      })
      results.restore = { lisiRole: restore.status, roles: restore.body?.roles }
    }
    // O2: 复原后再做第二轮 live 断言，不能只凭 PUT 200 宣布归零。
    const residualHosts = {}
    for (const host of (await api('/v1/hosts', { token: tokens.admin })).body?.hosts ?? []) {
      if (!['dev-local-02', 'dev-local-03'].includes(host.name)) {
        continue
      }
      const rows =
        (await api(`/v1/hosts/${host.id}/grants`, { token: tokens.admin })).body?.grants ?? []
      residualHosts[host.name] = rows.filter((row) => subjectOf(row) === 'lisi').length
    }
    const projectsNow = (await api('/v1/projects', { token: tokens.admin })).body?.projects ?? []
    const zdemoNow = projectsNow.find((project) => project.key === 'zhangsan-demo')
    const residualProject = zdemoNow
      ? (
          (await api(`/v1/projects/${zdemoNow.id}/grants`, { token: tokens.admin })).body?.grants ??
          []
        ).filter((row) => subjectOf(row) === 'lisi').length
      : null
    const relogin = await login('lisi')
    const lisiRoles = relogin.user?.roles ?? []
    results.restoreVerification = { residualHosts, residualProject, lisiRoles }
    if (
      Object.values(residualHosts).some((count) => count !== 0) ||
      residualProject !== 0 ||
      lisiRoles.length !== 1 ||
      lisiRoles[0] !== 'developer'
    ) {
      results.defects.push({
        severity: 'P0',
        title: 'restore verification failed',
        detail: results.restoreVerification
      })
    }
  } catch (error) {
    results.defects.push({ severity: 'P0', title: 'restore failed', detail: String(error) })
  }
  results.finishedAt = new Date().toISOString()
  results.evidenceDir = OUT
  save('matrix-summary.json', results)
  console.log(
    JSON.stringify(
      {
        evidenceDir: OUT,
        combos: Object.keys(results.combos),
        gates: Object.keys(results.gates),
        defects: results.defects,
        restore: results.restore,
        restoreVerification: results.restoreVerification
      },
      null,
      2
    )
  )
  await sleep(50)
}
