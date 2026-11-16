# Orca Cloud 探索路径增量 R6（v2.2 新增面：权限界面 / 全站路由 / 安装向导）

> **范围注记**：本轮把 v2.2 新增的可复用界面面纳入路径清单，只覆盖桌面视口（1440×900）。移动视口适配仍未实现，不在本轮做伪移动断言。
>
> 目标：`https://127.0.0.1:18787/`（自签证书，Playwright 需 `ignoreHTTPSErrors`）。
> 账号：`admin/Adm1n!`（平台管理员，demo-app 已授权 open/terminal/agent/file:rw）。
> 驱动：`node cloud-platform/scripts/exploratory-r2/run-exploratory-r6.mjs`
> 证据：`evidence/exploratory-r6/`（`r6-findings.json` + `screenshots/`，本地留存，不入 git）。
> 三条路径以只读/短交互为主：P1'' 的权限写操作统一走「添加 → 立即移除」，并在结束时清理；P2''/P3'' 只读（P3'' 只消耗向导自己签发的一次性令牌，属预期行为）。

## 运行态注记（2026-11-16）

- 常驻 18787 平台进程在启动时快照 web release，当前对外 release 为 `56ab51abab57`（`app.js` 132105 字节），权限卡仍是 v2.2 前的旧实现：每张卡重复渲染同一主体、卡头带权限位徽标、无 `data-open-host-detail` 跳转。
- 因此默认运行（直连 18787）会在 P1''-1 卡计数/chips 干净度与 P1''-4 管理推导跳转上失败，这是「服务端热更新缺口」而非工作树缺陷。
- 驱动支持 `ORCA_QA_PIN_WEBTREE=1`：仅把控制台四个静态文件从 `apps/web/` 取出回填，所有 API/安装端点仍真实打到 18787。本轮三条路径以该模式全量通过；不加该变量时 `webSource` 记为 `18787 server release`，便于复现旧包差异。
- 不重启持久进程（约束），故未强制刷新服务端快照。

## §2-16 基线探测（每轮开始执行一次）

- 步骤：登录后并发读取 `GET /v1/me`、`GET /v1/projects`、`GET /v1/hosts`、`GET /v1/users`、`GET /v1/directory`；用同刻 API 响应作为后续 UI 断言的基线，不依赖上一轮残留 DOM。
- 检查点：`me.username=admin` 且含 `platform:admin`；至少 1 台在线主机；`demo-app`（`proj_369e97d1`，host `host_281843a9`）在可见项目内；`admin` 在用户名单内；目录返回 `developers / platform-admins / team-payment` 组。
- 数据缺失时对应路径记为不可执行（FAIL 并在 detail 记录缺项），不记通过。
- 非 DOM 断言：路径状态、API 计数、URL hash、curl 状态码均以值断言；DOM 文本仅用于文案检查。

## P1'' 权限界面（主机三卡 / 项目两卡 + 管理推导 / 用户详情内联编辑）

### P1''-1 主机权限三卡（读）

- 入口：`#/hosts` → `dev-local-02`（`host_281843a9`）行「详情」→ 页签「权限」。
- 步骤：读取 `#hostPermCards .perm-card` 的 `data-card`、卡头标签、主体计数；同刻 `GET /v1/hosts/<id>/grants`。
- 检查点：恰好 3 张卡，顺序/键=`view`（查看）/`control`（控制）/`manage`（管理）；卡头不出现权限位 `badge`；每个主体 chip 只含 `mono 主体名 + 类型`（无级别 badge，`showLevel=false`）；已知主体 `zhangsan` 落在「控制」卡（位组合 `view+provision`）；每卡主体数 = API 按 `hostRoleOf` 推导计数。

### P1''-2 主机添加 → 移除（写后即清理 + 确认文案）

