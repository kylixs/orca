# U197：M116-QA-032 令牌存储加固设计

- 版本：v2（依据 `cloud-platform/test-reports/u197-token-design-review.md`（本地，只读）修订）
- 基线：行号锚点 `63a5fdde11a`（v1 与评审同 commit）；v2 修订于 `e3a405aeaa6`
- 状态：v2 草案，待复审/裁定（本文只出方案，不改 `apps/**` 与测试）
- 缺陷：M116-QA-032（P2，U54 台账）——`orca.access` / `orca.refresh` 明文存 `localStorage`
- 范围：`cloud-platform/apps/web` 平台 Web 控制台及其同源 API（`cloud-platform/apps/api`）
- 台账原始记录：`remote-connectivity/design/2026-11-13-cloud-dev-platform/test-reports/exploratory-qa-web.md:277`
- 证据：`cloud-platform/evidence/m116-exploratory-web/findings.json:484`（登录后两个键均为 43 字符明文）

## 修订记录（v2）

| 评审项 | 落点 | 要点 |
|---|---|---|
| P0-1 | §2B 服务端改动 2、§3 矩阵、§4 AC4/AC11 | 响应形态按凭据来源；仅 Cookie 只回 access，body 提供才回同一枚 body refresh |
| P0-2 | §3 Wire/旧 peer 兼容 | 补「已有 Cookie + body」行；响应必含 body token，旧页面不写 `undefined` |
| P1-1 | §2B 服务端改动 5 | grace 六条语义定死；撤销/过期先行；`graceMs` 可配 0 |
| P1-2 | §2B 服务端改动 7、前端改动、§4 AC9/AC12 | Cookie 模式 `auto/always/never`；非 https/loopback 告警；成功后删旧键；丢失不死循环 |
| P1-3 | §2B 服务端改动 4、§4 AC6 | 仅 Cookie 请求校验；可信 Origin 配置优先；拒绝缺失/`null`；代理集成测试 |
| P1-4 | §2B 迁移与回退判据 | 服务端先行/Web 后行判据、回退顺序、契约版本绑定 |
| P1-5 | §2B 测试策略、§4 AC5 | in-process + 手动 Cookie + `ApiHandle.store`；多标签真实 Chromium；happy-dom 仅 UI；`graceMs=0` |
| P2 | §1.4、§2B、§2C、§3、§4 | 基线锚点、失败路径副作用、CSP 草案、能力标志、grace 审计、PII 口径、部署前置、TTL 注入 |
| 待决策 | §5 | 压缩为 6 条关键项 |

---

## 1. 现状与威胁模型

### 1.1 令牌与生命周期

| 项 | 现状 | 依据 |
|---|---|---|
| access token | 32 字节随机数（base64url），30 分钟；服务端内存 Map 校验，非 JWT | `cloud-platform/apps/api/src/server.ts:108`、`2554-2578`、`2536-2552` |
| refresh token | 32 字节随机数，12 小时滑动过期；每次刷新轮换 | `server.ts:109`、`3198-3209` |
| 轮换检测 | 旧 refresh token 仍能定位 session，哈希不匹配即撤销整个 session | `server.ts:3192-3195` |
| 签发入口 | 密码登录、Web 交接码，共用 `issueDeviceSession` | `server.ts:3078-3182`、`3157`、`3214-3304` |
| 登出 | Bearer access 定位 session 后撤销并 bump epoch | `server.ts:3306-3322` |
| 持久化 | 默认仅进程内存；只有显式开发快照才落盘（含 sessions/tokens） | `server.ts:1855-1858`、`store-persistence.ts:48-50,124-126` |
| 设备绑定 | 登录体里的 `devicePubKey` 固定为字符串 `'web-client'`，不是密码学绑定 | `cloud-platform/apps/web/app.js:4362-4364` |

结论：refresh token 是长期凭据（12 小时、滑动、可无限续期），泄露后的价值远高于 access token；轮换复用检测已存在，但前提是同一 token 只有一个持有者。

### 1.2 存储点、读取点与清理点

| 行为 | 位置 | 说明 |
|---|---|---|
| 启动时读取 | `apps/web/app.js:5-7` | 模块加载即从 `localStorage` 读 `orca.access` / `orca.refresh` |
| 写入 | `app.js:96-101` | `setTokens()` 同时写内存与 `localStorage` |
| 登录写入 | `app.js:4380` | 登录响应直接落盘 |
| 刷新写入 | `app.js:79-86` | `/v1/auth/refresh` 响应再次落盘 |
| 每次 API 读取 access | `app.js:44-53` | `Authorization: Bearer` |
| 401 刷新 | `app.js:54-57`、`69-94` | 页内 `refreshInFlight` 合并并发刷新 |
| 登出清理 | `app.js:4387-4412`（特别 `4399-4400`） | 仅显式登出时删除 |
| 非密数据 | `app.js:4383-4384`、`4553-4564` | `orca.user`（用户资料 PII）、`orca.device` |
| 页面恢复 | `app.js:4551-4566` | 只用 access 调 `/v1/me`；失败只清内存 access，不清 `localStorage` 的 access/refresh |

