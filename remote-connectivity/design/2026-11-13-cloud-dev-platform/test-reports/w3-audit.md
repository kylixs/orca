# W3 审计报告（M117 管理员详情入口 + 项目行双入口）

- 审计人：独立审计代理（只读；除本报告外未创建/修改任何文件）
- 日期：2026-11-14
- 审计对象：`cd36987d7a0`（feat(cloud): per-project admin session-page entry，3 文件 +459/−17：server.ts +16、app.js +74/−17、web-project-entry.e2e.test.ts +386/−0）
- 对照基准：work-orders-2026-11-14.md §W3 + 附录「W3 设计要点」、requirements.md FR-3.8/FR-3.11、web-index-adaptation-plan.md、test-plan.md M117 行、AGENTS.md
- 方法：只读 diff 审查（含空白不敏感 diff 对照）+ 现行源码交叉验证（server.ts 守卫/路由/权限链、app.js 渲染函数、config.js/index.html/web-release.ts 消费面、cloud-admin 入口与静态伺服）+ **独立复跑**（新套件 6/6 绿、邻套件 web-exploratory-fixes 13/13 绿，真实平台进程 + happy-dom 真实控制台文件）。行号基于本提交的文件内容。

## 结论

**通过（带 1 项 major 移交 W5/收口前裁定）**：blocker 0、major 1、minor 2、note 7。

安全面成立：`sessionPageUrlFor` 复用 W7a 落地的 `isDirectAddrForm`（server.ts:161）做拼装点形态校验，与 handoff 直连入口同守卫、同 `directAddrs[0]` 选取，宿主注入面被收口在「宿主本就自主申报地址」的信任模型内；`target=_blank rel=noopener` 两条入口均正确；无 open 权限不渲染 Orca Web 属纯呈现层，后端 `/connect` 按 effectivePermissions 签发、`/web-handoff` 显式要求 open（server.ts:2503），无越权放大。语义取舍（URL 不随在线翻转、无地址空串不产死链、删除旧全局入口）均自洽且有 e2e 钉住。规范项干净：无 max-lines disable、命名具体、注释密度合规、**diff 归属经复核与代理自述一致**（未混入 W6b 健康门 hunk，未混入 format reflow）。唯一定向缺口是详情目的地在真实部署里缺运行时平台地址来源（pre-existing，被本提交首次变成用户可见入口，详见 §5 j-1）。

## 1. 安全（审计点①）

### 1.1 sessionPageUrl 拼装的形态校验（host:port 注入面）

- 实现（server.ts:661-667）：`h?.directAddrs[0]` → `https://${addr}/cloud-admin.html`，前置四重门：宿主存在、地址非空、`tlsFingerprint` 非空、`isDirectAddrForm(addr)`。
- **复用而非重写**：`isDirectAddrForm` 由 W7a 整改引入（commit `8fc140952e9`，server.ts:161-166），W3 是第二个消费方。正则 `^(\[[0-9A-Fa-f:]+\]|[^:[\]/?#\s]+)(?::(\d{1,5}))?$` 拒绝 scheme/path/fragment/空白/未括号 IPv6，端口校验 1–65535。与 W7a 签发侧（server.ts:2533）逐字同一 helper、同一「拼装点校验」模式——正是 w7a-audit.md m-2 要求的整改落点，两入口对同一宿主同生共死（一致性 ✓）。
- **该校验是必要而非冗余**：注册路径对 `directAddrs` 不做任何格式校验（server.ts:2018 原样入库），此守卫是唯一防线。
- 注入面残余：正则允许 `@`（userinfo）与 `\`（特殊 scheme 下浏览器归一为 `/`）。实际不可利用升级——宿主本可把地址申报成任意主机名，无需 userinfo 技巧；守卫的真实价值是禁掉 `javascript:`/data:、路径改写与空白/引号 breakouts（payload 经 JSON、href 再经 `esc()` 双层转义）。定 note（n-3），建议与 W7a/W6b 同一令内顺手收紧字符集。
- 与 W7a 的一处**有意不对称**（方向安全）：W7a 签发只查 `isDirectAddrForm`+活性，W3 额外要求 `tlsFingerprint`——管理员会话页（要输平台凭据）必须走 TLS，比 handoff 更严是正确的。

### 1.2 新标签与 rel

- 详情（app.js:295）与 Orca Web（app.js:322）两条锚点均为 `target="_blank" rel="noopener"`，href 分别为服务端拼装的 https URL 与 W6b 的 `browserEntryUrl`（`https://<browserHost>/h/<routeKey>/web-index.html`，routeKey 经 `BROWSER_ROUTE_KEY_PATTERN` 门）。e2e 对详情断言了 target+rel、对 Orca Web 断言了 target（rel 未断言，见 m-2）。无 `javascript:` 可达路径（两 URL 均服务端 https 拼装）。✓

