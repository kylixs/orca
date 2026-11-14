# W7b 审计报告（web 消费与入口激活）

- 审计人：独立审计代理（只读；未改任何被审文件）
- 日期：2026-11-14
- 审计对象：`3d9a22b5f5f`（feat(cloud): one-time handoff auto-entry，12 文件 +1672/−95）；关连提交 `7d599e329d2`（docs(cloud) 提交内带入的 `apps/web/app.js` 控制台入口半部）
- 对照基准：work-orders-2026-11-14.md §W7b / §W7 / 附录「W7 设计要点」、requirements.md FR-3.10（FR-3.11 修订）、web-index-adaptation-plan.md §4.1/§4.4/§4.5/§5、test-plan.md M122 行、business-chain-tests.md §2（B1–B8）、AGENTS.md、w7a-audit.md（n-2/n-3 移交项）、w6b-audit（browserEntryUrl 健康门）
- 方法：只读 diff 审查 + HEAD 源码交叉验证（server.ts CORS 块/`isDirectAddrForm`/`browserEntryUrlFor`/`relay-nodes.isBrowserHostForm`/`issueDeviceSession`/`/connect` 设备绑定、web 侧 entry/connect/session/storage/auth 各模块）+ 实跑验证（见 §7）。行号基于当前 HEAD。

## 结论

**通过（带 1 项 CI 门禁整改 + 3 项 minor）**：blocker 0、major 1、minor 3、note 9。

CORS 是本提交新增的暴露面，结论是**设计正确、实现收紧**：白名单为「宿主 TLS 直连地址 ∪ 中继浏览器边缘」的精确匹配回显（无 wildcard、无 allow-credentials、失败分支零头部），`/v1/internal/*` 明确排除，预检方法/头与浏览器页面实际发送面完全一致；CORS 在此只决定「谁可读回复」，不新增任何鉴权旁路（Bearer 走 Authorization 头，跨站伪造请求因预检失败根本发不出去）。handoff 消费链与 w7a 移交项（n-2 入口选择、n-3 设备行）均已落实且方向正确；`webCloudSessionFromAuthReply`/`connectCloudProjectWithSession` 抽取对既有登录路径逐字等价，既有套件全绿。

唯一的 major 是**规格性而非安全性**：本提交新增代码触发 `pnpm run check:code-quality:changed`（pr.yml:257 CI 门禁）4 条 finding，PR 会在此被挡（j-1）。

## 1. CORS 安全（审计点①，重点）

### 1.1 白名单构造与回显

- 来源只有两处（server.ts:674-687 `browserPageOrigins`）：宿主 `directAddrs` 经 `isDirectAddrForm`（`^(\[[0-9A-Fa-f:]+\]|[^:[\]/?#\s]+)(?::\d{1,5})?$`，禁 scheme/path/空白/多余冒号）过滤后拼 `https://<addr>`；中继 `browserHost` 经 `relay-nodes.isBrowserHostForm`（`^[A-Za-z0-9.-]+(?::\d{1,5})?$`）入库，非法值在注册侧即被拒并留 warn（relay-nodes.ts:108-131）。两处都**不可能把 scheme/path/userinfo 注入 origin 串**，`https://` 前缀固定。
- 匹配是 **Set 精确匹配 + 回显请求 Origin 原文**（server.ts:689-694），永不 wildcard：即使宿主注册了 `*` 这类直连地址（isDirectAddrForm 允许），产出的 origin 串 `https://*` 浏览器永远不会发送，不构成通配放行。多值 Origin 头（Node 折叠为 `a, b`）、`Origin: null`、带空白的变体均不匹配 → fail-closed。
- CORS 只在「响应可读性」上放行，不改变鉴权：`requestJson`（web-cloud-request.ts:26-36）不设 `credentials`（默认 same-origin，跨站不带 cookie），令牌走 Authorization 头；非白名单 origin 的 POST 因 `content-type: application/json` 触发预检而**根本不会发出**，简单请求面只剩无凭据 GET（公开端点）。白名单 origin 的页面本身是平台/宿主分发的页面，信任级等同页面自身。
- 余项（note）：`browserPageOrigins` 用 `relayNodes.all()` 而非 `healthy()`（n-1）；`isDirectAddrForm` 允许任意 DNS 名与 `*`/`%` 等字符，宿主可把白名单扩到它不拥有的 origin（W7a m-2 的 CORS 侧延伸，内部威胁，n-2）。

