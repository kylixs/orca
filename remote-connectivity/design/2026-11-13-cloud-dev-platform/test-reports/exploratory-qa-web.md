# 云开发平台 Web 管理台 探索式 QA 报告

- 执行日期：2026-11-14
- 被测对象：HEAD 快照（`git archive HEAD cloud-platform`，提交 `98cb583bbc9`），独立实例 `http://127.0.0.1:61841`（另起空数据实例 `:61317` 验证空态）
- 角色：`admin / Adm1n!`（平台管理员）、`zhangsan / Passw0rd!`（开发者，`team-payment` 组）
- 浏览器：Playwright Chromium headless，1440×900 为主，关键页补 1280×900
- 约束：**只读测试，未修改任何产品代码、未提交**；未触碰主会话 18787 实例与主仓工作区。
- 结果：**P0 × 1，P1 × 14，P2 × 18，共 33 条**
- 机器可读证据：`cloud-platform/evidence/m116-exploratory-web/findings.json`；截图 `.../shots/`（82 张）；控制台/网络 `.../console/`

## 一、测试环境与数据

独立栈全部在 `/tmp/m116-qa` 下运行：API（HEAD 快照）、runtime-sim 主机、2 个真实 relay 进程、心跳保活脚本。

| 对象 | 数据 |
| --- | --- |
| 主机 | `dev-001`（intranet，心跳可失效/可吊销）、`dev-002`（dmz，10s 心跳保活） |
| 项目 | `payment-service`（dev-001）、`payment-service-2`（dev-002）、`order-service`（dev-002）、`grant-fixture-probe`（授权探针） |
| 授权 | 上述项目默认授予组 `team-payment` |
| 中继 | `127.0.0.1:18443`（无 `RELAY_PUBLIC_HOST`，注册来源 IP）、`relay2.example.test:18444`（显式域名） |
| 审计 | 通过登录/连接/授权/吊销/脚本下载等操作累积至 97 条，用于溢出与分页验证 |

## 二、P0（功能坏）

### M116-QA-001 用户级授权「看起来成功、实际不生效」，并会撤销整个项目的凭证

- **页面**：成员与权限 → 选择项目 → 授权表单/矩阵
- **复现**：
  1. admin 进入「成员与权限」，选 `grant-fixture-probe`；
  2. 主体填 `zhangsan`，类型选「用户」，点「授予基础权限」；
  3. 矩阵出现 `zhangsan / 用户 / ✓`，toast「已授予」；
  4. 以 zhangsan 调 `GET /v1/projects`：项目不可见（前后结果完全一致）；
  5. 对照：把同一项目授予组 `team-payment`，zhangsan 立即可见。
- **实际**：授权记录 `subjectType=user, subjectId="zhangsan"` 被正常写入并在 UI 渲染为已授权；但服务端按 `g.subjectId === user.id` 匹配，而用户 ID 形如 `user_<uuid>`，用户名永不命中。更严重的是，新增/移除该授权时 `store.users.get('zhangsan')` 为 `undefined`，代码走 `else` 分支执行 `revokeProjectCredentials(projectId)`，**把该项目所有在线会话一并撤销**。
- **期望**：用户级授权应落到真实用户 ID（或表单提供可选择的用户），仅影响目标用户；UI 不得把未生效的授权显示为成功。
- **定位**：`cloud-platform/apps/web/app.js:509-526`；`cloud-platform/apps/api/src/store.ts:163-173`；`cloud-platform/apps/api/src/server.ts:1484-1504`
- **证据**：`shots/members-fixture-user-grant-added.png`、`console/member-usergrant.json`

## 三、P1（行为错或误导）

### M116-QA-002 审计列表硬编码 50 条，无总数/分页/截断提示

