# U106 设计 · 全站唯一 URL 路由与刷新恢复

- 日期：2026-11-16
- 性质：设计（只设计，未改产品代码）
- 输入：用户 2026-11-16 原话「云端开发系统任意页面增加唯一 url 路由，刷新页面恢复到原来的页面，而不是首页」；`u103-refresh-login-diagnosis.md`；现有实现复核（平台管理台 `cloud-platform/apps/web/`、Orca Web `src/renderer/src/web/`、简易工作区 `src/renderer/src/cloud/`、移动端 `mobile/`）
- 合流：**URL = 恢复载体，平台会话 = 恢复凭证**。U103-B1（静默续会话）与本设计的 Orca Web 刷新链是同一条实现；U103-B2（已落地 `72e6d3a7b79`：记住项目/只选可开项目）作为「URL 无 project 时」的兜底，不另造。
- 范围外：标签组/终端内容恢复（U96 A 承接）、U104 二次打开丢标签的诊断结论（报告未交付，本设计只保证 URL 指向唯一项目，不修其恢复链）、原生移动 App 内部导航（Expo Router 已有路由）。

---

## 0. 裁定摘要

| # | 裁定 |
| --- | --- |
| D1 | 平台管理台用 **hash 路由**（`#/...`），不使用 History path。原因：平台静态服务 `serveStatic` 只服务 `/`、已知静态文件与 `webRoot` 文件，无 SPA fallback（`cloud-platform/apps/api/src/server.ts:4340-4375`），path 路由会 404，且旧宿主/版本窗口无法保证 fallback。 |
| D2 | 路由名与既有生产代码对齐：`workbench / projects / hosts / relays / users / audit / settings`；不新增 `diagnostics`、`members`（生产无此页）。 |
| D3 | 弹框可深链：`#/projects/<id>`、`#/hosts/<id>`、`#/users/<id>`；权限页签用 `?tab=perms`。审计事件行展开不做深链（页码相关），审计**筛选条件**入 URL。 |
| D4 | 全屏工作区覆盖层是页面：`#/workspace/<projectId>`；刷新重新签发 handoff 并恢复覆盖层。 |
| D5 | **未知路由不再静默回落工作台**：保留未知 hash，渲染可辨识 404 页（含返回工作台）。`#/members`（U67 已删页面）按未知路由处理，**推翻** U67「回落工作台」旧行为；U67 文本/验收引用需同步修订。 |
| D6 | 管理路由无权限：**保留请求 URL**，渲染 403 页；刷新重新评估权限。项目类不可见/不存在按 FR-2.2 的 404 语义，不给 403 存在性信号。 |
| D7 | 登录是视图态而非路由：保留目标 hash，登录成功后落到该 hash；`#/login` 作为兼容别名（未登录→登录，已登录→`#/workbench`）。 |
| D8 | Orca Web 的页面 URL 为 `web-index.html?api=<平台地址>&project=<项目 id>`：`project` 放进 search、`handoff` 只走一次性 hash；进入前先把地址栏规范化为该形态，再兑换票据。 |
| D9 | URL 中的 `project` 是**权威目标**；刷新有持久云会话时静默续会话并对该 project 重新 mint 票据。project 不可见时给可辨识 403/404 页，**绝不静默切到记忆项目/首个项目**。 |
| D10 | 简易工作区/嵌入页沿用 `cloud-admin.html?api=<平台>&embed=1&project=<id>`（刷新已可凭保存会话恢复）；补齐「保存会话失效 → 登录表单（地址锁定）→ 登录后自动回到同一 project」而非「嵌入会话不可用」死路。 |
| D11 | 移动浏览器视口共用同一 schema（响应式），不另造路由；原生 App 不在本次范围。 |
| D12 | URL 永不携带访问/刷新令牌或已兑换的 handoff code；project id 为不透明标识，可出现在地址栏与分享链接，但接收方必须自行登录且通过权限校验。 |

---

## 1. 全页面清单与缺口表

现状核对（生产代码，不是原型）：

