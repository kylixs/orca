# M1 登录与认证（现状）

> 基线提交：`664a91e0322`（2026-11-16）｜来源：`cloud-platform/apps/web/{index.html,app.js}`、`cloud-platform/apps/api/src/{server.ts,ldap.ts,login-lockout-client.ts,store.ts}` 代码阅读 + 既有套件。
> 本次未启动 18787（探测 `000`），界面描述以生产管理台代码为准。

## 1. 页面/界面布局

**登录页**（`#view-login`，居中单卡片 `.login-card`）：
- 品牌区：ORCA CLOUD 图标 + 字标；标题「登录云端开发平台」；副题「使用公司域账号登录」。
- 表单：`域账号` 文本框（占位「域账号，如 zhangsan」）、`密码` 密码框 + 右侧眼睛图标按钮（显示/隐藏密码）。
- 错误行（`.inline-error`，默认隐藏，位于密码下、登录按钮上）。
- 主按钮「登录」（提交时变「登录中…」并禁用）。
- 页脚：「登录即表示同意《平台使用规范》。内网直连 / 外网访问」标签。

**登录后的框架**（`#view-app`，渲染在认证成功后）：
- 左侧栏：品牌、导航、底部用户盒（头像 = 显示名首字、「显示名 / 部门」、「退出」链接）。
- 顶栏：面包屑（当前页标题）、角色 chip（`平台管理员` / `审计员` / `开发者`）、「查看无权限页」按钮。
- 内容区由路由渲染（见 M2）。

## 2. 菜单与入口（权限门槛）

| 入口 | 位置 | 门槛 |
| --- | --- | --- |
| 登录表单 | 未登录视图（`showLogin()`）；无 token/恢复失败时显示 | 无 |
| 退出 | 侧栏用户盒「退出」 | 已登录 |
| 查看无权限页 | 顶栏；登录后按角色显隐——**管理员隐藏**，非管理员可见 | 非管理员 |

## 3. 操作清单

| # | 触发面 | 结果 | 弹窗/确认 | 失败态 | 权限门槛 |
| --- | --- | --- | --- | --- | --- |
| A1 | 空账号或空密码提交 | 客户端拦截，**不发请求**（避免烧锁定次数），账号/密码框标红 | 无 | 行内「请输入域账号和密码。」，焦点回账号框 | 无 |
| A2 | 账号+密码提交成功 | `POST /v1/auth/login`（含 `username/password/deviceId/deviceName/devicePubKey:'web-client'`）→ 写 `localStorage: orca.access / orca.refresh / orca.user / orca.device` → 进主框架；按当前 hash 恢复深链；空 hash 或 `#/login` → `#/workbench` | 无 | — | 无 |
| A3 | 密码错误 | 服务端 `401 INVALID_CREDENTIALS`，失败计数 +1 | 无 | 行内「账号或密码错误，请重试。」；密码框标红并聚焦；按钮恢复「登录」 | 无 |
| A4 | 连续 5 次失败 | 服务端 `423 ACCOUNT_LOCKED`（计数共享时跨副本累计；进程内默认 5 次 / 15 分钟） | 无 | 行内「连续 5 次失败，账号已锁定 15 分钟。」；锁定期间再试直接 423「账号已锁定，请 15 分钟后再试。」并记审计 `login/failure reason=locked` | 无 |
| A5 | 账号不在 LDAP 准组 | 服务端 `401 LDAP_GROUP_NOT_ADMITTED`；两条拒绝路径（adapter filter miss / 平台闸门）同码同文案；审计 `reason=ldap_group_denied`；**不计数也不清锁定** | 无 | 行内显示服务端文案「账号未加入平台准入组。」 | 准入组由 `ORCA_CLOUD_LDAP_REQUIRED_GROUP`（或 config `ldapRequiredGroup`）控制；空白=关闭 |
| A6 | 点击密码框眼睛 | 明文/密文切换 | 无 | — | 无 |
| A7 | 任意业务请求返回 401 且本地有 refreshToken | `api()` 静默 `POST /v1/auth/refresh`；成功后旋转 access+refresh 并**重放原请求一次** | 无 | refresh 失败（非 2xx）→ 直接 `logout()`，回登录页 | 已登录 |
| A8 | 刷新/重开页面 | 有 accessToken 时 `GET /v1/me` 恢复用户并进主框架 | 无 | 请求失败（含 refresh 后仍 401）→ 清 access、移除缓存 user、显示登录页；仅缓存 user 不足以进入 | 有本地 token |
| A9 | 点击「退出」 | 先向工作区 iframe 发 `logout`（不结束宿主 PTY）→ 尽力 `POST /v1/auth/logout`（撤销 session 并 bump epoch，已发票据失效）→ 清空 access/refresh/user 与登录框输入、隐藏错误 → 回登录页 | 无 | 登出请求失败被吞（本地仍清空） | 已登录 |

