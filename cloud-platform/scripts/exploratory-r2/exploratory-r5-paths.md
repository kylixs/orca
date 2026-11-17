# Orca Cloud 探索路径增量 R5（用户页 / 审计查询网格 / 终端面）

> **范围注记**：本轮只覆盖桌面视口（1440×900 / 1280×860）。移动视口适配原型已审定但实现未开工，移动视口与其他未覆盖用户面待移动适配实现后并入 **r6**，不在 r5 内做伪移动断言。
>
> 目标：`https://127.0.0.1:18787/`（自签证书，Playwright 需 `ignoreHTTPSErrors`）。
> 账号：`admin/Adm1n!`（平台管理员，demo-app 已授权 open/terminal）。
> 驱动：`node cloud-platform/scripts/exploratory-r2/run-exploratory-r5.mjs`
> 证据：`evidence/exploratory-r5/`（`r5-findings.json` + `screenshots/`，本地留存，不入 git）。
> 三条路径只读或短交互：P1' 的角色变更只走到确认框并取消，**不发送 PUT**；P2'/P3' 只读。

## 数据依赖（缺失时路径记为不可执行，不记通过）

- `/v1/users` 至少 1 个 `role=admin`、2 个 `role=developer`，账号状态均为 `active`；`roleSource` 为 `default` 或 `admin-override`。
- `/v1/audit/events` 在最近 7 天内有 `eventType=login & result=success` 且 `actor=admin` 的组合结果（数量随登录次数增长，r5 实测 14–17 条）。
- `demo-app`（`proj_6dc390d2`）主机在线，admin 具备 `open + terminal`：控制台「打开」进入内嵌工作区，iframe 为宿主侧 `cloud-admin.html`。

## P1' 用户页全交互（U81b/U82 查询 + 只读列表 + 详情弹框）

入口：登录 admin → 侧栏「用户管理」（`.nav-item[data-route=users]`）。

### P1'-1 列表只读与实时数据一致

- 步骤：读取 `#usersBody` 行数、每行控件、`#usersFoot`；同刻 `GET /v1/users`。
- 检查点：行数 = API `users.length`；`#usersBody` 内 `input/select` 数量 0；每行唯一动作按钮文案「详情」；页脚「共 N 个账号」。

### P1'-2 关键字查询（即输即筛 + 查询按钮兜底）

- 步骤：`#userSearch` 输入 `张伟`；再输入 `no-such-user-r5`；再清空。
- 检查点：`张伟` 命中 1 行且行内含显示名；无匹配显示「没有符合筛选条件的账号——请调整关键字或重置条件」；清空恢复全量。
- 补充：输入后点「查询」按钮，结果与即输一致（T4：两者并存）。

### P1'-3 角色 / 状态筛选

- 步骤：`#userRoleFilter` 依次选 `admin` → `auditor` → `all`；`#userStatusFilter` 依次选 `disabled` → `active` → `all`。
- 检查点：每个选项的行数 = API 同角色/状态计数；角色列文案 = 普通/审计/管理员；0 结果时显示空态；`all` 恢复全量。

### P1'-4 组合过滤 + 重置

- 步骤：角色=`admin`、状态=`active`、关键字=`李静`；随后点「重置」。
- 检查点：组合结果 = API 同条件计数（当前 1 行），行内显示名/账号正确；重置后三个控件值分别为空/`all`/`all`，行数恢复全量，页脚不再带「当前筛选」。
- **空态复用**：组合无匹配（如角色=`auditor` + 关键字=`张伟`）时仍显示同一空态文案。

### P1'-5 详情弹框字段

- 步骤：admin 行点「详情」。
- 检查点：弹框标题「用户详情 · <显示名>」；`dl.kv` 含显示名/账号/部门/LDAP 组/平台角色/角色来源/状态；字段值与同刻 API 一致；LDAP 组空值显示 `—`；创建时间/最近登录不得出现（无 wire 字段不虚构）。

### P1'-6 角色确认链取消路径（不落库）

- 步骤：详情内 `[data-detail-role]` 从 `admin` 改为 `developer`（降级）→ 出现「角色变更」确认框 → 点确认框「关闭」。
- 检查点：确认框正文含「管理员 → 普通」「变更写入 role_update 审计」「降级将断开该用户当前云会话（≤60 秒）」；确认按钮为 danger 文案「确认变更」；关闭后详情框仍在、角色下拉回滚为 `admin`；**全程 0 个 `PUT /v1/users/<id>/roles`**。
- 备注：取消也可用 Escape（会同时关闭详情框，因两代弹框都挂 document keydown）；驱动用关闭按钮以保留详情框做回滚断言。

### P1'-7 来源标记

- 检查点：每行「角色来源」列文本 = API `roleSource` 映射：`default → 平台默认`（muted 文本）、`admin-override → 管理员覆盖`（`span.badge.ok`）。

## P2' 审计查询网格改版（U86）

入口：登录 admin → 侧栏「审计日志」（`.nav-item[data-route=audit]`）。

### P2'-1 网格三行（y 坐标分组）