- 管理台只有内存 `state.route`（`cloud-platform/apps/web/app.js:8`），`navigate()` 直接改内存并渲染（`:116-136`），**无 `hashchange`、无 `history.*`**；启动/登录后固定 `navigate('workbench')`（`:2733`）。因此任意 `#/...` 都被忽略，刷新/重开一律工作台（已登录）或登录页（无会话）。
- 原型 `ui/README.md` 的 hash 路由与生产无关；`#/members`、`#/diagnostics` 在生产不存在。
- Orca Web 启动按 `cloudLoginRequired` 删除环境并回 WebConnect（`src/renderer/src/web/web-root.tsx:47-53`），handoff hash 进入即抹除（`web-cloud-handoff-entry.ts:69-78`），`project` 随 hash 一起丢失；URL 只剩 `?api=`。
- 简易工作区嵌入页 URL 稳定（平台签发时写入 `?api=&embed=1&project=`，`cloud-platform/apps/api/src/server.ts:4090-4105`），刷新靠 `cloud-browser-saved-session` 恢复；会话失效时落到 `CloudEmbedSessionMissing`（`cloud-app.tsx:338-345`）死路。

| # | 面 | 载体/入口 | 当前 URL | 当前刷新落点 | 缺口 |
| --- | --- | --- | --- | --- | --- |
| 1 | 平台登录 | `/` | 无 hash | 登录页（无会话）/工作台（有会话） | **全缺**：无目标 URL 保留、无 `#/login` 兼容 |
| 2 | 工作台 | `#/workbench` 概念 | 无 | 工作台 | **全缺**：无唯一 URL（结果碰巧相同） |
| 3 | 我的项目 | `#/projects` | 无 | 工作台 | **全缺** |
| 4 | 项目详情弹框 | 项目行「详情」 | 无 | 工作台，弹框丢失 | **全缺** |
| 5 | 项目工作区覆盖层 | 项目行「打开」 | 无（iframe 内 URL 有 `?embed=1&project=`） | 工作台，覆盖层丢失 | **全缺** |
| 6 | 主机 | `#/hosts` | 无 | 工作台 | **全缺** |
| 7 | 主机详情抽屉 | 主机行「详情」 | 无 | 工作台，抽屉丢失 | **全缺** |
| 8 | 中继 | `#/relays` | 无 | 工作台 | **全缺** |
| 9 | 用户管理 | `#/users` | 无 | 工作台 | **全缺** |
| 10 | 用户详情弹框 | 用户行「详情」 | 无 | 工作台，弹框丢失 | **全缺** |
| 11 | 审计日志 | `#/audit` + 筛选 | 无 | 工作台，筛选丢失 | **全缺** |
| 12 | 平台设置 | `#/settings` | 无 | 工作台 | **全缺** |
| 13 | 403 无权限页 | 管理路由兜底 | 无 | 工作台（不再显示 403） | **全缺** |
| 14 | 未知路由 | 任意 `#/foo` | 无 | 工作台（静默） | **全缺**：无可辨识落点 |
| 15 | Orca Web 云端登录面 | `web-index.html?api=` | `?api=` | 登录/连接页 | **全缺**：无 project 上下文 |
| 16 | Orca Web 云工作区 | handoff 新标签 | `?api=`（hash 已抹） | **强制登录页**（U103） | **全缺**：页面级恢复失败 |
| 17 | Orca Web 直连配对 | `?pairing=`/`#code` | 进入时清成纯地址 | 已存环境→App | **部分**：能刷新，但无唯一页面 URL（单环境存储） |
| 18 | 简易工作区嵌入页 | `cloud-admin.html?api=&embed=1&project=` | 稳定 | 保存会话有效→工作区；失效→「嵌入会话不可用」 | **部分**：失效路径是死路 |
| 19 | 管理台移动视口 | 同 2-14 | 同管理台 | 同管理台 | **全缺**（继承） |
| 20 | Orca Web 移动视口 | 同 16 | 同 Orca Web | 同 Orca Web | **全缺**（继承） |
| 21 | 原生移动 App | Expo Router | 已有 `/h/host-1` 等路由 | 由 App 自身导航决定 | 不在范围 |

**缺口计数：21 面，18 全缺，2 部分，1 不在范围。**

---

## 2. URL schema

### 2.1 平台管理台（hash）

所有路由以 `https://<platform>/#` 开头，参数沿用 `URLSearchParams` 编码；空参数省略；id 用现有 API 的不透明 id（`proj_…`、`host_…`、`user_…`）。