- **页面**：审计日志
- **复现**：累积 97 条审计事件 → 打开审计页 → 与 `GET /v1/audit/events?limit=200`（97 条）对比。
- **实际**：`limit: '50'` 写死，无分页控件、无总数、无「仅显示最近 50 条」提示；最早 47 条不可见、不可达。
- **期望**：展示总数并分页/加载更多，或显式告警截断。FR-8.3。
- **定位**：`cloud-platform/apps/web/app.js:540-579`
- **证据**：`shots/audit-over50.png`

### M116-QA-003 审计筛选控件每次查询后被重置，条件与结果不一致

- **页面**：审计日志
- **复现**：选 事件=`grant_update`、结果=成功、用户=`admin` → 查询（10 行，正确）→ 观察三个控件已全部回空但结果仍是过滤后的 10 行 → 再选 结果=拒绝 查询：事件类型条件丢失，返回全部类型的 denied 事件（9 条，含 `install_script` 等）。
- **实际**：`renderAudit()` 重建工具栏时不回填 `state.auditFilter`；控件清空而内部状态保留，第二次查询只携带新选条件。无「重置」按钮，无时间范围/项目/主机筛选（FR-8.3）。
- **期望**：控件保持已选条件，支持条件增删与一键重置；离开再返回时条件与结果一致。
- **定位**：`cloud-platform/apps/web/app.js:540-589`
- **证据**：`shots/audit-filters-reset-after-query.png`、`shots/audit-return-controls-reset.png`、`shots/audit-combined-filter.png`

### M116-QA-004 traceId 只显示前 12 位且不可复制

- **页面**：审计日志
- **复现**：查看 traceId 列，尝试选中/复制。
- **实际**：`esc((e.traceId ?? '').slice(0, 12))`，无 `title`、无复制按钮、行不可点击；复制到的是截断串，无法与中继/主机日志精确关联。FR-8.4。
- **定位**：`cloud-platform/apps/web/app.js:565-575`
- **证据**：`shots/audit-default.png`

### M116-QA-005 主机状态用持久 `status` 字段渲染，忽略心跳推导的 `online`

- **页面**：主机
- **复现**：让 `dev-001` 超过 60 秒无心跳 → 打开主机页 → 对比 `GET /v1/hosts` 的 `online:false`。
- **实际**：`h.status === 'online'` 直接决定文案/圆点；心跳 3 分钟前的主机仍显示绿色「在线」。结束维护后同样把离线主机写回「在线」。
- **期望**：以心跳窗口推导状态，与工作台「主机离线」口径一致。
- **定位**：`cloud-platform/apps/web/app.js:334-346`；`cloud-platform/apps/api/src/server.ts:670-680`
- **证据**：`shots/hosts-list.png`、`shots/hosts-after-end-maintenance.png`

### M116-QA-006 吊销后无「已吊销」标识，且仍可进入维护模式

- **页面**：主机 / 主机详情抽屉
- **复现**：打开 `dev-001` 详情 → 「下线主机」并确认 → 观察列表与抽屉 → 再点「进入维护模式」。
- **实际**：吊销后行与普通离线无差别；抽屉不展示 `revokedAt`/状态，仍提供维护/下线按钮；进入维护后列表显示「维护中」，而 API 仍是 `revokedAt` + `online:false`。
- **期望**：吊销应为不可逆终态，明确展示原因与时间，并禁止后续变更（服务端亦需拦截）。
- **定位**：`cloud-platform/apps/web/app.js:334-405`；`cloud-platform/apps/api/src/server.ts:1955`（维护处理无 revoked 守卫）
- **证据**：`shots/hosts-revoked-maintenance.png`、`shots/hosts-drawer-after-revoke.png`

### M116-QA-007 离线项目的「打开」只在工作台表格行禁用

- **页面**：工作台「最近项目」卡片 / 我的项目
- **复现**：`payment-service` 主机离线 → 点卡片「打开」→ 进「我的项目」点该行「打开」。
- **实际**：`projectCard()` 与 `renderProjects()` 未判断 `hostStatus`，按钮可点击并弹出「无法打开项目 / HOST_OFFLINE」；仅 `projectRow()` 有 `disabled`。三个入口行为不一致。FR-2.4。
- **定位**：`cloud-platform/apps/web/app.js:200-204`、`cloud-platform/apps/web/app.js:296-304`
- **证据**：`shots/projects-offline-open-dialog.png`、`shots/projects-developer-offline-open.png`

