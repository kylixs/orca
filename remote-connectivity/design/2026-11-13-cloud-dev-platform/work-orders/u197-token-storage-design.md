# U197：M116-QA-032 令牌存储加固设计

- 状态：草案，待裁定（本文只出方案，不改 `apps/**` 与测试）
- 缺陷：M116-QA-032（P2，U54 台账）——`orca.access` / `orca.refresh` 明文存 `localStorage`
- 范围：`cloud-platform/apps/web` 平台 Web 控制台及其同源 API（`cloud-platform/apps/api`）
- 台账原始记录：`remote-connectivity/design/2026-11-13-cloud-dev-platform/test-reports/exploratory-qa-web.md:277`
- 证据：`cloud-platform/evidence/m116-exploratory-web/findings.json:484`（登录后两个键均为 43 字符明文）

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
2. 刷新接口先读 cookie，再回退到 body（`body.refreshToken`，`3186`）；两种来源都走现有轮换逻辑（`3198-3209`）。
3. 登出（`3306-3324`）增加清除 cookie；仍用 Bearer 撤销 session。
4. Cookie 认证引入 CSRF 面：要求 `Origin` 与 `requestOrigin(req)` 精确一致（`server.ts:274-287`），并校验 `content-type: application/json`；可按需加 `Sec-Fetch-Site: same-origin`。跨站请求返回 403 且不轮换。仅用 body 认证的旧客户端不受该检查影响。
5. 轮换宽限：为 session 增加“上一枚 refresh 哈希 + 短期有效窗”（建议 30-60 秒），窗口内接受旧哈希，每次成功轮换顺延。没有它，同源多标签共享同一 cookie 并发刷新时，第二个请求会命中复用检测并把整个 session 撤销（`3192-3195`）。宽限窗口会短暂削弱严格复用检测，需要显式接受。
6. 兼容字段：响应体继续返回 `refreshToken`；新增非密能力标记（如 `refreshCookie: true`）告知新前端“可以丢弃 body 中的 refresh”。旧服务端没有该字段，新前端保留回退路径。

**前端改动**

- `setTokens()` 只写内存（`app.js:96-101`）；删除对 `orca.access`/`orca.refresh` 的读写（`5-7`、`99-100`、`4399-4400`）。
- 启动恢复（`4551-4566`）：无 access 时先 `POST /v1/auth/refresh`（fetch 默认 `same-origin` 凭据模式，Cookie 会随请求发送），成功后再 `GET /v1/me`；失败才 `showLogin()`。
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
- body 回退路径；Origin 拒绝；跨标签并发刷新；页面刷新恢复；旧前端 e2e。
- 能力标记缺失时的回退（新前端 + 旧服务端）。

**迁移与回滚**

- 建议服务端先上：同时支持 Cookie 与 body、下发标记、保留响应字段。旧 Web 客户端继续工作（忽略 `Set-Cookie`）。
- Web 后上：检测到标记后切换为内存 + Cookie，并删除遗留键。检测不到（旧服务端）时回退到 `sessionStorage` 或临时保留旧行为，见待决策。
- 回滚顺序：先回滚 Web（重新部署旧构建，归档资源仍可服务，`web-release.ts:60-110`），再回滚服务端；否则“只有 Cookie、没有 body refresh”的新页面会在旧服务端上无法恢复。
- 兼容窗口内不移除响应体 `refreshToken`；移除需要提升 Web 契约版本并提高 `MIN_WEB_CONTRACT_VERSION`（`web-release.ts:12-15`、`web-contract.ts:30-45`）。

**风险**

- 新增 CSRF 面：必须确保 Origin 校验覆盖所有 Cookie 认证的刷新；代理必须正确传递 Host / `X-Forwarded-Proto`。
- `Secure` Cookie 在纯 http 的非 loopback 环境不会被浏览器保存：本地/测试环境需明确策略（loopback 例外或 cookie 模式降级），不能静默失效。
- 宽限窗口是安全性与并发可用性的显式权衡。
- 会话存储仍是单进程内存（`store.ts:160-165`）；多副本部署时 Cookie 不能解决跨副本刷新，属于既有部署约束（待确认拓扑）。

### 方案 C：保留 localStorage + 强化缓解

**机制**：不改存储位置，靠严格 CSP、缩短 TTL、设备/风险绑定、轮换检测降低被利用窗口。

**改动面**

- 服务端：新增 CSP 响应头（`static-delivery.ts:15-17` 处扩展）；可调 TTL（`server.ts:108-109`、`6087-6098`）。
- 前端：无协议改动；可清理 `orca.user` 等非必要持久化。
- 协议：无。

**可行性与细节**

- 严格脚本 CSP 可行：`index.html` 没有内联脚本，只加载 `/app.js`（`index.html:200`）。但 `app.js` 模板里有 16 处内联 `style="..."`，`style-src 'self'` 会拦截，需要允许 `style-src 'unsafe-inline'` 或先改为 class。建议先 `Content-Security-Policy-Report-Only` 观测。
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

1. 服务端：下发 Cookie、双读（Cookie 优先，body 回退）、Origin/content-type 校验、轮换宽限、响应能力标记；响应字段不变。
2. Web：能力标记为真时切换为“access 内存 + Cookie refresh”，删除 `localStorage` 令牌键；标记缺失时进入受限回退（见待决策）。
3. 清理：兼容窗口结束后，才考虑停止返回 body refresh / 提升 Web 契约版本；本次不排期。
4. 并行纵深：严格脚本 CSP（Report-Only 起步）、遗留键清理、登出跨标签通知。

