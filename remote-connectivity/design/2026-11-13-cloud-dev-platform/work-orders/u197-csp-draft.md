# U197 S6：Web 控制台 CSP 草稿

- 状态：草稿，仅决策支持；不含实现，不改台账/协议。
- 日期：2026-11-18。基线：已提交 HEAD（不引用 U222 未提交改动）。
- 上游：[`u197-token-storage-design.md`](./u197-token-storage-design.md) v5 §2C；缺陷台账 U200（`defect-ledger.md:209`）；待裁定 D10（`pending-decisions-2026-11-17.md:186`）。
- 范围：`cloud-platform/apps/web`（平台管理控制台）与 `cloud-platform/apps/api` 的静态响应头。宿主侧 `cloud-admin.html` / `web-index.html` 不在本稿范围（见 §6-O5）。

## 1. 资产盘点（现状事实）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 内联 `<script>` / `<style>` | 无。唯一脚本是外部 module，唯一样式是外部 CSS | `index.html:8` `<link rel="stylesheet" href="/styles.css">`；`index.html:200` `<script type="module" src="/app.js">` |
| 内联事件属性 | 仅 1 处：`onclick="location.reload()"` | `app.js:1942`（`rg '[[:space:]]on[a-z]+="'` 在 `app.js`/`router/routes.js` 仅此一条；`index.html` 命中项为 `aria-controls`/`viewport-fit`，非事件属性） |
| 内联 `style="..."` 属性 | 16 处（`index.html` 为 0）；无 `<style>` 标签 | `app.js:1940, 2163, 2171, 2576, 2580, 2995, 3276, 4591, 4592, 4593, 4609, 4610, 4611, 4612, 4613, 4616` |
| `innerHTML` 注入点 | 37 处（台账 U200 口径），全部人工 `esc()`，无 `insertAdjacentHTML` | `defect-ledger.md:209`；`esc()` 定义 `app.js:42-48`；`insertAdjacentHTML` 检索为空 |
| 动态代码 | 无 `eval` / `new Function` / 字符串 `setTimeout` / `document.write` / 动态 `<script>` | 全目录检索为空 |
| `data:` / `blob:` | 仅 favicon 的 `data:,`；无 `Blob`/`URL.createObjectURL` | `index.html:7` |
| 同源 API | 全部 `fetch` 为相对路径，无绝对 base | `app.js:57-73`（`api()`）、`:109`、`:135`、`:4900`、`:4949` |
| WebSocket / SSE | 控制台自身没有；`wss://` 只出现在平台下发给宿主/中继的数据里 | `apps/web` 检索 `new WebSocket|EventSource` 为空；`server.ts:2931, 6766` 为宿主节点 URL |
| iframe | 项目工作区覆盖层：跨源 `iframe.src = url`，源自 `/v1/projects/:id/web-handoff` | `app.js:1424-1430`；URL 为 `https://<browserHost>/.../cloud-admin.html`（`server.ts:2950, 2998, 6595`）或 `https://<addr>/cloud-admin.html`（`server.ts:2988-2998`）；postMessage 握手 `app.js:1450-1451, 1496, 1506, 1552` |
| 弹出窗口 | `window.open(..., '_blank', 'noopener')`，属顶层导航，不受 `frame-src` 约束 | `app.js:1271, 1284` |
| 下载/导出 | 同源 `<a download>`，token 在 URL；无 blob | `app.js:4098-4115`（U201 E12）；导出响应 `server.ts:6158` |
| 表单 | 登录表单无 `action`，由 JS `onsubmit` 接管 | `index.html:14`；`app.js:5037` |
| 现状 CSP | 完全没有。静态/JSON 共享头只有 `referrer-policy` | `static-delivery.ts:15-17`；JSON 复用 `server.ts:238-243`；导出复用 `server.ts:6158`；宿主镜像同样只有 referrer：`src/main/runtime/rpc/static-web-response.ts:1-10` |

### 是否阻塞 `script-src 'self'`？

不阻塞。页面零内联脚本、零动态脚本，资源均在 `/assets/<build>/` 同源加载（`web-release.ts:66-124`，HTML 入口重写为带哈希的 `assetPath`）。唯一需要处理的是 `app.js:1942` 的 1 处内联 `onclick`：

- 路径 A（保留 `'unsafe-inline'`）：零代码成本，但 `innerHTML` 注入的事件属性会重新可执行，脚本侧纵深基本失效。不推荐。
- 路径 B（重构）：改为 `data-action="reload"` + 一个委托 click 监听（或复用现有事件委托），约 3 行，成本 S。推荐；完成后 `script-src 'self'` 可保持严格。

样式侧则必须依赖 `style-src 'unsafe-inline'`（除非把 16 处内联 style 全部改为 class；成本 M，涉及 5 个渲染函数，建议另批）。

## 2. 候选 Report-Only 指令集

响应头（阶段 1）：

```
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
```

