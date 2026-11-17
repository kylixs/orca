# M1 登录与认证（现状）

> 基线提交：`fe35a9d355a`（2026-11-18）｜来源：`cloud-platform/apps/web/app.js`、`cloud-platform/apps/api/src/{server.ts,refresh-cookie.ts,web-release.ts}` 代码阅读 + 已提交套件。文中行号均指该 HEAD（工作树若含未提交改动会使行号偏移）。
> 刷新记录：2026-11-18 按 HEAD `fe35a9d355a` 重写，覆盖 U197 Cookie 会话（登录形态/双读刷新/页面恢复/登出）、U218 登出撤销与 CSRF、U219/D17 迁移缺口、U220 Origin 边界、U221–U223 客户端硬化、U225–U227 测试收紧。U228（禁用账号登录/刷新复查）尚未合入 HEAD，文内标「修复中」。
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

| 入口         | 位置                                                 | 门槛     |
| ------------ | ---------------------------------------------------- | -------- |
| 登录表单     | 未登录视图（`showLogin()`）；无 token/恢复失败时显示 | 无       |
| 退出         | 侧栏用户盒「退出」                                   | 已登录   |
| 查看无权限页 | 顶栏；登录后按角色显隐——**管理员隐藏**，非管理员可见 | 非管理员 |

## 3. 操作清单

| #   | 触发面                                     | 结果                                                                                                                                                                                                                                                                                                                                                                  | 弹窗/确认 | 失败态                                                                                                                                                                | 权限门槛   |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A1  | 空账号或空密码提交                         | 客户端拦截，**不发请求**（避免烧锁定次数），账号/密码框标红                                                                                                                                                                                                                                                                                                           | 无        | 行内「请输入域账号和密码。」，焦点回账号框                                                                                                                            | 无         |
| A2  | 账号+密码提交成功                          | `POST /v1/auth/login`（含 `username/password/deviceId/deviceName/devicePubKey:'web-client'`）。**Cookie 模式**（服务端同源 + `ORCA_CLOUD_COOKIE_MODE` 生效）：`Set-Cookie: orca_refresh=…`，body 仅 `accessToken/refreshCookie:true/expiresIn/user/device`，无 refresh；客户端写 `orca.authMode='cookie'`，access 仅内存，localStorage 不写令牌。**never/旧服务端**：body 含 `accessToken/refreshToken`，客户端写 `orca.access/orca.refresh`。两种模式都写 `orca.user/orca.device`；进主框架；按当前 hash 恢复深链；空 hash 或 `#/login` → `#/workbench` | 无        | —                                                                                                                                                                     | 无         |
| A3  | 密码错误                                   | 服务端 `401 INVALID_CREDENTIALS`，失败计数 +1                                                                                                                                                                                                                                                                                                                         | 无        | 行内「账号或密码错误，请重试。」；密码框标红并聚焦；按钮恢复「登录」                                                                                                  | 无         |
| A4  | 连续 5 次失败                              | 服务端 `423 ACCOUNT_LOCKED`（计数共享时跨副本累计；进程内默认 5 次 / 15 分钟）                                                                                                                                                                                                                                                                                        | 无        | 行内「连续 5 次失败，账号已锁定 15 分钟。」；锁定期间再试直接 423「账号已锁定，请 15 分钟后再试。」并记审计 `login/failure reason=locked`                             | 无         |
| A5  | 账号不在 LDAP 准组                         | 服务端 `401 LDAP_GROUP_NOT_ADMITTED`；两条拒绝路径（adapter filter miss / 平台闸门）同码同文案；审计 `reason=ldap_group_denied`；**不计数也不清锁定**                                                                                                                                                                                                                  | 无        | 行内显示服务端文案「账号未加入平台准入组。」                                                                                                                          | 准入组由 `ORCA_CLOUD_LDAP_REQUIRED_GROUP`（或 config `ldapRequiredGroup`）控制；空白=关闭 |
| A6  | 点击密码框眼睛                             | 明文/密文切换                                                                                                                                                                                                                                                                                                                                                         | 无        | —                                                                                                                                                                     | 无         |
| A7  | 任意业务请求返回 401                       | `api()` 只尝试**一次刷新+一次重放**（`app.js:57-84`）。Cookie 模式先发一次无 body `/v1/auth/refresh`（`credentials:'same-origin'`）；无 Cookie 可解析时才用 body 回退（`app.js:169-190`）。刷新结果三态：`ok` 重放；`rejected`（HTTP 非 2xx）→ `logout()`；`error`（传输失败）→ **不登出**，失败原请求交给调用方（`app.js:105-166`）。并发 401 共享一次刷新（`app.js:86-88`） | 无        | 刷新被拒 → 清会话回登录页。**重放仍 401**：HEAD 仅把错误抛给调用方、**不自动登出**（会停留在只显示「加载失败」的壳）；U228 修复中，未提交 diff 在 `retried` 分支补 `logout()` | 已登录     |
| A8  | 刷新/重开页面                              | **Cookie 模式**：一次无 body 刷新 → 成功后 `GET /v1/me`（`retried:true`，不启动第二条刷新链）→ 进主框架（`app.js:5144-5162`）。**旧模式**：有 access 时 `GET /v1/me`，401 触发 body 刷新并重放一次（`app.js:5163-5175`；`u198-legacy-reload` 断言顺序 `/v1/me:401 → refresh:200 → /v1/me:200`）。`orca.pendingLogout=1` 时**先显示登录页**再补发一次登出、不自动进入（`app.js:5135-5141`） | 无        | 刷新失败/`/v1/me` 失败 → 移除缓存 user、显示登录页。仅缓存 user、无 access/无 Cookie 模式时直接登录页（`session-renewal` AC-M1-14）                                      | 有本地会话 |
| A9  | 点击「退出」                               | 关闭工作区 iframe → 置 `orca.pendingLogout=1` → 异步 `POST /v1/auth/logout`（同时带 Bearer 与同源 Cookie；服务端清 Cookie 的多作用域并撤销 Bearer/Cookie 定位到的**全部** session，`server.ts:3843-3891`）→ 本地清 access/refresh/tokenOwner、`orca.authMode`、缓存 user 与登录框输入 → 回登录页。请求网络失败保留标记，下次加载重试一次；收到 2xx 或 401 即删标记（`app.js:4946-4990`）。多标签为**被动**登出：另一标签下一次请求 401 → 刷新被拒 → 登出（`u197-web-cookie-browser` AC7） | 无        | 登出请求失败被吞，本地仍清空；HttpOnly Cookie 由下次加载的补发清理                                                                                                    | 已登录     |