**Wire / 旧 peer 兼容**

- 本设计不新增流操作码，不改 RPC 帧；变化的只是 Web 控制台与平台 HTTP API 之间的凭据传输方式。
- 旧 Web 客户端（包括部署前加载、仍由归档资源服务的旧页面）：继续用 body `refreshToken`，服务端双读，行为不变；它忽略 `Set-Cookie`。
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
| AC4 | 注入模拟 XSS 脚本读取 `localStorage`、`sessionStorage`、`document.cookie`，均拿不到 refresh；该值也不出现在 URL/hash、控制台日志、审计 metadata | 注入固定探针脚本，断言三段输出均不含 refresh；审计事件字段检查（现有审计不含令牌，`server.ts:3160-3167`） |
| AC5 | 两个同源标签同时刷新只产生一次有效轮换：access 过期后两标签并发请求 `/v1/me`，两者都恢复；服务端 session 未被撤销，refresh 轮换次数为 1（宽限方案下可为 2 次请求、1 次 current 轮换，需在实现时定义可观测口径） | 双页面并发 + `ApiHandle.store` 检查 `session.refreshHash` 变化/`refreshTokens` 增量；若测试进程拿不到 store，则退化为网络请求计数（待确认可观测点） |
| AC6 | 跨站 CSRF 刷新被拒：带有效 Cookie、`Origin: https://evil.example` 的 `POST /v1/auth/refresh` 返回 403，且不改变 session/不轮换；原标签后续请求仍有效 | 原始 HTTP 请求构造（Playwright `request` 或 fetch） |
| AC7 | 登出清除 Cookie（`Max-Age=0`）并撤销 session：随后刷新请求返回 401；其他标签在 N 秒内切到登录页或下一次请求被动登出 | 双标签 + 网络断言 |
| AC8 | 旧客户端兼容：仅带 body `refreshToken` 的刷新仍返回 200 与新令牌；新客户端在缺少能力标记时进入回退且不出现刷新死循环 | 保留现有 e2e/探针，新增“旧服务端/旧客户端”矩阵用例 |
| AC9 | 旧持久化清理：升级后首次加载删除遗留 `orca.access`/`orca.refresh`；迁移窗口内若旧 refresh 可用，应成功换新后删除，不可用则安静回登录页 | 预置旧键后加载页面 |
| AC10 | 纵深（若同批落地）：静态响应含 `Content-Security-Policy`，`script-src 'self'`，页面无脚本违规；样式如需 `unsafe-inline` 必须在设计里显式记录 | 响应头 + `securitypolicyviolation` 监听 |

多标签的“只轮换一次”口径需要在实现前定死：是“服务端 current 哈希只前进一次”，还是“两个标签都不得收到 `SESSION_EXPIRED`”。建议两者同时断言，宽限只允许中间态短暂存在。

---

## 5. 待决策

1. **主选确认**：是否按方案 B 推进？若本周期不能改服务端，是否接受 A 作为临时缓解并保留 QA-032 为未关闭？
2. **Cookie 生命周期**：使用会话 Cookie（关闭浏览器即结束，共用机器更安全）还是 `Max-Age=12h`（与现有 refresh 语义一致、重开仍登录）？浏览器“恢复上次会话”可能保留会话 Cookie，需接受该例外。
3. **响应体是否继续返回 `refreshToken`**：建议兼容窗口内继续返回；何时移除、是否需要提升 Web 契约版本（`web-release.ts:12-15`）？
4. **能力协商方式**：新增响应字段（如 `refreshCookie: true`）还是启用 `x-orca-web-contract`（`web-contract.ts:1-45`）？前端当前不发该头，需要一并决定是否开始发送。
5. **CSRF 机制**：`Origin` + `content-type` 校验是否足够，是否需要双提交令牌或 `Sec-Fetch-Site`？反向代理必须正确传递 Host / `X-Forwarded-Proto`，部署侧是否可保证？
6. **轮换宽限参数与安全容忍度**：宽限 30/60 秒是否接受？宽限期间旧 refresh 可重放，是否需要在审计中记录异常复用？
7. **多标签登出同步**：是否要求即时切换登录页（`BroadcastChannel`），还是接受下一次请求被动登出？
8. **新前端遇到旧服务端的回退**：回退到 `sessionStorage`（多标签需重登）还是临时保留 `localStorage`（短暂延续缺陷）？这决定回滚顺序和 QA-032 的关闭时点。
9. **Secure Cookie 与本地/测试环境**：生产强制 https；纯 http 的 loopback、IP、容器环境如何处理（loopback 例外、仅测试放行、还是 cookie 模式返回明确错误）？
10. **范围扩展**：宿主托管的 `cloud-admin.html` 仍把令牌存 `orca.webCloudSession`（`src/renderer/src/web/web-cloud-session-storage.ts:10-15`），是否另开一单？`orca.user`（PII）是否一并减少持久化？
11. **CSP 批次**：是否与 B 同批上线？脚本侧可严格；16 处内联 `style="..."` 需要允许 `style-src 'unsafe-inline'` 或先重构，选择哪条？
12. **TTL 产品取舍**：是否维持 access 30 分钟 / refresh 12 小时滑动（`server.ts:108-109`），还是借本次缩短？
13. **部署拓扑**：平台是否存在多副本/多实例？session 与令牌映射目前是进程内存（`store.ts:160-165`），若是多副本，Cookie 方案需要粘性会话或共享 store，否则刷新会随机失败（待确认）。
14. **SSO 路线**：未来 SSO 是否按 Cookie 方案设计？若是，B 的方向应作为前置约束固定下来。