### 1.2 `/v1/internal/*` 排除与既有防线

- `path.startsWith('/v1/internal/') ? null : corsAllowOriginFor(req)`（server.ts:880）：内部路由对**任何** origin（含白名单内）都不发 CORS 头；e2e 断言「白名单 origin 请求 `/v1/internal/relay-endpoint` OPTIONS 无 ACAO」。`/v1/internalfoo` 这类前缀近似路径不受排除影响（要求带尾斜杠），落回普通 `/v1/` 处理。
- 既有二层防线原样保留：配置 internalTls 后公共监听对非 relay-endpoint 内部路由仍 404（server.ts:899-907），CORS 块不触及该判定。OPTIONS 短路只对 `/v1/` 前缀统一回 204（含未知路径、未列 origin），无 ACAO 时浏览器按失败处理，且对所有路径行为一致，无存在性枚举信号。

### 1.3 预检最小化

`access-control-allow-methods: 'GET, POST, OPTIONS'`、`allow-headers: 'authorization, content-type'`、`max-age: 600`（server.ts:889-892）。核对发送面：`requestJson` 仅 GET/POST，头仅 content-type + authorization（web-cloud-request.ts:31-34）；宿主侧页面（web-index / cloud-admin workspace）经同一模块访问平台 REST，无 PUT/DELETE 调用（全仓核验：仅测试直连 harness 用 PUT）。方法/头与真实需求**一一对应**，无放权。web contract 头是可选的（`checkWebContract` 对缺失返回 ok，web-contract.ts），不进 allow-headers 是对的。无 `access-control-allow-credentials`——与「无 cookie、Bearer in header」的会话模型一致，浏览器也因此拒绝凭据型跨站调用。

### 1.4 错误响应与缓存

- CORS 头在路由分发前 `setHeader`（server.ts:880-886），之后所有 `json()`/`error()` 的 writeHead 都会携带——410/403/426 错误回复对白名单 origin 可读，正是回落提示读取 410/403 body 所必需；e2e 实测 410 带 ACAO。未列 origin 的错误回复零 CORS 头，traceId/message 不可被异源读取。
- `vary: Origin` 仅在放行分支设置。未放行分支的响应不带 ACAO 也不带 Vary：若被共享缓存串扰，最坏是「该带头的没带上」→ 浏览器拦截，方向 fail-closed；带头的响应有 Vary: Origin，按 origin 区分。预检回复的形状与 `Access-Control-Request-Method/-Headers` 无关（常量），只按 Origin 缓存即正确。

### 1.5 同源控制台零影响

- 控制台由平台自身伺服（同源），浏览器对同源请求不需要 CORS 头；平台 origin 不在白名单内（directAddrs 是宿主地址、browserHost 是中继边缘），因此同源 POST 即便携带 Origin 头也拿不到 ACAO——无行为差异。e2e 断言「无 Origin 头的请求零 CORS 头且 200」。极端重合（宿主直连地址恰好等于平台 origin）只是多带一个无害头部。
- 附带核验：控制台 `openOrcaWeb` 走同源 POST `/web-handoff` + `window.open(body.url,'_blank','noopener')`，URL 与签发响应同源同形（e2e W7b-button）；签发失败有 toast（QA-009 形态，e2e 断言）。

## 2. handoff 消费链（审计点②）

### 2.1 hash 清除时序

