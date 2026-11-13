# 云端开发平台 · 工作令（2026-11-14，规范化版）

> 纪律：**一个子代理只执行一个工作令**；主会话串行派发、逐个核验后再派下一个。
> **设计先行**：复杂令（W3/W5/W6/W7）分两步——先派「设计代理」产出设计方案（组件改动、数据流、边界与错误处理、测试点、风险），主会话确认后再派「实现代理」；简单令（W2/W4）设计方案已在本文件内，直接实现。
> **执行队列（细粒度，防漂移/遗漏——每个子代理只做一个组件级任务，主会话逐令核验后放行下一个）**：
> W2（执行中）→ W8 → W10 → W3 → W4 →
> W6a 中继浏览器模式 → W6b 平台入口字段 → W6c web 前缀适配 →
> W7a 平台 handoff 端点 → W7b web 消费与入口激活 →
> W5a 详情页终端组件 → W5b 终端 e2e →
> W9a 桌面黄金线 → W9b Orca Web 黄金线 →
> M120 设计 → M120a 登记表单 → M120b 权限矩阵 → M120c 项目级策略。
> 拆分原则：一个任务=一个组件域（中继/平台/web 管理台/orca web/桌面/测试工程），跨域耦合以既有已提交契约为界；每任务自带测试与证据；复杂令先派设计代理。
> **三权分立（用户 2026-11-14 指令）**：每个任务由**三个独立子代理**接力，主会话居中调度——
> ① **实现代理**：只写代码与提交；② **测试代理**：独立运行/复现测试并产出证据（不修改实现，发现问题回主会话派回实现代理）；③ **审计代理**：只读——对照工作令/需求审阅 diff、证据完整性与规范符合性（AGENTS/风格/线兼容），产出评审报告，问题回派实现代理。
> 三方齐备（实现提交+测试证据+审计报告）主会话才关闭该任务并放行下一个。
> **时长预算**：每个代理目标 ≤15 分钟完成；预估超时的任务必须继续拆分（宁可多拆一个 15 分钟任务，不做长跑代理）。
> 注：W2 为旧模式启动的在途任务，让其完成后补跑独立测试与审计代理；自 W8 起全面执行三权分立。
> **并发模型（用户确认可并发）**：按组件域分 **4 条并行通道**，通道内严格串行、通道间文件域不相交；每通道同时至多一个代理，三权分立（实现→测试→审计）在通道内完成。热点文件 `cloud-platform/apps/api/src/server.ts` 归通道①独占；`apps/web/app.js` 归通道③（W3 虽在①，其 app.js 改动错峰到③执行前完成——W3 与 W7b 都改 app.js，故 W7b 必须排在 W3 之后）。
>
> | 通道 | 组件域 | 串行任务序列 |
> |---|---|---|
> | ① 平台侧 | server.ts / store / 自助与归档 | W8 → W7a → W6b → W3 → M120 设计+abc |
> | ② 中继侧 | apps/relay | W6a |
> | ③ 客户端侧 | src/main + renderer 登录 + web 构建 + apps/web | W10 → W6c →（等①的 W3 提交后）W7b |
> | ④ 详情页 | renderer cloud-admin + 其 e2e | W5a → W5b |
> | 收口 | 测试工程 | W9a → W9b（依赖①③④全部落地） |
>
> 并发护栏：测试代理一律 PORT=0 自起实例（无端口冲突）；主会话每通道一次只派一个代理（提交天然错峰，git index 冲突则重试）；预计同时活跃代理 ≤4，符合资源约束。
> 每令一次提交、一次测试报告、证据入 `cloud-platform/evidence/<work-order>/`（gitignored）。
> 设计依据以 requirements.md（v1.3+FR 修订）、design.md、deployment-real-link.md、test-plan.md 为准；与本文件冲突时先在交付说明中指出，不要自行改文档。
> 工作区内与平台无关的改动（claude-auto-resume、acceptance-index 等）**不要触碰、不要提交**。

## 状态