关键行为缺口：页面恢复不尝试用 refresh 换新 access。因此浏览器空闲超过 30 分钟后刷新页面，会直接回到登录页，尽管 refresh 仍有 12 小时有效期（`app.js:4551-4566`）。

### 1.3 多标签与刷新恢复

- `app.js` 中没有 `storage` 事件监听，也没有 `BroadcastChannel`；每个标签在加载时对 `localStorage` 做一次快照（`app.js:5-7`）。
- 标签 A 刷新后把新令牌写回 `localStorage`（`app.js:86`、`99-100`），标签 B 的内存里仍是旧 refresh。标签 B 下一次 401 用旧 refresh 请求，服务端命中 `session.refreshHash` 不匹配并撤销 session（`server.ts:3192-3195`）——A、B 同时掉线。
- 同一标签内的并发 401 已由 `refreshInFlight` 合并（`app.js:69-94`），但跨标签没有合并，也没有服务端轮换宽限。
- 标签 A 登出会撤销服务端 session（`server.ts:3306-3322`）；标签 B 不会立即切登录页，下一次请求失败后才被动登出。
- 页面刷新：同标签内 access 有效则恢复（`app.js:4554-4559`）；access 过期但没有刷新逻辑，见 1.2。

这条现状直接约束候选方案：任何把多个标签继续指向同一个 refresh token 的方案，必须解决跨标签轮换竞争，否则会把现有的偶发掉线放大成常态。

### 1.4 同源部署与现有防护

- API 自己静态托管 Web 控制台：非 `/v1/`、非 `/install/` 的 GET 走 `serveStatic`（`server.ts:3066-3075`、`5983-6024`），Web 根目录为 `../../web/`（`server.ts:119`），入口 `index.html` 以 module 方式加载 `/app.js`（`cloud-platform/apps/web/index.html:200`）。因此平台控制台与登录/刷新接口天然同源。
- 全仓检索未发现 `Content-Security-Policy`；静态响应只带 `referrer-policy: no-referrer`（`static-delivery.ts:15-17`），JSON 响应复用同一组头（`server.ts:183-190`）。没有 CSP，XSS 的利用成本就是普通 DOM 注入。
- 页面有 37 处 `innerHTML` 赋值（如 `app.js:421`、`431`、`450`），转义依赖人工调用 `esc()`（`app.js:29-34`）；158 处 `esc(` 说明这是约定而非强制。QA-032 目前未找到注入点，但该结构不具备“即使有 XSS 也拿不到长期令牌”的纵深。
- 前端与 API 独立发布：前端资源按内容哈希归档，旧页面在部署后仍可解析自己的旧资源（`web-release.ts:1-9`、`60-110`）；入口 `index.html` 为 `no-cache`（`server.ts:6000-6008`）。已有版本化 Web 契约 `x-orca-web-contract`（`web-contract.ts:1-45`、`web-release.ts:12-15`），但 `app.js` 目前不发该头，服务端把空值视为当前版本（`web-contract.ts:14-18`）。
- 当前没有任何 Cookie 处理：`apps/api/src` 中无 `set-cookie` / `cookie` 读取。认证完全依赖 `Authorization` 头（`server.ts:2536-2543`），所以今天不存在 CSRF 面；这一点在方案 B 中会改变。
- 已存在的跨源页面只有宿主/中继托管的 `cloud-admin.html` / `web-index.html`，CORS 精确白名单、Bearer 认证（`server.ts:2644-2666`）。它们另用 `orca.webCloudSession` 存令牌（`src/renderer/src/web/web-cloud-session-storage.ts:10-15,51-57`），属于本次范围之外的同类问题，见待决策。

### 1.5 威胁模型

| 攻击者能力 | 当前结果 | 加固目标 |
|---|---|---|
| 任意同源脚本执行（XSS、被篡改的第三方脚本、恶意浏览器扩展注入页面） | 可直接读取并外带 access + refresh，最长维持 12 小时滑动会话 | refresh 不可被脚本读取/持久化外带；access 仅内存 |
| 共用电脑/共用浏览器配置文件 | 关闭标签页后令牌仍在；12 小时内打开页面即恢复会话 | 关闭浏览器或明确登出后不可恢复（可配置） |
| 网络攻击者 | 生产 TLS 下不可读；本地 http 环境可被截获 | 不新增明文通道；Cookie 加 `Secure` |
| 跨站页面（方案 B 引入 Cookie 后） | 无 Cookie，无 CSRF 面 | Cookie 认证的刷新接口必须拒绝跨站 Origin |
| 被窃 refresh 重放 | 已有轮换复用检测，可撤销 session（`server.ts:3192-3195`） | 保留该检测；为多标签竞争引入有限宽限，并记录其风险 |
| XSS 在页面存活期间代替用户发请求 | 本来就可以（Bearer 在内存） | 不承诺“XSS 无害”，只承诺 refresh 不可被读取和离线复用 |