### 1.3 前端隐藏 ≠ 安全边界（确认无越权放大）

- **Orca Web**：`orcaWebEntry` 仅对 `permissions.includes('open')` 渲染（app.js:317-319）。而 `/v1/projects` 列表可见性本身就是 `admin || open`（server.ts:1296-1301），故该门实际只对「无 grant 的管理员」生效——正是 e2e 的 locked-project 用例。点击后的两条后端路径均独立收口：`/connect` 按 `effectivePermissions` 签发凭证（server.ts:2647）；`/web-handoff` 显式 `open` 必需且注释明示 adminAccess 只放宽可见性（server.ts:2499-2510，W7a j-1 整改后语义）。
- **详情**：`sessionPageUrl` 对所有可见该项目的用户下发（含开发者），UI 按 `isAdmin()`（`platform:admin` 权限位）隐藏入口。地址本身无新增信息面——开发者经 `/connect` 响应的直连地址列表已见同一 host:port。会话页自带登录（cloud-admin/main.tsx:9-11 注释 + M54 交付），非管理员登录后能做什么由 W5 的授权面决定，不因知道 URL 而放大。
- 结论：前端隐藏只是呈现策略，后端 `/connect`、`/web-handoff`、宿主侧 rpc 各自 fail-closed，无越权放大。✓

## 2. 语义（审计点②）

### 2.1 sessionPageUrl 刻意不随在线翻转——取舍成立

- W3 设计要点原文「仅宿主在线且 TLS 首址存在」与同一工作令的「离线两入口均置灰 title=主机离线」**互相矛盾**：若离线即空串，离线行详情只能落「该主机没有可直达的会话页地址」分支，title 永远给不出「主机离线」。实现选择「地址只由静态能力决定（直连首项 + TLS 指纹），活性只进置灰判定」，是唯一能同时满足两条要求的解，且与 FR-3.11「离线宿主两入口均置灰」逐字吻合；commit message 与 delivery.json 都把这一取舍写明了。test-plan.md M117 行（「与 directAddrs 首项一致」）也不含在线条件。
- 活性判定仍由前端复用同一数据源（`hostStatus` 出自 `hostStatusView`，server.ts:749-754，心跳窗推导），两侧不会对同一宿主得出不同活性结论。✓
- 建议：把该裁决回写 work-orders/PLAN（设计要点那句话按实现语义修正），避免 W5/M120 重新争议（n-1）。

### 2.2 删除旧全局 `__ORCA_CLOUD_SESSION_URL__` 的影响面

- 全仓引用核查：**唯一消费方**就是被删的 `sessionPageUrl()`/`sessionPageLink()`（app.js 旧 268-289），无其它代码引用（src/、mobile/、relay、cloud-platform 均无）。删除无行为影响。✓
- 残留三处（m-1）：`apps/web/config.js:8` 仍赋值空串且 4-6 行注释仍描述「Left empty, the '打开会话页' action stays hidden」——该 action 已不存在，注释指向已删除行为；`apps/web/index.html:136` 仍加载 config.js；`cloud-platform/PROGRESS.md:1028` 仍把旧行为记为现状。delivery.json 已自认「无害残留」，且 config.js 不在本令文件域（通道③），可接受；但应挂账到 W7b/M120 一并清（注意 web-release.ts:18 的 `STATIC_FILES` 含 config.js、index.html 引用 `/config.js`，移除需同步两处，属小规模线兼容改动）。

