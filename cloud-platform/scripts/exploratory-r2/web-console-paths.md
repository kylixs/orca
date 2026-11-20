# Orca Cloud 管理台 Web 探索路径（R2，可重放）

目标：`https://127.0.0.1:18787/`（自签证书，浏览器需 `ignoreHTTPSErrors`）。
账号：`admin/Adm1n!`（管理员）、`zhangsan/Passw0rd!`（开发者）。
证据目录：`cloud-platform/evidence/exploratory-r2/`（findings：`web-console.json`，截图：`screenshots/`）。

本文按「入口 → 步骤 → 检查点」组织。检查点优先用 DOM 文本提取（`innerText`/`textContent`），截图只用于布局/视觉类问题。
所有写操作均标注「可逆」，重放后按「恢复」步骤还原。

## 0. 环境前置

- 平台进程：`cloud-platform/apps/api/src/server.ts`，环境变量 `ORCA_CLOUD_WEB_ROOT=<repo>/cloud-platform/apps/web`。
- 若浏览器加载到旧 bundle：以 `GET /` 返回的 `/assets/<build>/app.js` 为准；当前 build id 写入响应头 `x-orca-web-build`。重启平台后必须强制刷新页面。
- 共享环境可能被并发探针写入（项目/主机带 `r2-*` 前缀），统计数字以「同一时刻 DOM ↔ API」交叉比对为准，不要跨时刻比较。
- 只读断言脚本：`node cloud-platform/scripts/exploratory-r2/web-console-paths.mjs`（`ORCA_QA_BASE`/`ORCA_QA_USER`/`ORCA_QA_PASS` 可覆盖）。

## 1. 页面清单（视图 ↔ DOM 锚点）

| #   | 视图         | 入口                                          | 主容器/关键选择器                                                                            |
| --- | ------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | 登录         | 未登录或退出                                  | `#loginForm`、`#username`、`#password`、`#loginError`、`#loginBtn`、`#togglePassword`        |
| 2   | 工作台       | 登录后默认；`.nav-item[data-route=workbench]` | `#content .stat`、`.project-card`、`#content tbody tr`                                       |
| 3   | 我的项目     | `.nav-item[data-route=projects]`              | `#projectSearch`、`#projectBody`、`#registerProjectBtn`                                      |
| 4   | 登记项目弹层 | 我的项目 → 登记项目                           | `#regName/#regKey/#regHost/#regPath/#regRepo/#regBranch`、各自 `#reg*Error`、`#regError`     |
| 5   | 项目详情弹框 | 行内「详情」                                  | `.dialog .body .kv`、`[data-copy]`、`.foot [data-action="0"]`                                |
| 6   | 内嵌工作区   | 行内「打开」                                  | `#workspaceOverlay`、`.workspace-frame`、`[data-workspace-status]`、`[data-workspace-route]` |
| 7   | 主机         | `.nav-item[data-route=hosts]`                 | `#registerHostBtn`、`#content tbody tr`                                                      |
| 8   | 主机详情抽屉 | 主机行「详情」                                | `.drawer`、`#maintenanceBtn`、`#revokeHostBtn`、`#hostGrantPanel`                            |
| 9   | 中继         | `.nav-item[data-route=relays]`                | `#addRelayBtn`、`#refreshRelaysBtn`、`#content tbody tr`                                     |
| 10  | 成员与权限   | `.nav-item[data-route=members]`               | `#memberProjectList`、`#grantPanel`、`[data-material]`                                       |
| 11  | 审计日志     | `.nav-item[data-route=audit]`                 | `#auditType/#auditResult/#auditActor/#auditApply/#auditReset/#auditMore`                     |
| 12  | 平台设置     | `.nav-item[data-route=settings]`              | `input[name=dl]`、`#savePolicy`、`[data-policy-select]`、`#policyScope`                      |
| 13  | 无权限页     | 顶栏「查看无权限页」                          | `#backToWorkbench`、`.forbidden`                                                             |