### M116-QA-008 维护中的主机在项目列表被标为「主机离线」，维护原因不可见

- **页面**：工作台 / 我的项目
- **复现**：对 `dev-001` 进入维护 → 打开工作台。
- **实际**：非 online 状态统一渲染为「离线」+「主机离线」，无法区分维护与故障，也不显示维护原因。FR-4.5。
- **定位**：`cloud-platform/apps/web/app.js:190-205`、`cloud-platform/apps/web/app.js:225-238`
- **证据**：`shots/workbench-maintenance-host.png`

### M116-QA-009 保存下载策略失败时无任何提示，界面停留在未生效的值

- **页面**：平台设置
- **复现**：拦截 `PUT /v1/policies/download` 使其失败 → 选「允许下载」→ 保存。
- **实际**：无 toast、无错误文案，单选仍停在「允许」；仅控制台出现未捕获 `pageerror: Failed to fetch`（`app.js:32` → `612`）；服务端仍为 `deny`。
- **期望**：错误提示 + 状态回滚 + 可重试；禁止未处理 Promise。
- **定位**：`cloud-platform/apps/web/app.js:610-618`
- **证据**：`shots/settings-save-failure-clean.png`、`console/audit-overflow-savefail.json`

### M116-QA-010 管理员可打开任意项目，但签发凭证 `perms=[]`，「可见范围」列全空

- **页面**：工作台 / 我的项目 / 连接信息对话框
- **复现**：admin 打开任一项目 → 观察「可见范围」列 → 解码 `/connect` 返回的凭证。
- **实际**：admin 通过 `isAdmin` 看到全部项目，但 `effectivePermissions` 返回 `[]`，凭证 `perms: []`（桌面端等于无文件/终端权限）；工作台「可见范围」与「我的项目 → 权限」在 admin 视角全部为空。
- **期望**：无项目授权的管理员应被禁止打开并提示先授权，或展示项目实际授权主体。
- **定位**：`cloud-platform/apps/web/app.js:225-238`；`cloud-platform/apps/api/src/server.ts:2308-2345`；`cloud-platform/apps/api/src/store.ts:163-173`
- **证据**：`shots/workbench-admin.png`、`shots/projects-admin-full.png`

### M116-QA-011 页面数据加载失败时永久停在「加载中…」

- **页面**：主机/中继/审计/成员/设置（所有 fetch 渲染页）
- **复现**：拦截 `/v1/relays` 使其失败 → 点「中继」。
- **实际**：内容区永久「加载中…」，无错误态、无重试按钮；`pageerror: Failed to fetch`。一次网络抖动即让页面失去交互，只能整页刷新（刷新又回工作台）。
- **定位**：`cloud-platform/apps/web/app.js:106-117`
- **证据**：`shots/relays-load-failure.png`

### M116-QA-012 空字段不做必填校验，空提交累计触发账号锁定

- **页面**：登录
- **复现**：不填账号密码，连续点击「登录」5 次。
- **实际**：`<form novalidate>`，空值照常提交；服务端按 `username=''` 计失败，第 5 次返回 `423 ACCOUNT_LOCKED`，前端显示「账号已锁定，请 15 分钟后重试」；账号框未标红（仅密码框）。FR-1.4。
- **期望**：前端先提示「请输入域账号/密码」，不发起请求、不计锁定次数。
- **定位**：`cloud-platform/apps/web/index.html:14`；`cloud-platform/apps/web/app.js:728-755`
- **证据**：`shots/login-empty-locked.png`、`shots/login-empty-submit.png`

### M116-QA-013 管理台没有项目登记入口（FR-3.1 P0 缺口）

