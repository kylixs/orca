# 业务链路图（验收与用例编写基线）

> 建立：2026-11-16（用户指令 §3h 强制门）。本次按 M1-M12 模块文档填充到步骤级。
> 基线提交：`664a91e0322`（M1-M12 共同基线；工作树 U106-R3 详情深链与 U112/U113 修复尚未提交，相关处标「在途」）。
> 每条链路：入口 → 步骤与状态迁移 → 失败分支 → 涉及 API/事件/存储 → 已有测试/探索路径 → 覆盖状态。
> 纪律：只记录**当前实现**；设计稿中的未落地行为一律标「未实现（U 号）」，不据此断言。

## 链路登记

| # | 链路 | 涉及模块 | 状态 |
| --- | --- | --- | --- |
| F1 | 登录与准入（含 LDAP 门/刷新续会话） | M1/M2 | ✅ 已填充 |
| F2 | 项目生命周期 | M3/M9/M10/M11 | ✅ 已填充 |
| F3 | 工作区进入与恢复（关页/F5/第 N 次） | M9/M10/M2 | ✅ 已填充 |
| F4 | 标签与终端生命周期（suspend/end/孤儿/ended） | M9/M10 | ✅ 已填充 |
| F5 | 授权变更 | M11/M3/M4/M7 | ✅ 已填充 |
| F6 | 审计查询与证据 | M7/M12 | ✅ 已填充 |
| F7 | 宿主接入 | M4/M12 | ✅ 已填充 |
| F8 | 中继接入与路由 | M5/M12 | ✅ 已填充 |
| F9 | 用户管理 | M6/M11 | ✅ 已填充 |
| F10 | 移动端 | —（U80 原型） | ⛔ 原型阶段，未实现 |

---

## F1 登录与准入（密码 → 锁定 → LDAP 分组门 → 会话签发；含刷新续会话）

### 1. 入口
- 未登录打开平台根地址 `/`（或会话恢复失败）→ 登录视图 `#view-login`（M1 §2）。
- 兼容入口 `#/login`：未登录显示登录页，已登录跳默认路由（M2 §2，U106 已落地）。
- 退出入口：侧栏用户盒「退出」（仅已登录）。
- 已登录且本地有 access token 时刷新/重开页面，走会话恢复而非登录页（M1 A8）。

### 2. 步骤与状态迁移
1. **输入域账号/密码并提交**：前端先 trim 非空校验 → `POST /v1/auth/login`（`username/password/deviceId/deviceName/devicePubKey:'web-client'`）→ 服务端 LDAP 校验 + 准入组闸门 → 返回 `accessToken/refreshToken/expiresIn/user/device`。可见反馈：按钮变「登录中…」并禁用，成功后进入主框架。［来源 m01-A2］
2. **会话落地**：写 `localStorage` 的 `orca.access`、`orca.refresh`、`orca.user`、`orca.device`；内存 `state` 持用户与权限。可见反馈：侧栏出现显示名/部门/角色 chip。［来源 m01-A2、m02 §4］
3. **进入主框架并恢复目标路由**：读启动时捕获的 hash；空 hash 或 `#/login` → `#/workbench`，其余 hash 原样恢复；非管理员直达管理路由 → 403 页且保留 URL。可见反馈：面包屑/导航高亮对应页面。［来源 m01-B4、m02-B4/B6］
4. **业务请求 401 → 静默续会话**：`api()` 发现 401 且有 refreshToken → `POST /v1/auth/refresh` → 服务端旋转 access+refresh → 重放原请求一次；refresh 失败 → `logout()` 回登录页。可见反馈：用户无感（失败才回登录页）。［来源 m01-A7］
5. **刷新/重开页面恢复**：有 access token → `GET /v1/me` 恢复用户并进主框架；仅缓存 user 无 token 不构成登录态。可见反馈：直接回到原 hash 页面或工作台。［来源 m01-A8、m02-B4］
6. **密码显示切换**：点击密码框眼睛图标，`password`/`text` 切换，不触发请求。［来源 m01-A6］
7. **退出**：向工作区 iframe 发 `logout`（不结束宿主 PTY）→ 尽力 `POST /v1/auth/logout`（撤销 session 并 bump epoch）→ 清空 access/refresh/user、清空登录框输入、隐藏错误 → 回登录页。可见反馈：登录页且输入为空。［来源 m01-A9］

**服务端状态机要点**：密码只经 LDAP adapter 校验（生产 LDAPS simple-bind；仓库内仅 Mock）；access TTL 30 分钟、refresh TTL 12 小时并每次旋转；refresh 重放撤销会话；锁定计数共享时跨副本累计，不可达则登录 503 fail-closed（m01 §3）。

### 3. 失败分支
1. **空账号或空密码** → 客户端拦截，不发请求，账号/密码框标红，行内「请输入域账号和密码。」，焦点回账号框。用户动作：补齐后重试。［来源 m01-A1］
2. **密码错误** → `401 INVALID_CREDENTIALS`，失败计数 +1；行内「账号或密码错误，请重试。」，密码框标红聚焦。用户动作：重新输入。［来源 m01-A3］
3. **连续 5 次失败** → `423 ACCOUNT_LOCKED`（默认 15 分钟）；显示「连续 5 次失败，账号已锁定 15 分钟。」；锁定期间再试直接 423 并记 `login/failure reason=locked`。用户动作：等待 15 分钟或联系管理员。［来源 m01-A4］
4. **账号不在 LDAP 准入组** → `401 LDAP_GROUP_NOT_ADMITTED`（adapter filter miss 与平台闸门同码同文案）；写 `login/failure reason=ldap_group_denied`；**不计数也不清锁定**。显示「账号未加入平台准入组。」。用户动作：申请入组后重试。［来源 m01-A5］
5. **锁定服务不可达** → 登录 `503 PLATFORM_UNAVAILABLE`（fail-closed）。用户动作：稍后重试/联系管理员；界面无专门中文映射（仅服务端语义）。［来源 m01 §3 锁定计数］
6. **refresh 失败** → 直接本地登出回登录页（不保留半登录态）。用户动作：重新登录。［来源 m01-A7］
7. **`GET /v1/me` 失败（含 refresh 后仍 401）** → 清 access、移除缓存 user、显示登录页；仅缓存 user 不足以进入。用户动作：重新登录。［来源 m01-A8］
8. **登出请求失败** → 错误被吞，本地仍清空并回登录页。用户动作：无（本地已退出）。［来源 m01-A9］

### 4. 涉及 API / 事件 / 存储
| 面 | 内容 |
| --- | --- |
| API | `POST /v1/auth/login`、`POST /v1/auth/refresh`、`POST /v1/auth/logout`、`GET /v1/me` |
| 事件 | `login` success/failure（`INVALID_CREDENTIALS`/`locked`/`ldap_group_denied`）、denied 审计族 |
| 存储 | 浏览器 `orca.access`/`orca.refresh`/`orca.user`/`orca.device`；平台 `store.users`、会话/锁定计数（共享服务或进程内） |
| 配置 | `ORCA_CLOUD_ACCESS_TTL_MS`、`ORCA_CLOUD_REFRESH_TTL_MS`、`ORCA_CLOUD_LDAP_REQUIRED_GROUP`/`ldapRequiredGroup`、`ORCA_CLOUD_LOGIN_LOCKOUT_URL` |

### 5. 已有测试 / 探索路径
- 测试：[ldap-admission.test.ts](../../../../cloud-platform/test/ldap-admission.test.ts)、[ldap-mock-required-group.test.ts](../../../../cloud-platform/test/ldap-mock-required-group.test.ts)、[ldap-admission.e2e.test.ts](../../../../cloud-platform/test/e2e/ldap-admission.e2e.test.ts)、[login-lockout-shared.e2e.test.ts](../../../../cloud-platform/test/e2e/login-lockout-shared.e2e.test.ts)、[session-renewal.e2e.test.ts](../../../../cloud-platform/test/e2e/session-renewal.e2e.test.ts)、[web-exploratory-fixes.e2e.test.ts](../../../../cloud-platform/test/e2e/web-exploratory-fixes.e2e.test.ts)（M116-QA-012 空提交零请求、R5-① 退出清空凭据）、[web-admin-gating.e2e.test.ts](../../../../cloud-platform/test/e2e/web-admin-gating.e2e.test.ts)、[u106-console-routing.e2e.test.ts](../../../../cloud-platform/test/e2e/u106-console-routing.e2e.test.ts)（登录回跳、深链刷新）。
- 探索：[web-console-paths.md](../../../../cloud-platform/scripts/exploratory-r2/web-console-paths.md) L1-L8（空提交/错误凭据/密码可见性/正确登录/退出残留/会话刷新）；[api-paths.md](../../../../cloud-platform/scripts/exploratory-r2/api-paths.md) A1-A16（登录/刷新/登出边界）。

### 6. 覆盖状态
- 正常步骤 **7**，已覆盖 **7**（S4 浏览器 401→refresh→单请求重放已由 T05 新增用例钉住，`session-renewal.e2e.test.ts`；并行 401 竞态另见 G28；S6 密码切换由 U54 WEB-R2-011 e2e 覆盖（web-exploratory-fixes :838-854））。
- 失败分支 **8**，已覆盖 **5**（E1/E2/E3/E4/E5）；未覆盖：E6 refresh 失败 UI、E7 仅缓存 user 路径、E8 登出失败静默。
- 已知未实现：无（登录链路本身已实现）；U103 属工作区侧刷新，不在本链路。

---

## F2 项目生命周期（创建向导 → 授权 → 打开 → 工作区 → 归档/失败重试）