> 非管理员（`zhangsan`）：管理导航（主机/中继/成员与权限/审计/平台设置）隐藏，`ADMIN_ROUTES` 守卫仍生效。

## 2. 登录页路径

### L1 空提交

- 入口：未登录。
- 步骤：直接点 `#loginBtn`。
- 检查点：`#loginError` 文本 = `请输入域账号和密码。`；`#username/#password` 有 `.invalid`；不产生 `/v1/auth/login` 请求。

### L2 空白用户名

- 步骤：用户名输入 3 个空格，密码任意，点登录。
- 检查点：同 L1（`trim()` 后为空被前端拦截），无网络请求。

### L3 错误凭据（避免锁号）

- 步骤：用户名用不存在账号（如 `qa_ghost_user_r2`），密码随意，点登录。
- 检查点：`#loginError` = `账号或密码错误，请重试。`；`#password` 有 `.invalid` 且获得焦点；`POST /v1/auth/login` 401。不要用真实账号连续失败 5 次（锁定 15 分钟）。

### L4 密码可见性

- 步骤：输入密码，点 `#togglePassword` 两次。
- 检查点：`#password.type` 在 `password`/`text` 间切换；**已知缺陷**：aria-label 始终为「显示密码」（WEB-R2-011）。

### L5 超长/特殊字符

- 步骤：用户名粘贴 396 字符 `a`；再粘贴 `<script>alert(1)</script>' OR 1=1 --`。
- 检查点：输入框内部滚动、表单不破版；无脚本执行；服务端 401 后仍显示统一错误文案。

### L6 正确登录

- 步骤：`admin/Adm1n!` 登录。
- 检查点：`#view-app` 可见；角色 chip = `平台管理员`；当前 crumb = `工作台`；管理导航可见。

### L7 退出后凭据残留（关键回归）

- 步骤：登录任意账号 → 点 `#logoutBtn` → 不输入任何内容再点 `#loginBtn`。
- 检查点：退出后 localStorage 中 `orca.access/refresh/user` 均为 null；`#username.value`/`#password.value` 应为空；**已知缺陷**：值被保留，直接点登录可恢复上一账号（WEB-R2-002）。修复后此路径应停留在登录页并显示空提交错误。

### L8 会话刷新/失效

- 步骤：`localStorage.orca.access='bad'`、`orca.refresh` 保留有效值 → reload → 应自动 refresh 并进入应用；再把两者都置为 `bad_*` → reload。
- 检查点：第一次 `POST /v1/auth/refresh` 200 并重试 `/v1/me`；第二次 refresh 401 → 回到登录页且 localStorage 清空。

## 3. 工作台

### W1 统计一致性

- 步骤：登录 admin，读取 `.stat` 四个值、`#content tbody tr` 数量、标题段落；同一时刻用页面内 fetch（带 Bearer）读取 `GET /v1/projects?includeArchived=1` 与 `/v1/policies/download`。
- 检查点：
  - 可访问项目 = `projects.length`；在线项目（D11 更名，原「主机在线」）= `hostStatus==='online'` 计数；禁用下载 = 生效策略为 deny 的计数；策略版本 = policy.version。
  - **已知缺陷**：`projects` 含 `status==='archived'`，统计被归档项目放大（WEB-R2-003）。取证快照：total 40 / archived 29 / online 30 / denied 5，DOM 40/30/5。

### W2 项目卡片与置灰语义

- 步骤：读取 `.project-card` 文本与按钮 `disabled/title`。
- 检查点：
  - 离线主机：卡片显示「主机离线」，打开 disabled，title=主机离线。
  - 维护中：显示「维护中」，打开与 Orca Web 均 disabled。
  - 无 open 权限（管理员未授权）：打开 disabled，title=`项目未授权给你，请先在「成员与权限」中授权`；同行为出现「授权并打开」。
  - Orca Web 仅在 `permissions.includes('open')` 时出现。

### W3 全部项目表

- 步骤：读取每行 `.actions .btn` 的 label/disabled/title。
- 检查点：与 W2 同一原因串驱动；`详情` 对管理员始终可用（离线/维护也可开）。

