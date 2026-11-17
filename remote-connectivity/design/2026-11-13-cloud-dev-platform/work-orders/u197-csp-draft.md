# U197 S6：Web 控制台 CSP 草稿

- 状态：草稿，仅决策支持；不含实现，不改台账/协议。
- 日期：2026-11-18。基线：已提交 HEAD（不引用 U222 未提交改动）。
- 修订：v2（2026-11-18，U224 独立评审）：修正契约门禁事实（§3）、写头落点（§4）、宿主镜像位置（§1/§6）、`innerHTML` 计数（§1/§6）、iframe 源（§1/§5）、T3 用例、内联 `onclick` 门禁时序、样式收窄备选、UIR、上报报文形态与 D10 排序建议。
- 上游：[`u197-token-storage-design.md`](./u197-token-storage-design.md) v5 §2C；缺陷台账 U200（`defect-ledger.md:209`）；待裁定 D10（`pending-decisions-2026-11-17.md:186`）。
- 范围：`cloud-platform/apps/web`（平台管理控制台）与 `cloud-platform/apps/api` 的静态响应头。宿主侧 `cloud-admin.html` / `web-index.html` 不在本稿范围（见 §6-O5）。

## 1. 资产盘点（现状事实）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 内联 `<script>` / `<style>` | 无。唯一脚本是外部 module，唯一样式是外部 CSS | `index.html:8` `<link rel="stylesheet" href="/styles.css">`；`index.html:200` `<script type="module" src="/app.js">` |
| 内联事件属性 | 仅 1 处：`onclick="location.reload()"` | `app.js:1942`（`rg '[[:space:]]on[a-z]+="'` 在 `app.js`/`router/routes.js` 仅此一条；`index.html` 命中项为 `aria-controls`/`viewport-fit`，非事件属性） |
| 内联 `style="..."` 属性 | 16 处（`index.html` 为 0）；无 `<style>` 标签 | `app.js:1940, 2163, 2171, 2576, 2580, 2995, 3276, 4591, 4592, 4593, 4609, 4610, 4611, 4612, 4613, 4616` |
| `innerHTML` 注入点 | 38 处 `.innerHTML =` 赋值（台账 U200 的 37 为旧口径；另 1 处仅注释提及 `app.js:3017`）；用户字段走 `esc()`，但 `p.id`/`h.id` 等标识符裸插值；无 `insertAdjacentHTML` | `defect-ledger.md:209`；`esc()` 定义 `app.js:42-48`；裸插值示例 `app.js:902, 955, 2336`；`insertAdjacentHTML` 检索为空 |
| 动态代码 | 无 `eval` / `new Function` / 字符串 `setTimeout` / `document.write` / 动态 `<script>` | 全目录检索为空 |
| `data:` / `blob:` | 仅 favicon 的 `data:,`；无 `Blob`/`URL.createObjectURL` | `index.html:7` |
| 同源 API | 全部 `fetch` 为相对路径，无绝对 base | `app.js:57-73`（`api()`）、`:109`、`:135`、`:4900`、`:4949` |
| WebSocket / SSE | 控制台自身没有；`wss://` 只出现在平台下发给宿主/中继的数据里 | `apps/web` 检索 `new WebSocket|EventSource` 为空；`server.ts:2931, 6766` 为宿主节点 URL |
| iframe | 项目工作区覆盖层：跨源 `iframe.src = url`，源**仅**来自 `/v1/projects/:id/web-handoff` 的响应 `url` | `app.js:1424-1430`；handoff 构造 `server.ts:6591-6595`（`entry` 与回退均硬编码 `https://`），最终 URL `:6604-6605`；`:2950` 是中继入口候选、`:2988-2998` 是主机详情链接，**不是 iframe 源**；postMessage 握手 `app.js:1450-1451, 1496, 1506, 1552` |
| 弹出窗口 | `window.open(..., '_blank', 'noopener')`，属顶层导航，不受 `frame-src` 约束 | `app.js:1271, 1284` |
| 下载/导出 | 同源 `<a download>`，token 在 URL；无 blob | `app.js:4098-4115`（U201 E12）；导出响应 `server.ts:6158` |
| 表单 | 登录表单无 `action`，由 JS `onsubmit` 接管 | `index.html:14`；`app.js:5037` |
| 现状 CSP | 完全没有。静态/JSON 共享头只有 `referrer-policy` | `static-delivery.ts:15-17`；JSON 复用 `server.ts:238-243`；导出复用 `server.ts:6158`；宿主侧 `src/main/runtime/rpc/static-web-response.ts:1-10` 只是常量，实际写头在 `src/main/runtime/rpc/static-web-client-handler.ts:47`（仅 `Referrer-Policy`） |

