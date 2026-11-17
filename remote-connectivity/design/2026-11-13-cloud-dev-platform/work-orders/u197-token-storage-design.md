# U197：M116-QA-032 令牌存储加固设计

- 版本：v3（依据 `cloud-platform/test-reports/u197-token-design-rereview.md`（本地，只读）修订）
- 基线：以符号名为准，行号按 `5bfc3d4c9f7` 重算；v2 复审报告同 HEAD
- 状态：v3 草案，待复审/裁定（本文只出方案，不改 `apps/**` 与测试）
- 缺陷：M116-QA-032（P2，U54 台账）——`orca.access` / `orca.refresh` 明文存 `localStorage`
- 范围：`cloud-platform/apps/web` 平台 Web 控制台及其同源 API（`cloud-platform/apps/api`）
- 台账原始记录：`remote-connectivity/design/2026-11-13-cloud-dev-platform/test-reports/exploratory-qa-web.md:277`
- 证据：`cloud-platform/evidence/m116-exploratory-web/findings.json:484`（登录后两个键均为 43 字符明文）

## 修订记录（v2）

> 以下为 v2 历史记录；P0-1/P0-2 的响应形态已被 v3 修正，以 v3 记录与正文为准。
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

## 修订记录（v3，依据 v2 复审报告）

| 复审项 | 落点 | 要点 |
|---|---|---|
| P0-1 响应形态 | §2B 服务端改动 2、§3 矩阵、§4 AC4/AC8/AC11 | Cookie 认证来源绝不返回新签 refresh；仅 current/previous 原样回显请求值；假 body 无 refresh；AC11 三档 |
| 能力标记 | §2B 服务端改动 6、§5-2 | 删除 `x-orca-web-contract` 作为响应决策；能力只认响应字段 `refreshCookie`；登录/刷新/交接统一出现规则 |
| 前端 401 | §2B 前端改动、§4 AC14 | Cookie 模式 401 即尝试一次 Cookie 刷新；补页内 401（reload 之外） |
| 登出 | §2B 服务端改动 3、§4 AC7 | Bearer 无效/过期也清 Cookie；可据 Cookie 撤销 session；补「access 过期 + Cookie 有效」 |
| 迁移状态机 | §2B 前端改动（迁移状态机）、§4 AC9a-d/AC12 | 四分支写死；成功无 body 刷新前不删键；绝不循环 |
| body refresh 移除 | §2B 迁移与回退判据、§5-5 | 不依赖抬 `MIN_WEB_CONTRACT_VERSION`；遥测 + 期限窗口 |
| 锚点与默认值 | §1、§2B、§4、§5 | 符号名 + 重算行号；TTL env 对齐；`graceMs`/Cookie 可执行默认；能力标记位置统一 |
| handoff 跨源 | §2B「handoff 跨源」、§3 兼容、§5-6 | 区分平台同源与宿主跨源；宿主路径 Cookie 不生效，写明当前限制 |
| 待决策 | §5 | 重切为 6 条互不重叠 |

---

## 1. 现状与威胁模型

### 1.1 令牌与生命周期

| 项 | 现状 | 依据 |
|---|---|---|
| access token | 32 字节随机数（base64url），30 分钟；服务端内存 Map 校验，非 JWT | `ACCESS_TTL_MS`（`server.ts:128`）、`issueSession`（`server.ts:2714-2743`）、`resolveToken`（`server.ts:2697-2711`） |
| refresh token | 32 字节随机数，12 小时滑动过期；每次刷新轮换 | `REFRESH_TTL_MS`（`server.ts:129`）、刷新端点（`server.ts:3345-3371`） |
| 轮换检测 | 旧 refresh token 仍能定位 session，哈希不匹配即撤销整个 session | `server.ts:3353-3359` |
| 签发入口 | 密码登录、Web 交接码，共用 `issueDeviceSession` | `issueDeviceSession`（`server.ts:2745-2757`）、登录（`server.ts:3239`）、交接（`server.ts:3375`） |
| 登出 | Bearer access 定位 session 后撤销并 bump epoch | `server.ts:3467-3484` |
| 持久化 | 默认仅进程内存；只有显式开发快照才落盘（含 sessions/tokens） | `cloud-platform/apps/api/src/store-persistence.ts:117-126`、`147-173` |
| 设备绑定 | 登录体里的 `devicePubKey` 固定为字符串 `'web-client'`，不是密码学绑定 | `cloud-platform/apps/web/app.js:4799` |

结论：refresh token 是长期凭据（12 小时、滑动、可无限续期），泄露后的价值远高于 access token；轮换复用检测已存在，但前提是同一 token 只有一个持有者。

### 1.2 存储点、读取点与清理点

| 行为 | 位置 | 说明 |
|---|---|---|
| 启动时读取 | `apps/web/app.js:5-7` | 模块加载即从 `localStorage` 读 `orca.access` / `orca.refresh` |
| 写入 | `app.js:96-101` | `setTokens()` 同时写内存与 `localStorage` |
| 登录写入 | `app.js:4815` | 登录响应直接落盘（`setTokens`） |
| 刷新写入 | `app.js:73-94` | `/v1/auth/refresh` 响应再次落盘 |
| 每次 API 读取 access | `app.js:44-53` | `Authorization: Bearer` |
| 401 刷新 | `app.js:54-58`、`73-94` | 页内 `refreshInFlight` 合并并发刷新 |
| 登出清理 | `app.js:4822-4853`（特别 `4844-4845`） | 仅显式登出时删除 |
| 非密数据 | `app.js:4816-4819`、`1777-1782` | `orca.user`（用户资料 PII）、`orca.device` |
| 页面恢复 | `app.js:4987-5005` | 只用 access 调 `/v1/me`；失败只清内存 access，不清 `localStorage` 的 access/refresh |