### W4 授权并打开（自授）

- 步骤：对 `管理员可见（未授权）` 且主机在线的项目点「授权并打开」。
- 检查点：弹框标题 `授权并打开`；正文包含 `open · terminal · agent · file:read · file:write` 与会话断开警告；此处只验证弹框，**不要确认**（会写 grant 并断开当前会话）。重放结束点「关闭」。

## 4. 我的项目

### P1 搜索

- 步骤：`#projectSearch` 依次输入 `zhang`、`dev-local-03`、`no-such-project-r2`、`<img src=x onerror=alert(1)>`。
- 检查点：按 name/repoUrl/hostName 大小写不敏感匹配；无匹配显示「没有匹配的项目」；无脚本执行；清空恢复全量。

### P2 登记项目：前端校验

- 空提交：四个字段分别显示：`项目名称不能为空。`、`项目 Key 长度必须为 1–64 个字符。`、`请选择目标主机。`、`项目路径不能为空。`；焦点落到 name。
- Key 失焦校验：
  - `PaymentService` → `项目 Key 必须以小写字母或数字开头…`
  - `qa-r2-probe.` → `项目 Key 不能是 “.” 或 “..”，也不能以 “.” 结尾。`
- 提交校验：
  - `work/qa-r2-probe` → `项目路径必须是绝对路径。`
  - `/…/projects/../demo-app` → `项目路径不能包含 “.” 或 “..” 段。`
  - `/tmp/qa-r2-probe/` → `项目路径不能以分隔符结尾。`
- 服务端映射：
  - Key 用已存在的 `demo-app` → 409 + `项目 Key 已存在。`（#regKeyError）
  - Path 用 demo-app 的现有路径 + dev-local-02 → 409 + `该主机目录下已存在同路径的项目。`（#regPathError）
  - 分支 `bad branch name` → 400 + `默认分支名不能包含空白或无效字符。`（#regBranchError）
  - 仓库 `not-a-valid-url` → **已知缺陷**：被接受并创建 failed 项目（WEB-R2-008）。重放时如创建，用 `POST /v1/projects/:id/archive` 清理。
- 主机下拉切换：显示 `主机项目根：<projectsRoot>`。

### P3 项目详情弹框

- 步骤：点 demo-app 详情，提取 `.dialog .body` innerText 与 `.foot .btn`。
- 检查点（admin，正常项目）：
  - 基本信息：名称/Key/ID（含复制）/创建者/创建时间/状态=就绪。
  - 运行配置：主机名+ID、宿主状态=在线、路径（复制）、仓库（未配置）、默认分支。
  - 授权与策略：我的权限 5 位；直接授权 4 行（team-payment 5、zhangsan 5、admin 5、lisi 2）；下载策略=禁止下载·项目覆盖；独立页链接。
  - 打开项目 enabled；Esc 关闭并将焦点还给「详情」按钮。
  - 失败项目：状态=准备失败 + 准备失败原因（CLONE_URL_INVALID…）。
  - 归档项目：状态=已归档，刷新返回 404 并显示「未能刷新项目信息」（并入 WEB-R2-003）。

### P4 内嵌工作区（打开）

- 步骤：demo-app 行点「打开」；读取 iframe `src` 与 Axe 树；等待 20 秒。
- 检查点：
  - 覆盖层标题 `项目工作区`，bar 显示项目名/分支/主机，含「← 返回 / 在新标签打开 Orca Web / 关闭」。
  - **已知缺陷**：iframe alert `工作区打开失败（NOT_SIGNED_IN）`；20 秒后失败壳 `工作区加载超时：20 秒内未收到就绪信号。`；重试仍失败（WEB-R2-001）。
  - 逃生路径：「在新标签打开 Orca Web」打开新标签并显示 Orca 工作区（Cloud project session / Registering the project...）。

## 5. 主机

### H1 列表

- 提取每行文本：名称/zone、直连地址、中继路由、`orcaVersion p<protocol>`、心跳、状态、详情。
- 检查点：状态词只应是 在线/离线/维护中/已吊销；空名称主机显示「(空) —」属缺陷（WEB-R2-006）；在线主机 orcaVersion 为空时显示 `· 协议 v3`（WEB-R2-007）。

