/* Orca Cloud 平台 Web 前端（前后端分离：只通过 REST 访问后端） */

const state = {
  accessToken: localStorage.getItem('orca.access') ?? '',
  refreshToken: localStorage.getItem('orca.refresh') ?? '',
  user: null,
  projects: [],
  route: 'workbench',
  deviceId: localStorage.getItem('orca.device') ?? '',
  lastHosts: [],
  auditFilter: {},
  auditEvents: null,
  auditCursor: null
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

const ADMIN_ROUTES = new Set(['hosts', 'relays', 'members', 'audit', 'settings'])
const TITLES = {
  workbench: '工作台',
  projects: '我的项目',
  hosts: '平台设置 / 主机',
  relays: '平台设置 / 中继',
  members: '成员与权限',
  audit: '审计日志',
  settings: '平台设置',
  forbidden: '无权访问'
}

function isAdmin() {
  return Boolean(state.user?.permissions?.includes('platform:admin'))
}

function navigate(route) {
  if (ADMIN_ROUTES.has(route) && !isAdmin()) {
    renderForbidden()
    return
  }
  state.route = route
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.classList.toggle('active', btn.dataset.route === route)
  }
  $('#crumbs').textContent = TITLES[route] ?? route
  const renderers = {
    workbench: renderWorkbench,
    projects: renderProjects,
    hosts: renderHosts,
    relays: renderRelays,
    members: renderMembers,
    audit: renderAudit,
    settings: renderSettings
  }
  void loadContent(renderers[route] ?? renderWorkbench)
}