| 指令 | 值 | 依据 / 说明 |
| --- | --- | --- |
| `default-src` | `'self'` | 兜底；控制台只同源加载 JS/CSS/API |
| `script-src` | `'self'` | 外部 module + 同源 import（`app.js:3`）；无 `'unsafe-eval'` 需求。重构 `app.js:1942` 后无需 `'unsafe-inline'` |
| `style-src` | `'self' 'unsafe-inline'` | 16 处内联 style 属性；`styles.css` 同源。`'unsafe-inline'` 是过渡豁免，须在报告中登记（v5 §2C / AC10 口径）。CSSOM（`el.style.x =`）不受 CSP 限制，检索也未发现 `setAttribute('style')` |
| `img-src` | `'self' data:` | favicon 是 `data:,`（`index.html:7`）。v5 §2C 草案只写 `'self'`，将拦截 favicon，需补 `data:`；更严做法是换成同源图标后回到 `'self'` |
| `font-src` | `'self'` | 当前无 `@font-face`、无外链字体 |
| `connect-src` | `'self'` | 控制台只有同源 `fetch`；无 WebSocket/SSE |
| `frame-src` | `'self' https:` | **必须显式列出**。工作区覆盖层 iframe 指向宿主/中继的 `https://.../cloud-admin.html`，若沿用 v5 草案（只有 `default-src 'self'`）会被 `default-src` 回退拦截，直接打断「打开项目工作区」。`window.open` 新标签不受此约束 |
| `frame-ancestors` | `'none'` | 控制台按顶层文档加载（浏览器/桌面视图/移动 WebView 均为顶层，非 frame）。`rg '<iframe|<webview' src/renderer/src mobile` 的命中均为文件预览/HTML 预览，未发现加载本控制台的 frame 宿主；若未来要嵌，须改此值 |
| `base-uri` | `'none'` | 无 `<base>`；比 v5 草案的 `'self'` 更严且无成本 |
| `form-action` | `'self'` | 登录表单无 `action`，JS 接管；`'self'` 保留无 JS 时的同源回退 |
| `object-src` | `'none'` | 无 `<object>`/`<embed>` |

不引入：`'strict-dynamic'`（无动态脚本创建）、`'unsafe-eval'`（无 eval）、`worker-src`/`manifest-src`/`media-src`（无对应资产，走 `default-src 'self'`）。

## 3. 上报通道

现状：无任何 CSP 端点；`/v1/*` 还受 Web 契约门禁（缺 `x-orca-web-contract` 会 426，`server.ts:3366-3375`），浏览器自动上报不会带该头。

| 方案 | 做法 | 代价 | 评价 |
| --- | --- | --- | --- |
| A. 仅 console（推荐起步） | Report-Only 头不带 `report-uri`；违规出现在 DevTools console，并触发 `securitypolicyviolation` 事件 | 0 服务端改动 | 满足真实 Chromium 验收门禁（Playwright 可收集）；无法观察真实用户 |
| B. 同源收集端点 | 新增 `POST /csp-report`（**不要放 `/v1/`**，否则被契约门禁 426）；限 8 KiB、免认证/Cookie、按 IP 限速，只记 `document-uri` 路径、指令名、屏蔽源 scheme/host，不记 token/Cookie | 中：1 路由 + 限速 + 脱敏 + 测试 | 仅在 D10 要求「真实用户观察期」时采用 |
| C. 外部 SaaS | 外部上报端点 | 数据外带、违反现有部署约束 | 拒绝 |

推荐：阶段 1 用 A；若 D10 要求生产观察，再上 B。任何报告内容不得包含令牌、Cookie、完整查询串。

## 4. 灰度 / 回滚

落点：只给 HTML 文档响应加头（入口 `index.html` 与文件系统 HTML 回退，`server.ts:6849-6888`），不要把 CSP 塞进 `STATIC_SECURITY_HEADERS` 而扩散到 JSON/JS/CSS/导出（v5 §2C：JSON 不带 CSP；JS/CSS 上的 CSP 无意义）。宿主侧镜像 `static-web-response.ts` 若也要加，必须同步。

| 阶段 | 动作 | 进入下一阶段的条件 |
| --- | --- | --- |
| 0 | 现状：无头 | — |
| 1 | Report-Only，仅 console，仅 HTML | 真实 Chromium 全流程零违规（§5 T2），连续 7 天或 2 个发布周期 |
| 2（条件） | Report-Only + 同源收集端点 | 违规计数归零且样本覆盖主要页面 |
| 3 | 强制 `Content-Security-Policy` | 阶段 1/2 达标 + Cookie 模式（D10 前置）已稳定 |

与 Cookie 模式的顺序：