关键行为缺口：页面恢复不尝试用 refresh 换新 access。因此浏览器空闲超过 30 分钟后刷新页面，会直接回到登录页，尽管 refresh 仍有 12 小时有效期（`app.js:4987-5005`）。

### 1.3 多标签与刷新恢复

- `app.js` 中没有 `storage` 事件监听，也没有 `BroadcastChannel`；每个标签在加载时对 `localStorage` 做一次快照（`app.js:5-7`）。
- 标签 A 刷新后把新令牌写回 `localStorage`（`app.js:73-94`、`99-100`），标签 B 的内存里仍是旧 refresh。标签 B 下一次 401 用旧 refresh 请求，服务端命中 `session.refreshHash` 不匹配并撤销 session（`server.ts:3353-3359`）——A、B 同时掉线。
- 同一标签内的并发 401 已由 `refreshInFlight` 合并（`app.js:73-94`），但跨标签没有合并，也没有服务端轮换宽限。
- 标签 A 登出会撤销服务端 session（`server.ts:3467-3484`）；标签 B 不会立即切登录页，下一次请求失败后才被动登出。
- 页面刷新：同标签内 access 有效则恢复（`app.js:4990-4998`）；access 过期但没有刷新逻辑，见 1.2。

这条现状直接约束候选方案：任何把多个标签继续指向同一个 refresh token 的方案，必须解决跨标签轮换竞争，否则会把现有的偶发掉线放大成常态。

### 1.4 同源部署与现有防护

- API 自己静态托管 Web 控制台：非 `/v1/`、非 `/install/` 的 GET 走 `serveStatic`（`server.ts:3228-3236`、`6443-6475`），Web 根目录为 `WEB_ROOT`（默认 `../../web/`，`server.ts:6417`），入口 `index.html` 以 module 方式加载 `/app.js`（`cloud-platform/apps/web/index.html:200`）。因此平台控制台与登录/刷新接口天然同源。
- 全仓检索未发现 `Content-Security-Policy`；静态响应只带 `referrer-policy: no-referrer`（`static-delivery.ts:15-17`），JSON 响应复用同一组头（`server.ts:219-226`）。没有 CSP，XSS 的利用成本就是普通 DOM 注入。
- 页面有 39 行含 `innerHTML` 赋值（如 `app.js:421`、`431`、`450`），转义依赖人工调用 `esc()`（`app.js:29-34`）；171 行调用 `esc(` 说明这是约定而非强制。QA-032 目前未找到注入点，但该结构不具备“即使有 XSS 也拿不到长期令牌”的纵深。
- 前端与 API 独立发布：前端资源按内容哈希归档，旧页面在部署后仍可解析自己的旧资源（`web-release.ts:1-9`、`60-110`）；入口 `index.html` 为 `no-cache`（`server.ts:6458-6465`）。已有版本化 Web 契约 `x-orca-web-contract`（`web-contract.ts:1-45`、`web-release.ts:12-15`），但 `app.js` 目前不发该头，服务端把空值视为当前版本（`web-contract.ts:32-38`）。
- 当前没有任何 Cookie 处理：`apps/api/src` 中无 `set-cookie` / `cookie` 读取。认证完全依赖 `Authorization` 头（`resolveToken`，`server.ts:2697-2711`），所以今天不存在 CSRF 面；这一点在方案 B 中会改变。
- 已存在的跨源页面只有宿主/中继托管的 `cloud-admin.html` / `web-index.html`，CORS 精确白名单、Bearer 认证（`corsAllowOriginFor`，`server.ts:2823-2826`、`3127-3137`）。它们另用 `orca.webCloudSession` 存令牌（`src/renderer/src/web/web-cloud-session-storage.ts:15,50-57`），属于本次范围之外的同类问题，见待决策。

### 1.5 威胁模型

| 攻击者能力 | 当前结果 | 加固目标 |
|---|---|---|
| 任意同源脚本执行（XSS、被篡改的第三方脚本、恶意浏览器扩展注入页面） | 可直接读取并外带 access + refresh，最长维持 12 小时滑动会话 | refresh 不可被脚本读取/持久化外带；access 仅内存 |
| 共用电脑/共用浏览器配置文件 | 关闭标签页后令牌仍在；12 小时内打开页面即恢复会话 | 关闭浏览器或明确登出后不可恢复（可配置） |
| 网络攻击者 | 生产 TLS 下不可读；本地 http 环境可被截获 | 不新增明文通道；Cookie 加 `Secure` |
| 跨站页面（方案 B 引入 Cookie 后） | 无 Cookie，无 CSRF 面 | Cookie 认证的刷新接口必须拒绝跨站 Origin |
| 被窃 refresh 重放 | 已有轮换复用检测，可撤销 session（`server.ts:3353-3359`） | 保留该检测；为多标签竞争引入有限宽限，并记录其风险 |
| XSS 在页面存活期间代替用户发请求 | 本来就可以（Bearer 在内存） | 不承诺“XSS 无害”，只承诺 refresh 不可被读取和离线复用 |

---

## 2. 候选方案

### 方案 A：access 仅内存 + refresh 存 sessionStorage

**机制**：`setTokens()` 只更新内存；refresh 写入 `sessionStorage`；access 永不持久化。页面加载时若内存无 access，则用 sessionStorage 的 refresh 调 `/v1/auth/refresh` 换取 access。服务端不改。

**改动面**

- 前端：`app.js:5-7`、`96-101`、`4815`、`4844-4845`、`4987-5005`；登录/刷新/登出/恢复五处。
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

