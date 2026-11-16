/* Orca Cloud 平台 Web 前端（前后端分离：只通过 REST 访问后端） */

import { buildHash, DEFAULT_ROUTE, parseHash } from './router/routes.js'

const state = {
  accessToken: localStorage.getItem('orca.access') ?? '',
  refreshToken: localStorage.getItem('orca.refresh') ?? '',
  user: null,
  projects: [],
  route: 'workbench',
  routeParams: {},
  routeQuery: null,
  deviceId: localStorage.getItem('orca.device') ?? '',
  lastHosts: [],
  users: [],
  /** Admin-only subject directory (A1), cached for the permission-tab pickers. */
  directory: null,
  auditFilter: {},
  auditEvents: null,
  auditCursor: null,
  auditStatus: null
}

const $ = (sel) => document.querySelector(sel)
const content = () => $('#content')

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}

function relative(ts) {
  const diff = Math.max(0, Date.now() - ts)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(state.accessToken ? { authorization: `Bearer ${state.accessToken}` } : {}),
      ...(init.headers ?? {})
    }
  })
  if (res.status === 401 && state.refreshToken) {
    const refreshed = await fetch('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: state.refreshToken })
    })
    if (refreshed.ok) {
      const body = await refreshed.json()
      setTokens(body.accessToken, body.refreshToken)
      return api(path, init)
    }
    logout()
  }
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.error?.message ?? `请求失败 (${res.status})`)
    err.code = body.error?.code
    err.status = res.status
    throw err
  }
  return body
}

function setTokens(access, refresh) {
  state.accessToken = access
  state.refreshToken = refresh
  localStorage.setItem('orca.access', access)
  localStorage.setItem('orca.refresh', refresh)
}

function toast(text) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = text
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2400)
}

/* ---------------- routing ---------------- */

const ADMIN_ROUTES = new Set(['hosts', 'relays', 'users', 'audit', 'settings'])
const TITLES = {
  workbench: '工作台',
  projects: '我的项目',
  workspace: '项目工作区',
  hosts: '平台设置 / 主机',
  relays: '平台设置 / 中继',
  users: '用户管理',
  audit: '审计日志',
  settings: '平台设置',
  forbidden: '无权访问',
  'not-found': '页面不存在'
}

function isAdmin() {
  return Boolean(state.user?.permissions?.includes('platform:admin'))
}

function isAuditor() {
  return Boolean(state.user?.permissions?.includes('platform:auditor'))
}

/** U72：审计路由对 admin 与 auditor 开放（u67 §7.1 审计=审计查询）；其余 admin 路由不变。 */
function canViewAudit() {
  return isAdmin() || isAuditor()
}

function routeAllowed(route) {
  if (!ADMIN_ROUTES.has(route)) return true
  return route === 'audit' ? canViewAudit() : isAdmin()
}

const ROUTE_RENDERERS = {
  workbench: renderWorkbench,
  projects: renderProjects,
  hosts: renderHosts,
  relays: renderRelays,
  users: renderUsersPage,
  audit: renderAudit,
  settings: renderSettings
}

/** 上一次真正渲染的路由；hashchange 与直接导航会对同一目标触发两次。 */
let appliedRoute = null

function clearActiveNav() {
  for (const btn of document.querySelectorAll('.nav-item')) btn.classList.remove('active')
}

function updateNav(name) {
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.classList.toggle('active', btn.dataset.route === name)
  }
}

function routeSignature(route) {
  return `${route.name}|${JSON.stringify(route.params)}|${route.query.toString()}`
}

/**
 * T7/C3 列表筛选入 URL：输入时 replaceState（不刷历史），显式「查询」pushState。
 * 只写当前列表路由；空值即从 query 删除（规范化）。
 */
function syncListQuery(name, filter, { push = false } = {}) {
  if (state.route !== name) return
  const hash = buildHash({ name, query: filter })
  if (location.hash === hash) return
  if (push) window.history.pushState(null, '', hash)
  else window.history.replaceState(null, '', hash)
  const route = parseHash(hash)
  state.routeQuery = route.query
  appliedRoute = routeSignature(route)
}

/** 写 URL 是唯一导航入口（U106 D1/D5）：刷新据此恢复。 */
function navigate(name, params = {}, query = undefined) {
  const hash = buildHash({ name, params, query })
  if (location.hash !== hash) location.hash = hash
  // 详情层是应用内 push 的条目：关闭时据此决定 back（回列表）还是 replace（深链直达）。
  window.history.replaceState(params?.id ? { detail: true } : null, '', hash)
  // 显式导航总是重绘（重复点当前导航项=刷新）；只有 hashchange 去重。
  applyRoute(parseHash(hash), { force: true })
}