- 步骤：在「查看」卡把主体类型切到「组」，输入目录中不存在于该主机授权的组（`developers`），点「添加」；等待 `PUT /v1/hosts/<id>/grants` 落库并重绘。随后点该 chip 的 `✕`，出现「移除全部授权」确认框；断言后点「确认移除」，等待第二次 PUT。
- 检查点：添加后 API 出现 `group:developers` 且权限位恰为 `['view']`、chip 出现在「查看」卡；确认框标题「移除全部授权」、正文含「宿主无法解析组成员，将断开该主机当前全部在线会话（≤60 秒内生效，FR-1.7）。」（组主体文案）、确认按钮为 danger 文案「确认移除」；移除后 API 不再含该主体，chip 消失。结束时该主机授权与基线一致。

### P1''-3 主机角色「调整」确认链（不落库）

- 步骤：点「控制」卡 `zhangsan` chip 的「调整」。
- 检查点：新弹框标题「调整角色」，正文含「当前角色为「控制」」；目标按钮文案「改为「查看」」「改为「管理」」；因控制卡含 `view`，「改为「管理」」前出现「管理=provision+maintain（不含 view）：保存会丢失 view 带来的项目可见性。」；点「关闭」后弹框消失、主机抽屉仍在，**0 个额外 PUT**。

### P1''-4 项目两卡 + 管理推导只读 + 跳转

- 入口：`#/projects/proj_369e97d1?tab=perms`（demo-app）。
- 步骤：读取 `#projectPermCards .perm-card`、`[data-perm-add]`、`[data-open-host-detail]`；同刻 `GET /v1/projects/<id>/grants` 与 `GET /v1/hosts/<hostId>/grants`。
- 检查点：恰好 3 张卡——可写 `view`（查看）/`control`（控制）+ `derived`（管理）；可写卡卡头不暴露权限位（`showBits=false`）；「管理」卡头徽标「主机推导 · 只读」，描述含「项目级无「管理」权限位」，卡内 **0 个添加入口**、所有 `✕` 为 disabled；推导主体 = 主机 `control`/`manage` 卡主体（本数据为 `zhangsan`，来源徽标「来源：控制卡」），仅 `view` 持有者不得出现；点「前往主机详情弹框 →」后 URL 变为 `#/hosts/<hostId>?tab=perms` 且主机抽屉权限页签激活。

### P1''-5 项目添加 → 移除

- 步骤：在「查看」卡以「组」添加 `developers`（默认类型即组），等待 PUT；再点 chip `✕` 触发「移除全部授权」并确认。
- 检查点：添加后 API 行权限为行内并集 `['file:read','open']`（排序后），chip 出现在「查看」卡；确认框正文含「宿主无法解析组成员，将断开该项目当前全部在线会话（≤60 秒内生效，FR-1.7）。」（组主体文案）；移除后 API 删除该行且与基线一致。

### P1''-6 用户详情内联编辑

- 入口：`#/users/<admin id>` 深链。
- 检查点：弹框标题「用户详情 · 李静」；列表 `#usersBody` 内 `input/select` 数为 0（列表只读）；详情内存在 `select[data-detail-role]`（角色修改唯一入口）；`dl.kv` 含显示名/账号/部门/LDAP 组/平台角色/角色来源/状态；无创建时间/最近登录（wire 无字段不虚构）。

### P1''-7 成员页不存在（详情 404）

- 步骤：`#/users/user_does_not_exist`。
- 检查点：渲染「页面不存在」，正文含「链接里的用户不存在或当前账号不可见。地址保留，刷新会重新校验。」；按钮「返回用户管理」；hash 保留原值；不渲染任何用户弹框。

## P2'' 全站路由（深链 / 覆盖层 / 筛选入 URL / 404 / 403 / 登出）

### P2''-1 三个详情深链 + `?tab=perms` 刷新