**服务端认证语义（现状）**
- 密码只经 LDAP adapter 校验，平台不存密码；生产为 LDAPS simple-bind adapter（代码中仅 Mock 实现，`ldap.ts` 注释声明生产接同接口）。
- 准入组语义（U69a 裁定）：**组=登录准入，不是角色映射**；新用户首登角色一律 `developer`，角色由平台内用户管理覆盖（`roleOverride` 优先）。
- 会话：access TTL 30 分钟、refresh TTL 12 小时（`ORCA_CLOUD_ACCESS_TTL_MS` / `ORCA_CLOUD_REFRESH_TTL_MS` 可覆盖）；refresh 每次旋转，旧 refresh 重放会撤销会话。
- 锁定计数：配置 `ORCA_CLOUD_LOGIN_LOCKOUT_URL` 时走共享服务（不可达 → 登录 `503 PLATFORM_UNAVAILABLE`，fail-closed）；未配置时进程内计数（5 次 / 15 分钟）。

## 4. 数据来源

| 面 | 来源 |
| --- | --- |
| 登录 | `POST /v1/auth/login`（返回 `accessToken/refreshToken/expiresIn/user/device`） |
| 静默续会话 | `POST /v1/auth/refresh` |
| 恢复会话 | `GET /v1/me` |
| 登出 | `POST /v1/auth/logout` |
| 本地存储 | `orca.access`、`orca.refresh`、`orca.user`、`orca.device`（均 localStorage） |
| 锁定/准入 | 共享锁定服务或进程内计数；LDAP adapter 的 groups（`profile.groups`） |

## 5. 已知缺陷（台账）

- 🟢 U8：跨源登录 network_error（平台缺 CORS）——已修。
- 🟢 U13：开发模式带 `ORCA_CLOUD_API_URL` 启动看不到登录页——已修（准入只认显式宿主信号）。
- 🟢 U53②：退出登录后登录框凭据残留（可一键恢复上一账号）——已修。
- 🟢 U69a：LDAP 组→角色映射方向错误撤回；现状=分组准入 + 平台内角色。
- 🟢 U72：审计员角色的登录后导航/直达路由门禁（联动 M2）。
- 🟡 U106：全站唯一 URL 路由（含登录回跳/刷新恢复）在途；现状仅 hash 页级恢复。
- 🔴 U103：刷新 Orca Web 停留在旧登录界面（工作区侧续会话，非平台登录页）。

## 6. 测试覆盖

- `cloud-platform/test/ldap-admission.test.ts`：A1–A12（准入成功/两条拒绝路径/再入组/未配置/精确 CN/凭据优先/移出组不追溯/审计落链）。
- `cloud-platform/test/ldap-mock-required-group.test.ts`：Mock 准入组精确匹配、大小写/前后缀、先密码后组、未配置零回归。
- `cloud-platform/test/e2e/ldap-admission.e2e.test.ts`：E1–E6（真实平台进程；含 handoff 传递覆盖、拒绝不污染锁定、审计可检索）。
- `cloud-platform/test/e2e/login-lockout-shared.e2e.test.ts`：三副本共享计数、锁定服务不可达 fail-closed。
- `cloud-platform/test/e2e/session-renewal.e2e.test.ts`：短 TTL 过期→刷新旋转→旧 token 复用作废；refresh 过期被拒。
- `cloud-platform/test/e2e/web-exploratory-fixes.e2e.test.ts`：M116-QA-012 空登录不发请求；R5-① 退出清空登录框凭据。
- `cloud-platform/test/e2e/web-admin-gating.e2e.test.ts`：开发者/管理员登录后的导航与门禁（联动 M2）。
- `cloud-platform/test/e2e/u106-console-routing.e2e.test.ts`：登录回跳与深链刷新（联动 M2）。
- `cloud-platform/test/cloud-admission-parity.test.ts`：平台/宿主凭证实现一致性（认证凭证族，不含登录 UI）。

## 7. 未覆盖 / 存疑

- 浏览器端「401→静默 refresh→重放请求」无专门 e2e（`session-renewal` 只钉 API 旋转语义）。
- 登录页网络错误（fetch 抛 TypeError）无专门用例，界面会直接显示底层错误文本。
- LDAP 准入拒绝在**管理台 UI** 的中文错误呈现无 e2e（E1/E2 走 HTTP 断言）。
- 密码显示切换、登录中按钮禁用态无 e2e。
- 生产 LDAPS adapter 不在本仓库实现（仅 Mock），真实 bind/`memberOf` 过滤行为无法从当前代码验证。
- 「刷新后仅缓存 user、无 token」路径无 e2e。
