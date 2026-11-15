# U46 设计 · 项目行三操作语义澄清（详情弹框 / 打开=内嵌简易工作区 / Orca Web 不动）

> 状态：设计稿，只设计不改码，待主会话审定后拆实现令
> 日期：2026-11-15 · 缺陷账：U46🔴（defect-ledger.md:53，用户 2026-11-15 澄清，FR-3.11 第三次修订）
> 依据：用户裁定（唯一需求源）· `ui/prototype.html` P3（3001–3230 行）+ `ui/README.md` §P3 ·
> `cloud-platform/apps/web/app.js` 现状入口（306–448 行）· `src/renderer/src/cloud/cloud-project-workspace.tsx`（W5a/M118）·
> `cloud-platform/apps/api/src/server.ts` projectView / sessionPageUrl / web-handoff · FR-3.9 / FR-3.11 / FR-6.2
> 范围：平台 Web（`cloud-platform/apps/web`）× 平台 API（`cloud-platform/apps/api`）× 云管理台页（`src/renderer/src/cloud*`）× 测试
> 非目标：不改宿主 RPC 契约、不改云权限表、不改 orca web（W13b）语义、不下发任何新端点给宿主。

---

## 0. 结论摘要

**一句话**：把项目行三操作落成三种明确语义——**详情=平台侧只读弹框**、**打开=管理台同页覆盖层里的简易工作区**（宿主伺服的 `cloud-admin.html` 以 iframe 嵌入，RPC 经既有 `cloud-browser-bridge` 直达宿主）、**Orca Web=原 W13b handoff 入口不动**；详情与工作区都不新增业务端点，平台侧只有两处 wire-additive 增量。

**架构选型：B（宿主伺服页 iframe + 既有 React 管线）**。决定性事实不是偏好而是浏览器可达性：跨网段浏览器只能经中继浏览器边缘，而 WSS 前缀由 `deriveWebRoutePathPrefix(location.pathname)` 从页面路径 `/h/<routeKey>/` 推导（`src/renderer/src/web/web-path-prefix.ts:16,42-57`）；票据里的 relay endpoints 是 SNI 形态（`server.ts:726-735`），浏览器无法拨号。平台源页面拿不到这个前缀，方案 A 就必须自建第二条传输路径。iframe 让工作区文档的源就是宿主/中继边缘，E2EE、设备密钥、票据、W5c 子票重签、终端 WebGL prime、文件 RPC 封装全部原样复用。

**复用清单（最大化）**：`CloudTerminalPanel`（xterm + WebGL + 重连）· `cloud-browser-bridge`（登录/开工作区/rpc/订阅）· `shared/cloud-file-browser.ts`（readDir/readPreview/路径拼接/排序）· `CloudConnectionDiagnosticsDialog` · `CloudConnectFailureDialog` / `CloudHostKeyDialog` · `readWebCloudHandoffEntry` / `clearWebHandoffFromAddressBar` / `redeemWebHandoff` · `workspace.info`（W13a）· `RecoverableRenderErrorBoundary` 懒加载终端分块模式 · 平台 `dialog()` / `.kv` / 状态徽标。差异只在：多标签宿主、文件树（分层展开）、文件编辑器、图片/HTML 预览、内嵌模式与"同页"装配。

**字段清单（详情弹框）**：创建表单六字段（名称/Key/主机/路径/仓库/默认分支）+ 必要补充：项目状态与准备失败原因、创建者（`createdBy`，唯一增量字段）、创建时间、宿主在线/维护原因、我的权限、直接授权概要（管理员，走既有 `GET /grants`）、下载策略生效值与来源（走既有 `GET /v1/policies/download`）、项目 ID。**零新增端点**；数据全部来自既有 `projectView` 数据面 + 两个既有只读端点。

**语义演进**：FR-3.11 第三次修订（M117/M122 双入口 → U5/W3c「打开=进工作区」→ U46 三操作）；FR-3.9 从"独立详情页的终端+只读文件树"演化为"弹框看信息 + 同页简易工作区（终端/文件树/编辑/预览）"。

**置信度：高（~90%）**。架构结论有传输层代码实证；复用面清楚。不确定点集中在：iframe 的 PTY 生命周期收尾（需关闭握手，见 §4.2/§8 R3）、宿主 bundle 版本落差（旧 bundle 不认 `embed=1`，有回落）、以及"简易工作区左侧栏"是否要与 P3 的 WORKSPACES 列表逐像素一致（本文给出单工作区行的最小忠实解，见 §4.3）。

---

## 1. 需求与语义演进（写清第 N 次修订）

### 1.1 三操作契约（本令唯一需求源）

| 操作 | 语义 | 现在的实现 | U46 后 |
| --- | --- | --- | --- |
| **详情** | 管理台**弹框**查看项目信息（字段≈创建表单 + 必要补充） | 管理员链接新标签打开宿主 `cloud-admin.html` 登录页（`app.js:310-318`） | 同页只读弹框；独立页入口降级为弹框内次要链接 |
| **打开** | **管理台同页面进入简易版工作区**（P3：左中右、中间多标签、点右侧文件加标签、终端/文件编辑/预览设计图·HTML），只在当前浏览器查看，不惊动远程主机 orca | 一次性 handoff 新标签打开 orca web（`app.js:441-448`） | 同页覆盖层 + iframe 工作区；handoff 保留为平台版本不支持的回落 |
| **Orca Web** | 打开 orca web 工作区（W13b 现语义） | W13b handoff → `web-index.html` | **不动**（同按钮、同端点、同语义） |

### 1.2 FR-3.11 修订史（第三次修订）

| 次 | 时间 | 变更 | 入口形态 |
| --- | --- | --- | --- |
| R1 | 2026-11-14（M117/M122） | 首次落地：双入口「详情」（管理员→宿主会话页）+「Orca Web」（open→handoff）；「打开」同 handoff | 两个新标签页 |
| R2 | 2026-11-14（U5/W3c） | 「打开」= 进入工作区，删除「连接信息已就绪」原始地址对话框 | 新标签页 |
| **R3（本令）** | **2026-11-15（U46）** | **三操作语义澄清**：详情=弹框；打开=同页简易工作区；Orca Web 保持 R2 语义 | **弹框 + 同页覆盖层** |

### 1.3 FR-3.9 语义演进（能力面不缩、承载方式变）

- R1（M118）：管理台项目详情**页** = 实时终端 + 右侧文件树只读预览（W5a/W5b）。
- R2（本令）：同一能力拆成两处——**信息**进弹框（平台数据），**工作区**进同页简易工作区（宿主数据）。终端与文件读取仍按 `terminal` / `file:read` 授权；FR-6.2 的"写入按权限"第一次在管理台变成用户可见能力（编辑器保存），但边界仍是宿主 `workspaceRoot` 写边界（既有，不改）。