---

## 2. 候选方案

### 方案 A：access 仅内存 + refresh 存 sessionStorage

**机制**：`setTokens()` 只更新内存；refresh 写入 `sessionStorage`；access 永不持久化。页面加载时若内存无 access，则用 sessionStorage 的 refresh 调 `/v1/auth/refresh` 换取 access。服务端不改。

**改动面**

- 前端：`app.js:5-7`、`96-101`、`4380`、`4399-4400`、`4551-4566`；登录/刷新/登出/恢复五处。
- 服务端：无。
- 协议：无。

**多标签与刷新**

- `sessionStorage` 按标签隔离：新标签拿不到 refresh，必须重新登录，或通过 `BroadcastChannel` 向已有标签“借”一次 refresh。后者需要标签间领导权/消息协议，复杂度接近方案 B 的客户端协调，但安全性仍不如 B。
- 同标签刷新页面：可用（sessionStorage 存活）。
- 浏览器关闭：会话结束，符合共用机器目标，但与当前“12 小时内重开仍登录”的产品行为不同。

**SSO / 移动 WebView**

- 不影响服务端与 SSO 路线；移动浏览器后台标签被回收更频繁，恢复时仍需走 refresh，行为可接受。新标签必须登录，移动端多标签体验差。

**测试点**

- 登录、刷新后 `localStorage` 无 `orca.access`/`orca.refresh`；同标签刷新页面会话保持；新标签按预期要求登录；登出清空 sessionStorage。

**迁移与回滚**

- 迁移：启动时删除遗留 `orca.access`/`orca.refresh`，把可用 refresh 迁到 sessionStorage；一次性迁移窗口内仍需读取旧键。
- 回滚：恢复写 `localStorage` 即可，无服务端配合。

**风险**

- 不解决核心威胁：XSS 在标签生命周期内仍可读 `sessionStorage` 并外带 refresh；只是把“持久窃取”降为“当次窃取”。
- 多标签行为回退，且无法满足“多标签同时刷新只轮换一次”的验收目标。
- 若改用 IndexedDB 以跨标签共享，脚本同样可读，安全性等同 `localStorage`，没有收益。

**结论**：可作为服务端改动的过渡缓解，不足以单独关闭 QA-032。

### 方案 B：refresh 放 HttpOnly + SameSite Cookie，access 仅内存

**机制**：登录、刷新、交接成功时由服务端下发 `HttpOnly; Secure; SameSite` 的 refresh cookie；浏览器页面不再持久化 refresh。access token 只存内存，页面刷新时用 cookie 调 `/v1/auth/refresh` 恢复。`/v1/auth/refresh` 优先读 cookie，同时保留请求体 `refreshToken` 兼容旧客户端。

**服务端改动**

1. 登录（`server.ts:3078-3182`）、刷新（`3184-3210`）、Web 交接（`3214-3304`）在响应中下发 refresh cookie（名称、Path 见待决策）。
2. 刷新接口按**实际使用的凭据来源**决定响应形态，禁止用客户端声明头/标志判定（P0-1）：
   - 仅 Cookie 刷新（请求体没有非空 `refreshToken`）：响应**只返回 `accessToken` / `expiresIn`**，refresh 仅经 `Set-Cookie`；响应体不得出现 `refreshToken`。
   - 请求体提供非空 `refreshToken`（无论 Cookie 是否存在）：响应**必须返回 body `refreshToken`，且与本次轮换/沿用的那枚相同**（P0-2，保护旧页面不写入 `undefined`）。
   - 来源判定顺序固定：Cookie 优先、body 回退（见第 5 条）。响应形态跟随最终使用的来源；唯一例外是 P0-2——只要请求体提供了非空 refresh，响应就必须含 body refresh（无轮换时原样返回请求提供的那一枚，有轮换时返回本次签发的同一枚），否则旧页面会写入 `undefined`。
