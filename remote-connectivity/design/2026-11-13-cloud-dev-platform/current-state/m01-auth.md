# M1 登录与认证（现状）

> 基线提交：`214a58f6f1c`（`server.ts` 行号按冻结代码 `28964a07a67` 校准，文档提交 `214a58f6f1c`；`app.js` 等引用为历史版本，原基线 `a5d6d2162b4`/2026-11-18）｜来源：`cloud-platform/apps/web/app.js`、`cloud-platform/apps/api/src/{server.ts,refresh-cookie.ts,web-release.ts}` 代码阅读 + 已提交套件。文中 `server.ts` 行号均指该 HEAD（工作树若含未提交改动会使行号偏移）。
> 刷新记录：2026-11-18 按 HEAD `39ad743d793`（U228 后）整理，覆盖 U197 Cookie 会话（登录形态/双读刷新/页面恢复/登出）、U218 登出撤销与 CSRF、U219/D17 迁移探测、U220 Origin 边界、U221–U223 客户端硬化、U225–U227 测试收紧。U228（禁用账号登录/刷新复查）已合入 `39ad743d793`（登录/刷新拒绝非 active 并撤销会话；客户端重放仍 401 即登出）。
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
| A7  | 任意业务请求返回 401                       | `api()` 只尝试**一次刷新+一次重放**（`app.js:70-108`）。Cookie 模式先发一次无 body `/v1/auth/refresh`（`credentials:'same-origin'`）；无 Cookie 可解析时才用 body 回退（`app.js:259-297`）。刷新结果四态：`ok` 重放；`rejected`（HTTP **400/401**）→ `logout()`；`error`（403/408/429/5xx 与传输失败）→ **不登出**，失败原请求交给调用方；`stale`（auth 代际已变）→ 不写状态/不登出，交回原 401（`app.js` U229/U232）。并发 401 共享一次刷新（`app.js:110-112`） | 无        | 刷新被拒 → 清会话回登录页。**重放仍 401**：`retried` 分支直接 `logout()` 回登录页（U228 `39ad743d793`，裸 fetch 不递归） | 已登录     |
| A8  | 刷新/重开页面                              | **Cookie 模式**：一次无 body 刷新 → 成功后 `GET /v1/me`（`retried:true`，不启动第二条刷新链）→ 进主框架（`app.js:5321-5350`）。**旧模式**：有 access 时 `GET /v1/me`，401 触发 body 刷新并重放一次（`app.js:5352-5367`；`u198-legacy-reload` 断言顺序 `/v1/me:401 → refresh:200 → /v1/me:200`）。`orca.pendingLogout=1` 时**先显示登录页**再补发一次登出、不自动进入（`app.js:5312-5317`） | 无        | 刷新失败/`/v1/me` 失败 → 移除缓存 user、显示登录页。仅缓存 user、无 access/无 Cookie 模式时直接登录页（`session-renewal` AC-M1-14）                                      | 有本地会话 |
| A9  | 点击「退出」                               | 关闭工作区 iframe → 置 `orca.pendingLogout=1` → 异步 `POST /v1/auth/logout`（同时带 Bearer 与同源 Cookie；服务端清 Cookie 的多作用域并撤销 Bearer/Cookie 定位到的**全部** session，`server.ts:4353-4432`）→ 本地清 access/refresh/tokenOwner、`orca.authMode`、缓存 user 与登录框输入 → 回登录页。请求网络失败保留标记，下次加载重试一次；收到 2xx 或 401 即删标记（`app.js:5081-5145`）。多标签为**被动**登出：另一标签下一次请求 401 → 刷新被拒 → 登出（`u197-web-cookie-browser` AC7） | 无        | 登出请求失败被吞，本地仍清空；HttpOnly Cookie 由下次加载的补发清理                                                                                                    | 已登录     |

**会话代际与迁移 owner 策略（U229）**

- `state.authEpoch`：`login()` 发起/成功、`logout()` 自增并清空 `refreshInFlight`；刷新在每次 await 后校验代际，过期结果返回 `'stale'` 且**不写** state/storage、不改能力标记、不登出（`app.js:70-297`）。`api()` 遇 `'stale'` 把原 401 交回调用方，不重放。
- 旧键 owner：登录成功时 `orca.tokenOwner` 为空或与本次用户名不同 → 清除旧键；Cookie 模式启动且 Cookie 刷新失败时，仅 owner 与 `orca.user` 一致才允许 body 回退，否则清键（`app.js:244-252,281-284,5067-5070`）。无 owner 的 pre-U221 键不再作为回退来源（跨账号防护）。
- 登出：请求体携带 `{refreshToken}`（非 Cookie 模式），服务端据此定位并撤销 legacy 会话（U229 F10）；慢登出响应在重新登录后被 abort，不再清除新 Cookie（U229 F3）。
- grace 回显：body 回退响应 `refreshToken` 等于请求值且无 `refreshCookie` → 视为未轮换，只更新 access、保留标记与旧键（U229 F4）。