| 令 | 内容 | 状态 |
|---|---|---|
| W1 | M115 自助建项目目录化 | ✅ 已提交 `7eba67c76cd`（主会话核验中） |
| W2 | M116 QA 修复：F1（P0）+ F2（P1 快修批） | 执行中（新纪律首个单任务代理） |
| W8 | M115 兼容回归（管理员 path 登记） | 待派发（W2 后立即） |
| W10 | 客户端零 env 登录记忆地址/用户名 | 待派发 |
| W3 | M117 管理员详情入口 + 项目行双入口布局 | 待派发 |
| W4 | D1 静态请求 503 兜底 | 待派发 |
| W5 | M118 管理台详情页实时终端 | 待派发 |
| W6 | M121 中继双模式（浏览器路径路由） | 待派发 |
| W7 | M122 一次性 handoff 自动进入工作区 | 待派发 |
| W9 | 黄金旅程端到端（A 桌面 / B Orca Web 双线） | 待派发（移至 W7 之后，B 线依赖 W6/W7） |

## W2 · M116 QA 修复（依据 test-reports/exploratory-qa-web.md + evidence/m116-exploratory-web/findings.json）

**F1（P0，单独提交 `fix(cloud): user grants resolve by username`）**
QA-001：Web 用户级授权填用户名显示已授予，但服务端按 `user_<uuid>` 匹配永不命中；且增删该授权误走 `revokeProjectCredentials` 撤销全项目在线会话（apps/web/app.js:509-526、store.ts:163-173、server.ts:1484-1504）。修法：服务端把 username 解析为 user id 再存（或统一主体格式），grant 变更只影响该用户。e2e：授权生效断言 + 仅该用户会话被撤。

**F2（P1 快修批，一个提交 `fix(web): exploratory QA round 1`）**
QA-002 审计 limit=50 → 总数与截断提示；003 筛选控件与实际条件一致；004 traceId 全量可复制；005 主机状态按心跳推导；006 已吊销主机标识+禁维护；007 离线打开全入口禁用；008 维护中主机显示维护原因；009 策略保存失败提示+回滚；010 admin 权限列展示；011 加载失败错误态+重试；012 登录必填客户端校验。每项一条回归断言。P2 不做；013/014/015 功能缺口属 M120，不做。

## W3 · M117 管理员详情入口 + 双入口（FR-3.8/3.11）

平台：项目 payload 增 `sessionPageUrl`（宿主 TLS 直连首项 → `https://<host>:<port>/cloud-admin.html`；无则空）。Web：项目行（工作台+我的项目，两处一致）双入口——「详情」仅管理员（新标签）；「Orca Web」按钮占位（disabled 或按能力隐藏，交付说明写明选择，M122 接管）；离线两入口均置灰 title=主机离线。开发者「打开」对话框首行加「请在 Orca 桌面客户端中打开此项目」引导。e2e：payload 字段正反例 + Web 双入口可见性 + 引导文案。提交 `feat(cloud): per-project admin session-page entry`。

## W4 · D1 静态请求 503 兜底

无 web bundle（staticRoot undefined）时宿主 TLS 监听对静态路径返回 503 立即关闭（不再挂起 0 字节），启动打 warn 日志。单测：无 staticRoot GET /cloud-admin.html → 503；有 staticRoot 行为不变。提交 `fix(runtime): answer static requests when the web bundle is missing`。

## W5 · M118 管理台详情页实时终端（FR-3.9）

CloudProjectWorkspace 接入终端面板（复用 web 客户端终端管线 + cloud-browser-bridge rpc 到宿主 pty；cloud-admin/main.tsx 补 WebGL prime）；布局对齐原型 P3（中部终端、右侧文件树）。无 `terminal` 授权 → 占位不报错。e2e：真实平台+TLS 宿主+PTY，输入回显、文件只读预览。提交 `feat(cloud): live terminal in the admin session page`。

## W6 · M121 中继双模式（FR-4.12 修订）