**登录响应形态（HEAD）**

- Cookie 下发的判定只看 `Origin` 与配置的 `ORCA_CLOUD_PUBLIC_ORIGIN` 是否同源，**不用 Host/X-Forwarded-Proto**（`server.ts:1973-1977`、`refresh-cookie.ts:134-148`）。
- 同源登录：`Set-Cookie` + body `{accessToken, refreshCookie:true, expiresIn, user, device}`，body **无** `refreshToken`（`server.ts:3500-3516`）。
- 非同源/无 Origin/`never`：body `{accessToken, refreshToken, expiresIn, user, device}`，无 Cookie（`server.ts:3502-3505`）。
- 平台同源 handoff 同 Cookie 模式；宿主跨源 handoff 保留 body refresh（`server.ts:3826-3829`）。
- 客户端能力标记：`orca.authMode='cookie'`（`app.js:5-7,90-94`）；账号归属标记：`orca.tokenOwner`（`app.js:8-9,199-210`）；登出欠账标记：`orca.pendingLogout`（`app.js:10-11`）。

**刷新语义（HEAD）**

- 服务端**双读**：能解析出 Cookie session 时以 Cookie 为准，body 只作回显/宽限判定（`server.ts:3527-3535`）。
- Cookie 源**不轮换**：current 每次命中只续 access、滑动 `refreshExpiresAt`、同值重发 Cookie（`refreshCookie:true`）；重建失败时保留浏览器原 Cookie（`server.ts:3647-3664`）。
- previous（宽限内）只发 access，不续期、不重发 Cookie；宽限外或既非 current 也非 previous → 撤销 session + 401 + `refresh.reuse_detected`（`server.ts:3566-3631`）。
- body 源（无 Cookie 或 Cookie 无法解析）：current 正常轮换并置 `previousRefreshHash/graceUntil`，同源时例外地同时 `Set-Cookie`；previous 在宽限内回显请求值、不轮换；宽限外撤销并 401；未知 token 直接 401（不撤销未知会话）（`server.ts:3667-3731`）。
- 客户端三态 `ok/rejected/error`，只有 `rejected` 触发登出（`app.js:105-190`）。