**登录响应形态（HEAD）**

- Cookie 下发的判定只看 `Origin` 与配置的 `ORCA_CLOUD_PUBLIC_ORIGIN` 是否同源，**不用 Host/X-Forwarded-Proto**（`server.ts:2304-2309`、`refresh-cookie.ts:134-148`）。
- 同源登录：`Set-Cookie` + body `{accessToken, refreshCookie:true, expiresIn, user, device}`，body **无** `refreshToken`（`server.ts:3959-3974`）。
- 非同源/无 Origin/`never`：body `{accessToken, refreshToken, expiresIn, user, device}`，无 Cookie（`server.ts:3962`）。
- 平台同源 handoff 同 Cookie 模式；宿主跨源 handoff 保留 body refresh（`server.ts:4336-4341`）。
- 客户端能力标记：`orca.authMode='cookie'`（`app.js:5-7,138-142`）；账号归属标记：`orca.tokenOwner`（`app.js:8-9,299-317`）；登出欠账标记：`orca.pendingLogout`（`app.js:10-11`）。

**刷新语义（HEAD）**

- 服务端**双读**：能解析出 Cookie session 时以 Cookie 为准，body 只作回显/宽限判定（`server.ts:3984-3992`）。
- Cookie 源**不轮换**：current 每次命中只续 access、滑动 `refreshExpiresAt`、同值重发 Cookie（`refreshCookie:true`）；重建失败时保留浏览器原 Cookie（`server.ts:4126-4142`）。
- previous（宽限内）只发 access，不续期、不重发 Cookie；宽限外或既非 current 也非 previous → 撤销 session + 401 + `refresh.reuse_detected`（`server.ts:4021-4026,4045-4093`）。
- body 源（无 Cookie 或 Cookie 无法解析）：current 正常轮换并置 `previousRefreshHash/graceUntil`，同源时例外地同时 `Set-Cookie`；previous 在宽限内回显请求值、不轮换；宽限外撤销并 401；未知 token 直接 401（不撤销未知会话）（`server.ts:4144-4228`）。
- 撤销一致性（U241/D20）：所有 session 级撤销经 `revokeSessionOnce`——仅在 `revokedAt === null` 时置值并 `bumpEpoch`（幂等）；覆盖过期/已撤销拒绝、reuse 三处、禁用、登出、设备批量。首个撤销者写恰一条 `session.expired`（刷新过期与 sweep 共用同一写点）；禁用刷新写 `session.revoked success`（`reason:USER_DISABLED`，不再写 `logout denied`）；reuse 恰一条 `refresh.reuse_detected`；已撤销再命中不重复 bump。
- 客户端三态 `ok/rejected/error`，只有 `rejected` 触发登出（`app.js:155-297`）。

**页面恢复分支（HEAD）**

- Cookie 模式：一次无 body 刷新；成功才删旧键（`refreshWithCookie` 成功后 `clearLegacyTokens`），随后 `/v1/me`（`app.js:162-190,5321-5350`）。
- 旧模式：`/v1/me` 401 → body 刷新 → 重放（`app.js:5352-5367`）。启动期 body 刷新成功后在 `/v1/me` 拿到用户名时补写 `tokenOwner`（`app.js:312-317`；`u198-legacy-reload`、`web-refresh-cookie` U222 N3）。
- 迁移分支 **已实现（U219/D17，`4e808df20f2`；后续 `296dcf40ac7`/`b0183c972f`）**：无 `orca.authMode` 标记时按「能力未知」处理——启动先发一次无 body 探测；成功即进入 Cookie 模式并删旧键（AC9b/AC9c），被拒时最多花一次 body 回退并写 `legacy`；探测传输故障（403/408/429/5xx/传输）不当会话裁决，有持久 access 时继续走 `/v1/me`，失败探测 60 秒退避（U249）。`u197-migration-browser` AC15(g) 与 `u197-web-cookie-browser-race-probe` AC9c 已去 skip。

**会话参数与配置（HEAD）**