### 1. 入口
- 「我的项目」：侧栏导航 / `#/projects`（M2/M3）。
- 「登记项目」：我的项目页头按钮（仅 `platform:admin`）。
- 「详情」：列表行内 / 工作台行内（仅管理员）。
- 「打开」：行内/工作台卡片/详情主按钮；「Orca Web」：行内新标签。
- 归档/恢复：**控制台无入口**，仅 API `POST /v1/projects/:id/archive|restore`（M3 §2）。

### 2. 步骤与状态迁移
1. **进入我的项目**：并发 `GET /v1/projects`（ACL 过滤、默认排除归档）+ `GET /v1/policies/download` → 渲染表格与生效下载策略。可见反馈：列表/空态「没有匹配的项目」。［来源 m03-C1、m02 §3］
2. **打开登记弹框**：拉 `GET /v1/hosts`（排除已吊销，标注离线/维护）→ 渲染字段与主机下拉。可见反馈：弹框打开；拉取失败 toast「打开登记弹层失败：…」。［来源 m03-C4］
3. **填写与即时校验**：项目 Key 失焦按提交同款规则校验；切换目标主机清空已填路径并刷新「主机项目根」提示；字段错误各自行内展示。可见反馈：字段标红/清错。［来源 m03-C5/C6］
4. **提交创建（无 repoUrl）**：客户端校验通过 → `POST /v1/projects` → 弹框关闭、toast「项目已登记…授权请在项目详情的『权限』页签中配置。」→ 重绘列表；状态 `ready`。［来源 m03-C8］
5. **提交创建（有 repoUrl）**：同上，toast 追加「克隆中，就绪后可打开」；状态 `provisioning`；宿主心跳下行指派克隆并回报，成功后 `ready`，失败写 `provisioningError` 并在详情显示「准备失败」。［来源 m03-C9、m12 §4 心跳 provisioned[]］
6. **查看详情**：弹框先渲染列表缓存行，再并发刷新项目/grants/下载策略/主机 grants；信息页展示基本信息、运行配置、授权与策略；权限页三卡片。可见反馈：黄条仅项目 GET 失败时出现；主按钮随可打开性更新。［来源 m03-C13/C14］
7. **配置项目授权**：权限页「查看」「控制」卡添加主体/移除芯片 → `PUT /v1/projects/:id/grants` 整行替换 → toast 级别变化并重绘；「管理」卡为只读主机推导。［来源 m03-C16/C17、m11 §4.2］
8. **打开项目**：`POST /v1/projects/:id/web-handoff {surface:'admin'}` → 同页 iframe 覆盖层（老平台非 `cloud-admin.html` 时新标签 + toast）。可见反馈：覆盖层状态「准备中→就绪」、路由/延迟。［来源 m03-C11、m02-B11/B12］
9. **进入工作区使用**：bootstrap 后标签/终端/文件树/Git 可用；宿主标签与终端内容按 M9/M10 恢复。可见反馈：工作区 ready、状态栏路线/分支/未保存数。［来源 m09 §3、m10 §3］
10. **关闭工作区**：脏文件先确认；「结束工作区」按宿主能力显示并走 end 清理（现状见 F4 E7）。可见反馈：覆盖层移除、回原路由。［来源 m03-C11、m10 §3.3］
11. **归档 / 恢复（仅 API）**：归档后从 `/v1/projects` 消失（管理员 `includeArchived=1` 可取回），撤销该项目全部凭证并释放 key/路径；详情 GET 归档项目 404。控制台**未实现**归档/恢复 UI（M3 §7）。［来源 m03-C21］

### 3. 失败分支
1. **客户端字段校验失败** → 不发请求；所有错误字段标红并列出，焦点到首个错误（名称空/超 200、Key 非法、主机未选、路径非绝对/含 `..`/尾分隔符）。用户动作：按行内规则修正。［来源 m03-C7］
2. **服务端字段错误** → 按错误码落字段（`HOST_NOT_FOUND`→主机、`PROJECT_EXISTS`→Key、`PROJECT_PATH_TAKEN|INVALID`→路径、`REPO_URL_INVALID`→仓库、`BRANCH_INVALID`→分支），其余顶部兜底；弹框不关、输入保留、按钮恢复。用户动作：改字段重试。［来源 m03-C10］
3. **主机离线/维护/项目归档** → 行内「打开」「Orca Web」disabled 并在 title 给原因（已归档/主机维护中/主机离线/管理员未授权）；详情仍可开。用户动作：等主机恢复/先授权。［来源 m03 §1、m02-B12］
4. **handoff 签发失败** → 覆盖层失败态（重试 / 新标签）；20 秒未就绪 → 超时态，最多重试 2 次。用户动作：重试或改用新标签 Orca Web。［来源 m03-C11、workspace-paths P20］
5. **克隆/准备失败** → 心跳回报 `provisioningError`，详情状态「准备失败」并显示原因。用户动作：检查仓库地址/分支后重建或归档。［来源 m03-C9、m12 §4］
6. **授权写失败** → toast「授予/移除失败：…」，输入保留，请求期间控件冻结后恢复；主体已有行先弹覆盖确认。用户动作：修正主体或位组合后重试。［来源 m03-C16/C17、m04-D11/D12］
7. **非管理员登记** → 接口 403 + denied 审计，入口不渲染。用户动作：联系管理员。［来源 m03 §2］
8. **归档后可见性** → 列表默认排除归档（U53③ 已修）；详情 GET 返回 404，不泄漏存在性；API 归档对非创建者/非管理员返回 404。用户动作：管理员用 `includeArchived=1` 或 API 恢复。［来源 m03-C21、m02-B16］

### 4. 涉及 API / 事件 / 存储
| 面 | 内容 |
| --- | --- |
| API | `GET /v1/projects`（`includeArchived`）、`GET/POST /v1/projects`、`GET /v1/projects/:id`、`GET/PUT /v1/projects/:id/grants`、`POST /v1/projects/:id/web-handoff`、`POST /v1/projects/:id/archive|restore`、`GET /v1/hosts`、`GET /v1/policies/download` |
| 事件 | `project_create`、`web_handoff`、`grant_update`、`project_archive/restore`、denied 族 |
| 存储 | `store.projects`（`status: provisioning|ready|failed|archived`、`provisioningError`、key/path）、项目 claims/凭证（归档撤销）、iframe 消息 `ready/dirty/closed/suspended/ended` |

### 5. 已有测试 / 探索路径
- 登记/校验：[web-project-registration.e2e.test.ts](../../../../cloud-platform/test/e2e/web-project-registration.e2e.test.ts)、[project-registration-validation.e2e.test.ts](../../../../cloud-platform/test/e2e/project-registration-validation.e2e.test.ts)、[project-branch-validation.e2e.test.ts](../../../../cloud-platform/test/e2e/project-branch-validation.e2e.test.ts)。
- 详情/入口：[web-project-detail.e2e.test.ts](../../../../cloud-platform/test/e2e/web-project-detail.e2e.test.ts)、[web-project-entry.e2e.test.ts](../../../../cloud-platform/test/e2e/web-project-entry.e2e.test.ts)、[web-admin-self-grant.e2e.test.ts](../../../../cloud-platform/test/e2e/web-admin-self-grant.e2e.test.ts)。
- 打开/覆盖层：[u46-1-platform-contract.e2e.test.ts](../../../../cloud-platform/test/e2e/u46-1-platform-contract.e2e.test.ts)、[u46-3-overlay.e2e.test.ts](../../../../cloud-platform/test/e2e/u46-3-overlay.e2e.test.ts)、[web-handoff.e2e.test.ts](../../../../cloud-platform/test/e2e/web-handoff.e2e.test.ts)。
- 生命周期/就绪/归档：[project-connect-readiness.e2e.test.ts](../../../../cloud-platform/test/e2e/project-connect-readiness.e2e.test.ts)、[provision-assignment-downlink.e2e.test.ts](../../../../cloud-platform/test/e2e/provision-assignment-downlink.e2e.test.ts)、[project-archive.e2e.test.ts](../../../../cloud-platform/test/e2e/project-archive.e2e.test.ts)、[project-update.e2e.test.ts](../../../../cloud-platform/test/e2e/project-update.e2e.test.ts)。
- 探索：[web-console-paths.md](../../../../cloud-platform/scripts/exploratory-r2/web-console-paths.md) P1-P4/W2-W4；[workspace-paths.md](../../../../cloud-platform/scripts/exploratory-r2/workspace-paths.md) P1/P19/P20/P23。

### 6. 覆盖状态
- 正常步骤 **11**，已覆盖 **9**（S3 主机切换清路径无专门断言；S5 `provisioning→ready` 浏览器 UI 未覆盖；S11 归档 UI 未实现，仅 API）。
- 失败分支 **8**，已覆盖 **8**（E1-E8；E5/E8 含 API 层）。
- 未实现：归档/恢复控制台入口（M3 §7，无 U 号；仅 API）。

---

## F3 工作区进入与恢复（关闭重开 / F5 / 第 N 次打开）

### 1. 入口
- 管理台项目行「打开」→ `POST /v1/projects/:id/web-handoff {surface:'admin'}` → 同页覆盖层（M3/M9）。
- Orca Web：`web-index.html?api=<平台>&project=<id>`；一次性 `#handoff=<code>&project=<id>` 进入后立即抹除 code（M9 §2，U106 W1）。
- 简易工作区嵌入页：`cloud-admin.html?embed=1&project=<id>`（宿主侧，管理台 iframe 承载）。
- 刷新/重开同一 URL；第 N 次从管理台再次打开同一项目。
- `#/workspace/<id>` 顶层覆盖层路由：**未实现（U106 R4）**；当前该 hash 无 renderer，回落工作台（M2 §2）。