- `WebRoot` 的启动 `useMemo` 在**任何**取值前先 `readWebCloudHandoffEntry` → `clearWebHandoffFromAddressBar()`（main.tsx:39-46），`history.replaceState` 同步把 hash 抹掉、保留 `?api=`（search 是地址不是秘密，供回落表单预填）与 `/h/<route>/` pathname（W6c 前缀）。清除发生在任何 fetch、任何子资源、任何存储写入之前；换发失败路径 hash **不残留**（清除在前、换发在后，且单测断言 `window.location.hash === ''`）。
- main.tsx 未包 StrictMode，`useMemo` 无双调用导致「第二次读到空 hash、handoff 分支被跳过」的风险。启动 useMemo 带副作用（清除地址栏/清存储）沿袭该文件既有模式（`clearStoredWebRuntimeEnvironment` 同此）。
- 残余窗口＝页面首次字节到 React 首渲染之间 code 在地址栏/历史项可见——FR-3.10 设计固有（中继/宿主收不到 hash 段），plan §5 已如实声明。

### 2.2 `redeemWebHandoff` 与设备复用（w7a n-3 落实质量）

- 请求体 `{code, devicePubKey, deviceName:'Orca Web', deviceId?}`（web-cloud-session.ts:186-208）：`deviceId` 仅当「已存会话的 apiUrl 与本次入口一致」时携带（`readPersistedWebCloudSession` 按 normalizeApiUrl 匹配，handoff-entry.ts:168-175）——不会把 A 平台的设备行 id 送到 B 平台。
- 服务端复用语义（W7a 已核，此处复核调用面）：`issueDeviceSession` 只复用「属于本人且未吊销」的设备，否则忽略并新建（server.ts:597-606）；`/connect` 侧 `DEVICE_KEY_MISMATCH` 收口 E2EE 绑定（server.ts:2710-2712）。因此 w7a n-3 指出的「`{code}` 单字段换发 → 每次新建 `unknown`/空公钥设备行」缺口**已闭合**：renderer e2e W7b-1 断言登记设备 `name === 'Orca Web'` 且非吊销，W7b-5 断言同浏览器两次进入同一 `deviceId`（一行设备）。
- 未落实部分：w7a n-3 同时要求补「换发携带他人 deviceId 不被采纳」的负向断言——本提交未补，该分支（密码登录同样走）仍零覆盖（n-4）。
- 细节核验（安全）：`onTokensChanged: (tokens) => persistTokens(session, tokens)` 闭包引用尚未赋值的 `session`——`createWebCloudAuth` 只在后续刷新流程回调（web-cloud-auth.ts:105），构造期不触发，时序安全。设备密钥私钥（secretKeyB64）只进 E2EE 握手与 adoption，不写入任何持久化（persisted session 类型无此字段，模块注释明示）。

### 2.3 恢复优先级与回落

- 优先级实现与 plan §4.4 一致：显式 handoff 在启动 useMemo 短路返回（`decision: null`），存储环境与 pairing 都不参与；`hasEnvironment` 初始为 false → 「Opening the project workspace…」进入屏；成功后 `saveStoredWebRuntimeEnvironment`（App 的 preload 层读它）→ `adoptWebRuntimeClient` 把已验证 socket 交给 App（ticket 已被验证探针消费，重建必败，注释与 M50 语义一致）；失败回落登录表单，且**不触碰已存会话记录**（单测断言）。
- 失败映射逐一核对：410 `HANDOFF_GONE` / 403 `PROJECT_FORBIDDEN` / `network_error` / `NO_PROJECTS`（项目不可见）/ 其它 → 五种提示（web-cloud-handoff-entry.ts:79-114），410/403/网络三种的文案映射有单测，平台端 410/403 由真实 e2e（W7b-2/3）钉住。`?api=` 缺失时不发请求直接回落（单测覆盖）。
- 回落表单预填 `initialApiUrl` 优先于构建默认值（WebConnectCloudForm.tsx:36）——正确：code 必须回到签发平台兑换。
- 顺序细节：notice 优先级为 sessionRecovery > handoff 失败 > cloudSessionEnded（main.tsx:113-126）。若进入失败瞬间恰好发生会话恢复事件，handoff 提示会被恢复提示覆盖——两者都指向登录表单，无功能损害（n-8 未单列，归入 n-9）。