### 2.3 无地址置灰不产死链

四态穷举核验（app.js:269-301、303-324）：

| 宿主态 | 详情（admin） | Orca Web（open） |
| --- | --- | --- |
| online + 有地址 | `<a href>` 真链接 | `<a href>` 真链接 |
| online + sessionPageUrl 空 | disabled button，title=该主机没有可直达的会话页地址 | — |
| online + browserEntryUrl 空 | — | disabled button，title=该主机暂无浏览器入口… |
| maintenance | disabled，title=主机维护中 | disabled，title=主机维护中 |
| offline/revoked | disabled，title=主机离线 | disabled，title=主机离线 |
| 无 open 权限 | （按角色隐藏） | 不渲染 |

- 空 URL 一律落 disabled `<button>`，永不渲染 `href=""`；e2e 用「点号 routeKey 被 `/h/` 解析器拒绝」的宿主把 Orca Web 空分支真实钉住（test:256-297）。无死链。✓
- 维护态 title=主机维护中超出令文（令文只写离线），与 M116-QA-008「维护原因可见」语义一致，属正向扩展。✓

## 3. 规范（审计点③）

- **max-lines**：app.js 934 → 991 行。根门禁不适用（`check-changed-code-quality.mjs:12` `ROOT_CODE_QUALITY_IGNORED_PREFIXES = ['cloud/', 'cloud-platform/']`，cloud-platform 为独立 workspace）；根 oxlint 的 max-lines override 只挂 `*.ts/*.tsx/*.mjs`，`.js` 无预算。**未新增任何 max-lines disable、未动 max-lines-baseline.txt**——AGENTS.md 红线未触。方向性观察：app.js 单文件继续增长，但双入口本身是「抽共享 builder 消灭重复」的正向改动（两页模板从各自手拼改为一个函数），净增 57 行里有 386 行是测试。✓
- **命名**：`projectRowActions` / `detailEntry` / `orcaWebEntry` / `detailDisabledReason` / `orcaWebDisabledReason` / `sessionPageUrlFor`——全部具体域名词；`sessionPageUrlFor` 与既有 `browserEntryUrlFor` 命名对仗，无 helpers/utils 类命名。✓
- **注释**：新增 why 注释 6 处（server.ts 2 处 4-5 行、app.js 4 处 1-4 行），全部解释「为什么」（如「Empty rather than dangling」「Offline stays out of the decision」「one builder so 工作台 and 我的项目 stay identical」），无过程复述，密度与两文件既有风格一致。✓
- **diff 归属（复核代理「hash-object 重建暂存」自述）**：
  - 仅 3 个文件，逐 hunk 审查全部 W3 域内；server.ts 只有 `sessionPageUrlFor` + payload 一行（`browserEntryUrl` 行是 W6b 已提交内容的上下文）。
  - **W6b 健康门 hunk 未混入**：W6b 审计 MAJ-1 的整改是独立提交 `843c3d6c382`（fix(cloud): gate browser entry url on live relay health，在 W3 之后 3 分钟）。本提交里的 `browserEntryUrlFor` 仍是 W6b 原样（含 `all().slice(-1)` 回退），与「他人未提交改动不入暂存」的自述一致。
  - **format reflow 未混入**：`--ignore-all-space` 与普通 diff 的逐行对比显示，空白不敏感后消失的行**只有一行**——被删除函数自身的 `-return null`，属 W3 改动本体；工作区里他人对 app.js 的 prettier 重排（esc/openProject/showHost 等 6 处）确实全部被排除在提交外。
  - 附证：`git show --check` 干净（0 whitespace error）；提交内 app.js `node --check` 语法通过；`git show` 三文件 +459/−17 与交付自述逐字一致。✓