### 是否阻塞 `script-src 'self'`？

不阻塞。页面零内联脚本、零动态脚本，资源均在 `/assets/<build>/` 同源加载（`web-release.ts:66-124`，HTML 入口重写为带哈希的 `assetPath`）。唯一需要处理的是 `app.js:1942` 的 1 处内联 `onclick`：

- 路径 A（保留 `'unsafe-inline'`）：零代码成本，但 `innerHTML` 注入的事件属性会重新可执行，脚本侧纵深基本失效。不推荐。
- 路径 B（重构）：改为 `data-action="reload"` + 一个委托 click 监听（或复用现有事件委托），约 3 行，成本 S。推荐；完成后 `script-src 'self'` 可保持严格。

实测该 `onclick` 的违规只在**点击时**产生（违反 `script-src-attr`，`blockedURI:"inline"`），页面加载不点击则不产生报告。因此 Report-Only 的「零违规」不会自动覆盖它：阶段 1 退出门禁必须先完成上述 3 行重构，或在 T2 中显式点击刷新按钮后再断言零违规（§5）。

样式侧建议收窄为 `style-src 'self'; style-src-attr 'unsafe-inline'`：只豁免 16 处 `style="..."` 属性，仍阻止注入 `<style>`/非同源样式；整段 `style-src 'self' 'unsafe-inline'` 保留为退路（不支持 `style-src-attr` 的浏览器会回退到 `style-src`，属性将被拦截，故以真实 Chromium 验收为准）。若把 16 处内联 style 全部改为 class，成本 M（涉及 5 个渲染函数），建议另批；CSSOM（`el.style.x =`）不受 CSP 限制。

## 2. 候选 Report-Only 指令集

响应头（阶段 1）：

```
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
```

| 指令 | 值 | 依据 / 说明 |
| --- | --- | --- |
| `default-src` | `'self'` | 兜底；控制台只同源加载 JS/CSS/API |
| `script-src` | `'self'` | 外部 module + 同源 import（`app.js:3`）；无 `'unsafe-eval'` 需求。重构 `app.js:1942` 后无需 `'unsafe-inline'`；该属性的违规仅在点击时触发（§1） |
| `style-src` | `'self' 'unsafe-inline'`（退路）；建议收窄为 `'self'` + `style-src-attr 'unsafe-inline'` | 16 处内联 style 属性；`styles.css` 同源。收窄版只豁免属性、仍阻止注入 `<style>`；不支持 `style-src-attr` 的浏览器回退到 `style-src` 会拦截属性，故以 Chromium 验收为准。`'unsafe-inline'` 是过渡豁免，须在报告中登记（v5 §2C / AC10 口径）。CSSOM（`el.style.x =`）不受 CSP 限制，检索也未发现 `setAttribute('style')` |
| `img-src` | `'self' data:` | favicon 是 `data:,`（`index.html:7`）。v5 §2C 草案只写 `'self'`，将拦截 favicon，需补 `data:`；更严做法是换成同源图标后回到 `'self'` |
| `font-src` | `'self'` | 当前无 `@font-face`、无外链字体 |
| `connect-src` | `'self'` | 控制台只有同源 `fetch`；无 WebSocket/SSE |
| `frame-src` | `'self' https:` | **必须显式列出**。工作区覆盖层 iframe 指向宿主/中继的 `https://.../cloud-admin.html`，若沿用 v5 草案（只有 `default-src 'self'`）会被 `default-src` 回退拦截，直接打断「打开项目工作区」。`window.open` 新标签不受此约束 |
| `frame-ancestors` | `'none'` | 控制台按顶层文档加载（浏览器/桌面视图/移动 WebView 均为顶层，非 frame）。`rg '<iframe|<webview' src/renderer/src mobile` 的命中包括：文件/PDF/notebook 预览（`html-file-renderer.tsx:22`、`pdf-file-renderer.tsx:31`、`IpynbHtmlOutput.tsx:35`）、移动 HTML 预览（`MobileHtmlPreview.web.tsx:138`）、聊天视觉帧（`MobileNativeChatVisualFrame.web.tsx:37`）、插件壳 srcdoc（`PluginPanel.tsx:220`，`sandbox="allow-scripts"`）与桌面浏览器面板 `<webview>`（可加载任意 URL 的 guest）；未发现显式加载本控制台的 frame 宿主。若未来要嵌，须改此值 |
| `base-uri` | `'none'` | 无 `<base>`；比 v5 草案的 `'self'` 更严且无成本 |
| `form-action` | `'self'` | 登录表单无 `action`，JS 接管；`'self'` 保留无 JS 时的同源回退 |
| `object-src` | `'none'` | 无 `<object>`/`<embed>` |