/** One failed fetch must not leave the page stuck on its own spinner (M116-QA-011). */
async function loadContent(render) {
  content().innerHTML = '<p class="muted">加载中…</p>'
  try {
    await render()
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
  for (const btn of document.querySelectorAll('.nav-item')) btn.classList.remove('active')
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

async function loadProjects() {
  const body = await api('/v1/projects?includeArchived=1')
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
  return p.permissions.join(' · ')
}

/** Why 打开 is unavailable, or null when the project can be opened (FR-2.4). */
function openDisabledReason(p) {
  if (p.hostStatus === 'maintenance') return '主机维护中'
  if (p.hostStatus !== 'online') return '主机离线'
  if (p.permissions.length === 0 && isAdmin()) {
    return '项目未授权给你，请先在「成员与权限」中授权'
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
      <div class="name"><span class="dot ${offline ? 'offline' : 'online'}"></span>${esc(p.name)}</div>
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

/** Why the 详情 entry cannot open, or null when it is a plain link (FR-3.8). */
function detailDisabledReason(p) {
  if (p.hostStatus === 'maintenance') {
    return '主机维护中'
  }
  if (p.hostStatus !== 'online') {
    return '主机离线'
  }
  if (!p.sessionPageUrl) {
    return '该主机没有可直达的会话页地址'
  }
  return null
}

/**
 * The per-project row entries (FR-3.11) come from one builder so 工作台 and
 * 我的项目 stay identical. 「详情」 is admin-only and opens the host session
 * page in a new tab; 「打开」 and 「Orca Web」 (M122, FR-3.10) mint a one-time
 * handoff URL and open it, landing straight in the project workspace.
 */
function projectRowActions(p) {
  return `<button class="btn sm" data-open="${p.id}" ${openDisabledAttr(p)}>打开</button>${detailEntry(p)}${orcaWebEntry(p)}`
}

function detailEntry(p) {
  if (!isAdmin()) {
    return ''
  }
  const reason = detailDisabledReason(p)
  return reason
    ? `<button class="btn sm" disabled title="${esc(reason)}">详情</button>`
    : `<a class="btn sm" href="${esc(p.sessionPageUrl)}" target="_blank" rel="noopener" title="在新标签打开会话详情">详情</a>`
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

function projectRow(p) {
  const offline = p.hostStatus !== 'online'
  return `<tr>
    <td><strong>${esc(p.name)}</strong><div class="muted mono">${esc(p.path)}</div></td>
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
  // 「打开」 and 「Orca Web」 are the same handoff entry (FR-3.11 revision):
  // both land the open-permission holder straight in the project workspace.
  for (const btn of document.querySelectorAll('[data-open], [data-orca-web]')) {
    const projectId = btn.dataset.open ?? btn.dataset.orcaWeb
    btn.onclick = () => openProjectWorkspace(projectId)
  }
  for (const btn of document.querySelectorAll('[data-go]')) {
    btn.onclick = () => navigate(btn.dataset.go)
  }
}

/**
 * The platform mints a one-time, 60-second handoff code bound to this session,
 * and the new tab trades it for a workspace — no second login (FR-3.10). The
 * raw connection info stays with the 详情 entry and the workspace's connection
 * diagnostics, so the old「连接信息已就绪」dialog has nothing left to add.
 */
async function openProjectWorkspace(projectId) {
  try {
    const body = await api(`/v1/projects/${projectId}/web-handoff`, { method: 'POST' })
    window.open(body.url, '_blank', 'noopener')
  } catch (err) {
    toast(`打开失败：${err.message ?? err}`)
  }
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
        <td><strong>${esc(p.name)}</strong><div class="muted mono">${esc(p.path)}</div></td>
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
  draw()
  $('#projectSearch').oninput = (e) => draw(e.target.value)
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
        `项目已登记${created.repoUrl ? '，克隆中，就绪后可打开' : ''}。授权请在「成员与权限」中配置。`
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
  $('#regHost').onchange = () => {
    const hint = $('#regRootHint')
    const root = hosts.find((h) => h.id === $('#regHost').value)?.projectsRoot
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
        <thead><tr><th>主机</th><th>直连地址</th><th>中继路由</th><th>版本</th><th>心跳</th><th>状态</th><th class="actions">操作</th></tr></thead>
        <tbody>
          ${hostsBody.hosts.map(hostRow).join('') || '<tr><td colspan="7" class="table-empty">尚未注册主机</td></tr>'}
        </tbody>
      </table>
    </div>`
  $('#registerHostBtn').onclick = registerHostDialog
  for (const btn of document.querySelectorAll('[data-host]')) {
    btn.onclick = () => showHost(btn.dataset.host)
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
    <td>${esc(h.orcaVersion)} <span class="muted">p${h.protocolVersion}</span></td>
    <td>${relative(h.lastHeartbeatAt)}</td>
    <td><span class="dot ${dot}"></span> ${status}</td>
    <td class="actions"><button class="btn sm" data-host="${h.id}">详情</button></td>
  </tr>`
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
  const cmd = `bash <(curl -fsSL ${location.origin}/install/host.sh?token=${body.token})`
  dialog(
    '注册主机',
    `<p>在目标开发机执行以下命令完成注册。脚本会写入环境配置并生成自签证书，令牌 24 小时内有效且只能使用一次。</p>
     <pre id="installCmd">${esc(cmd)}</pre>`,
    [copyCommandAction(cmd)]
  )
}

async function showHost(hostId) {
  const host = state.lastHosts.find((h) => h.id === hostId)
  if (!host) return
  const drawer = openDrawer(
    `主机 ${host.name}`,
    `
    <dl class="kv">
      <dt>主机 ID</dt><dd class="mono">${esc(host.id)}</dd>
      <dt>指纹</dt><dd class="mono">${esc(host.fingerprint)}</dd>
      <dt>E2EE 公钥</dt><dd class="mono">${esc(host.e2eePublicKey)}</dd>
      <dt>版本</dt><dd>${esc(host.orcaVersion)} · 协议 v${host.protocolVersion}</dd>
      <dt>网络位置</dt><dd>${esc(host.zone)}</dd>
      <dt>直连地址</dt><dd class="mono">${esc(host.directAddrs.join(', ') || '—')}</dd>
      <dt>中继路由</dt><dd class="mono">${esc(host.relayRoute ?? '—')}</dd>
      <dt>能力</dt><dd>${esc(host.capabilities.join(', '))}</dd>
      <dt>最近心跳</dt><dd>${relative(host.lastHeartbeatAt)}</dd>
      ${host.revokedAt ? `<dt>状态</dt><dd>已吊销（${new Date(host.revokedAt).toLocaleString('zh-CN')}）</dd>` : ''}
    </dl>
    <div class="toolbar" style="margin-top:20px">
      <button class="btn" id="maintenanceBtn" ${host.revokedAt ? 'disabled title="主机已下线"' : ''}>${host.status === 'maintenance' ? '结束维护' : '进入维护模式'}</button>
      <button class="btn danger" id="revokeHostBtn" ${host.revokedAt ? 'disabled' : ''}>下线主机</button>
    </div>
    <p class="muted" style="margin-top:12px">下线后该主机的项目立即不可打开，已签发凭证失效。</p>`
  )
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
function addRelayDialog() {
  const cmd = `bash <(curl -fsSL ${location.origin}/install/relay.sh)`
  dialog(
    '添加中继',
    `<p>在中继机执行以下命令完成注册上线。内部控制令牌由脚本端点注入，不出现在 URL 中。</p>
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

async function renderMembers() {
  const projects = await loadProjects()
  const selected = projects[0]
  content().innerHTML = `
    <div class="page-head"><div><h1>成员与权限</h1><p>按项目管理成员/组的权限。下载权限需在平台设置中单独开启。</p></div></div>
    <div class="grid-3" style="grid-template-columns: 260px 1fr; align-items:start">
      <div class="card">
        <div class="section-head" style="margin:12px 16px"><h2>项目</h2></div>
        <div id="memberProjectList"></div>
      </div>
      <div class="card pad" id="grantPanel"><p class="muted">选择左侧项目查看授权。</p></div>
    </div>`
  $('#memberProjectList').innerHTML = projects
    .map(
      (p, i) =>
        `<button class="nav-item ${i === 0 ? 'active' : ''}" data-material="${p.id}">${esc(p.name)}</button>`
    )
    .join('')
  for (const btn of document.querySelectorAll('[data-material]')) {
    btn.onclick = () => {
      for (const other of document.querySelectorAll('[data-material]'))
        other.classList.remove('active')
      btn.classList.add('active')
      showGrants(btn.dataset.material)
    }
  }
  if (selected) showGrants(selected.id)
}

/** The full Permission set of the credential contract; the matrix edits exactly these 7 bits. */
const GRANT_PERMISSIONS = [
  'open',
  'terminal',
  'agent',
  'file:read',
  'file:write',
  'browser',
  'download'
]

const grantKey = (g) => `${g.subjectType}:${g.subjectId}`
const subjectLabel = (g) => g.username ?? g.subjectId

async function showGrants(projectId) {
  const grantsPath = `/v1/projects/${projectId}/grants`
  const body = await api(grantsPath)
  // What the platform holds per row, sorted so a draft diff is a plain compare.
  const serverPerms = new Map(body.grants.map((g) => [grantKey(g), [...g.permissions].sort()]))
  // Checkbox edits stay a local draft per row: nothing lands until 「保存变更」 (M120b §4.1).
  const draft = new Map()
  const draftOf = (g) => draft.get(grantKey(g)) ?? [...g.permissions].sort()
  const isDirty = (g) => {
    const next = draft.get(grantKey(g))
    if (!next) return false
    const base = serverPerms.get(grantKey(g)) ?? []
    return next.length !== base.length || next.some((p, i) => p !== base[i])
  }
  const dirtyGrants = () => body.grants.filter(isDirty)

  const rows = body.grants
    .map((g) => {
      // GET /grants names only user rows it can resolve: an unnamed user row has
      // no live account behind it (a pre-fix row keyed by the typed name), so it
      // grants nothing and its removal is refused server-side (W2 audit m-2).
      const deadUser = g.subjectType === 'user' && !g.username
      return `<tr data-row="${esc(grantKey(g))}">
        <td>${esc(subjectLabel(g))}${deadUser ? ' <span class="badge">已删除用户</span>' : ''}<span class="badge" data-unsaved hidden>未保存</span></td>
        <td class="muted">${g.subjectType === 'group' ? '组' : '用户'}</td>
        ${GRANT_PERMISSIONS.map(
          (p) =>
            `<td><input type="checkbox" aria-label="${esc(subjectLabel(g))} ${p}" data-perm="${p}" data-subject-type="${g.subjectType}" data-subject-id="${esc(g.subjectId)}"${draftOf(g).includes(p) ? ' checked' : ''}${deadUser ? ' disabled title="该账号已不存在"' : ''}></td>`
        ).join('')}
        <td class="actions"><button class="btn sm danger" data-remove="${esc(grantKey(g))}" ${deadUser ? 'disabled title="该账号已不存在，无法在此移除"' : ''}>移除</button></td>
      </tr>`
    })
    .join('')
  const panel = $('#grantPanel')
  panel.innerHTML = `
    <div class="section-head" style="margin-top:0"><h2>授权矩阵</h2></div>
    <div class="note">download 仅在项目下载策略为「允许」时生效（平台设置）；策略为「禁止」时勾选也不放行导出。</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>主体</th><th>类型</th>${GRANT_PERMISSIONS.map((p) => `<th>${p}</th>`).join('')}<th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="10" class="table-empty">尚无授权</td></tr>`}</tbody>
      </table>
    </div>
    <div class="toolbar" style="margin-top:16px">
      <button class="btn primary" id="grantSave" disabled>保存变更</button>
      <button class="btn" id="grantDiscard" disabled>放弃修改</button>
      <span class="muted">勾选先暂存，「保存变更」才落盘。</span>
    </div>
    <div class="toolbar" style="margin-top:12px">
      <input class="input" id="grantSubject" style="min-width:240px" placeholder="用户名或组 ID，如 zhangsan / team-payment">
      <select class="select" id="grantType"><option value="group">组</option><option value="user">用户</option></select>
      <button class="btn" id="grantAdd">添加授权</button>
    </div>`

  const syncDraftUi = (tr) => {
    const dirty = body.grants.some((g) => grantKey(g) === tr.dataset.row && isDirty(g))
    tr.classList.toggle('dirty', dirty)
    tr.querySelector('[data-unsaved]').hidden = !dirty
    const anyDirty = dirtyGrants().length > 0
    $('#grantSave').disabled = !anyDirty
    $('#grantDiscard').disabled = !anyDirty
  }
  for (const box of panel.querySelectorAll('input[type="checkbox"][data-perm]')) {
    box.onchange = () => {
      const key = `${box.dataset.subjectType}:${box.dataset.subjectId}`
      const next = new Set(draft.get(key) ?? serverPerms.get(key) ?? [])
      if (box.checked) next.add(box.dataset.perm)
      else next.delete(box.dataset.perm)
      draft.set(key, [...next].sort())
      syncDraftUi(box.closest('tr'))
    }
  }

  // The platform has no online-session listing, so the blast radius is stated as
  // a rule per row kind, never as named online users (M120b §4.3).
  const diffLine = (g) => {
    const base = new Set(g.permissions)
    const next = new Set(draftOf(g))
    const added = GRANT_PERMISSIONS.filter((p) => next.has(p) && !base.has(p))
    const removed = GRANT_PERMISSIONS.filter((p) => base.has(p) && !next.has(p))
    const changes = [
      added.length ? `+新增 ${added.join('、')}` : '',
      removed.length ? `−移除 ${removed.join('、')}` : ''
    ]
      .filter(Boolean)
      .join('；')
    const blast =
      g.subjectType === 'user'
        ? `保存将断开 ${subjectLabel(g)} 当前全部云会话（含其他项目）。`
        : '宿主无法解析组成员，保存将断开该项目当前全部在线会话。'
    return `<li>${esc(subjectLabel(g))}（${g.subjectType === 'group' ? '组' : '用户'}）：${esc(changes)}<br><span class="muted">${esc(blast)}</span></li>`
  }

  const applyChanges = async (dirty) => {
    // A double click would double-send the batch: the buttons stay dead until the redraw.
    $('#grantSave').disabled = true
    $('#grantDiscard').disabled = true
    // The whole batch window freezes: an edit to a not-yet-queued row would be
    // silently dropped by the post-batch redraw (m-5). The redraw rebuilds the
    // panel, so nothing needs re-enabling on either exit path.
    for (const control of panel.querySelectorAll(
      'input[type="checkbox"][data-perm], [data-remove], #grantAdd, #grantSubject, #grantType'
    )) {
      control.disabled = true
    }
    let saved = 0
    for (const g of dirty) {
      try {
        await api(grantsPath, {
          method: 'PUT',
          // Row-wide replacement: the PUT carries the subject's full array and the
          // platform rebuilds that row from it, so unticked bits stay unticked (§4.2).
          body: JSON.stringify({
            subjectType: g.subjectType,
            subjectId: g.subjectId,
            permissions: draftOf(g)
          })
        })
        saved += 1
      } catch (err) {
        toast(
          `已保存 ${saved} 项，${dirty.length - saved} 项失败：${subjectLabel(g)}（${err.message ?? err}）`
        )
        // Applied rows persist server-side; the rest falls back to what it holds.
        showGrants(projectId)
        return
      }
    }
    toast(`已保存 ${saved} 项授权变更`)
    showGrants(projectId)
  }

  $('#grantSave').onclick = () => {
    const dirty = dirtyGrants()
    if (dirty.length === 0) return
    dialog(
      '确认保存权限变更',
      `
      <p>将保存 ${dirty.length} 行权限变更：</p>
      <ul>${dirty.map(diffLine).join('')}</ul>
      <p class="muted">断开后重新打开项目即按新权限签发凭证。</p>`,
      [
        {
          label: '确认保存',
          primary: true,
          onClick: () => {
            void applyChanges(dirty)
          }
        }
      ]
    )
  }
  $('#grantDiscard').onclick = () => showGrants(projectId)

  $('#grantAdd').onclick = async () => {
    const subjectId = $('#grantSubject').value.trim()
    if (!subjectId) return
    try {
      await api(grantsPath, {
        method: 'PUT',
        // An empty array deletes a row, so a new grant is born with one bit and
        // the rest is set in the matrix (M120b §4.2).
        body: JSON.stringify({
          subjectType: $('#grantType').value,
          subjectId,
          permissions: ['open']
        })
      })
    } catch (err) {
      // A refused grant (a mistyped name → 400 USER_NOT_FOUND) used to vanish
      // silently: report it and leave the matrix as the platform holds it (W2-M-1).
      toast(`授予失败：${err.message ?? err}`)
      return
    }
    toast('已授予，默认 open，可在矩阵中调整')
    showGrants(projectId)
  }
  for (const btn of panel.querySelectorAll('[data-remove]')) {
    btn.onclick = async () => {
      const sep = btn.dataset.remove.indexOf(':')
      const subjectType = btn.dataset.remove.slice(0, sep)
      const subjectId = btn.dataset.remove.slice(sep + 1)
      try {
        await api(grantsPath, {
          method: 'PUT',
          body: JSON.stringify({ subjectType, subjectId, permissions: [] })
        })
      } catch (err) {
        toast(`移除失败：${err.message ?? err}`)
        return
      }
      toast('已移除')
      showGrants(projectId)
    }
  }
}

const AUDIT_PAGE_SIZE = 50

async function renderAudit(loadMore = false) {
  // Only 「加载更早」 accumulates onto what is shown; a fresh view re-queries, so
  // leaving and returning can never resurrect a stale accumulation (M116-QA-002).
  if (!loadMore) {
    state.auditEvents = null
    state.auditCursor = null
  }
  // Filter controls re-render from state so what they show always matches the
  // rows below them (M116-QA-003).
  const filter = state.auditFilter
  const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) })
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value)
  if (state.auditCursor) params.set('cursor', String(state.auditCursor))
  const body = await api(`/v1/audit/events?${params}`)
  const events = state.auditEvents ? [...state.auditEvents, ...body.events] : body.events
  state.auditEvents = events
  state.auditCursor = body.nextCursor
  content().innerHTML = `
    <div class="page-head"><div><h1>审计日志</h1><p>只追加、哈希链校验；保留 180 天。已显示 ${events.length} 条。</p></div></div>
    <div class="toolbar">
      <select class="select" id="auditType">
        <option value="">全部事件</option>
        ${[
          'login',
          'logout',
          'project_create',
          'project_connect',
          'project_access',
          'grant_update',
          'host_register',
          'host_revoke',
          'policy_update',
          'device_revoke'
        ]
          .map((t) => `<option value="${t}">${t}</option>`)
          .join('')}
      </select>
      <select class="select" id="auditResult">
        <option value="">全部结果</option>
        <option value="success">成功</option>
        <option value="failure">失败</option>
        <option value="denied">拒绝</option>
      </select>
      <input class="input grow" id="auditActor" placeholder="按用户过滤，如 zhangsan">
      <button class="btn primary" id="auditApply">查询</button>
      <button class="btn" id="auditReset">重置</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>时间</th><th>用户</th><th>事件</th><th>目标</th><th>结果</th><th>traceId</th></tr></thead>
        <tbody>
          ${
            events
              .map(
                (e) => `<tr>
                <td class="muted">${new Date(e.ts).toLocaleString('zh-CN')}</td>
                <td>${esc(e.actor ?? '—')}</td>
                <td class="mono">${esc(e.eventType)}</td>
                <td class="mono muted">${esc(e.targetId ?? '—')}</td>
                <td>${{ success: '✓ 成功', failure: '✕ 失败', denied: '⛔ 拒绝' }[e.result]}</td>
                <td class="mono muted"><span title="${esc(e.traceId ?? '')}">${esc(e.traceId ?? '—')}</span>
                  ${e.traceId ? `<button class="btn sm" data-trace="${esc(e.traceId)}">复制</button>` : ''}
                </td>
              </tr>`
              )
              .join('') || '<tr><td colspan="6" class="table-empty">没有事件</td></tr>'
          }
        </tbody>
      </table>
    </div>
    ${body.nextCursor ? `<div class="toolbar"><span class="muted">仅显示最近 ${AUDIT_PAGE_SIZE} 条，还有更早记录。</span><button class="btn" id="auditMore">加载更早</button></div>` : ''}`
  // The chosen conditions are restored as properties: a parsed `selected`
  // attribute is not what every DOM picks up on a re-render.
  $('#auditType').value = filter.eventType ?? ''
  $('#auditResult').value = filter.result ?? ''
  $('#auditActor').value = filter.actor ?? ''
  const apply = () => {
    state.auditFilter = {
      eventType: $('#auditType').value,
      result: $('#auditResult').value,
      actor: $('#auditActor').value.trim()
    }
    for (const [key, value] of Object.entries(state.auditFilter))
      if (!value) delete state.auditFilter[key]
    state.auditEvents = null
    state.auditCursor = null
    renderAudit()
  }
  $('#auditApply').onclick = apply
  $('#auditReset').onclick = () => {
    state.auditFilter = {}
    state.auditEvents = null
    state.auditCursor = null
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

function openDrawer(title, html) {
  const backdrop = document.createElement('div')
  backdrop.className = 'drawer-backdrop'
  backdrop.innerHTML = `
    <div class="drawer" role="dialog" aria-modal="true">
      <div class="drawer-head"><h2>${esc(title)}</h2><button class="icon-btn" aria-label="关闭">✕</button></div>
      <div class="drawer-body">${html}</div>
    </div>`
  backdrop.querySelector('.icon-btn').onclick = () => backdrop.remove()
  backdrop.onclick = (e) => {
    if (e.target === backdrop) backdrop.remove()
  }
  document.body.appendChild(backdrop)
  return { close: () => backdrop.remove() }
}

function dialog(title, html, actions = []) {
  const backdrop = document.createElement('div')
  backdrop.className = 'dialog-backdrop'
  backdrop.innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true">
      <h2>${esc(title)}</h2>
      <div class="body">${html}</div>
      <div class="foot">
        ${actions.map((a, i) => `<button class="btn ${a.primary ? 'primary' : ''}" data-action="${i}">${esc(a.label)}</button>`).join('')}
        <button class="btn ghost" data-action="close">关闭</button>
      </div>
    </div>`
  backdrop.querySelector('[data-action="close"]').onclick = () => backdrop.remove()
  backdrop.onclick = (e) => {
    if (e.target === backdrop) backdrop.remove()
  }
  actions.forEach((a, i) => {
    backdrop.querySelector(`[data-action="${i}"]`).onclick = () => {
      const keep = a.onClick?.()
      if (keep !== false) backdrop.remove()
    }
  })
  document.body.appendChild(backdrop)
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
  void fetch('/v1/auth/logout', {
    method: 'POST',
    headers: { authorization: `Bearer ${state.accessToken}` }
  }).catch(() => undefined)
  state.accessToken = ''
  state.refreshToken = ''
  state.user = null
  localStorage.removeItem('orca.access')
  localStorage.removeItem('orca.refresh')
  localStorage.removeItem('orca.user')
  showLogin()
}

function enterApp() {
  $('#view-login').hidden = true
  $('#view-app').hidden = false
  $('#adminNav').hidden = !isAdmin()
  $('#userName').textContent = state.user.displayName
  $('#userDept').textContent = state.user.dept
  $('#userAvatar').textContent = state.user.displayName.slice(0, 1)
  $('#roleChip').textContent = isAdmin() ? '平台管理员' : '开发者'
  navigate('workbench')
}

function showLogin() {
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
$('#open403').onclick = renderForbidden

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