| 路由 | 页面/视图 | 权限 |
| --- | --- | --- |
| `#/workbench` | 工作台（登录后默认） | 登录 |
| `#/projects` | 我的项目；`?q=<搜索词>` | 登录 |
| `#/projects/<projectId>` | 我的项目 + 项目详情弹框；`?tab=info\|perms` | 管理员（非管理员→403） |
| `#/workspace/<projectId>` | 项目工作区覆盖层（顶层路径，避免与详情嵌套歧义） | `open` 权限；不可见→404 |
| `#/hosts` | 主机；`#/hosts/<hostId>?tab=info\|perms` 为抽屉 | 管理员 |
| `#/relays` | 中继（无详情抽屉） | 管理员 |
| `#/users` | 用户管理；`?query=&role=&status=` | 管理员 |
| `#/users/<userId>` | 用户管理 + 用户详情弹框 | 管理员 |
| `#/audit` | 审计；`?range=&q=&event=&username=&fileName=&result=&projectId=&hostId=&since=&until=` | 管理员/审计员 |
| `#/settings` | 平台设置 | 管理员 |
| `#/forbidden` | 403 预览（顶栏「查看无权限页」） | 登录 |
| 其他任意 hash | 404 页（显示原 hash，可返回工作台） | 登录 |

补充规则：

- 工作区覆盖层最终裁定采用 **`#/workspace/<projectId>`**（顶层路径，避免与详情弹框嵌套歧义）；`#/projects/<projectId>/workspace` 已否决，不实现。
- 项目详情/主机抽屉的权限页签 `tab=perms` 必须可刷新直达（U67 授权入口的唯一位置）。
- 审计 `event` 值沿用 UI 现有编码：普通事件 `eventType`；家族事件 `family:<name>`。`cursor`（加载更早）**不入 URL**，刷新从第一页开始。
- 用户角色下拉等写操作弹框（角色变更确认）不入 URL；它依赖详情弹框的父路由。
- `#/projects` 与 `#/workbench` 都展示项目数据，但语义不同（入口页 vs 我的项目），不合并。
- 无 hash 的根地址：`replaceState('#/workbench')`（不新增历史项）。

### 2.2 Orca Web 工作区

| URL | 含义 | 刷新行为 |
| --- | --- | --- |
| `web-index.html` | 无云端上下文：直连配对/连接页 | 现有行为 |
| `web-index.html?api=<platform>` | 云端登录/连接页；登录后按记忆项目（B2）打开并规范化为下一行 | 有保存会话则静默续并打开记忆项目；否则登录 |
| `web-index.html?api=<platform>&project=<projectId>` | 某项目的页面级工作区（唯一页面 URL） | 静默续会话→重新 mint→回到同一项目；失败按 §3.2 分支 |
| `web-index.html?api=<platform>&project=<projectId>&embed=1` | 仅管理台嵌入页使用（实际为 `cloud-admin.html`） | 见 §2.3 |
| `web-index.html?pairing=<code>` / `#code` | 直连配对（秘密） | 现有：消费后清地址；不新增页面路由 |

要点：

- handoff 入口仍为 `?api=…#handoff=<code>&project=<id>`（FR-3.10）；进入时**先** `history.replaceState` 为 `?api=&project=<id>`（保留 hash 之外的既有查询，如 `embed`），**再**兑换 code。这样刷新、历史、Referer 都不会看到 code；兑换失败也仍有 project 可回跳登录。
- 登录成功（含记忆项目路径）后同样 `replaceState` 成带 `project` 的规范 URL。
- Orca Web 不引入应用内多页面路由：工作区内部标签/终端由 U96 A 恢复；页面级唯一 URL 只表达「哪个平台 + 哪个项目」。

### 2.3 简易工作区 / 嵌入页

- 规范 URL：`https://<host-or-relay-edge>/cloud-admin.html?api=<platform>&embed=1&project=<projectId>`（平台 `web-handoff` 已按此签发，含 relay `/h/<routeKey>/` 形态）。
- 刷新语义：保持 URL 不变；`CloudApp` 的 embed 分支凭保存的平台会话恢复并自动 `openProject(projectId)`。
- 会话失效：显示云端登录表单（平台地址预填且锁定），提示「会话已过期，请重新登录；登录后将返回该项目」，登录成功自动打开同一 project。
- 禁止把 `handoff` 写回 URL。
- 控制台覆盖层刷新：控制台恢复 `#/workspace/<id>` 后重新 `POST /v1/projects/:id/web-handoff`（surface=admin），再挂 iframe；不依赖旧 iframe 的 URL。

### 2.4 移动视口

- 管理台与 Orca Web 在移动浏览器使用**完全相同**的 schema；样式沿用现有 `@media`（`styles.css:790/904/941/956`）与 Orca Web 响应式布局。
- 原生 App 不接这套 URL；其 Expo Router 路径已独立存在。

---

## 3. 刷新恢复语义链

### 3.1 平台管理台