- **页面**：管理导航 / 项目
- **复现**：admin 登录后查找「项目 / 新建项目 / 登记项目」。
- **实际**：侧栏仅 工作台/我的项目/主机/中继/成员与权限/审计日志/平台设置；工作台与我的项目均为只读列表；只能通过 API 创建项目。「新建项目弹层」（含空值、重复 Key、超长校验）不存在。
- **期望**：提供项目登记表单与校验（FR-3.1/3.2）。
- **定位**：`cloud-platform/apps/web/index.html:54-64`；`cloud-platform/apps/web/app.js:144-309`
- **证据**：`shots/workbench-admin.png`、`shots/projects-admin-full.png`

### M116-QA-014 权限矩阵只读，无法按权限项配置（FR-9.3 P0 缺口）

- **页面**：成员与权限
- **复现**：进入页面，尝试勾选/取消单个权限。
- **实际**：矩阵为静态 ✓/—，每行只有「移除」；新增固定授予 `open/terminal/agent/file:read/file:write` 五项，无 download；无法只给 `file:read` 或单独开终端；无保存/重置语义。
- **期望**：可编辑矩阵并保存，支持最小权限组合。
- **定位**：`cloud-platform/apps/web/app.js:479-537`
- **证据**：`shots/members-default.png`

### M116-QA-015 下载策略只有全局二态，无项目级覆盖与影响范围（FR-9.4 P0 缺口）

- **页面**：平台设置
- **复现**：打开平台设置，查找项目级策略/生效范围。
- **实际**：仅 deny/allow 单选，保存后只 toast「已保存，30 秒内生效」，不显示影响项目数；无项目级入口；无「审批」态；副标题宣称的「客户端最低版本」设置不存在。
- **期望**：全局默认 + 项目级覆盖/三态，保存后展示生效范围与影响项目数（FR-7.1、FR-9.4）。
- **定位**：`cloud-platform/apps/web/app.js:591-619`
- **证据**：`shots/settings-default.png`

## 四、P2（体验打磨）

### M116-QA-016 弹层/抽屉：Esc 不关闭、焦点不进入/不锁定、无 aria-labelledby

- **复现**：打开项目连接信息对话框 → 按 Esc → 连续 Tab；对主机详情抽屉重复。
- **实际**：Esc 无效；`activeElement` 仍在背景「打开」按钮；Tab 可依次聚焦背景侧栏；`role=dialog/aria-modal` 存在但无 `aria-labelledby`，关闭后焦点不回触发按钮。
- **定位**：`cloud-platform/apps/web/app.js:623-663`
- **证据**：`shots/workbench-online-open-dialog.png`、`shots/hosts-drawer-dev001.png`

### M116-QA-017 显示密码按钮 aria-label 不随状态更新

- **复现**：点密码眼睛按钮 → 读取 `aria-label` 与 `type`。
- **实际**：`type=text` 后 label 仍为「显示密码」，无 `aria-pressed`。
- **定位**：`cloud-platform/apps/web/app.js:757-760`
- **证据**：`shots/login-password-visible.png`

### M116-QA-018 登录网络失败显示英文 `Failed to fetch`，错误无无障碍关联

- **复现**：中断 `/v1/auth/login` → 提交正确账号密码。
- **实际**：内联错误文本为 `Failed to fetch`；账号框无错误标记；无 `aria-invalid`/`aria-describedby`。
- **定位**：`cloud-platform/apps/web/app.js:741-750`
- **证据**：`shots/login-network-error.png`

### M116-QA-019 中继「最近注册时间」为 en-US 格式

- **复现**：打开中继页查看时间列。
- **实际**：`toLocaleString()` 跟随运行环境，headless 下为 `11/14/2026, 3:51:21 AM`；同页审计使用 `zh-CN`。
- **定位**：`cloud-platform/apps/web/app.js:442-449`
- **证据**：`shots/relays-list.png`

### M116-QA-020 中继列表无详情/抽屉、无自动刷新