### 2. 步骤与状态迁移
1. **管理台发起打开**：mint 一次性 handoff（同页 `surface:'admin'`）→ 创建全屏覆盖层与 iframe。可见反馈：覆盖层「准备中」，顶栏项目名/分支。［来源 m03-C11］
2. **嵌入页兑换与 bootstrap**：读 hash → 立即从地址栏抹掉 handoff → 兑换会话 → `workspace.info` 解析 project/workspace/perms/capabilities → `repo.add` 注册项目根 → `project.provision`/`worktree.list`/`worktree.createManaged`（幂等）→ `activateWorkspace`（`file:read` 决定是否挂 Explorer）。可见反馈：ready / fallback 横幅。［来源 m09 §3.1、m10 §2］
3. **宿主标签镜像与收养**：能力协商 `cloud.session-tabs-restore.v1` → `session.tabs.list/listAll/subscribe` 拉宿主镜像 → `applyWebSessionTabsSnapshot` → `adoptHostLayout` 每次进入工作区收养一次（U104 已修）→ 之后 client-owned。可见反馈：终端标签组/active/layout 出现。［来源 m09 §3.2］
4. **终端内容回放**：订阅初始快照（512 KiB / 1000 行，客户端可请求至 2 MiB，超限 `truncated`）；PTY 已死/宿主重启显示「会话已结束（宿主已重启或终端已退出）」+ 同标签一键重开。可见反馈：历史输出可见、无空白假活。［来源 m09 §3.3］
5. **关闭工作区**：脏文件先走三选确认；关闭握手后覆盖层移除、回原路由，宿主 PTY 按 suspend 语义保留（显式 end 见 F4）。可见反馈：覆盖层消失、路由不变。［来源 m03-C11、workspace-paths P18］
6. **F5 刷新（当前能力边界）**：简易工作区/Orca Web 凭持久会话 `resumeWebCloudSession` 静默续会话并回到同一 project（`?api&project` 保留）；**管理台覆盖层刷新仍回落工作台、覆盖层丢失——未实现（U106 R4）**。可见反馈：嵌入页/Orca Web 回到工作区；管理台回工作台。［来源 m09 §3.4、m02 §2、U106 §1 #5］
7. **第 N 次打开同一项目**：`adoptHostLayout` 每次进入收养宿主镜像组/active/layout；客户端已有本地组后宿主 layout 不再覆盖。可见反馈：标签组按宿主真源恢复。［来源 m09 §3.2/§3.4、U104 `b50c241e699`］
8. **深链刷新（设计目标）**：项目级 `?api&project` 是当前唯一页面级恢复载体；标签级 URL、管理台 `#/workspace/:id`、筛选入 URL 均**未实现（U106 R4/R5、W2/W3）**。［来源 m02 §5、m09 §5、U106 §1］

### 3. 失败分支
1. **handoff 已用/过期/无权限** → `HANDOFF_GONE`/`PROJECT_FORBIDDEN`/`network_error` 对应文案，保留登录入口。用户动作：重新从平台打开或登录后打开。［来源 m09 §2］
2. **20 秒未就绪** → 覆盖层超时态「工作区加载超时：20 秒内未收到就绪信号」，可重试（最多 2 次）/新标签逃生。用户动作：重试或「在新标签打开 Orca Web」。［来源 m03-C11、workspace-paths P20］
3. **旧宿主无 capabilities** → 视为不支持标签恢复，客户端**零 `session.tabs.*` 探测**，降级为无恢复的工作区。用户动作：无（可升级宿主）。［来源 m09 §3.1、m12 §6］
4. **project 不可见 / 无 open** → 设计要求「无法打开该项目」403/404 且不静默换项目；**未实现（U106 W3/C12）**；当前经验路径为 handoff 失败/登录表单。用户动作：登录有权限账号或联系管理员。［来源 U106 §3.2、workspace-paths P22］
5. **刷新后覆盖层/标签丢失（管理台）** → 回工作台、弹框/覆盖层消失；未实现（U106 R4）。用户动作：重新进入项目。［来源 m02 §7、U106 §1 #5］
6. **二次打开 `NOT_SIGNED_IN`（历史缺陷 U104）** → 已修为每次进入收养；当前回归由 reentry 套件覆盖。用户动作：清除边缘 origin site data 曾是可恢复手段，现不应复现。［来源 workspace-paths P19、m09 §5 U104］
7. **订阅断流** → 当前有重连状态文案，**退避重连未实现（U112 D5）**。用户动作：手动重开标签/刷新。［来源 m09 §3.3、m10 §5］
8. **文件/编辑器标签不恢复** → 用户裁定接受（U100 方案 a），仅终端标签+分组+内容恢复；验收不得按设计字面判失败。［来源 m09 §5、U100］

### 4. 涉及 API / 事件 / 存储
| 面 | 内容 |
| --- | --- |
| 平台 | `POST /v1/projects/:id/web-handoff`、`POST /v1/projects/:id/connect`、`POST /v1/auth/refresh`、`GET /v1/projects` |
| 宿主 RPC | `workspace.info`、`repo.add`、`project.provision`、`worktree.list/createManaged`、`session.tabs.*`、`terminal.list/adoptOrphans/create/close/subscribe` |
| 存储 | 浏览器 `orca.webCloudSession`（按 apiUrl 隔离）、device key；宿主 workspaceSession/标签 inventory；内存 capability 缓存（environmentId+revision） |

### 5. 已有测试 / 探索路径
- 测试：[cloud-golden-journey-orca-web.spec.ts](../../../../tests/e2e/cloud-golden-journey-orca-web.spec.ts)、[cloud-golden-journey-git-and-restart.spec.ts](../../../../tests/e2e/cloud-golden-journey-git-and-restart.spec.ts)（reload 同路径/零 login-handoff）、[web-cloud-handoff-entry.e2e.test.ts](../../../../src/renderer/src/web/web-cloud-handoff-entry.e2e.test.ts)、[web-cloud-session-renewal.e2e.test.ts](../../../../src/renderer/src/web/web-cloud-session-renewal.e2e.test.ts)、[web-cloud-session-resume.test.ts](../../../../src/renderer/src/web/web-cloud-session-resume.test.ts)、[web-cloud-workspace-location.test.ts](../../../../src/renderer/src/web/web-cloud-workspace-location.test.ts)、[web-session-tabs-reentry-host-adoption.test.ts](../../../../src/renderer/src/runtime/web-session-tabs-reentry-host-adoption.test.ts)、[cloud-simple-workspace.e2e.test.ts](../../../../src/renderer/src/cloud-admin/cloud-simple-workspace.e2e.test.ts)。
- 探索：[workspace-paths.md](../../../../cloud-platform/scripts/exploratory-r2/workspace-paths.md) P1/P18/P19/P20/P21/P22/P23；[desktop-paths.md](../../../../cloud-platform/scripts/exploratory-r2/desktop-paths.md) Path B/F。
- 证据：[u104/](../../../../evidence/u104/)、[u113 相关报告](../test-reports/)。

### 6. 覆盖状态
- 正常步骤 **8**，已覆盖 **6**（S6 仅嵌入页/Orca Web 覆盖，管理台覆盖层刷新未实现；S8 深链目标未实现）。
- 失败分支 **8**，已覆盖 **4**（E1/E2/E3/E6），未实现 **3**（E4/E5/E7），未覆盖 **1**（旧宿主真机矩阵）。
- 未实现：管理台 `#/workspace/<id>`（U106 R4）、刷新恢复覆盖层（U106 R4）、project 403/404 视图（U106 W3）、标签级 URL（U106 W2/W3）、断流退避（U112 D5）。

---

## F4 标签与终端生命周期（新建 → attach → 输入共享 → 关闭 → suspend/end → 孤儿/ended）

### 1. 入口
- 简易工作区标签条「+ 终端」（管理台覆盖层 iframe 内）。
- 文件树点文件 → 文件/预览/Diff 标签。
- 关闭标签「✕」；覆盖层「关闭」/「结束工作区」；平台「退出」。
- 刷新/第 N 次进入触发宿主标签镜像与孤儿认领。

### 2. 步骤与状态迁移
1. **新建终端**：客户端本地先加终端标签（`terminal-<uuid>` + 裸 leaf UUID）→ 宿主支持则 `terminal.create` → `session.tabs.activate`；宿主不支持/失败保留本地标签并降级一次、不重试。可见反馈：新终端标签与面板。［来源 m10 §3.1、m09 §3.2］
2. **attach / 订阅回放**：终端订阅声明 `desktopViewportClaims:1` 被动观察（U98）；订阅快照按 512 KiB/1000 行回放，超限标 `truncated`。可见反馈：历史输出、状态「实时/重连中」。［来源 m09 §3.3、m10 §3.2］
3. **输入共享**：输入经宿主 PTY 执行并回显到同一 terminal handle 的订阅端；同一宿主 PTY 可被多个视图订阅。可见反馈：输入即回显（多端为同一 PTY 视图）。［来源 m10 §3.1/§3.2、workspace-paths P15、exploratory-r5 P3'］
4. **激活标签**：本地 activate；宿主型终端额外 `session.tabs.activate`（仅用户手势，应用宿主帧时不回写，防回环）。可见反馈：active 标签与面板切换。［来源 m10 §3.1］
5. **关闭标签**：宿主型先 `session.tabs.close`，成功才移除本地标签；文件/Diff 本地 reducer，dirty 时进未保存确认。可见反馈：标签移除、邻接激活。［来源 m10 §3.1、workspace-paths P14/P16］
6. **suspend（覆盖层收起/legacy close/logout）**：面板 unmount 策略 `leave-running`——销毁 xterm/流/socket 但**保留宿主 PTY**，回复 `suspended`/`closed`。可见反馈：覆盖层收起/工作区不可见，PTY 仍在宿主存活。［来源 m10 §3.3］
7. **end（显式结束工作区）**：`intent='ending'` → `runEndCleanup()`（注册的 closeAll）→ 关项目 socket → 回复 `ended`；目标同时关闭宿主承接 PTY 并退役 inventory 行。**现状未实现（U112 D1，修令在工作树未提交）**：HEAD 仅执行面板 close-on-unmount，不关闭 attached/reopened PTY、不退役行。［来源 m10 §3.3］
8. **孤儿恢复**：投影后收集 `pending-handle` 且带 `ptyId` 的终端行（每 tab 首个 leaf，上限 64）→ `terminal.list`（`requireFreshPtyLiveness:true`）按 ptyId 匹配 → 需宿主见证 + incarnation 才 `terminal.adoptOrphans`；失败静默降级，每 bootstrap 一次。可见反馈：重进后终端内容接续。［来源 m10 §3.4］
9. **ended 态**：PTY 已死/宿主重启时显示明确「会话已结束（宿主已重启或终端已退出）」+ 同标签一键重开，不显示空白假活。可见反馈：结束提示与重开按钮。［来源 m09 §3.3］