| 项          | 现状                                                                                                                                                                 | 来源                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| access TTL  | 默认 30 分钟；`ORCA_CLOUD_ACCESS_TTL_MS` / `accessTtlMs` 可覆盖                                                                                                       | `server.ts:145,2270`                                    |
| refresh TTL | 默认 12 小时；`ORCA_CLOUD_REFRESH_TTL_MS` / `refreshTtlMs` 可覆盖                                                                                                     | `server.ts:146,2271`                                    |
| grace       | 默认 30 秒，上限 60 秒；`ORCA_CLOUD_REFRESH_GRACE_MS`；`0`=严格复用；非法/负数回落默认                                                                                | `server.ts:147-149,305-310`                             |
| Cookie 属性 | `Path=/v1/auth`、`HttpOnly`、`SameSite=Lax`、`Max-Age=ceil(refreshTTL/1000)`；下发不带 Domain；`Secure` 见下                                                         | `refresh-cookie.ts:60-80`；`server.ts:2352-2362`        |
| 清理作用域  | host-only `/v1/auth` + Domain `/v1/auth`（origin 为域名时）+ 旧构建 `Path=/`；重复 Cookie 也按这三条清                                                                 | `refresh-cookie.ts:93-113`；`server.ts:2364-2378`       |
| 模式        | `auto`（默认）/`always`/`never`；`auto` 无有效 origin 降级 `never` 并告警一次；`always` 无 origin 启动即失败；非法值回落 `auto`                                       | `refresh-cookie.ts:173-212`；`server.ts:2289-2294`      |
| Secure      | `always` 强制加；`auto` 在 https 或 loopback http 加；非 loopback http 省略并告警                                                                                    | `refresh-cookie.ts:193-211`                             |
| PUBLIC_ORIGIN | 规范化 origin（scheme/host 小写、去默认端口与尾斜杠）；只用于同源判断与 Cookie 作用域，不信任 XFP/Host                                                                 | `refresh-cookie.ts:115-148`；`server.ts:2289-2294`      |

**失败分支（HEAD）**

| 分支                     | 现象                                                                                                                             | 来源                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| CSRF 403                 | Cookie 认证的刷新缺失/跨源/`null` Origin，或 `content-type` 不是 `application/json` → `403 CSRF_REJECTED`，无续期/清理副作用       | `server.ts:2344-2350,3995-3997`；`refresh-cookie` CSRF 用例                            |
| 重复 Cookie 401          | `orca_refresh` 出现两次（同名/多 Cookie 头）→ 登录/handoff/刷新/登出一律硬 `401 SESSION_EXPIRED`，清三种作用域，**不回退 body、不轮换、不撤销 session**（刷新） | `server.ts:2310-2313,3830-3834,3977-3982,4242-4246,4357,4428-4430`；`refresh-cookie` 245/267 |
| Cookie 缺失              | 服务端回退 body 刷新；Cookie 模式客户端若无旧 refresh → `rejected` → 回登录，无循环                                               | `server.ts:4144-4165`；`app.js:5321-5350`；`u197-web-cookie-browser`                   |
| 传输失败                 | 客户端记为 `error`：页内请求**不登出**、保留会话、恢复后可重试；启动探测失败→登录页，不空白/无未捕获异常（启动含 10s 超时，U229 F5）                          | `app.js:174-179,208-212,273-285`；`web-refresh-cookie` U222 N1、`u197-web-cookie-browser-race-probe` 496/541 |
| 刷新 5xx/429/403         | 客户端归 `error`：不登出、保留会话，业务错误交给调用方（U229 F7） | `app.js` `refreshVerdict`；`u229-web-startup-resilience` |
| 登录 200 非契约响应      | 校验 `accessToken/user.username/device.id`，不满足抛 `PLATFORM_UNAVAILABLE`「平台响应异常」，不写 `"undefined"`（U229 F6） | `u229-web-startup-resilience` |
| 非对象 JSON body         | `readJson` 将 `null`/标量归一为 `{}`（数组/对象保留），各端点返回既有 4xx 而非 500（U236） | `u236-non-object-body` |
| 登出带重复 Cookie        | 清三作用域后仍用 Bearer/body 显式凭据撤销，响应保持 401；仅重复 Cookie 不猜测撤销（U233 F1） | `refresh-cookie.e2e`、`u229-logout-body` |
| refresh 请求体为 `null`  | 视为假 body：Cookie 源 200 不回显/不轮换；无 Cookie 401（U235） | `u235-refresh-null`（`refresh-cookie.e2e` 内） |
| 外来 Origin 登录         | 配置了 PUBLIC_ORIGIN 时非平台 Origin 登录 → `403 CSRF_REJECTED`，不下发 body refresh                                              | `server.ts:2332-2338,3844-3846`；`refresh-cookie` 139                                 |
| 带 Cookie 但无 Origin    | 登录/handoff → `401 SESSION_EXPIRED`，不按 Cookie 源解析                                                                          | `server.ts:2319-2324,3837-3842`；`refresh-cookie` 149                                 |
| 刷新被拒                 | 客户端 `logout()`，清本地并回登录页                                                                                              | `app.js:84-98`                                                                         |
| refresh 过期/会话已撤销  | 服务端 `401 SESSION_EXPIRED` 并清 Cookie                                                                                         | `server.ts:4005-4012,4158-4165`                                                        |
| 禁用账号                 | **已修复（U228 `39ad743d793`）**：登录非 active → 403 `USER_DISABLED`（审计 login denied、不发令牌/Cookie）；刷新 Cookie/body 两源在 current/previous/宽限前统一检查 → 撤销+bump epoch+清 Cookie+401；客户端重放仍 401 即登出（旧行为见探索 E1） | `server.ts:3914-3928`（登录）、`4013-4020`（Cookie 刷新）、`4166-4172`（body 刷新）；`test-reports/u197-auth-exploration-20261118.md` E1     |