- **复现**：打开中继页 → 点击任一行 → 停留 30s+。
- **实际**：行不可点击、无详情按钮；仅手动「刷新」；`lastSeenAt` 绝对时间，在线状态不会自动更新。
- **定位**：`cloud-platform/apps/web/app.js:407-449`
- **证据**：`shots/relays-list.png`、`shots/relays-refreshed.png`

### M116-QA-021 复制命令失败仍提示「已复制」

- **复现**：覆写 `navigator.clipboard.writeText` 为 reject → 打开「注册主机」→ 点「复制命令」。
- **实际**：toast「已复制」，同时 `pageerror: denied`；命令未进入剪贴板。
- **定位**：`cloud-platform/apps/web/app.js:348-358`
- **证据**：`shots/clipboard-false-success.png`

### M116-QA-022 慢请求下页面错位：面包屑「中继」+ 内容「主机」

- **复现**：对 `/v1/hosts` 注入 1.6s 延迟 → 点「主机」→ 100ms 内点「中继」。
- **实际**：hosts 的迟到响应覆盖 content，出现 crumb/高亮=中继、内容=主机表格；无请求序号/取消。
- **定位**：`cloud-platform/apps/web/app.js:96-117`
- **证据**：`shots/race-relays-shows-hosts.png`

### M116-QA-023 「刷新」触发整页 reload 并回到工作台；路由不可持久化

- **复现**：进入「我的项目」→ 点「刷新」；另试 `/#settings` 与 `/settings`。
- **实际**：`location.reload()` 后 bootstrap 固定 `navigate('workbench')`；hash 不生效，`/settings` 直接 404（无 SPA fallback）。
- **定位**：`cloud-platform/apps/web/app.js:276-282`、`cloud-platform/apps/web/app.js:769-783`
- **证据**：`shots/projects-after-refresh.png`、`shots/hash-settings-route.png`、`shots/workbench-after-reload.png`

### M116-QA-024 「最近项目」取数组前 3 个（最旧创建）

- **复现**：新建第 4 个项目 `grant-fixture-probe` → 打开工作台。
- **实际**：三张卡仍是最早 seed 的项目；新项目只出现在下方表格；卡片 meta 为 `createdAt` 的「创建于」，无最近使用时间。FR-2.4。
- **定位**：`cloud-platform/apps/web/app.js:144-205`
- **证据**：`shots/workbench-after-host-revoke.png`

### M116-QA-025 设置页无改动也保存；保存按钮不防重复点击

- **复现**：不改选项直接保存；随后快速双击保存并统计 PUT。
- **实际**：无脏数据仍递增版本（v1→v2）；双击产生 2 次 PUT，版本继续 +2，并重复写 `policy_update` 审计。
- **定位**：`cloud-platform/apps/web/app.js:610-618`
- **证据**：`shots/settings-double-save.png`、`shots/settings-saved-toast.png`

### M116-QA-026 顶栏常驻调试入口「查看无权限页」

- **复现**：admin 登录后点击顶栏按钮。
- **实际**：`#open403` 始终显示，点击直接渲染 403 页。
- **定位**：`cloud-platform/apps/web/index.html:81`；`cloud-platform/apps/web/app.js:766`
- **证据**：`shots/forbidden-page-via-topbar.png`

### M116-QA-027 加载态/toast 无 aria-live、aria-busy、role=status

- **复现**：延迟 `/v1/projects` 打开工作台；触发复制/保存 toast；检查无障碍属性。
- **实际**：内容容器无 `role/live/busy`；toast 仅为 `div`。
- **定位**：`cloud-platform/apps/web/app.js:70-76`、`cloud-platform/apps/web/app.js:115`
- **证据**：`shots/loading-state-workbench.png`

### M116-QA-028 移除授权无二次确认；空主体静默无反馈；项目切换不显示主机状态