### 3. 失败分支
1. **关闭被拒** → `refused`（`live-host-pty`/`retirement-owner`/`stale-*`/`unknown-liveness`）保留标签并显示宿主提示条。用户动作：根据提示稍后重试/停止占用。［来源 m10 §3.1］
2. **连接不可用** → `local` 走本地关闭并提示「连接不可用」。用户动作：重连后重开。［来源 m10 §3.1］
3. **pending-handle 永不过渡 ended** → **未实现（U112 D2）**：无法到达「重开显式已结束」。用户动作：关闭标签重开（绕行）。［来源 m10 §3.3/§5］
4. **尺寸冲突** → 宿主回报冲突时渲染 `CloudTerminalFitOverlay`（另一窗口/手机控制；保持现状/使用本窗口尺寸/恢复），支持自动恢复文案。用户动作：选择保持或接管尺寸。［来源 m10 §3.2］
5. **订阅断流** → 有重连状态文案，**无退避重连（U112 D5，未实现）**。用户动作：手动刷新/重开。［来源 m10 §5］
6. **终端数量上限** → 第 7 个禁用，「最多 6 个终端」；关闭一个后恢复。用户动作：先关再建。［来源 workspace-paths P15］
7. **未保存文件关闭** → 三选「保存/放弃/取消」；取消保留 tab+buffer，放弃不落盘，保存后关。用户动作：选择处理方式。［来源 m10 §1、workspace-paths P16］
8. **宿主不支持新建终端** → 本地标签保留、降级一次不重试。用户动作：升级宿主/改用支持环境。［来源 m10 §3.1］
9. **多标签组恢复超时** → `session.tabs.move` 云端曾超时（U99），2 组恢复未最终验证；修令已派。用户动作：暂无（待修复）。［来源 m09 §3.2、U99］

### 4. 涉及 API / 事件 / 存储
| 面 | 内容 |
| --- | --- |
| 宿主 RPC | `terminal.create/close/subscribe/list/adoptOrphans`、`session.tabs.list/listAll/subscribe/subscribeAll/activate/close/move`、`file.*`、git 相关 |
| 宿主流 | 终端快照/增量、fit override 事件、`ready/dirty/closed/suspended/ended` postMessage |
| 存储 | 宿主 workspaceSession / 标签 inventory（真源）；浏览器**不持久标签**；PTY 存活由宿主见证 |

### 5. 已有测试 / 探索路径
- 组件/状态：[cloud-simple-workspace-tabs.test.ts](../../../../src/renderer/src/cloud/cloud-simple-workspace-tabs.test.ts)、[cloud-simple-workspace-session-tabs.test.ts](../../../../src/renderer/src/cloud/cloud-simple-workspace-session-tabs.test.ts)、[cloud-simple-workspace-orphan-recovery.test.ts](../../../../src/renderer/src/cloud/cloud-simple-workspace-orphan-recovery.test.ts)、[cloud-terminal-panel.test.tsx](../../../../src/renderer/src/cloud/cloud-terminal-panel.test.tsx)、[cloud-terminal-replay-boundary.test.tsx](../../../../src/renderer/src/cloud/cloud-terminal-replay-boundary.test.tsx)、[cloud-admin-embed.test.tsx](../../../../src/renderer/src/cloud/cloud-admin-embed.test.tsx)。
- e2e：[cloud-simple-workspace.e2e.test.ts](../../../../src/renderer/src/cloud-admin/cloud-simple-workspace.e2e.test.ts)、[cloud-simple-workspace-dual-client.e2e.test.ts](../../../../src/renderer/src/cloud-admin/cloud-simple-workspace-dual-client.e2e.test.ts)、[cloud-admin-session.e2e.test.ts](../../../../src/renderer/src/cloud-admin/cloud-admin-session.e2e.test.ts)。
- 探索：[workspace-paths.md](../../../../cloud-platform/scripts/exploratory-r2/workspace-paths.md) P14/P15/P16/P17/P18/P19/P23；[exploratory-r5-paths.md](../../../../cloud-platform/scripts/exploratory-r2/exploratory-r5-paths.md) P3'（填满/resize/回显徽标）。

### 6. 覆盖状态
- 正常步骤 **9**，已覆盖 **7**（S7 end 未实现 U112 D1；S3 多端输入仅同 PTY 回显，跨客户端并发输入未专门验证）。
- 失败分支 **9**，已覆盖 **6**（E1/E2/E4/E6/E7/E8），未实现 **2**（E3 U112 D2、E5 U112 D5），未闭合/未覆盖 **1**（E9 U99 多组真机复验）。
- 未实现：end 关闭宿主 PTY/退役行（U112 D1）、pending→ended（U112 D2）、断流退避（U112 D5）。

---

## F5 授权变更（三卡片位置即权限 → 降级断会话 → 审计落链）

### 1. 入口
- 项目详情弹框「权限」页签（`#/projects/<id>?tab=perms` 深链未实现，R3 在途；当前仅弹框内切换）。
- 主机详情抽屉「权限」页签（`#/hosts/<id>?tab=perms` 深链未实现，R3 在途）。
- 用户管理详情弹框角色下拉（全局角色，F9）。

### 2. 步骤与状态迁移
1. **打开授权面板**：项目详情弹框 / 主机抽屉先渲染缓存，再异步 `GET /v1/projects|hosts/:id/grants` 填充三卡片。可见反馈：卡片与主体数、脚注「变更即时保存…降级保存将断开该主体当前全部云会话」。［来源 m03-C13、m04-D6、m11 §2/§4.2］
2. **选择主体**：用户/组切换 datalist，数据来自 `GET /v1/directory`；未知主体提交后由平台文案拒绝。可见反馈：输入建议项。［来源 m03-C16、m04-D11］
3. **添加到卡片**：把卡片位并集进该主体整行 → `PUT .../grants` 整行替换 → 成功 toast 合成级别并重绘。可见反馈：新芯片/级别徽标。［来源 m03-C16、m04-D11］
4. **同主体已有行** → 弹「覆盖现有授权」确认（显示级别变化与会话断开提示）→ 确认后才写入。可见反馈：确认弹框；取消零请求。［来源 m03-C16、m04-D11、web-exploratory R5-③］
5. **移除芯片**：从该行减去卡片位并 `PUT`；剩余非空 → toast 级别变化并重绘；剩余为空 → 「移除全部授权」确认（用户/组爆炸半径文案不同）。可见反馈：确认/提示。［来源 m03-C17、m04-D12］
6. **有效权限生效**：`effectiveProjectPermissions` 按 `hostBits` 计算——主机 `view+provision`=全权（六操作位）、仅 `view`=只读上限 `open+file:read`、无位=项目行原样；`canCreateProjectOnHost = admin || provision`；connect 时写入票据 `perms`，宿主按方法映射拒绝。可见反馈：项目内可用操作/宿主拒绝。［来源 m11 §4.3］
7. **降级断会话**：角色降级（admin→非 admin）或授权收缩后，服务端撤销该主体凭证（≤60 秒心跳闭环）；页面确认文案声明断会话。可见反馈：被降级用户下一请求失去权限/被踢回。［来源 m06-3.10、m11 §4.2］
8. **审计落链**：成功写 `grant_update`/`host_grant_update`/`role_update`；拒绝写同名 denied + `host_grant_read` 等。可见反馈：审计页可按事件类型检索（F6）。［来源 m11 §4.3/§6、m12 §8］
9. **管理员自授打开**：管理员无 `open` 时行内「授权并打开」→ 确认（5 位 + 断会话警告）→ `PUT grants` 自授 → 打开。可见反馈：确认框/toast「已授权，正在打开…」。［来源 m03-C12、m02-B13］