---

## 2. 现状核实（只读，行号为当前基线）

### 2.1 平台 Web 三个入口怎么来的

- `projectRowActions`（`app.js:306-308`）：`打开` + `selfGrantEntry` + `detailEntry` + `orcaWebEntry`，工作台与「我的项目」共用同一 builder。
- `detailEntry`（310-318）：管理员可见，**`<a href=sessionPageUrl target=_blank>`**；主机离线/维护/无会话页地址时置灰。无弹框。
- `orcaWebEntry`（331-341）：有 `open` 才渲染；按钮点击新标签开 handoff。
- `openProjectWorkspace`（441-448）：`POST /v1/projects/:id/web-handoff` → `window.open(url,'_blank')`；没有 `surface` 参数、没有同页装配。
- 现有 `dialog()`（1635-1659）与 `.kv` 样式（`styles.css:158-172`）：详情弹框可直接复用；但无 Escape/焦点回收（本令顺手补齐，见 §3.5）。

### 2.2 宿主侧（cloud-admin）已有的 W5a/W5b 管线

- `CloudProjectWorkspace`（`cloud-project-workspace.tsx:72-296`）：`status.get` 探活；`subscribe` 有则挂终端（lazy xterm 分块 + 错误边界），无则挂只读文件面板；权限降级用 `opened.permissions`（114-115）。
- `CloudTerminalPanel`（`cloud-terminal-panel.tsx:77-424`）：xterm + FitAddon + WebGL（116-135）、`terminal.create/send/updateViewport/close` + `terminal.subscribe`、断流重连（53、284-302）、**每次挂载建一个 PTY、卸载即 close**（103-171、357-370）。
- `CloudFilePanel`（`cloud-file-panel.tsx:135-247`）：目录逐层浏览（`browseCloudDirectory`）+ `previewCloudFile` 只读预览；图片/二进制按"不提供预览"呈现（108-124）。
- `cloud-browser-bridge`（`cloud-browser-bridge.ts:73-341`）：浏览器安全桥；`openWorkspace`（262-286）复用 `openCloudWorkspaceOverRpc` 幂等 ensure；`rpc`（305-322）；`subscribe`（324-327）走 W5c 子票重签。
- 手入口（`src/cloud-admin/main.tsx:13-32`）：`?api=` → bridge → `CloudApp`；终端 WebGL prime 已就位（37-39）。

### 2.3 宿主 RPC 可用性（如实核对 `CLOUD_HOST_METHODS`，纠正任务描述）

- **没有**名为 `CLOUD_HOST_METHODS` 的云方法白名单常量；实际是 `CLOUD_HOST_METHODS = [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS, ...PROJECT_PROVISION_METHODS, ...WORKSPACE_INFO_METHODS]`（`src/main/startup/cloud-runtime-admission.ts:340-345`）。它决定"方法在不在表里"；**放行与否由权限表 + 路径守卫决定**。
- 权限表：`cloudMethodAccess`（`src/main/cloud-platform/cloud-rpc-permission.ts:102-134`）
  - `SESSION_METHODS`：`status.get`、`workspace.info`（13 行）
  - 读：`files.read/readDir/readChunk/stat/readPreview/readDocPreview/pathsExist/...` → `file:read`（24-48）
  - 写：`files.write/writeBase64/createFile/createDir/rename/copy/delete/commitUpload` → `file:write`（50-61）
  - `terminal.*`/`git.*` → `terminal`；`agent.*` → `agent`；`repo.add`/`project.provision` → `open`
- 路径守卫（`cloud-path-guard.ts`）：
  - `files.browseServerDir`、`files.readTerminalArtifact*`、`files.writeTerminalArtifact`、`files.resolveTerminalPath` 在 **`CLOUD_FILE_UNBOUNDED_METHODS` → `path_unbounded` 拒绝**（`cloud-file-path-params.ts:56-62`、`cloud-path-guard.ts:150-156`）。
  - 其余 `files.*` 必须声明路径参数（`CLOUD_FILE_PATH_PARAMS`，22-48），未声明的新方法一律 `path_unverifiable` 拒绝（161-172）。绝对路径拒绝（216-221）；读边界=projectRoot，写边界=workspaceRoot（`checkCloudTargetScope`，202-207）。
  - **结论（F9 裁定不变）**：worktree 内相对路径的 `files.read` / `files.write` / `files.readPreview` / `files.readDir` **在云会话可用**；`browseServerDir` 继续拒绝。`workspace.info` 为 session 级只读自省（`src/shared/cloud-workspace-info.ts`），可用于展示分支/permissions。
- 关键耦合（必须如实写进 UI 降级）：`workspacePath` 来自 `openWorkspace` 的 ensure（`project.provision` + `worktree.list` + `worktree.createManaged` → 全需 `terminal`/`open`；W5b-2 已实证 viewer 无 `terminal` 时 `workspacePath` 为空）。因此**文件树实际依赖 terminal 权限**，`file:read` 只决定读得到读不到。

### 2.4 平台 API 数据面（详情弹框的来源）

`projectView`（`server.ts:804-830`）现返回：`id/key/name/repoUrl/hostId/hostName/hostStatus/sessionPageUrl/browserEntryUrl/hostMaintenanceReason?/path/defaultBranch/downloadPolicy/downloadPolicyExplicit/status/provisioningError?/createdAt/permissions`。
`Project` 里还有 `createdBy`（`store.ts:78-79`），**未下发**。
既有只读端点：`GET /v1/projects/:id`（`server.ts:1861`）、`GET /v1/projects/:id/grants`（1955，管理员/项目 owner）、`GET /v1/policies/download`（2139）。
handoff：`POST /v1/projects/:id/web-handoff`（1951 → 3048）签发 60s 一次性码；`POST /v1/web/handoff`（1241-1331）换正式会话；URL 选择"浏览器边缘优先、否则宿主 TLS 直连"（3087-3101、3123-3129）。**这已经是同页工作区需要的全部认证语义。**

---

## 3. 详情弹框设计

### 3.1 入口与可见性

- 入口：`projectRowActions` 里的「详情」从 `<a target=_blank>` 改为 `<button data-detail="<id>">`。**仍仅管理员**（现状语义不变；是否放开给 open 持有者是开放问题 Q1）。
- **不再因主机离线/维护置灰**：弹框只读平台数据，离线恰是查看"宿主在线=离线"的场景。`detailDisabledReason` 删除；只保留"无 open / 无会话页地址"不影响弹框。
- 弹框内提供主按钮「打开项目」（走 §4 的内嵌流程；离线/维护/无 open 时用**同一条** `openDisabledReason` 置灰并给 title），次按钮「关闭」；管理员另有一行「在独立页打开会话页」`<a href=sessionPageUrl target=_blank>`（保留旧入口作为逃生通道）。