- D10 要求 CSP 与 Cookie 模式同批以 Report-Only 起步（`pending-decisions-2026-11-17.md:186`）；Cookie 模式启用前必须先满足单副本/粘性会话、代理 Host/XFP、`ORCA_CLOUD_PUBLIC_ORIGIN` 等前置，且 D5–D10 已裁定（`defect-ledger.md:223`）。
- 推荐顺序：先上 CSP Report-Only（独立可回滚），再按 U197 的 S1–S5 序列启用 cookieMode，最后把 CSP 升为强制。不要把「CSP 强制」与「cookieMode 开启」压进同一个发布，否则回滚边界不清。
- 回滚：HTML 是 `no-cache`（`static-delivery.ts:10`），改回头常量下一次加载即生效，无需回退客户端产物。可选 `ORCA_CLOUD_CSP_MODE=off|report-only|enforce`（默认 off）以免重部署，但增加一个配置面；仅在确实需要「不重部署回滚」时采用。

## 5. 可测验收（真实 Chromium）

| # | 用例 | 断言 | 落点 |
| --- | --- | --- | --- |
| T1 | 头存在性与范围 | `GET /`、`/index.html` 带 `content-security-policy-report-only`（阶段 1）或 `content-security-policy`（阶段 3）；`/v1/*` JSON 不带 | 新增 in-process 断言 |
| T2 | 零违规主流程 | 登录 → 项目列表/详情 → 主机 → 用户 → 设置，收集 console 与 `securitypolicyviolation`，断言 0 条；Report-Only 与强制各跑一遍 | 复用 `test/e2e/u197-cookie-browser.e2e.test.ts`（Playwright chromium，`:9`, `:140`） |
| T3 | 下载/导出 | 走 `audit-export-download.e2e.test.ts` 同型流程；点 `#auditExportDownload`（`app.js:4103-4115`）后字节落盘，无违规；确认不依赖 blob | `test/e2e/audit-export-download.e2e.test.ts` |
| T4 | WebSocket | 控制台无 socket（检索为空）；打开工作区覆盖层，断言 iframe 变 `ready`、子文档自身的 WebSocket 不受父文档 `connect-src` 限制 | `app.js:1450-1461`；宿主侧既有工作区用例 |
| T5 | 跨源 handoff | `POST /v1/projects/:id/web-handoff` 后，跨源 iframe 加载并完成 `postMessage` 握手；**故意移除 `frame-src` 时此用例必须失败**（防回退到 `default-src 'self'`） | `app.js:1424-1461`；`server.ts:2950, 2998` |
| T6 | favicon / data: | `img-src` 含 `data:` 时 favicon 无违规；若改同源图标则移除 `data:` 仍无违规 | `index.html:7` |

报告收集：Playwright `page.on('console')` + `addInitScript` 监听 `securitypolicyviolation`，把 `violatedDirective`/`blockedURI` 纳入失败信息。

## 6. 未决（关联 D10）

- **O1 脚本内联豁免**：`app.js:1942` 重构（推荐）还是保留 `script-src 'unsafe-inline'`（削弱纵深）。决定前不得宣称脚本 CSP 已生效。
- **O2 样式内联豁免**：16 处 style 属性保留 `'unsafe-inline'` 的期限与移除责任；必须登记，防止永久化（U200）。
- **O3 `frame-src` 策略**：`https:` 方案源 vs 中继 `browserHost` 动态白名单。前者允许任意 https 子框架；后者需要按请求生成头并处理缓存/Vary。Report-Only 可先用 `https:`，强制前裁定。
- **O4 上报通道**：是否加 `/csp-report`、保留期、脱敏口径；若加，必须绕开 `/v1` 契约门禁。
- **O5 覆盖边界**：宿主服务的 `cloud-admin.html` / `web-index.html` 是独立文档，控制台 CSP 不保护它们；U200 的「Web 无 CSP」在强制后仍部分成立。
- **O6 CSP 不是 XSS 修复**：37 处 `innerHTML` 仍依赖人工 `esc()`；强制 CSP 只降低事件属性/外链脚本的利用面，不能单独关闭 QA-032。
- **O7 双份静态策略**：`static-delivery.ts` 与 `src/main/runtime/rpc/static-web-response.ts` 注释要求保持一致；只改一侧会让两个服务面分叉。

### 待验证（含验证命令）

1. 本地 http 宿主是否存在 handoff 路径（决定 `frame-src` 是否需 `http:`）。`rg -n "https://\\$\\{(addr|edge)" cloud-platform/apps/api/src/server.ts`，并用 §5 T5 在本地两种部署下实跑。
2. `frame-ancestors 'none'` 是否有实际嵌入方。`rg -n "<iframe|<webview" src/renderer/src mobile --glob '!**/*.test.*'`，逐个确认加载 URL 是否为控制台（当前命中均为文件/HTML 预览）。
3. Chromium 对 `link rel=icon` 的 `img-src` 执行行为。按 §5 T6 实跑确认。
4. `style-src 'unsafe-inline'` 移除后的真实违规数（当前 16 处静态属性之外，是否还有 `setAttribute('style')` 或第三方代码）。`rg -n "setAttribute\\('style'" cloud-platform/apps/web`。