### 3. 失败分支
1. **未知组/用户或非法权限位** → 平台文案 toast，输入保留，控件冻结后恢复。用户动作：换主体或修正位组合。［来源 m03-C16、m04-D11、AA4］
2. **写请求失败** → toast「授予/移除失败：…」，随后重拉 GET 重绘服务端真值；输入保留。用户动作：重试。［来源 m03-C16/C17、m04-D11/D12］
3. **非管理员调用** → 主机 grants 端点 admin-only、项目 grants admin/owner；403 + denied 审计，页面入口不渲染。用户动作：联系管理员。［来源 m11 §4.2］
4. **管理员无 open** → 打开 disabled + title「项目未授权给你…」，提供「授权并打开」自授入口；取消零请求。用户动作：自授或请他人授权。［来源 m02-B13、AA5］
5. **主机只读上限** → 只读主体的项目内有效位强制裁剪为 `open+file:read`，即使项目行授予 terminal/file:write 也不进票据。用户动作：需终端/写文件须主机侧升到 `view+provision`。［来源 m11 §4.3］
6. **项目授权不扩大主机** → 项目级授权不产生主机可见性/创建/维护；仅 `provision`/`maintain` 混合位不推导项目可见性。用户动作：主机级授权需在主机抽屉办理。［来源 m11 §4.3］
7. **降级断会话端到端** → 角色降级已覆盖；主机授权收缩触发凭证撤销的完整链路未闭合（U65 C10）。用户动作：暂无（待修复）。［来源 m11 §5/§8、U65］
8. **审定二「位置即权限 · 层级单卡」** → **未实现（U67/U67b）**：当前仍是位并集 + 合成徽标 + 同主体可出现在多张卡。验收不得宣称层级单卡。［来源 m11 §5］

### 4. 涉及 API / 事件 / 存储
| 面 | 内容 |
| --- | --- |
| API | `GET/PUT /v1/projects/:id/grants`、`GET/PUT /v1/hosts/:id/grants`、`PUT /v1/hosts/:id/provision-policy`、`GET /v1/directory`、`PUT /v1/users/:id/roles`、`POST /v1/projects/:id/connect` |
| 事件 | `grant_update`、`host_grant_update`、`host_grant_read`、`host_provision_policy_update`、`role_update`、`method_denied` + denied 族 |
| 存储 | `Grant {projectId,subjectType,subjectId,permissions[]}`、`HostGrant {hostId,subjectType,subjectId,permissions[]}`、`User.roleOverride`；票据 `perms` 不落平台库 |

### 5. 已有测试 / 探索路径
- 测试：[host-authorization.e2e.test.ts](../../../../cloud-platform/test/e2e/host-authorization.e2e.test.ts)、[web-host-permission-drawer.e2e.test.ts](../../../../cloud-platform/test/e2e/web-host-permission-drawer.e2e.test.ts)、[web-grant-subject-picker.e2e.test.ts](../../../../cloud-platform/test/e2e/web-grant-subject-picker.e2e.test.ts)、[web-admin-self-grant.e2e.test.ts](../../../../cloud-platform/test/e2e/web-admin-self-grant.e2e.test.ts)、[u67-role-authz.e2e.test.ts](../../../../cloud-platform/test/e2e/u67-role-authz.e2e.test.ts)、[u62-authz-polish.e2e.test.ts](../../../../cloud-platform/test/e2e/u62-authz-polish.e2e.test.ts)、[user-grant-resolution.e2e.test.ts](../../../../cloud-platform/test/e2e/user-grant-resolution.e2e.test.ts)、[web-project-detail.e2e.test.ts](../../../../cloud-platform/test/e2e/web-project-detail.e2e.test.ts)、[web-exploratory-fixes.e2e.test.ts](../../../../cloud-platform/test/e2e/web-exploratory-fixes.e2e.test.ts)（R5-③/W2-M）。
- 探索：[authz-combo-paths.md](../../../../cloud-platform/scripts/exploratory-r2/authz-combo-paths.md)、[authz-api-combo-paths.md](../../../../cloud-platform/scripts/exploratory-r2/authz-api-combo-paths.md)、[web-console-paths.md](../../../../cloud-platform/scripts/exploratory-r2/web-console-paths.md) P3/H6。
- 证据：[aa2-host-grants/](../../../../cloud-platform/evidence/aa2-host-grants/)、[aa6-host-drawer/](../../../../cloud-platform/evidence/aa6-host-drawer/)、[aa7-coverage/matrix-coverage.json](../../../../cloud-platform/evidence/aa7-coverage/matrix-coverage.json)。

### 6. 覆盖状态
- 正常步骤 **9**，已覆盖 **8**（S7 降级断会话完整链路未闭合，U65 C10）。
- 失败分支 **8**，已覆盖 **6**（E1-E6），未覆盖 **1**（E7 端到端撤销），未实现 **1**（E8 U67/U67b）。
- 未实现：层级单卡/位置即权限（U67/U67b）；主机授权收缩撤凭证完整链路（U65 C10）。

---

## F6 审计查询与证据（查询条件 → 事件详情 → 链校验/gaps）

### 1. 入口
- 侧栏「审计日志」/ `#/audit`（管理员或审计员；开发者直达 403 保留 URL）。
- 无单事件深链、无 `/v1/audit/verify` 页面入口（仅 API）。

### 2. 步骤与状态迁移
1. **打开审计页**：并行 `GET /v1/audit/events`（默认 range=168h、limit=50）、`/v1/audit/status`、`/v1/projects`、`/v1/hosts`；events 必须成功，其余失败降级 null。可见反馈：结果表/缺口横幅/覆盖说明/操作类型目录。［来源 m07-3.1］
2. **设置查询条件**：关键字（2–128）、时间范围（24h/7d 默认/31d）、显式起止、操作类型（全部/下载族/复制族/单类型）、用户、项目、主机、文件名、结果。可见反馈：控件值与目录项。［来源 m07 §1/3.2］
3. **查询**：读 10 个控件 → 客户端校验 → 写 `state.auditFilter`、清空累积与 cursor → `GET /v1/audit/events?<conditions>`。可见反馈：结果表「已显示 N 条」、错误横幅。［来源 m07-3.2］
4. **结果渲染与高亮**：时间本地化、操作徽标（下载/复制/拦截）、置信度徽标、项目/主机/文件列、结果（✓/✕/⛔）、traceId；关键字/文件名命中 `<mark>` 高亮。可见反馈：表格行。［来源 m07 §1/3.8］
5. **加载更早**：存在 `nextCursor` 时以 cursor 追加下一页（每页 50），不与新查询混表。可见反馈：「加载更早」按钮。［来源 m07-3.4］
6. **file_copy 展开**：切换隐藏行，展示复制内容摘录/`sha256` 指纹/字符与字节数；无摘录显示「仅保留指纹」。可见反馈：展开行。［来源 m07-3.7］
7. **证据复制**：点文件名复制 `metadata.path`（缺省 fileName）、点 traceId「复制」；toast「已复制」。可见反馈：剪贴板写入。［来源 m07-3.5/3.6］
8. **缺口与可信度查看**：缺口横幅（宿主有缺口/计数/平台入口计数，best-effort）；覆盖范围折叠块（可捕获/不可捕获/缺口/可信度）。可见反馈：横幅与 details。［来源 m07-3.12/§1］
9. **链校验（API，无 UI）**：`GET /v1/audit/verify` 返回 200/409 并把 `audit_verify` 写入链；**控制台无入口，未实现**（m07 §4）。［来源 m07-3.12/§4］

### 3. 失败分支
1. **客户端校验失败** → `#auditError` 显示原因且**不发请求**（q 长度、fileName ≤128、日期可解析、结束不得早于开始、窗口 >31 天、只给 since 且距今 >31 天）。用户动作：修正条件。［来源 m07-3.2/§3 校验］
2. **服务端拒绝** → 横幅「查询失败：<原因>（下方为上次查询结果）」，旧行保留。用户动作：调整条件重查。［来源 m07-3.2］
3. **首屏 events 失败** → 内容区「加载失败」+ 错误文本 +「重试」。用户动作：重试。［来源 m07-3.1］
4. **连续快速查询** → generation latest-wins：被取代的请求不落 state、不渲染，失败也静默丢弃。用户动作：无（最终结果正确）。［来源 m07-3.11、U73］
5. **auditor 的项目/主机下拉为空** → `/v1/hosts` 对 auditor 403 被 catch 吞掉，`/v1/projects` 仅返回其 open 项目（通常空）；UI 不说明原因。用户动作：按用户名/事件类型查询，或请管理员提供 id。［来源 m07 §4/§5 观察 2］
6. **空结果** → 表格单行「没有符合筛选条件的审计事件」。用户动作：放宽条件。［来源 m07 §1］
7. **无权限直达** → developer 渲染 403 页保留 URL，不发审计查询；API 403 + `audit_query` denied。用户动作：联系管理员。［来源 m07 §2、U72］

### 4. 涉及 API / 事件 / 存储
| 面 | 内容 |
| --- | --- |
| API | `GET /v1/audit/events`（q/eventType/eventFamily/username/fileName/result/projectId/hostId/since/until/cursor/limit）、`GET /v1/audit/status`、`GET /v1/audit/verify`、`GET /v1/projects`、`GET /v1/hosts` |
| 事件 | 全部事件族落链；查询拒绝写 `audit_query` denied；校验写 `audit_verify`；缺口写 `host_audit_gap`（U71） |
| 存储 | 单写者哈希链（180 天保留、单窗 ≤31 天、每页 50、daily/total envelope）；宿主 audit gap 计数 |

