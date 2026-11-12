/* Orca Cloud 平台 Web 前端（前后端分离：只通过 REST 访问后端） */

const state = {
  accessToken: localStorage.getItem('orca.access') ?? '',
  refreshToken: localStorage.getItem('orca.refresh') ?? '',
  user: null,
  projects: [],
  route: 'workbench',
  deviceId: localStorage.getItem('orca.device') ?? '',
  lastHosts: [],
  auditFilter: {}
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

const ADMIN_ROUTES = new Set(['hosts', 'members', 'audit', 'settings'])
const TITLES = {
  workbench: '工作台',
  projects: '我的项目',
  hosts: '平台设置 / 主机',
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
    members: renderMembers,
    audit: renderAudit,
    settings: renderSettings
  }
  content().innerHTML = '<p class="muted">加载中…</p>'
  ;(renderers[route] ?? renderWorkbench)()
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
  const body = await api('/v1/projects')
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

function projectCard(p) {
  return `
    <div class="card project-card">
      <div class="name"><span class="dot ${p.hostStatus === 'online' ? 'online' : 'offline'}"></span>${esc(p.name)}</div>
      <div class="path">${esc(p.repoUrl || p.path)}</div>
      <div class="meta-row">
        <span>${esc(p.hostName ?? '—')}</span>
        <span class="badge">${esc(p.defaultBranch)}</span>
        <span>创建于 ${relative(p.createdAt ?? Date.now())}</span>
      </div>
      <div class="foot">
        <span class="badge ${p.downloadPolicy === 'deny' ? 'lock' : ''}">${p.downloadPolicy === 'deny' ? '下载已禁用' : '允许下载'}</span>
        <button class="btn primary sm" data-open="${p.id}">打开</button>
      </div>
    </div>`
}

function projectRow(p) {
  const offline = p.hostStatus !== 'online'
  return `<tr>
    <td><strong>${esc(p.name)}</strong><div class="muted mono">${esc(p.path)}</div></td>
    <td class="mono muted">${esc(p.repoUrl)}</td>
    <td>${esc(p.hostName ?? '—')} ${offline ? '<span class="badge">离线</span>' : ''}</td>
    <td class="muted">${esc(p.permissions.join(' · '))}</td>
    <td><span class="dot ${offline ? 'offline' : 'online'}"></span> ${offline ? '主机离线' : '可打开'}</td>
    <td class="actions">
      <button class="btn sm" data-open="${p.id}" ${offline ? 'disabled' : ''}>打开</button>
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
      `<p>桌面客户端会先探测直连地址，全部失败后经中继连接。凭证 ${body.expiresIn} 秒内有效且只能使用一次。</p>
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
      rows.map((p) => `<tr>
        <td><strong>${esc(p.name)}</strong><div class="muted mono">${esc(p.path)}</div></td>
        <td class="mono muted">${esc(p.repoUrl)}</td>
        <td>${esc(p.hostName)} <span class="dot ${p.hostStatus === 'online' ? 'online' : 'offline'}"></span></td>
        <td class="muted">${esc(p.permissions.join(' · '))}</td>
        <td>${p.downloadPolicy === 'deny' ? '<span class="badge lock">禁止</span>' : '<span class="badge">允许</span>'}</td>
        <td class="actions"><button class="btn sm" data-open="${p.id}">打开</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="table-empty">没有匹配的项目</td></tr>'
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
  const status = h.status === 'online' ? '在线' : h.status === 'maintenance' ? '维护中' : '离线'
  const dot = h.status === 'online' ? 'online' : h.status === 'maintenance' ? 'warn' : 'offline'
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

async function registerHostDialog() {
  const body = await api('/v1/hosts/tokens', { method: 'POST' })
  const cmd = `curl -fsSL https://devcloud.example.com/install.sh | sudo bash -s -- --token ${body.token}`
  dialog(
    '注册主机',
    `<p>在目标开发机执行以下命令完成注册。令牌 24 小时内有效且只能使用一次。</p>
     <pre id="installCmd">${esc(cmd)}</pre>`,
    [
      {
        label: '复制命令',
        primary: false,
        onClick: () => {
          navigator.clipboard?.writeText(cmd)
          toast('已复制')
          return false
        }
      }
    ]
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
    </dl>
    <div class="toolbar" style="margin-top:20px">
      <button class="btn" id="maintenanceBtn">${host.status === 'maintenance' ? '结束维护' : '进入维护模式'}</button>
      <button class="btn danger" id="revokeHostBtn">下线主机</button>
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
    .map(
      (g) => `<tr>
        <td>${esc(g.subjectId)}</td>
        <td class="muted">${g.subjectType === 'group' ? '组' : '用户'}</td>
        ${permissionSet
          .map((p) =>
            p === 'download'
              ? '<td><span class="badge lock">锁</span></td>'
              : `<td>${g.permissions.includes(p) ? '✓' : '—'}</td>`
          )
          .join('')}
        <td class="actions"><button class="btn sm danger" data-remove="${g.subjectType}:${g.subjectId}">移除</button></td>
      </tr>`
    )
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
    await api(`/v1/projects/${projectId}/grants`, {
      method: 'PUT',
      body: JSON.stringify({
        subjectType: $('#grantType').value,
        subjectId,
        permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
      })
    })
    toast('已授予')
    showGrants(projectId)
  }
  for (const btn of document.querySelectorAll('[data-remove]')) {
    btn.onclick = async () => {
      const [subjectType, subjectId] = btn.dataset.remove.split(':')
      await api(`/v1/projects/${projectId}/grants`, {
        method: 'PUT',
        body: JSON.stringify({ subjectType, subjectId, permissions: [] })
      })
      toast('已移除')
      showGrants(projectId)
    }
  }
}

async function renderAudit() {
  const params = new URLSearchParams({ limit: '50', ...state.auditFilter })
  const body = await api(`/v1/audit/events?${params}`)
  content().innerHTML = `
    <div class="page-head"><div><h1>审计日志</h1><p>只追加、哈希链校验；保留 180 天。</p></div></div>
    <div class="toolbar">
      <select class="select" id="auditType">
        <option value="">全部事件</option>
        ${['login', 'logout', 'project_connect', 'project_access', 'grant_update', 'host_register', 'host_revoke', 'policy_update', 'device_revoke']
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
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>时间</th><th>用户</th><th>事件</th><th>目标</th><th>结果</th><th>traceId</th></tr></thead>
        <tbody>
          ${body.events
            .map(
              (e) => `<tr>
                <td class="muted">${new Date(e.ts).toLocaleString('zh-CN')}</td>
                <td>${esc(e.actor ?? '—')}</td>
                <td class="mono">${esc(e.eventType)}</td>
                <td class="mono muted">${esc(e.targetId ?? '—')}</td>
                <td>${{ success: '✓ 成功', failure: '✕ 失败', denied: '⛔ 拒绝' }[e.result]}</td>
                <td class="mono muted">${esc((e.traceId ?? '').slice(0, 12))}</td>
              </tr>`
            )
            .join('') || '<tr><td colspan="6" class="table-empty">没有事件</td></tr>'}
        </tbody>
      </table>
    </div>`
  $('#auditApply').onclick = () => {
    state.auditFilter = {
      eventType: $('#auditType').value,
      result: $('#auditResult').value,
      actor: $('#auditActor').value.trim()
    }
    for (const [k, v] of Object.entries(state.auditFilter)) if (!v) delete state.auditFilter[k]
    renderAudit()
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
    await api('/v1/policies/download', {
      method: 'PUT',
      body: JSON.stringify({ downloadDefault: value })
    })
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