- 步骤：在 1440 宽视口读取 10 个查询控件 + 动作容器的 `getBoundingClientRect()`，按 `top` 聚类（容差 8px）。
- 检查点：恰好 3 行——第 1 行 `#auditKeyword/#auditRange/#auditSince/#auditUntil/#auditType`；第 2 行 `#auditActor/#auditProject/#auditHost/#auditFileName`；第 3 行 `#auditResult/#auditApply/#auditReset`。行内控件不重叠、不越出 `.audit-filter` 右边界；「查询/清除」右对齐（动作容器右缘 ≥ 结果选择框右缘）。
- 响应式备注：1100px 以下 6 列、700px 以下 2 列由 CSS 兜底，r5 不单独断言。

### P2'-2 无底部提示

- 步骤：检查 `.audit-filter` 与 `.table-wrap` 之间的 DOM。
- 检查点：旧提示「默认最近 7 天，起止时间优先；时间窗最大 31 天。关键字…」全页文本不存在；`#auditError` 的下一个兄弟即 `.table-wrap`；`.audit-filter` 内无 `.muted` 提示节点。

### P2'-3 31 天上限在页头

- 检查点：`#content .page-head p` 含「保留 180 天，查询时间窗最大 31 天。已显示 N 条。」；N = 表格行数。

### P2'-4 组合过滤仍生效（真实数据）

- 步骤：操作类型=`login`、用户=`admin`、结果=`success`、时间范围=`最近 7 天` → 点「查询」；同刻 `GET /v1/audit/events?limit=50&eventType=login&result=success&username=admin&since=<now-7d>`。
- 检查点：DOM 行数 = API `events.length`；每行用户列=`admin`、操作列含 `login`、结果列=`✓ 成功`；页头「已显示 N 条」与行数一致。
- **观察项 R5-OBS-01（P2）**：时间范围选「最近 31 天」时，客户端按 `now-744h` 计算 since，请求到达服务端时窗口已 >31 天，API 返回 400 `TIME_WINDOW_TOO_LARGE`；页面保留上一批旧结果（当前 17 行）且 `#auditError` 仍隐藏，仅控制台出现 `查询时间窗最大 31 天。`（渲染异常未提示）。因此组合过滤用「最近 7 天」验证；31 天预设当前不可用，已登记待修。

## P3' 终端面（U83 填满 + U84a 回显徽标）

入口：登录 admin → 「我的项目」→ `demo-app` 行「打开」→ `#workspaceOverlay` 内嵌 `cloud-admin.html` → 工作区就绪 → 新建终端（`[data-testid=cloud-simple-workspace-new-terminal]`）→ 状态「实时」。
说明：该终端是 Web 控制台内嵌宿主边缘页面里的简单工作区终端，不是桌面 Electron 客户端；无需启动 Orca 应用。

### P3'-1 初始填满（gap < 1 行高）

- 步骤：读取可见 tabpanel、`cloud-terminal-panel`、`cloud-terminal-host`、`.xterm-screen` 的矩形；在 prompt 处读 `.xterm-helper-textarea` 的 `top`，按一次 Enter 后再读一次，位移即单元格行高（画布渲染下 DOM 无行文本，滚动区高度也不随输出增长）。
- 检查点：`pane.bottom - panel.bottom ≤ 1px`（面板占满 pane，无 U83 的底部空带）；`host.bottom - xterm.bottom < 行高`（xterm 渲染区占满宿主，余量不足一行）；估算行数 > 0。
- 渲染器说明：本环境终端为 canvas/webgl 渲染，`.xterm-rows` 无子节点、char-measure 元素不可用；行高用光标 textarea 位移实测，长输出证据用回显样本增量 + `.xterm-screen` 位图变化。

### P3'-2 resize fit 跟随

- 步骤：视口 1600×1000 → 1280×860，等 1.5s 重测。
- 检查点：终端行数（或 host 高度）随视口变化；`pane.bottom - panel.bottom ≤ 1px` 且 `host.bottom - xterm.bottom < 新行高` 仍成立。

### P3'-3 回显徽标存在且随输入更新

- 步骤：聚焦 `.xterm-helper-textarea`，输入 `echo R5_ECHO_OK` + Enter；读 `[data-testid=cloud-terminal-echo-latency]` 的文本与 `title`；再输入一条命令。
- 检查点：徽标文本匹配 `^echo \d+ms p95$`；`title` 含 `回显 P50 … · P95 … · max … · N 键`；第二次输入后 N 严格增大（滚动窗口样本增加），徽标仍存在。
- 已知边界：徽标仅在匹配到回显后出现；重连会清空 pending，2s 超时未匹配的按键不计样本（U84a 语义）。

### P3'-4 长输出后仍填满

- 步骤：输入 `for i in $(seq 1 300); do echo R5_LONG_$i; done`，等待输出落屏（回显样本数增加 + `.xterm-screen` 截图变化）。
- 检查点：长输出确实渲染（位图改变、样本数增加）；再次几何测量仍满足 P3'-1 的填满条件（长输出不改布局）。