- **复现**：点某行「移除」；主体留空点「授予基础权限」；查看左侧项目列表。
- **实际**：移除即时生效（并触发凭证撤销）无确认；空主体 `return` 无提示；左侧仅项目名，`payment-service` 所在主机离线不可见。
- **定位**：`cloud-platform/apps/web/app.js:451-477`、`cloud-platform/apps/web/app.js:513-537`
- **证据**：`shots/members-default.png`、`shots/members-fixture-empty.png`

### M116-QA-029 主机详情缺状态/维护原因/吊销时间/绝对心跳时间

- **复现**：打开主机详情，与 `GET /v1/hosts` 字段对照。
- **实际**：仅 ID/指纹/E2EE 公钥/版本/zone/直连/中继路由/能力/相对心跳；无状态、维护原因、吊销信息。FR-4.5。
- **定位**：`cloud-platform/apps/web/app.js:371-405`
- **证据**：`shots/hosts-drawer-dev001.png`、`shots/hosts-drawer-after-revoke.png`

### M116-QA-030 工作台缺搜索/筛选与通知面板；统计卡口径与 FR-2.5 不一致

- **复现**：打开工作台，查找搜索框、状态筛选、通知入口。
- **实际**：无任何输入控件与通知入口；统计卡为「可访问项目/主机在线/禁用下载项目/下载默认策略」，与需求的「进行中项目/今日会话/可用主机/待审批下载」不一致。FR-2.3/2.5。
- **定位**：`cloud-platform/apps/web/app.js:144-176`
- **证据**：`shots/workbench-admin.png`

### M116-QA-031 审计事件类型下拉缺 6 类实际事件，且无导出

- **复现**：对比下拉选项与实际 `eventType` 集合。
- **实际**：仅 9 个固定类型，实际有 13 种；`install_script/host_maintenance/project_create/host_token_create/audit_query/relay_list/host_list` 无法筛选；无导出入口（FR-8.5）。
- **定位**：`cloud-platform/apps/web/app.js:546-557`
- **证据**：`shots/audit-default.png`

### M116-QA-032 access/refresh 令牌明文存 localStorage

- **复现**：登录后读取 `localStorage['orca.access'/'orca.refresh']`。
- **实际**：两个令牌均为明文（长度 43/43）；无 HttpOnly 保护。当前页面未发现注入点，属加固建议。
- **定位**：`cloud-platform/apps/web/app.js:3-12`、`cloud-platform/apps/web/app.js:63-68`
- **证据**：`shots/workbench-admin.png`、`console/workbench-admin.json`

### M116-QA-033 连接信息不展示凭证/无复制与桌面端引导；注册主机弹层每次打开即签发一次性令牌

- **复现**：打开项目连接信息；打开注册主机弹层后直接关闭，重开对比 token。
- **实际**：对话框仅 wss 地址与工作区，文案提到「60 秒一次性」但不给出凭证；每次点「注册主机」都 POST `/v1/hosts/tokens` 生成新令牌，取消后不回收。
- **定位**：`cloud-platform/apps/web/app.js:249-266`、`cloud-platform/apps/web/app.js:360-369`
- **证据**：`shots/workbench-online-open-dialog.png`、`shots/hosts-register-dialog.png`

## 五、已验证正常（覆盖证明）

以下项目已逐条实测通过，用于界定 P0「核心链路未断」的结论：

