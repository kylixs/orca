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
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
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

async function renderWorkbench() {
  const [projects, policy] = await Promise.all([loadProjects(), api('/v1/policies/download')])
  const online = projects.filter((p) => p.hostStatus === 'online').length
  const denied = projects.filter((p) => p.downloadPolicy === 'deny').length
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
      ${recent.map(projectCard).join('') || '<div class="card pad muted">暂无项目。请联系项目负责人或平台管理员。</div>'}
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

function projectCard(p) {
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
        <span class="badge ${p.downloadPolicy === 'deny' ? 'lock' : ''}">${p.downloadPolicy === 'deny' ? '下载已禁用' : '允许下载'}</span>
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
 * page in a new tab; 「Orca Web」 opens the host's browser entry for open
 * holders (M122 will switch it to the one-time handoff auto-entry).
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

/** Why the Orca Web entry cannot open, or null when it is a plain link. */
function orcaWebDisabledReason(p) {
  if (p.hostStatus === 'maintenance') {
    return '主机维护中'
  }
  if (p.hostStatus !== 'online') {
    return '主机离线'
  }
  if (!p.browserEntryUrl) {
    return '该主机暂无浏览器入口，请先在 Orca 桌面客户端中打开此项目'
  }
  return null
}

function orcaWebEntry(p) {
  if (!p.permissions.includes('open')) {
    return ''
  }
  const reason = orcaWebDisabledReason(p)
  return reason
    ? `<button class="btn sm" disabled title="${esc(reason)}">Orca Web</button>`
    : `<a class="btn sm" href="${esc(p.browserEntryUrl)}" target="_blank" rel="noopener" title="在新标签打开 Orca Web">Orca Web</a>`
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
  for (const btn of document.querySelectorAll('[data-open]')) {
    btn.onclick = () => openProject(btn.dataset.open)
  }
  for (const btn of document.querySelectorAll('[data-go]')) {
    btn.onclick = () => navigate(btn.dataset.go)
  }
}

async function openProject(projectId) {
  try {
    const body = await api(`/v1/projects/${projectId}/connect`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: currentDeviceId(), clientVersion: '1.5.0' })
    })
    const direct = body.endpoints.direct.map((e) => e.url).join('\n') || '（无直连地址）'
    const relay = body.endpoints.relay.map((e) => e.url).join('\n') || '（无中继地址）'
    dialog(
      '连接信息已就绪',
      `<p><strong>请在 Orca 桌面客户端中打开此项目</strong>（客户端将自动探测直连并连接）</p>
       <p>桌面客户端会先探测直连地址，全部失败后经中继连接。凭证 ${body.expiresIn} 秒内有效且只能使用一次。</p>
       <p class="muted">主机：${esc(body.host.name)} · 指纹 ${esc(body.host.fingerprint)}</p>
       <pre>${esc(`直连:\n${direct}\n\n中继:\n${relay}\n\n工作区:\n${body.workspace.workspaceRoot}`)}</pre>`
    )
  } catch (err) {
    dialog('无法打开项目', `<p>${esc(err.message)}</p><p class="muted mono">${esc(err.code ?? '')}</p>`)
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
  const projects = await loadProjects()
  content().innerHTML = `
    <div class="page-head">
      <div><h1>我的项目</h1><p>仅展示你有「打开项目」权限的项目。</p></div>
      <button class="btn" onclick="location.reload()">刷新</button>
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
        <td>${p.downloadPolicy === 'deny' ? '<span class="badge lock">禁止</span>' : '<span class="badge">允许</span>'}</td>
        <td class="actions">${projectRowActions(p)}</td>
      </tr>`
        )
        .join('') || '<tr><td colspan="6" class="table-empty">没有匹配的项目</td></tr>'
    wireProjectActions()
  }
  draw()
  $('#projectSearch').oninput = (e) => draw(e.target.value)
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
  const drawer = openDrawer(`主机 ${host.name}`, `
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
    <p class="muted" style="margin-top:12px">下线后该主机的项目立即不可打开，已签发凭证失效。</p>`)
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
      for (const other of document.querySelectorAll('[data-material]')) other.classList.remove('active')
      btn.classList.add('active')
      showGrants(btn.dataset.material)
    }
  }
  if (selected) showGrants(selected.id)
}

async function showGrants(projectId) {
  const body = await api(`/v1/projects/${projectId}/grants`)
  const permissionSet = ['open', 'terminal', 'agent', 'file:read', 'file:write', 'download']
  const rows = body.grants
    .map((g) => {
      // GET /grants names only user rows it can resolve: an unnamed user row has
      // no live account behind it (a pre-fix row keyed by the typed name), so it
      // grants nothing and its removal is refused server-side (W2 audit m-2).
      const deadUser = g.subjectType === 'user' && !g.username
      return `<tr>
        <td>${esc(g.username ?? g.subjectId)}${deadUser ? ' <span class="badge">已删除用户</span>' : ''}</td>
        <td class="muted">${g.subjectType === 'group' ? '组' : '用户'}</td>
        ${permissionSet
          .map((p) =>
            p === 'download'
              ? '<td><span class="badge lock">锁</span></td>'
              : `<td>${g.permissions.includes(p) ? '✓' : '—'}</td>`
          )
          .join('')}
        <td class="actions"><button class="btn sm danger" data-remove="${g.subjectType}:${g.subjectId}" ${deadUser ? 'disabled title="该账号已不存在，无法在此移除"' : ''}>移除</button></td>
      </tr>`
    })
    .join('')
  const panel = $('#grantPanel')
  panel.innerHTML = `
    <div class="section-head" style="margin-top:0"><h2>授权矩阵</h2></div>
    <div class="note">下载权限在平台策略中控制，一期固定为禁止，审批流二期开放。</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>主体</th><th>类型</th><th>open</th><th>terminal</th><th>agent</th><th>read</th><th>write</th><th>download</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="9" class="table-empty">尚无授权</td></tr>`}</tbody>
      </table>
    </div>
    <div class="toolbar" style="margin-top:16px">
      <input class="input" id="grantSubject" style="min-width:240px" placeholder="组 ID，如 team-payment">
      <select class="select" id="grantType"><option value="group">组</option><option value="user">用户</option></select>
      <button class="btn primary" id="grantAdd">授予基础权限</button>
    </div>`
  $('#grantAdd').onclick = async () => {
    const subjectId = $('#grantSubject').value.trim()
    if (!subjectId) return
    try {
      await api(`/v1/projects/${projectId}/grants`, {
        method: 'PUT',
        body: JSON.stringify({
          subjectType: $('#grantType').value,
          subjectId,
          permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
        })
      })
    } catch (err) {
      // A refused grant (a mistyped name → 400 USER_NOT_FOUND) used to vanish
      // silently: report it and leave the matrix as the platform holds it (W2-M-1).
      toast(`授予失败：${err.message ?? err}`)
      return
    }
    toast('已授予')
    showGrants(projectId)
  }
  for (const btn of document.querySelectorAll('[data-remove]')) {
    btn.onclick = async () => {
      const [subjectType, subjectId] = btn.dataset.remove.split(':')
      try {
        await api(`/v1/projects/${projectId}/grants`, {
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

async function renderSettings() {
  const policy = await api('/v1/policies/download')
  content().innerHTML = `
    <div class="page-head"><div><h1>平台设置</h1><p>下载策略与客户端最低版本。</p></div></div>
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
    toast('已保存，30 秒内生效')
    renderSettings()
  }
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