**服务端认证语义（现状）**

- 密码只经 LDAP adapter 校验，平台不存密码；生产为 LDAPS simple-bind adapter（代码中仅 Mock 实现，`ldap.ts` 注释声明生产接同接口；filter/DN 转义与 CN 单值校验按 G04 §4-3，G04-1 是生产 adapter 开工门）。
- 准入组语义（U69a 裁定）：**组=登录准入，不是角色映射**；新用户首登角色一律 `developer`，角色由平台内用户管理覆盖（`roleOverride` 优先）。
- **准入运维规则（P2-3/P2-5，零语义）**：组名与目录 CN 必须精确、大小写敏感，不匹配一律 fail-closed 拒绝；启用顺序=入组→（如用组主体先建授权）→升级全副本→设 env→重启→验证，回滚=撤 env 重启（详见 `work-orders/ldap-group-admission-design.md` §5.4）。旧副本未升级前不得设 env（混合版本 fail-open，D15-8 待裁定）。
- 会话：access/refresh TTL 见上表；旧 body 模式 refresh 每次旋转，旧值宽限期内可复用、宽限期外撤销会话；Cookie 模式 refresh 不轮换。
- 锁定计数：配置 `ORCA_CLOUD_LOGIN_LOCKOUT_URL` 时走共享服务（不可达 → 登录 `503 PLATFORM_UNAVAILABLE`，fail-closed）；未配置时进程内计数（5 次 / 15 分钟）。
- 审计：登录成功/失败、登出、`refresh.reuse_detected`、`refresh.grace_reuse` 均落链；复用事件只记来源，不记 token（`server.ts:4051-4059,4080-4088,4101-4109`；`refresh-cookie` 审计用例）。

**已裁定（2026-11-18 自动决策，`work-orders/decisions-log-20261118.md`）**

- **D5–D10**：`cookieMode` 仅在**平台同源控制台**启用（`auto`/`always` + `ORCA_CLOUD_PUBLIC_ORIGIN`）；默认关闭，配置即开、撤配置即回退；宿主跨源 handoff 继续 Bearer + body refresh。CSP 维持 `Report-Only`，不新增上报管道。启用前置四项：TLS、`ORCA_CLOUD_PUBLIC_ORIGIN` 精确配置（Host/XFP 不入判据）、多副本粘性会话或共享 store、宿主跨源路径确认不依赖 Cookie；四项写入部署检查单。
- **D12**：不新增 `lastUsedAt`，一期不做；项目「最近使用」维持 `createdAt` 排序（U196 关闭）。
- **D16**：接受 Cookie 同值重发所需的内存明文 refresh（仅内存、不落盘，U216）。
- **D18（已实施 `b521fb87988`）**：只做惰性 + 60s sweep（`ORCA_CLOUD_SESSION_SWEEP_MS` 可关，retention 固定 60s）+ 快照剥离 `accessTokens`/`webHandoffs`；不做退役 token FIFO、不新增端点、不持久化。服务启动时立即清扫一次（每个会话至多一条 `session.expired`，重启不重复；`0` 关闭时跳过）；快照剥离使重启后旧 bearer 立即失效、需 refresh。
- **D20（已实施 `77dea8b4dda`）**：只新增 `session.expired`（首个撤销者 1 条，sweep 复用）与 `session.revoked`（替换禁用用户现有 `logout` + `denied`）；不改 401/清 Cookie。

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
- 🟢 U219/D17：迁移分支 AC9b/AC9c「能力未知探测」已实现（`4e808df20f2`，后续 `296dcf40ac7`/`b0183c972f`）；首次加载即探测，AC15(g)/AC9c 去 skip。
- ✅ U228：禁用账号登录/刷新拒绝与撤销已合入 `39ad743d793`（新套件 `u228-disabled-user-session` / `u228-web-disabled-session`）。
- 🟢 U106：全站唯一 URL 路由（R1-R6，含登录回跳/刷新恢复/详情深链）已实现（`9e436334e88` 等，见 M2/M6）。
- 🟢 U103：刷新 Orca Web 停留在旧登录界面——已修（B1 `0048e24d59a`、B2 `72e6d3a7b79`；刷新静默续会话）。
- 🟢 U214/D5–D10：Cookie 模式已实现并默认关闭；生产启用由运维按检查单执行（`19c908da06f`）。
- 🟢 U233 F6/D18：令牌回收与快照明文剥离已实施（`b521fb87988`，11/11）。
- 🟢 U243①/U230①/D20：会话事件词汇（`session.expired`/`session.revoked`）已实施（`77dea8b4dda`，u243 4/4）。
- 🟢 U216：内存明文 refresh 权衡已接受（D16）。