### 3.2 字段清单与来源映射（零新增端点）

| 区块 | 字段 | 来源 | 展示规则 |
| --- | --- | --- | --- |
| 基本信息 | 项目名称 | `projectView.name` | 文本 |
| | 项目 Key | `projectView.key` | mono |
| | 项目 ID | `projectView.id` | mono，可复制 |
| | 创建者 | **`projectView.createdBy`（本次唯一增量字段）** | 文本；`null/缺省`→「未记录」；仅 admin/auditor 下发 |
| | 创建时间 | `projectView.createdAt` | 绝对时间 + 相对时间（复用 `relative()`） |
| | 项目状态 | `projectView.status` | 徽标：准备中/就绪/准备失败/已归档 |
| | 准备失败原因 | `projectView.provisioningError` | mono，仅 `failed` 时显示 |
| 运行配置 | 主机 | `hostName` + `hostId` | 主机名 + mono id |
| | 宿主状态 | `hostStatus` + `hostMaintenanceReason` | 在线/离线/维护中（+原因） |
| | 项目路径 | `projectView.path` | mono，可复制 |
| | 仓库地址 | `projectView.repoUrl` | mono；空→「未配置仓库」 |
| | 默认分支 | `projectView.defaultBranch` | mono |
| 授权与策略 | 我的权限 | `projectView.permissions` | 权限徽标；管理员空集→「管理员可见（未授权）」，复用 `permissionSummary` 语义（`app.js:241-249`） |
| | 直接授权概要 | `GET /v1/projects/:id/grants`（既有，管理员） | 主体（用户名/组 id）+ 权限数量；空→「无直接授权」；**不改端点、不显示继承来源**（端点不返回） |
| | 下载策略 | `downloadPolicy` + `downloadPolicyExplicit` + `GET /v1/policies/download` | 生效值 + 来源（项目覆盖 / 跟随全局），复用 `effectiveDownloadPolicy`（`app.js:171-173`） |
| | 会话页 | `sessionPageUrl` | 管理员「在独立页打开」链接（空则不显示） |

不展示：`browserEntryUrl`（内部路由）、完整 ACL 矩阵（在「成员与权限」页）、宿主延迟（弹框不连宿主）。**弹框不触发任何宿主 RPC**。

**无新增端点论证**：信息本身来自已加载的 `state.projects` 行（工作台/我的项目每次渲染都刷新）；打开时先渲染缓存行（零等待），再做**一次** `GET /v1/projects/:id` 刷新字段（失败保留缓存 + 一行「未能刷新」）；管理员额外一次 `GET /grants`；策略弹框按需一次 `GET /v1/policies/download`。唯一平台改动是 `projectView` 增 `createdBy`（wire-additive 可选字段；旧前端忽略、旧平台缺省）。

### 3.3 布局

- 复用 `dialog(title, html, actions)`；加 `.dialog.wide`（720px）+ `.detail-sections` 两列网格（≤760px 单列），每区块一个 `h3` 小标题 + `.kv` 行组（`styles.css:158-172`）。
- 只读：无输入控件；mono 值可双击选中；长路径 `word-break: break-all`（`.kv dd` 已有）。
- 状态色只出现在状态徽标（在线/离线/维护/失败），其余走中性色。

### 3.4 交互与状态

- 打开：立即渲染缓存 → 后台刷新（`GET` 1 次）；`provisioning/failed` 的 `provisioningError` 用 mono 行内展示。
- 关闭：Escape / 点击遮罩 / 关闭按钮；焦点回到触发按钮。
- 弹框内「打开项目」：关闭弹框 → 触发 §4 流程；失败沿用 §4.5 的错误呈现。
- 数据过期：刷新失败不阻塞，不把旧值伪装成新值（保留「未能刷新」提示）。

### 3.5 共享 dialog 的无障碍补齐（顺带、影响所有弹框）

现有 `dialog()` 无 Escape、无焦点回收。本令给 `dialog()` 增加：Escape 关闭、打开时聚焦第一个可聚焦元素（无则关闭按钮）、关闭后焦点回到 opener、`aria-labelledby`。现有调用方零参数变化，回归由既有 e2e 覆盖。

### 3.6 e2e 断言（平台 Web，happy-dom）

1. `W46-D1` 管理员行有「详情」按钮（非 `<a>`）；点击后 `role=dialog` 出现；**零写请求、零 window.open**；恰好 1×`GET /v1/projects/:id`。
2. `W46-D2` 六个创建字段与补充字段逐字段等于 payload（name/key/hostId/path/repoUrl/defaultBranch/status/provisioningError/createdAt/hostStatus/permissions）。
3. `W46-D3` 非管理员行无「详情」；离线/维护行的「详情」**可点**（弹框打开），弹框内「打开项目」disabled 且 title 与行内「打开」一致。
4. `W46-D4` `createdBy`：管理员的 payload 含该键；开发者/无权限者 payload 不含（新增 platform 断言）。
5. `W46-D5` 弹框内「打开项目」→ 关闭弹框 + 1×`POST /web-handoff`（body 含 `surface:'admin'`）+ 覆盖层出现。
6. `W46-D6` Escape 关闭、焦点回到「详情」按钮。

---

## 4. 简易工作区设计

### 4.1 架构选型：A（app.js 内嵌视图）vs B（cloud-admin iframe / 组件嵌入）

| 维度 | A · app.js 内嵌工作区视图 | B · 宿主伺服 `cloud-admin.html` iframe（**采纳**） |
| --- | --- | --- |
| 浏览器可达性 | **不可行**：跨网段必须经中继浏览器边缘；WSS 前缀由页面路径 `/h/<routeKey>/` 推导（`web-path-prefix.ts:16,42-57`），平台源页面没有该前缀；票据 relay 端点是 SNI 形态（`server.ts:726-735`），浏览器拨不了。需自建第二条传输路径 | 页面本身就是宿主/中继边缘，前缀推导、直连与中继两种形态、W5c 子票重签全部原样生效 |
| 客户端代码 | 需把 `src/renderer/src/web`（E2EE、设备密钥、WebRuntimeClient、票据换发）打进平台 Web 包 → 第二套浏览器客户端 | 复用现有 `cloud-browser-bridge`，平台包零增长 |
| UI 复用 | app.js 是 vanilla；终端 WebGL / xterm / 文件面板 / 诊断对话框都要重写 | `CloudTerminalPanel`、`CloudFilePanel`、`CloudConnectionDiagnosticsDialog`、主机键/连接失败对话框直接复用 |
| 多标签与编辑器宿主 | 控制台 state 里再写一套标签状态机；工作区随控制台重渲染 | React 工作区内部 reducer；iframe 文档与控制台路由互不干扰 |
| 状态隔离 | 与控制台共享全局 state，切换路由易误伤 | 独立文档、独立 session/localStorage；关闭需显式握手 |
| 与工作台路由共存 | 需要给控制台加路由/挡住导航 | 控制台用覆盖层；iframe 用 `?embed=1` 只渲染工作区，工作台视图不进入 iframe |
| 代价 | 传输/客户端重复，且中继场景做不到 | 跨文档 postMessage 协议；iframe 生命周期收尾；宿主 bundle 版本落差 |