1. **登录与会话**：正确凭据登录成功；错误密码返回中文「域账号或密码错误」；会话自动恢复；401 后静默刷新 access token 并重放请求；刷新令牌失效后回到登录页；登出清理本地态。
2. **锁定**：错误密码 5 次触发 `423 ACCOUNT_LOCKED` 并显示 15 分钟提示（唯一缺陷见 M116-QA-012：空提交也计入）。
3. **工作台数据一致性**：4 张统计卡与 API 逐项核对一致（项目总数/在线主机数/禁用下载项目数=策略 deny 下全部/策略版本），且随策略变更联动更新。
4. **工作台表格**：项目行离线时「打开」按钮 `disabled` 且带原因提示；在线项目打开弹出连接信息；`HOST_OFFLINE` 分支文案正确。
5. **我的项目**：搜索对名称/仓库/主机三类字段生效，空结果有空态文案；离线行表格按钮正确禁用（卡片/行入口不一致见 M116-QA-007）。
6. **开发者视角**：侧栏不渲染任何管理项；直接调用 5 个管理路由均渲染 403 页；`curl` 管理 API（hosts/relays/audit/grants/policies）全部 403 且写入 denied 审计；403 页文案与返回入口正常。
7. **主机页**：搜索/状态筛选生效；统计数与列表一致；注册命令与实际下发的 token 一致（剪贴板真实读取校验，成功路径通过）；`/install/host.sh` 无 token 返回 400；主机详情抽屉主要字段与 API 一致；维护进入/退出流程成功且心跳 / 项目状态联动。
8. **离线确认流**：HEARTBEAT 超时后进入离线，工作台与表格按钮状态同步（主机页 `status` 文案缺陷见 M116-QA-005）。
9. **中继页**：两个样本均正确展示（显式 `RELAY_PUBLIC_HOST` 与来源 IP 回退）；节点 ID/可拨号地址/在线状态/最近注册四列与 API 一致；空数据实例显示空态；`/install/relay.sh` 可下载且内嵌 token。
10. **成员与权限**：项目切换与组授权生效（zhangsan 授权后立即可见）；download 列固定「锁」并给出说明；组授权移除即时生效；XSS 载荷在主体名中被安全转义（未执行）。
11. **审计**：四个筛选条件均由服务端生效（单条件计数逐项核对：denied=9、grant_update=10、login 等）；时间范围 `since` 正确下传；`traceId` 精确查询命中；31 天窗口上限生效。
12. **设置**：deny→allow→deny 策略切换成功并在工作台「禁用下载项目」联动；保存后版本递增；模板/权限文案与实际一致。
13. **全局**：1440×900 与 1280×900 均无横向滚动条；各页空态文案存在；加载态存在（错误态缺失见 M116-QA-011）；登录页与主界面无未处理的 console error（注入故障时除外）。
14. **安全基线**：`/connect` 凭证含 `sub/perms/exp`，60 秒 TTL；未授权用户无法读取他人项目；管理员 API 全部鉴权；审计事件有 hash 链与 denied 记录。
15. **后端故障语义**：`HOST_MAINTENANCE`、`HOST_REVOKED`、`HOST_OFFLINE`、`PROJECT_EXISTS`、`INVALID_CREDENTIALS`、`ACCOUNT_LOCKED` 状态码与错误码均与设计一致。

## 六、未覆盖与限制

- 桌面客户端侧的连接建立、文件传输、终端会话未纳入本轮（Web 端仅验证到凭证签发与错误分支）。
- 下载审批流（FR-7.x 的审批态）在 Web 端未实现，无法端到端验证。
- 通知面板、项目登记向导、项目级下载策略属于需求应有但页面不存在的能力，按缺口记录（M116-QA-013/015/030），未做交互级验证。
- 未做长时间稳定性/并发压力测试；导航竞态仅以延迟注入方式验证一次。
- 未执行破坏性操作（未删除 seed 项目/主机之外的生产数据）；所有数据均在 `/tmp/m116-qa` 隔离实例内。

## 七、复现与证据索引

- 复现脚本：`/tmp/m116-qa/cloud-platform/qa/`（t1–t16，Playwright，可直接对独立实例重跑；数据准备脚本 `/tmp/m116-qa/setup.mjs`、心跳 `/tmp/m116-qa/beat.mjs`）
- 机器可读结果：`cloud-platform/evidence/m116-exploratory-web/findings.json`（33 条，含 severity/page/steps/actual/expected/files/evidence）
- 截图：`cloud-platform/evidence/m116-exploratory-web/shots/`（82 张）
- 控制台与网络：`cloud-platform/evidence/m116-exploratory-web/console/`（每场景一个 JSON，含 console/pageerror/HTTP 4xx-5xx/requestfailed）