1. 登录（`server.ts:3239`）、刷新（`3345-3371`）、Web 交接（`3375-3467`）在成功响应中下发 refresh cookie；交接仅对平台同源请求下发（宿主跨源见下方「handoff 跨源」），属性默认值见「Cookie 默认值」。
2. 刷新接口响应形态按**实际认证来源**决定，不使用请求头/客户端声明（P0-1 写死）：
   - **认证来源判定**：请求带有效 refresh Cookie 即 Cookie 源；否则 body `refreshToken` 非空且能定位 session 为 body 源；都没有 → 401。来源判定顺序固定为 Cookie 优先、body 回退（第 5 条第 4 点）。
   - **Cookie 为认证来源：绝不轮换、响应体绝不返回服务端新签 refresh。**
     - 请求体为空：不轮换；只签发 access，滑动续期 `refreshExpiresAt`，并以**同一 refresh 值**重发 `Set-Cookie` 的 `Max-Age`；响应体只有 `accessToken`/`expiresIn`。
     - 请求体非空且经哈希比较等于本 session 的 `current`：**不轮换、不签发新 refresh**；只签发 access，滑动续期 `refreshExpiresAt`（同一值重发 Cookie）；响应体**原样回显请求值** `refreshToken`（与请求逐字节一致）。
     - 请求体非空且等于本 session 的 `previous`（宽限窗口内）：**不轮换、不续期**；只签发 access；响应体**原样回显请求值** `refreshToken`。
     - 请求体非空但不属于本 session（任意假 body、其他 session 的 token、乱码）：**不得因此返回任何 refresh**；按无 body 的 Cookie 请求处理（不轮换、只签发 access、同一 Cookie 续期），响应体不含 `refreshToken`。
     - 禁止以「body 是否存在」作为返回新 token 的条件；上述回显是 Cookie 源唯一可能出现的 body refresh，且恒等于请求值。轮换（服务端新签 refresh）只发生在 body 源 current 路径。
   - **body 为认证来源（无有效 Cookie）**：
     - 命中 `current`：正常轮换，响应体返回**本次新签发**的 `refreshToken`（唯一返回新 token 的路径）；同一响应也下发 `Set-Cookie`（同源才生效），使旧页面下一次刷新自然迁移到 Cookie 源。
     - 命中 `previous`（宽限内）：不轮换、不续期，响应体**原样回显请求值**。
     - 其他：401 `SESSION_EXPIRED`。
3. 登出（`server.ts:3467-3484`）**无论 Bearer 是否有效/过期**都 `Set-Cookie ... Max-Age=0`；Bearer 有效则撤销其 session；Cookie 可定位 session 且与 Bearer 的 session 不同时也一并撤销；Bearer 缺失/无效但 Cookie 可定位时按 Cookie 撤销；两者都没有也清 Cookie 并返回 200。清理 Path/属性必须与下发时一致，否则清不掉。
4. CSRF 校验**只作用于实际使用 Cookie 的请求**（P1-3）：要求 `Origin` 与可信源精确一致，并校验 `content-type: application/json`；可按需加 `Sec-Fetch-Site: same-origin`。可信源优先取新增配置 `ORCA_CLOUD_PUBLIC_ORIGIN`，未配置时才回退 `requestOrigin(req)`（`server.ts:314-324`，依赖 Host/`X-Forwarded-Proto`）。Cookie 路径拒绝缺失 `Origin` 与 `Origin: null`；跨站返回 403 且不轮换。仅 body 认证的旧客户端与宿主跨源 Bearer 通道保持现状，不受该检查影响。
5. 轮换宽限语义（P1-1 定死，六条，与第 2 条一致）：
   1. session 持有 `refreshHash`（current）、`previousRefreshHash`、`graceUntil`；只有 **body 源 current** 完成一次轮换时才前进：签发新 refresh、把旧 current 写入 previous、设 `graceUntil = now + graceMs`。Cookie 源一律不轮换（第 2 条）。
   2. previous 在窗口内（`now < graceUntil`）命中：**不轮换、不续期**（不延长 session/refresh/grace）、**不签发新 token**，只签发 access；请求未提供 body 时响应无 refresh，提供了则原样回显该请求值（绝不以 current 或新 token 替换）。
   3. 撤销/过期先短路：session 已撤销或 refresh 已过期时，无论命中 current/previous 一律 401 `SESSION_EXPIRED`，宽限不得放行。
   4. 来源判定顺序：先 Cookie、后 body；仅 Cookie 缺失或无效才回退 body；两种来源共用同一套 current/previous 判定与撤销短路规则。
   5. 命中 previous 但窗口已过，等同复用旧 token，按现有复用检测撤销整个 session（`server.ts:3353-3359`）。
   6. `graceMs` 可配，允许 `0`（严格复用检测；并发刷新的第二请求会撤销 session）；默认 `30_000`，env `ORCA_CLOUD_REFRESH_GRACE_MS`，上限 `60_000`。
   宽限审计：新增 `refresh.grace_reuse`（窗口内命中 previous）与 `refresh.reuse_detected`（撤销）事件，落入现有审计出口（与 `web_handoff` 的 `appendBestEffort` 同一目录），只记录 session/来源类型，不记录 token 值。
6. 能力标记（统一）：**删除 `x-orca-web-contract` 作为响应决策的选项**；能力只走响应字段 `refreshCookie: true`。出现位置统一为登录、刷新、交接三类成功响应，且**仅当该响应实际为平台同源请求下发了可用的 refresh `Set-Cookie`**（无 `Origin` 的非浏览器调用按同源处理；`ORCA_CLOUD_COOKIE_MODE=never` 时省略）；其他情况一律省略该字段（不写 `false`）。旧前端忽略它；新前端只有看到 `true` 才进入 Cookie 模式。
7. Cookie 模式配置（P1-2）：`ORCA_CLOUD_COOKIE_MODE=auto|always|never`，默认 `auto`。`always` 强制 `Secure`；`auto` 在 https 或 loopback 下带 `Secure`，在非 loopback 的纯 http 下必须**显式降级并输出一次告警**（不得静默丢失 Cookie）；`never` 不下发 Cookie（仅用于排障）。
8. 失败路径副作用（P2）：`SESSION_EXPIRED` 时清除 refresh Cookie；CSRF 403 **不清 Cookie、不撤销 session**；登出清 Cookie（`Max-Age=0`）并撤销 session。三条必须在同一测试矩阵中断言。