### 2.4 刷新/回退行为

- 刷新：hash 已清 → 走常规启动（已进入者凭已存环境/表单），不会把同一 code 重放给平台；「已进入又刷新」因 `cloudLoginRequired: true`（ticket 已消费）回到登录表单——与设计一致。
- 回退：replaceState 替换当前历史项，回退不会回到含 code 的 URL。
- 进入屏无超时（m-3）：`redeemWebHandoff`/`listCloudProjects`/ticket 的 fetch 无超时（requestJson 无 AbortSignal；`STATUS_TIMEOUT_MS` 只覆盖 status.get），平台挂起时用户停留在进入屏无反馈，唯一出路是手动刷新（code 未消费则重放成功、已消费则 410 回落，均可恢复）。

## 3. 契约抽取与 W3 断言同步（审计点③）

- **`webCloudSessionFromAuthReply` 零回归**：逐字比对抽取前后——解析字段、校验、`createWebCloudAuth` 参数、返回形状全部不变；唯一文本差异是错误消息 `login reply did not match the platform contract` → `auth reply …`（全仓无测试/代码引用该文案）。登录路径（`loginToCloud`）经 `web-cloud-session.test.ts` 全绿。
- **`connectCloudProjectWithSession` 零回归**：`connectCloudProject` 变为「加载设备身份 → `loginToCloud` → 委托新函数」，执行顺序（identity→login→list→select→ticket→offer→validate→adopt tail）与抽取前一致；条件展开保证 undefined 参数不改变行为；`client?.close()` 的失败清理 tail 原样保留。`web-cloud-connect.test.ts` 22/22 过；M50 adopt 套件（`web-cloud-handoff.e2e.test.ts`）不受影响。
- **W3 套件同步无越权**：改动全部围绕「Orca Web 链接→动作按钮」（`data-orca-web`、`disabled===false`、移除 `browserEntryUrl` 置灰分支）及 evidence/matrix 字符串同步；「详情」入口（含 `?api=`、target、rel）断言未动，离线/维护置灰语义未动（`orcaWebDisabledReason` 仅剩 maintenance/offline）。10/10 过。矩阵文案把「无浏览器入口→占位禁用」改写为「仍可点击由平台裁定」，与 FR-3.11 修订（7d599e329d2）一致。

## 4. 范围裁定复核（审计点④）

- **入口 URL 追加 `?api=`**：`page.searchParams.set('api', platformOrigin)`（server.ts:2643-2646），platformOrigin 与 W3 sessionPageUrl 同一 `requestOrigin`（x-forwarded-proto+Host）——页面由宿主/中继伺服，`?api=` 是它找到平台的唯一通道；FR-3.10 的 URL 形如 `<web入口>#handoff=<code>&project=<id>` 与追加 search 参数不冲突。签发者伪造 Host 只会把自己 code 的兑换点指向别处（code 绑定签发者本人，跨用户无利可图），与 W3 既有语义同类（n-3）。
- **browserEntryUrl 优先直连兜底（w7a n-2 落实）**：`browserEntryUrlFor(host.relayRoute)` 取**首个健康**中继边缘（`relayNodes.healthy(now(), relayAliveMs)` + `browserHost !== ''`，server.ts:663-664）——与 W6b 健康门衔接正确；边缘为空时回落 `https://<directAddr>/web-index.html` 且 `directAddr` 必须过 `isDirectAddrForm`；两者皆无 → 保持 400 `HOST_UNAVAILABLE`（`browserEntry === '' && (!directAddr || !isDirectAddrForm(directAddr))`，server.ts:2606-2609），即「无健康中继 + 无直连 → 空串 → 拒签」。relay-only 宿主现在可签发（e2e W7b-url 断言）。签发侧权限判定（W7a major j-1）已在 `8fc140952e9` 修复，W7a 套件含「无 grant 的 admin 签发 403」用例，本提交在此之上无回归。
- 「无浏览器入口不再置灰」是显式产品语义变更（提交信息、FR-3.11 修订、测试矩阵三方一致）：对「直连地址对开发者浏览器不可达」（NAT/`[::1]`）的宿主，现在产出打不开的新标签而非灰色按钮+解释，签发失败仍有 toast 兜底（n-7）。