- **类型断言**：新测试用 `as { token: string }` 等窄断言 + 一处行内 disable 的 `any`（注明「same assert-driven shape as web-exploratory-fixes.e2e.test.ts」）。严格按 AGENTS.md 应带 SAFETY 行注，此处沿袭 e2e 套件既有约定，定 note（n-7）。

## 4. 测试质量（审计点④）

### 4.1 独立复跑（本审计执行）

- `node --test test/e2e/web-project-entry.e2e.test.ts` → **6/6 pass，18s**（真实平台进程 PORT=0 + happy-dom 装载真实 index.html/app.js，fetch 直打真平台；非 mock 渲染）。
- 邻套件回归 `web-exploratory-fixes.e2e.test.ts` → **13/13 pass，59s**（双入口改动最可能波及的既有 Web 套件）。
- 测试介质可信：装载的是工作区真实控制台文件而非内联 HTML 片段；「工作台 vs 我的项目 actions 逐字节相等」断言（test:356-360）直接钉死「一处 builder 两处一致」这一 FR-3.11 核心要求——若有人只在renderProjects 里改，developer 用例必红。

### 4.2 六例可变红性（mutation-red）逐条

| 用例 | 钉住的行为 | 反例突变 → 变红？ |
| --- | --- | --- |
| W3-payload 正例（test:218） | 直连首项+TLS → URL；开发者列表同值 | 删字段/改首项选取 → 红 ✓ |
| W3-payload 反例（test:243） | 无 TLS 指纹 / 无直连 → `''` | 删 `tlsFingerprint` 门 → 红 ✓ |
| W3-admin（test:256） | 详情 href/target/rel、Orca Web href/target、无边缘置灰、离线详情置灰 title | 去掉 rel、离线仍出链接、空边缘出链接 → 红 ✓ |
| W3-orca-web（test:304） | 无 open 完全不渲染 | 去掉 open 门 → 红 ✓ |
| W3-developer（test:321） | 开发者零详情入口、Orca Web 三态、两页 actions 相等 | 去掉 isAdmin 门 / 两页改动不同步 → 红 ✓ |
| W3-guide（test:365） | 对话框首行引导文案 + 真实 connect 调用 | 改文案/删引导 → 红 ✓ |

**不可变红（当前矩阵打不到）的分支**（→ m-2）：

1. `isDirectAddrForm` 拒绝分支（地址在但非 host:port，如 `127.0.0.1:99999`/`http://x/y`）→ payload 恒空串。commit message 与 delivery.json 都声明了这条行为，但矩阵里所有带地址的宿主地址都合法，删掉该守卫**零用例变红**。注册路径不校验 directAddrs（server.ts:2018），该分支经 API 真实可达，补一例即钉住。
2. online + `sessionPageUrl === ''` 时详情的置灰分支（app.js:277-279）——矩阵里在线宿主全都有会话页地址，`detailDisabledReason` 第三支未被任何用例走到。
3. maintenance 分支的 `title=主机维护中`（两条入口的四支中 0 支有断言）。
4. 「admin 持 open + 离线宿主 → 两入口**同时**置灰」的组合态：现矩阵里离线宿主恰好无 admin grant（test 内有注释自认），离线置灰是详情、Orca Web 各自单侧覆盖。

### 4.3 覆盖矩阵缺口与补例建议（供测试代理回派）

1. 注册一个 `directAddrs: ['127.0.0.1:99999']`（或带 scheme）宿主 → 断言 payload `sessionPageUrl === ''`，且该宿主项目在线时详情 title=该主机没有可直达的会话页地址（一并覆盖缺口 1+2）。
2. 给一台宿主发维护态心跳 → 断言 admin 行详情与（有 grant 时的）Orca Web 均 disabled 且 title=主机维护中；同宿主恢复在线再断言回到真链接（置灰-恢复翻转）。
3. Orca Web 锚点补 `rel === 'noopener'` 断言（现在只有详情有）。
4. admin + open + 离线宿主行：断言打开/详情/Orca Web 三控件同态（title 同为主机离线）。
5. 多直连地址宿主 → 断言取 `directAddrs[0]` 而非末项（现矩阵全部单地址宿主，首项语义未证）。
6. （可选）`entryIn` 现按 textContent 精确匹配，「打开」按钮与新增入口同格共存这一事实已被隐式覆盖，可在 admin 用例里加一条「行内控件数为 3」防后续静默增删。