## 6. 认证端点不变式表（§2-118）

| 端点 | 凭据来源 | fail-closed 顺序 | 幂等/去重键 | 撤销范围 | 审计 |
|---|---|---|---|---|---|
| `POST /v1/auth/login` | 账密 + LDAP | 重复 Cookie/Origin → 锁定（服务不可达 503）→ 凭据 → 组门 → 禁用 → 签发；审计 best-effort 不回滚 | 每次登录新 session；device 复用有效 deviceId，否则新建 | — | `login` success / failure（错密、锁定、组门）/ denied（禁用） |
| `POST /v1/auth/refresh` | Cookie 优先 / body 回退 | 重复 Cookie → CSRF（仅 Cookie 源）→ 撤销/过期 → 禁用 → reuse/grace → 轮换 | session 内 current/previous + grace | 过期/reuse/禁用 → revoked+epoch（已撤销不二次 bump）；Cookie 源不轮换 | `refresh.grace_reuse`/`reuse_detected`；过期首个撤销写 `session.expired`；禁用刷新写 `session.revoked success`（USER_DISABLED） |
| `POST /v1/auth/logout` | Bearer + Cookie + 可选 body refresh | 清 Cookie → 定位全部显式凭据 → 撤销（已撤销跳过；重复 Cookie 只记标志，显式凭据仍撤） | `revokedAt`（U241 幂等） | 仅显式凭据命中的 session（不吊销 device、不写 user 撤销集合） | `logout` success（已撤销不重复）/denied（UNKNOWN_REFRESH；USER_DISABLED 由刷新禁用路径写入） |
| `POST /v1/users/:id/sessions/revoke` | Bearer（admin） | auth→admin→链健康预检→404 检查→leader `recordAudit`（失败即 503 且无撤销/无标记）→撤销→user 撤销集合 | per-user 队列 leader outcome（leader 失败时 follower 重试为新 leader）；`revokedAt` | 全部 session + user 撤销集合；不吊销 device | `session_revoke` success（leader 每次，含零撤销）/denied；并发 follower 无 |

**认证 body 上限（U249 `571ebe26df1`）**：`POST /v1/auth/login` 与 `POST /v1/auth/refresh`（Cookie 源与 body 回退）body > 16 KiB → `413 PAYLOAD_TOO_LARGE`，解析前丢弃（不计数/不轮换/不撤销）；`POST /v1/auth/logout` 同 16 KiB 上限，但超限按无 body 处理（不报错，Bearer/Cookie 撤销照常）。`server.ts:362-423,3848-3852,3999-4003,4146-4150,4373`；`auth-body-limit.test.ts`

**契约 B（U250 `fix(u250)`）**：认证凭据类 body（login / refresh / `POST /v1/web/handoff`，body 承载唯一凭据或一次性交接码）超限 → `413 PAYLOAD_TOO_LARGE`，且在凭据状态检查**之前**拒绝、不消耗任何凭据（handoff 读取点 `server.ts:4237`，用例 `auth-body-limit.test.ts`）；定位器/备注类 body（logout / force-offline）超限 → 丢弃为空 body、动作照常（force-offline 4 KiB 读取点 `server.ts:5639`，用例 `u244-admin-force-offline.e2e.test.ts`）。

**U250 body 分档（HEAD 行号）**