3. 登出（`3306-3324`）增加清除 cookie；仍用 Bearer 撤销 session。
4. CSRF 校验**只作用于实际使用 Cookie 的请求**（P1-3）：要求 `Origin` 与可信源精确一致，并校验 `content-type: application/json`；可按需加 `Sec-Fetch-Site: same-origin`。可信源优先取新增配置 `ORCA_CLOUD_PUBLIC_ORIGIN`，未配置时才回退 `requestOrigin(req)`（`server.ts:274-287`，依赖 Host/`X-Forwarded-Proto`）。Cookie 路径拒绝缺失 `Origin` 与 `Origin: null`；跨站返回 403 且不轮换。仅 body 认证的旧客户端与宿主跨源 Bearer 通道保持现状，不受该检查影响。
5. 轮换宽限语义（P1-1 定死，六条）：
   1. session 持有 `refreshHash`（current）、`previousRefreshHash`、`graceUntil`；只有命中 current 才轮换：签发新 refresh、把旧 current 写入 previous、设 `graceUntil = now + graceMs`。
   2. previous 在窗口内（`now < graceUntil`）命中：**不轮换、不续期**（不延长 session/refresh/grace）、**不签发新 token**，只签发 access。Cookie-only 响应不含 body refreshToken；P0-2 的 body 请求例外下，原样返回请求提供的那一枚 previous（同一枚，绝不以 current 或新 token 替换）。
   3. 撤销/过期先短路：session 已撤销或 refresh 已过期时，无论命中 current/previous 一律 401 `SESSION_EXPIRED`，宽限不得放行。
   4. 来源判定顺序：先 Cookie、后 body；仅 Cookie 缺失或为空才回退 body；两种来源共用同一套 current/previous 规则。
   5. 命中 previous 但窗口已过，等同复用旧 token，按现有复用检测撤销整个 session（`server.ts:3192-3195`）。
   6. `graceMs` 可配，允许 `0`（严格复用检测；并发刷新的第二请求会撤销 session）；默认值见 §5。
   宽限审计：新增 `refresh.grace_reuse`（窗口内命中 previous）与 `refresh.reuse_detected`（撤销）事件，落入现有审计目录（`server.ts:3160-3167` 一带），只记录 session/来源类型，不记录 token 值。
6. 兼容字段：登录与 Web 交接响应**继续返回 body `refreshToken`**（旧页面登录依赖它落盘），并新增非密能力标记（如 `refreshCookie: true`），告知新前端可忽略 body refresh；刷新响应仅在请求体提供 refresh 时返回 `refreshToken`（第 2 条）。旧服务端没有能力标记，新前端保留回退路径。
7. Cookie 模式配置（P1-2）：`ORCA_CLOUD_COOKIE_MODE=auto|always|never`，默认 `auto`。`always` 强制 `Secure`；`auto` 在 https 或 loopback 下带 `Secure`，在非 loopback 的纯 http 下必须**显式降级并输出一次告警**（不得静默丢失 Cookie）；`never` 不下发 Cookie（仅用于排障）。Cookie 名/Path/SameSite/生命周期见 §5。
8. 失败路径副作用（P2）：`SESSION_EXPIRED` 时清除 refresh Cookie；CSRF 403 **不清 Cookie、不撤销 session**；登出清 Cookie（`Max-Age=0`）并撤销 session。三条必须在同一测试矩阵中断言。

**前端改动**

- `setTokens()` 只写内存（`app.js:96-101`）；删除对 `orca.access`/`orca.refresh` 的读写（`5-7`、`99-100`、`4399-4400`）。
- 迁移删除旧键必须以**一次真实的无 body 刷新成功**为前提（该响应证明 Cookie 已生效）；刷新失败时保留旧键并回退 `localStorage`，不得先删后验（P1-2）。
- 启动恢复（`4551-4566`）：无 access 时先 `POST /v1/auth/refresh`（fetch 默认 `same-origin` 凭据模式，Cookie 会随请求发送），成功后再 `GET /v1/me`；失败才 `showLogin()`，不得自动重复刷新（Cookie 丢失不死循环）。
- 刷新请求（`79-83`）不再需要 body token；保留 body 仅作为能力标记缺失时的回退。
- 多标签：Cookie 自动共享；服务端宽限保证并发刷新不撤销 session。建议用 `BroadcastChannel` 同步“已登出/已刷新”以改善 UI 一致性，但它不是正确性的前提。
- 登出（`4387-4412`）清理遗留 `localStorage` 键，并通知其他标签切换登录页。

**多标签与刷新行为**

- 页面刷新：Cookie 自动携带，刷新恢复可用，且修复了 1.2 中“access 过期后刷新页面直接回登录页”的缺口。
- 新标签：同源 Cookie 自动可用，无需登录。
- 并发刷新：依赖服务端宽限窗口；客户端 `navigator.locks`/`BroadcastChannel` 只能作为优化（浏览器支持不一致）。

**SSO / 移动 WebView**

- 平台当前是 LDAP 密码登录（`server.ts:3111`），没有 SSO；未来 SSO 通常以 Cookie 为载体，B 与路线一致。
- 移动浏览器同源第一方 Cookie 不受第三方 Cookie 限制；后台标签被回收后，回前台刷新页面即可用 Cookie 恢复。Orca 移动 App 不消费这些端点，无影响。
- 宿主托管的 `cloud-admin.html` 是另一个源，继续用 Bearer + 自己的存储；平台 Cookie 不会自动给它用，不产生回归，但也不加固它（见待决策）。