不引入：`'strict-dynamic'`（无动态脚本创建）、`'unsafe-eval'`（无 eval）、`worker-src`/`manifest-src`/`media-src`（无对应资产，走 `default-src 'self'`）。**故意不引入 `upgrade-insecure-requests`**：现有部署包含 http loopback（本地/测试），该指令会把同源资源升级到 https 而失败；待部署仅剩 https 时再评估。

## 3. 上报通道

现状：无任何 CSP 端点。`/v1/*` 有 Web 契约门禁（`server.ts:3365-3380`），但 `checkWebContract` 对**缺失**头返回 ok（`web-contract.ts:29-33`），只有「带头但非法/低于 min/高于 max」才 426；浏览器自动上报虽不带该头，实测不会被 426。上报端点仍放 `/v1/` 外，理由是它不属于版本化前端契约、且需免认证/免 Cookie，避免未来门禁语义收紧时被误伤。验证：拟新增单测断言 `checkWebContract(null)` 等于 `{ ok: true, offered: WEB_CONTRACT_VERSION }`（现有 `test/e2e/web-release.e2e.test.ts:105-107` 已覆盖同语义：无头请求 401 而非 426）；`/v1/__csp_probe` 为拟新增探针，预期 404（未知 `/v1/` POST 落到 `server.ts:6483`），例如 `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:<port>/v1/__csp_probe`。

| 方案 | 做法 | 代价 | 评价 |
| --- | --- | --- | --- |
| A. 仅 console（推荐起步） | Report-Only 头不带 `report-uri`；违规出现在 DevTools console，并触发 `securitypolicyviolation` 事件。注意内联 `onclick` 只在点击时报告（§1/T2） | 0 服务端改动 | 满足真实 Chromium 验收门禁（Playwright 可收集）；无法观察真实用户 |
| B. 同源收集端点 | 新增 `POST /csp-report`（放 `/v1/` 外：非版本化前端契约且需免认证；虽实测无头 POST 不触发 426，仍避免语义耦合）。先定报文格式（见下）；限 8 KiB、免认证/Cookie、按 IP 限速，只记 `document-uri` 路径、指令名、屏蔽源 scheme/host，不记 token/Cookie | 中：1 路由 + 限速 + 脱敏 + 测试 | 仅在 D10 要求「真实用户观察期」时采用 |
| C. 外部 SaaS | 外部上报端点 | 数据外带、违反现有部署约束 | 拒绝 |

若采用 B，先选定报文格式（二选一，或同时声明并同时解析）：

- `report-uri /csp-report`（已弃用，Chromium 仍工作）：无需额外响应头；浏览器 `POST`，`Content-Type: application/csp-report`，body 形如 `{"csp-report":{"document-uri":"...","referrer":"","violated-directive":"script-src-attr","effective-directive":"script-src-attr","original-policy":"...","blocked-uri":"inline","status-code":200}}`。成本最低，建议作为观察期首选。
- `report-to csp-endpoint` + 响应头 `Reporting-Endpoints: csp-endpoint="https://<console-origin>/csp-report"`（同源绝对 URL）：浏览器 `POST`，`Content-Type: application/reports+json`，body 是数组，元素形如 `[{"type":"csp-violation","url":"...","body":{"documentURL":"...","blockedURL":"inline","effectiveDirective":"script-src-attr","originalPolicy":"..."}}]`。面向新标准；若同时保留 `report-uri`，端点需按 `Content-Type` 分流解析。

两者都不改变阶段 1 方案 A。

推荐：阶段 1 用 A；若 D10 要求生产观察，再上 B。任何报告内容不得包含令牌、Cookie、完整查询串。

## 4. 灰度 / 回滚