## 5. 分级发现清单

### Blocker（0）

无。

### Major（1）

- **j-1（移交 W5/收口，非 W3 违规）** 详情目的地的平台地址在运行时无来源：`cloud-admin.html` 只认 `window.__ORCA_CLOUD_ADMIN_API_URL__`（声明于 env.d.ts:101、读取于 cloud-admin/main.tsx:14，全仓**无任何注入点**）、`?api=` 查询参数、或构建期 `VITE_ORCA_CLOUD_API_URL`；宿主侧静态伺服原样回文件不注入（static-web-client-handler.ts）。design.md/deployment-real-link.md 对此零着墨，PROGRESS.md:923/1036 自认「VITE_… 是构建期变量，尚无运行时配置发现」。后果：未设置该构建变量的部署里，管理员点「详情」落到页面自己的「未配置」态——W3 把这条 URL 从「无消费者」变成管理台上一等入口后，该缺口首次用户可见。W3 本身忠于令文规定的 URL 形态（`https://<host>:<port>/cloud-admin.html`），故不计为本提交缺陷；但必须在 W5（M118 正式把页面做成浏览器可用）之前裁定修法：平台拼 `sessionPageUrl` 时追加 `?api=<平台公网地址>`（增量字段、线兼容、平台本就持有该地址），或宿主伺服时注入，并进 deployment-real-link.md。裁判依据：详情入口的验收（FR-3.8「管理员经该页查看会话信息」）在 W5 收口时必须真实可走通。

### Minor（2）

- **m-1** `apps/web/config.js`（+index.html:136 加载、PROGRESS.md:1028 记录）成死旋钮：唯一的 `__ORCA_CLOUD_SESSION_URL__` 消费方已删，注释仍描述「打开会话页」行为，构成部署者误导面（照注释配置后无任何效果）。delivery.json 已自认无害残留；请在 W7b 或 M120 清理，同步处理 web-release.ts `STATIC_FILES` 与 index.html 引用（两处需一致改动）。
- **m-2** e2e 矩阵缺 4 个已声明/已实现分支（详见 §4.2）：`isDirectAddrForm` 负例（commit message 明文声称的行为，现状零覆盖、不可变红）、online+无地址的详情置灰支、维护态 title 四支、「两入口同时置灰」组合态。按 §4.3 补例，预计 +2 用例可全覆盖。

### Note（7）