/** 工作区覆盖层路由：`#/workspace/<projectId>`（T4 顶层路径）。 */
function workspaceRouteOf(route) {
  if (route?.name !== 'workspace') return null
  const id = route.params?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** 详情深链：`projects|hosts|users/<id>`，`?tab=perms` 选权限页签（D3）。 */
function detailRouteOf(route) {
  if (!['projects', 'hosts', 'users'].includes(route?.name)) return null
  const id = route.params?.id
  if (typeof id !== 'string' || id === '') return null
  return {
    name: route.name,
    id,
    tab: route.query?.get('tab') === 'perms' ? 'perms' : 'info'
  }
}

/** 当前打开的详情层（项目弹框 / 主机抽屉 / 用户弹框）。 */
let activeDetail = null
/** 详情层通过 history.back() 关闭后，目标列表仍在层下方，hashchange 不再重绘。 */
let pendingBackRestore = false
/** 关闭覆盖层期间的幂等闸：iframe 回报与 300ms 兜底只能关一次（T4）。 */
let workspaceClosing = false

/** 路由切换时静默移除旧详情层，不操作历史（§3.1 页面导航）。 */
function removeActiveDetail() {
  if (!activeDetail) return
  const current = activeDetail
  activeDetail = null
  current.remove()
}

/** 关闭详情层：列表点击 push 的条目后退一步；深链直达则替换为父路由。 */
function handleDetailClose(parent) {
  activeDetail = null
  if (window.history.state?.detail === true) {
    pendingBackRestore = true
    window.history.back()
    return
  }
  const hash = buildHash({ name: parent })
  window.history.replaceState(null, '', hash)
  appliedRoute = routeSignature(parseHash(hash))
}

/** 页签是视图态：tab 变化 replaceState（刷新可恢复），不新增历史项。 */
function replaceDetailTab(name, id, tab) {
  const hash = buildHash({
    name,
    params: { id },
    query: tab === 'perms' ? { tab: 'perms' } : undefined
  })
  if (location.hash === hash) return
  window.history.replaceState(window.history.state, '', hash)
  appliedRoute = routeSignature(parseHash(hash))
}

/** 列表点击：push 详情条目后直接打开，避免重载列表（与深链共用 openRouteDetail）。 */
function openDetailFromList(name, id) {
  const hash = buildHash({ name, params: { id } })
  if (location.hash === hash) {
    window.history.replaceState({ detail: true }, '', hash)
  } else {
    window.history.pushState({ detail: true }, '', hash)
  }
  state.routeParams = { id }
  appliedRoute = routeSignature(parseHash(hash))
  void openRouteDetail(parseHash(hash))
}

/**
 * 渲染 URL 指向的页面。登录是视图态（D7）：未登录时保留目标 hash，
 * 让登录成功后回到同一个 URL；无权管理路由保留 URL 并渲染 403（D6）。
 */
function applyRoute(route, { force = false } = {}) {
  if (!state.user) {
    showLogin()
    return
  }
  if (route.name === 'login') {
    navigate(DEFAULT_ROUTE)
    return
  }
  // 切到别的路由（或别的详情 id）前先移除旧弹框/抽屉，历史由浏览器自己走。
  const detail = detailRouteOf(route)
  if (
    activeDetail &&
    (!detail || activeDetail.name !== detail.name || activeDetail.id !== detail.id)
  ) {
    removeActiveDetail()
  }
  state.route = route.name
  state.routeParams = route.params
  state.routeQuery = route.query
  $('#crumbs').textContent = TITLES[route.name] ?? route.name

  // 覆盖层是路由状态：离开工作区路由或换项目时先静默移除，历史由浏览器自己走。
  const workspaceId = workspaceRouteOf(route)
  if (workspaceClosing && !workspaceId) workspaceClosing = false
  if (workspaceOverlay && workspaceId !== workspaceOverlay.projectId) {
    removeWorkspaceOverlay()
  }

  if (route.name === 'not-found') {
    renderNotFound()
    return
  }
  if (route.name === 'forbidden' || !routeAllowed(route.name)) {
    renderForbidden()
    return
  }

  const signature = routeSignature(route)
  if (!force && signature === appliedRoute) return
  appliedRoute = signature
  // 工作区路由：列表数据即存在性判据，确认可见后才 mint handoff（D4/T5）。
  if (workspaceId) {
    if (workspaceOverlay?.projectId === workspaceId) return
    pendingBackRestore = false
    void loadWorkspaceRoute(workspaceId)
    return
  }
  // 关层后的 back 目标列表仍在旧的层下方：不重绘，保留弹框 opener 的焦点（U46 §3.5）。
  if (pendingBackRestore) {
    pendingBackRestore = false
    if (!force) return
  }
  updateNav(route.name)
  const render = ROUTE_RENDERERS[route.name] ?? renderWorkbench
  // 详情先完成列表加载，再按 id 打开弹框/抽屉（列表数据即存在性判据）。
  if (detail) {
    // Q5/T5：详情弹框管理员专属，非管理员直达同一 URL 给 403（URL 保留）。
    if (detail.name === 'projects' && !isAdmin()) {
      renderForbidden()
      return
    }
    // 显式重绘同一详情时先收起旧层，避免叠两个弹框。
    removeActiveDetail()
    void loadContent(render).then((result) => {
      if (appliedRoute === signature) void openRouteDetail(route, result)
    })
    return
  }
  void loadContent(render)
}

/** One failed fetch must not leave the page stuck on its own spinner (M116-QA-011). */
async function loadContent(render) {
  content().innerHTML = '<p class="muted">加载中…</p>'
  try {
    return await render()
  } catch (err) {
    content().innerHTML = `
      <div class="forbidden">
        <div class="box">
          <h1>加载失败</h1>
          <p class="muted">${esc(err.message ?? String(err))}</p>
          <button class="btn primary" id="retryContent">重试</button>
        </div>
      </div>`
    $('#retryContent').onclick = () => void loadContent(render)
  }
}

/* ---------------- views ---------------- */

function renderForbidden() {
  $('#crumbs').textContent = TITLES.forbidden
  clearActiveNav()
  content().innerHTML = `
    <div class="forbidden">
      <div class="box">
        <svg class="shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="M12 8v4M12 16h.01"/>
        </svg>
        <h1>无权访问</h1>
        <p>当前账号没有平台管理权限。如需访问，请联系平台管理员开通。</p>
        <button class="btn primary" id="backToWorkbench">返回工作台</button>
      </div>
    </div>`
  $('#backToWorkbench').onclick = () => navigate('workbench')
}

/** D5：未知 hash 保留原地址，渲染可辨识的 404，而不是静默回落工作台。 */
function renderNotFound() {
  $('#crumbs').textContent = TITLES['not-found']
  clearActiveNav()
  content().innerHTML = `
    <div class="forbidden">
      <div class="box">
        <h1>页面不存在</h1>
        <p class="muted">没有找到这个页面：<span class="mono">${esc(location.hash || '（空）')}</span></p>
        <button class="btn primary" id="backToWorkbench">返回工作台</button>
      </div>
    </div>`
  $('#backToWorkbench').onclick = () => navigate('workbench')
}

/** T5：id 不存在或当前名单不可见一律 404 语义，不泄露存在性。 */
function renderDetailNotFound(parent) {
  const labels = {
    projects: ['项目', '返回我的项目'],
    hosts: ['主机', '返回主机'],
    users: ['用户', '返回用户管理']
  }
  const [noun, backLabel] = labels[parent]
  clearActiveNav()
  content().innerHTML = `
    <div class="forbidden">
      <div class="box">
        <h1>页面不存在</h1>
        <p class="muted">链接里的${noun}不存在或当前账号不可见。地址保留，刷新会重新校验。</p>
        <button class="btn primary" id="backToParent">${backLabel}</button>
      </div>
    </div>`
  $('#backToParent').onclick = () => navigate(parent)
}

/** 工作区路由：项目在可见列表内才 mint handoff 并挂覆盖层（D4/T5）。 */
async function loadWorkspaceRoute(projectId) {
  let projects = state.projects
  if (!projects.some((project) => project.id === projectId)) {
    try {
      projects = await loadProjects()
    } catch (err) {
      renderWorkspaceLoadFailure(projectId, err)
      return
    }
  }
  // 加载期间路由可能已改变（后退或换项目）。
  if (workspaceRouteOf(parseHash(location.hash)) !== projectId) return
  const project = projects.find((candidate) => candidate.id === projectId)
  if (!project) {
    renderWorkspaceNotFound()
    return
  }
  await openProjectWorkspace(projectId)
}

/** 不泄露存在性：列表只含可见项目，查不到即 404（T5）。 */
function renderWorkspaceNotFound() {
  $('#crumbs').textContent = TITLES['not-found']
  renderDetailNotFound('projects')
}

function renderWorkspaceLoadFailure(projectId, err) {
  content().innerHTML = `
    <div class="forbidden">
      <div class="box">
        <h1>加载失败</h1>
        <p class="muted">${esc(err.message ?? String(err))}</p>
        <button class="btn primary" id="retryWorkspace">重试</button>
      </div>
    </div>`
  $('#retryWorkspace').onclick = () => void loadWorkspaceRoute(projectId)
}

/** 列表/授权后打开：先 push URL，再由路由挂载覆盖层（T4）。 */
function enterWorkspace(projectId) {
  const hash = buildHash({ name: 'workspace', params: { id: projectId } })
  workspaceClosing = false
  if (location.hash === hash) {
    window.history.replaceState({ workspace: true }, '', hash)
  } else {
    window.history.pushState({ workspace: true }, '', hash)
  }
  applyRoute(parseHash(hash), { force: true })
}

/** 列表加载完成后按详情路由打开既有弹框/抽屉（U106 R3）。 */
async function openRouteDetail(route, listResult) {
  const detail = detailRouteOf(route)
  if (!detail) return
  const onClose = () => handleDetailClose(detail.name)
  if (detail.name === 'projects') {
    if (!state.projects.some((p) => p.id === detail.id)) {
      return renderDetailNotFound('projects')
    }
    await openProjectDetail(detail.id, { tab: detail.tab, onClose })
    return
  }
  if (detail.name === 'hosts') {
    if (!state.lastHosts.some((h) => h.id === detail.id)) {
      return renderDetailNotFound('hosts')
    }
    await showHost(detail.id, { tab: detail.tab, onClose })
    return
  }
  const user = (listResult ?? state.users).find((item) => item.id === detail.id)
  if (!user) {
    renderDetailNotFound('users')
    return
  }
  openUserDetail(user, { onClose })
}

async function loadProjects() {
  // Live views only: an archived project is history, so it never enters the
  // workbench or 「我的项目」 (U53③). includeArchived stays an explicit query.
  const body = await api('/v1/projects')
  state.projects = body.projects
  return body.projects
}

/**
 * What the platform enforces: a pinned per-project override wins, everything
 * else follows the global default. The stored value alone misreads a
 * follow-global project as pinned (M120c §5.1-1, needs downloadPolicyExplicit).
 */
function effectiveDownloadPolicy(p, globalDefault) {
  return p.downloadPolicyExplicit === true ? p.downloadPolicy : globalDefault
}

function downloadBadge(p, globalDefault) {
  const deny = effectiveDownloadPolicy(p, globalDefault) === 'deny'
  return `<span class="badge ${deny ? 'lock' : ''}">${deny ? '下载已禁用' : '允许下载'}</span>`
}

async function renderWorkbench() {
  const [projects, policy] = await Promise.all([loadProjects(), api('/v1/policies/download')])
  const globalDefault = policy.downloadDefault
  const online = projects.filter((p) => p.hostStatus === 'online').length
  const denied = projects.filter((p) => effectiveDownloadPolicy(p, globalDefault) === 'deny').length
  const recent = projects.slice(0, 3)
  content().innerHTML = `
    <div class="page-head">
      <div>
        <h1>${greeting()}，${esc(state.user?.displayName ?? '')}</h1>
        <p>你有 ${projects.length} 个可访问项目，其中 ${online} 个所在主机在线。</p>
      </div>
    </div>
    <div class="grid-4">
      ${stat('可访问项目', String(projects.length), '按 ACL 过滤')}
      ${stat('主机在线', String(online), '心跳 15 秒')}
      ${stat('禁用下载项目', String(denied), '导出入口已隐藏')}
      ${stat('下载默认策略', policy.downloadDefault === 'deny' ? '禁止' : '允许', `策略版本 v${policy.version}`)}
    </div>
    <div class="section-head"><h2>最近项目</h2><button class="btn ghost" data-go="projects">查看全部</button></div>
    <div class="grid-3">
      ${recent.map((p) => projectCard(p, globalDefault)).join('') || '<div class="card pad muted">暂无项目。请联系项目负责人或平台管理员。</div>'}
    </div>
    <div class="section-head"><h2>全部项目</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>项目</th><th>仓库</th><th>主机</th><th>可见范围</th><th>状态</th><th class="actions">操作</th></tr></thead>
        <tbody>
          ${projects.map(projectRow).join('') || '<tr><td colspan="6" class="table-empty">没有可访问的项目</td></tr>'}
        </tbody>
      </table>
    </div>`
  wireProjectActions()
}

function greeting() {
  const hour = new Date().getHours()
  if (hour < 6) return '凌晨好'
  if (hour < 12) return '上午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

function stat(label, value, hint) {
  return `<div class="card stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-hint">${hint}</div></div>`
}

function hostStatusBadge(p) {
  if (p.hostStatus === 'maintenance') {
    return '<span class="badge">维护中</span>'
  }
  return p.hostStatus === 'online' ? '' : '<span class="badge">主机离线</span>'
}

/** Fallback for a row that still reaches a live view: archived is never openable. */
function archivedBadge(p) {
  return p.status === 'archived' ? '<span class="badge">已归档</span>' : ''
}

function hostStateText(p) {
  if (p.hostStatus === 'maintenance') {
    return p.hostMaintenanceReason ? `维护中 · ${p.hostMaintenanceReason}` : '维护中'
  }
  return p.hostStatus === 'online' ? '可打开' : '主机离线'
}

function permissionSummary(p) {
  // An admin reaches every project without carrying grants; an empty list must
  // not read as "no permissions" — and the minted credential would carry none
  // either, so the column says exactly that (M116-QA-010).
  if (p.permissions.length === 0 && isAdmin()) {
    return '管理员可见（未授权）'
  }
  // U65: a host read-only grant caps the ticket at open+file:read, so the
  // column names the cap instead of implying free choice (DH matrix).
  const capped = p.hostAccess === 'read-only' ? '（主机只读上限）' : ''
  return `${p.permissions.join(' · ')}${capped}`
}

/** Why 打开 is unavailable, or null when the project can be opened (FR-2.4). */
function openDisabledReason(p) {
  if (p.status === 'archived') return '项目已归档，无法打开'
  if (p.hostStatus === 'maintenance') return '主机维护中'
  if (p.hostStatus !== 'online') return '主机离线'
  if (p.permissions.length === 0 && isAdmin()) {
    return '项目未授权给你，请先在项目详情的「权限」页签中授权'
  }
  return null
}

/** One reason string drives every 打开 entry, so the three stay consistent. */
function openDisabledAttr(p) {
  const reason = openDisabledReason(p)
  return reason ? `disabled title="${esc(reason)}"` : ''
}

function projectCard(p, globalDefault) {
  const offline = p.hostStatus !== 'online'
  return `
    <div class="card project-card">
      <div class="name"><span class="dot ${offline ? 'offline' : 'online'}"></span>${esc(p.name)} ${archivedBadge(p)}</div>
      <div class="path">${esc(p.repoUrl || p.path)}</div>
      <div class="meta-row">
        <span>${esc(p.hostName ?? '—')}</span>
        <span class="badge">${esc(p.defaultBranch)}</span>
        <span>创建于 ${relative(p.createdAt ?? Date.now())}</span>
        ${hostStatusBadge(p)}
      </div>
      <div class="foot">
        ${downloadBadge(p, globalDefault)}
        <button class="btn primary sm" data-open="${p.id}" ${openDisabledAttr(p)}>打开</button>
      </div>
    </div>`
}

/**
 * The per-project row entries (FR-3.11 R3) come from one builder so 工作台 and
 * 我的项目 stay identical. 「详情」 is admin-only and opens a read-only platform
 * dialog (never gated by host state: an offline host is exactly what it
 * explains); 「打开」 mounts the admin-surface handoff in a same-page overlay
 * (U46-3); 「Orca Web」 (M122, FR-3.10) keeps the new-tab entry unchanged.
 */
function projectRowActions(p) {
  return `<button class="btn sm" data-open="${p.id}" ${openDisabledAttr(p)}>打开</button>${selfGrantEntry(p)}${detailEntry(p)}${orcaWebEntry(p)}`
}

function detailEntry(p) {
  // Q1 (U46): the dialog carries createdBy and the direct-grant summary, so the
  // entry stays admin-only; a host that is offline still opens its own dialog.
  return isAdmin() ? `<button class="btn sm" data-detail="${esc(p.id)}">详情</button>` : ''
}

/** Why the Orca Web entry cannot open. */
function orcaWebDisabledReason(p) {
  if (p.hostStatus === 'maintenance') {
    return '主机维护中'
  }
  if (p.hostStatus !== 'online') {
    return '主机离线'
  }
  return null
}

function orcaWebEntry(p) {
  if (!p.permissions.includes('open')) {
    return ''
  }
  const reason = orcaWebDisabledReason(p)
  // Why an action button, not a link: the entry URL is minted per click, so a
  // host with no browser edge may still serve its direct web-index entry.
  return reason
    ? `<button class="btn sm" disabled title="${esc(reason)}">Orca Web</button>`
    : `<button class="btn sm" data-orca-web="${esc(p.id)}" title="在新标签打开 Orca Web 工作区">Orca Web</button>`
}

/* ---------------- admin 自授并打开（U40 · AA5） ---------------- */

/** The set a self-service project is born with, so a self-grant reads as one. */
const SELF_GRANT_PERMISSIONS = ['open', 'terminal', 'agent', 'file:read', 'file:write']

/**
 * An admin sees every project but carries no grant row, so 打开 mints a
 * credential the host refuses outright (U40 403). The entry is additive: the
 * greyed 打开 keeps stating why, and 「授权并打开」 writes a real grant for the
 * admin themself before handing off — use rights stay explicit (default deny).
 */
function selfGrantEntry(p) {
  if (!isAdmin() || p.permissions.includes('open')) {
    return ''
  }
  // Same host gate as the other handoff entries: the grant could land anyway,
  // but the open it enables would just fail.
  const reason = orcaWebDisabledReason(p)
  return reason
    ? `<button class="btn sm" disabled title="${esc(reason)}">授权并打开</button>`
    : `<button class="btn sm" data-self-grant="${esc(p.id)}" title="先给自己授权，再进入项目工作区">授权并打开</button>`
}

async function selfGrantAndOpen(projectId) {
  const subjectId = state.user?.username ?? ''
  try {
    await api(`/v1/projects/${projectId}/grants`, {
      method: 'PUT',
      // A username is all the server needs: it resolves it to the user id that
      // the ACL matches on, so the row is named and live.
      body: JSON.stringify({ subjectType: 'user', subjectId, permissions: SELF_GRANT_PERMISSIONS })
    })
  } catch (err) {
    toast(`授权失败：${err.message ?? err}`)
    return
  }
  toast('已授权，正在打开…')
  enterWorkspace(projectId)
}

function confirmSelfGrant(projectId) {
  const project = state.projects.find((p) => p.id === projectId)
  if (!project) {
    return
  }
  dialog(
    '授权并打开',
    `
    <p>项目「${esc(project.name)}」尚未授权给你。确认把以下权限授予你的账号：</p>
    <p class="mono">${esc(SELF_GRANT_PERMISSIONS.join(' · '))}</p>
    <p class="muted">保存将断开你当前全部云会话（含其他项目），重新打开项目即按新权限签发凭证。</p>`,
    [
      {
        label: '授权并打开',
        primary: true,
        onClick: () => {
          void selfGrantAndOpen(projectId)
        }
      }
    ]
  )
}

function projectRow(p) {
  const offline = p.hostStatus !== 'online'
  return `<tr>
    <td><strong>${esc(p.name)}</strong> ${archivedBadge(p)}<div class="muted mono">${esc(p.path)}</div></td>
    <td class="mono muted">${esc(p.repoUrl)}</td>
    <td>${esc(p.hostName ?? '—')} ${hostStatusBadge(p)}</td>
    <td class="muted">${esc(permissionSummary(p))}</td>
    <td><span class="dot ${offline ? 'offline' : 'online'}"></span> ${hostStateText(p)}</td>
    <td class="actions">
      ${projectRowActions(p)}
    </td>
  </tr>`
}

function wireProjectActions() {
  // §4.10: 「打开」 goes into the same-page overlay; 「Orca Web」 keeps the W13b
  // new-tab handoff byte for byte.
  for (const btn of document.querySelectorAll('[data-open]')) {
    // 打开是 URL 状态：push #/workspace/<id>，浏览器后退即关闭覆盖层（U106 D4）。
    btn.onclick = () => enterWorkspace(btn.dataset.open ?? '')
  }
  for (const btn of document.querySelectorAll('[data-orca-web]')) {
    btn.onclick = () => void openOrcaWebInNewTab(btn.dataset.orcaWeb ?? '')
  }
  for (const btn of document.querySelectorAll('[data-self-grant]')) {
    btn.onclick = () => confirmSelfGrant(btn.dataset.selfGrant ?? '')
  }
  for (const btn of document.querySelectorAll('[data-detail]')) {
    btn.onclick = () => {
      // 详情是 URL 状态：push 后立即打开，浏览器后退可回到列表（U106 R3）。
      // 保持行按钮为 opener，关闭时焦点回到它（U46 §3.5）。
      btn.focus()
      openDetailFromList('projects', btn.dataset.detail ?? '')
    }
  }
  for (const btn of document.querySelectorAll('[data-go]')) {
    btn.onclick = () => navigate(btn.dataset.go)
  }
}

/* ---------------- 内嵌工作区覆盖层（U46-3 · §4.2） ---------------- */

const WORKSPACE_READY_TIMEOUT_MS = 20_000
const WORKSPACE_CLOSE_TIMEOUT_MS = 300
/** §4.2: an end closes every PTY serially, so its acknowledgement is slower. */
const WORKSPACE_END_TIMEOUT_MS = 5_000
/** R9: retry the handoff at most twice, then point at the standalone page. */
const WORKSPACE_READY_MAX_RETRIES = 2
let workspaceOverlay = null

/** Only the admin-surface page can host the embed entry (§4.10). */
function isInlineWorkspaceUrl(url) {
  try {
    return new URL(url).pathname.endsWith('/cloud-admin.html')
  } catch {
    return false
  }
}

/**
 * The platform mints a one-time, 60-second handoff code bound to this session;
 * the console asks for the admin surface and mounts the host-served
 * cloud-admin.html in a fullscreen overlay, so the workspace document runs on
 * the host/relay edge while the console stays underneath (§4.1/§4.2).
 */
async function openProjectWorkspace(projectId, { retries = 0 } = {}) {
  const project = state.projects.find((p) => p.id === projectId)
  let body
  try {
    body = await api(`/v1/projects/${projectId}/web-handoff`, {
      method: 'POST',
      body: JSON.stringify({ surface: 'admin' })
    })
  } catch (err) {
    // The issuance itself failed: state the reason, keep both escape hatches.
    mountWorkspaceFailure(projectId, project, err.message ?? String(err))
    return
  }
  const url = String(body.url ?? '')
  if (!isInlineWorkspaceUrl(url)) {
    // An old platform ignores `surface` and still answers web-index.html.
    window.open(url, '_blank', 'noopener')
    toast('当前平台版本不支持内嵌工作区，已在新标签打开')
    // 没有覆盖层能恢复，URL 就不该继续声称 `#/workspace/<id>`（T4）。
    if (workspaceRouteOf(parseHash(location.hash)) === projectId) finishWorkspaceClose()
    return
  }
  mountWorkspaceOverlay(projectId, project, url, retries)
}

/** 「Orca Web」 and the overlay's fallback: web surface, new tab, unchanged. */
async function openOrcaWebInNewTab(projectId) {
  try {
    const body = await api(`/v1/projects/${projectId}/web-handoff`, { method: 'POST' })
    window.open(body.url, '_blank', 'noopener')
  } catch (err) {
    toast(`打开失败：${err.message ?? err}`)
  }
}

function workspaceBarHtml(project) {
  const branch = project?.defaultBranch
    ? `<span class="muted">${esc(project.defaultBranch)}</span>`
    : ''
  const host = project?.hostName ? `<span class="muted">${esc(project.hostName)}</span>` : ''
  return `
    <header class="workspace-bar">
      <div class="workspace-bar-side">
        <button class="btn ghost sm" data-workspace-back>← 返回</button>
        <strong class="workspace-title">${esc(project?.name ?? '项目工作区')}</strong>
        ${branch}
        <span class="workspace-route" data-workspace-route hidden></span>
        <span class="workspace-dirty" data-workspace-dirty hidden></span>
        ${host}
      </div>
      <div class="workspace-bar-side">
        <button class="btn sm" data-workspace-new-tab>在新标签打开 Orca Web</button>
        <button class="btn sm danger" data-workspace-end hidden>结束工作区</button>
        <button class="btn sm" data-workspace-close>关闭</button>
      </div>
    </header>`
}

function createWorkspaceShell(project) {
  const root = document.createElement('div')
  root.className = 'workspace-overlay'
  root.id = 'workspaceOverlay'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', '项目工作区')
  root.innerHTML = `${workspaceBarHtml(project)}<div class="workspace-body"></div>`
  return root
}

function wireWorkspaceShell(root, projectId, retries = 0) {
  for (const btn of root.querySelectorAll('[data-workspace-close], [data-workspace-back]')) {
    btn.onclick = () => {
      // A failure shell has no iframe to handshake with.
      if (workspaceOverlay?.root === root) requestWorkspaceClose()
      else root.remove()
    }
  }
  for (const btn of root.querySelectorAll('[data-workspace-new-tab]')) {
    btn.onclick = () => void openOrcaWebInNewTab(projectId)
  }
  for (const btn of root.querySelectorAll('[data-workspace-end]')) {
    btn.onclick = () => requestWorkspaceEnd()
  }
  const retry = root.querySelector('[data-workspace-retry]')
  if (retry) {
    retry.onclick = () => {
      removeWorkspaceOverlay()
      // R9: a retry re-mints the one-time handoff and rebuilds the iframe.
      void openProjectWorkspace(projectId, { retries: retries + 1 })
    }
  }
}

function mountWorkspaceFailure(projectId, project, reason) {
  removeWorkspaceOverlay()
  const root = createWorkspaceShell(project)
  root.querySelector('.workspace-body').innerHTML = `
    <div class="workspace-status" role="alert">
      <div class="workspace-status-box">
        <p>工作区打开失败：${esc(reason)}</p>
        <div class="workspace-actions">
          <button class="btn primary sm" data-workspace-retry>重试</button>
          <button class="btn sm" data-workspace-new-tab>在新标签打开 Orca Web</button>
        </div>
      </div>
    </div>`
  wireWorkspaceShell(root, projectId)
  document.body.appendChild(root)
  // F-08: registered too, so top-bar close, logout, and a later open release it.
  workspaceOverlay = {
    root,
    projectId,
    iframe: null,
    origin: null,
    dirty: 0,
    ready: false,
    features: new Set(),
    readyTimer: null,
    closeTimer: null,
    onMessage: null
  }
}

/**
 * R9/§5.3: an old host bundle never reports ready. Keep the overlay and show a
 * failure state (not just a toast) with a re-mint retry, then the standalone
 * Orca Web entry once the retries are spent.
 */
function mountWorkspaceReadyFailure(projectId, project, retries) {
  removeWorkspaceOverlay()
  const exhausted = retries >= WORKSPACE_READY_MAX_RETRIES
  const root = createWorkspaceShell(project)
  root.querySelector('.workspace-body').innerHTML = `
    <div class="workspace-status" role="alert" data-workspace-ready-failure>
      <div class="workspace-status-box">
        <p>工作区加载超时：${WORKSPACE_READY_TIMEOUT_MS / 1000} 秒内未收到就绪信号。</p>
        <p class="muted">${
          exhausted
            ? '已重试 ' + retries + ' 次仍未就绪，请改为在新标签页打开 Orca Web。'
            : '当前宿主可能不支持内嵌工作区。可以重试，或直接在新标签页打开 Orca Web。'
        }</p>
        <div class="workspace-actions">
          ${exhausted ? '' : '<button class="btn primary sm" data-workspace-retry>重试</button>'}
          <button class="btn sm" data-workspace-new-tab>在新标签打开 Orca Web</button>
        </div>
      </div>
    </div>`
  wireWorkspaceShell(root, projectId, retries)
  // Registered so top-bar close, logout, and a later open all release it.
  workspaceOverlay = {
    root,
    projectId,
    iframe: null,
    origin: null,
    dirty: 0,
    ready: false,
    features: new Set(),
    readyTimer: null,
    closeTimer: null,
    onMessage: null
  }
  document.body.appendChild(root)
}

function mountWorkspaceOverlay(projectId, project, url, retries = 0) {
  removeWorkspaceOverlay()
  const root = createWorkspaceShell(project)
  const body = root.querySelector('.workspace-body')
  body.innerHTML = '<div class="workspace-status" data-workspace-status>正在进入项目工作区…</div>'
  const iframe = document.createElement('iframe')
  iframe.className = 'workspace-frame'
  iframe.title = '项目工作区'
  iframe.src = url
  body.appendChild(iframe)

  const overlay = {
    root,
    projectId,
    iframe,
    origin: new URL(url).origin,
    dirty: 0,
    ready: false,
    features: new Set(),
    readyTimer: null,
    closeTimer: null,
    onMessage: null
  }
  const status = root.querySelector('[data-workspace-status]')
  const route = root.querySelector('[data-workspace-route]')
  const dirty = root.querySelector('[data-workspace-dirty]')
  const endBtn = root.querySelector('[data-workspace-end]')

  overlay.onMessage = (event) => {
    // §4.2: only this iframe, only from the page the handoff named.
    if (event.source !== iframe.contentWindow || event.origin !== overlay.origin) return
    const data = event.data ?? {}
    if (data.source !== 'orca-cloud-admin') return
    if (data.type === 'ready') {
      overlay.ready = true
      overlay.features = new Set(Array.isArray(data.features) ? data.features : [])
      clearTimeout(overlay.readyTimer)
      status.hidden = true
      route.hidden = false
      route.textContent = `${data.route === 'relay' ? '中继' : '直连'} ${Number(data.latencyMs) || 0}ms`
      // §4.2: only a console that implements `end` offers the explicit action.
      if (endBtn) endBtn.hidden = !overlay.features.has('end')
    } else if (data.type === 'dirty') {
      overlay.dirty = Number(data.count) || 0
      dirty.hidden = overlay.dirty === 0
      dirty.textContent = `${overlay.dirty} 个未保存文件`
    } else if (data.type === 'closed' || data.type === 'suspended' || data.type === 'ended') {
      finishWorkspaceClose()
    }
  }
  window.addEventListener('message', overlay.onMessage)
  overlay.readyTimer = setTimeout(() => {
    if (overlay.ready) return
    // R9: an old host bundle never reports ready; keep a failure state with a
    // re-mint retry and the standalone Orca Web escape hatch.
    mountWorkspaceReadyFailure(projectId, project, retries)
  }, WORKSPACE_READY_TIMEOUT_MS)
  workspaceOverlay = overlay
  wireWorkspaceShell(root, projectId)
  document.body.appendChild(root)
}

function requestWorkspaceClose() {
  const overlay = workspaceOverlay
  if (!overlay) return
  if (overlay.dirty > 0 && !confirmDialog(`有 ${overlay.dirty} 个文件未保存，确定关闭工作区？`)) {
    return
  }
  if (!overlay.iframe) {
    finishWorkspaceClose()
    return
  }
  // §4.1: 收起 is a suspend — the iframe drops its stream/socket, host PTYs stay.
  // An old iframe has no `suspend` feature; its `close` means the same now.
  const type = overlay.features.has('suspend') ? 'suspend' : 'close'
  overlay.iframe.contentWindow?.postMessage({ type }, overlay.origin)
  overlay.closeTimer = setTimeout(finishWorkspaceClose, WORKSPACE_CLOSE_TIMEOUT_MS)
}

/** §4.1: explicit end is the only action that retires PTYs and rows. */
function requestWorkspaceEnd() {
  const overlay = workspaceOverlay
  if (!overlay || !overlay.iframe) return
  if (!confirmDialog('结束工作区将关闭其中所有终端，确定继续？')) return
  clearTimeout(overlay.closeTimer)
  overlay.iframe.contentWindow?.postMessage({ type: 'end' }, overlay.origin)
  overlay.closeTimer = setTimeout(() => {
    finishWorkspaceClose()
    toast('结束工作区超时，已强制关闭')
  }, WORKSPACE_END_TIMEOUT_MS)
}

/**
 * 关闭覆盖层并回退 URL（T4）：push 打开的后退一步回来源页；深链直达
 * 则 replace 为 `#/projects`（无前项可退）。iframe 回报与兜底只生效一次。
 */
function finishWorkspaceClose() {
  if (workspaceClosing) return
  workspaceClosing = true
  const pushed = window.history.state?.workspace === true
  removeWorkspaceOverlay()
  if (pushed) {
    pendingBackRestore = true
    window.history.back()
    return
  }
  const hash = buildHash({ name: 'projects' })
  window.history.replaceState(null, '', hash)
  applyRoute(parseHash(hash), { force: true })
}

function removeWorkspaceOverlay() {
  const overlay = workspaceOverlay
  if (!overlay) {
    document.querySelector('#workspaceOverlay')?.remove()
    return
  }
  clearTimeout(overlay.readyTimer)
  clearTimeout(overlay.closeTimer)
  if (overlay.onMessage) window.removeEventListener('message', overlay.onMessage)
  overlay.root.remove()
  workspaceOverlay = null
}

/**
 * R10/T-B7: the console owns logout; logout is a suspend, never an implicit end,
 * so the iframe clears its session without closing any host PTY.
 */
function closeWorkspaceForLogout() {
  const overlay = workspaceOverlay
  if (!overlay) return
  overlay.iframe?.contentWindow?.postMessage({ type: 'logout' }, overlay.origin)
  removeWorkspaceOverlay()
}

/* ---------------- 详情弹框（U46-2 · FR-3.11 R3） ---------------- */

const PROJECT_STATUS = {
  provisioning: ['准备中', ''],
  ready: ['就绪', 'ok'],
  failed: ['准备失败', 'danger'],
  archived: ['已归档', '']
}

function projectStatusBadge(status) {
  const [label, tone] = PROJECT_STATUS[status] ?? [status || '未知', '']
  return `<span class="badge ${tone}">${esc(label)}</span>`
}

function detailHostStatus(p) {
  if (p.hostStatus === 'maintenance') {
    return `<span class="badge warn">维护中</span>${
      p.hostMaintenanceReason ? `<div class="muted">${esc(p.hostMaintenanceReason)}</div>` : ''
    }`
  }
  return p.hostStatus === 'online'
    ? '<span class="badge ok">在线</span>'
    : '<span class="badge danger">离线</span>'
}

/** A mono value with a copy button; read-only fields stay selectable too. */
function copyable(value) {
  return `<span class="mono">${esc(value)}</span> <button class="btn sm" data-copy="${esc(value)}">复制</button>`
}

function detailPermissions(p) {
  if (p.permissions.length === 0) {
    return isAdmin()
      ? '<span class="muted">管理员可见（未授权）</span>'
      : '<span class="muted">无直接权限</span>'
  }
  return p.permissions
    .map((permission) => `<span class="badge">${esc(permission)}</span>`)
    .join(' ')
}

function detailGrants(grants, loading) {
  if (loading) {
    return '<span class="muted">加载中…</span>'
  }
  if (grants === null) {
    return '<span class="muted">未能读取直接授权</span>'
  }
  if (grants.length === 0) {
    return '<span class="muted">无直接授权</span>'
  }
  return grants
    .map((grant) => {
      const subject = grant.username ?? grant.subjectId
      const kind = grant.subjectType === 'group' ? '组' : '用户'
      return `<div>${esc(subject)}（${kind}）· ${grant.permissions.length} 项权限</div>`
    })
    .join('')
}

function detailDownloadPolicy(p, policy) {
  if (!policy) {
    return '<span class="muted">未能读取下载策略</span>'
  }
  const effective = effectiveDownloadPolicy(p, policy.downloadDefault)
  const source = p.downloadPolicyExplicit === true ? '项目覆盖' : '跟随全局'
  const badge =
    effective === 'deny'
      ? '<span class="badge lock">禁止下载</span>'
      : '<span class="badge">允许下载</span>'
  return `${badge} <span class="muted">${source}</span>`
}

function projectDetailHtml(p, extra = {}) {
  const createdBy = p.createdBy == null || p.createdBy === '' ? '未记录' : p.createdBy
  const createdAt = p.createdAt
    ? `${new Date(p.createdAt).toLocaleString('zh-CN')}（${relative(p.createdAt)}）`
    : '—'
  return `
    ${extra.refreshFailed ? '<p class="note warn">未能刷新项目信息，以下为最近一次加载的数据。</p>' : ''}
    <div class="detail-tabs">
      <button class="detail-tab active" data-auth-tab="info">信息</button>
      <button class="detail-tab" data-auth-tab="perms">权限</button>
    </div>
    <div data-auth-panel="info">
      <div class="detail-sections">
        <section class="detail-section">
          <h3>基本信息</h3>
          <dl class="kv">
            <dt>项目名称</dt><dd>${esc(p.name)}</dd>
            <dt>项目 Key</dt><dd class="mono">${esc(p.key)}</dd>
            <dt>项目 ID</dt><dd>${copyable(p.id)}</dd>
            <dt>创建者</dt><dd>${esc(createdBy)}</dd>
            <dt>创建时间</dt><dd>${esc(createdAt)}</dd>
            <dt>项目状态</dt><dd>${projectStatusBadge(p.status)}</dd>
            ${
              p.status === 'failed' && p.provisioningError
                ? `<dt>准备失败原因</dt><dd class="mono">${esc(p.provisioningError)}</dd>`
                : ''
            }
          </dl>
        </section>
        <section class="detail-section">
          <h3>运行配置</h3>
          <dl class="kv">
            <dt>主机</dt><dd>${esc(p.hostName ?? '—')} <span class="mono muted">${esc(p.hostId)}</span></dd>
            <dt>宿主状态</dt><dd>${detailHostStatus(p)}</dd>
            <dt>项目路径</dt><dd>${copyable(p.path)}</dd>
            <dt>仓库地址</dt><dd>${p.repoUrl ? copyable(p.repoUrl) : '<span class="muted">未配置仓库</span>'}</dd>
            <dt>默认分支</dt><dd class="mono">${esc(p.defaultBranch)}</dd>
          </dl>
        </section>
        <section class="detail-section">
          <h3>授权与策略</h3>
          <dl class="kv">
            <dt>我的权限</dt><dd>${detailPermissions(p)}</dd>
            <dt>直接授权</dt><dd>${detailGrants(extra.grants, extra.grantsLoading === true)}</dd>
            <dt>下载策略</dt><dd>${detailDownloadPolicy(p, extra.policy)}</dd>
            ${
              p.sessionPageUrl
                ? `<dt>独立页</dt><dd><a href="${esc(p.sessionPageUrl)}" target="_blank" rel="noopener">在独立页打开会话页</a></dd>`
                : ''
            }
          </dl>
        </section>
      </div>
    </div>
    <div data-auth-panel="perms" hidden>
      <div id="projectPermCards"><p class="muted">加载中…</p></div>
    </div>`
}

function wireDetailCopy(backdrop) {
  for (const button of backdrop.querySelectorAll('[data-copy]')) {
    button.onclick = () => {
      void navigator.clipboard?.writeText(button.dataset.copy ?? '')
      toast('已复制')
    }
  }
}

/**
 * Read-only platform info plus the U67 permission tab (the only project-grant
 * entry): render the cached row at once, then refresh with one GET /projects/:id
 * plus the existing read endpoints (grants, policy, host grants). Never talks
 * to the host, so an offline/maintenance host is still inspectable.
 */
async function openProjectDetail(projectId, { tab = 'info', onClose } = {}) {
  const cached = state.projects.find((p) => p.id === projectId)
  if (!cached) {
    return
  }
  // The permission tab's pickers share the admin directory cache (AA4); a
  // failed read degrades to free-text input, never to a broken dialog.
  if (isAdmin() && !state.directory) state.directory = await loadDirectory()
  let project = cached
  let currentTab = tab
  // 「打开项目」进入覆盖层：URL 不再回落列表（workspace 路由由 R4 接管）。
  let openedWorkspace = false
  const reason = openDisabledReason(cached)
  const extra = { grantsLoading: true, grants: [], hostRows: null }
  // 详情层身份：静默移除后旧弹框的 Escape 监听不得影响新层（onClose 身份比对）。
  const detailEntry = { name: 'projects', id: projectId, remove: () => backdrop.remove() }
  const backdrop = dialog(
    '项目详情',
    projectDetailHtml(project, extra),
    [
      {
        label: '打开项目',
        primary: true,
        disabled: Boolean(reason),
        title: reason ?? '进入项目工作区',
        onClick: () => {
          openedWorkspace = true
          void openProjectWorkspace(projectId)
        }
      }
    ],
    {
      wide: true,
      onClose: () => {
        if (activeDetail !== detailEntry) return // 已被路由静默移除
        activeDetail = null
        if (!openedWorkspace) onClose?.()
      }
    }
  )
  activeDetail = detailEntry
  const body = backdrop.querySelector('.dialog .body')
  const grantsPath = `/v1/projects/${projectId}/grants`
  const paintPermCards = () => {
    const holder = body.querySelector('#projectPermCards')
    if (!holder) return
    holder.innerHTML = permCardsHtml(PROJECT_ROLE_CARDS, extra.grants ?? [], {
      kind: 'project',
      header:
        '项目级授权仅影响当前项目，不扩大到所在主机或其它项目（FR-9.11③）。下载位仍受项目 / 全局下载策略独立约束。',
      footnote: PERM_FOOTNOTE,
      datalistPrefix: 'project',
      hostRows: extra.hostRows
    })
    wirePermCards(holder, {
      grantsPath,
      rows: extra.grants ?? [],
      cards: PROJECT_ROLE_CARDS,
      kind: 'project',
      noun: '项目',
      errorText: grantErrorText,
      datalistPrefix: 'project',
      onChange: async () => {
        const fresh = await api(grantsPath)
        extra.grants = fresh.grants
        paintPermCards()
      }
    })
  }
  const paint = () => {
    if (!backdrop.isConnected) {
      return
    }
    body.innerHTML = projectDetailHtml(project, extra)
    wireDetailCopy(backdrop)
    wireAuthTabs(body, {
      active: currentTab,
      onSelect: (key) => {
        currentTab = key
        replaceDetailTab('projects', projectId, key)
      }
    })
    paintPermCards()
    // The refresh may have changed host state, so the primary action follows it.
    const refreshedReason = openDisabledReason(project)
    const openAction = backdrop.querySelector('[data-action="0"]')
    if (openAction) {
      openAction.disabled = Boolean(refreshedReason)
      openAction.title = refreshedReason ?? '进入项目工作区'
    }
  }
  wireDetailCopy(backdrop)

  const [fresh, grants, policy, hostGrants] = await Promise.allSettled([
    api(`/v1/projects/${projectId}`),
    isAdmin() ? api(grantsPath) : Promise.resolve(null),
    api('/v1/policies/download'),
    isAdmin() ? api(`/v1/hosts/${cached.hostId}/grants`).catch(() => null) : Promise.resolve(null)
  ])
  if (fresh.status === 'fulfilled') {
    project = { ...cached, ...fresh.value }
    Object.assign(cached, fresh.value)
  } else {
    extra.refreshFailed = true
  }
  extra.grantsLoading = false
  extra.grants = grants.status === 'fulfilled' ? (grants.value?.grants ?? []) : null
  extra.policy = policy.status === 'fulfilled' ? policy.value : null
  extra.hostRows = hostGrants.status === 'fulfilled' ? (hostGrants.value?.grants ?? null) : null
  paint()
}

function currentDeviceId() {
  const id = state.deviceId || localStorage.getItem('orca.device')
  if (id) return id
  const generated = `web_${Math.random().toString(36).slice(2, 10)}`
  localStorage.setItem('orca.device', generated)
  return generated
}

async function renderProjects() {
  // 生效值 = 显式覆盖 ? 项目值 : 全局默认；列与徽标都按生效值渲染（M120c §5.4）。
  const [projects, policy] = await Promise.all([loadProjects(), api('/v1/policies/download')])
  const globalDefault = policy.downloadDefault
  content().innerHTML = `
    <div class="page-head">
      <div><h1>我的项目</h1><p>仅展示你有「打开项目」权限的项目。</p></div>
      <div style="display:flex;gap:8px">
        ${isAdmin() ? '<button class="btn primary" id="registerProjectBtn">登记项目</button>' : ''}
        <button class="btn" onclick="location.reload()">刷新</button>
      </div>
    </div>
    <div class="toolbar">
      <input class="input grow" id="projectSearch" placeholder="搜索项目名、仓库或主机">
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>项目</th><th>仓库</th><th>主机</th><th>权限</th><th>下载策略</th><th class="actions">操作</th></tr></thead>
        <tbody id="projectBody"></tbody>
      </table>
    </div>`
  const draw = (filter = '') => {
    const rows = projects.filter((p) =>
      `${p.name} ${p.repoUrl} ${p.hostName}`.toLowerCase().includes(filter.toLowerCase())
    )
    $('#projectBody').innerHTML =
      rows
        .map(
          (p) => `<tr>
        <td><strong>${esc(p.name)}</strong> ${archivedBadge(p)}<div class="muted mono">${esc(p.path)}</div></td>
        <td class="mono muted">${esc(p.repoUrl)}</td>
        <td>${esc(p.hostName)} ${hostStatusBadge(p)}</td>
        <td class="muted">${esc(permissionSummary(p))}</td>
        <td>${
          effectiveDownloadPolicy(p, globalDefault) === 'deny'
            ? '<span class="badge lock">禁止</span>'
            : '<span class="badge">允许</span>'
        }</td>
        <td class="actions">${projectRowActions(p)}</td>
      </tr>`
        )
        .join('') || '<tr><td colspan="6" class="table-empty">没有匹配的项目</td></tr>'
    wireProjectActions()
  }
  draw(state.routeQuery?.get('q') ?? '')
  $('#projectSearch').value = state.routeQuery?.get('q') ?? ''
  $('#projectSearch').oninput = (e) => {
    draw(e.target.value)
    syncListQuery('projects', { q: e.target.value.trim() })
  }
  const registerBtn = $('#registerProjectBtn')
  if (registerBtn) {
    registerBtn.onclick = () =>
      void registerProjectDialog().catch((err) => toast(`打开登记弹层失败：${err.message ?? err}`))
  }
}

/* ---------------- 项目登记弹层（M120a · QA-013） ---------------- */

/** 管理员路由对 key 只查重不校验语法（R1），语法守门只能由控制台补位。 */
const REGISTRATION_FIELD_BY_CODE = {
  HOST_NOT_FOUND: 'regHost',
  PROJECT_EXISTS: 'regKey',
  PROJECT_PATH_TAKEN: 'regPath',
  PROJECT_PATH_INVALID: 'regPath',
  REPO_URL_INVALID: 'regRepo',
  BRANCH_INVALID: 'regBranch'
}

const PROJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

/** 与 project-key.ts / project-path.ts 同规则的客户端软校验，服务端仍是权威。 */
function registrationFieldErrors(fields) {
  const errors = []
  if (fields.name === '') {
    errors.push(['regName', '项目名称不能为空。'])
  } else if (fields.name.length > 200) {
    errors.push(['regName', '项目名称不能超过 200 个字符。'])
  }
  if (fields.key === '' || fields.key.length > 64) {
    errors.push(['regKey', '项目 Key 长度必须为 1–64 个字符。'])
  } else if (!PROJECT_KEY_PATTERN.test(fields.key)) {
    errors.push([
      'regKey',
      '项目 Key 必须以小写字母或数字开头，且只能包含小写字母、数字、点、下划线或连字符。'
    ])
  } else if (fields.key.endsWith('.')) {
    errors.push(['regKey', '项目 Key 不能是 “.” 或 “..”，也不能以 “.” 结尾。'])
  }
  if (fields.hostId === '') {
    errors.push(['regHost', '请选择目标主机。'])
  }
  const path = fields.path
  if (path === '') {
    errors.push(['regPath', '项目路径不能为空。'])
  } else if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    errors.push(['regPath', '项目路径必须是绝对路径。'])
  } else if (path.split(/[\\/]/).includes('..')) {
    errors.push(['regPath', '项目路径不能包含 “.” 或 “..” 段。'])
  } else if (path !== '/' && !/^[A-Za-z]:[\\/]$/.test(path) && /[\\/]$/.test(path)) {
    errors.push(['regPath', '项目路径不能以分隔符结尾。'])
  }
  return errors
}

function setRegistrationError(inputId, message) {
  $(`#${inputId}`).classList.add('invalid')
  const line = $(`#${inputId}Error`)
  line.textContent = message
  line.hidden = false
}

function hostOptionLabel(h) {
  if (h.status === 'maintenance') {
    return `${h.name}（维护中）`
  }
  return h.online ? h.name : `${h.name}（离线）`
}

async function registerProjectDialog() {
  const hosts = (await api('/v1/hosts')).hosts.filter((h) => !h.revokedAt)
  let backdrop = null

  const clearErrors = () => {
    for (const line of backdrop.querySelectorAll('.inline-error')) {
      line.hidden = true
      line.textContent = ''
    }
    for (const control of backdrop.querySelectorAll('input, select')) {
      control.classList.remove('invalid')
    }
  }

  const readForm = () => ({
    name: $('#regName').value.trim(),
    key: $('#regKey').value.trim(),
    hostId: $('#regHost').value,
    path: $('#regPath').value.trim(),
    repoUrl: $('#regRepo').value.trim(),
    defaultBranch: $('#regBranch').value.trim()
  })

  const submitRegistration = () => {
    clearErrors()
    const fields = readForm()
    const errors = registrationFieldErrors(fields)
    if (errors.length > 0) {
      for (const [id, message] of errors) {
        setRegistrationError(id, message)
      }
      $(`#${errors[0][0]}`).focus()
      return false
    }
    const button = backdrop.querySelector('[data-action="0"]')
    button.disabled = true
    void (async () => {
      let created
      try {
        created = await api('/v1/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: fields.name,
            key: fields.key,
            hostId: fields.hostId,
            // 管理员路由是 path 直供语义（W8）：不发 dir，缺省项不进请求体。
            path: fields.path,
            ...(fields.repoUrl ? { repoUrl: fields.repoUrl } : {}),
            ...(fields.defaultBranch ? { defaultBranch: fields.defaultBranch } : {})
          })
        })
      } catch (err) {
        button.disabled = false
        const fieldId = REGISTRATION_FIELD_BY_CODE[err.code ?? '']
        if (fieldId) {
          setRegistrationError(fieldId, err.message ?? '登记失败。')
        } else {
          const top = $('#regError')
          top.textContent = err.message ?? '登记失败。'
          top.hidden = false
        }
        return
      }
      backdrop.remove()
      toast(
        `项目已登记${created.repoUrl ? '，克隆中，就绪后可打开' : ''}。授权请在项目详情的「权限」页签中配置。`
      )
      await renderProjects()
    })()
    return false
  }

  backdrop = dialog(
    '登记项目',
    `
    <p class="inline-error" id="regError" hidden></p>
    <div class="field"><span>项目名称</span>
      <input id="regName" placeholder="如 支付服务">
      <p class="inline-error" id="regNameError" hidden></p>
    </div>
    <div class="field"><span>项目 Key</span>
      <input id="regKey" placeholder="如 payment-service（小写字母、数字、点、下划线、连字符）">
      <p class="inline-error" id="regKeyError" hidden></p>
    </div>
    <div class="field"><span>目标主机</span>
      <select class="select" id="regHost" style="width:100%">
        <option value="">请选择主机</option>
        ${hosts.map((h) => `<option value="${esc(h.id)}">${esc(hostOptionLabel(h))}</option>`).join('')}
      </select>
      <p class="inline-error" id="regHostError" hidden></p>
    </div>
    <div class="field"><span>目标路径</span>
      <input id="regPath" placeholder="主机上的绝对路径，如 /srv/work/payment-service">
      <p class="muted mono" id="regRootHint" style="margin:6px 0 0" hidden></p>
      <p class="inline-error" id="regPathError" hidden></p>
    </div>
    <div class="field"><span>仓库地址（可选）</span>
      <input id="regRepo" placeholder="留空则登记即就绪，不触发克隆">
      <p class="inline-error" id="regRepoError" hidden></p>
    </div>
    <div class="field"><span>默认分支（可选）</span>
      <input id="regBranch" placeholder="留空使用远端默认分支">
      <p class="inline-error" id="regBranchError" hidden></p>
    </div>`,
    [{ label: '登记', primary: true, onClick: submitRegistration }]
  )
  let lastHostId = $('#regHost').value
  $('#regHost').onchange = () => {
    const hostId = $('#regHost').value
    // An absolute path is scoped to one host's root; carrying it across a host
    // switch registers a directory the user never picked on the new machine.
    if (lastHostId !== '' && hostId !== lastHostId) {
      $('#regPath').value = ''
      const pathError = $('#regPathError')
      pathError.hidden = true
      pathError.textContent = ''
      $('#regPath').classList.remove('invalid')
    }
    lastHostId = hostId
    const hint = $('#regRootHint')
    const root = hosts.find((h) => h.id === hostId)?.projectsRoot
    hint.textContent = root ? `主机项目根：${root}` : ''
    hint.hidden = !root
  }
  // 失焦即校（§3.2）：key 单字段跑与提交同一份规则，只做即时反馈；拦截仍在提交时。
  $('#regKey').onblur = () => {
    const error = registrationFieldErrors(readForm()).find(([id]) => id === 'regKey')
    if (error) {
      setRegistrationError('regKey', error[1])
      return
    }
    $('#regKey').classList.remove('invalid')
    const line = $('#regKeyError')
    line.hidden = true
    line.textContent = ''
  }
}