### H2 注册主机

- 步骤：点「注册主机」。
- 检查点：弹层标题 `注册主机`；命令为 `bash <(curl -fsSL <origin>/install/host.sh?token=…)`；「复制命令」→ toast 已复制；Esc 关闭；token 一次性（重开生成新值）。

### H3 主机抽屉

- 步骤：dev-local-02 详情。
- 检查点：主机 ID/指纹/E2EE 公钥/版本/网络位置/直连地址/中继路由/能力/最近心跳；
  - 指纹应可核对（当前为占位 `host:<name>`，真实 TLS 指纹未展示，WEB-R2-007）。
  - 按钮文案：维护中显示「结束维护」，否则「进入维护模式」；已吊销时两按钮 disabled。
  - 关闭：头部 ✕ 或点击背景；**抽屉不响应 Esc**（WEB-R2-017），可用 `.drawer .icon-btn` 关闭。

### H4 维护模式（可逆）

- 步骤：点「进入维护模式」→ 主机列表状态=维护中 → 工作台 demo-app/zhangsan-demo 显示 维护中·管理员操作、打开与 Orca Web disabled → 回主机抽屉点「结束维护」。
- 检查点：恢复后状态=在线、项目可打开；API `status` 不再是 maintenance。
- 恢复：结束维护（如中断，重进抽屉点结束维护）。

### H5 下线确认（不执行）

- 步骤：点「下线主机」。
- 检查点：原生 confirm 文案 `确认下线该主机？`；取消后主机仍在线。**不要确认**（吊销不可逆）。

### H6 主机授权矩阵

- 步骤：抽屉内 `#hostGrantSubject` 空 → 添加（静默无反馈，WEB-R2-015）；输入 `no-such-group-r2` → toast `授予失败：组不存在或平台未见过该组。`
- 添加用户 lisi（用户类型）→ 行出现 provision 勾选；取消 provision → 行「未保存」+ 保存/放弃可用；放弃 → 恢复；再勾 maintain → 保存 → 确认弹框列出 `+新增 maintain` → 确认 → toast `已保存 1 项主机授权变更`。
- 切换策略 仅授权主体 → 保存 → 确认 → 再切回 开放 → 保存。
- 移除行 → toast 已移除。
- 恢复：移除 lisi 行、策略=开放（如中断，直接 PUT `/v1/hosts/:id/grants {permissions:[]}` 与 `/provision-policy {mode:'open'}`）。

## 6. 中继

- 步骤：读取表行；点「添加中继」→ 检查命令 `bash <(curl -fsSL <origin>/install/relay.sh)`、复制 toast；Esc 关闭；点「刷新」。
- 检查点：刷新后「最近注册时间」更新；行状态只有 在线/离线；客户端地址为 host:port。

## 7. 成员与权限

- 步骤：
  1. 左侧项目按钮逐个点击（`[data-material]`），读取 `#grantPanel` 表头 7 位：open/terminal/agent/file:read/file:write/browser/download。
  2. demo-app 添加授权：
     - 空主体 → 静默 no-op（WEB-R2-015）。
     - 用户 `nobody-qa-r2` → toast `授予失败：用户不存在。`
     - 用户 `lisi`（已存在，原 open+file:read）→ **已知缺陷**：行被覆盖为仅 open，提示仍「已授予」（WEB-R2-004）。
  3. 恢复 lisi：勾选 file:read → 行「未保存」→ 保存 → 确认弹框（`保存将断开 lisi 当前全部云会话`）→ 确认 → toast `已保存 1 项授权变更`。
  4. 组 `developers` 添加（默认 open）→ 再点该行移除 → toast 已移除。
- 检查点：草稿态（未保存徽标、保存/放弃启用）、放弃恢复服务端值、保存弹框列出增删位与影响范围、移除立即生效。

## 8. 审计日志