```
启动
 ├─ 读 location.hash（无 → replaceState '#/workbench'；'#/login' → 视为目标 workbench）
 ├─ 有 access token → GET /v1/me
 │    ├─ 401 → 用 refresh token 刷新（api() 已实现）
 │    │    ├─ 成功 → 继续
 │    │    └─ 失败 → 清会话，显示登录；保留当前 hash 为登录后回跳目标
 │    └─ 成功 → resolveRoute(hash)
 └─ 无 token → 显示登录；保留当前 hash 为回跳目标
```

`resolveRoute(hash)`：

| 情况 | 行为 |
| --- | --- |
| 已知页面且有权 | 渲染页面；`replaceState` 规范化（去空参数、去未知参数） |
| 管理路由但当前角色无权 | **不改 URL**，渲染 403 页（含「返回工作台」）；刷新重新判定 |
| 项目/主机/用户 id 不在当前可见集合 | 渲染 404 内容页（不显示名称、不泄露存在性）；URL 保留 |
| 未知路由（含 `#/members`、`#/diagnostics`） | 渲染 404 页，标题「页面不存在」，展示原 hash，按钮「返回工作台」 |
| 详情路由 | 先完成列表加载，再打开弹框；弹框数据走既有 `openProjectDetail`/`showHost`/`openUserDetail` |
| 工作区路由 | 先确认项目可开（可见 + open + 主机状态），再 mint handoff 并挂覆盖层 |

登录回跳：

- 登录页不改变 hash；提交成功后 `enterApp()` 读取启动时捕获的目标 hash，跳到该路由而不是固定 workbench。
- 显式「退出」：清 token 后 `replaceState('#/workbench')`，清空回跳目标。
- 会话过期：保留 hash，回跳目标=当前 hash。

弹框/覆盖层历史语义：

- 打开详情/覆盖层：`history.pushState(null,'',newHash)`，再渲染。
- 应用内关闭：若该视图是 push 打开的 → `history.back()`；深链直达（无本页前项）→ `replaceState` 回父路由（`#/projects` / `#/hosts` / `#/users` / `#/workbench`）。
- 浏览器后退：`hashchange` 处理器发现目标路由不再包含详情 → 移除弹框/覆盖层；包含不同 id → 关闭旧的、打开新的。
- 页面导航时若有打开的弹框：先移除弹框 DOM，不再操作历史，再 push 新路由。
- 筛选输入：`replaceState`（不刷历史）；显式「查询」按钮：`pushState`（可后退回上次查询）。

### 3.2 Orca Web

```
启动
 ├─ 读 handoff（hash+project）
 │    ├─ 有 → replaceState '?api&project' → 兑换 code → 打开 project → 挂 App
 │    └─ 无 → 读 search {api, project}
 ├─ project 存在？
 │    ├─ 是 → 尝试静默续会话（见下表）
 │    └─ 否 → 现有配对/连接逻辑；云端登录后用记忆项目（B2）打开并规范化 URL
 └─ 读持久会话 orca.webCloudSession（按 api 精确匹配）
```

静默续会话（U103-B1，复用既有 `restoreWebCloudSession`；该能力目前只被桌面 `cloud-browser-saved-session` 使用）：

1. `restoreWebCloudSession({ persisted, onTokensChanged })` 重建内存会话（access 过期会自动 refresh）。
2. `connectCloudProjectWithSession({ session, projectId: <URL project>, ... })`：列项目→校验 project 可见→请求票据→WebSocket 验证→`adoptWebRuntimeClient`→保存环境。
3. 成功后 `replaceState` 保持规范 URL，挂 App；标签恢复由 U96 A 继续。

失败分支（必须逐项可区分，禁止一律回登录）：

| 失败 | 判定 | 用户可见行为 | URL/存储 |
| --- | --- | --- | --- |
| 无持久会话 | storage 空 | 云端登录表单，平台地址预填 | 保留 `?api&project`，登录后回该项目 |
| refresh token 已死 | `SESSION_EXPIRED` | 登录表单，提示会话已过期 | 删除 `orca.webCloudSession`；保留 URL |
| 网络/平台不可达 | 非鉴权错误 | 登录表单或重试页，提示网络 | 保留会话与 URL，下次刷新重试 |
| project 不在可见列表 | `selectProject` 明确抛错（新增 `PROJECT_NOT_VISIBLE`） | 可辨识「项目不可访问或不存在」页 | 保留 URL，**不切换项目** |
| web-handoff 403 | `PROJECT_FORBIDDEN` | 同上（文案保持不泄露存在性） | 保留 URL |
| 主机离线/连接失败 | 连接错误 | 现有连接失败对话框；退回登录面时可重试 | 保留会话与 URL |