async function renderHosts() {
  const [hostsBody, policy] = await Promise.all([api('/v1/hosts'), api('/v1/policies/download')])
  state.lastHosts = hostsBody.hosts
  content().innerHTML = `
    <div class="page-head">
      <div><h1>主机</h1><p>已注册开发机、心跳状态与直连/中继路径。</p></div>
      <button class="btn primary" id="registerHostBtn">注册主机</button>
    </div>
    <div class="note">中继路由由平台单向同步；未知 SNI 默认黑洞。下载默认策略：<strong>${policy.downloadDefault === 'deny' ? '禁止' : '允许'}</strong>（v${policy.version}）。</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>主机</th><th>直连地址</th><th>中继路由</th><th>中继</th><th>版本</th><th>心跳</th><th>状态</th><th class="actions">操作</th></tr></thead>
        <tbody>
          ${hostsBody.hosts.map(hostRow).join('') || '<tr><td colspan="8" class="table-empty">尚未注册主机</td></tr>'}
        </tbody>
      </table>
    </div>`
  $('#registerHostBtn').onclick = registerHostDialog
  for (const btn of document.querySelectorAll('[data-host]')) {
    btn.onclick = () => openDetailFromList('hosts', btn.dataset.host ?? '')
  }
}

function hostRow(h) {
  // The heartbeat window decides liveness: a stored "online" must not keep a
  // silent host green (M116-QA-005). Revocation is terminal and labelled.
  const status = h.revokedAt
    ? '已吊销'
    : h.status === 'maintenance'
      ? '维护中'
      : h.online
        ? '在线'
        : '离线'
  const dot = h.revokedAt
    ? 'offline'
    : h.status === 'maintenance'
      ? 'warn'
      : h.online
        ? 'online'
        : 'offline'
  return `<tr>
    <td><strong>${esc(h.name)}</strong><div class="muted mono">${esc(h.zone)}</div></td>
    <td class="mono">${esc(h.directAddrs.join('<br>') || '—')}</td>
    <td class="mono">${esc(h.relayRoute ?? '—')}</td>
    <td>${hostRelayCell(h)}</td>
    <td>${esc(h.orcaVersion)} <span class="muted">p${h.protocolVersion}</span></td>
    <td>${relative(h.lastHeartbeatAt)}</td>
    <td><span class="dot ${dot}"></span> ${status}</td>
    <td class="actions"><button class="btn sm" data-host="${h.id}">详情</button></td>
  </tr>`
}