中继浏览器模式（env RELAY_BROWSER_TLS_CERT/KEY + RELAY_BROWSER_PORT，未配置则不启用）：终结 TLS，按 `/h/<routeKey>/` 路由 HTTP/WSS 到宿主（剥前缀，升级请求同规则）；SNI 透传模式与既有端口完全不变。中继注册体加可选 `browserHost`（env RELAY_BROWSER_PUBLIC_HOST）。平台：宿主 payload 增 `browserEntryUrl`（`https://<browserHost>/h/<routeKey>/web-index.html`，缺 browserHost 或 routeKey 非 DNS 安全 → 空）。Web：有 open 权限者可见「浏览器打开」。web 客户端：构建相对资源 base（`/h/<routeKey>/assets/...`，直连无前缀兼容）；运行时 WSS URL 从 location.pathname 推导前缀。e2e：浏览器模式转发伺服（资源无 404）、未知 routeKey 404、SNI 模式既有全绿、未配置不启用。交付说明含「中继可见传输层头部、E2EE 载荷不可读」确认点。提交 `feat(relay): browser mode with path routing`。

## W7 · M122 一次性 handoff 自动进入（FR-3.10）

平台：`POST /v1/projects/{id}/web-handoff`（open 权限，审计 `web_handoff`）→ 一次性 ≤60s code + URL（`<browserEntryUrl 或直连 web-index>#handoff=<code>&project=<id>`）；`POST /v1/web/handoff` 换正式会话（复用设备会话签发；二次/过期 410、无权限 403）。orca web：启动读 hash → 换会话 → 自动打开指定项目；失败回落登录表单（预填平台地址）；hash 用后即清。Web 项目行「Orca Web」按钮激活（调 web-handoff 并 window.open）。e2e：签发→换发→二次 410→过期 410→无权限 403 + web 端自动进入。提交 `feat(cloud): one-time web handoff auto-entry`。

## W10 · 客户端安装即可用：登录时录入平台地址，登录成功自动记忆（M119 最终版，用户定稿，排在 W9 之后）

用户定稿（2026-11-14，覆盖此前「配置面板 + CLI + init」扩展）：**登录时录入新的平台地址；已登录自动记录平台地址和用户名**。

要求：
1. 无环境变量启动 → 直接进入登录界面（永不因缺 env 失败/卡死）；登录表单含「平台地址」输入。
2. 地址默认值优先级 = 上次成功登录记录（持久化）> **构建参数注入的默认平台地址**（构建时 `ORCA_DEFAULT_PLATFORM_URL` 之类进产物，企业内部分发即预填）> 空；运行时 env 存在时仅作预填/覆盖。
3. 登录成功 → 持久化 {平台地址, 用户名}；下次启动自动预填，免重输。
4. 不做配置面板、CLI config、init 脚本（本轮砍掉，保持最小）。
5. 托管构建（ORCA_MANAGED_BUILD）锁定地址语义不变；非云端构建零回归。

设计要点：持久化沿用既有会话存储位置（M66 机制旁，键=cloud.lastPlatformUrl/lastUsername，权限保护）；env > 持久化记忆 > 空；地址格式校验内联报错。测试（真实平台）：无 env 首启登录成功并记录；重启后地址+用户名预填；换地址登录后记忆更新；env 覆盖预填；非云端构建零回归。提交 `feat(cloud): remember platform address and username from login`。

## W9 · 黄金旅程端到端（A/B 双线，移至 W7 之后执行）

完整业务链路见 business-chain-tests.md（链路 A 桌面 / B Orca Web / C 管理员独立链）。本令交付两条连续旅程单测 + 时间线证据：
- **A 线（桌面）**：宿主注册 → 建项目授权 → 开发者真实登录 → 打开项目（直连徽标）→ 终端 `echo orca-journey && ls` 回显 → 文件树/打开文件 → 时间线 JSON + 截图。
- **B 线（Orca Web）**：平台登录 → 「Orca Web」→ handoff 新标签自动进工作区 → 终端/文件对等断言 → code 重放 410 → 时间线 JSON + 截图（依赖 W6/W7/W5 已落地）。
- 管理员链路 C 的 C2/C3/C4(API)/C5(组) 步骤作为两线共同前置串联其中（对应管理员独立链的自动化部分）。
文件 tests/e2e/cloud-journey-golden.spec.ts（或按基建惯例并入 native e2e 工程）。提交 `test(e2e): golden journey dual-line desktop and orca web`。