| 档位 | 上限 | 超限语义 | 代表端点、行号与提交 |
| --- | --- | --- | --- |
| 1 鉴权前 | 16 KiB | login / refresh（Cookie 源与 body 回退）/ handoff → `413 PAYLOAD_TOO_LARGE`，在凭据状态检查前拒绝、不消耗凭据；logout 超限按空 body，Bearer/Cookie 撤销照常 | login `server.ts:3848`、refresh `3999`/`4146`、handoff `4237`、logout `4373`；`571ebe26df1`、`f697adfcfdd` |
| 2 敏感写 | 16 KiB | 认证后的权限/策略写 → 413；**拒绝分支不返回 413，是为了保持拒绝语义与 denied 审计**：仍返回 403，并以 4 KiB 上限读取 body 供 denied 审计（超限记为空） | 成功写 grants `5184`/`6392`、project policy `5386`、user roles `5567`、host tokens `5841`、provision-policy `6524`、global policy `7082`；拒绝读 `5174`/`6379`/`6511`；`d271157ba45` |
| 3 普通写 | 16 KiB | 认证后的业务写 → `413 PAYLOAD_TOO_LARGE`，在任何变更/审计前拒绝 | projects 创建/self/更新 `4700`/`4864`/`5070`、maintenance `6306`、audit/export `6667`、web-handoff mint `7301`、connect `7420`；`aa2e3b798a3` |
| 3a 注册（U252） | 64 KiB | 契约允许 200×255 B `projectDirs`，合法最大 52,232 B（3.19×16 KiB）→ 独立档；超限 413 `PAYLOAD_TOO_LARGE` 且不消耗一次性令牌 | `hosts/register` `5887`、常量 `server.ts:516`；`dc9c6e938ad` |
| 3b 心跳（U251） | 1 MiB | 一拍含 100 事件（metadata 各 ≤4096 B）+ 200 `projectDirs` + 32 provision 报告，实测合法最大 443 KB；超限 413 + `connection: close`，不落库 | `hosts/:id/heartbeat` `6101`、常量 `server.ts:525`；`fbf0237658d` |
| 4 内部端点（U251） | 8 KiB | 内部令牌校验后读取；超限整包丢弃为 `{}` 并置 `connection: close`，端点按空 body 走既有语义，与旧对端兼容 | `internal/audit/file-events` `6595`、`internal/relay-endpoint` `7182`；`8d9f5d3101b` |

常量与入口：`AUTH_BODY_MAX_BYTES`/`LOGOUT_BODY_MAX_BYTES` `server.ts:484`/`487`、`INTERNAL_BODY_MAX_BYTES` `496`、`SENSITIVE_WRITE_BODY_MAX_BYTES` `505`、`REGISTER_BODY_MAX_BYTES` `516`、`PROJECT_PATH_MAX_CHARS` `project-self-service.ts:17`（U256 移出，`server.ts:18` 导入）、`HEARTBEAT_BODY_MAX_BYTES` `525`、`DENIED_AUDIT_BODY_MAX_BYTES` `531`；统一 413 助手 `readSensitiveWriteBody` `server.ts:471-481`，超限丢弃在 `readBody` `server.ts:362-423`。

- 远程 audit-writer 追加上限（U252 `2ed0f0b439d`）：每批 ≤ `MAX_BATCH`(1000) × 16 KiB = 16 MiB，单事件 >16 KiB → 400 `BATCH_INVALID`；`writer.ts:18,41-42,198-202`；写入语义见 M7 §4。

**U255 超限连接的关闭语义（`5060e50e75c`）**
- `readJsonWithRes`（`server.ts:434-442`）在 oversized 时置 `connection: close`，body 仍为 `{}`；5 处调用：logout `4373`、项目 grants 403 `5174`、host grants 403 `6379`、provision-policy 403 `6511`、force-offline `5639`。旧 `readJson` 已删除（`apps/api/src` 内 `rg` 0 命中）。
- 三种超限路径（`readBody` `server.ts:362-423`）：声明 ≤2 MiB → 有界排空（2 MiB/250 ms，常量 `319-320`）后响应；声明 >2 MiB → 仅凭 header 立即响应并关闭；chunked → `pause` 后关闭。大声明包或快速 chunked 写者可能收到 reset 而非完整响应（U251 `8d9f5d3101b`）。
- ✅ **U258（已落地 `301c49139e0`，原 ⛔ P2）**：早于 body 读取的 401/403 拒绝不再无界排空——拒绝出口对声明超限统一置 `connection: close`（`json` 判定 `server.ts:259-267`；`readBody` 标记已消费 `:365`；公开入口绑定请求 `:3705`；内部监听由 `internal-channel.ts:46` 安装同一策略，`server.ts:7762-7764` 的 404 亦覆盖；chunked 自 U264 起改为有界排空，见下）。原观测：非管理员 force-offline 403 实读 8 MiB/29 ms、未认证 `POST /v1/projects` 实读 64 MiB/34 ms。