### 5. 已有测试 / 探索路径
- 测试：[u66-5-audit-ui.e2e.test.ts](../../../../cloud-platform/test/e2e/u66-5-audit-ui.e2e.test.ts)、[u66-2-audit-query.e2e.test.ts](../../../../cloud-platform/test/e2e/u66-2-audit-query.e2e.test.ts)、[u66-audit-file-events.e2e.test.ts](../../../../cloud-platform/test/e2e/u66-audit-file-events.e2e.test.ts)、[u71-audit-gap-heartbeat.e2e.test.ts](../../../../cloud-platform/test/e2e/u71-audit-gap-heartbeat.e2e.test.ts)、[u72-u73-audit-role-race.e2e.test.ts](../../../../cloud-platform/test/e2e/u72-u73-audit-role-race.e2e.test.ts)、[audit-verify.e2e.test.ts](../../../../cloud-platform/test/e2e/audit-verify.e2e.test.ts)、[audit-fail-closed.e2e.test.ts](../../../../cloud-platform/test/e2e/audit-fail-closed.e2e.test.ts)、[audit-writer.e2e.test.ts](../../../../cloud-platform/test/e2e/audit-writer.e2e.test.ts)、[audit-anchor.e2e.test.ts](../../../../cloud-platform/test/e2e/audit-anchor.e2e.test.ts)。
- 探索：[exploratory-r5-paths.md](../../../../cloud-platform/scripts/exploratory-r2/exploratory-r5-paths.md) P2'-1~P2'-4（12 列三行/31 天文案/组合过滤）；[api-paths.md](../../../../cloud-platform/scripts/exploratory-r2/api-paths.md) 审计端点段。

### 6. 覆盖状态
- 正常步骤 **9**，已覆盖 **7**（S5 加载更早由 T06 QA-002 钉住；S7 文件名复制、S9 链校验 UI 未覆盖/未实现）。
- 失败分支 **7**，已覆盖 **5**（E1/E2/E4/E5/E7；E5 由 T32 U72-4 characterization 钉现状，断言边界=下拉仅「全部」、不含 /加载失败|无权访问/ 两短语），未覆盖 **2**（E3 首屏失败重试、E6 空态）。
- 未实现：控制台链健康/容量水位展示、`/v1/audit/verify` 入口（M7 §5 观察 1；无 U 号）。

---

## F7 宿主接入（注册 → 安装向导 → 心跳 → projectsRoot/routeKey → 权限）

### 1. 入口
- 管理台「主机」/ `#/hosts`（admin-only）→「注册主机」。
- 目标机执行 `bash <(curl -fsSL <平台 origin>/install/host.sh?token=<token>)`。
- 宿主 `POST /v1/hosts/register`（一次性令牌）→ 周期心跳。
- 主机详情抽屉：信息/权限、维护、下线。

### 2. 步骤与状态迁移
1. **进入主机页**：并发 `GET /v1/hosts` + `GET /v1/policies/download` → 列表（在线/离线/维护/已吊销、中继绑定、心跳相对时间）。可见反馈：表格/空态「尚未注册主机」。［来源 m04-D1］
2. **注册主机签发令牌**：`POST /v1/hosts/tokens` → 一次性令牌（24h，仅存 hash，审计 `host_token_create`）→ 弹框展示命令。可见反馈：命令块/复制按钮。［来源 m04-D2］
3. **复制安装命令**：写剪贴板，toast「已复制」，弹框保持。可见反馈：toast。［来源 m04-D3］
4. **目标机拉安装脚本**：`GET /install/host.sh?token=…` → 校验管理员会话与未使用令牌 → 输出内嵌平台地址/令牌/projectsRoot/TLS 自签/systemd 的脚本（审计 `install_script`，不含令牌明文）。可见反馈：脚本文本。［来源 m04-D4、m12 §2］
5. **宿主注册**：`POST /v1/hosts/register`（Bearer 一次性令牌）→ 令牌置已用；按名称 upsert Host，写入指纹/TLS 指纹/E2EE 公钥/版本/协议/zone/直连地址/能力/projectsRoot/projectDirs/状态 online/最近心跳；生成长期凭证；写中继路由表项；审计 `host_register`；返回 `hostId/credential/policyVersion`。可见反馈：宿主侧注册成功；平台列表出现主机。［来源 m04-D5、m12 §3］
6. **周期心跳**：`POST /v1/hosts/:id/heartbeat` 更新直连地址/项目目录/projectsRoot（护栏）/E2EE/TLS 指纹/状态/克隆回报/宿主审计事件/缺口；响应撤销集合、策略、维护态、开通指派、审计能力、serverTime。可见反馈：列表心跳时间/在线状态、策略版本更新。［来源 m04-D13、m12 §4］
7. **在线判定**：列表 `online = revokedAt==null && status==='online' && now-lastHeartbeat<=hostOfflineMs`（默认 60s，`ORCA_CLOUD_HOST_OFFLINE_MS` 可覆盖）；不沿用存储 online。可见反馈：状态列推导。［来源 m04-D14］
8. **routeKey 派生/迁移**：注册时显式 `relayRoute` 优先，否则 `ip-<IP>`（无地址回落主机名）；路由目标 `relayTarget||directAddrs[0]`；重注册改键删旧路由；心跳新地址 `syncHostRoute+ensureHostRoute` 补/迁移；吊销删除表项。可见反馈：列表中继路由列变化。［来源 m04-D15、m12 §3/§7］
9. **维护模式**：抽屉「进入/结束维护」→ `POST /v1/hosts/:id/maintenance {enabled,reason}` → 状态维护中/回 online，项目打开入口随 `hostStatus` 置灰。可见反馈：列表状态/项目卡置灰。［来源 m04-D8/D9］
10. **下线主机**：`DELETE /v1/hosts/:id` → status offline、`revokedAt` 置位、删路由、撤销该项目全部凭证；原生 confirm「确认下线该主机？」；审计 `host_revoke`。可见反馈：状态已吊销、项目不可打开。［来源 m04-D10、m12 §2］
11. **主机权限三卡片**：添加/移除组或用户 → `PUT /v1/hosts/:id/grants` 整行替换 → toast + 重绘；降级断会话提示。可见反馈：卡片主体/级别。［来源 m04-D11/D12、m11 §4.2］

### 3. 失败分支
1. **安装脚本缺/无效/已用/过期令牌** → 400 `INSTALL_TOKEN_REQUIRED`；401 `HOST_TOKEN_INVALID`；非 admin 403。用户动作：回管理台重新签发令牌。［来源 m04-D4、m12 §2］
2. **注册令牌无效/已用/过期** → 401 `HOST_TOKEN_INVALID`，令牌一次性。用户动作：重新建令牌。［来源 m04-D5］
3. **非管理员访问主机面/授权** → 页面 403 保留 URL；接口 403 + denied 审计。用户动作：联系管理员。［来源 m04 §2、m12 §2］
4. **坏心跳字段（如 `directAddrs`）** → 400 `HOST_DIRECTADDRS_INVALID`，整拍拒绝，不落库。用户动作：宿主修正上报。［来源 m04-D13、U57］
5. **projectsRoot 变更冲突** → 活跃项目在册时拒绝换根（旧根保留），响应 `projectsRootRejected:'PROJECTS_ROOT_CONFLICT'`；归档项目不阻塞。用户动作：先归档/迁移项目再换根。［来源 m04-D13、m12 §5、U21］
6. **主机离线** → 静默超窗→离线；项目打开入口 disabled「主机离线」；恢复心跳→online。用户动作：检查宿主/网络。［来源 m04-D14、host-offline］
7. **已吊销主机** → 心跳仍达并携带 `hostRevoked`，但不更新存活/地址/根/能力；新连接 409 `HOST_REVOKED`；维护切换 409。用户动作：重新注册新主机。［来源 m04-D8、m12 §4、host-revocation］
8. **安装命令鉴权不一致（存疑）** → 向导命令为无 `Authorization` 的 curl，而脚本端点先 `requireAuth()` 再 `isAdmin()`；照抄执行可能 401。**未覆盖/待现场核实**（M4 §7 存疑①，无 U 号）。用户动作：暂无定论。［来源 m04 §7、m12 §2］

### 4. 涉及 API / 事件 / 存储
| 面 | 内容 |
| --- | --- |
| API | `POST /v1/hosts/tokens`、`GET /install/host.sh?token=`、`POST /v1/hosts/register`、`POST /v1/hosts/:id/heartbeat`、`GET /v1/hosts`、`GET /v1/hosts/available`、`POST /v1/hosts/:id/maintenance`、`DELETE /v1/hosts/:id`、`GET/PUT /v1/hosts/:id/grants` |
| 事件 | `host_token_create`、`install_script`、`host_register`、`host_e2ee_key_changed`、`host_tls_fingerprint_changed`、`host_maintenance`、`host_revoke`、`provision_assign`、`host_audit_gap`、`host_grant_*` |
| 存储 | `store.hosts`（credentialHash、fingerprint、projectsRoot、projectDirs、capabilities、lastHeartbeatAt、revokedAt/status）、一次性令牌（hash）、`store.relayRoutes` |

### 5. 已有测试 / 探索路径
- 测试：[install-wizard.e2e.test.ts](../../../../cloud-platform/test/e2e/install-wizard.e2e.test.ts)、[host-authorization.e2e.test.ts](../../../../cloud-platform/test/e2e/host-authorization.e2e.test.ts)、[host-offline.e2e.test.ts](../../../../cloud-platform/test/e2e/host-offline.e2e.test.ts)、[host-revocation.e2e.test.ts](../../../../cloud-platform/test/e2e/host-revocation.e2e.test.ts)、[host-route-key-follow.e2e.test.ts](../../../../cloud-platform/test/e2e/host-route-key-follow.e2e.test.ts)、[u64-host-port-drift.e2e.test.ts](../../../../cloud-platform/test/e2e/u64-host-port-drift.e2e.test.ts)、[projects-root-change-guard.e2e.test.ts](../../../../cloud-platform/test/e2e/projects-root-change-guard.e2e.test.ts)、[host-key-change-audit.e2e.test.ts](../../../../cloud-platform/test/e2e/host-key-change-audit.e2e.test.ts)、[provision-assignment-downlink.e2e.test.ts](../../../../cloud-platform/test/e2e/provision-assignment-downlink.e2e.test.ts)、[web-host-permission-drawer.e2e.test.ts](../../../../cloud-platform/test/e2e/web-host-permission-drawer.e2e.test.ts)、[mtls-control-channel.e2e.test.ts](../../../../cloud-platform/test/e2e/mtls-control-channel.e2e.test.ts)、[control-plane-isolation.e2e.test.ts](../../../../cloud-platform/test/e2e/control-plane-isolation.e2e.test.ts)。
- 探索：[web-console-paths.md](../../../../cloud-platform/scripts/exploratory-r2/web-console-paths.md) H1-H6；[api-paths.md](../../../../cloud-platform/scripts/exploratory-r2/api-paths.md) 宿主/令牌段；[desktop-paths.md](../../../../cloud-platform/scripts/exploratory-r2/desktop-paths.md) 前置条件。
- 证据：[aa2-host-grants/](../../../../cloud-platform/evidence/aa2-host-grants/)、[aa6-host-drawer/](../../../../cloud-platform/evidence/aa6-host-drawer/)、[env-repair-2026-11-14/](../../../../cloud-platform/evidence/env-repair-2026-11-14/)。