登录回跳：`WebConnect` 新增 `initialProjectId`；登录成功后 `connectCloudProject({ projectId })`，成功后 URL 已是规范形态。若 URL 无 project，则用记忆项目并在成功后补写 `project`。

403/404 页（新增轻量视图，App 不挂载）：

- 标题「无法打开该项目」；正文「项目不存在或当前账号无权访问。」
- 动作：`返回平台`（`<api>/#/projects`，有 api 时）、`重新登录`（清理保存会话并显示 WebConnect）。
- URL 保持 `?api&project`，刷新可重试。

简易工作区（`cloud-admin.html?embed=1&project=`）：

- 保存会话有效 → 现有自动打开链（A-RESTART 已覆盖）。
- 无效 → 替换 `CloudEmbedSessionMissing` 为登录表单（`defaultPlatformUrl`、`addressLocked`），成功后自动 `openProject(embedProjectId)`。
- project 403 → 嵌入页 403 视图 + 「返回平台」，不显示通用 degraded code。

---

## 4. 历史/前进与深链安全

### 4.1 push / replace 矩阵

| 动作 | 历史操作 |
| --- | --- |
| 首次无 hash 启动 | `replaceState '#/workbench'` |
| 侧栏导航 | `pushState` |
| 打开详情/覆盖层 | `pushState` |
| 应用内关闭详情/覆盖层 | `history.back()`；深链直达则 `replaceState` 父路由 |
| 浏览器前进/后退 | `hashchange` 渲染 |
| 筛选输入 | `replaceState` |
| 审计「查询」 | `pushState` |
| 登录成功 | 不改 hash（保留目标） |
| 显式退出 | `replaceState '#/workbench'` |
| Orca Web handoff 进入 | `replaceState '?api&project'`（替换掉带 code 的历史项） |
| Orca Web 登录成功 | `replaceState` 补 `project` |

### 4.2 外部分享安全

- 控制台分享 URL 只含路由与不透明 id；接收方用自己的会话重新鉴权与授权，管理路由照样 403，项目路由照样 404/不可见。
- Orca Web 分享 URL 只含平台地址与项目 id：接收方没有 handoff code 可复用；必须自行登录，平台仍校验可见性/`open`。
- 令牌只存 `localStorage`（`orca.webCloudSession`）；URL 中不出现 access/refresh token。
- handoff code 只在 fragment，兑换前用 `replaceState` 清除，且 `pushState` 不再写回。
- 浏览器不会把 fragment 放进 Referer；`?api=` 是平台地址而非秘密。建议（非阻塞）给平台/宿主页面补 `Referrer-Policy: same-origin` 作为纵深防御。
- 项目 id 可被同一浏览器历史看到；它不含项目名、仓库路径、主机信息。若后续要求「连 id 都不可出现在分享链接」，再评估 key/短链方案（见 Q1）。

---

## 5. AC → 测试用例映射（协议 §2-5）

测试基线：
- 控制台：`loadWebConsolePage`（happy-dom + 真实平台进程），需扩展 `hash` 与 `storageSeed` 选项以模拟刷新（新建 Window + 同一 storage 种子 + 目标 hash）。
- Orca Web：真实栈（`tests/e2e/cloud-golden-journey-git-and-restart.spec.ts` 的 platform+host+Chromium 栈；U96 A1 的「KNOWN RED」注释在 C10 变绿后删除）。
- 构建：任何 `out/web` 重建必须在快照/worktree 内执行（协议 §2-10，U103 判例），不得在主工作树原地重建。