/**
 * U79: the host↔relay binding (route target), with an offline flag when no
 * live relay serves routes any more — the blast radius of a dead relay.
 */
function hostRelayCell(h) {
  const bound = h.relayTarget
    ? `<span class="mono">${esc(h.relayTarget)}</span>`
    : '<span class="muted mono">—</span>'
  const offline = h.relayRoute && h.relayOnline === false
  if (!offline) return bound
  const direct = (h.directAddrs ?? []).length > 0 ? '<div class="muted">直连不受阻</div>' : ''
  return `${bound}<div><span class="badge warn">中继离线</span> ${direct}</div>`
}

/** Drawer form of the same U79 verdict: bound target plus the offline caveat. */
function hostRelayOfflineNote(host) {
  const offline = host.relayRoute && host.relayOnline === false
  if (!offline) return ''
  const direct = (host.directAddrs ?? []).length > 0 ? '（直连不受阻）' : ''
  return ` <span class="badge warn">中继离线</span>${direct}`
}

function copyCommandAction(cmd) {
  return {
    label: '复制命令',
    primary: false,
    onClick: () => {
      navigator.clipboard?.writeText(cmd)
      toast('已复制')
      return false
    }
  }
}

async function registerHostDialog() {
  const body = await api('/v1/hosts/tokens', { method: 'POST' })
  // U115: the target machine has no session, so the one-liner carries a
  // short-lived one-time download token alongside the registration token.
  const download = body.downloadToken ? `download=${encodeURIComponent(body.downloadToken)}&` : ''
  const cmd = `bash <(curl -fsSL ${location.origin}/install/host.sh?${download}token=${body.token})`
  dialog(
    '注册主机',
    `<p>在目标开发机执行以下命令完成注册。脚本会写入环境配置并生成自签证书，命令 10 分钟内有效且只能下载一次；注册令牌 24 小时内有效且只能使用一次。</p>
     <pre id="installCmd">${esc(cmd)}</pre>`,
    [copyCommandAction(cmd)]
  )
}

async function showHost(hostId, { tab = 'info', onClose } = {}) {
  const host = state.lastHosts.find((h) => h.id === hostId)
  if (!host) return
  // Host routes are admin-only; the directory feeds the permission-tab pickers.
  if (!state.directory && isAdmin()) state.directory = await loadDirectory()
  const detailEntry = { name: 'hosts', id: host.id, remove: () => drawer.backdrop.remove() }
  const drawer = openDrawer(
    `主机 ${host.name}`,
    `
    <div class="detail-tabs">
      <button class="detail-tab active" data-auth-tab="info">信息</button>
      <button class="detail-tab" data-auth-tab="perms">权限</button>
    </div>
    <div data-auth-panel="info">
      <dl class="kv">
        <dt>主机 ID</dt><dd class="mono">${esc(host.id)}</dd>
        <dt>指纹</dt><dd class="mono">${esc(host.fingerprint)}</dd>
        <dt>E2EE 公钥</dt><dd class="mono">${esc(host.e2eePublicKey)}</dd>
        <dt>版本</dt><dd>${esc(host.orcaVersion)} · 协议 v${host.protocolVersion}</dd>
        <dt>网络位置</dt><dd>${esc(host.zone)}</dd>
        <dt>直连地址</dt><dd class="mono">${esc(host.directAddrs.join(', ') || '—')}</dd>
        <dt>中继路由</dt><dd class="mono">${esc(host.relayRoute ?? '—')}</dd>
        <dt>中继绑定</dt><dd class="mono">${esc(host.relayTarget ?? '—')}${hostRelayOfflineNote(host)}</dd>
        <dt>能力</dt><dd>${esc(host.capabilities.join(', '))}</dd>
        <dt>最近心跳</dt><dd>${relative(host.lastHeartbeatAt)}</dd>
        ${host.revokedAt ? `<dt>状态</dt><dd>已吊销（${new Date(host.revokedAt).toLocaleString('zh-CN')}）</dd>` : ''}
      </dl>
      <div class="toolbar" style="margin-top:20px">
        <button class="btn" id="maintenanceBtn" ${host.revokedAt ? 'disabled title="主机已下线"' : ''}>${host.status === 'maintenance' ? '结束维护' : '进入维护模式'}</button>
        <button class="btn danger" id="revokeHostBtn" ${host.revokedAt ? 'disabled' : ''}>下线主机</button>
      </div>
      <p class="muted" style="margin-top:12px">下线后该主机的项目立即不可打开，已签发凭证失效。</p>
    </div>
    <div data-auth-panel="perms" hidden>
      <div id="hostPermCards"><p class="muted">加载中…</p></div>
    </div>`,
    {
      onClose: () => {
        if (activeDetail !== detailEntry) return // 已被路由静默移除
        activeDetail = null
        onClose?.()
      }
    }
  )
  activeDetail = detailEntry
  wireAuthTabs(drawer.backdrop, {
    active: tab,
    onSelect: (key) => replaceDetailTab('hosts', host.id, key)
  })
  $('#maintenanceBtn').onclick = async () => {
    await api(`/v1/hosts/${host.id}/maintenance`, {
      method: 'POST',
      body: JSON.stringify({ enabled: host.status !== 'maintenance', reason: '管理员操作' })
    })
    drawer.close()
    renderHosts()
  }
  $('#revokeHostBtn').onclick = async () => {
    if (!confirmDialog('确认下线该主机？')) return
    await api(`/v1/hosts/${host.id}`, { method: 'DELETE' })
    drawer.close()
    renderHosts()
  }
  await showHostGrants(host)
}