### 6. 覆盖状态
- 正常步骤 **11**，已覆盖 **9**（S9 维护 UI、S10 下线 UI 仅服务端覆盖；S2/S3 弹框成功/失败 UI 部分覆盖）。
- 失败分支 **8**，已覆盖 **7**（E1-E7，其中 E1/E2 为 API 层），未覆盖 **1**（E8 安装命令鉴权一致性），另 **1 存疑**。
- 未覆盖：真实宿主执行脚本→注册→首次心跳的真机端到端；Windows/CentOS7 安装脚本。

---

## F8 中继接入与路由（安装 → 绑定 → 在线态 → 不可达表现）

### 1. 入口
- 管理台「中继」/ `#/relays`（admin-only）→「添加中继」。
- 中继机执行 `bash <(curl -fsSL <平台>/install/relay.sh)`。
- 中继 `POST /v1/internal/relay-endpoint`（`x-internal-token`，非浏览器路径）注册。
- 宿主侧绑定可见性在主机页/抽屉（`relayTarget`/`relayOnline`）。

### 2. 步骤与状态迁移
1. **打开中继页**：`GET /v1/relays` → 表格（节点 ID/客户端地址/状态/最近注册时间）。可见反馈：列表/空态「尚未注册中继」。［来源 m05-3.1］
2. **添加中继**：打开弹框展示命令 `bash <(curl -fsSL <platform>/install/relay.sh)`；「复制命令」toast「已复制」，弹框保持。可见反馈：命令块。［来源 m05-3.3］
3. **中继机执行命令**：`GET /install/relay.sh` 输出内嵌 `ORCA_CLOUD_API_URL` 与 `ORCA_CLOUD_INTERNAL_TOKEN` 的脚本（审计 `install_script`，metadata type=relay，不含令牌明文）。可见反馈：脚本文本。［来源 m05-3.4、m12 §7］
4. **中继注册上线**：`POST /v1/internal/relay-endpoint` 校验内部令牌与端口 → 记录 host/port/browserHost/lastSeenAt → 返回 relayPort/id/healthyRelays；每 2s 心跳注册。可见反馈：平台中继页出现节点「在线」。［来源 m05-3.4/§3 补充、m12 §7］
5. **路由表同步**：平台 `GET /v1/internal/relay-routes` 下发 `{version,routes:[{routeKey,hostId,target,version}]}`；中继定时同步，陈旧 5 分钟拒绝新连接。可见反馈：宿主「中继路由」列可解析。［来源 m12 §7、m04-D15］
6. **宿主绑定可见**：主机表「中继」列显示 `relayTarget`，`relayOnline===false` 追加「中继离线」，有直连地址再提示「直连不受阻」；抽屉「中继绑定」同标注。可见反馈：徽标/说明。［来源 m04-D16、m05-3.6、U79］
7. **客户端连接/选路**：`/connect` 只下发存活中继端点（`wss://<host>:<port>/`，SNI=`<routeKey>.relay.local`）；中继死亡后客户端 5 次内切换存活节点（AC-23）。可见反馈：工作区状态栏路线「直连/中继」；切换无感。［来源 m05-3.7、m12 §7］
8. **不可达表现**：无存活中继时不下发端点；未知 SNI 默认黑洞；中继页不自动轮询，离线需「刷新」或重进页面才看到。可见反馈：中继行「离线」；宿主侧「中继离线」。［来源 m05-3.5/3.7、m12 §7］

### 3. 失败分支
1. **「刷新」失败无反馈** → `renderRelays()` 直接 await，异常不进 `loadContent`，旧表保留、无 toast/横幅。用户动作：重进页面/等下次刷新。［来源 m05-3.2/§5 观察 1；未登记 U］
2. **向导命令粘贴执行 401（存疑）** → `/install/relay.sh` admin-gated，UI 命令不含 token；e2e 只验「管理员带 Bearer 拉脚本」与命令字符串一致。用户动作：暂无定论，待部署层/鉴权澄清。［来源 m05 §5 观察 2］
3. **中继掉线状态滞留** → 无自动刷新，页面可能长期显示「在线」直到人工刷新。用户动作：点「刷新」。［来源 m05 §5 观察 3］
4. **非法端口注册** → 400 `RELAY_PORT_INVALID`，节点不注册。用户动作：检查 `RELAY_PORT`。［来源 m12 §7］
5. **无存活中继** → `/connect` 不下发端点；客户端无法连接（错误由客户端呈现）。用户动作：恢复中继/使用直连。［来源 m05-3.7］
6. **未知 SNI/非 TLS/超并发** → 中继黑洞/拒绝连接；不泄露路由。用户动作：从平台获取有效端点/SNI。［来源 m05 §6 relay-hardening］
7. **中继离线但宿主可直连** → 宿主侧标「中继离线」+「直连不受阻」，仍可打开项目。用户动作：无需操作。［来源 m04-D16、U79］

### 4. 涉及 API / 事件 / 存储
| 面 | 内容 |
| --- | --- |
| API | `GET /v1/relays`、`GET /install/relay.sh`、`POST /v1/internal/relay-endpoint`、`GET /v1/internal/relays`、`GET /v1/internal/relay-routes`、`POST /v1/projects/:id/connect` |
| 事件 | `install_script`（relay）、`relay_list`（仅拒绝落链）；注册/心跳类事件不在中继页展示 |
| 存储 | 平台内存 `relayRoutes`（routeKey→hostId/target/version）、relay 节点注册表（host/port/browserHost/lastSeenAt，30s 存活窗）；中继侧路由缓存（陈旧 5 分钟拒绝） |

### 5. 已有测试 / 探索路径
- 测试：[web-admin-gating.e2e.test.ts](../../../../cloud-platform/test/e2e/web-admin-gating.e2e.test.ts)、[relay-endpoint-address.e2e.test.ts](../../../../cloud-platform/test/e2e/relay-endpoint-address.e2e.test.ts)、[install-wizard.e2e.test.ts](../../../../cloud-platform/test/e2e/install-wizard.e2e.test.ts)、[u79-host-relay-binding.e2e.test.ts](../../../../cloud-platform/test/e2e/u79-host-relay-binding.e2e.test.ts)、[relay-hardening.e2e.test.ts](../../../../cloud-platform/test/e2e/relay-hardening.e2e.test.ts)、[relay-failover.e2e.test.ts](../../../../cloud-platform/test/e2e/relay-failover.e2e.test.ts)、[relay-browser-entry.e2e.test.ts](../../../../cloud-platform/test/e2e/relay-browser-entry.e2e.test.ts)、[relay-browser-mode.e2e.test.ts](../../../../cloud-platform/test/e2e/relay-browser-mode.e2e.test.ts)、[relay-browser-edge-hygiene.e2e.test.ts](../../../../cloud-platform/test/e2e/relay-browser-edge-hygiene.e2e.test.ts)、[relay-nodes.test.ts](../../../../cloud-platform/test/relay-nodes.test.ts)。
- 探索：[web-console-paths.md](../../../../cloud-platform/scripts/exploratory-r2/web-console-paths.md) §6；[api-paths.md](../../../../cloud-platform/scripts/exploratory-r2/api-paths.md) 中继段。
- 证据：[m114-relay-page/](../../../../cloud-platform/evidence/m114-relay-page/)、[u79-relay-binding/](../../../../cloud-platform/evidence/u79-relay-binding/)、[m83-relay-failover/](../../../../cloud-platform/evidence/m83-relay-failover/)、[m86-relay-data-path/](../../../../cloud-platform/evidence/m86-relay-data-path/)。

### 6. 覆盖状态
- 正常步骤 **8**，已覆盖 **8**（S8 中继页离线行 UI 未直接断言，属探索覆盖）。
- 失败分支 **7**，已覆盖 **7**（E4-E7 既有；E2 命令执行由 T38 覆盖；E1/E3 由 T06 QA-013 characterization 钉住——旧表保留/无提示、1.2s 无轮询，行为缺口保留）。
- 未覆盖：无自动化缺口；行为缺口（刷新失败无反馈、无自动刷新）见 §13 G11，建议登记 U。

---

## F9 用户管理（查询 → 详情 → 角色内联编辑 → roleOverride）

### 1. 入口
- 侧栏「用户管理」/ `#/users`（admin-only）。
- 列表行「详情」→ 用户详情弹框（HEAD 不改 URL；`#/users/:id` R3 在途）。
- 角色唯一写入口 = 详情弹框内角色下拉。

