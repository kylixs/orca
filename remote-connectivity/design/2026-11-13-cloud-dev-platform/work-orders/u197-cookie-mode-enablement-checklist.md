# U197 Cookie 模式启用检查单（D5–D10）

依据：`decisions-log-20261118.md` §1（D5–D10 接受项）。一行一个检查项，全部勾选后才可启用。

## 0. 启用范围（先确认，不做例外）

- [ ] 仅**平台控制台同源**启用：浏览器 `Origin` 规范化后**精确等于** `ORCA_CLOUD_PUBLIC_ORIGIN`。
- [ ] 宿主跨源 handoff 继续用 Bearer，响应保留 body `refreshToken`，不下发平台 Cookie（当前限制，接受）。
- [ ] 无 `Origin` 的脚本/非浏览器调用按非同源处理：不下发 Cookie，保留 body refresh。
- [ ] 不启用 `always`（本检查单只覆盖 `auto`）；`never` 仅用于排障/回退。

## 1. 四项前置（缺一不可）

- [ ] **TLS + 精确 origin**：`ORCA_CLOUD_PUBLIC_ORIGIN` 为 `https://` origin，无路径/末尾斜杠；生产非 loopback 必须 https。
- [ ] **会话落点**：单副本，或已配置粘性会话/共享 store；否则 refresh 会落到无 session 的副本（进程内存 store 是现状）。
- [ ] **CSP**：`Content-Security-Policy-Report-Only` 已观察满 7 天，或跨 2 个发布均为零违规（维持 Report-Only，不新增上报管道）。
- [ ] **发布顺序**：新 Web 先于服务端上线，或与本次服务端同批上线；不允许旧 Web 单独面对 Cookie 模式服务端。

## 2. 启用

- [ ] 服务端设置并重启：
  ```bash
  ORCA_CLOUD_PUBLIC_ORIGIN=https://<console-origin>
  ORCA_CLOUD_COOKIE_MODE=auto
  ```
- [ ] 启动日志确认无降级告警：缺 origin 时 `auto` 会降级 `never` 并告警；非 loopback 纯 http 会显式降级并告警。
- [ ] 用真实浏览器打开控制台，确认登录后 Cookie 存在且页面可刷新恢复。

## 3. 验证子集（服务端 + 真实浏览器）

- [ ] **AC3**：`Set-Cookie` 含 `HttpOnly`、`SameSite=Lax`、TLS 下 `Secure`、`Path=/v1/auth`；`document.cookie` 读不到 refresh。
- [ ] **AC6**：带有效 Cookie、`Origin: https://evil.example` 刷新返回 403，不轮换/不改 session；缺失或 `Origin: null` 同样 403；仅 body 刷新与宿主跨源 Bearer 不受影响；可信源只认 `ORCA_CLOUD_PUBLIC_ORIGIN`。
- [ ] **AC15**：平台同源登录/交接成功体**无** `refreshToken` 键、`refreshCookie === true`、含可用 `Set-Cookie`；宿主跨源 handoff 仍有新签 body `refreshToken` 且无 `refreshCookie`；无 `Origin` 调用不下发 Cookie；刷新 body 源 current 是唯一「Set-Cookie + 新签 body refresh」例外。
- [ ] **AC16**：伪造 `X-Forwarded-Proto`/`Host` 不改变同源判定，不降级为「非同源 + 新签 body refresh」；未配置 origin 时 `auto` 降级 `never` 并告警。
- [ ] **AC17**：同名重复/无法区分的 `orca_refresh` 硬 401，即使 body 带有效 current 也不轮换/不撤销；单个 Cookie 正常刷新；host-only 与 `Domain` 并存按各自属性清理后恢复。
- [ ] 记录验证时间、构建 SHA、浏览器版本与结果（附证据链接）。

## 4. 回退

回退顺序固定：**Web 先回退，再回退服务端**。禁止先回退服务端，否则已切换 Cookie-only 的页面无法恢复。

- [ ] 先回滚 Web 到旧构建（旧资源仍由归档服务提供），确认页面仍使用 body refresh。
- [ ] 再回退服务端，任选其一：
  ```bash
  ORCA_CLOUD_COOKIE_MODE=never
  # 或撤销 ORCA_CLOUD_PUBLIC_ORIGIN（auto 将降级 never）
  ```
- [ ] 若浏览器仍持有 `orca_refresh`，先登出（或 DevTools 删除）再验证。

### 回退后必须复验 body refresh

- [ ] 登录/交接/刷新响应均无 `Set-Cookie`、无 `refreshCookie`，登录/交接 body 含**新签** `refreshToken`。
- [ ] `POST /v1/auth/refresh` 仅带 body current 返回 200，响应含新签 `refreshToken` 并完成轮换。
- [ ] 页面刷新、access 过期后的 401 刷新路径均不循环、不掉线。
- [ ] 宿主跨源 handoff 仍工作（Bearer + body refresh 不受影响）。

## 5. 记录

- [ ] 启用/回退操作人、时间、环境、`ORCA_CLOUD_PUBLIC_ORIGIN`、构建 SHA 已写入变更记录。
- [ ] 若任一项验证失败：立即执行 §4 回退，并按 U197 台账登记缺口。