**页面恢复分支（HEAD）**

- Cookie 模式：一次无 body 刷新；成功才删旧键（`refreshWithCookie` 成功后 `clearLegacyTokens`），随后 `/v1/me`（`app.js:106-128,5144-5162`）。
- 旧模式：`/v1/me` 401 → body 刷新 → 重放（`app.js:5163-5175`）。启动期 body 刷新成功后在 `/v1/me` 拿到用户名时补写 `tokenOwner`（`app.js:205-210`；`u198-legacy-reload`、`web-refresh-cookie` U222 N3）。
- 迁移分支 **⛔ 未实现**：无 `orca.authMode` 标记时**不**发起无 body 探测；AC9b（有旧键）与 AC9c（无旧键、仅有效 Cookie）字面行为不成立，阻塞于 D17/U219（`u197-migration-browser` AC15(g) skip、`u197-web-cookie-browser` AC9c skip）。旧构建换新构建后首次加载不刷新，access 过期后才走一次 body 回退并置标记（`u197-migration-browser` INVALID-FACT）。

**会话参数与配置（HEAD）**

| 项          | 现状                                                                                                                                                                 | 来源                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| access TTL  | 默认 30 分钟；`ORCA_CLOUD_ACCESS_TTL_MS` / `accessTtlMs` 可覆盖                                                                                                       | `server.ts:136,1939`                                    |
| refresh TTL | 默认 12 小时；`ORCA_CLOUD_REFRESH_TTL_MS` / `refreshTtlMs` 可覆盖                                                                                                     | `server.ts:137,1940`                                    |
| grace       | 默认 30 秒，上限 60 秒；`ORCA_CLOUD_REFRESH_GRACE_MS`；`0`=严格复用；非法/负数回落默认                                                                                | `server.ts:138-140,270-279`                             |
| Cookie 属性 | `Path=/v1/auth`、`HttpOnly`、`SameSite=Lax`、`Max-Age=ceil(refreshTTL/1000)`；下发不带 Domain；`Secure` 见下                                                         | `refresh-cookie.ts:60-80`；`server.ts:2021-2031`        |
| 清理作用域  | host-only `/v1/auth` + Domain `/v1/auth`（origin 为域名时）+ 旧构建 `Path=/`；重复 Cookie 也按这三条清                                                                 | `refresh-cookie.ts:93-113`；`server.ts:2033-2047`       |
| 模式        | `auto`（默认）/`always`/`never`；`auto` 无有效 origin 降级 `never` 并告警一次；`always` 无 origin 启动即失败；非法值回落 `auto`                                       | `refresh-cookie.ts:173-212`；`server.ts:1958-1967`      |
| Secure      | `always` 强制加；`auto` 在 https 或 loopback http 加；非 loopback http 省略并告警                                                                                    | `refresh-cookie.ts:193-211`                             |
| PUBLIC_ORIGIN | 规范化 origin（scheme/host 小写、去默认端口与尾斜杠）；只用于同源判断与 Cookie 作用域，不信任 XFP/Host                                                                 | `refresh-cookie.ts:115-148`；`server.ts:1969-1977`      |

**失败分支（HEAD）**