- 步骤与检查点：
  1. 默认：header `已显示 50 条`，行数 = 50，时间倒序。
  2. 事件 `login` → 查询：所有行 eventType=login。
  3. 结果 `failure` + 用户 `zhangsan` → 查询：行数 N（本次 3），全部为 login/失败/zhangsan；header 同步 N。
  4. 重置：筛选控件清空，header 回到 50。
  5. 「加载更早」：追加 50（header 100），首尾时间仍倒序，不重复已有行。
  6. traceId「复制」→ toast 已复制。
  7. 超长/特殊字符用户过滤 → 0 条 + 「没有事件」，无 XSS。
  8. **已知缺陷**：同一 traceId 的完全重复行（WEB-R2-010）；无 traceId 筛选（WEB-R2-016）。

## 9. 平台设置

- 步骤：
  1. 读取全局 radio（允许/禁止）、`当前版本 vN`、`#policyScope` 的跟随/覆盖计数、覆盖表行（项目、覆盖策略、当前生效）。
  2. 全局切换 禁止 → 保存 → toast `已保存，将随宿主心跳生效；跟随全局 X 个项目，独立覆盖 Y 个不受影响`；回工作台验证策略=禁止、项目徽标翻转为禁止；再切回 允许 → 保存。
  3. demo-app 覆盖 `禁止 → 允许`（行内即保存，toast 已保存项目下载策略，`当前生效` 同步）→ `跟随全局`（行消失、计数变化）→ **已知缺陷**：无法从 UI 重新新建覆盖（WEB-R2-009）。
- 恢复：demo-app 覆盖改回 `禁止`（如已选跟随全局，用 API `PUT /v1/projects/proj_4fb40a8b/policy {downloadPolicy:'deny'}`）；全局恢复为初始值（本次为 允许）。

## 10. 无权限页与非管理员

- 管理员点「查看无权限页」：`#content` 显示「无权访问」+「返回工作台」；返回后可回到工作台。**已知文案**：对管理员称「当前账号没有平台管理权限」（WEB-R2-013）。
- 非管理员：
  - 登录 zhangsan → 导航只有 工作台/我的项目；角色=开发者。
  - 工作台统计只含 ACL 内项目（本次 5 个）。
  - 我的项目：无「登记项目」、无「详情」、无「授权并打开」；只有打开/Orca Web。
  - 直接调用不存在的前端路由不可达（无 hash 路由）；管理页守卫由 `ADMIN_ROUTES` 在 navigate 时兜底。

## 11. 边界输入样本（复用）

| 场景         | 样本                                              | 期望                                      |
| ------------ | ------------------------------------------------- | ----------------------------------------- |
| 登录空/空白  | `""`、`"   "`                                     | 前端拦截，提示请输入域账号和密码          |
| 登录错误     | `qa_ghost_user_r2/WrongPass!123`                  | 401，统一错误文案                         |
| 项目 Key     | `PaymentService`、`qa-r2-probe.`、65 字符、`项目` | 三条 Key 规则分别命中                     |
| 项目路径     | `work/x`、`/a/../b`、`/tmp/x/`                    | 绝对/.. 段/尾分隔符错误                   |
| 仓库地址     | `not-a-valid-url`                                 | 当前被接受并 failed（缺陷）；修复后应拒绝 |
| 分支         | `bad branch name`                                 | BRANCH_INVALID                            |
| 搜索/过滤    | `<img src=x onerror=alert(1)>`、350 字符          | 无 XSS、空结果                            |
| 重复添加授权 | 已存在用户 lisi                                   | 应提示已存在，不得覆盖（缺陷）            |

## 12. 重放注意事项

- 不执行：确认「授权并打开」、确认「下线主机」、确认真实用户/组权限变更（如需执行，先记录原始值并立即还原）。
- 维护模式、全局/项目下载策略、临时授权都可逆；先读原值再操作。
- 认证/项目/审计统计随并发探针变化，断言用「同一时刻 DOM ↔ API」而非固定数字。
- 截图仅用于布局/视觉证据；数据/状态判定用文本提取。