**Cookie 默认值（可执行）**

| 属性 | 默认 | 说明 |
|---|---|---|
| 名称 | `orca_refresh` | 不复用 `orca.access`/`orca.refresh` 键名，避免与 localStorage 混淆 |
| `Path` | `/v1/auth` | 覆盖 login/refresh/logout，不发给 `/v1/me` 等业务接口；改 Path 时必须先用旧 Path 清一次 |
| `HttpOnly` | 恒开 | 脚本不可读 |
| `SameSite` | `Lax` | Cookie 认证的刷新仍需第 4 条 Origin 校验 |
| `Secure` | 随 `ORCA_CLOUD_COOKIE_MODE` | `always` 恒开；`auto` 仅 https/loopback；`never` 不下发 |
| `Max-Age` | `ORCA_CLOUD_REFRESH_TTL_MS / 1000`（默认 `43200` 秒） | Cookie 源续期时以同一值重发；仅 body 源轮换产生新值；等价当前 12 小时滑动行为 |

TTL 变量统一：access 用 `ORCA_CLOUD_ACCESS_TTL_MS`（`server.ts:6559`），refresh 用 `ORCA_CLOUD_REFRESH_TTL_MS`（`server.ts:6560`），不得互相复用。

**handoff 跨源（P1-1 写死）**

- **平台同源**（平台控制台从 API 同源加载）：Cookie 正常存取，适用方案 B 全部行为。
- **宿主跨源**（`cloud-admin.html` / `web-index.html` 由宿主 TLS 直连或中继浏览器边缘托管，调用 `${apiUrl}/v1/web/handoff`）：`web-cloud-request.ts:27-42` 使用 fetch 默认 `credentials: same-origin`，且 CORS 只回 `access-control-allow-origin`、不回 `access-control-allow-credentials`（`server.ts:3127-3137`）。因此浏览器**既不发送也不保存**平台 Cookie；handoff 响应里的 `Set-Cookie` 被丢弃，`refreshCookie` 也不会出现。宿主页面继续 Bearer + `orca.webCloudSession`（`web-cloud-session-storage.ts:15,50-57`）。
- 当前限制：Cookie 模式只覆盖平台控制台，**不覆盖 handoff 路径**。要让宿主 Cookie 生效需 `credentials: 'include'` + `Access-Control-Allow-Credentials: true` + `SameSite=None; Secure`（并受第三方 Cookie 限制），本设计不做，列入 §5-6 范围裁定。

**前端改动**

- `setTokens()` 只写内存（`app.js:96-101`）；Cookie 模式下不再读写 `orca.access`/`orca.refresh`（`5-7`、`99-100`、`4844-4845`）。
- **401 守卫（P1-3 写死）**：`app.js:54-58` 当前条件是 `state.refreshToken`，Cookie 模式下该值为空会导致永远不刷新。改为：
  - `cookieMode === true` 时，任意 401 都尝试一次 `refreshSession()`（无 body Cookie 刷新）；成功则重放原请求，失败则 `logout()`。
  - `cookieMode !== true`（旧服务端/旧模式）时保持现有 `state.refreshToken` 条件。
  - 页内单次性由 `refreshInFlight` 合并（`app.js:73-94`）；同一请求链最多自动刷新一次，避免 401 循环。
- **迁移状态机（P1-2 写死，按页面加载时的前置分支）**：
  1. **标记真（`refreshCookie: true`）**：登录响应或一次成功的无 body 探测已证明 Cookie 可用 → 进入 Cookie-only；删除旧键只发生在该次无 body 刷新成功之后，此后不再写任何 `localStorage` 令牌键。
  2. **未知 + 旧键**：先发**一次**无 body Cookie 刷新（探测）。成功（标记为真）→ 删除旧键并进入 Cookie-only；失败 → 用旧 refresh 发**一次** body 刷新。body 刷新成功且响应标记为真 → 切换 Cookie-only 但**保留旧键**（尚未有无 body 成功，不得先删后验），待下一次无 body 刷新成功后再删；标记缺失 → 旧服务端，保留旧键、继续 `localStorage`（该组合下 QA-032 保持未关闭）；body 刷新失败 → 保留旧键、不循环、`showLogin()`。
  3. **无旧键**：发**一次**无 body Cookie 刷新恢复会话；成功进入应用，失败 `showLogin()`；不自动重试。
  4. **失败**：任何分支都**不得在无 body 刷新成功前删除旧键**；一次页面加载内最多「1 次无 body + 1 次 body」刷新，绝不循环。旧 refresh 失效时保留键但不再使用，用户重新登录成功后再清理。
- 启动恢复（`app.js:4987-5005`）：无 access 时按上述状态机先刷新（fetch 默认 `same-origin`，Cookie 随请求发送），成功后再 `GET /v1/me`；不得自动重复刷新。
- 刷新请求（`app.js:73-94`）在 Cookie 模式不再发送 body token；保留 body 仅作为「标记缺失/旧服务端」的回退。
- 多标签：Cookie 自动共享；Cookie 源无轮换竞争，body 源旧客户端由服务端宽限兜底。建议用 `BroadcastChannel` 同步“已登出/已刷新”以改善 UI 一致性，但它不是正确性的前提。
- 登出（`app.js:4822-4853`）：调用 `/v1/auth/logout`（带 Bearer，即使已过期也调用，让服务端清 Cookie/按 Cookie 撤销）；清理遗留 `localStorage` 键；通知其他标签切换登录页。