**测试点**

- Cookie 属性（HttpOnly/Secure/SameSite/Path）；`document.cookie` 不可见；刷新与登出正确设置/清除。
- body 回退路径；Origin 拒绝（含缺失/`null`）；跨标签并发刷新；页面刷新恢复；旧前端 e2e。
- 能力标记缺失时的回退（新前端 + 旧服务端）；Cookie 丢失后只失败一次并回登录页（不重复刷新）。

**测试策略（P1-5 定死）**

- 服务端验收用 in-process API + 手动构造 `Cookie` 请求头，并断言 `ApiHandle.store` 中的 session/refresh 状态；happy-dom 没有真实 Cookie jar，不得用于 Cookie/CSRF 证据。
- 多标签与浏览器行为（Cookie 自动携带、`document.cookie` 不可见、页面刷新恢复、登出同步）用真实 Chromium（Playwright）。
- happy-dom 只做前端 UI 逻辑（旧键清理、回退分支、能力标记分支）。
- 严格复用检测用例显式传 `graceMs=0`；现有 `session-renewal.e2e` 的“严格复用立即撤销”“localStorage 断言”编码的是旧行为，必须随本设计改写，不能保留双重语义。

**迁移与回退判据（P1-4 定死）**

- 服务端先行判据：双读（Cookie 优先、body 回退）生效；登录/刷新/交接下发 Cookie；刷新响应带能力标记；请求提供 body refresh 时响应含同一枚 body token。以上全部通过独立服务端验收后，才可发布 Web。
- Web 后行判据：真实 Chromium 中一次无 body 刷新成功拿到 access，且该次响应 `Set-Cookie` 生效（`document.cookie` 不可见）后，才删除遗留 `localStorage` 键并切换为内存 + Cookie。
- 新 Web + 旧服务端：能力标记缺失时回退 `localStorage`（临时延续缺陷，QA-032 在该组合下保持未关闭）；不得回退 `sessionStorage`（多标签会强制重登）。
- 回退顺序：先回滚 Web（旧构建仍可由归档资源服务，`web-release.ts:60-110`），再回滚服务端；禁止先回滚服务端，否则已切换 Cookie-only 的页面无法恢复。
- 兼容窗口内不移除响应体 `refreshToken`；移除必须与 Web 契约版本绑定：提升 `MIN_WEB_CONTRACT_VERSION`，并让 `app.js` 开始发送 `x-orca-web-contract`（`web-release.ts:12-15`、`web-contract.ts:30-45`）。契约版本未提升前，服务端不得删除 body 字段。

**风险**

- 新增 CSRF 面：必须确保 Origin 校验覆盖所有 Cookie 认证的刷新；代理必须正确传递 Host / `X-Forwarded-Proto`，并以 `ORCA_CLOUD_PUBLIC_ORIGIN` 作为代理链的权威源。
- `Secure` Cookie 在纯 http 的非 loopback 环境不会被浏览器保存：由 `ORCA_CLOUD_COOKIE_MODE` 显式处理并告警，不能静默失效。
- 宽限窗口是安全性与并发可用性的显式权衡；异常复用必须进审计（见服务端改动 5）。
- 部署前置：session 与 refresh 映射目前是进程内存（`store.ts:160-165`）。多副本部署必须配置粘性会话或共享 store，否则 Cookie 刷新会随机落到无 session 的副本而失败；这是上线前置，不由本设计兜底。
- 范围口径：`orca.user`（PII）与宿主 `cloud-admin.html` 的 `orca.webCloudSession` 属同类同源风险，但**不纳入 QA-032 的关闭条件**，另单处理。

### 方案 C：保留 localStorage + 强化缓解

**机制**：不改存储位置，靠严格 CSP、缩短 TTL、设备/风险绑定、轮换检测降低被利用窗口。

**改动面**

- 服务端：新增 CSP 响应头（`static-delivery.ts:15-17` 处扩展）；可调 TTL（`server.ts:108-109`、`6087-6098`）。
- 前端：无协议改动；可清理 `orca.user` 等非必要持久化。
- 协议：无。

**可行性与细节**