- **n-1** sessionPageUrl 不随在线翻转偏离设计要点「仅宿主在线…」字面，但那是设计要点自身与令文置灰要求的内部矛盾，实现取了唯一自洽解且两处文档（commit/delivery）写明。建议回写 work-orders/PLAN 防复议。
- **n-2** 「Orca Web」令文要求「占位（disabled 或按能力隐藏）」，实现按 W6b 已落地的真 URL 出真链接（能力隐藏 + 无边缘/离线置灰），delivery.json 的 choices.orcaWebButton 满足「交付说明写明选择」。在 W7b 接 handoff 之前，点击落到 orca web 登录表单而非自动进入——FR-3.11 终态（handoff 免登自动进入）未达成，W7b 必须接管（已在 commit/delivery 双处挂账）。
- **n-3** `isDirectAddrForm` 允许 `@`（userinfo）与 `\`（特殊 scheme 下归一为 `/`）。在「宿主自主申报地址」的信任模型下无放大（宿主本可申报任意主机名），与 W7a 守卫行为一致；建议后续同一令内收紧字符集（禁 `@`/`\`/`,`/`;`）。
- **n-4** 详情走宿主 TLS 直连，浏览器受 FR-3.8 固有的信任链约束（web-index-adaptation-plan §1.2：浏览器「必须过浏览器信任链」）：自签证书宿主上管理员会碰证书告警，而平台无法验证浏览器信任。属设计固有，建议 deployment-real-link.md 写明「详情入口要求宿主证书受浏览器信任」；这也正是 Orca Web 走中继浏览器模式的动机，两入口并存是合理互补。
- **n-5** 工作台「最近项目」卡片（projectCard，app.js:249-267）只有「打开」无双入口——符合 FR-3.11「项目行」字面，但同一项目在工作台表格有双入口、卡片没有，请确认是预期（若是，建议在 delivery 里写一句，避免 M120 布局时再议）。
- **n-6** 小项：`data-open="${p.id}"` 未过 `esc()`（app.js:289，沿袭本提交之前的既有写法，id 为服务端 `proj_`+hex，无实际风险）；disabled 控件的 `title` 在部分浏览器引擎不弹原生 tooltip（与既有 `openDisabledAttr` 模式一致，是共享局限而非新引入）；`sessionPageUrlFor` 的 TLS 指纹门槛比 W7a 签发侧更严（方向安全，有意为之）。
- **n-7** 证据精度：delivery.json 记「web-exploratory-fixes.e2e.test.ts 16/16」，该套件在 W3 提交点与现 HEAD 均为 **13** 例（无子测试），本审计独立复跑 13/13 绿。结论不受影响，但证据数字应可复现；另新测试的 `as` 断言沿袭套件约定、未带 SAFETY 行注（AGENTS.md 字面要求，沿袭既有 e2e 风格，非本提交独有）。

## 6. 与工作令逐条对照

| 工作令 W3 要求 | 落实 |
| --- | --- |
| 项目 payload 增 `sessionPageUrl`（TLS 直连首项 → `https://<host>:<port>/cloud-admin.html`；无则空） | server.ts:661-667 + projectView:680；空串覆盖无地址/非 host:port 形态/无 TLS 指纹三支；增量字段，线兼容（旧客户端忽略）✓ |
| Web 项目行双入口，工作台+我的项目两处一致 | 共享 `projectRowActions`（app.js:288）替换两处手拼；e2e 断言两页 actions innerHTML 相等 ✓ |
| 「详情」仅管理员（新标签） | `isAdmin()`（platform:admin）门 + `target=_blank rel=noopener`；开发者全站零入口（e2e 钉）✓ |
| 「Orca Web」占位（disabled 或按能力隐藏，交付说明写明，M122 接管） | 按能力隐藏（open）+ 无边缘/离线/维护置灰；实现超出「占位」为真链接，交付说明已写明选择 → note n-2，W7b 接管 ✓ |
| 离线两入口均置灰 title=主机离线 | 四态表见 §2.3；维护态扩展 title=主机维护中（正向）✓（「两入口同时置灰」组合态无断言 → m-2） |
| 开发者「打开」对话框首行加桌面客户端引导 | app.js:359-360 首行 `<strong>` 引导；e2e 断言文案 + 真实 connect 调用 ✓ |
| e2e：payload 字段正反例 + Web 双入口可见性 + 引导文案 | 6 例 386 行，真实平台+真实控制台文件；本审计独立复跑 6/6 ✓（分支缺口 → m-2） |
| 提交信息 `feat(cloud): per-project admin session-page entry` | 逐字一致 ✓ |
| 证据入 `cloud-platform/evidence/w3-admin-entry/` | delivery.json + 6 份用例 JSON + run log 齐；本审计复跑另产出 4 份新 JSON ✓ |
| FR-3.8 | 入口地址/可见性/新标签/开发者不显示全中；页面内会话/文件/诊断面板归 W5 ✓ |
| FR-3.11 | 双入口布局与可见性矩阵全中；handoff 免登自动进入归 W7b（计划内时序）✓ |
| AGENTS.md | 无 max-lines disable、命名具体、注释克制、diff 归属干净、payload 增量字段线兼容 ✓ |