## 5. 规范（审计点⑤）

- **max-lines**：根预算 300（.ts，skipBlank/Comments）。新增 `web-cloud-handoff-entry.ts` 258 总行、`web-cloud-connect.ts` 278、`web-cloud-session.ts` 348 总行（注释/空行剔除后低于阈值，oxlint 无 finding）；server.ts 2962 行但 cloud-platform 不入根门禁（w7a 已裁定）。`check:max-lines-ratchet` OK，无新增 suppressions，未触碰 AGENTS 红线。
- **命名**：`web-cloud-handoff-entry.ts` / `enterWorkspaceViaWebHandoff` / `readWebCloudHandoffEntry` / `clearWebHandoffFromAddressBar` / `webCloudHandoffFailureNotice` / `useWebCloudHandoffEntry` 全为具体域名词，无 helpers/utils。
- **注释**：新增 why 注释密度与仓内一致（「Why the search stays」「Why the persisted device id first」「Why persist before mounting」「Why adopt」「Why vary」等），1–4 行、无过程复述。
- **diff 归属**：12 个文件全部属 W7b，无混入的格式/无关 hunk（对比 w7a n-5 已改进）。app.js 半部落入 docs 提交 `7d599e329d2`：已核验该提交 app.js 的 hunks 纯属本令控制台入口（注释、置灰分支删除、按钮化、`openOrcaWeb`），requirements.md 行属 docs 提交自身目的（FR-3.11 修订）；提交信息如实披露了共享索引冲突成因。特性代码挂在 docs 标题下损害历史可读性（n-5）。
- **类型断言与 import（→ major j-1）**：`web-cloud-handoff-entry.ts:104` 的 `(error as { code?: unknown }).code` 与 `web-cloud-handoff-entry.e2e.test.ts:232` 的 `(await res.json()) as {…}` 违反 AGENTS「Avoid type assertions except as const；unavoidable casts need a line-specific SAFETY explanation」，`check:code-quality:changed` 的 casting 扫描实报 error；同文件 `./web-cloud-device-key` 与 `./web-cloud-session-storage` 各被 import 两次（行 5/6 与 22–31），`import/no-duplicates` 实报 2 条。格式：oxfmt 全绿（w7a m-5 未复发）。

## 6. 分级发现清单

### Blocker（0）

无。

### Major（1）

- **j-1** `check:code-quality:changed`（pr.yml:257 CI 门禁）对本提交新增代码报 4 条 finding，PR 会被挡（实跑 exit 1，共 8 条中另 4 条来自其它 WIP 文件，非本提交）：
  - `src/renderer/src/web/web-cloud-handoff-entry.ts:104` typescript/consistent-type-assertions——无 SAFETY 说明；可改为 `error instanceof WebCloudConnectError`（该类与已导入的 `WEB_CLOUD_CONNECT_ERROR_CODE` 同模块）。
  - `src/renderer/src/web/web-cloud-handoff-entry.e2e.test.ts:232` typescript/consistent-type-assertions——`as { devices… }` 无 SAFETY 说明。
  - `src/renderer/src/web/web-cloud-handoff-entry.ts:5、:6` import/no-duplicates——`./web-cloud-device-key`（行 5 与 22–26）、`./web-cloud-session-storage`（行 6 与 27–31）各重复 import 一次，合并即可。
  修法均为局部机械改动，不影响行为。

### Minor（3）