/**
 * U67: the drawer's permission tab is the only host-grant entry. Cards are the
 * role view of the stored bits; every add/remove is one immediate row PUT.
 */
async function showHostGrants(host) {
  const grantsPath = `/v1/hosts/${host.id}/grants`
  const holder = $('#hostPermCards')
  let body
  try {
    body = await api(grantsPath)
  } catch (err) {
    if (holder) {
      holder.innerHTML = `<div class="note danger">授权加载失败：${esc(hostGrantErrorText(err))}</div>`
    }
    return
  }
  if (!holder) return // the drawer was closed while the grants were loading
  holder.innerHTML = permCardsHtml(HOST_ROLE_CARDS, body.grants, {
    kind: 'host',
    roleOf: hostRoleOf,
    showBits: false,
    showLevel: false,
    defaultSubjectType: 'user',
    footnote: PERM_FOOTNOTE,
    datalistPrefix: 'host'
  })
  wirePermCards(holder, {
    grantsPath,
    rows: body.grants,
    cards: HOST_ROLE_CARDS,
    kind: 'host',
    noun: '主机',
    errorText: hostGrantErrorText,
    datalistPrefix: 'host',
    onChange: () => showHostGrants(host)
  })
}

async function renderRelays() {
  const body = await api('/v1/relays')
  content().innerHTML = `
    <div class="page-head">
      <div><h1>中继</h1><p>已注册中继节点、客户端拨号地址与在线状态。</p></div>
      <div>
        <button class="btn primary" id="addRelayBtn">添加中继</button>
        <button class="btn" id="refreshRelaysBtn">刷新</button>
      </div>
    </div>
    <div class="note">客户端地址是客户端实际拨号的 host:port：中继显式上报的可达地址优先，未上报时取注册来源 IP。路由表由平台单向同步。</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>节点 ID</th><th>客户端地址</th><th>状态</th><th>最近注册时间</th></tr></thead>
        <tbody>
          ${body.relays.map(relayRow).join('') || '<tr><td colspan="4" class="table-empty">尚未注册中继</td></tr>'}
        </tbody>
      </table>
    </div>`
  $('#addRelayBtn').onclick = addRelayDialog
  $('#refreshRelaysBtn').onclick = () => renderRelays()
}

/** FR-4.11: the internal token is injected by the script endpoint, never the URL. */
async function addRelayDialog() {
  // U115: the target machine has no session, so the command carries a one-time
  // download token; the internal token still never travels in the URL.
  const body = await api('/v1/relays/install-tokens', { method: 'POST' })
  const cmd = body.downloadToken
    ? `bash <(curl -fsSL ${location.origin}/install/relay.sh?download=${encodeURIComponent(body.downloadToken)})`
    : `bash <(curl -fsSL ${location.origin}/install/relay.sh)`
  dialog(
    '添加中继',
    `<p>在中继机执行以下命令完成注册上线。命令 10 分钟内有效且只能下载一次；内部控制令牌由脚本端点注入，不出现在 URL 中。</p>
     <pre id="relayInstallCmd">${esc(cmd)}</pre>
     <p class="muted">仅管理员可见。RELAY_PUBLIC_HOST 缺省时平台记录注册来源 IP。</p>`,
    [copyCommandAction(cmd)]
  )
}

function relayRow(r) {
  return `<tr>
    <td class="mono">${esc(r.id)}</td>
    <td class="mono">${esc(`${r.host}:${r.port}`)}</td>
    <td><span class="dot ${r.online ? 'online' : 'offline'}"></span> ${r.online ? '在线' : '离线'}</td>
    <td class="muted">${new Date(r.lastSeenAt).toLocaleString()}</td>
  </tr>`
}

/* ---------------- 用户管理（U67-3：平台级身份，覆盖优先于 LDAP 同步） ---------------- */

const USER_PAGE_ROLE_LABELS = { developer: '普通', auditor: '审计', admin: '管理员' }
const USER_SOURCE_LABELS = { ldap: 'LDAP 同步', 'admin-override': '管理员覆盖' }
/** U81：查询条件客户端过滤（零 wire 变更）；跨重绘保留，角色变更后筛选不丢。 */
let userFilter = { query: '', role: 'all', status: 'all' }

const USER_ROLES = ['developer', 'auditor', 'admin']
const USER_STATUSES = ['active', 'disabled']

/** T7：URL 是筛选状态的载体，非法值规范化为 all。 */
function userFilterFromQuery(query) {
  const role = query?.get('role')
  const status = query?.get('status')
  return {
    query: query?.get('query') ?? '',
    role: typeof role === 'string' && USER_ROLES.includes(role) ? role : 'all',
    status: typeof status === 'string' && USER_STATUSES.includes(status) ? status : 'all'
  }
}

/** 原型 #/users（U81/U82）：查询栏 + 只读列表 + 详情弹框（角色修改唯一入口）。返回列表数据供弹框同步。 */
async function renderUsersPage() {
  userFilter = userFilterFromQuery(state.routeQuery)
  const body = await api('/v1/users')
  const users = body.users
  state.users = users
  content().innerHTML = `
    <div class="page-head">
      <div>
        <h1>用户管理</h1>
        <p>平台账号与角色设置。用户与组来自 LDAP 同步；角色为按用户覆盖，覆盖记录留审计。</p>
      </div>
      <div class="toolbar">
        <span class="badge ok"><span class="dot online"></span>LDAP 同步正常</span>
        <span class="badge">${users.length} 个账号</span>
      </div>
    </div>
    <div class="note"><strong>角色 ≠ 资源授权（两层模型）</strong>：本页的「普通 / 审计 / 管理员」是平台级身份——决定管控面与审计面可见性；「谁能用哪些项目、有哪些操作」由项目 / 主机详情弹框权限页签的角色卡片（资源授权）决定。管理员角色不等于项目内全权：打开项目仍需显式授权。</div>
    <div class="toolbar" role="search" aria-label="用户查询">
      <input class="input grow" id="userSearch" type="search" placeholder="用户名关键字：显示名或账号，如 张伟 / zhangwei" aria-label="用户名关键字" autocomplete="off">
      <select class="select" id="userRoleFilter" aria-label="角色">
        <option value="all">全部角色</option>
        <option value="developer">普通</option>
        <option value="auditor">审计</option>
        <option value="admin">管理员</option>
      </select>
      <select class="select" id="userStatusFilter" aria-label="状态">
        <option value="all">全部状态</option>
        <option value="active">活跃</option>
        <option value="disabled">已停用</option>
      </select>
      <button class="btn primary" id="userFilterApply" type="button">查询</button>
      <button class="btn ghost" id="userFilterReset" type="button">重置</button>
    </div>
    <div class="section-head"><h2>账号与角色</h2><span class="muted">列表只读 · 角色在详情中修改 · 变更写入 role_update 审计</span></div>
    <div class="table-wrap">
      <table aria-label="用户与角色">
        <thead><tr><th>用户</th><th>部门</th><th>LDAP 组</th><th>角色</th><th>角色来源</th><th>状态</th><th>操作</th></tr></thead>
        <tbody id="usersBody"></tbody>
      </table>
    </div>
    <p class="muted" id="usersFoot"></p>
    <div class="note">角色语义：普通 = 项目 / 主机使用面（按资源授权）；审计 = + 审计查询（目录保持 admin-only），不可管控；管理员 = 全管控面 + 授权卡片写入。新用户首登角色一律普通（LDAP 组→角色种子映射已废除）；升权经用户管理页覆盖（roleOverride 优先、不被回灌），登录准入由 LDAP 分组门槛独立控制。</div>`
  const search = $('#userSearch')
  const roleSelect = $('#userRoleFilter')
  const statusSelect = $('#userStatusFilter')
  search.value = userFilter.query
  roleSelect.value = userFilter.role
  statusSelect.value = userFilter.status
  const apply = ({ push = false } = {}) => {
    userFilter = { query: search.value, role: roleSelect.value, status: statusSelect.value }
    syncListQuery(
      'users',
      {
        query: userFilter.query.trim(),
        role: userFilter.role === 'all' ? '' : userFilter.role,
        status: userFilter.status === 'all' ? '' : userFilter.status
      },
      { push }
    )
    renderUserRows(users)
  }
  // 即输即筛为主，「查询」按钮兜底重放（T4 裁定：两者并存）。
  search.oninput = () => apply()
  roleSelect.onchange = () => apply()
  statusSelect.onchange = () => apply()
  $('#userFilterApply').onclick = () => apply({ push: true })
  $('#userFilterReset').onclick = () => {
    userFilter = { query: '', role: 'all', status: 'all' }
    search.value = ''
    roleSelect.value = 'all'
    statusSelect.value = 'all'
    syncListQuery('users', {})
    renderUserRows(users)
  }
  renderUserRows(users)
  return users
}

function filterUsers(users) {
  const query = userFilter.query.trim().toLowerCase()
  return users.filter((user) => {
    const matchesQuery =
      !query ||
      user.displayName.toLowerCase().includes(query) ||
      user.username.toLowerCase().includes(query)
    const matchesRole = userFilter.role === 'all' || user.role === userFilter.role
    const matchesStatus = userFilter.status === 'all' || user.status === userFilter.status
    return matchesQuery && matchesRole && matchesStatus
  })
}

function userSourceMarkup(source) {
  return source === 'admin-override'
    ? `<span class="badge ok">${esc(USER_SOURCE_LABELS[source])}</span>`
    : `<span class="muted">${esc(USER_SOURCE_LABELS[source] ?? 'LDAP 同步')}</span>`
}

function statusMarkup(status) {
  const active = status === 'active'
  return `<span class="dot ${active ? 'online' : 'offline'}"></span> ${active ? '活跃' : '已停用'}`
}

function renderUserRows(users) {
  const tbody = $('#usersBody')
  if (!tbody) return
  const filtered = filterUsers(users)
  tbody.innerHTML = filtered.length
    ? filtered.map(userRow).join('')
    : '<tr><td colspan="7" class="table-empty">没有符合筛选条件的账号——请调整关键字或重置条件</td></tr>'
  const foot = $('#usersFoot')
  if (foot) {
    foot.textContent = `共 ${users.length} 个账号${filtered.length !== users.length ? ` · 当前筛选 ${filtered.length} 个` : ''} · 服务端按请求实时判定角色；角色降级会断开当前云会话（≤60 秒），升级即时生效、不断会话。变更可在审计日志按「角色变更 · role_update」筛选。`
  }
  for (const button of document.querySelectorAll('[data-user-detail]')) {
    button.onclick = () => openDetailFromList('users', button.dataset.userDetail ?? '')
  }
}

/** 列表只读（U82）：角色纯文本 + 行内唯一动作「详情」。 */
function userRow(user) {
  return `<tr>
    <td><strong>${esc(user.displayName)}</strong><div class="muted mono">${esc(user.username)}</div></td>
    <td>${esc(user.dept)}</td>
    <td class="mono">${esc(user.groups.join(', ') || '—')}</td>
    <td>${esc(USER_PAGE_ROLE_LABELS[user.role] ?? user.role)}</td>
    <td>${userSourceMarkup(user.roleSource)}</td>
    <td>${statusMarkup(user.status)}</td>
    <td><button class="btn ghost" data-user-detail="${esc(user.id)}">详情</button></td>
  </tr>`
}

/** 用户详情弹框字段集（U82）：users API 实有字段，创建时间/最近登录无 wire 数据不虚构。 */
function userDetailMarkup(user) {
  const active = user.status === 'active'
  const roleOptions = Object.entries(USER_PAGE_ROLE_LABELS)
    .map(
      ([value, label]) =>
        `<option value="${value}"${user.role === value ? ' selected' : ''}>${label}</option>`
    )
    .join('')
  return `<dl class="kv">
    <dt>显示名</dt><dd>${esc(user.displayName)}</dd>
    <dt>账号</dt><dd class="mono">${esc(user.username)}</dd>
    <dt>部门</dt><dd>${esc(user.dept)}</dd>
    <dt>LDAP 组</dt><dd class="mono">${esc(user.groups.join(', ') || '—')}</dd>
    <dt>平台角色</dt><dd>
      <select class="select" data-detail-role aria-label="平台角色（点击修改）"${active ? '' : ' disabled'}>${roleOptions}</select>
      <span class="muted">${active ? '点击可修改' : '已停用账号不可修改角色'}</span>
    </dd>
    <dt>角色来源</dt><dd>${userSourceMarkup(user.roleSource)}</dd>
    <dt>状态</dt><dd>${statusMarkup(user.status)}</dd>
  </dl>
  <p class="muted" style="margin-top:12px">角色变更写入 role_update 审计，按用户覆盖优先于 LDAP 同步；降级将断开该用户当前云会话（≤60 秒），升级即时生效。列表只读，角色修改仅在此处进行。</p>`
}

function openUserDetail(user, { onClose } = {}) {
  const detailEntry = { name: 'users', id: user.id, remove: () => backdrop.remove() }
  const backdrop = dialog(`用户详情 · ${user.displayName}`, userDetailMarkup(user), [], {
    wide: true,
    onClose: () => {
      if (activeDetail !== detailEntry) return // 已被路由静默移除
      activeDetail = null
      onClose?.()
    }
  })
  activeDetail = detailEntry
  wireDetailRoleSelect(backdrop, user)
}

/** 弹框内角色下拉 change → 既有确认链；确认后弹框保持打开并重绘为新值。 */
function wireDetailRoleSelect(backdrop, user) {
  const select = backdrop.querySelector('[data-detail-role]')
  if (!select) return
  select.value = user.role // 显式落值：innerHTML 的 selected 属性在部分 DOM 实现不可靠
  select.onchange = () => {
    const next = select.value
    select.value = user.role // 回退到当前值：确认成功后重绘才会翻转
    if (user.status !== 'active') return // T3：停用账号不可修改角色
    confirmUserRoleChange(user, next, (fresh) => {
      const body = backdrop.querySelector('.body')
      if (!body) return
      body.innerHTML = userDetailMarkup(fresh)
      wireDetailRoleSelect(backdrop, fresh)
    })
  }
}

/** 确认弹框（降级 danger + 断开会话副题）→ PUT → 列表同步 + 回调刷新弹框 + toast。 */
function confirmUserRoleChange(user, next, onChanged) {
  if (next === user.role) return
  const demote = user.role === 'admin' && next !== 'admin'
  dialog(
    '角色变更',
    `<p><strong>${esc(user.displayName)}（${esc(user.username)}）</strong>：${USER_PAGE_ROLE_LABELS[user.role]} → ${USER_PAGE_ROLE_LABELS[next]}。</p>
     <p class="muted">变更写入 role_update 审计；按用户覆盖优先于 LDAP 同步，再次登录不会被同步覆盖。</p>
     ${demote ? '<p class="note warn">降级将断开该用户当前云会话（≤60 秒）。</p>' : '<p class="muted">升级即时生效，不断开会话。</p>'}`,
    [
      {
        label: '确认变更',
        primary: !demote,
        danger: demote,
        onClick: () => void applyUserRoleChange(user, next, onChanged)
      }
    ]
  )
}

async function applyUserRoleChange(user, next, onChanged) {
  try {
    await api(`/v1/users/${user.id}/roles`, {
      method: 'PUT',
      body: JSON.stringify({ role: next })
    })
    toast(`已将 ${user.displayName} 的角色更新为${USER_PAGE_ROLE_LABELS[next]}`)
  } catch (err) {
    // 失败重绘回滚：列表与弹框不能继续显示一个没落库的角色。
    toast(`保存失败：${err.message ?? err}`)
  }
  const users = await renderUsersPage()
  const fresh = users.find((item) => item.id === user.id) ?? user
  onChanged?.(fresh, users)
}

/** The subject picker is an enhancement: a failed directory read keeps free text. */
async function loadDirectory() {
  try {
    return await api('/v1/directory')
  } catch {
    return null
  }
}

/* ---------------- 授权卡片（U67：详情弹框权限页签 = 唯一授权入口） ---------------- */