落点：在 `static-delivery.ts:121-152` 的 `sendStaticAsset` 增加可选 policy 参数，仅对入口 `index.html`/`.html` 文档注入；`serveStatic` 的两处调用——release 入口 `server.ts:6868-6874`（`isEntry`）与文件系统回退 `server.ts:6880-6886`——把 policy 传进去。`server.ts:6849` 只是 `serveStatic` 定义（调用方），不是写头位置。**不得**把 CSP 放进 `STATIC_SECURITY_HEADERS`（`static-delivery.ts:15-17`）：该常量被 JSON（`server.ts:238-243`）与导出（`server.ts:6158`）继承，加进去会扩散到所有静态/JSON/导出响应（v5 §2C：JSON 不带 CSP；JS/CSS 上的 CSP 无意义）。注意回退调用把所有文件都标成 `text/html`（`server.ts:6882`），判定应以 `isEntry || name.endsWith('.html')` 为准，不能只看 contentType。

宿主侧：`src/main/runtime/rpc/static-web-response.ts:1-10` 只有常量，实际写头在 `static-web-client-handler.ts:47`；若宿主面也要加，需在该处单独实现并做独立策略评估（O5/O7），不得照抄控制台策略。

| 阶段 | 动作 | 进入下一阶段的条件 |
| --- | --- | --- |
| 0 | 现状：无头 | — |
| 1 | Report-Only，仅 console，仅 HTML | **先完成 `app.js:1942` 的 3 行重构**（或 T2 显式点击刷新按钮后再断言），且真实 Chromium 全流程零违规（§5 T2），连续 7 天或 2 个发布周期 |
| 2（条件） | Report-Only + 同源收集端点 | 违规计数归零且样本覆盖主要页面 |
| 3 | 强制 `Content-Security-Policy` | 阶段 1/2 达标 + Cookie 模式（D10 前置）已稳定 |

与 Cookie 模式的顺序：

- D10 要求 CSP 与 Cookie 模式同批以 Report-Only 起步（`pending-decisions-2026-11-17.md:186`）；Cookie 模式启用前必须先满足单副本/粘性会话、代理 Host/XFP、`ORCA_CLOUD_PUBLIC_ORIGIN` 等前置，且 D5–D10 已裁定（`defect-ledger.md:223`）。**本稿建议 CSP Report-Only 先于 cookieMode 启用，与 D10「同批」措辞不同，属建议修订，供裁定。**
- 推荐顺序：先上 CSP Report-Only（独立可回滚），再按 U197 的 S1–S5 序列启用 cookieMode，最后把 CSP 升为强制。不要把「CSP 强制」与「cookieMode 开启」压进同一个发布，否则回滚边界不清。
- 回滚：HTML 是 `no-cache`（`static-delivery.ts:10`），改回头常量下一次加载即生效，无需回退客户端产物。可选 `ORCA_CLOUD_CSP_MODE=off|report-only|enforce`（默认 off）以免重部署，但增加一个配置面；仅在确实需要「不重部署回滚」时采用。

## 5. 可测验收（真实 Chromium）

| # | 用例 | 断言 | 落点 |
| --- | --- | --- | --- |
| T1 | 头存在性与范围 | `GET /`、`/index.html` 带 `content-security-policy-report-only`（阶段 1）或 `content-security-policy`（阶段 3）；`/v1/*` JSON 不带 | 新增 in-process 断言 |
| T2 | 零违规主流程（含内联 onclick） | 登录 → 项目列表/详情 → 主机 → 用户 → 设置，**并显式点击刷新按钮**（`app.js:1942` 未重构时）或先完成 3 行重构；收集 console 与 `securitypolicyviolation`，断言 0 条；Report-Only 与强制各跑一遍 | 复用 `test/e2e/u197-cookie-browser.e2e.test.ts`（in-process Playwright chromium：`before` 中 launch、跨用例复用；`:9`, `:140`） |
| T3 | 下载/导出 | 在 resident Playwright 中走「能力探测 → 确认 → POST → 轮询 → 下载」全流程；点 `#auditExportDownload`（`app.js:4103-4115`）后字节落盘，无违规；确认不依赖 blob | `cloud-platform/test/e2e/web-audit-export-browser.e2e.test.ts`（resident Playwright + headless Chromium；`audit-export-download.e2e.test.ts` 是 node:test 进程内用例，不是浏览器测试） |
| T4 | WebSocket | 控制台无 socket（检索为空）；打开工作区覆盖层，断言 iframe 变 `ready`、子文档自身的 WebSocket 不受父文档 `connect-src` 限制 | `app.js:1450-1461`；宿主侧既有工作区用例 |
| T5 | 跨源 handoff | `POST /v1/projects/:id/web-handoff` 后，跨源 iframe 加载并完成 `postMessage` 握手；**故意移除 `frame-src` 时此用例必须失败**（防回退到 `default-src 'self'`） | `app.js:1424-1461`；iframe 源仅 `server.ts:6591-6595`（`:2950` 是中继入口、`:2998` 是主机详情链接，非 iframe 源） |
| T6 | favicon / data: | `img-src` 含 `data:` 时 favicon 无违规；若改同源图标则移除 `data:` 仍无违规 | `index.html:7` |