- 严格脚本 CSP 可行：`index.html` 没有内联脚本，只加载 `/app.js`（`index.html:200`）。但 `app.js` 模板里有 16 处内联 `style="..."`，`style-src 'self'` 会拦截，需要允许 `style-src 'unsafe-inline'` 或先改为 class。建议先 `Content-Security-Policy-Report-Only` 观测。
- CSP 完整草案（P2）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`。`style-src 'unsafe-inline'` 是内联样式的过渡豁免，须在报告中登记并在后续批次移除；`img-src` 若确有 data URI 再加 `data:`。落点：`static-delivery.ts:15-17` 的静态/HTML 响应与 `server.ts:183-190` 的共享响应头；JSON 接口不带 CSP。`report-to`/`report-uri` 的收集落点需在实施时指定，且违规报告不得包含令牌。
- 缩短 access TTL（如 10 分钟）与 refresh TTL（如 2-4 小时）能缩小窗口，但会提高刷新频率和 LDAP 重登频率，是产品取舍。
- “设备绑定”当前没有可用凭据：`devicePubKey` 是常量（`app.js:4364`），把 token 绑 UA/IP 易误伤且不抗本机攻击者；不建议作为主措施。
- 客户端加密 `localStorage` 没有意义：解密密钥同样可被脚本读取。

**多标签与刷新**：行为不变，仍受 1.3 的跨标签竞争影响。

**SSO / 移动 WebView**：无影响。

**测试点**：CSP 头存在且页面无违规报告；TTL 生效；复用检测仍撤销 session。

**迁移与回滚**：纯增量，风险最低；回滚即移除头/恢复 TTL。

**风险**：不改变“任意 XSS 可外带长期 refresh”的事实；只能降低概率和窗口，不能关闭 QA-032 的核心诉求。CSP 若允许 `unsafe-inline` 样式，脚本侧仍可收紧，但要防止后续回退。

**结论**：应作为 B 的纵深措施保留，不应单独作为关闭项。

### 方案对比

| 维度 | A：sessionStorage | B：HttpOnly Cookie | C：localStorage + 缓解 |
|---|---|---|---|
| XSS 能否直接读 refresh | 能（标签存活期间） | 不能 | 能 |
| 刷新后外带 refresh | 能（当次会话） | 不能 | 能（12 小时） |
| 页面刷新恢复 | 同标签可以 | 可以 | 可以 |
| 新标签免登录 | 不可以（除非自建标签间中继） | 可以 | 可以 |
| 多标签并发刷新 | 各自 refresh，需协调 | Cookie 共享，需服务端宽限 | 现状有撤销风险 |
| 服务端改动 | 无 | 中（Cookie、CSRF、宽限） | 小（CSP/TTL） |
| 旧客户端兼容 | 无影响 | 双读 + body 回退可兼容 | 无影响 |
| 迁移/回滚成本 | 低 | 中，需服务端先行、Web 后行 | 低 |
| 主要风险 | 多标签回退、XSS 仍可窃取 | CSRF、Cookie 配置、轮换窗口 | 核心威胁未消除 |
| 能否单独关闭 QA-032 | 部分（仅持久化面） | 是 | 否 |

---

## 3. 推荐

**主选：方案 B（HttpOnly + SameSite Cookie 承载 refresh，access 仅内存），并叠加 C 的 CSP 与轮换宽限。**

理由：

1. 只有 B 让 refresh token 对同源脚本不可读，直接消除“XSS 长期外带 refresh”的核心风险；sessionStorage（A）只是把持久窃取改成当次窃取。
2. 平台前端与 API 同源（`server.ts:3066-3075`、`5983-6024`），Cookie 是最自然的传输方式，不需要跨源改造；现有宿主页面的 Bearer 通道不受影响。
3. B 顺带修复页面刷新恢复缺口（`app.js:4551-4566`）：Cookie 自动携带，刷新页面即可换新 access。
4. 兼容性可控：响应体继续返回 `refreshToken`，服务端同时接受 Cookie 与 body；旧前端无需改动。前端和 API 独立发布、旧资源归档的机制（`web-release.ts:1-9`）要求这种双栈窗口。
5. 与未来 SSO 方向一致；C 的 CSP 可以作为并行纵深，不阻塞 B。

**备选：方案 A**，仅在服务端改动无法在本周期落地时采用。必须明确它不关闭 QA-032 的 XSS 外带面，并且会让新标签必须重新登录；若要保留多标签体验，需要额外的 `BroadcastChannel` 中继，复杂度会追上 B，却没有 B 的安全收益。

**建议实施顺序**

1. 服务端：下发 Cookie、双读（Cookie 优先，body 回退）、Origin/content-type 校验、轮换宽限、响应能力标记；响应形态按 P0-1/P0-2（仅 Cookie 只回 access，body 提供才回同一枚 body refresh）。
2. Web：能力标记为真时切换为“access 内存 + Cookie refresh”，在一次无 body 刷新成功后删除 `localStorage` 令牌键；标记缺失时回退 `localStorage`（见 §2B 迁移判据与 §5）。
3. 清理：兼容窗口结束后，才考虑停止返回 body refresh / 提升 Web 契约版本；本次不排期。
4. 并行纵深：严格脚本 CSP（Report-Only 起步）、遗留键清理、登出跨标签通知。

**Wire / 旧 peer 兼容**

- 本设计不新增流操作码，不改 RPC 帧；变化的只是 Web 控制台与平台 HTTP API 之间的凭据传输方式。
- 旧 Web 客户端（包括部署前加载、仍由归档资源服务的旧页面）：继续用 body `refreshToken`，服务端双读，行为不变；它忽略 `Set-Cookie`。
- 旧客户端矩阵补充「已有 Cookie + body 请求」：服务端已下发 Cookie 后，旧页面仍会带 body refresh 刷新；响应**必须包含 body `refreshToken`（同一枚）**，否则 `setTokens(body.accessToken, undefined)` 会写入字符串 `"undefined"` 并掉线（`app.js:86`、`4815`）。旧页面不会写入 `undefined` 的唯一前提，是服务端遵守 P0-2。

| 请求形态 | 凭据来源 | 响应体 |
|---|---|---|
| 旧页面：body refresh，无 Cookie | body | 必含 body refresh（轮换时为本次签发枚） |
| 旧页面：已有 Cookie + body refresh | Cookie 优先判定，P0-2 覆盖响应形态 | **必含 body refresh**（正常轮换为本次签发枚；grace previous 为请求提供枚） |
| 新页面：仅 Cookie | Cookie | 只含 `accessToken`/`expiresIn`，无 `refreshToken` |
| 新页面：Cookie 丢失 | 无 | 401，前端一次失败后回登录 |
- 新 Web 客户端 + 旧服务端：服务端没有能力标记，客户端不得假定 Cookie 存在；必须保留回退路径，否则页面刷新即掉线。
- 新服务端 + 旧客户端：服务端仍接受 body，轮换宽限不改变响应结构。
- 旧客户端看到的是“轮换语义没变”（仍每次返回新 refresh）；宽限只在服务端内部放宽旧哈希的短暂复用，不改变线上字段。
- 回滚顺序必须是 Web 先、服务端后；服务端回滚会移除 Cookie 下发，而已经切到 Cookie-only 的新页面将无法恢复。

---

## 4. 验收判据草案（可机检）

| # | 断言 | 检查方法 |
|---|---|---|
| AC1 | 登录成功、执行一次刷新、再登出后，`localStorage` 中不存在 `orca.access` / `orca.refresh`，且 `JSON.stringify(localStorage)` 不包含服务端返回的 refresh 值 | Playwright `page.evaluate` 扫描键与值；同时断言旧键被删除 |
| AC2 | access 过期后刷新页面仍保持登录：将 `ORCA_CLOUD_ACCESS_TTL_MS` 调短（`server.ts:6095`），等待过期后 `reload()`，页面进入工作台而非登录页；期间恰好发生一次 `POST /v1/auth/refresh` | Playwright 网络计数 + 页面可见性 |
| AC3 | 登录/刷新响应的 `Set-Cookie` 含 `HttpOnly`、`SameSite=Lax`（或最终裁定值）、TLS 环境下 `Secure`、约定 `Path`；`document.cookie` 不含 refresh 值 | 读取响应头 + `page.evaluate` |
| AC4 | 注入模拟 XSS 脚本读取 `localStorage`、`sessionStorage`、`document.cookie`，均拿不到 refresh；该值也不出现在 URL/hash、控制台日志、审计 metadata，且刷新接口响应体本身不含 refresh（响应体面由 AC11 覆盖） | 注入固定探针脚本，断言三段输出均不含 refresh；审计事件字段检查（现有审计不含令牌，`server.ts:3160-3167`） |
| AC5 | 两个同源标签同时刷新只产生一次有效轮换：access 过期后两标签并发请求 `/v1/me`，两者都恢复；服务端 session 未被撤销，refresh 轮换次数为 1（宽限方案下可为 2 次请求、1 次 current 轮换，需在实现时定义可观测口径） | 服务端同进程用例用 `ApiHandle.store` 断言 `session.refreshHash` 只前进一次、`previousRefreshHash`/`graceUntil` 符合 P1-1；浏览器侧用真实 Chromium 双页面并发，断言两者都不出现 `SESSION_EXPIRED` |
| AC6 | 跨站 CSRF 刷新被拒：带有效 Cookie、`Origin: https://evil.example` 的 `POST /v1/auth/refresh` 返回 403，且不改变 session/不轮换；原标签后续请求仍有效。Cookie 路径下缺失 `Origin` 或 `Origin: null` 同样 403 且不轮换；body-only 刷新与宿主跨源 Bearer 不受影响；可信源优先取 `ORCA_CLOUD_PUBLIC_ORIGIN` | 原始 HTTP 请求构造（Playwright `request` 或 in-process）；代理集成用例覆盖 `Host`/`X-Forwarded-Proto` 与配置源不一致时以配置为准 |
| AC7 | 登出清除 Cookie（`Max-Age=0`）并撤销 session：随后刷新请求返回 401；其他标签在 N 秒内切到登录页或下一次请求被动登出 | 双标签 + 网络断言 |
| AC8 | 旧客户端兼容：仅带 body `refreshToken` 的刷新仍返回 200 与新令牌；已有 Cookie + body 请求也返回 200 且响应含同一枚 body `refreshToken`（旧页面不写入 `"undefined"`）；新客户端在缺少能力标记时回退 `localStorage` 且不出现刷新死循环 | 保留现有 e2e/探针，新增“旧服务端/旧客户端”矩阵用例 |
| AC9 | 旧持久化清理：升级后首次加载，只有在一次真实无 body 刷新成功后才删除遗留 `orca.access`/`orca.refresh`；刷新失败则保留旧键并回退 `localStorage`；旧 refresh 不可用时安静回登录页 | 预置旧键后加载页面，分“Cookie 可用/Cookie 缺失/旧 refresh 失效”三组 |
| AC10 | 纵深（若同批落地）：静态响应含 `Content-Security-Policy`，`script-src 'self'`，页面无脚本违规；样式如需 `unsafe-inline` 必须在设计里显式记录 | 响应头 + `securitypolicyviolation` 监听 |
| AC11 | XSS 直接调刷新接口拿不到 refresh（P0-1）：页面内注入脚本发起 `fetch('/v1/auth/refresh', {method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:'{}'})`，响应 JSON **不含 `refreshToken` 字段**，只有 `accessToken`/`expiresIn` | 注入探针断言响应体键集合；服务端同请求（无 body refresh）只回 body access |
| AC12 | Cookie 丢失回退不死循环（P1-2）：手动删除 refresh Cookie 后触发刷新，前端只发起有限次（1 次）刷新，失败后清内存 access 并回登录页，不重复自动刷新 | Playwright 请求计数 + 页面可见性 |
| AC13 | 失败路径副作用（P2）：`SESSION_EXPIRED` 响应清 Cookie；CSRF 403 不清 Cookie、不撤销 session；登出清 Cookie（`Max-Age=0`） | 响应头 + Cookie jar 检查，三者在同一矩阵 |