| AC | 用例 | 测试文件/命令 | 关键断言 |
| --- | --- | --- | --- |
| U106-C1 | 控制台七个静态页面各有唯一 URL，刷新后同页 | `cloud-platform/test/e2e/u106-console-routing.e2e.test.ts`；`pnpm test cloud-platform/test/e2e/u106-console-routing.e2e.test.ts` | 依次 `#/workbench #/projects #/hosts #/relays #/users #/audit #/settings`：地址 hash 不变；以相同 storage 种子重建页面后仍在同页（crumbs/内容标识） |
| U106-C2 | 项目/主机/用户详情深链（含权限页签），刷新还原弹框 | 同上 | `#/projects/<id>?tab=perms`、`#/hosts/<id>?tab=perms`、`#/users/<id>` 刷新后弹框存在且 tab 正确；id 缺失→404 内容页 |
| U106-C3 | 项目搜索、用户筛选、审计筛选刷新还原 | 同上 | `#/projects?q=`、`#/users?query=&role=&status=`、`#/audit?range=&event=&username=&projectId=` 刷新后输入/选中值一致，查询请求参数与之一致 |
| U106-C4 | 登录后回跳原 URL | 同上 | 无 token 打开 `#/hosts` → 登录表单 → admin 登录 → 主机页渲染、hash 仍 `#/hosts`；开发者登录 → 403 页、hash 不变 |
| U106-C5 | 管理路由无权限保留 URL 并显示 403；刷新重新判定 | 扩展 `cloud-platform/test/e2e/web-admin-gating.e2e.test.ts` | 开发者 `#/hosts`：403 文案、hash 仍 `#/hosts`；重建页面仍 403；返回工作台后不在管理页 |
| U106-C6 | 未知路由（含 `#/members`）显式 404，不回落工作台 | `u106-console-routing.e2e.test.ts` | `#/members`、`#/nope`：标题「页面不存在」、无工作台表格、hash 保留；点击返回→`#/workbench` |
| U106-C7 | 覆盖层路由刷新恢复同一项目 | 扩展 `cloud-platform/test/e2e/u46-3-overlay.e2e.test.ts` 或 `tests/e2e/cloud-golden-journey-git-and-restart.spec.ts` | 打开 `#/workspace/<id>` 出现 `#workspaceOverlay` 且只 mint 一次；以同一 hash 重建页面再次出现覆盖层、项目名一致；关闭后回父路由 |
| U106-C8 | push/back 语义 | `u106-console-routing.e2e.test.ts` | 导航 N 次后 back 逐页返回；弹框 back 关闭且不离开页面；首启无 hash 只 `replace`（历史长度不增） |
| U106-C9 | Orca Web 入口 URL 规范化且无秘密 | `src/renderer/src/web/web-cloud-handoff-entry.test.tsx`（单元）+ 真实栈 | 兑换前地址已是 `?api&project`、无 `#handoff`；`history.length` 不新增带 code 项；刷新后仍为规范 URL |
| U106-C10 | Orca Web 有有效会话刷新→静默恢复同一项目（页面级） | `tests/e2e/cloud-golden-journey-git-and-restart.spec.ts` U96 A1（删除 KNOWN RED） | reload 后 `.app-layout` 可见、无 `#web-cloud-api-url` 登录表单、项目一致；无 `/v1/auth/login`、无 `/v1/web/handoff` 兑换；URL 含 `project=<id>` |
| U106-C11 | 会话失效→登录→回到同一项目 | `tests/e2e/u106-web-refresh-restore.spec.ts`（新） | 清 `orca.webCloudSession` 后 reload：登录表单出现、URL 仍带 project；登录成功→同一 project 工作区，URL 仍为 `?api&project` |
| U106-C12 | project 不可见→可辨识 403/404，不静默换项目 | 同上（用无权项目 id，管理员手建） | 出现「无法打开该项目」视图；无 `.app-layout`；无其他项目名；URL 保留；`返回平台` 指向 `/#/projects` |
| U106-C13 | 简易工作区嵌入页刷新/失效恢复 | 既有 `cloud-golden-journey-git-and-restart.spec.ts` A-RESTART + 新增 CloudApp 组件用例 | 有效会话 reload 同 checkout；清会话后出现登录表单（非「嵌入会话不可用」），登录后自动打开同 project |
| U106-C14 | 秘密卫生 | 单元 + 上述 e2e | 地址栏、history、请求 Referer 无 access/refresh token、无已兑换 handoff code；分享 URL 仅 `api`+不透明 id |
| U106-C15 | 移动视口冒烟 | `u106-console-routing.e2e.test.ts` 以 390×844 happy-dom/真实浏览器；Orca Web 同 C10 视口 | 同 schema、无横向滚动；`#/hosts` 与 `?api&project` 刷新落点一致 |

注：C10 的标签组/终端断言仍归 U96 A1 本体；C10 只负责「页面级恢复到同一项目」。二者同文件、同一次 reload，避免重复驱动真实栈。

---

## 6. 终审项（T）与开放问题（Q）

### 6.1 终审项