| 分支                     | 现象                                                                                                                             | 来源                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| CSRF 403                 | Cookie 认证的刷新缺失/跨源/`null` Origin，或 `content-type` 不是 `application/json` → `403 CSRF_REJECTED`，无续期/清理副作用       | `server.ts:2009-2019,3536-3540`；`refresh-cookie` CSRF 用例                            |
| 重复 Cookie 401          | `orca_refresh` 出现两次（同名/多 Cookie 头）→ 登录/handoff/刷新/登出一律硬 `401 SESSION_EXPIRED`，清三种作用域，**不回退 body、不轮换、不撤销 session**（刷新） | `server.ts:1979-1982,3395-3399,3522-3526,3737-3741,3844-3847`；`refresh-cookie` 245/267 |
| Cookie 缺失              | 服务端回退 body 刷新；Cookie 模式客户端若无旧 refresh → `rejected` → 回登录，无循环                                               | `server.ts:3667-3675`；`app.js:5144-5161`；`u197-web-cookie-browser`                   |
| 传输失败                 | 客户端记为 `error`：页内请求**不登出**、保留会话、恢复后可重试；启动探测失败→登录页，不空白/无未捕获异常                          | `app.js:117-120,143-146,176-183`；`web-refresh-cookie` U222 N1、`u197-web-cookie-browser` 597/642 |
| 外来 Origin 登录         | 配置了 PUBLIC_ORIGIN 时非平台 Origin 登录 → `403 CSRF_REJECTED`，不下发 body refresh                                              | `server.ts:2001-2007,3406-3409`；`refresh-cookie` 139                                 |
| 带 Cookie 但无 Origin    | 登录/handoff → `401 SESSION_EXPIRED`，不按 Cookie 源解析                                                                          | `server.ts:1988-1994,3402-3405`；`refresh-cookie` 149                                 |
| 刷新被拒                 | 客户端 `logout()`，清本地并回登录页                                                                                              | `app.js:67-74`                                                                         |
| refresh 过期/会话已撤销  | 服务端 `401 SESSION_EXPIRED` 并清 Cookie                                                                                         | `server.ts:3543-3546,3672-3675`                                                        |
| 禁用账号                 | **HEAD 未复查**：登录不检查 `user.status`（仅业务请求的 `resolveToken` 拒绝）；登录 200 → 业务 401、刷新仍 200、重放 401、不自动登出（探索 E1）。**U228 修复中**（未提交 diff：登录/刷新拒绝非 active 并撤销会话、客户端重放仍 401 即登出） | `server.ts:2819-2834`（HEAD）；`test-reports/u197-auth-exploration-20261118.md` E1     |

**服务端认证语义（现状）**

- 密码只经 LDAP adapter 校验，平台不存密码；生产为 LDAPS simple-bind adapter（代码中仅 Mock 实现，`ldap.ts` 注释声明生产接同接口）。
- 准入组语义（U69a 裁定）：**组=登录准入，不是角色映射**；新用户首登角色一律 `developer`，角色由平台内用户管理覆盖（`roleOverride` 优先）。
- 会话：access/refresh TTL 见上表；旧 body 模式 refresh 每次旋转，旧值宽限期内可复用、宽限期外撤销会话；Cookie 模式 refresh 不轮换。
- 锁定计数：配置 `ORCA_CLOUD_LOGIN_LOCKOUT_URL` 时走共享服务（不可达 → 登录 `503 PLATFORM_UNAVAILABLE`，fail-closed）；未配置时进程内计数（5 次 / 15 分钟）。
- 审计：登录成功/失败、登出、`refresh.reuse_detected`、`refresh.grace_reuse` 均落链；复用事件只记来源，不记 token（`server.ts:3571-3579,3600-3608,3684-3692`；`refresh-cookie` 审计用例）。

## 4. 数据来源

| 面         | 来源                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| 登录       | `POST /v1/auth/login`（Cookie 模式：`accessToken/refreshCookie:true/expiresIn/user/device`；旧模式另含 `refreshToken`） |
| 静默续会话 | `POST /v1/auth/refresh`（Cookie 优先，body 回退）                                                                         |
| 恢复会话   | `GET /v1/me`                                                                                                              |
| 登出       | `POST /v1/auth/logout`（Bearer + Cookie 双凭证）                                                                          |
| 本地存储   | `orca.user`、`orca.device`（两模式）；`orca.access`、`orca.refresh`、`orca.tokenOwner`（仅旧模式）；`orca.authMode`（能力标记）、`orca.pendingLogout`（登出欠账） |
| Cookie     | `orca_refresh`（`Path=/v1/auth; HttpOnly; SameSite=Lax`，仅同源平台与 Cookie 模式）                                        |
| 锁定/准入  | 共享锁定服务或进程内计数；LDAP adapter 的 groups（`profile.groups`）                                                      |

## 5. 已知缺陷（台账）