多标签的“只轮换一次”口径需要在实现前定死：是“服务端 current 哈希只前进一次”，还是“两个标签都不得收到 `SESSION_EXPIRED`”。建议两者同时断言，宽限只允许中间态短暂存在。

TTL 注入口径（P2）：`ORCA_CLOUD_ACCESS_TTL_MS` 只用于缩短 access TTL（`server.ts:6095`，AC2）；refresh TTL（`server.ts:109`）必须用独立注入变量，不得复用 access 变量，避免把“刷新恢复”与“refresh 过期”混为一谈。AC12 的 Cookie 丢失用例也不得通过改 TTL 模拟。

---

## 5. 待决策（压缩为 6 项）

1. **B 是否推进**：确认方案 B 为关闭 QA-032 的唯一路径；本周期不能改服务端时，A 只作临时缓解且 QA-032 保持未关闭。未来 SSO 是否按 Cookie 方案设计（若是，B 为前置约束）。
2. **响应契约与能力协商**：body 提供才回 body refresh（P0-1/P0-2 已定，不再开放）；能力标记用响应字段 `refreshCookie: true` 还是 `x-orca-web-contract`；body `refreshToken` 的移除时点必须与 `MIN_WEB_CONTRACT_VERSION` 提升绑定。
3. **Cookie 属性与生命周期**：Cookie 名、`Path`、`SameSite`；会话 Cookie（关闭浏览器即结束）还是 `Max-Age=12h`（含“恢复上次会话”例外）；`ORCA_CLOUD_COOKIE_MODE=auto` 在非 loopback 纯 http 下告警后是否放行。
4. **grace 与审计**：默认 `graceMs`（30/60 秒），生产是否允许 `0`；`refresh.grace_reuse` / `refresh.reuse_detected` 的审计目录与告警阈值；多标签登出是否用 `BroadcastChannel` 即时切换（否则接受下一次请求被动登出）。
5. **部署前置**：TLS、反向代理的 Host/`X-Forwarded-Proto`、`ORCA_CLOUD_PUBLIC_ORIGIN` 的配置责任；多副本必须粘性会话或共享 store；CSP 是否与 B 同批（`style-src 'unsafe-inline'` 为过渡豁免）。
6. **回退与关闭口径**：新 Web + 旧服务端回退 `localStorage` 是否接受（该组合下 QA-032 保持未关闭）；回滚顺序固定为 Web 先、服务端后；QA-032 关闭只认 Cookie-only 刷新，TTL 缩短、`orca.user` PII、宿主 `orca.webCloudSession` 均不纳入关闭条件。