**否决的备选**：
- A1 在 app.js 里重写一个云客户端：重复 + 中继不可达（上表）。
- A2 把 React 工作区作为 island 编进平台包：仍是第二套客户端，且平台 Web 独立发布（M78/AC-19），等于把 Orca 运行时版本化两次。
- C 维持新标签打开独立页：不满足"同页面"。
- D 平台做 RPC 代理的后端渲染：违反 D1（平台不进数据路径）与 E2EE 边界。
- E 在覆盖层里嵌完整 `web-index.html`（orca web）：与"简易工作区"和"Orca Web 是另一入口"冲突。

**"内嵌"的准确边界（如实声明）**：工作区的**文档**来自宿主（这是 W5a 管线的运行前提），控制台用覆盖层把它装进当前页；用户感知为同页、同一浏览器、无新标签、无二次登录。不是"把 React 组件编译进 app.js"。

### 4.2 同页装配与生命周期

```
控制台「打开」
  → POST /v1/projects/:id/web-handoff { surface:'admin' }        （既有端点，可选字段）
  → 201 { url: https://<宿主或中继>/…/cloud-admin.html?api=<平台>&embed=1&project=<id>#handoff=<code>&project=<id>, surface:'admin' }
  → 覆盖层：#workspaceOverlay + <iframe src=url title="项目工作区">
       iframe 内：readWebCloudHandoffEntry() → 清 hash → redeemWebHandoff()
                 → 持久化会话 → 自动 openProject(id) → 简易工作区
                 → postMessage {source:'orca-cloud-admin', type:'ready', route, latencyMs}
  → 控制台顶栏显示项目/分支/线路；收不到 ready（20s）→ 失败态 + 「重试 / 在新标签打开 Orca Web」
```

- **覆盖层**：`position: fixed; inset: 0; z-index: 45`（低于 dialog 50），顶栏 40px（`#fafafa`，对齐 P3 平台条），iframe 撑满剩余高度，`border:0`。控制台侧栏/顶栏被覆盖，避免误导航销毁工作区。
- **顶栏内容**：← 返回、项目名 · 默认分支（来自行数据）、线路徽标 + 延迟（来自 ready 消息）、主机名、右侧「在新标签打开 Orca Web」与「关闭」。
- **关闭握手**：控制台先 `postMessage({type:'close'})` → iframe 调 `session.closeProject(id)`（关闭 PTY/套接字）→ 回 `{type:'closed'}` → 控制台移除 iframe；300ms 未回则强制移除。**dirty 文件**：iframe 持续上报 `{type:'dirty', count}`；>0 时控制台先弹确认框。
- **登出**：控制台登出时先移除覆盖层并 `postMessage({type:'logout'})`（iframe 调 `bridge.logout()`），再走控制台登出；平台侧会话吊销仍是权威。
- **刷新**：控制台刷新丢失覆盖层（控制台本来无 URL 路由）；iframe 自身刷新因 hash 已清 + 会话已持久化，凭 `?embed=1&project=<id>` 恢复并自动打开（§4.4）。
- **安全**：iframe 收 `event.origin === new URL(adminUrl).origin && event.source === iframe.contentWindow`；iframe → 父用 `postMessage(msg, '*')`，消息里只有路由/延迟/dirty 计数，无令牌无路径。控制台**不把 url 写入日志**。
- **不做**：不改宿主静态资源头（当前无 `X-Frame-Options`，允许被嵌）。点击劫持面记入开放问题 Q4。

### 4.3 布局（P3 对齐 + 差异声明）

```
┌ 控制台覆盖层顶栏 40px：← 项目 · 分支 | 直连/中继 18ms | 主机 | 新标签打开 / 关闭 ┐
│ ┌ 左 240px ──────┬ 中（自适应）──────────────────┬ 右 300px ─────────┐ │
│ │ 工作区          │ 标签条：Terminal 1 | a.ts | 图 │ 文件               │ │
│ │ feat/refund 当前 │ ───────────────────────────── │ ~/payment-service  │ │
│ │ ~/.orca-worktrees│ 激活标签内容                   │ ▾ src              │ │
│ │ 我的权限徽标     │ （终端 / 编辑器 / 预览）        │   calculator.ts    │ │
│ │ 连接诊断         │                               │   …                │ │
│ │ 状态栏：E2EE · 分支 · 路径 · ●未保存            │                    │ │
└───────────────────┴───────────────────────────────┴────────────────────┘
```

- **左 240px = 工作区上下文**。P3 的 WORKSPACES 列表在多工作区桌面语义下成立；云会话的票据只签一个检出（`workspaceRoot` 内本用户 checkout），列出队友检出既越权诱导又不属于本令。忠实的最小解：一行「当前工作区」（分支来自 `workspace.info`，路径来自 `opened.workspacePath`）+ 项目/主机/线路 + 我的权限徽标 + 连接诊断。**差异如实记录**：没有「+ 新建工作区」。
- **中 = 多标签内容区**（§4.4）。
- **右 300px = 文件树**（§4.6），顶部「文件 / 刷新 / 路径」，点击文件 → 中间新增/激活标签。
- 视觉：iframe 内走 Orca 设计系统（`docs/STYLEGUIDE.md`、`components/ui/*`、`cn()`、`scrollbar-sleek`）；控制台覆盖层与详情弹框走平台原型的 token（`styles.css`）。两套不混用。

### 4.4 多标签架构

状态（React reducer，位于简易工作区组件内）：

```ts
type WorkspaceTab =
  | { id: string; kind: 'terminal'; title: string }                 // Terminal 1..N
  | { id: string; kind: 'file'; path: string; title: string; mode: 'source' | 'preview' | 'image' | 'binary' }

type WorkspaceState = {
  tabs: WorkspaceTab[]
  activeId: string | null
  buffers: Record<string, FileBuffer>   // 按 tab id；切走不丢
}
type FileBuffer = {
  path: string
  content: string; baseContent: string
  state: 'loading' | 'ready' | 'error'
  truncated: boolean; readOnly: boolean
  saving: boolean; errorCode?: string
}
```