| T | 事项 | 设计建议 |
| --- | --- | --- |
| T1 | 控制台路由载体 | hash + `pushState`；不引入服务端 SPA fallback |
| T2 | 路由表命名 | 按 §2.1；不移植原型的 `#/project/<key>`、`#/diagnostics`、`#/members` |
| T3 | 详情弹框深链 | 项目/主机/用户三个；`tab=info\|perms`；写操作确认弹框不入 URL |
| T4 | 覆盖层路由命名 | 定 `#/workspace/<projectId>`（备选 `#/projects/<id>/workspace` 否决） |
| T5 | 403/404/未知路由 | 保留 URL；管理无权=403；项目不可见=404 文案；未知=404 页；`#/members` 由回落工作台改为 404 |
| T6 | 登录回跳与 `#/login` | 登录是视图态；保留目标 hash；`#/login` 兼容别名 |
| T7 | 筛选状态入 URL 范围 | 项目 `q`、用户 `query/role/status`、审计全部筛选；cursor 与事件行展开不入 |
| T8 | Orca Web URL 形态 | `?api=&project=`；handoff 仅 hash；进入前规范化为 `?api&project` |
| T9 | 静默续会话失败分支 | 按 §3.2 表；网络失败保留会话，鉴权死亡清会话，项目不可见不切换 |
| T10 | URL project 权威性 | URL 有 project 时覆盖记忆项目；不可见时禁止 fallback |
| T11 | 嵌入页失效路径 | 登录表单（地址锁定）替代「嵌入会话不可用」，登录后自动回同 project |
| T12 | 秘密与 id 可见性 | 无 token/code；project id 可分享；接收方重新鉴权；建议 `Referrer-Policy: same-origin` |
| T13 | 多标签页 | 每个云工作区标签各自 URL + 重新 mint；不依赖单一 localStorage 环境跨项目一致（直连配对仍为最后写入者） |
| T14 | 移动范围 | 浏览器视口共用 schema；原生 App 不接 |

### 6.2 开放问题

| Q | 问题 | 建议/影响 |
| --- | --- | --- |
| Q1 | `project` 用不透明 id 还是可读 key | 用 id（FR-2.2 不泄露名称/存在性）；改 key 需重新评估分享泄露 |
| Q2 | 覆盖层刷新重新 mint handoff（多一条 `web_handoff` 审计）还是复用 iframe 保存会话不 mint | 建议 mint：复用现有 U46 安全链、主机离线时错误可解释；确认审计噪声可接受 |
| Q3 | 审计单事件是否要 `#/audit?eventSeq=` 深链 | 建议不做：seq 依赖当前页集合；只深链筛选条件 |
| Q4 | 平台设置是否拆子路由 | 当前只有下载策略一个 section，不拆 |
| Q5 | 非管理员直达 `#/projects/<id>` | 设计取「管理路由 403」（详情本身管理员专属）；若要求与项目不可见统一 404，需改 T5 |
| Q6 | 直连配对是否也要唯一 URL（如 `?env=<id>`） | 建议本次不做：单环境存储 + 刷新已工作；多环境改造属另案 |
| Q7 | `#/login` 是否正式暴露给文档/分享 | 建议仅兼容，不作为规范入口 |
| Q8 | 原型旧链 `#/project/<key>` 是否做别名 | 建议不别名，统一 404；避免 key→id 解析与泄露面 |

---

## 7. ≤20 分钟实现令切分

每令一个代理；文件域尽量不相交。标注依赖与合流点。

| 令 | 预估 | 范围 | 依赖/合流 |
| --- | --- | --- | --- |
| R1 | 20' | 新增 `cloud-platform/apps/web/console-route.js`（纯解析/格式化/未知判定）；`web-release.ts` 的 `STATIC_FILES` + `index.html` 引入；`web-console-page.ts` 支持 hash/storage 种子并加载新脚本 | 无；T1/T2 |
| R2 | 20' | `app.js` 接入 router：启动解析、`hashchange`、导航 push、默认/`#/login`、登录回跳、403 保留 URL | R1；C1/C4/C5/C8 |
| R3 | 20' | 详情路由：`#/projects/<id>`/`#/hosts/<id>`/`#/users/<id>` + `tab=perms` + 弹框开/关历史 | R2；U67 权限页签；C2 |
| R4 | 15' | 覆盖层 `#/workspace/<id>`：打开 push、关闭 back、刷新重新 mint | R2；U46 覆盖层；C7 |
| R5 | 15' | 筛选入 URL：projects/users/audit（replace/查询 push、规范化） | R2；C3 |
| R6 | 15' | 未知路由/`#/members` 404 页 + U67 文档与验收引用修订说明 | R2；C6 |
| W1 | 20' | 新增 `web-cloud-workspace-location.ts`（读/规范化 `api`+`project`）+ `web-cloud-session-resume.ts`（注入 `restoreWebCloudSession`/`connectCloudProjectWithSession` 的纯编排，含失败分类） | **U103-B1**；与在途 B2 合流（URL project 优先，记忆项目仅兜底）；单测 C9/C11 |
| W2 | 20' | `web-root.tsx` 接入 resume：取消 `cloudSessionEnded` 强制清环境；规范化 URL 先于兑换；`WebConnect`/`WebConnectCloudForm` 传 `initialProjectId` | W1；C9/C10/C11 |
| W3 | 15' | Orca Web 403/404 视图（不挂 App）+ `cloud-app.tsx` embed 登录兜底 + project 403 分支 | W1/W2；C12/C13 |
| E1 | 20' | 真实栈：扩展 U96 A1（删 KNOWN RED）、新增 `tests/e2e/u106-web-refresh-restore.spec.ts` 覆盖 C11/C12/C14 | W2/W3 + U96 A 宿主恢复；快照构建 |
| E2 | 15' | 控制台 happy-dom 套件 `u106-console-routing.e2e.test.ts` 全量 + 移动视口冒烟 | R2-R6；C1-C8/C15 |