- 步骤：分别直达 `#/projects/proj_369e97d1`、`#/hosts/host_281843a9`、`#/users/<admin id>`；再直达 `#/projects/proj_369e97d1?tab=perms` 与 `#/hosts/host_281843a9?tab=perms` 并 `reload()`。
- 检查点：三个深链分别打开项目弹框/主机抽屉/用户弹框；hash 原样保留；`?tab=perms` 刷新后仍打开同一详情、权限页签 `active`、对应 `data-auth-panel="perms"` 可见且权限卡已渲染。

### P2''-2 覆盖层路由 `#/workspace/<id>`

- 步骤：直达 `#/workspace/proj_369e97d1`，等待 `#workspaceOverlay`；再用 `location.hash = '#/projects'` 离开；最后直达 `#/workspace/proj_nope`。
- 检查点：覆盖层出现且 URL 为 `#/workspace/proj_369e97d1`；离开后覆盖层移除（0 个 `#workspaceOverlay`）；不存在/不可见 id 渲染「页面不存在」且正文含「链接里的项目不存在或当前账号不可见」；不泄露存在性。

### P2''-3 列表筛选入 URL

- 步骤：`#/users` 输入 `张伟`（即输即筛，replaceState）；点「查询」（pushState）；点「重置」。
- 检查点：输入后 hash 含 `query=%E5%BC%A0%E4%BC%9F` 且行数 1；点「查询」后 `history.length` 增加 1（push 而非 replace）；重置后 hash 回到 `#/users` 且恢复全量。

### P2''-4 404 五形态

- 步骤：依次直达 `#/nope`、`#/projects/x/y`、`#projects`、`#/projects/%E0%A4%A`、`#/workspace/`，另加显式 `#/not-found`。
- 检查点：六种形态均渲染「页面不存在」，crumb=`页面不存在`，页面正文回显原 hash，地址栏 hash 不被改写（不回落工作台）。

### P2''-5 403 与 404 分离

- 步骤：直达 `#/forbidden`，再直达 `#/nope`。
- 检查点：`#/forbidden` 渲染「无权访问」、crumb=`无权访问`、正文含「当前账号没有平台管理权限」；`#/nope` 渲染「页面不存在」；两者标题/文案互不混用，URL 均保留。

### P2''-6 登出清 hash

- 步骤：从 `#/users` 点顶栏「退出」；再 `reload()`。
- 检查点：hash 立即变为 `#/login`；`localStorage` 中 `orca.access/orca.refresh/orca.user` 均不存在；登录视图可见；刷新后仍停在登录页且 hash=`#/login`（不恢复上一用户深链）。

## P3'' 安装向导一次性令牌（命令照抄 / 二次 401 / Bearer 兼容）

### P3''-1 主机命令原文照抄

- 入口：登录 admin → `#/hosts` → 「注册主机」。
- 步骤：读取 `#installCmd` 文本；断言格式 `bash <(curl -fsSL <origin>/install/host.sh?download=<token>&token=<token>)`。
- 检查点：说明文字含「命令 10 分钟内有效且只能下载一次；注册令牌 24 小时内有效且只能使用一次」；命令中的 origin = 页面 origin；`download` 与 `token` 均非空。

### P3''-2 照抄 URL 取脚本 200，二次 401

- 步骤：从命令原文提取 URL，用 `curl -isk "<url>"`（只读验证；`-i` 保留响应头）请求一次，再原样请求第二次。
- 检查点：第一次 HTTP 200、`content-type` 为 shell 脚本、正文含命令里的注册令牌且以脚本 shebang 开头；第二次 HTTP 401（下载令牌已被 200 消费，`usedAt` 烧毁）；两次均不执行脚本。

### P3''-3 Bearer 兼容

- 步骤：`POST /v1/hosts/tokens`（Bearer admin）取得新注册令牌，再用 `curl -isk -H "authorization: Bearer <access>" "<origin>/install/host.sh?token=<token>"`。
- 检查点：HTTP 200 且正文含该注册令牌；证明无会话目标机走一次性 URL、API/测试走 Bearer 两条通道并存。