规则：
- **打开文件**：同路径已开 → 只激活，不新增；否则新增 `file` 标签并激活。
- **新建终端**：`+ 终端` → `Terminal N`（N 取未用最小序号）；上限 6（每终端一条子套接字；`MAX_SOCKETS_PER_DEVICE_SESSION=12`，`cloud-session-limits.ts:40`），超限 toast。
- **激活**：标签点击/键盘；终端面板**保持挂载**（不被卸载），非激活用 `hidden` + `active=false` 抑制 fit/viewport（见 §4.5）。
- **关闭**：终端标签 = 卸载面板（→ `terminal.close`），无确认，tooltip 说明「关闭将结束该终端会话」；文件标签 dirty → 自定义确认（保存/放弃/取消）；关闭激活标签后优先激活右邻，无则左邻；最后一个标签关闭 → 空态「从右侧文件树打开文件，或新建终端」。
- **标签条**：横向滚动、关闭按钮、dirty 圆点、文件图标/终端图标；不做拖拽排序、不做分屏（P3 的分屏按钮不进简易版）。
- **状态隔离**：标签与缓冲区只属于当前工作区；关闭覆盖层即整体销毁。不跨项目保留（同一项目重进从空标签开始）。

### 4.5 终端标签（W5a 管线复用）

- 每个终端标签 = 一个 `CloudTerminalPanel`，`rpc`/`subscribe` 由 `CloudApp` 注入（与今日管理台页相同）。PTY 创建/订阅/重连/关闭全部沿用 W5a/W5c。
- **必要的小改动（向后兼容）**：`CloudTerminalPanel` 增两个可选 props：`title`（默认 `'cloud-admin'`，`terminal.create` 的 title 字段）与 `active`（默认 `true`）。`active=false` 时跳过 `fit()` 与 `updateViewport`（避免 `display:none` 下 fit 出 0 列把 PTY 尺寸打坏），激活时补一次 fit + viewport；沿用现有 ResizeObserver（`cloud-terminal-panel.tsx:137-161`）。xterm 的 WebGL 上下文丢失已有回落（116-135）。
- 降级：无 `terminal` → 不渲染「+ 终端」，中央空态写明「当前项目未授予终端权限」；`terminal.create` 被拒时标签内呈现错误码（不崩、不弹窗）。

### 4.6 文件树（右侧）

- 数据：`browseCloudDirectory(rpc, workspacePath, relativePath)`（`shared/cloud-file-browser.ts:103-129`），逐目录懒加载；`sortCloudEntries` 目录优先、忽略 `.git`（78-91 已实现）。
- 节点状态按相对路径缓存：`{expanded, loading, children?, error?}`；「刷新」清缓存并重拉根；目录箭头展开/折叠；错误行显示 `failureText`（forbidden → 「无权访问该路径」）。
- 文件点击 → `openFile(path)`；不做重命名/删除/下载/上传（§9）。
- 不可用态：无 `file:read` → 面板占位「当前项目未授予文件读取权限」；无 `workspacePath`（通常=无 `terminal`）→ 「工作区尚未创建，无法打开文件面板」（沿用 W5b-2 文案，`cloud-project-workspace.tsx:234-239`）。
- 可选（本令不做）：`files.watch` 自动刷新——云会话已允许，但推送合并与失效策略另立。

### 4.7 文件编辑（读写 RPC 与安全边界）

- **打开（文本）**：`files.read({worktree: 'path:<workspacePath>', relativePath})` → `{content, truncated, byteLength}`。
  - `truncated=true`（>512KB，`MOBILE_FILE_READ_MAX_BYTES`）→ **只读**，提示「文件过大（已截断），简易工作区不支持编辑」——**绝不把截断内容写回**（防损坏）。
  - `binary_file` 错误 → 自动走预览路径（§4.8）。
- **保存**：`files.write({worktree, relativePath, content})`。前置：
  1. `file:write` 不在 `opened.permissions` → 只读（无保存按钮 + 徽标「只读」）。
  2. 保存前**再读一次**并和 `baseContent` 比对；不一致 → 自定义冲突框（重新加载 / 覆盖保存 / 取消）。平台无乐观锁/ETag（`files-mutation-params.ts:24-28` 只有 content），这一步是防静默覆盖的最小成本。
  3. 保存中禁用按钮；成功后 `baseContent=content`；失败行内显示错误码（`path_denied`/`permission`/`file_too_large` 等）。