关键合流点（实现代理必须先读）：

1. **U103-B1**：本设计 W1/W2 就是 B1 的实现；`restoreWebCloudSession` 已存在（`web-cloud-session-restore.ts:21`），只在 `cloud-browser-saved-session.ts:69` 被用。不要新建第二套续会话。
2. **U103-B2 已落地（`72e6d3a7b79`）**：`selectProject` 已实现记忆项目/可开项目选择（`NO_OPENABLE_PROJECTS`），并新增 `web-cloud-project-memory.ts`、启动保留 `?api=`。实现令以该提交为基线，URL `project` 走显式参数，记忆项目只在无 project 时使用。
3. **U96 A**：页面恢复只负责把 App 挂到正确项目；标签/终端恢复由 A 链。E1 的 C10 与 U96 A1 共用一次 reload，不重复驱动。
4. **U46**：覆盖层 URL 与 mint 复用 `openProjectWorkspace`；不重写 iframe 协议。
5. **U67**：详情 `?tab=perms` 是权限唯一入口；`#/members` 由 U67 的「回落工作台」改为 404，需在 U67 设计/AC 文本中留修订记录（生产无该测试，原型 README 仍保留旧行为，见 §8）。
6. **U104**：无报告可纳入；本设计仅提供「URL 指定项目」这一确定性输入，二次打开是否丢标签由 U104 另行诊断。

---

## 8. 诊断声明复核（协议 §2-11）

| U103 声明 | 复核结果 |
| --- | --- |
| 创建云端环境时写 `cloudLoginRequired: true`，「reload must still return to sign-in」 | **属实**。HEAD 为 `web-cloud-connect.ts:142`（行号因在途 B2 改动偏移），注释在 `:123`。 |
| `web-root.tsx:48` 启动时据此删除环境并回 WebConnect | **属实**。`web-root.tsx:47-53` 删除存储环境；`:95-128` 渲染 WebConnect。 |
| handoff hash 进入即被清除 | **属实**。`web-cloud-handoff-entry.ts:69-78`；调用点 `web-root.tsx:42`。清除保留 `?api=`。 |
| 启动路径没有 `restoreWebCloudSession`/refresh 尝试 | **属实**。该函数只被 `cloud-browser-saved-session.ts:69`（独立 cloud-admin 页）使用；`WebRoot` 未引用。 |
| `selectProject` 取 `projects[0]` 导致 403 | **原 HEAD 属实，已由 U103-B2（`72e6d3a7b79`）修复**：`selectProject(projects, projectId, rememberedProjectId)` 优先 remembered 且要求 `permissions.includes('open')`；新错误码 `NO_OPENABLE_PROJECTS`。设计与测试以该基线为准，不得回退。 |
| B2 表单未预填 `?api=` | **已由 U103-B2 修复**（`web-root.tsx` 启动保留 `cloudApiUrl`）；本设计 W2 只需在 resume 失败时继续传入 URL 的 `api`。 |
| U104 报告 | 未交付；仅有 `evidence/u104/` 证据。不在本设计内推结论。 |

另：U46 设计文档已记录「控制台刷新丢失覆盖层（控制台本来无 URL 路由）」（`u46-three-actions-design.md:196`）；本设计即关闭该已知限制。

---

## 9. 主会话审定节

（待主会话审定后填写：T1-T14 逐项裁决、Q1-Q8 取舍、实现令派发顺序、与 U103-B1/B2 的合并方式。）
