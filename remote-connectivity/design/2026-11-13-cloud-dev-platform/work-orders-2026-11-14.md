# 云端开发平台 · 工作令（2026-11-14，规范化版）

> 纪律：**一个子代理只执行一个工作令**；主会话串行派发、逐个核验后再派下一个。
> 每令一次提交、一次测试报告、证据入 `cloud-platform/evidence/<work-order>/`（gitignored）。
> 设计依据以 requirements.md（v1.3+FR 修订）、design.md、deployment-real-link.md、test-plan.md 为准；与本文件冲突时先在交付说明中指出，不要自行改文档。
> 工作区内与平台无关的改动（claude-auto-resume、acceptance-index 等）**不要触碰、不要提交**。

## 状态

| 令 | 内容 | 状态 |
|---|---|---|
| W1 | M115 自助建项目目录化 | ✅ 已提交 `7eba67c76cd`（主会话核验中） |
| W2 | M116 QA 修复：F1（P0）+ F2（P1 快修批） | 工作区有旧代理残留的半成品（server.ts / apps/web/app.js / web-admin-gating.e2e.test.ts），先审阅再续作 |
| W3 | M117 管理员详情入口 + 项目行双入口布局 | 待派发 |
| W4 | D1 静态请求 503 兜底 | 待派发 |
| W5 | M118 管理台详情页实时终端 | 待派发 |
| W6 | M121 中继双模式（浏览器路径路由） | 待派发 |
| W7 | M122 一次性 handoff 自动进入工作区 | 待派发 |

## W2 · M116 QA 修复（依据 test-reports/exploratory-qa-web.md + evidence/m116-exploratory-web/findings.json）

**F1（P0，单独提交 `fix(cloud): user grants resolve by username`）**
QA-001：Web 用户级授权填用户名显示已授予，但服务端按 `user_<uuid>` 匹配永不命中；且增删该授权误走 `revokeProjectCredentials` 撤销全项目在线会话（apps/web/app.js:509-526、store.ts:163-173、server.ts:1484-1504）。修法：服务端把 username 解析为 user id 再存（或统一主体格式），grant 变更只影响该用户。e2e：授权生效断言 + 仅该用户会话被撤。

**F2（P1 快修批，一个提交 `fix(web): exploratory QA round 1`）**
QA-002 审计 limit=50 → 总数与截断提示；003 筛选控件与实际条件一致；004 traceId 全量可复制；005 主机状态按心跳推导；006 已吊销主机标识+禁维护；007 离线打开全入口禁用；008 维护中主机显示维护原因；009 策略保存失败提示+回滚；010 admin 权限列展示；011 加载失败错误态+重试；012 登录必填客户端校验。每项一条回归断言。P2 不做；013/014/015 功能缺口属 M120，不做。

## W3 · M117 管理员详情入口 + 双入口（FR-3.8/3.11）

平台：项目 payload 增 `sessionPageUrl`（宿主 TLS 直连首项 → `https://<host>:<port>/cloud-admin.html`；无则空）。Web：项目行（工作台+我的项目，两处一致）双入口——「详情」仅管理员（新标签）；「Orca Web」按钮占位（disabled 或按能力隐藏，交付说明写明选择，M122 接管）；离线两入口均置灰 title=主机离线。开发者「打开」对话框首行加「请在 Orca 桌面客户端中打开此项目」引导。e2e：payload 字段正反例 + Web 双入口可见性 + 引导文案。提交 `feat(cloud): per-project admin session-page entry`。

## W4 · D1 静态请求 503 兜底

无 web bundle（staticRoot undefined）时宿主 TLS 监听对静态路径返回 503 立即关闭（不再挂起 0 字节），启动打 warn 日志。单测：无 staticRoot GET /cloud-admin.html → 503；有 staticRoot 行为不变。提交 `fix(runtime): answer static requests when the web bundle is missing`。

## W5 · M118 管理台详情页实时终端（FR-3.9）

CloudProjectWorkspace 接入终端面板（复用 web 客户端终端管线 + cloud-browser-bridge rpc 到宿主 pty；cloud-admin/main.tsx 补 WebGL prime）；布局对齐原型 P3（中部终端、右侧文件树）。无 `terminal` 授权 → 占位不报错。e2e：真实平台+TLS 宿主+PTY，输入回显、文件只读预览。提交 `feat(cloud): live terminal in the admin session page`。

## W6 · M121 中继双模式（FR-4.12 修订）

中继浏览器模式（env RELAY_BROWSER_TLS_CERT/KEY + RELAY_BROWSER_PORT，未配置则不启用）：终结 TLS，按 `/h/<routeKey>/` 路由 HTTP/WSS 到宿主（剥前缀，升级请求同规则）；SNI 透传模式与既有端口完全不变。中继注册体加可选 `browserHost`（env RELAY_BROWSER_PUBLIC_HOST）。平台：宿主 payload 增 `browserEntryUrl`（`https://<browserHost>/h/<routeKey>/web-index.html`，缺 browserHost 或 routeKey 非 DNS 安全 → 空）。Web：有 open 权限者可见「浏览器打开」。web 客户端：构建相对资源 base（`/h/<routeKey>/assets/...`，直连无前缀兼容）；运行时 WSS URL 从 location.pathname 推导前缀。e2e：浏览器模式转发伺服（资源无 404）、未知 routeKey 404、SNI 模式既有全绿、未配置不启用。交付说明含「中继可见传输层头部、E2EE 载荷不可读」确认点。提交 `feat(relay): browser mode with path routing`。

## W7 · M122 一次性 handoff 自动进入（FR-3.10）

平台：`POST /v1/projects/{id}/web-handoff`（open 权限，审计 `web_handoff`）→ 一次性 ≤60s code + URL（`<browserEntryUrl 或直连 web-index>#handoff=<code>&project=<id>`）；`POST /v1/web/handoff` 换正式会话（复用设备会话签发；二次/过期 410、无权限 403）。orca web：启动读 hash → 换会话 → 自动打开指定项目；失败回落登录表单（预填平台地址）；hash 用后即清。Web 项目行「Orca Web」按钮激活（调 web-handoff 并 window.open）。e2e：签发→换发→二次 410→过期 410→无权限 403 + web 端自动进入。提交 `feat(cloud): one-time web handoff auto-entry`。

## M120（功能缺口，暂缓待排）

管理台项目登记弹层（QA-013）、权限矩阵可配置（QA-014）、项目级下载策略（QA-015）——FR-3.1/9.3/9.4 的 Web 呈现补齐。依赖 W3 布局稳定后再派发。