- **快捷键**：Cmd/Ctrl+S 保存（平台判定，非硬编码 metaKey，遵循跨平台规则）；不使用浏览器原生 `confirm`。
- **编辑器形态**：`components/ui/textarea.tsx` 的 `Textarea`（mono、`editor-surface`、`scrollbar-sleek`）+ 行号列可选；**不做**语法高亮/monaco（简易版）。Tab 保留浏览器默认焦点语义（不做自绘缩进）。
- **边界**：路径始终相对 `workspacePath`，绝对路径/`..` 由宿主 `cloud-path-guard` 拒绝；前端只做 `cloudChildPath` 名称拼接（拒绝 `/`、`\`、`.`、`..`）。
- 类型断言/编码风险：非 UTF-8 文本按 UTF-8 解码可能丢字节（宿主 `files.read` 行为）；本令如实记录为已知限制，不做转码（§8 R6）。

### 4.8 预览（设计图 / HTML / 二进制）

| 类型 | 判定 | 渲染 | 安全 |
| --- | --- | --- | --- |
| 图片（png/jpg/jpeg/gif/webp/bmp/ico/svg） | 扩展名白名单 → `previewCloudFile` → `isImage && mimeType` | `<img src="data:<mime>;base64,<content>">`，自适应容器，加载失败占位 | data URL + img 上下文，不执行脚本 |
| HTML | 扩展名 `.html/.htm` → `files.read` 取文本 | `mode='preview'`：`<iframe sandbox="" referrerPolicy="no-referrer" srcDoc={content}>`（**无 allow-scripts / allow-same-origin**）；`mode='source'`：编辑器/只读源码 | 相对资源不解析（文档级预览，不是本地 dev server 预览）；脚本不执行 |
| PDF | `previewCloudFile` → `mimeType==='application/pdf'` | 占位「PDF 预览不在简易版范围」+ 文件大小 | 不嵌入外部查看器 |
| 其他二进制 | `isBinary` | 占位 + mime + 大小 | — |
| 超大 | 宿主 `file_too_large` / 读配额错误 | 行内错误码，不伪装空内容 | — |

- 预览与编辑共用**一次读取**：HTML 用 `files.read` 的文本同时喂源码与 srcdoc；图片用 `files.readPreview`。不新增 RPC。
- 读配额：平台默认 600 次/64MB 每项目每小时（`store.ts:156`），大图会消耗预算；错误如实呈现（§8 R7）。

### 4.9 权限语义与降级矩阵

| 票据权限 | 「打开」入口 | 终端标签 | 文件树 | 读取/预览 | 保存 | 呈现 |
| --- | --- | --- | --- | --- | --- | --- |
| `open` | ✔（宿主在线） | ✘ | ✘ | ✘ | ✘ | **无法进入工作区**：`openWorkspace` 的 ensure（`worktree.list/createManaged` 需 `terminal`）失败 → iframe 显示明确降级页「当前项目未授予终端权限，无法创建工作区」+ 错误码，不是空白/死循环 |
| +`terminal` | ✔ | ✔ | ✔（checkout 已 ensure） | 由 `file:read` 决定 | 由 `file:write` 决定 | |
| +`file:read` | ✔ | ✔ | ✔ | ✔ | ✘ | 只读标签 + 「只读」徽标 |
| +`file:write` | ✔ | ✔ | ✔ | ✔ | ✔ | 编辑器可保存 |
| `agent` / `browser` / `download` | 不呈现（简易版不含 Agent 标签、localhost 浏览器预览、下载） | | | | | |

- **如实核对（既有语义，不改）**：`use-cloud-session.openProject` 调用的是 `bridge.openWorkspace`（`use-cloud-session.ts:262`），而 ensure 需要 `terminal`；因此 `open+file:read`（W5b-2 的 viewer）在真实 UI 路径上会停在 ensure 失败，W5b-2 里渲染出的"无授权占位"是直接调 bridge `openProject`（只 connect）才可见的状态。本令**不改变**这条桥语义，只要求内嵌模式把 ensure 失败呈现成明确的权限降级页（复用 W5b 文案），并保留「在独立页打开」退路。
- 无 `open`：控制台行内「打开」沿用 `openDisabledReason` 置灰；管理员走既有「授权并打开」。自授后进入**内嵌**工作区（不再新标签）。
- 任意 RPC 被拒：标签/面板内联错误，不崩、不弹系统框；拒绝由宿主写 `method_denied`/`path_denied` 审计（既有）。
- 宿主键变更/连接失败：复用 `CloudHostKeyDialog` / `CloudConnectFailureDialog`（`cloud-app.tsx:64-87`）；`embed` 模式下也必须渲染（不能只挂在 workbench 分支）。

### 4.10 与现有「打开」handoff 的替换边界

| 入口 | 现状 | U46 后 |
| --- | --- | --- |
| 「打开」 | `POST /web-handoff` → `window.open` orca web | `POST /web-handoff { surface:'admin' }` → 同页覆盖层；平台不支持时回落 `window.open` |
| 「授权并打开」 | PUT grants → `POST /web-handoff` → `window.open` | PUT grants → 同内嵌流程 |
| 「Orca Web」 | `POST /web-handoff` → `window.open` | **逐字节不变** |
| 「详情」 | 新标签 `cloud-admin.html` | 弹框；独立页保留为弹框内次要链接 |

- 旧平台（无 `surface`）+ 新控制台：响应 URL 仍是 `web-index.html` → 控制台识别路径并**回落** `window.open` + toast「当前平台版本不支持内嵌工作区，已在新标签打开」。新平台 + 旧控制台：不传 `surface`，行为不变。旧宿主 bundle + 新控制台：iframe 里是旧版 `cloud-admin.html`（工作台视图、可能要求登录）→ 20s 无 ready → 失败态 + 「在新标签打开 Orca Web」。三向都有人工/自动退路。
- 内嵌流程的入口前置检查（`surface=admin` 时）：`provisioning` → 409 `PROJECT_PROVISIONING`、`failed` → 409 `PROJECT_NOT_PREPARED`，控制台直接给原因而不是进一个空 iframe。`web` surface 的既有行为不动（最小回归面）。

---

## 5. 平台侧契约与兼容性

### 5.1 增量一：`POST /v1/projects/:id/web-handoff` 可选 `surface`

- 请求体新增可选 `surface: 'web' | 'admin'`（缺省 `web`）；旧平台忽略未知字段，旧控制台不发送 → 双向兼容。
- `admin`：URL 选择与 `handleWebHandoff` 相同的"浏览器边缘优先、否则宿主 TLS 直连"（3087-3101、3123-3129），页面换成 `cloud-admin.html`（`browserEntryUrl.replace(/web-index\.html$/, 'cloud-admin.html')`），query 追加 `embed=1&project=<id>`，hash 仍为 `#handoff=<code>&project=<id>`。
- 响应增可选 `surface`（旧平台缺省 → 控制台按 URL 路径判定）。审计 `web_handoff` metadata 增 `surface`（区分内嵌进入与 orca web 进入）。TTL/一次性/权限/主机门禁/指纹全部不变。
- 失败面：`open` 权限、宿主不存在/吊销/维护/离线、无可用页面地址 → 既有错误码原样；新增 `PROJECT_PROVISIONING`/`PROJECT_NOT_PREPARED` 仅 admin surface。

### 5.2 增量二：`projectView.createdBy`

- 仅 admin/auditor 下发（`isAdmin(user) || roles.includes('platform:auditor')`），其余角色 payload 不变；`null` 允许（旧项目/自助项目可能未记录）。这是本令唯一的 `projectView` 字段变更，wire-additive。

### 5.3 兼容矩阵

| 平台 API | 控制台 Web | 宿主 bundle(`cloud-admin`) | 结果 |
| --- | --- | --- | --- |
| 新 | 新 | 新 | 同页工作区全功能 |
| 旧 | 新 | 新 | handoff 不含 `surface` → 控制台识别 `web-index.html` → 新标签打开（旧行为） |
| 新 | 旧 | 任意 | 旧控制台不发 `surface` → 行为不变 |
| 新 | 新 | 旧 | iframe 为旧管理台页 → 20s 失败态 → 「在新标签打开 Orca Web」 |
| 任意 | 新 | 旧/新 | 详情弹框只读平台数据 → 始终可用（`createdBy` 缺省显示「未记录」） |

---

## 6. 测试设计与 e2e 断言清单

### 6.1 分层