- **m-1** B7/B8 e2e 缺口：工作令 W7b 明列「e2e：B1–B3/B5/B7/B8」。B1–B3/B5 已覆盖（平台 e2e + renderer e2e），但 **B7（关浏览器重开 → localStorage 会话恢复）与 B8（同浏览器第二个项目，独立连接互不影响）零自动化覆盖**。实现侧注意点：持久化是单槽（`orca.webCloudSession` 一条 + 单个 stored runtime environment），第二个 handoff 进入会覆盖第一个项目已存环境；活动标签页内两连接互不影响成立（每标签一个 adopted socket），跨重载「互不影响」不成立——与 plan §4.4 的措辞存在解释空间，建议至少把 B8 的「第二标签活动连接互不影响」补成断言，并在交付说明里写明重载语义。
- **m-2** 回落 UI 链路只测到数据层：`initialApiUrl`→表单预填（WebConnectCloudForm.tsx:36）、`initialCloudApiUrl` 透传（WebConnect.tsx）与 main.tsx 启动分支（handoff > 存储短路、entering 屏、notice 三级优先级）均无组件级断言；B5 的「回落登录表单（预填平台地址）」目前仅由 `result.apiUrl` 返回值与 `readWebCloudHandoffEntry` 单测间接支撑。
- **m-3** 进入屏无超时/无退出通道：redeem 与 connect 前半段（list/ticket）的 fetch 无超时（requestJson 无 AbortSignal；15s 超时只覆盖 status.get）。平台挂起时用户停在「Opening the project workspace…」，唯一恢复路径是手动刷新。建议给进入流程加总超时（超时后按网络错误回落表单）。

### Note（9）

- **n-1** `browserPageOrigins()` 用 `relayNodes.all()`（含已停心跳的死边缘）而签发侧用 `healthy()`——死边缘的 origin 会留在 CORS 白名单里。CORS 只决定可读性、无 token 即无信息，风险为零，但语义上「平台仍信任一个已死边缘的 origin」；建议与签发侧同用 healthy()。
- **n-2** `isDirectAddrForm` 允许任意 DNS 名与 `*`/`%`/`@` 等字符：宿主可把白名单扩到它不拥有的 origin（与 W7a m-2 同源的内部威胁；修复点在注册/心跳入库校验，不在 CORS 逻辑）。
- **n-3** `?api=` 取自请求头派生的 platformOrigin（x-forwarded-proto+Host）：Host 伪造/代理配置不当会让签发 URL 把兑换点指到别处；但 code 绑定签发者本人，跨用户窃取不成立，且与 W3 sessionPageUrl 同一既有语义，非新类别。同理，被转发/篡改的链接可让页面把 code POST 到任意 `?api=`——plan §5 已把「未消费窗口内外发」列为声明过的残余风险。
- **n-4** w7a n-3 的负向断言未补：「换发携带他人/已吊销 deviceId 不被采纳」分支零测试覆盖（密码登录路径同样未覆盖，既有缺口非本提交引入）。
- **n-5** app.js 半部落入 docs 提交 `7d599e329d2`（已披露、内容核验为纯本令改动）：「一令一提交」纪律受损，回溯/回滚该特性时需跨两个提交。
- **n-6** 本地化目录未同步：6 个新 `auto.web.WebConnect.handoff*` 键未进 `src/renderer/src/i18n/locales/`（`verify-localization-catalog` exit 1；该检查在本提交前已红——`cloud-connect-failure-dialog` 2026-11-13 起未同步）。`translate(key, fallback)` 兜底保证英文（默认语言）可用，非阻塞。
- **n-7** 「无浏览器入口不再置灰」使直连不可达宿主（NAT/`[::1]`）产出打不开的新标签而非带解释的灰色按钮；三方（提交信息/FR-3.11 修订/测试矩阵）一致，属显式裁决，记录备查。
- **n-8** 预检对任意 `/v1/*`（含未知路径、未列 origin、internal 路径）统一 204——无 ACAO 时浏览器按失败处理，无枚举信号；internal 路径的 mTLS 二层防线不受影响。
- **n-9** 失败 notice 优先级中 sessionRecovery 高于 handoff 失败：两者同时发生时显示恢复提示（都落在登录表单，无功能损害）。