报告收集：Playwright `page.on('console')` + `addInitScript` 监听 `securitypolicyviolation`，把 `violatedDirective`/`blockedURI` 纳入失败信息。

## 6. 未决（关联 D10）

- **O1 脚本内联豁免**：`app.js:1942` 重构（推荐）还是保留 `script-src 'unsafe-inline'`（削弱纵深）。该 `onclick` 只在点击时产生 `script-src-attr`/`blockedURI:"inline"` 违规，阶段 1 退出门禁必须先完成 3 行重构，或在 T2 显式点击刷新按钮。决定前不得宣称脚本 CSP 已生效。
- **O2 样式内联豁免**：16 处 style 属性保留 `'unsafe-inline'` 的期限与移除责任；必须登记，防止永久化（U200）。建议先收窄为 `style-src-attr 'unsafe-inline'`（只豁免属性，仍阻止注入 `<style>`），整段 `style-src 'self' 'unsafe-inline'` 作为不支持 `style-src-attr` 的浏览器的退路，并以真实 Chromium 验收。
- **O3 `frame-src` 策略**：`https:` 方案源 vs 中继 `browserHost` 动态白名单。前者允许任意 https 子框架；后者需要按请求生成头并处理缓存/Vary。Report-Only 可先用 `https:`，强制前裁定。
- **O4 上报通道**：是否加 `/csp-report`、保留期、脱敏口径。端点放 `/v1/` 外的理由是「非版本化前端契约 + 需免认证」，不是「否则 426」（缺失 `x-orca-web-contract` 时 `checkWebContract` 返回 ok，见 §3）。若加，先定 `report-uri`（`application/csp-report`，Chromium 仍工作）还是 `report-to` + `Reporting-Endpoints`（`application/reports+json`），并按选定格式解析。
- **O5 覆盖边界**：宿主服务的 `cloud-admin.html` / `web-index.html` 是独立文档，控制台 CSP 不保护它们；宿主面是 React 构建并加载 `wasm/`、`standard_fonts/`、`cmaps/`（`static-web-client-handler.ts:18`），需单独策略评估，**禁止照抄控制台策略**。U200 的「Web 无 CSP」在强制后仍部分成立。
- **O6 CSP 不是 XSS 修复**：38 处 `.innerHTML =` 赋值中用户字段走人工 `esc()`，但 `p.id`/`h.id` 等标识符裸插值（`app.js:902, 955, 2336`）；强制 CSP 只降低事件属性/外链脚本的利用面，不修复 DOM 注入，不能单独关闭 QA-032。
- **O7 双份静态策略**：`static-delivery.ts` 与 `src/main/runtime/rpc/static-web-response.ts` 的常量注释要求保持一致；但实际写头在 `static-web-client-handler.ts:47`，宿主面（React 构建、wasm/font/cmaps）需独立策略评估，禁止照抄控制台；只改一侧会让两个服务面分叉。

### 待验证（含验证命令）

1. ~~本地 http 宿主是否存在 handoff 路径（决定 `frame-src` 是否需 `http:`）~~ **已由代码确认：handoff 硬编码 `https://`（`server.ts:6591-6595`，含回退），无 http handoff；`frame-src` 不需要 `http:`**。保留 §5 T5 作回归，确认两种部署下握手仍成立。
2. `frame-ancestors 'none'` 是否有实际嵌入方。`rg -n "<iframe|<webview" src/renderer/src mobile --glob '!**/*.test.*'`，逐个确认加载 URL 是否��控制台（命中含文件/PDF/notebook 预览、移动 HTML 预览、聊天 srcdoc、插件壳与桌面 `<webview>` guest；未发现加载本控制台者）。强制前需实测 Electron `<webview>` guest 是否受 `frame-ancestors` 约束。
3. Chromium 对 `link rel=icon` 的 `img-src` 执行行为。按 §5 T6 实跑确认。
4. `style-src 'unsafe-inline'` 移除后的真实违规数（当前 16 处静态属性之外，是否还有 `setAttribute('style')` 或第三方代码）。`rg -n "setAttribute\\('style'" cloud-platform/apps/web`。