## W8 · M115 兼容性回归修复（全量复测发现，优先级最高，W2 完成后立即派发）

HEAD 快照全量套件 171 用例 163 过 8 失败；其中 4 个失败为**真回归**：M115（7eba67c76cd）把 `dir` 设为必填后，**管理员按 `path` 登记项目的旧调用收到 400 INVALID_DIR**（project-archive.e2e.test.ts 建项目失败级联 4 断言；证据 /tmp/m116-retest-full.log）。修法：目录必填仅约束开发者自助路径（FR-3.7）；管理员登记（path 直供）保持原语义，dir 缺省时按现有 key/path 规则派生。修复后 project-archive e2e 全绿 + 新增「管理员无 dir 登记」回归断言。提交 `fix(cloud): admin project creation keeps path semantics`。另 2 个失败为快照缺 evidence/、1 个为快照缺 src/ 跨目录依赖（环境产物，修复验证时在主工作区跑对应文件确认即可，不算回归）。

## M120（功能缺口，暂缓待排）

管理台项目登记弹层（QA-013）、权限矩阵可配置（QA-014）、项目级下载策略（QA-015）——FR-3.1/9.3/9.4 的 Web 呈现补齐。依赖 W3 布局稳定后再派发。


---

## 附：复杂令设计要点（设计代理在此框架内细化，主会话确认）

### W3 设计要点（M117 详情入口 + 双入口）
- 数据流：/v1/hosts 已有 directAddrs → 平台在项目 payload 组装 sessionPageUrl（仅宿主在线且 TLS 首址存在）；前端按角色/权限渲染按钮，不加新接口。
- 错误处理：宿主离线/无 TLS → 入口置灰；URL 生成失败 → 空值隐藏。
- 测试：字段正反例、按钮可见性矩阵（admin×online/offline、developer×online/offline）、引导文案。

### W5 设计要点（M118 详情页终端）
- 组件：CloudProjectWorkspace 增终端区（懒加载避免首屏回归）；数据流 cloud-browser-bridge.rpc → 宿主 pty 方法族；WebGL addon 在 cloud-admin/main.tsx prime（同 web/main.tsx 注释理由）。
- 错误处理：断线重连保留缓冲语义对齐 web 客户端；无 terminal 授权 → 占位卡（非报错）；rpc 超时 → 终端区错误态+重试。
- 测试：真实 PTY 回显、授权负向、文件面板不回归；风险：终端组件对 DOM 环境假设（e2e 内验证）。

### W6 设计要点（M121 中继双模式）
- 中继：新监听器（TLS 终结）与既有 SNI 监听完全隔离；路径解析 → 路由表查 target → HTTP 反代（剥 /h/<routeKey>、X-Forwarded-*）+ WSS 升级透传；路由表复用现有同步机制，未命中 404。
- 平台/前端：browserHost 注册字段（可选、线兼容）→ browserEntryUrl 拼装；web 包相对 base（vite base './'）+ 运行时 WSS 前缀从 location.pathname 推导（无前缀行为不变）。
- 安全语义：浏览器模式下中继可见传输层头部/路径，E2EE 载荷不可读；中继元数据记录 routeKey。风险：升级请求头透传差异、相对 base 对 verify-web-build 的影响。
- 测试：端到端三进程（平台+浏览器模式中继+宿主）转发伺服、未知 404、SNI 模式全绿回归、未配置不启用。

### W7 设计要点（M122 handoff 自动进入）
- 平台：code 存内存 map（code→{userId, projectId, exp}，单次消费），换发走既有设备会话签发；审计 web_handoff 含 code 指纹（不含明文）。
- web 端：hash 读取 → 换发 → 存会话 → 自动打开项目；失败清 hash 回登录表单（预填平台地址）；与既有 web-cloud-session 恢复逻辑的优先级：handoff 显式优先。
- 错误处理：410/403/网络失败分别提示；防重放（消费即删）。
- 测试：平台五步负向链 + web e2e 自动进入 + 审计断言。


---

## 细粒度拆分规格（每条=一个子代理任务）