/** Server verdicts the cards must explain, not echo as a raw code (AA4). */
const GRANT_ERROR_TEXT = {
  GROUP_NOT_FOUND: '组不存在或平台未见过该组。',
  GRANT_PERMISSION_INVALID:
    '权限位无效：仅支持 open、terminal、agent、file:read、file:write、browser、download。'
}
const grantErrorText = (err) => GRANT_ERROR_TEXT[err?.code] ?? err?.message ?? String(err)

const HOST_GRANT_ERROR_TEXT = {
  ...GRANT_ERROR_TEXT,
  HOST_GRANT_PERMISSION_INVALID: '主机权限位不在允许范围内。',
  HOST_PROVISION_POLICY_INVALID: '自助建项目策略只能是 open 或 restricted。'
}
const hostGrantErrorText = (err) => HOST_GRANT_ERROR_TEXT[err?.code] ?? err?.message ?? String(err)

const grantKey = (g) => `${g.subjectType}:${g.subjectId}`
const subjectLabel = (g) => g.username ?? g.subjectId

/**
 * 角色 → 位组合映射（u67-authz-refactor-design §2 / 审定二）。存储行保持位组合；
 * 位置即权限——主体只出现在其被授权的最高级别卡（查看 < 控制 < 管理）。
 */
const HOST_ROLE_CARDS = [
  {
    key: 'view',
    label: '查看',
    bits: ['view'],
    desc: '主机只读：可见该主机全部非归档项目并打开查看；项目内上限 = 打开 + 文件只读。不能创建 / 维护主机，不能使用终端 / Agent / 编辑 / 浏览器 / 下载。'
  },
  {
    key: 'control',
    label: '控制',
    bits: ['view', 'provision'],
    desc: '主机全权（操作推导）：可见全部项目，项目内终端 / Agent / 文件读写 / 浏览器可用；下载仍按下载策略独立判定。含创建 / 登记项目能力（不含主机维护）。'
  },
  {
    key: 'manage',
    label: '管理',
    bits: ['provision', 'maintain'],
    desc: '创建 / 登记项目 + 进入 / 退出维护模式。不推导项目可见性（仅显式授权项目可见），不授予项目内操作位；吊销主机仍仅限平台管理员。'
  }
]

/** 审定二：层级单卡——按存储位推导主体唯一的卡片（高级隐含低级）。 */
function hostRoleOf(permissions) {
  const has = (bit) => permissions.includes(bit)
  if (has('provision') && has('maintain')) return 'manage'
  if (has('view') && has('provision')) return 'control'
  if (has('view')) return 'view'
  return null
}

const PROJECT_OP_BITS = ['terminal', 'agent', 'file:write', 'browser', 'download']

const PROJECT_ROLE_CARDS = [
  {
    key: 'view',
    label: '查看',
    bits: ['open', 'file:read'],
    desc: '项目可见、可打开；文件浏览与预览。'
  },
  {
    key: 'control',
    label: '控制',
    bits: PROJECT_OP_BITS,
    desc: '项目内操作位：终端、Agent、文件写入、浏览器与下载；下载仍需项目 / 全局下载策略为「允许」才放行（FR-7）。'
  }
]

const PERM_FOOTNOTE =
  '变更即时保存（PUT 整行替换）；已存在于其它卡片时先弹覆盖确认。降级保存将断开该主体当前全部云会话，≤60 秒生效（FR-1.7）。'

/** 合成级别徽标（§2.2）：管理台不产生这两种读法之外的级别。 */
function permLevelLabel(kind, permissions) {
  const has = (bit) => permissions.includes(bit)
  if (kind === 'host') {
    if (has('view') && has('provision')) return has('maintain') ? '全权+维护' : '全权'
    if (has('view')) return '只读'
    if (has('provision') && has('maintain')) return '管理（创建+维护）'
    return '其他位组合'
  }
  const levels = []
  if (has('open') && has('file:read')) levels.push('查看')
  if (PROJECT_OP_BITS.some((bit) => has(bit))) levels.push('控制')
  return levels.join('+') || '其他位组合'
}

/** Tab switch is pure overlay view state; the URL keeps it via `?tab=`. */
function wireAuthTabs(scope, { active = 'info', onSelect } = {}) {
  const tabs = scope.querySelectorAll('[data-auth-tab]')
  const show = (key) => {
    for (const other of tabs) other.classList.toggle('active', other.dataset.authTab === key)
    for (const panel of scope.querySelectorAll('[data-auth-panel]')) {
      panel.hidden = panel.dataset.authPanel !== key
    }
  }
  show(active)
  for (const tab of tabs) {
    tab.onclick = () => {
      show(tab.dataset.authTab)
      onSelect?.(tab.dataset.authTab)
    }
  }
}

function permChipHtml(row, card, kind, { showLevel = true } = {}) {
  const dead = row.subjectType === 'user' && !row.username
  const removable = card.key !== 'derived' && !dead
  const level = showLevel
    ? `<span class="badge">${esc(permLevelLabel(kind, row.permissions))}</span>`
    : ''
  return `<span class="perm-chip" data-chip="${esc(grantKey(row))}">
      <span class="mono">${esc(subjectLabel(row))}</span>${dead ? ' <span class="badge">已删除用户</span>' : ''}
      <span class="muted">${row.subjectType === 'group' ? '组' : '用户'}</span>
      ${level}
      <button class="perm-chip-x" data-perm-remove="${esc(grantKey(row))}" data-card="${esc(card.key)}" title="从「${esc(card.label)}」移除 ${esc(subjectLabel(row))}"${removable ? '' : ' disabled'}>✕</button>
    </span>`
}

function permDatalistsHtml(prefix) {
  const directory = state.directory
  if (!directory) return ''
  // Values must be what the platform resolves (username / exact group name);
  // display name and department only help the admin pick it (AA4).
  const users = (directory.users ?? [])
    .map(
      (user) =>
        `<option value="${esc(user.username)}">${esc(user.displayName)}${user.dept ? ` · ${esc(user.dept)}` : ''}</option>`
    )
    .join('')
  const groups = (directory.groups ?? [])
    .map((group) => `<option value="${esc(group)}"></option>`)
    .join('')
  return `<datalist id="${prefix}UserOptions">${users}</datalist><datalist id="${prefix}GroupOptions">${groups}</datalist>`
}

/** 项目弹框的管理卡：主机推导只读视图（FR-9.11③ 不扩大），不可添加/移除。 */
function projectDerivedCardHtml(hostRows) {
  const chips =
    hostRows == null
      ? '<span class="muted">未能读取主机授权</span>'
      : hostRows
          .filter((row) => row.permissions.includes('view'))
          .map((row) => {
            const full = row.permissions.includes('provision')
            return `<span class="perm-chip"><span class="mono">${esc(subjectLabel(row))}</span> <span class="muted">${row.subjectType === 'group' ? '组' : '用户'}</span> <span class="badge">${full ? '全权（来源）' : '只读（上限）'}</span></span>`
          })
          .join('') || '<span class="muted">暂无主机级主体</span>'
  return `
    <div class="perm-card" data-card="derived">
      <div class="perm-card-head"><strong>管理</strong><span class="badge">主机推导 · 只读</span></div>
      <p class="muted perm-card-desc">项目级无「管理」权限位：归档 / 登记归创建者或平台管理员，主机维护属主机授权。下方为按 U65 推导在本项目获得权限的主机级主体——在主机详情弹框维护，项目授权不扩大到主机级。</p>
      <div class="perm-chips">${chips}</div>
    </div>`
}

function permCardsHtml(cards, rows, options) {
  const { kind } = options
  const showBits = options.showBits !== false
  const showLevel = options.showLevel !== false
  const belongs = options.roleOf
    ? (row, card) => options.roleOf(row.permissions) === card.key
    : (row, card) => card.bits.some((bit) => row.permissions.includes(bit))
  const userFirst = options.defaultSubjectType === 'user'
  const cardsHtml = cards
    .map((card) => {
      const matching = rows.filter((row) => belongs(row, card))
      return `
      <div class="perm-card" data-card="${esc(card.key)}">
        <div class="perm-card-head"><strong>${esc(card.label)}</strong>${showBits ? `<span class="badge">${esc(card.bits.join(' + '))}</span>` : ''}<span class="muted">${matching.length} 个主体</span></div>
        <p class="muted perm-card-desc">${esc(card.desc)}</p>
        <div class="perm-chips" data-chips>${
          matching.map((row) => permChipHtml(row, card, kind, { showLevel })).join('') ||
          '<span class="muted">暂无主体</span>'
        }</div>
        <div class="toolbar perm-add">
          <input class="input" style="min-width:200px" data-perm-subject="${esc(card.key)}" list="${esc(options.datalistPrefix)}${userFirst ? 'User' : 'Group'}Options" placeholder="${userFirst ? '用户名，如 zhangsan' : '组名，如 team-payment'}">
          <select class="select" data-perm-type="${esc(card.key)}"><option value="${userFirst ? 'user' : 'group'}">${userFirst ? '用户' : '组'}</option><option value="${userFirst ? 'group' : 'user'}">${userFirst ? '组' : '用户'}</option></select>
          <button class="btn sm" data-perm-add="${esc(card.key)}">添加</button>
        </div>
      </div>`
    })
    .join('')
  // Rows no card claims are history/direct-write shapes; removable, not editable.
  const leftovers = rows.filter((row) => cards.every((card) => !belongs(row, card)))
  const leftoverCard = leftovers.length
    ? `
      <div class="perm-card" data-card="other">
        <div class="perm-card-head"><strong>其他位组合</strong><span class="muted">最小降级（管理台自身不产生该形态）</span></div>
        <div class="perm-chips" data-chips>${leftovers
          .map((row) =>
            permChipHtml(row, { key: 'other', label: '其他位组合' }, kind, { showLevel })
          )
          .join('')}</div>
      </div>`
    : ''
  const derivedCard = kind === 'project' ? projectDerivedCardHtml(options.hostRows) : ''
  return `
      ${options.header ? `<div class="note">${esc(options.header)}</div>` : ''}
      <div data-perm-cards>${cardsHtml}${leftoverCard}${derivedCard}</div>
      ${options.footnote ? `<p class="muted perm-footnote">${esc(options.footnote)}</p>` : ''}
      ${permDatalistsHtml(options.datalistPrefix)}`
}

/**
 * One subject = one row: add unions the card's bits into the row, chip removal
 * subtracts them (empty remainder deletes with the danger confirm, U67 §4.2).
 * Every operation is one immediate PUT; failures redraw from the platform.
 */
function wirePermCards(root, options) {
  const { grantsPath, rows, cards, kind, errorText, onChange } = options
  const rowOf = (key) => rows.find((g) => grantKey(g) === key)
  for (const select of root.querySelectorAll('[data-perm-type]')) {
    select.onchange = () => {
      const input = root.querySelector(`[data-perm-subject="${select.dataset.permType}"]`)
      const isUser = select.value === 'user'
      input.setAttribute(
        'list',
        isUser ? `${options.datalistPrefix}UserOptions` : `${options.datalistPrefix}GroupOptions`
      )
      input.placeholder = isUser ? '用户名，如 zhangsan' : '组名，如 team-payment'
    }
  }
  const setFrozen = (frozen) => {
    for (const control of root.querySelectorAll(
      '[data-perm-subject], [data-perm-type], [data-perm-add], .perm-chip-x'
    )) {
      control.disabled = frozen
    }
  }
  const putRow = async (subjectType, subjectId, permissions) => {
    await api(grantsPath, {
      method: 'PUT',
      // Row-wide replacement: the PUT carries the subject's full array.
      body: JSON.stringify({ subjectType, subjectId, permissions })
    })
  }
  for (const button of root.querySelectorAll('[data-perm-add]')) {
    button.onclick = () => {
      const card = cards.find((c) => c.key === button.dataset.permAdd)
      const input = root.querySelector(`[data-perm-subject="${button.dataset.permAdd}"]`)
      const select = root.querySelector(`[data-perm-type="${button.dataset.permAdd}"]`)
      const subjectId = input?.value.trim() ?? ''
      if (!card || subjectId === '') return
      const subjectType = select.value
      const existing = rows.find(
        (g) =>
          g.subjectType === subjectType &&
          (g.subjectId === subjectId || (subjectType === 'user' && g.username === subjectId))
      )
      const next = [...new Set([...(existing?.permissions ?? []), ...card.bits])].sort()
      const save = async () => {
        try {
          setFrozen(true)
          await putRow(subjectType, subjectId, next)
        } catch (err) {
          // W2-M-1/AA4: report the refusal, keep the typed subject for correction.
          toast(`授予失败：${errorText(err)}`)
          return
        } finally {
          setFrozen(false)
        }
        if (!existing) input.value = ''
        toast(`已保存「${card.label}」授权：${permLevelLabel(kind, next)}`)
        await onChange()
      }
      if (existing) {
        dialog(
          '覆盖现有授权',
          `<p>${esc(subjectLabel(existing))}（${subjectType === 'group' ? '组' : '用户'}）已有一条授权，保存按整行替换权限位。</p>
           <p>级别：${esc(permLevelLabel(kind, existing.permissions))} → ${esc(permLevelLabel(kind, next))}（${esc(card.bits.join(' + '))} 并入）</p>
           <p class="muted">级别提升即时生效；降级保存将断开该主体当前全部云会话，≤60 秒生效（FR-1.7）。</p>`,
          [{ label: '确认保存', primary: true, onClick: () => void save() }]
        )
        return
      }
      void save()
    }
  }
  for (const button of root.querySelectorAll('.perm-chip-x[data-perm-remove]')) {
    button.onclick = () => {
      const row = rowOf(button.dataset.permRemove)
      const card = cards.find((c) => c.key === button.dataset.card)
      if (!row) return
      const remaining = (
        card ? row.permissions.filter((bit) => !card.bits.includes(bit)) : []
      ).sort()
      const save = async () => {
        try {
          setFrozen(true)
          await putRow(row.subjectType, row.subjectId, remaining)
        } catch (err) {
          toast(`移除失败：${errorText(err)}`)
          return
        } finally {
          setFrozen(false)
        }
        toast(
          remaining.length === 0
            ? '已移除该主体的全部授权'
            : `已保存，级别：${permLevelLabel(kind, row.permissions)} → ${permLevelLabel(kind, remaining)}`
        )
        await onChange()
      }
      if (remaining.length === 0) {
        const blast =
          row.subjectType === 'user'
            ? `该主体将失去此${options.noun}的全部授权，云会话将在 ≤60 秒内断开（FR-1.7）。`
            : `宿主无法解析组成员，将断开该${options.noun}当前全部在线会话（≤60 秒内生效，FR-1.7）。`
        dialog(
          '移除全部授权',
          `<p>${esc(subjectLabel(row))}（${row.subjectType === 'group' ? '组' : '用户'}）</p><p>${esc(blast)}</p>`,
          [{ label: '确认移除', primary: true, onClick: () => void save() }]
        )
        return
      }
      void save()
    }
  }
}

const AUDIT_PAGE_SIZE = 50

/**
 * U78: the 操作类型 dropdown derives from the platform's authoritative catalog
 * (/v1/audit/status `eventTypes`), so a new server event type appears here
 * without a console change. The list below is only the fallback for a platform
 * that predates the field, plus the zh labels for known types.
 */
const AUDIT_FAMILY_OPTIONS = [
  ['family:download', '下载族 · 下载 + 拦截'],
  ['family:copy', '复制族 · file_copy']
]
const AUDIT_EVENT_FALLBACK_TYPES = [
  'file_download',
  'file_copy',
  'download_blocked',
  'login',
  'logout',
  'project_create',
  'project_connect',
  'project_access',
  'grant_update',
  'role_update',
  'host_register',
  'host_revoke',
  'policy_update',
  'device_revoke'
]
const AUDIT_EVENT_LABELS = {
  audit_query: '审计查询',
  audit_verify: '审计校验',
  connection_rejected: '连接拒绝',
  device_revoke: '设备撤销',
  directory_read: '目录读取',
  download_blocked: '下载拦截',
  file_copy: '复制文件内容',
  file_download: '文件下载',
  grant_update: '权限变更',
  'host.audit_gap': '主机审计缺口',
  'host.connection_rejected': '主机连接拒绝',
  'host.path_denied': '主机路径拒绝',
  'host.method_denied': '主机方法拒绝',
  host_e2ee_key_changed: '主机 E2EE 密钥变更',
  host_grant_read: '主机授权读取',
  host_grant_update: '主机授权变更',
  host_list: '主机列表',
  host_maintenance: '主机维护',
  host_projects_root_rejected: '项目根拒绝',
  host_provision_policy_update: '建项目策略变更',
  host_register: '主机注册',
  host_revoke: '主机撤销',
  host_tls_fingerprint_changed: '主机 TLS 指纹变更',
  host_token_create: '注册令牌签发',
  install_script: '安装脚本取用',
  login: '登录',
  logout: '登出',
  policy_update: '策略变更',
  project_access: '连接',
  project_archive: '项目归档',
  project_connect: '打开项目',
  project_create: '项目创建',
  project_provision: '项目开通',
  project_restore: '项目恢复',
  project_update: '项目更新',
  projects_root_change: '项目根变更',
  provision_assign: '开通分配',
  relay_list: '中继列表',
  role_update: '角色变更',
  signing_key_rotate: '签名密钥轮换',
  user_list: '用户列表',
  web_handoff: '会话交接'
}