| 层 | 内容 | 形态 |
| --- | --- | --- |
| 平台 Web（控制台） | 详情弹框字段/状态/无写请求；打开→覆盖层/iframe/postMessage/回落；旧平台回落；退出与登出；自授后内嵌 | `cloud-platform/test/e2e/*.e2e.test.ts` + `web-console-page.ts`（happy-dom） |
| 平台 API | `surface=admin` 的 URL/状态前置/审计；`createdBy` 角色可见性；旧 surface 回归 | `cloud-platform/test/e2e/web-handoff*.test.ts`、`web-project-entry`（真实平台进程） |
| 云管理台桥 | handoff 解析（先清 hash 再兑换）、持久化、自动打开、失败回落登录表单、恢复路径 | renderer vitest（scripted fetch + 真实平台） |
| 工作区组件 | 标签状态机、终端的挂载/fit 守卫/关闭、文件树懒加载、编辑器脏/保存/冲突/截断、预览安全属性、权限矩阵 | React 组件测试 |
| 真栈 e2e | 真平台 + 真 TLS 宿主 + 真 PTY：读取/保存/预览/越权/重放/无终端 viewer | `src/renderer/src/cloud-admin/*.e2e.test.ts`（node 池，复用 `cloud-session-e2e-harness`） |
| 真浏览器验收 | 控制台登录 → 打开 → iframe 工作区 → 终端回显 → 文件编辑保存 → 图片/HTML 预览 → 返回；隐藏渲染 + CDP 截图 | Playwright（headless/隐藏，禁用 `show()`/focus，遵 AGENTS.md） |

### 6.2 具体断言（编号即验收项）

- 平台 Web：`W46-D1..D6`（§3.6）、`W46-O1` 点「打开」恰 1×`POST /web-handoff`（body `surface:'admin'`）→ 覆盖层出现、iframe `src` 等于响应 URL、零 `window.open`、零 `/connect`；`W46-O2` 签发失败 → 原因 + 「在新标签打开 Orca Web」→ 第二次 POST 无 `surface` + 恰 1 次 `window.open`；`W46-O3` 旧平台 stub 返回 `web-index.html` → 回落新标签；`W46-O4` 返回 → 覆盖层移除、底层路由内容不变、无重复请求；`W46-O5` 登出/宿主离线 → 覆盖层移除或入口置灰。
- 桥：`C1` hash 在兑换前清除；`C2` 兑换成功 → 持久化 → 自动打开 → 内嵌工作区；`C3` 410/403/网络 → 登录表单 + notice；`C4` 重载（`?embed=1&project`）+ 已存会话 → 自动打开且不兑换；`C5` 无 handoff → 原有独立页行为逐字节不变。
- 工作区：`T1` 标签去重/切换/关闭邻接/空态；`T2` 终端只建一次、切走不卸载重建、隐藏不推 0 尺寸 viewport、关闭调 `terminal.close`、上限；`T3` 文件树每次展开恰 1×`files.readDir`、缓存/刷新、`.git` 隐藏、错误行；`T4` 编辑器读取/脏/保存（内容逐字）/截断只读/二进制转预览/冲突框/无 `file:write` 只读；`T5` 图片 data URL、HTML `sandbox=""`（断言无 `allow-scripts`）、PDF/二进制占位、`file_too_large`；`T6` 权限矩阵四行。
- 真栈：`E1` `surface=admin` URL 形态与 `web` 不同、审计带 surface；`E2` 兑换→打开→读取→保存→再读回新内容（写边界内）；`E3` 图片 fixture 返回 base64+mime、HTML fixture 返回文本；`E4` workspace 外写入 `path_denied` + 审计（回归）；`E5` viewer（`open+file:read`）无 `workspacePath`、终端拒绝带审计；`E6` 重放/过期 410、无 `open` 403；`E7` 关闭覆盖层后宿主 PTY/套接字回收（审计或会话计数）。
- 验收门槛：以上全绿 + `pnpm tc`/`pnpm test`（含 node 真栈池）+ `check:code-quality:changed` + 证据目录 `cloud-platform/evidence/u46-three-actions/`（JSON 时间线 + 截图 + 回归日志）。真浏览器验收必须隐藏运行、不得抢焦点。

---

## 7. 实施切分（每令 ≤20 分钟，域不相交）

| 令 | 域（文件所有权） | 内容 | 依赖 |
| --- | --- | --- | --- |
| U46-1 | 平台 API：`cloud-platform/apps/api/src/server.ts` + 其测试 | `createdBy`（admin/auditor）、`surface:'admin'`（URL/前置状态/审计/响应字段）、兼容测试 | — |
| U46-2 | 平台 Web：`apps/web/app.js` + `styles.css`（通道③独占） | 详情弹框（字段/刷新/弹框内打开/独立页链接）+ `dialog()` 无障碍 + D1–D6 | 1 |
| U46-3 | 同上（同通道，串行） | 「打开」→ 覆盖层/iframe/postMessage/失败回落 + O1–O5 | 2 |
| U46-4 | 云管理台入口/桥：`cloud-admin/main.tsx`、`cloud-browser-bridge.ts`、`cloud-app.tsx`、`use-cloud-session.ts` + web 测试 | handoff 入口、`loginWithHandoff`、`embed` 模式、自动打开、ready/dirty/close/logout 消息 + C1–C5 | 1（URL 形态） |
| U46-5a | 工作区新文件：`cloud-simple-workspace*` | 外壳 + 标签 reducer + 左栏 + 状态栏 + 空态 + T1 | 4 |
| U46-5b | `cloud-terminal-panel.tsx` + 新文件 | 终端标签（title/active/fit 守卫）+ T2 | 5a |
| U46-6 | 工作区新文件：`cloud-workspace-file-tree.tsx` | 懒加载文件树 + T3 | 5a |
| U46-7 | 工作区新文件：`cloud-workspace-file-tab.tsx` + 预览组件 | 编辑器/缓冲区/冲突/预览 + T4/T5/T6 | 5a |
| U46-8 | 测试工程（只测试/证据） | 真栈 E1–E7 + 真浏览器旅程 + 回归矩阵 + 证据 | 1–7 |

规则：1 与 2/3 与 4–7 的域不相交可并行；2/3 同属 `app.js` 必须串行；6/7 文件不相交可并行；任何安全路径改动与测试分提交；提交前核对暂存集。

---

## 8. 风险与开放问题

### 风险