**多标签与刷新行为**

- 页面刷新：Cookie 自动携带，刷新恢复可用，且修复了 1.2 中“access 过期后刷新页面直接回登录页”的缺口。
- 新标签：同源 Cookie 自动可用，无需登录。
- 并发刷新：Cookie 源无轮换竞争；body 源旧客户端依赖服务端宽限窗口，客户端 `navigator.locks`/`BroadcastChannel` 只能作为优化（浏览器支持不一致）。

**SSO / 移动 WebView**

- 平台当前是 LDAP 密码登录（`server.ts:3239`），没有 SSO；未来 SSO 通常以 Cookie 为载体，B 与路线一致。
- 移动浏览器同源第一方 Cookie 不受第三方 Cookie 限制；后台标签被回收后，回前台刷新页面即可用 Cookie 恢复。Orca 移动 App 不消费这些端点，无影响。
- 宿主托管的 `cloud-admin.html` 是另一个源，继续用 Bearer + 自己的存储；平台 Cookie 不会自动给它用，不产生回归，但也不加固它（见待决策）。

**测试点**

- Cookie 属性（HttpOnly/Secure/SameSite/Path）；`document.cookie` 不可见；刷新与登出正确设置/清除。
- 响应形态矩阵：Cookie 源 + 空 body（无 refresh）、current（回显请求值）、previous（回显请求值且不含 current）、任意假 body（无 refresh）；body 源 current（返回新签发）、previous（回显请求值）。
- 页内 401（不 reload）触发一次 Cookie 刷新并重放成功；登出在 access 已过期 + Cookie 有效时仍清 Cookie 并撤销 session。
- body 回退路径；Origin 拒绝（含缺失/`null`）；跨标签并发刷新；页面刷新恢复；旧前端 e2e。
- 能力标记缺失时的回退（新前端 + 旧服务端）；Cookie 丢失后只失败一次并回登录页（不重复刷新）。

**测试策略（P1-5 定死）**

- 服务端验收用 in-process API + 手动构造 `Cookie` 请求头，并断言 `ApiHandle.store` 中的 session/refresh 状态；happy-dom 没有真实 Cookie jar，不得用于 Cookie/CSRF 证据。
- 多标签与浏览器行为（Cookie 自动携带、`document.cookie` 不可见、页面刷新恢复、登出同步）用真实 Chromium（Playwright）。
- happy-dom 只做前端 UI 逻辑（旧键清理、回退分支、能力标记分支）。
- 严格复用检测用例显式传 `graceMs=0`；现有 `session-renewal.e2e` 的“严格复用立即撤销”“localStorage 断言”编码的是旧行为，必须随本设计改写，不能保留双重语义。

**迁移与回退判据（P1-4 定死）**

- 服务端先行判据：双读（Cookie 优先、body 回退）生效；登录/刷新/交接在同源请求下发 Cookie；刷新响应带 `refreshCookie`；Cookie 源 + current/previous body 原样回显请求值、假 body 不回 refresh；body 源 current 返回新签发 refresh。以上全部通过独立服务端验收后，才可发布 Web。
- Web 后行判据：真实 Chromium 中一次无 body 刷新成功拿到 access，且该次响应 `Set-Cookie` 生效（`document.cookie` 不可见）后，才删除遗留 `localStorage` 键并切换为内存 + Cookie。
- 新 Web + 旧服务端：能力标记缺失时回退 `localStorage`（临时延续缺陷，QA-032 在该组合下保持未关闭）；不得回退 `sessionStorage`（多标签会强制重登）。
- 回退顺序：先回滚 Web（旧构建仍可由归档资源服务，`web-release.ts:60-110`），再回滚服务端；禁止先回滚服务端，否则已切换 Cookie-only 的页面无法恢复。
- **body refresh 的移除判据（P1-4 写死，不依赖抬 `MIN_WEB_CONTRACT_VERSION`）**：
  - 事实前提：`readWebContract` 把缺失 `x-orca-web-contract` 视为当前版本（`web-contract.ts:32-38`），抬 `MIN_WEB_CONTRACT_VERSION` 无法区分旧页面，故不得作为移除开关。
  - 第 0 步：新 `app.js` 在所有 `/v1/auth/*` 请求发送 `x-orca-web-contract: <WEB_CONTRACT_VERSION>`；服务端对刷新请求记录两个聚合计数：`refresh.body_token`（请求体携带 `refreshToken`）与 `refresh.contract_missing`（缺 header）。缺 header 在这两个计数里一律按「旧」统计，即使契约门仍放行。
  - 实施先行：服务端双读 + Cookie 下发 + `refreshCookie` 标记全量上线；Web 新构建成为唯一入口后开始计时。
  - 移除门槛（同时满足）：(a) 新构建全量上线且条目 `index.html` 已 30 天；(b) 最近 14 天 `refresh.body_token = 0`（含缺 header 的请求）；(c) 最近 14 天归档旧资源的访问计数为 0 或仅剩内测。任一不满足不得移除。
  - 期限兜底：最迟新构建后 90 天移除 body refresh，接受「从未重载的旧标签页」在下一次刷新收到 401、被带回登录页；入口 `index.html` 为 `no-cache`（`server.ts:6458-6465`），一次重载即拿到新构建。旧 `app.js` 没有 426 处理/重载路径（`app.js:73-94`），所以不采用「缺 header 立即按最旧拒绝」的 426 方案。
  - 移除动作：刷新响应不再返回 body `refreshToken`（Cookie/body 两源一致）；此时可把 `MIN_WEB_CONTRACT_VERSION` 抬到下一版作为说明性 426，但它是移除后的表达，不是触发条件。