/** Families first, then the catalog (or the legacy fallback) with zh labels. */
function auditEventOptions(status) {
  const catalog = Array.isArray(status?.eventTypes) ? status.eventTypes : []
  const types = catalog.length > 0 ? catalog : AUDIT_EVENT_FALLBACK_TYPES
  return [
    ...AUDIT_FAMILY_OPTIONS,
    ...types.map((type) => [
      type,
      AUDIT_EVENT_LABELS[type] ? `${AUDIT_EVENT_LABELS[type]} · ${type}` : type
    ])
  ]
}

/** file_download/download_blocked are the download family; file_copy is copy. */
const AUDIT_FILE_LABELS = {
  file_download: ['badge', '下载'],
  file_copy: ['badge warn', '复制'],
  download_blocked: ['badge danger', '拦截']
}
const AUDIT_RESULT_LABELS = {
  success: ['badge ok', '✓ 成功'],
  failure: ['badge danger', '✕ 失败'],
  denied: ['badge warn', '⛔ 拒绝']
}
const AUDIT_DAY_MS = 24 * 60 * 60_000
const AUDIT_MAX_WINDOW_MS = 31 * AUDIT_DAY_MS
// U97: a preset must not sit exactly on the API's window gate; leave headroom
// for anything the server adds after the client computes the window.
const AUDIT_WINDOW_BUFFER_MS = 5 * 60_000

/** Only q/fileName hits are highlighted; the server treats them as literals. */
function auditHighlight(text, terms) {
  let html = esc(text ?? '')
  for (const term of terms.filter(Boolean)) {
    const pattern = esc(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (pattern) {
      html = html.replace(
        new RegExp(pattern, 'gi'),
        (match) => `<mark class="audit-hit">${match}</mark>`
      )
    }
  }
  return html
}

function auditTypeMarkup(event) {
  const fileLabel = AUDIT_FILE_LABELS[event.eventType]
  const type = fileLabel
    ? `<span class="${fileLabel[0]}">${fileLabel[1]}</span> <span class="mono">${esc(event.eventType)}</span>`
    : `<span class="mono">${esc(event.eventType)}</span>`
  const confidence = event.metadata?.captureConfidence
  // client-declared is advisory: the client said so; the host did not attest it.
  const confidenceMarkup =
    confidence === 'host-attested'
      ? '<span class="badge ok">主机确认</span>'
      : confidence === 'inferred'
        ? '<span class="badge">推断</span>'
        : confidence
          ? '<span class="badge warn">客户端自报 · advisory</span>'
          : ''
  return `${type}${confidenceMarkup ? ` ${confidenceMarkup}` : ''}`
}

function auditSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 ** 2).toFixed(1)} MB`
}

function auditFileMarkup(event, terms) {
  const metadata = event.metadata ?? {}
  const name = typeof metadata.fileName === 'string' ? metadata.fileName : ''
  if (!name) return '<span class="muted mono">—</span>'
  const path = typeof metadata.path === 'string' && metadata.path ? metadata.path : name
  const copyLength = metadata.copiedChars
    ? `${Number(metadata.copiedChars)} 字符 / ${Number(metadata.copiedBytes ?? 0)} 字节`
    : ''
  const meta = [
    metadata.sizeBytes === undefined ? '—' : auditSize(metadata.sizeBytes),
    copyLength,
    auditHighlight(path, terms)
  ]
    .filter(Boolean)
    .join(' · ')
  return `<button class="audit-file" type="button" data-copy-file="${esc(path)}" title="点击复制路径">
      <span class="mono">${auditHighlight(name, terms)}</span>
      <span class="muted">复制</span>
    </button>
    <div class="audit-file-meta muted mono">${meta}</div>`
}

function auditDetailMarkup(event, terms, expanded) {
  const metadata = event.metadata ?? {}
  const excerpt = typeof metadata.excerpt === 'string' ? metadata.excerpt : ''
  const copyLength = metadata.copiedChars
    ? `复制 ${Number(metadata.copiedChars)} 字符 / ${Number(metadata.copiedBytes ?? 0)} 字节 · `
    : ''
  return `<tr class="audit-expand-row" data-detail="${event.seq}" ${expanded ? '' : 'hidden'}>
      <td colspan="8">
        <div class="audit-expand-panel">
          <div>
            <div class="audit-expand-label">复制内容摘录</div>
            ${
              excerpt
                ? `<div class="mono audit-excerpt">${auditHighlight(excerpt, terms)}</div>`
                : '<div class="muted">未记录内容摘录（仅保留指纹）</div>'
            }
          </div>
          <div>
            <div class="audit-expand-label">内容指纹与复制长度</div>
            <div class="mono">sha256:${esc(metadata.sha256 ?? '—')}</div>
            <div class="muted">${copyLength}仅记录指纹，不可反推内容</div>
          </div>
        </div>
      </td>
    </tr>`
}

function auditRowMarkup(event, terms, expanded) {
  const metadata = event.metadata ?? {}
  const result = AUDIT_RESULT_LABELS[event.result] ?? AUDIT_RESULT_LABELS.failure
  const traceId = event.traceId ?? ''
  const expandable = event.eventType === 'file_copy'
  return `<tr>
      <td class="muted">${esc(new Date(event.ts).toLocaleString('zh-CN'))}</td>
      <td>${esc(event.actor ?? '—')}</td>
      <td>${auditTypeMarkup(event)}</td>
      <td class="mono">${esc(event.targetId ?? '—')}</td>
      <td class="mono muted">${esc(metadata.hostName ?? metadata.hostId ?? '—')}</td>
      <td>${auditFileMarkup(event, terms)}</td>
      <td><span class="${result[0]}">${result[1]}</span></td>
      <td class="actions mono muted">
        <span title="${esc(traceId)}">${esc(traceId || '—')}</span>
        ${traceId ? `<button class="btn sm" data-trace="${esc(traceId)}">复制</button>` : ''}
        ${expandable ? `<button class="btn sm" data-expand="${event.seq}">${expanded ? '收起' : '展开'}</button>` : ''}
      </td>
    </tr>${expandable ? auditDetailMarkup(event, terms, expanded) : ''}`
}

/** A non-zero host or ingress gap must be visible; best-effort is not "normal". */
function auditGapMarkup(status) {
  const gaps = status?.gaps ?? {}
  const ingress = status?.ingressGaps ?? {}
  const hosts = Number(gaps.hostsWithGap) || 0
  const counts = [
    gaps.droppedTotal,
    gaps.suppressedTotal,
    gaps.rateLimitedTotal,
    ingress.droppedTotal,
    ingress.suppressedTotal,
    ingress.rateLimitedTotal
  ].map((value) => Number(value) || 0)
  if (hosts === 0 && counts.every((value) => value === 0)) return ''
  return `<div class="note warn" id="auditGapWarning">审计缺口：${hosts} 台主机有缺口；宿主上报 dropped ${counts[0]} / suppressed ${counts[1]} / rateLimited ${counts[2]}；平台入口 dropped ${counts[3]} / suppressed ${counts[4]} / rateLimited ${counts[5]}。缺口可见性为 best-effort，宿主瞬时崩溃无法精确检测。</div>`
}

/** Mirrors the API's INVALID_QUERY/TIME_WINDOW_TOO_LARGE gates. */
/** T7：审计筛选全部入 URL；cursor 与事件行展开不入。 */
const AUDIT_QUERY_KEYS = Object.freeze([
  'q',
  'range',
  'since',
  'until',
  'event',
  'username',
  'projectId',
  'hostId',
  'fileName',
  'result'
])

function auditFilterFromQuery(query) {
  const filter = {}
  for (const key of AUDIT_QUERY_KEYS) {
    const value = query?.get(key)
    if (value) filter[key] = value
  }
  return filter
}

function auditFilterError(filter) {
  if (filter.q && (filter.q.length < 2 || filter.q.length > 128)) {
    return '关键字长度需为 2–128 个字符。'
  }
  if (filter.fileName.length > 128) return '文件名长度需为 1–128 个字符。'
  const since = filter.since ? Date.parse(filter.since) : undefined
  const until = filter.until ? Date.parse(filter.until) : undefined
  if (since !== undefined && Number.isNaN(since)) return '起始时间无效。'
  if (until !== undefined && Number.isNaN(until)) return '结束时间无效。'
  const lower = since ?? (until !== undefined ? until - AUDIT_MAX_WINDOW_MS : undefined)
  if (lower !== undefined && until !== undefined && lower > until) {
    return '结束时间不能早于起始时间。'
  }
  if (lower !== undefined && until !== undefined && until - lower > AUDIT_MAX_WINDOW_MS) {
    return '查询时间窗最大 31 天。'
  }
  if (since !== undefined && until === undefined && Date.now() - since > AUDIT_MAX_WINDOW_MS) {
    return '查询时间窗最大 31 天。'
  }
  return ''
}

/** Explicit bounds win over the preset range (tech design §4.1). */
function auditQueryParams(filter, cursor) {
  const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) })
  if (filter.q) params.set('q', filter.q)
  if (filter.event) {
    if (filter.event.startsWith('family:')) params.set('eventFamily', filter.event.slice(7))
    else params.set('eventType', filter.event)
  }
  if (filter.username) params.set('username', filter.username)
  if (filter.fileName) params.set('fileName', filter.fileName)
  if (filter.result) params.set('result', filter.result)
  if (filter.projectId) params.set('projectId', filter.projectId)
  if (filter.hostId) params.set('hostId', filter.hostId)
  if (filter.since) params.set('since', new Date(filter.since).toISOString())
  if (filter.until) params.set('until', new Date(filter.until).toISOString())
  if (!filter.since && !filter.until) {
    const hours = Number(filter.range) || 168
    const requestedMs = hours * 3_600_000
    // U97: trim the buffer off the old end and pin `until` to the same clock, so
    // the server compares the window the client computed — not client-now
    // against server-now, whose drift rejected the «最近 31 天» preset.
    const windowMs = Math.min(requestedMs, AUDIT_MAX_WINDOW_MS - AUDIT_WINDOW_BUFFER_MS)
    const nowMs = Date.now()
    params.set('since', new Date(nowMs - windowMs).toISOString())
    if (windowMs < requestedMs) params.set('until', new Date(nowMs).toISOString())
  }
  if (cursor) params.set('cursor', String(cursor))
  return params
}

/** U73: 每次查询持一代号，仅最新一代可落 state/渲染；被取代的查询整体丢弃。 */
let auditQueryGeneration = 0

async function renderAudit(loadMore = false) {
  const generation = ++auditQueryGeneration
  // Only 「加载更早」 accumulates onto what is shown; a fresh view re-queries, so
  // leaving and returning can never resurrect a stale accumulation (M116-QA-002).
  if (!loadMore) {
    state.auditEvents = null
    state.auditCursor = null
  }
  if (!loadMore) state.auditFilter = auditFilterFromQuery(state.routeQuery)
  // Filter controls re-render from state so what they show always matches the
  // rows below them (M116-QA-003).
  const filter = state.auditFilter
  const params = auditQueryParams(filter, state.auditCursor)
  let body
  let status
  let projectsBody
  let hostsBody
  try {
    ;[body, status, projectsBody, hostsBody] = await Promise.all([
      api(`/v1/audit/events?${params}`),
      api('/v1/audit/status').catch(() => null),
      api('/v1/projects').catch(() => null),
      api('/v1/hosts').catch(() => null)
    ])
  } catch (err) {
    if (generation !== auditQueryGeneration) return // superseded: the page moved on
    // U97: a failed query must be visible. Keep the previous rows, but say so;
    // the initial load has no page yet, so it still falls through to loadContent.
    const banner = $('#auditError')
    if (banner) {
      banner.textContent = `查询失败：${err.message ?? String(err)}（下方为上次查询结果）`
      banner.hidden = false
      return
    }
    throw err
  }
  if (generation !== auditQueryGeneration) return
  if (!loadMore) state.auditStatus = status
  const events = state.auditEvents ? [...state.auditEvents, ...body.events] : body.events
  state.auditEvents = events
  state.auditCursor = body.nextCursor
  const projects = projectsBody?.projects ?? []
  const hosts = hostsBody?.hosts ?? []
  const terms = [filter.q, filter.fileName].filter(Boolean)
  content().innerHTML = `
    <div class="page-head"><div><h1>审计日志</h1><p>查询身份、连接、文件下载与复制、下载拦截与管理操作事件。只追加、哈希链校验；保留 180 天，查询时间窗最大 31 天。已显示 ${events.length} 条。</p></div></div>
    ${auditGapMarkup(state.auditStatus)}
    <details class="audit-coverage">
      <summary>覆盖范围与限制（审计链保证记录不被篡改，不保证记录完整）</summary>
      <div class="audit-coverage-body">
        <div>可捕获：桌面云工作区下载（files.readChunk，客户端自报）、宿主 browser.download、移动端保存、应用内复制（Web / 桌面 / 移动端）、宿主拒绝与前端下载拦截。</div>
        <ul>
          <li>不可捕获：开发机 shell 的 scp / git push / curl / cp 等带外传输；Finder / Explorer、拖拽、第三方应用、截图 / 录屏 / OCR；纯浏览器「另存为」、跨域 iframe 选区、键盘 Ctrl+C（一期）。</li>
          <li>缺口：客户端离线、绕过应用接缝、宿主进程重启可能丢事件；缺口可见性为 best-effort，宿主瞬时崩溃无法精确检测。</li>
          <li>可信度：主机确认（host-attested）为宿主确认；客户端自报（client-declared）为 advisory，只表示客户端声明，不作为宿主确认结论；推断（inferred）为启发式归属。</li>
        </ul>
      </div>
    </details>
    <div class="audit-filter" role="search" aria-label="审计查询">
      <input class="input span-4" id="auditKeyword" type="search" placeholder="关键字：类型 / 路径 / 文件名 / 账号 / 项目（2–128 字符）" autocomplete="off" aria-label="关键字">
      <select class="select span-2" id="auditRange" aria-label="时间范围">
        <option value="24">最近 24 小时</option>
        <option value="168">最近 7 天（默认）</option>
        <option value="744">最近 31 天</option>
      </select>
      <input class="input span-2" type="datetime-local" id="auditSince" aria-label="起始时间">
      <input class="input span-2" type="datetime-local" id="auditUntil" aria-label="结束时间">
      <select class="select span-2" id="auditType" aria-label="操作类型">
        <option value="">全部操作</option>
        ${auditEventOptions(status)
          .map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`)
          .join('')}
      </select>
      <input class="input span-3" id="auditActor" placeholder="用户（域账号，精确）" autocomplete="off" aria-label="用户">
      <select class="select span-3" id="auditProject" aria-label="项目">
        <option value="">全部项目</option>
        ${projects.map((project) => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('')}
      </select>
      <select class="select span-3" id="auditHost" aria-label="主机">
        <option value="">全部主机</option>
        ${hosts
          .filter((host) => !host.revokedAt)
          .map((host) => `<option value="${esc(host.id)}">${esc(host.name ?? host.id)}</option>`)
          .join('')}
      </select>
      <input class="input span-3" id="auditFileName" placeholder="文件名（1–128 字符）" autocomplete="off" aria-label="文件名">
      <select class="select span-3" id="auditResult" aria-label="结果">
        <option value="">全部结果</option>
        <option value="success">成功</option>
        <option value="failure">失败</option>
        <option value="denied">拒绝</option>
      </select>
      <div class="audit-filter-actions">
        <button class="btn primary" id="auditApply">查询</button>
        <button class="btn" id="auditReset">清除</button>
      </div>
    </div>
    <p class="inline-error" id="auditError" hidden></p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>时间</th><th>用户</th><th>操作</th><th>项目</th><th>主机</th><th>文件 · 大小</th><th>结果</th><th>详情 / traceId</th></tr></thead>
        <tbody>
          ${
            events.map((event) => auditRowMarkup(event, terms, false)).join('') ||
            '<tr><td colspan="8" class="table-empty">没有符合筛选条件的审计事件</td></tr>'
          }
        </tbody>
      </table>
    </div>
    ${body.nextCursor ? `<div class="toolbar"><span class="muted">仅显示最近 ${AUDIT_PAGE_SIZE} 条，还有更早记录。</span><button class="btn" id="auditMore">加载更早</button></div>` : ''}`
  // The chosen conditions are restored as properties: a parsed `selected`
  // attribute is not what every DOM picks up on a re-render.
  $('#auditKeyword').value = filter.q ?? ''
  $('#auditRange').value = filter.range ?? '168'
  $('#auditSince').value = filter.since ?? ''
  $('#auditUntil').value = filter.until ?? ''
  $('#auditType').value = filter.event ?? ''
  $('#auditActor').value = filter.username ?? ''
  $('#auditProject').value = filter.projectId ?? ''
  $('#auditHost').value = filter.hostId ?? ''
  $('#auditFileName').value = filter.fileName ?? ''
  $('#auditResult').value = filter.result ?? ''
  const apply = () => {
    const next = {
      q: $('#auditKeyword').value.trim(),
      range: $('#auditRange').value,
      since: $('#auditSince').value,
      until: $('#auditUntil').value,
      event: $('#auditType').value,
      username: $('#auditActor').value.trim(),
      projectId: $('#auditProject').value,
      hostId: $('#auditHost').value,
      fileName: $('#auditFileName').value.trim(),
      result: $('#auditResult').value
    }
    const error = auditFilterError(next)
    $('#auditError').textContent = error
    $('#auditError').hidden = !error
    if (error) return
    state.auditFilter = next
    state.auditEvents = null
    state.auditCursor = null
    syncListQuery('audit', next, { push: true })
    renderAudit()
  }
  $('#auditApply').onclick = apply
  $('#auditReset').onclick = () => {
    state.auditFilter = {}
    state.auditEvents = null
    state.auditCursor = null
    syncListQuery('audit', {})
    renderAudit()
  }
  const more = $('#auditMore')
  if (more) more.onclick = () => renderAudit(true)
  for (const btn of document.querySelectorAll('[data-trace]')) {
    btn.onclick = () => {
      navigator.clipboard?.writeText(btn.dataset.trace)
      toast('已复制')
    }
  }
  for (const btn of document.querySelectorAll('[data-copy-file]')) {
    btn.onclick = () => {
      navigator.clipboard?.writeText(btn.dataset.copyFile)
      toast('已复制')
    }
  }
  // The excerpt row is rendered closed; expanding must not re-query the page.
  for (const btn of document.querySelectorAll('[data-expand]')) {
    btn.onclick = () => {
      const row = document.querySelector(`[data-detail="${btn.dataset.expand}"]`)
      if (!row) return
      row.hidden = !row.hidden
      btn.textContent = row.hidden ? '展开' : '收起'
    }
  }
}