| # | 风险 | 缓解 |
| --- | --- | --- |
| R1 | iframe 内的 PTY/套接字在覆盖层被移除时未必走 React 卸载清理 | 关闭握手（`close`→`closeProject`→`closed`，300ms 兜底）+ E7 回收断言 |
| R2 | 60s handoff 码 vs 冷缓存 iframe 加载慢 | 点击时立即签发并立刻设 `src`；失败态给重试与「在新标签打开」两条路 |
| R3 | 隐藏终端 `fit()` 出 0 列把 PTY 打坏 | `active` prop 抑制 fit/viewport；补组件测试与真栈回显 |
| R4 | 保存静默覆盖他人修改（无 ETag） | 保存前重读比对 + 冲突框（重新加载/覆盖/取消） |
| R5 | 截断文本写回损坏文件 | `truncated` → 强制只读，无保存入口 |
| R6 | 非 UTF-8 文本按 UTF-8 解码丢字节 | 如实记录为简易版限制；不走 `writeBase64`（需二进制读回，当前无对应读方法） |
| R7 | 大图/大量读取吃平台配额（600 次/64MB 每小时） | 宿主错误码如实呈现；不做自动重试风暴 |
| R8 | 多终端内存/GPU 与 12 socket 预算 | 终端标签上限 6；标签条明示 |
| R9 | 旧宿主 bundle 不认 `embed=1` | 20s ready 超时 → 失败态 + 新标签 Orca Web |
| R10 | 控制台登出后 iframe 会话可能仍存活到令牌过期 | 登出先移除覆盖层 + `postMessage(logout)` → `bridge.logout()`；平台吊销仍是权威 |
| R11 | 点击劫持面（宿主静态页当前无 `X-Frame-Options`） | 记入 Q4；若要硬化，用宿主已配置的平台 origin 生成 `frame-ancestors`，不能用可被请求方伪造的 `?api=` 值 |
| R12 | 设计系统门禁（计算 className/原始色） | 全部用 `cn()` + token + `components/ui`；控制台样式只加类不做内联色值 |

### 开放问题（请主会话裁定）

1. **Q1 详情可见性**：维持"仅管理员"（本文默认，现状语义），还是对 `open` 持有者开放（授权概要需降级为"我的权限"）？
2. **Q2 左栏**：单工作区行（本文）是否够？是否要 `worktree.list` 列出队友检出（有 W13 §3.3 已知共享边界，不推荐）。
3. **Q3 文件操作**：右键重命名/删除/复制本令不做；是否另立 UX 令（可用 `files.rename/copy/delete`，写边界已就绪）。
4. **Q4 框架硬化**：是否为 `cloud-admin.html` / `web-index.html` 加 `frame-ancestors`（用宿主已配置的平台 origin），以及是否独立安全评审。
5. **Q5 Agent 标签**：原型 P3 有 Claude 标签；本令按用户清单不含 Agent。是否需要后续以 `agent` 权限点亮。
6. **Q6 HTML 预览**：本文默认脚本全禁（`sandbox=""`）。若产品要"真预览带脚本的页面"，需要另立安全方案（不是本地 dev server 预览）。
7. **Q7 独立页保留**：弹框内的「在独立页打开会话页」是否长期保留（本文保留为逃生通道）。
8. **Q8 `surface` 前置状态检查**：是否也加到 `web` surface（会改变 orca web 的失败时机）。

---

## 9. 不做清单（明确范围外）

- 不改 `cloudMethodAccess`、`CLOUD_FILE_PATH_PARAMS`、`CLOUD_FILE_UNBOUNDED_METHODS`、`CLOUD_HOST_METHODS`；`browseServerDir` 继续拒绝。
- 不做下载/上传/导出、下载审批流；不新增 `files.*` 读二进制方法。
- 不做 Agent/Claude 标签、localhost 浏览器预览、分屏、标签拖拽、文件搜索、Markdown 渲染、语法高亮、多工作区创建。
- 不改 orca web（W13b）与宿主启动链、配对路径、移动端。
- 不把访问令牌放进 URL；iframe URL 的 hash 只带一次性 code（与 W7b 同语义）。
- 不引入第二套浏览器云客户端；不把 Orca 运行时编译进平台 Web 包。


## 10. 主会话审定（2026-11-15）

全盘采纳：①架构 B（iframe 嵌入）——传输可达性（中继边缘 WSS 前缀推导）为硬约束论证成立；②详情字段清单（零新增端点、createdBy 唯一增量、离线不置灰）；③开放问题：Q1=详情保持 admin-only、Q3 文件重命名/删除/复制不做、Q5 Agent 标签不做；④wire-additive 两处（surface:'admin'+createdBy）采纳。派发序：U46-1∥U46-4 并行（URL 形态以本文档契约为界）→U46-2/3（app.js 串行）→U46-5a→5b∥6∥7 并行→U46-8 收口。


## 11. 需求增量（2026-11-15 用户指令，覆盖 §4.3 布局并扩展标签类型）

1. **布局两栏**：左侧栏暂不做（§4.3 的左栏取消）；中间标签区+右侧栏。
2. **右侧栏双 tab 并列**：文件 tab（简单文件树+**文件名过滤查找**）+ git 变更 tab。
3. **git 变更 tab**（新组件）：上下布局——上半=不同状态文件（修改/未跟踪/新增/删除等，按 git status 分组），下半=git 提交记录列表；点击提交记录展开查看对应文件列表；点击文件→中间打开 **diff 标签页**；diff 可切换**左右/合并**模式。（前置核验：git status/log/diff/show 在 CLOUD_HOST_METHODS 宽集合内的可用性与输出形态——派令首步完成）
4. **预览扩展**：常见开发文档——md 渲染预览、代码着色编辑框（Monaco 语法高亮）、设计图 drawio/svg/jpg/png（svg/jpg/png 直接 img/dataURL；drawio 用嵌入查看器或提示降级，如实按可行性）。
5. **标签类型枚举扩为四**：terminal|editor|preview|diff。

覆盖 §4.3/§4.4/§4.6/§4.8 相应部分；其余条款不变。切分调整：U46-6 文件树+过滤；U46-6b git 变更面板（首步核验 git RPC）；U46-7a 编辑器+md+着色；U46-7b 预览（drawio/svg/img）+diff 标签页（依赖 6b 的 git RPC 结论）；5a 已止损通知（两栏+四类型）。


## 12. 复用指导（2026-11-15 用户指令：复用 orca web 组件与参考设计）

各组件令实现时**优先复用 orca web（src/renderer/src/web/，W13b 云会话视图）的组件与形态**：外壳参考其 app-layout/侧栏/面板组合与 CloudSessionEmptyState 降级态；文件树**优先直接复用或最小适配其 explorer**（同数据面 cloud file RPC，勿重造树逻辑，无过滤则新增）；编辑器参考其 Monaco 加载/`__monacoEditorE2E` 管线与 md 呈现（如有）；终端参考其终端管线与 W13b 终端标签形态。跨包能 import 则 import，不能则形态复制适配并注明来源先例。后续令（5b/6b/7b/8）派发词直接含此要求。