**风险**

- 新增 CSRF 面：必须确保 Origin 校验覆盖所有 Cookie 认证的刷新；代理必须正确传递 Host / `X-Forwarded-Proto`，并以 `ORCA_CLOUD_PUBLIC_ORIGIN` 作为代理链的权威源。
- `Secure` Cookie 在纯 http 的非 loopback 环境不会被浏览器保存：由 `ORCA_CLOUD_COOKIE_MODE` 显式处理并告警，不能静默失效。
- 宽限窗口是安全性与并发可用性的显式权衡；异常复用必须进审计（见服务端改动 5）。
- Cookie 源不轮换（P0-1 的直接约束）：被窃 Cookie 在 TTL 内可重放，靠 HttpOnly、12 小时滑动、显式登出/撤销与复用检测兜底；这是为消除 body 泄露面而接受的显式取舍。
- 部署前置：session 与 refresh 映射目前是进程内存（`store.ts:160-165`）。多副本部署必须配置粘性会话或共享 store，否则 Cookie 刷新会随机落到无 session 的副本而失败；这是上线前置，不由本设计兜底。
- 范围口径：`orca.user`（PII）与宿主 `cloud-admin.html` 的 `orca.webCloudSession` 属同类同源风险，但**不纳入 QA-032 的关闭条件**，另单处理。

### 方案 C：保留 localStorage + 强化缓解

**机制**：不改存储位置，靠严格 CSP、缩短 TTL、设备/风险绑定、轮换检测降低被利用窗口。

**改动面**

- 服务端：新增 CSP 响应头（`static-delivery.ts:15-17` 处扩展）；可调 TTL（`server.ts:128-129`、`6559-6562`）。
- 前端：无协议改动；可清理 `orca.user` 等非必要持久化。
- 协议：无。

**可行性与细节**