- 🟢 U8：跨源登录 network_error（平台缺 CORS）——已修。
- 🟢 U13：开发模式带 `ORCA_CLOUD_API_URL` 启动看不到登录页——已修（准入只认显式宿主信号）。
- 🟢 U53②：退出登录后登录框凭据残留（可一键恢复上一账号）——已修。
- 🟢 U69a：LDAP 组→角色映射方向错误撤回；现状=分组准入 + 平台内角色。
- 🟢 U72：审计员角色的登录后导航/直达路由门禁（联动 M2）。
- 🟢 U197：HttpOnly refresh Cookie 传输（S1 服务端基建 → S2 双读/grace/CSRF → S4 客户端能力门控 → S5 真实浏览器验收）已落地，默认 `auto` 无 origin 时保持旧契约。
- 🟢 U218/U220：登出撤销 Bearer/Cookie 两个 session、多作用域清理、Origin/CSRF 边界（含 IP 字面量省略 Domain）已修。
- 🟢 U221/U222：启动/页内传输失败不空白、不误登出；`tokenOwner` 防跨账号回退；`pendingLogout` 重试；`/v1/auth/*` 携带 `x-orca-web-contract`。
- 🟢 U225/U226/U227：迁移夹具、never 模式刷新契约、XFP/重复 Cookie 断言收紧（测试）。
- 🟡 U219/D17：迁移分支 AC9b/AC9c「能力未知探测」未实现；首次加载不迁移，依赖后续登录/响应逐步开启。
- 🔴 U228：禁用账号仍可登录并续期（探索 E1）；修复未合入 HEAD。
- 🟡 U106：全站唯一 URL 路由（含登录回跳/刷新恢复）在途；现状仅 hash 页级恢复。
- 🔴 U103：刷新 Orca Web 停留在旧登录界面（工作区侧续会话，非平台登录页）。

## 6. 测试覆盖

**认证/会话专项（HEAD 已提交）**

- `cloud-platform/test/refresh-cookie.test.ts`：纯单元——Cookie 解析（缺失/空值/重复/多 header）、序列化属性与清理三作用域（含 IP 字面量省略 Domain）、origin 规范化/同源、模式解析（auto 降级/always 拒启/never 惰性/非法回落/Secure 判定）。**无浏览器**。
- `cloud-platform/test/e2e/refresh-cookie.e2e.test.ts`：**in-process `createApp` + Node fetch**（非浏览器）——S1 登录/交接/刷新/登出的 Cookie 形态与能力标记、无 Origin/外来 Origin、never 回归；S2 双读/grace/CSRF/并发/审计；U218 登出撤销与多作用域、XFP/Host 伪造、启动矩阵。
- `cloud-platform/test/e2e/u197-cookie-browser.e2e.test.ts`：**真实 Chromium + 真实 API 进程**——HttpOnly Cookie 罐、空 body 刷新同值重发与 TTL 滑动、跨 Origin/非 JSON 403、重复 Cookie 硬 401 与作用域清理、多标签刷新、never 模式单次告警、日志/审计无明文 refresh。
- `cloud-platform/test/e2e/u197-web-cookie-browser.e2e.test.ts`：**真实 Chromium**——AC9a 标记真 + 旧键迁移、登录后 `document.cookie`/localStorage 无令牌、AC12 重载一次刷新进入、多标签同刷、Cookie 缺失/伪造标记一次失败回登录、AC14 页内 401 一次刷新重放、并发 401 只刷一次、真实登出清 Cookie/旧键/标记、AC7 双标签被动登出、U222 N1 传输失败保留会话、启动传输失败不空白；AC9c（清 localStorage 仅 Cookie）**skip（D17/U219）**。
- `cloud-platform/test/e2e/web-refresh-cookie.e2e.test.ts`：**happy-dom + 真实 `createApp`**——无标记保持旧契约、`refreshCookie:true` 不落盘、重载恢复与删键时机、Cookie/body 双失败回登录、页内 401 无 refreshToken 也刷新、登出清理、U221 F2/F3/F4、U222 N1/N2/N3/N4、`x-orca-web-contract` 头。
- `cloud-platform/test/e2e/session-renewal.e2e.test.ts`：**happy-dom + 真实 `createApp`**——短 TTL 旋转与旧 token 复用作废、refresh 过期拒绝、401 一次刷新一次重放（AC-M1-04）、并行 401 共享刷新（U134）、刷新失败/登出失败/仅缓存 user 的收尾（AC-M1-13/14/15）。
- `cloud-platform/test/e2e/u197-ac-probes.e2e.test.ts`：**真实 Chromium**——AC1 登录/刷新/登出后存储无令牌；AC2 access 过期 reload 恰好一次无 body 刷新；AC4 存储/Cookie/URL/console/响应体/审计均无 refresh。
- `cloud-platform/test/e2e/u197-migration-browser.e2e.test.ts`：**真实 Chromium**——AC9d 标记真 + 无有效 Cookie + 失效旧键（1 次无 body + 1 次 body，均 401，保留旧键）；AC15(g) 旧构建字面量 `undefined` 夹具；INVALID-FACT 换新构建首次加载不迁移；AC15(g) 单次重载迁移 **skip**；U225 N3R Cookie 标记 + never 服务端补写 `tokenOwner`、纯 Cookie 模式不写；伪造 Cookie + 假 body 判别力。
- `cloud-platform/test/e2e/u198-legacy-reload.e2e.test.ts`：**真实 Chromium**——旧 localStorage 模式 access 过期 reload 恰一次 body 刷新、access/refresh 轮换、`tokenOwner` 回填；负例失效 refresh + 过期 access 恰一次 401 后回登录、无循环。
- 探索报告（工作文档，不入库）：`cloud-platform/test-reports/u197-auth-exploration-20261118.md`——真实 API + 真实 headless Chromium 32 PASS / 1 SUSPECT（E1=U228），覆盖禁用账号、多标签、Cookie 边界、传输失败、legacy→cookie 回滚。