### W6a · 中继浏览器模式监听（仅 relay 组件）
`cloud-platform/apps/relay/src/relay.ts`：新增 TLS 终结监听（RELAY_BROWSER_TLS_CERT/KEY/PORT，未配置不启用），按 `/h/<routeKey>/` 路由 HTTP/WSS 到路由表 target（剥前缀、X-Forwarded-*、升级请求同规则），未命中 404；SNI 透传模式与既有端口零改动。测试：真实三进程（平台+浏览器模式中继+宿主）转发伺服、未知 404、SNI 模式回归全绿、未配置不启用。证据 `evidence/w6a-relay-browser/`。提交 `feat(relay): browser mode listener with path routing`。

### W6b · 平台浏览器入口字段（仅平台）
中继注册体可选 `browserHost`（relay 侧注册一行 + 解析测试）；平台宿主/项目 payload 增 `browserEntryUrl`（`https://<browserHost>/h/<routeKey>/web-index.html`，缺省/非 DNS 安全 → 空）；`/v1/relays` 带该字段。e2e 正反例。证据 `evidence/w6b-browser-entry/`。提交 `feat(cloud): per-host browser entry url`。

### W6c · orca web 前缀适配（仅 web 客户端与构建）
vite 相对 base（双 base 构建校验通过）；运行时 WSS URL 从 `location.pathname` 推导 `/h/<routeKey>` 前缀（直连不变）。测试：带前缀页面资源零 404、前缀 WSS 连接、直连回归。证据 `evidence/w6c-web-prefix/`。提交 `feat(web): path-prefix aware assets and runtime socket`。

### W7a · 平台 handoff 端点（仅平台）
`POST /v1/projects/{id}/web-handoff`（open 权限、60s 单次 code、审计 `web_handoff` 记指纹）+ `POST /v1/web/handoff`（换发复用设备会话签发；重放/过期 410、无权限 403）。e2e 五步负向链。证据 `evidence/w7a-handoff-api/`。提交 `feat(cloud): web handoff endpoints`。

### W7b · web 消费与入口激活（orca web + 管理台）
orca web：hash 读码→换发→自动打开项目→hash 即清；410/403/网络错误回落登录表单（预填地址）；恢复优先级 handoff>localStorage（M62）。管理台：「Orca Web」按钮激活（调 web-handoff 并 window.open）。e2e：B1–B3/B5/B7/B8。证据 `evidence/w7b-handoff-web/`。提交 `feat(web): one-time handoff auto-entry`。

### W5a · 详情页终端组件（仅 renderer）
`CloudProjectWorkspace` 终端区（懒加载、cloud-browser-bridge rpc→宿主 pty、cloud-admin/main.tsx WebGL prime）；无 `terminal` 授权占位；断线重连语义对齐 web 客户端。组件级测试。证据 `evidence/w5a-terminal-panel/`。提交 `feat(cloud): terminal panel in admin workspace`。

### W5b · 详情页终端 e2e（仅测试工程）
真实平台+TLS 宿主+PTY：输入回显、文件树打开只读预览、无授权占位、文件面板零回归。扩展 cloud-admin-session e2e。证据 `evidence/w5b-terminal-e2e/`。提交 `test(e2e): admin workspace terminal and file preview`。

### W9a / W9b · 黄金旅程双线（各一个测试代理）
W9a：A 线（桌面）按 business-chain-tests §1，含 C2/C3/C4(API)/C5(组) 前置串联，时间线 JSON+截图，证据 `evidence/journey-golden-a/`，提交 `test(e2e): golden journey desktop line`。
W9b：B 线（Orca Web）按 §2（依赖 W7b/W6c 已落地），code 重放 410 纳入旅程，证据 `evidence/journey-golden-b/`，提交 `test(e2e): golden journey orca web line`。

### M120（先设计，再 a/b/c 三任务）
设计代理出方案（登记表单字段与校验、权限矩阵交互模型、项目级策略 UI 与接口映射）→ 主会话确认 → M120a 登记表单 / M120b 权限矩阵 / M120c 项目级策略，各自独立提交与证据。