- 严格脚本 CSP 可行：`index.html` 没有内联脚本，只加载 `/app.js`（`index.html:200`）。但 `app.js` 模板里有 16 处内联 `style="..."`，`style-src 'self'` 会拦截，需要允许 `style-src 'unsafe-inline'` 或先改为 class。建议先 `Content-Security-Policy-Report-Only` 观测。
- CSP 完整草案（P2）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`。`style-src 'unsafe-inline'` 是内联样式的过渡豁免，须在报告中登记并在后续批次移除；`img-src` 若确有 data URI 再加 `data:`。落点：`static-delivery.ts:15-17` 的静态/HTML 响应与 `server.ts:219-226` 的共享响应头；JSON 接口不带 CSP。`report-to`/`report-uri` 的收集落点需在实施时指定，且违规报告不得包含令牌。
- 缩短 access TTL（如 10 分钟）与 refresh TTL（如 2-4 小时）能缩小窗口，但会提高刷新频率和 LDAP 重登频率，是产品取舍。
- “设备绑定”当前没有可用凭据：`devicePubKey` 是常量（`app.js:4799`），把 token 绑 UA/IP 易误伤且不抗本机攻击者；不建议作为主措施。
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
2. 平台前端与 API 同源（`server.ts:3228-3236`、`6443-6475`），Cookie 是最自然的传输方式，不需要跨源改造；现有宿主页面的 Bearer 通道不受影响。
3. B 顺带修复页面刷新恢复缺口（`app.js:4987-5005`）：Cookie 自动携带，刷新页面即可换新 access。
4. 兼容性可控：body 源刷新继续返回新 `refreshToken`；已有 Cookie 的旧页面收到的是其请求值的原样回显，不会写入 `undefined`；旧前端无需改动。前端和 API 独立发布、旧资源归档的机制（`web-release.ts:1-9`）要求这种双栈窗口。
5. 与未来 SSO 方向一致；C 的 CSP 可以作为并行纵深，不阻塞 B。

**备选：方案 A**，仅在服务端改动无法在本周期落地时采用。必须明确它不关闭 QA-032 的 XSS 外带面，并且会让新标签必须重新登录；若要保留多标签体验，需要额外的 `BroadcastChannel` 中继，复杂度会追上 B，却没有 B 的安全收益。

**建议实施顺序**

1. 服务端：下发 Cookie、双读（Cookie 优先，body 回退）、Origin/content-type 校验、轮换宽限、`refreshCookie` 标记；响应形态按 §2B 第 2 条（Cookie 源永不新签、current/previous 原样回显、假 body 不回；仅 body 源 current 返回新签发）。
2. Web：能力标记为真时切换为“access 内存 + Cookie refresh”，在一次无 body 刷新成功后删除 `localStorage` 令牌键；标记缺失时回退 `localStorage`（见 §2B 迁移判据与 §5）。
3. 清理：兼容窗口结束后，才考虑停止返回 body refresh / 提升 Web 契约版本；本次不排期。
4. 并行纵深：严格脚本 CSP（Report-Only 起步）、遗留键清理、登出跨标签通知。

**Wire / 旧 peer 兼容**

- 本设计不新增流操作码，不改 RPC 帧；变化的只是 Web 控制台与平台 HTTP API 之间的凭据传输方式。
- 旧 Web 客户端（包括部署前加载、仍由归档资源服务的旧页面）：继续用 body `refreshToken`，服务端双读；无 Cookie 时行为不变，它忽略 `Set-Cookie`。
- 旧客户端矩阵补充「已有 Cookie + body 请求」：服务端已下发 Cookie 后，旧页面仍会带 body refresh 刷新。响应必须让旧页面拿到**非 `undefined`** 的 refresh，否则 `setTokens(body.accessToken, undefined)` 会写入字符串 `"undefined"` 并掉线（`app.js:96-101`、`4815`）。v3 的保证是：请求值属于本 session 的 current/previous 时**原样回显该值**；任意假 body 不回 refresh。
- 宿主跨源 handoff：见 §2B「handoff 跨源」，Cookie 不生效，保持 body token + Bearer。

| 请求形态 | 认证来源 | 响应体 |
|---|---|---|
| 旧页面：body refresh，无 Cookie，current | body | 必含 body refresh（本次新签发） |
| 旧页面：body refresh，无 Cookie，previous（宽限内） | body | 含 body refresh = 请求值（不轮换） |
| 旧页面：已有 Cookie + body current/previous | Cookie | 含 body refresh = **请求值原样**（不轮换、不返回新 token） |
| 任意页面：已有 Cookie + 假 body | Cookie | 按无 body Cookie 请求处理：不轮换、同一 Cookie 续期；响应体无 `refreshToken` |
| 新页面：仅 Cookie | Cookie | 只含 `accessToken`/`expiresIn`，无 `refreshToken` |
| 新页面：Cookie 丢失 | 无 | 401，前端一次失败后回登录 |
- 新 Web 客户端 + 旧服务端：服务端没有能力标记，客户端不得假定 Cookie 存在；必须保留回退路径，否则页面刷新即掉线。
- 新服务端 + 旧客户端：服务端仍接受 body，轮换宽限不改变响应结构。
- 旧客户端在无 Cookie 时仍看到“轮换语义没变”（每次返回新 refresh）；一旦服务端下发 Cookie，旧页面的 body refresh 改为原样回显、不再轮换，但字段始终存在且非 `undefined`。
- 回滚顺序必须是 Web 先、服务端后；服务端回滚会移除 Cookie 下发，而已经切到 Cookie-only 的新页面将无法恢复。

---

## 4. 验收判据草案（可机检）

| # | 断言 | 检查方法 |
|---|---|---|
| AC1 | 登录成功、执行一次刷新、再登出后，`localStorage` 中不存在 `orca.access` / `orca.refresh`，且 `JSON.stringify(localStorage)` 不包含服务端返回的 refresh 值 | Playwright `page.evaluate` 扫描键与值；同时断言旧键被删除 |
| AC2 | access 过期后刷新页面仍保持登录：将 `ORCA_CLOUD_ACCESS_TTL_MS` 调短（`server.ts:6559`），等待过期后 `reload()`，页面进入工作台而非登录页；期间恰好发生一次 `POST /v1/auth/refresh` | Playwright 网络计数 + 页面可见性 |
| AC3 | 登录/刷新响应的 `Set-Cookie` 含 `HttpOnly`、`SameSite=Lax`（或最终裁定值）、TLS 环境下 `Secure`、约定 `Path`；`document.cookie` 不含 refresh 值 | 读取响应头 + `page.evaluate` |
| AC4 | 注入模拟 XSS 脚本读取 `localStorage`、`sessionStorage`、`document.cookie`，均拿不到 refresh；该值也不出现在 URL/hash、控制台日志、审计 metadata，且仅 Cookie 刷新响应体本身不含 refresh（body 回显矩阵由 AC8/AC11 覆盖） | 注入固定探针脚本，断言三段输出均不含 refresh；审计事件字段检查（现有审计不含令牌） |
| AC5 | 两个同源标签并发刷新：Cookie 模式下两标签都恢复且 `session.refreshHash` 不变（Cookie 源不轮换）；body 源旧客户端并发时 current 哈希只前进一次，previous 在宽限内命中不撤销 | 服务端同进程用 `ApiHandle.store` 断言 Cookie 源哈希不变、body 源最多一次前进与 `previousRefreshHash`/`graceUntil`；真实 Chromium 双页面断言无 `SESSION_EXPIRED` |
| AC6 | 跨站 CSRF 刷新被拒：带有效 Cookie、`Origin: https://evil.example` 的 `POST /v1/auth/refresh` 返回 403，且不改变 session/不轮换；原标签后续请求仍有效。Cookie 路径下缺失 `Origin` 或 `Origin: null` 同样 403 且不轮换；body-only 刷新与宿主跨源 Bearer 不受影响；可信源优先取 `ORCA_CLOUD_PUBLIC_ORIGIN` | 原始 HTTP 请求构造（Playwright `request` 或 in-process）；代理集成用例覆盖 `Host`/`X-Forwarded-Proto` 与配置源不一致时以配置为准 |
| AC7 | 登出清除 Cookie（`Max-Age=0`）并撤销 session，覆盖两种前置：(a) Bearer 有效；(b) **access 已过期、Cookie 有效**——两种情况下 logout 都必须清 Cookie，且随后刷新返回 401；其他标签在 N 秒内切到登录页或下一次请求被动登出 | 双标签 + 网络断言；用短 access TTL 制造 (b)，断言响应仍含 `Set-Cookie ... Max-Age=0` 且 session 被撤销 |
| AC8 | 旧客户端兼容（按 §3 矩阵逐行）：body 源 current 刷新返回 200 + **新签发** refresh；body 源 previous（宽限内）回显请求值；已有 Cookie + body current/previous 返回 200 且 `body.refreshToken === 请求值`（**不是**新签发），旧页面不写入 `"undefined"`；已有 Cookie + 假 body 的响应无 `refreshToken`；新客户端在缺少 `refreshCookie` 时回退 `localStorage` 且不出现刷新死循环 | 保留现有 e2e/探针，新增旧服务端/旧客户端矩阵 |
| AC9a | 迁移分支「标记真」：新服务端 + Cookie 可用；首次加载一次无 body 刷新成功 → 删除遗留 `orca.access`/`orca.refresh`，之后不再发 body refresh | 预置旧键 + 真实 Chromium；断言一次无 body 刷新、旧键被删 |
| AC9b | 迁移分支「未知 + 旧键」：无 body 探测失败后恰好一次 body 刷新成功——标记缺失（旧服务端）→ 保留旧键并继续 `localStorage`，QA-032 保持未关闭；标记为真 → 切换 Cookie-only 且保留旧键，下一次无 body 刷新成功后才删除 | 旧服务端/新服务端夹具；断言 1 次无 body + 1 次 body、键的删除时点 |
| AC9c | 迁移分支「无旧键」：无 `localStorage` 令牌，仅 Cookie 可用 → 一次无 body 刷新进入应用；Cookie 缺失 → 一次失败后登录，不重复刷新 | Playwright 清空 localStorage；请求计数 |
| AC9d | 迁移分支「失败」：无 body 与 body 回退均失败 → 旧键保留、页面登录、一次加载内不超过 1 次无 body + 1 次 body 刷新 | 失效旧 refresh 夹具；请求计数 + 键存在断言 |
| AC10 | 纵深（若同批落地）：静态响应含 `Content-Security-Policy`，`script-src 'self'`，页面无脚本违规；样式如需 `unsafe-inline` 必须在设计里显式记录 | 响应头 + `securitypolicyviolation` 监听 |
| AC11 | XSS 直接调刷新接口拿不到 refresh（P0-1，三档）：页面内注入脚本以 `credentials:'same-origin'` 发起刷新——(a) `body:'{}'`：响应 JSON 无 `refreshToken`；(b) `body:'{"refreshToken":"fake-not-a-session-token"}'`：仍无 `refreshToken`；(c) body 带有效 previous：响应 `refreshToken === 请求的 previous`，且**不等于** session 当前 current（不泄露 current、不返回新 token） | 注入探针断言响应体键集合；服务端同进程用 `ApiHandle.store` 校验 current/previous，确保 (c) 回显的是请求值 |
| AC12 | Cookie 丢失回退不死循环（P1-2，覆盖 AC9c/AC9d 的无旧键与失败分支）：手动删除 refresh Cookie 后触发刷新，前端只发起 1 次刷新，失败后清内存 access 并回登录页；若存在旧键，最多再回退 1 次 body 刷新 | Playwright 请求计数 + 页面可见性 |
| AC13 | 失败路径副作用（P2）：`SESSION_EXPIRED` 响应清 Cookie；CSRF 403 不清 Cookie、不撤销 session；登出清 Cookie（`Max-Age=0`） | 响应头 + Cookie jar 检查，三者在同一矩阵 |
| AC14 | 页内 401（reload 之外，P1-3）：access 过期后在当前页触发一次业务请求，前端恰好发起一次 Cookie 刷新并重放成功，页面保持登录；不出现第二次自动刷新 | 短 access TTL + Playwright 网络计数；不调用 `reload()` |