**U264 预读前关闭规则（`b290025b097`；行号已按冻结代码重校）**
- `installUnreadBodyPolicy()`（`unread-body-policy.ts:79-89`）在 `server.ts` 的 `handle()` 入口（`server.ts:3705-3706`）为每个响应包装一次 `res.writeHead`：首次写出前由 `applyUnreadBodyPolicy()`（`unread-body-policy.ts:69-76`）判定——body 未被 `readBody` 消费（`bodyReadRequests`，`unread-body-policy.ts:17,21-23`；标记点 `server.ts:365`）且声明 `content-length > 16 KiB`（`UNREAD_BODY_CLOSE_BYTES` `unread-body-policy.ts:13`）→ 置 `connection: close`。一处覆盖 OPTIONS 204、`serveStatic` 200/304/404、relay bundle、install script、audit export 与全部 `json()` 出口；internal 非 `/v1/` 404 走同一 helper（`server.ts:7762-7764`）。
- chunked：首次写头时启动有界排空（`boundUnreadChunkedBody()` `unread-body-policy.ts:37-62`，16 KiB / 250 ms，常量 `:14-15`）；小体量读到 `end` 保持 keep-alive，超预算或超时 `req.destroy()`。这取代了 U258 对 chunked 的一律关闭。
- internal-channel 现由共享模块 `unread-body-policy.ts`（U267② 抽取，`9f3a5534638`）提供同一策略，mTLS 401/403/500 与 404 出口复用（现行引用见 `internal-channel.ts:5,46`）；`b290025b097` 当时为 30 行最小镜像 `closeUnreadBody()`（`internal-channel.ts:33-64`，调用 `:87/:97/:107`）。
- 已知限制：声明/突发 ≥768 KiB 时客户端可能先收到 EPIPE 而非完整响应（U251 已知）；双门与多出口的覆盖以 `pre-read-close.test.ts`、`auth-body-limit.test.ts` 为准。

## 7. 测试覆盖

**认证/会话专项（HEAD 已提交）**

- `cloud-platform/test/refresh-cookie.test.ts`：纯单元——Cookie 解析（缺失/空值/重复/多 header）、序列化属性与清理三作用域（含 IP 字面量省略 Domain）、origin 规范化/同源、模式解析（auto 降级/always 拒启/never 惰性/非法回落/Secure 判定）。**无浏览器**。
- `cloud-platform/test/e2e/refresh-cookie.e2e.test.ts`：**in-process `createApp` + Node fetch**（非浏览器）——S1 登录/交接/刷新/登出的 Cookie 形态与能力标记、无 Origin/外来 Origin、never 回归；S2 双读/grace/CSRF/并发/审计；U218 登出撤销与多作用域、XFP/Host 伪造、启动矩阵。
- `cloud-platform/test/e2e/u197-cookie-browser.e2e.test.ts`：**真实 Chromium + 真实 API 进程**——HttpOnly Cookie 罐、空 body 刷新同值重发与 TTL 滑动、跨 Origin/非 JSON 403、重复 Cookie 硬 401 与作用域清理、多标签刷新、never 模式单次告警、日志/审计无明文 refresh。
- `cloud-platform/test/e2e/u197-web-cookie-browser.e2e.test.ts`（主干）＋ `cloud-platform/test/e2e/u197-web-cookie-browser-race-probe.e2e.test.ts`（迁移/探测/竞态）：**真实 Chromium**——AC9a 标记真 + 旧键迁移、登录后 `document.cookie`/localStorage 无令牌、AC12 重载一次刷新进入、多标签同刷、Cookie 缺失/伪造标记一次失败回登录、AC14 页内 401 一次刷新重放、并发 401 只刷一次、真实登出清 Cookie/旧键/标记、AC7 双标签被动登出、U222 N1 传输失败保留会话、启动传输失败不空白；AC9c（清 localStorage 仅 Cookie）已覆盖（D17/U219 实现后去 skip）。
- `cloud-platform/test/e2e/web-refresh-cookie.e2e.test.ts`：**happy-dom + 真实 `createApp`**——无标记保持旧契约、`refreshCookie:true` 不落盘、重载恢复与删键时机、Cookie/body 双失败回登录、页内 401 无 refreshToken 也刷新、登出清理、U221 F2/F3/F4、U222 N1/N2/N3/N4、`x-orca-web-contract` 头。
- `cloud-platform/test/e2e/session-renewal.e2e.test.ts`：**happy-dom + 真实 `createApp`**——短 TTL 旋转与旧 token 复用作废、refresh 过期拒绝、401 一次刷新一次重放（AC-M1-04）、并行 401 共享刷新（U134）、刷新失败/登出失败/仅缓存 user 的收尾（AC-M1-13/14/15）。
- `cloud-platform/test/e2e/u197-ac-probes.e2e.test.ts`：**真实 Chromium**——AC1 登录/刷新/登出后存储无令牌；AC2 access 过期 reload 恰好一次无 body 刷新；AC4 存储/Cookie/URL/console/响应体/审计均无 refresh。
- `cloud-platform/test/e2e/u197-migration-browser.e2e.test.ts`：**真实 Chromium**——AC9d 标记真 + 无有效 Cookie + 失效旧键（1 次无 body + 1 次 body，均 401，保留旧键）；AC15(g) 旧构建字面量 `undefined` 夹具；AC15(g) 换回新构建首次加载即一次无 body 成功并删除旧键（不再 skip/INVALID-FACT）；U225 N3R Cookie 标记 + never 服务端补写 `tokenOwner`、纯 Cookie 模式不写；伪造 Cookie + 假 body 判别力。
- `cloud-platform/test/e2e/u198-legacy-reload.e2e.test.ts`：**真实 Chromium**——旧 localStorage 模式 access 过期 reload 恰一次 body 刷新、access/refresh 轮换、`tokenOwner` 回填；负例失效 refresh + 过期 access 恰一次 401 后回登录、无循环。
- `cloud-platform/test/e2e/u228-disabled-user-session.e2e.test.ts` / `u228-web-disabled-session.e2e.test.ts`：**in-process + happy-dom**——禁用登录 403 不建 session/device、刷新两源撤销+bump+清 Cookie、旧 access 立即 401；客户端重放仍 401 即登出、启动路径同分支仅一次刷新（U228）。
- `cloud-platform/test/e2e/u229-web-refresh-epoch.e2e.test.ts`：**happy-dom**——刷新在途登出不复活、跨账号覆盖被代际拦截、登录清无 owner/异 owner 旧键、Cookie 启动无 owner 不回退（U229 F1/F2）。
- `cloud-platform/test/e2e/u229-web-logout-grace.e2e.test.ts`：**happy-dom**——grace 回显不持久化 previous/不改标记、登出携带 body refresh、非 SESSION_EXPIRED 401 不登出（U229 F3/F4、U230③）。
- `cloud-platform/test/e2e/u229-web-startup-resilience.e2e.test.ts`：**happy-dom（timerScale）**——启动挂起超时落登录页、登录 200 非契约响应校验、刷新 503 保会话、未处理拒绝修复（U229 F5/F6/F7/F11）。
- `cloud-platform/test/e2e/u230-disabled-user-edges.e2e.test.ts`：**in-process**——Cookie previous/宽限禁用、已删用户两源、假 body+有效 Cookie、禁用登录不建 device、`/v1/audit/verify` 全链（U230④）。
- `cloud-platform/test/e2e/u236-non-object-body.e2e.test.ts`：**in-process**——7 端点 × `null`/标量/数组发送，断言 4xx 非 500 + 有效对象回归（U236）。
- `cloud-platform/test/e2e/u229-logout-body.e2e.test.ts`：**in-process**——登出 body refresh 撤销、未知值 200 不撤销并审计、非对象 body（null/标量/数组）不 500（U229 F10、U232）。
- `cloud-platform/test/e2e/u197-web-cookie-browser-race-probe.e2e.test.ts` 内新增：U232 慢登出（`route.fetch()`+延迟 fulfill）不清新 Cookie、refresh 在途跨登录不覆盖新 Cookie。
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