**既有登录/准入套件**

- `cloud-platform/test/ldap-admission.test.ts`：A1–A12（准入成功/两条拒绝路径/再入组/未配置/精确 CN/凭据优先/移出组不追溯/审计落链）。
- `cloud-platform/test/ldap-mock-required-group.test.ts`：Mock 准入组精确匹配、大小写/前后缀、先密码后组、未配置零回归。
- `cloud-platform/test/e2e/ldap-admission.e2e.test.ts`：E1–E6（真实平台进程；含 handoff 传递覆盖、拒绝不污染锁定、审计可检索）。
- `cloud-platform/test/e2e/login-lockout-shared.e2e.test.ts`：三副本共享计数、锁定服务不可达 fail-closed。
- `cloud-platform/test/e2e/web-exploratory-fixes.e2e.test.ts`：M116-QA-012 空登录不发请求；R5-① 退出清空登录框凭据；G03 网络异常可读文案、LDAP 401 文案逐字展示、登录中禁用且重复提交零新增请求。
- `cloud-platform/test/e2e/web-admin-gating.e2e.test.ts`：开发者/管理员登录后的导航与门禁（联动 M2）。
- `cloud-platform/test/e2e/u106-console-routing.e2e.test.ts`：登录回跳与深链刷新（联动 M2）。
- `cloud-platform/test/cloud-admission-parity.test.ts`：平台/宿主凭证实现一致性（认证凭证族，不含登录 UI）。

## 7. 未覆盖 / 存疑

- ⛔ **U219/D17（AC9b/AC9c/AC15(g)）**：迁移分支「无能力标记时加载先发一次无 body 探测」未实现；`u197-migration-browser` 的 AC15(g) 单次重载用例与 `u197-web-cookie-browser` 的 AC9c 均为 skip。现状是渐进迁移，且换新构建首次加载不迁移（INVALID-FACT 已如实标注）。
- ⛔ **U228**：禁用账号的登录/刷新复查与客户端「重放仍 401 即登出」在 HEAD 未合入；探索 E1 的真实行为（登录 200、刷新 200、重放 401、不登出）仍是现状。
- 浏览器端「Cookie 模式页内 401 → 刷新 → 重放仍 401」的**自动登出**分支无已提交 e2e（U228 修复需补）。
- 生产 LDAPS adapter 不在本仓库实现（仅 Mock），真实 bind/`memberOf` 过滤行为无法从当前代码验证。
- 「刷新后仅缓存 user、无 token」路径由 `session-renewal` AC-M1-14 覆盖（happy-dom），真实 Chromium 无同名用例。
- 登录页密码显示切换仍仅手测（WEB-R2-011）。
- 探测/验证命令：`pnpm test cloud-platform/test/e2e/refresh-cookie.e2e.test.ts`、`…/u197-web-cookie-browser.e2e.test.ts`、`…/u198-legacy-reload.e2e.test.ts`（真实 Chromium 需本机可启动 headless Chromium）。