多标签口径：Cookie 源不轮换，断言哈希不变且无 `SESSION_EXPIRED`；body 源旧客户端断言 current 哈希最多前进一次。宽限只允许中间态短暂存在。

TTL 注入口径（P2）：`ORCA_CLOUD_ACCESS_TTL_MS` 只用于缩短 access TTL（`server.ts:6559`，AC2）；refresh TTL 用 `ORCA_CLOUD_REFRESH_TTL_MS`（`server.ts:6560`，默认 `REFRESH_TTL_MS` 于 `server.ts:129`），不得复用 access 变量，避免把“刷新恢复”与“refresh 过期”混为一谈。AC12 的 Cookie 丢失用例也不得通过改 TTL 模拟。

---

## 5. 待决策（重切为 6 项，互不重叠）

1. **B 推进与 SSO 路线**：确认方案 B 为关闭 QA-032 的唯一路径；本周期不能改服务端时，A 只作临时缓解且 QA-032 保持未关闭。未来 SSO 是否按 Cookie 承载设计（若是，B 为前置约束）。
2. **响应形态判别口径**（P0-1/P0-2 规则已定，不再开放）：current/previous 判定用常量时间哈希比较的实现归属；假 body 命中时是否新增 `refresh.body_rejected` 审计；回显值是否进入访问日志的脱敏检查。不得改变「Cookie 源绝不新签、仅原样回显」的结论。
3. **Cookie 属性、生命周期与降级**：确认默认名 `orca_refresh`、`Path=/v1/auth`、`SameSite=Lax`、`Max-Age=refresh TTL`；是否改用会话 Cookie（关闭浏览器即结束）；`ORCA_CLOUD_COOKIE_MODE=auto` 在非 loopback 纯 http 下告警后是否放行。
4. **grace 与审计**：默认 `graceMs=30_000`、上限 `60_000` 是否接受，生产是否允许 `0`；`refresh.grace_reuse` / `refresh.reuse_detected` 的审计目录与告警阈值；多标签登出是否用 `BroadcastChannel` 即时切换（否则接受下一次请求被动登出）。
5. **迁移、回退与 body 移除**：四分支状态机是否按 §2B 执行；新 Web + 旧服务端回退 `localStorage` 是否接受（该组合下 QA-032 保持未关闭）；回滚顺序固定为 Web 先、服务端后；body refresh 移除是否接受「遥测 30/14 天 + 90 天期限兜底」与强制旧标签重登。
6. **部署前置、CSP 与关闭范围**：TLS、反向代理的 Host/`X-Forwarded-Proto`、`ORCA_CLOUD_PUBLIC_ORIGIN` 的配置责任；多副本必须粘性会话或共享 store；CSP 是否与 B 同批（`style-src 'unsafe-inline'` 为过渡豁免）；宿主跨源 handoff 的 Cookie 不生效是否接受为当前限制；QA-032 关闭只认平台同源 Cookie-only 刷新，TTL 缩短、`orca.user` PII、宿主 `orca.webCloudSession` 均不纳入关闭条件。