### 2. 步骤与状态迁移
1. **打开用户页**：`GET /v1/users` → 页头徽标、查询栏、只读表格（7 列）、页脚统计。可见反馈：列表/空态。［来源 m06-3.1］
2. **关键字查询**：输入显示名或账号，大小写不敏感子串匹配，即输即筛，无网络请求。可见反馈：行数即时变化。［来源 m06-3.2］
3. **角色/状态筛选**：下拉精确匹配，三条件 AND；「查询」兜底重放控件值，「重置」恢复全量。可见反馈：行集/页脚「当前筛选」。［来源 m06-3.3/3.4/3.5］
4. **查看详情**：打开弹框，7 字段来自当前 `users` 数组（显示名/账号/部门/LDAP 组/平台角色/角色来源/状态）；关闭回焦触发按钮。可见反馈：弹框。［来源 m06-3.7］
5. **修改角色**：下拉值立刻回退 → 弹「角色变更」确认框（同值不弹；停用账号直接 return）；确认框含 from→to、role_update 审计、覆盖优先、升级即时/降级断会话。可见反馈：确认框。［来源 m06-3.8］
6. **确认升权**：`PUT /v1/users/{id}/roles {role}` → toast「已将 … 更新为…」→ 整页重绘（筛选态保留）→ 详情重绘为新角色、来源「管理员覆盖」。可见反馈：toast/列表/弹框同步。［来源 m06-3.9］
7. **确认降级（admin→非 admin）**：同一 PUT；后端记 `role_update metadata.revoked=true` 并 `revokeUserCredentials`，旧 token 下一请求失去管控面（≤60 秒心跳撤销）；确认按钮 danger。可见反馈：被降级用户失去管理入口。［来源 m06-3.10］
8. **roleOverride 重登优先**：再次登录时若存在 `roleOverride`，`roles = USER_PAGE_ROLES[roleOverride]`，LDAP 组不再推导角色；`roleSource='admin-override'`。可见反馈：重登后角色保持覆盖值。［来源 m06 §3 角色语义］
9. **停用账号展示**：列表/详情显示「已停用」；详情角色下拉 disabled，change 处理器二次拦截；`requireAuth` 对 `status!=='active'` 返回 null（已签发 token 失效）。可见反馈：禁止改角色/API 401。［来源 m06-3.11/§3］
10. **深链详情（设计目标）**：`#/users/:id` **未实现（U106 R3，工作树在途）**；HEAD 详情不改 URL。［来源 m06 §1/§5、m11 §2］

### 3. 失败分支
1. **列表加载失败** → 「加载失败」+ 错误文本 +「重试」。用户动作：重试。［来源 m06-3.1］
2. **筛选无结果** → 单行空态「没有符合筛选条件的账号——请调整关键字或重置条件」，页脚仍显示总数/筛选 0。用户动作：调整/重置。［来源 m06-3.6］
3. **保存失败** → toast「保存失败：<原因>」→ 随后整页重绘并回调刷新弹框，界面回服务端真值（回滚）。用户动作：重试或检查目标用户状态。［来源 m06-3.9］
4. **非管理员访问** → 页面 403 保留 URL、不发 `GET /v1/users`；接口 403 + `user_list` denied。用户动作：联系管理员。［来源 m06 §2］
5. **停用账号服务端校验缺口** → 角色 PUT 服务端未校验 `target.status`，停用锁定仅在 UI（当前无停用入口，实际不可达）。用户动作：无。［来源 m06 §3/§5 观察 2］
6. **角色变更后筛选态保持** → 整页重绘保留 `userFilter`，但无自动化断言（U114-D4 点名缺口）。用户动作：无（功能按现状工作）。［来源 m06 §6］
7. **roleOverride 与 LDAP 再登录竞态** → 已有覆盖（u72-u73）；覆盖值优先。用户动作：无。［来源 m06 §6、m11 §8］

### 4. 涉及 API / 事件 / 存储
| 面 | 内容 |
| --- | --- |
| API | `GET /v1/users`、`PUT /v1/users/{id}/roles`、`GET /v1/me`、`GET /v1/directory` |
| 事件 | `role_update`（成功含 from/to/username/revoked；拒绝 denied）、`user_list` denied |
| 存储 | `store.users`（`status`、`roles`、`roleOverride`）；access token 为 opaque 键，角色每请求重算 |

### 5. 已有测试 / 探索路径
- 测试：[u67-3-users-page.e2e.test.ts](../../../../cloud-platform/test/e2e/u67-3-users-page.e2e.test.ts)、[u72-u73-audit-role-race.e2e.test.ts](../../../../cloud-platform/test/e2e/u72-u73-audit-role-race.e2e.test.ts)、[u67-role-authz.e2e.test.ts](../../../../cloud-platform/test/e2e/u67-role-authz.e2e.test.ts)、[web-admin-gating.e2e.test.ts](../../../../cloud-platform/test/e2e/web-admin-gating.e2e.test.ts)。
- 探索：[exploratory-r5-paths.md](../../../../cloud-platform/scripts/exploratory-r2/exploratory-r5-paths.md) P1'-1~P1'-7；[web-console-paths.md](../../../../cloud-platform/scripts/exploratory-r2/web-console-paths.md)（用户面早期路径）。
- 证据：[u67-3-users-page/](../../../../cloud-platform/evidence/u67-3-users-page/)、[u81b-fix/](../../../../evidence/u81b-fix/)、[exploratory-r3-users-audit/](../../../../cloud-platform/evidence/exploratory-r3-users-audit/)。

### 6. 覆盖状态
- 正常步骤 **10**，已覆盖 **8**（S9 停用锁定无自动化，U114-D4；S10 深链未实现 U106 R3）。
- 失败分支 **7**，已覆盖 **4**（E2/E4/E6/E7），未覆盖 **3**（E1 加载失败、E3 保存失败回滚、E5 服务端停用校验）。
- 未实现：`#/users/:id` 深链（U106 R3，在途）；无分页/无新建/停用入口（非缺陷，设计未承诺）。

---

## F10 移动端形态

> **状态：原型阶段，未实现。** 本链路只登记设计/原型边界，不描述运行行为、不据此编写验收用例。

### 1. 入口
- 无生产入口。设计对象为云端系统全站 Web 移动端适配（平台管理台 / 宿主 `cloud-admin` / Orca Web 工作区），见 U80。
- 原生移动 App 的 Expo Router 路径不属本设计范围（U106 D11/T14）。

### 2. 步骤与状态迁移
- 未实现（U80）：设计已交付并审定（提交 `721e43512ee`，15 面清单 + 6 关键页完整移动形态 + 断点策略页；T1=响应式同一套 DOM，工作区豁免；T2=tab 按角色派生；T3=审计详情行内展开）。
- 实现未开工；不存在可重放的移动端点击路径。探索 R5 明确移动视口适配「实现未开工，待 r6」。
- 未实现（U80）。

### 3. 失败分支
- 未实现（U80）：无运行时失败分支可登记。

### 4. 涉及 API / 事件 / 存储
- 设计目标为同一套 API/事件/存储（响应式同一 DOM，不新增后端契约）；当前无移动专属 API/存储。
- 未实现（U80）。

### 5. 已有测试 / 探索路径
- 设计/原型证据：U80 交付 `721e43512ee`（原型与截图，见 `ui/`；相关 QA 见 U85）。
- 自动化：**未覆盖**；R5 明确不含移动断言，移动视口并入未来 r6（[exploratory-r5-paths.md](../../../../cloud-platform/scripts/exploratory-r2/exploratory-r5-paths.md) 范围注记）。
- 唯一已存在的移动相关断言是 U106 C15 的移动视口冒烟目标（尚未落地，U106 §5）。

### 6. 覆盖状态
- 正常步骤 **0**（未实现，U80）；失败分支 **0**。
- 已覆盖 **0**；不得按原型推断行为或生成"通过"结论。

---

## 全链路覆盖汇总（2026-11-16）

| 链路 | 正常步骤 | 失败分支 | 已覆盖步骤 | 已覆盖分支 | 未实现/未覆盖要点 |
| --- | --- | --- | --- | --- | --- |
| F1 | 7 | 8 | 7 | 5 | 浏览器并行 401 竞态（G28）；/v1/me 失败、登出静默 |
| F2 | 11 | 8 | 9 | 8 | 归档/恢复无控制台入口；provisioning→ready UI |
| F3 | 8 | 8 | 6 | 4 | U106 R4 覆盖层路由/刷新；U106 W3 项目 403/404；U112 D5 |
| F4 | 9 | 9 | 7 | 6 | U112 D1 end、D2 pending→ended、D5 退避；U99 多组复验 |
| F5 | 9 | 8 | 8 | 6 | U65 C10 撤销链路；U67/U67b 层级单卡未实现 |
| F6 | 9 | 7 | 7 | 5 | 文件名复制/审计首屏失败/审计员下拉解释；链校验无 UI |
| F7 | 11 | 8 | 9 | 7 | 维护/下线 UI；安装命令鉴权一致性存疑 |
| F8 | 8 | 7 | 8 | 7 | 刷新失败无反馈/无自动轮询（G11 characterization）；命令粘贴执行 |
| F9 | 10 | 7 | 8 | 4 | U106 R3 深链；U114-D4 筛选态/停用锁 |
| F10 | 0 | 0 | 0 | 0 | U80 原型阶段，未实现 |
| **合计** | **82** | **70** | **69** | **52** | — |

**填充规则重申**（沿用骨架）：
- 每链路每步骤 ≥1 正常用例 + 每失败分支 ≥1 异常用例（G7c 派生规则）；
- 步骤后标注「模块文档条目号」与既有测试文件；
- 探索路径清单（`cloud-platform/scripts/exploratory-r2/`）中覆盖该链路的条目已互链；
- 未实现项必须保持「未实现（U 号）」标记，不得按设计稿推断验收通过。