## 8. 未覆盖 / 存疑

- ✅ **U219/D17（AC9b/AC9c/AC15(g)）**：迁移分支已实现（`4e808df20f2`，后续 `296dcf40ac7`/`b0183c972f`）；无能力标记时加载先发一次无 body 探测，成功即进入 Cookie 模式并删旧键，失败最多一次 body 回退并记住 `legacy`。`u197-migration-browser` 的 AC15(g) 单次重载用例与 `u197-web-cookie-browser-race-probe` 的 AC9c 均已去 skip。
- ✅ **U228**：禁用账号登录/刷新复查与「重放仍 401 即登出」已合入；覆盖见 `u228-disabled-user-session.e2e.test.ts`、`u228-web-disabled-session.e2e.test.ts`。
- 浏览器端「重放仍 401 → 自动登出」目前由 happy-dom 套件覆盖（`u228-web-disabled-session`）；真实 Chromium 同分支未单列（P3）。
- 生产 LDAPS adapter 不在本仓库实现（仅 Mock），真实 bind/`memberOf` 过滤行为无法从当前代码验证；生产 adapter 的 filter/DN 转义契约见 G04 §4-3，G04-1（依赖评审）为开工门，本文件不宣称已实现。
- 「刷新后仅缓存 user、无 token」路径由 `session-renewal` AC-M1-14 覆盖（happy-dom），真实 Chromium 无同名用例。
- 登录页密码显示切换仍仅手测（WEB-R2-011）。
- 探测/验证命令：`pnpm test cloud-platform/test/e2e/refresh-cookie.e2e.test.ts`、`…/u197-web-cookie-browser.e2e.test.ts`、`…/u197-web-cookie-browser-race-probe.e2e.test.ts`、`…/u198-legacy-reload.e2e.test.ts`（真实 Chromium 需本机可启动 headless Chromium）。