/* ---------------- 项目级下载策略覆盖（M120c · QA-015） ---------------- */

/** 统计与覆盖表都只看在营项目：已归档行是历史，不再参与策略管理（§5.3）。 */
function policyOverrides(projects) {
  const live = projects.filter((p) => p.status !== 'archived')
  const overrides = live.filter((p) => p.downloadPolicyExplicit === true)
  return { following: live.length - overrides.length, overrides }
}

async function renderSettings() {
  const [policy, projects] = await Promise.all([api('/v1/policies/download'), loadProjects()])
  const globalDefault = policy.downloadDefault
  const { following, overrides } = policyOverrides(projects)
  const rows = overrides
    .map(
      (p) => `<tr data-policy-row="${esc(p.id)}">
        <td><strong>${esc(p.name)}</strong> <span class="badge">覆盖</span><div class="muted mono">${esc(p.path)}</div></td>
        <td>
          <select class="select" data-policy-select="${esc(p.id)}" aria-label="${esc(p.name)} 下载策略" style="width:auto">
            <option value="deny" ${p.downloadPolicy === 'deny' ? 'selected' : ''}>禁止</option>
            <option value="allow" ${p.downloadPolicy === 'allow' ? 'selected' : ''}>允许</option>
            <option value="inherit">跟随全局</option>
          </select>
        </td>
        <td class="muted">当前生效：${effectiveDownloadPolicy(p, globalDefault) === 'deny' ? '禁止' : '允许'}</td>
      </tr>`
    )
    .join('')
  content().innerHTML = `
    <div class="page-head"><div><h1>平台设置</h1><p>下载策略：全局默认与项目覆盖。</p></div></div>
    <div class="card pad" style="max-width:640px">
      <h2 style="font-size:14px;margin:0 0 4px">全局下载策略</h2>
      <p class="muted" style="margin:0 0 16px">项目级策略可覆盖全局；托管项目默认禁止下载。</p>
      <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:12px">
        <input type="radio" name="dl" value="deny" ${policy.downloadDefault === 'deny' ? 'checked' : ''}>
        <span><strong>禁止下载</strong><br><span class="muted">隐藏导出入口；主机拒绝专用下载 RPC；阻断浏览器下载。</span></span>
      </label>
      <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:16px">
        <input type="radio" name="dl" value="allow" ${policy.downloadDefault === 'allow' ? 'checked' : ''}>
        <span><strong>允许下载</strong><br><span class="muted">保留导出通道，仍记录审计。</span></span>
      </label>
      <div class="note warn">内容级 DLP（终端复制、文件内容读取）一期不做阻断，仅限速与审计。</div>
      <button class="btn primary" id="savePolicy">保存</button>
      <span class="muted" style="margin-left:8px">当前版本 v${policy.version}</span>
    </div>
    <div class="card pad" style="max-width:640px;margin-top:16px">
      <h2 style="font-size:14px;margin:0 0 4px">项目级覆盖</h2>
      <p class="muted" style="margin:0 0 12px">独立覆盖钉住该项目的下载策略，全局默认翻转时不随之变化；选「跟随全局」即恢复。</p>
      <p class="muted" style="margin:0 0 12px" id="policyScope">跟随全局默认 <strong>${following}</strong> 个项目 · 独立覆盖 <strong>${overrides.length}</strong> 个项目</p>
      ${
        rows
          ? `<div class="table-wrap"><table>
              <thead><tr><th>项目</th><th>覆盖策略</th><th>当前生效</th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div>`
          : '<p class="muted">暂无项目覆盖，全部项目跟随全局默认。</p>'
      }
    </div>`
  $('#savePolicy').onclick = async () => {
    const value = document.querySelector('input[name=dl]:checked').value
    try {
      await api('/v1/policies/download', {
        method: 'PUT',
        body: JSON.stringify({ downloadDefault: value })
      })
    } catch (err) {
      // A silent failure would leave the form claiming a policy that never landed
      // (M116-QA-009): report it and redraw from the value the platform holds.
      toast(`保存失败：${err.message ?? err}`)
      renderSettings()
      return
    }
    // FR-9.4 的生效范围：翻转全局时告诉管理员谁跟着走、谁被钉住不受影响。
    toast(
      `已保存，30 秒内生效；跟随全局 ${following} 个项目，独立覆盖 ${overrides.length} 个不受影响`
    )
    renderSettings()
  }
  for (const select of content().querySelectorAll('[data-policy-select]')) {
    select.onchange = () => void saveProjectPolicy(select.dataset.policySelect ?? '', select.value)
  }
}

/** 行内选择即保存：「禁止/允许」钉住一个覆盖，「跟随全局」清掉钉住回到继承。 */
async function saveProjectPolicy(projectId, value) {
  const inherit = value === 'inherit'
  // A row save redraws the whole page, which used to throw the admin back to the
  // top and drop the select: carry both over (m-7). The failure path redraws to
  // roll back (QA-009) and deliberately skips the restore.
  const scroller = content()
  const scrollTop = scroller.scrollTop
  const focusedId = document.activeElement?.getAttribute?.('data-policy-select') ?? ''
  try {
    await api(`/v1/projects/${projectId}/policy`, {
      method: 'PUT',
      body: JSON.stringify(inherit ? { inherit: true } : { downloadPolicy: value })
    })
  } catch (err) {
    // Same rule as the global card (M116-QA-009): report it and redraw from the
    // platform's value, so no row keeps claiming a policy that never landed.
    toast(`保存失败：${err.message ?? err}`)
    renderSettings()
    return
  }
  toast(inherit ? '已恢复跟随全局默认' : '已保存项目下载策略')
  await renderSettings()
  scroller.scrollTop = scrollTop
  const refocus = focusedId ? document.querySelector(`[data-policy-select="${focusedId}"]`) : null
  refocus?.focus()
}

/* ---------------- overlays ---------------- */

function openDrawer(title, html, options = {}) {
  const backdrop = document.createElement('div')
  backdrop.className = 'drawer-backdrop'
  backdrop.innerHTML = `
    <div class="drawer" role="dialog" aria-modal="true">
      <div class="drawer-head"><h2>${esc(title)}</h2><button class="icon-btn" aria-label="关闭">✕</button></div>
      <div class="drawer-body">${html}</div>
    </div>`
  const close = () => {
    backdrop.remove()
    options.onClose?.()
  }
  backdrop.querySelector('.icon-btn').onclick = close
  backdrop.onclick = (e) => {
    if (e.target === backdrop) {
      close()
    }
  }
  document.body.appendChild(backdrop)
  return { close, backdrop }
}

let dialogSeq = 0

function dialog(title, html, actions = [], options = {}) {
  // Captured before the dialog steals focus so closing can return it (U46 §3.5).
  const opener = document.activeElement
  const titleId = `dialogTitle${++dialogSeq}`
  const backdrop = document.createElement('div')
  backdrop.className = 'dialog-backdrop'
  backdrop.innerHTML = `
    <div class="dialog${options.wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <h2 id="${titleId}">${esc(title)}</h2>
      <div class="body">${html}</div>
      <div class="foot">
        ${actions
          .map(
            (a, i) =>
              `<button class="btn ${a.danger ? 'danger' : a.primary ? 'primary' : ''}" data-action="${i}" ${a.disabled ? 'disabled' : ''} ${a.title ? `title="${esc(a.title)}"` : ''}>${esc(a.label)}</button>`
          )
          .join('')}
        <button class="btn ghost" data-action="close">关闭</button>
      </div>
    </div>`
  const panel = backdrop.querySelector('.dialog')
  const close = () => {
    document.removeEventListener('keydown', onKeydown)
    backdrop.remove()
    options.onClose?.()
    // Duck-typed: app.js runs in a DOM whose HTMLElement is not this realm's.
    if (typeof opener?.focus === 'function') {
      opener.focus()
    }
  }
  const onKeydown = (event) => {
    if (event.key !== 'Escape') {
      return
    }
    event.preventDefault()
    close()
  }
  document.addEventListener('keydown', onKeydown)
  backdrop.querySelector('[data-action="close"]').onclick = close
  backdrop.onclick = (e) => {
    if (e.target === backdrop) {
      close()
    }
  }
  actions.forEach((a, i) => {
    backdrop.querySelector(`[data-action="${i}"]`).onclick = () => {
      const keep = a.onClick?.()
      if (keep !== false) {
        close()
      }
    }
  })
  document.body.appendChild(backdrop)
  // First focusable wins; with none, the close button keeps Escape reachable.
  const forceFocus = panel.querySelector(
    'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )
  const target = forceFocus ?? panel.querySelector('[data-action="close"]')
  if (typeof target?.focus === 'function') {
    target.focus()
  }
  return backdrop
}

function confirmDialog(text) {
  return window.confirm(text)
}

/* ---------------- auth ---------------- */

async function login(username, password) {
  const res = await fetch('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      deviceId: currentDeviceId(),
      deviceName: navigator.userAgent.includes('Mac') ? 'Mac 浏览器' : '浏览器',
      devicePubKey: 'web-client'
    })
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error?.message ?? '登录失败')
    err.code = body.error?.code
    throw err
  }
  setTokens(body.accessToken, body.refreshToken)
  state.user = body.user
  state.deviceId = body.device.id
  localStorage.setItem('orca.user', JSON.stringify(body.user))
  localStorage.setItem('orca.device', body.device.id)
}

function logout() {
  // R10: the overlay goes first, and the iframe is told to drop its session.
  closeWorkspaceForLogout()
  void fetch('/v1/auth/logout', {
    method: 'POST',
    headers: { authorization: `Bearer ${state.accessToken}` }
  }).catch(() => undefined)
  state.accessToken = ''
  state.refreshToken = ''
  state.user = null
  state.directory = null
  localStorage.removeItem('orca.access')
  localStorage.removeItem('orca.refresh')
  localStorage.removeItem('orca.user')
  // U53②: the next user must not find the previous credentials one click away.
  $('#username').value = ''
  $('#password').value = ''
  $('#loginError').hidden = true
  showLogin()
  // U120: 登出即丢弃受保护深链；刷新只回到登录页，再登录落工作台。
  window.history.replaceState(null, '', buildHash({ name: 'login' }))
  state.route = 'login'
  state.routeParams = {}
  state.routeQuery = null
}

function enterApp() {
  $('#view-login').hidden = true
  $('#view-app').hidden = false
  const admin = isAdmin()
  const auditor = isAuditor()
  $('#adminNav').hidden = !admin && !auditor
  // U72: an auditor sees only the audit entry; every other admin route stays admin-only.
  for (const btn of document.querySelectorAll('#adminNav .nav-item[data-route]')) {
    btn.hidden = btn.dataset.route === 'audit' ? !(admin || auditor) : !admin
  }
  // U74-P3: every route renders for an admin, so the 403 preview is theirs alone to skip.
  $('#open403').hidden = admin
  $('#userName').textContent = state.user.displayName
  $('#userDept').textContent = state.user.dept
  $('#userAvatar').textContent = state.user.displayName.slice(0, 1)
  $('#roleChip').textContent = admin ? '平台管理员' : auditor ? '审计员' : '开发者'
  appliedRoute = null
  const route = parseHash(location.hash)
  // 空 hash 规范化为默认路由，深链则原样恢复（D5/D7）。
  if (
    route.name === 'login' ||
    location.hash === '' ||
    location.hash === '#' ||
    location.hash === '#/'
  ) {
    navigate(DEFAULT_ROUTE)
    return
  }
  applyRoute(route)
}

function showLogin() {
  appliedRoute = null
  pendingBackRestore = false
  $('#view-login').hidden = false
  $('#view-app').hidden = true
}

/* ---------------- bootstrap ---------------- */

$('#loginForm').onsubmit = async (event) => {
  event.preventDefault()
  const username = $('#username').value.trim()
  const password = $('#password').value
  const errorEl = $('#loginError')
  errorEl.hidden = true
  $('#username').classList.remove('invalid')
  $('#password').classList.remove('invalid')
  // An empty submit must not reach the server and burn lockout attempts (M116-QA-012).
  if (username === '' || password === '') {
    errorEl.textContent = '请输入域账号和密码。'
    errorEl.hidden = false
    $('#username').classList.add('invalid')
    $('#password').classList.add('invalid')
    $('#username').focus()
    return
  }
  $('#loginBtn').disabled = true
  $('#loginBtn').textContent = '登录中…'
  try {
    await login(username, password)
    enterApp()
  } catch (err) {
    errorEl.textContent =
      err.code === 'ACCOUNT_LOCKED'
        ? '连续 5 次失败，账号已锁定 15 分钟。'
        : err.code === 'INVALID_CREDENTIALS'
          ? '账号或密码错误，请重试。'
          : err.message
    errorEl.hidden = false
    $('#password').classList.add('invalid')
    $('#password').focus()
  } finally {
    $('#loginBtn').disabled = false
    $('#loginBtn').textContent = '登录'
  }
}

$('#togglePassword').onclick = () => {
  const input = $('#password')
  input.type = input.type === 'password' ? 'text' : 'password'
}

for (const btn of document.querySelectorAll('.nav-item[data-route]')) {
  btn.onclick = () => navigate(btn.dataset.route)
}
$('#logoutBtn').onclick = logout
$('#open403').onclick = () => navigate('forbidden')

// URL 是恢复载体：前进/后退与手改地址都走同一分发。
window.addEventListener('hashchange', () => {
  if (!state.user) return // 登录视图保持目标 hash，登录成功后回到它（D7）
  applyRoute(parseHash(location.hash))
})

// restore session
;(async () => {
  const cachedUser = localStorage.getItem('orca.user')
  if (state.accessToken) {
    try {
      const me = await api('/v1/me')
      state.user = { ...me.user, displayName: me.user.displayName, dept: me.user.dept }
      enterApp()
      return
    } catch {
      state.accessToken = ''
    }
  }
  if (cachedUser) localStorage.removeItem('orca.user')
  showLogin()
})()