## 7. 验证记录（本审计实跑）

| 套件 | 结果 |
| --- | --- |
| `pnpm test src/renderer/src/web/web-cloud-handoff-entry.test.tsx` | 10/10 过 |
| `pnpm test src/renderer/src/web/web-cloud-handoff-entry.e2e.test.ts`（真实平台 + TLS runtime） | 5/5 过 |
| `pnpm test src/renderer/src/web/web-cloud-session.test.ts web-cloud-connect.test.ts`（既有契约） | 22/22 过 |
| `cloud-platform` `test/e2e/web-handoff-entry.e2e.test.ts`（CORS 正负向/入口 URL/按钮/失败 toast） | 5/5 过 |
| `cloud-platform` `test/e2e/web-handoff.e2e.test.ts`（W7a，含 j-1 修复用例）+ `web-project-entry.e2e.test.ts`（W3 同步后） | 19/19 过 |
| `pnpm run tc:web` | 过 |
| `npx oxfmt --check`（本提交全部改动文件，含 cloud-platform） | 全绿 |
| `pnpm run check:max-lines-ratchet` | OK |
| `pnpm run check:code-quality:changed` | **exit 1**——8 条中 4 条归属本提交（j-1） |

运行说明：被审的 12 个文件与 `server.ts`、三个平台 e2e 在工作树中与 HEAD 完全一致（`git status` 复核）；唯一漂移是 `cloud-platform/apps/web/app.js`（另一在途任务的 oxfmt 重排，已用 `git show` 按提交内容静态审计）。测试写出的 evidence JSON 落在 gitignored 的 `cloud-platform/evidence/w7b-handoff-web/`，未触碰任何受版本控制文件。

## 8. 与工作令逐条对照

| 工作令 W7b 要求 | 落实 |
| --- | --- |
| orca web：hash 读码→换发→自动打开项目→hash 即清 | main.tsx 启动短路 + `enterWorkspaceViaWebHandoff`（换发→落存储→ticket→adopt 已验证 socket）；renderer e2e W7b-1 真实链路 ✓ |
| 410/403/网络错误回落登录表单（预填地址） | 五种失败各自映射 notice；`apiUrl` 返回并预填表单（数据层有断言，表单渲染链无 → m-2）✓（带缺口） |
| 恢复优先级 handoff > localStorage（M62） | 启动 useMemo 先读 hash 并短路；成功覆盖存储；失败不触碰已存记录 ✓ |
| 管理台「Orca Web」按钮激活（调 web-handoff 并 window.open） | `7d599e329d2`（已披露）+ e2e 点击→POST→新标签一次性 URL ✓ |
| e2e：B1–B3/B5/B7/B8 | B1–B3/B5 覆盖；B7/B8 缺失 → m-1 |
| 提交信息 `feat(web): one-time handoff auto-entry` | 实际为 `feat(cloud): one-time handoff auto-entry`（前缀差异，无实质影响） |
| 证据 `evidence/w7b-handoff-web/` | 平台侧 5 份 + renderer 侧 6 份 JSON（gitignored 目录，本次实跑已再生成）✓ |
| FR-3.10 | 60s 单次 code、hash 携带、令牌不经 URL、自动进入、失效回落、`web_handoff` 审计（W7a）✓ |
| 附录「W7 设计要点」web 半部 | hash 读取→换发→存会话→自动打开、失败清 hash 回表单、410/403/网络分别提示、防重放（消费即删，W7a）✓ |
| w7a 移交项 n-2 / n-3 | n-2 落实（健康边缘优先/直连兜底/relay-only 可签发）；n-3 正向落实（deviceId+pubKey+name），负向断言未补（n-4） |
