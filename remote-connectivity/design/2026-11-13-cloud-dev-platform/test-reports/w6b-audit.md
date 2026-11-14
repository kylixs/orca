# W6b 审计报告（平台浏览器入口字段）

- 审计人：独立审计代理（只读，未修改任何仓库文件）
- 日期：2026-11-14
- 审计对象：`8cdfdd02902`（feat(cloud): per-host browser entry url；5 文件 +479/−14）
- 对照基准：work-orders-2026-11-14.md §W6 / §W6b、requirements.md FR-4.12 修订、web-index-adaptation-plan.md §4.2/§4.3/§5、design.md §4.3.2、AGENTS.md（复用优先/注释密度/命名/禁 max-lines disable/类型断言）
- 方法：只读 diff 审查 + 提交快照逐行核对（`git show 8cdfdd02902:<path>`，与含未提交改动的现行工作树隔离）；另以 1 个一次性探针脚本（/tmp，脱离仓库）对 `parseRelayRegistration` 的 browserHost 白名单与 `BROWSER_ROUTE_KEY_PATTERN` 共 25 个边界值实测；与测试代理证据 `cloud-platform/evidence/w6b-browser-entry/`（run-w6b.log 23/23、run-relay-regression.log 30/30、5 份 JSON）及 `w6b-verify/` 交叉印证。
- 未复跑套件的说明：现行工作树在 cloud-platform 有大量未提交改动（server.ts 等），复跑会测到非本提交的代码；改用提交内代码核对 + 既有证据比对。`relay-nodes.ts` 在工作树与提交零差异，白名单边界实测结论对提交有效。

## 结论

**有条件通过（不阻塞 W6c 派发；MAJ-1 应在 W7b 把入口接成可点击按钮之前修复）**：blocker 0、major 1、minor 4、note 8。

方向与工作令一致：browserHost 只在浏览器监听真正起来时宣告（relay.ts:295 的条件在 `options.browser` 之内）、平台侧白名单只收裸 `host[:port]`（scheme/路径/空白/`@`/`%`/非 ASCII 一律置空，实测）、routeKey 复核与中继 `/h/` 解析器同形（两份正则逐字符相同，实测）、四处挂载（`/v1/relays`、`/v1/hosts`、projectView、`/connect`）全部是新增字段、旧中继注册体与旧客户端双向零破坏。唯一的 major 是**存活语义的效果级漂移**：`browserEntryUrlFor` 逐字复用了 `relayEndpointsFor` 的 live→last-known 兜底，但 browser 入口没有桌面客户端那套探测/failover，最后Known 的死中继会以「可用」姿态产出一个点不开的 URL——与本提交自述的「Empty string over a dead link」不变量相悖，且在单中继的真实链路部署里是常态故障形态。

---

## 1. 安全审计

### 1.1 browserHost 白名单边界（探针实测，非推理）

`isBrowserHostForm` = `^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$` + 端口 1–65535（relay-nodes.ts:112-117）。

| 输入 | 结果 | 判读 |
| --- | --- | --- |
| `relay.example.test` / `:8443`（含首尾空白） | 收（trim 后） | 正确 |
| `:0` / `:00` / `:00000` | 置空 | 正确（清单问点：三种全零形式都被 `Number(port) >= 1` 拒掉） |
| `:65535` | 收；`:65536`、`:99999`、`:123456` | 拒（`\d{1,5}` + 范围双闸） |
| `:00001` | **收，且原样存储** | 端口语义归一（浏览器解析为 1），存储不归一——运营写错时入口指向 1 端口而非所配边缘（N1） |
| `https://x`、`x/h/k`、`x y`、`x:/443` | 置空 | scheme/路径/空白/非法端口全拒 |
| `[2001:db8::1]:443` | 置空 | IPv6 字面量宣告不了——fail-closed，但属部署限制（N2） |
| `_relay.example.test` | 置空 | 下划线标签拒（N2） |
| `..`、`a..b`、`-evil.example.test`、`relay.example.test.` | **收** | 非注入面：`..`/前导 `-`/尾点都是解析不了的死链，不是 origin 逃逸；白名单本可廉价收紧（N1） |
| 300 字符 host | **收** | 无长度上限，见 MIN-2 |
| `0177.0.0.1:8443`、`127.0.0.1` | 收 | 十进制 IP 变体收下；仍是合法 origin，无绕过 |
| 非字符串（42/数组/对象）、空白串、缺字段 | `undefined` → 注册表清空 | 类型面 fail-closed |

**注入面判定：封闭。** 拼接点是 `https://${edge.browserHost}/h/${routeKey}/web-index.html`（server.ts:651）：browserHost 字符集 `[A-Za-z0-9.-]` + `:\d{1,5}`，排除了 `/ ? # @ % \ 空白 CR/LF` 与一切非 ASCII，无法逃逸 authority、无法注入 userinfo、无法换 scheme；routeKey 被 `^[A-Za-z0-9_-]+$` 闸住，无法改写路径段。剩余自由度只有「中继给自己起什么名字」——这在本设计里就是中继的自宣告权（x-internal-token 之后的可信配置面），白名单管语法不管目的地，属设计内信任，不是缺陷。

### 1.2 routeKey 复核与中继侧白名单一致性

- 平台 `BROWSER_ROUTE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/`（relay-nodes.ts:13）；中继 `BROWSER_ROUTE_KEY = /^[A-Za-z0-9_-]+$/`（relay.ts:87），`parseBrowserPath` 用它判 `null`（relay.ts:121）。**逐字符相同，实测**（`dev-001`/`ip-10-0-0-8`/`a_b` 收，`w6b.bad.key`/`a b`/`a%2Fb` 拒）。危险方向（平台收、中继拒 → 产 404 死链）当前不存在。
- 常量是**两份独立拷贝**（api 与 relay 是独立部署件，未共享包），漂移不保证 fail-closed：中继一侧将来收紧（如禁前导 `-`）时，平台会继续拼出中继 404 的入口且无任何告警。MIN-3。
- 中继的 SNI 侧规则（`routeKey.includes('.')` 才拒，relay.ts:351-356）比浏览器侧松，但平台闸门取的是更严的那个，入口 URL 不会落到 SNI 也到不了的地方；反方向（SNI 收、浏览器拒）只影响桌面客户端，非本令面。
- 平台侧只在入口拼装处复核；宿主注册体本身的 `relayRoute` 仍不校验形状（server.ts:2007 原样收），带点/带空格键可进路由表。这不是回归（SNI 侧既有行为），且入口复核已把危害封在「空串」。

### 1.3 「未宣告即清空（非粘连）」的影响窗口

- 生效链路：中继每 2s route sync 成功后 `announce()`（relay.ts:289-307,313-317）→ 平台 `register` 用 `input.browserHost ?? ''` 覆盖（relay-nodes.ts:62，无 existing 回退）→ `browserEntryUrlFor` 每次请求现算，无缓存。**关闭浏览器模式 → 下一次 announce（≤2s）起，所有新响应即空串。**
- 客户端侧无失效推送：管理台页面按导航拉 `/v1/projects`，已渲染的按钮持有旧 URL 直到刷新；桌面/移动端在 `/connect` 时取一次。窗口 = 客户端自身刷新节奏，秒级到「一次会话」级。当前仓库内尚无任何消费方（W6c/W7b 未落地，`git grep browserEntryUrl 8cdfdd02902 -- apps/web apps/client` 为空），该窗口在 W6b 节点上是理论性的；W7b 接线时建议点击时重取或校验，而不是信任页面存量值。
- 反向窗口（本不该被推荐却被推荐）：见 MAJ-1。`registry.all()` 永不驱逐节点（只有 `healthy()` 按时间过滤），一个已停进程的中继的 browserHost 会一直留在表里。

### 1.4 其他

- 鉴权面：browserHost 只经 `/v1/internal/relay-endpoint`（x-internal-token）进入，`/v1/relays` 管理员门控与 `relay_list` 拒绝审计为既有用例（relay-endpoint-address.e2e.test.ts:153,207）；`/v1/hosts` 管理员门控既有。无新增未鉴权暴露。
- 无审计：中继注册（含 browserHost 出现/消失）不写审计事件，`/v1/internal/relay-endpoint` 全程无 `audit.append`。FR-4.12 修订要求「该可见性变化需在部署文档与审计语义中如实声明」，宣告行为的开启/关闭目前无痕（N4）。
- URL 不含令牌：`browserEntryUrl` 只有 host/routeKey，与 W7a 已落地的 `handleWebHandoff` 的直连形态 `https://${directAddr}/web-index.html#handoff=…`（server.ts:2557）路径形态一致；本提交未触碰 handoff 的入口选择（run-summary「handoffLinkage」声明与代码一致：`browserEntryUrlFor` 只有 3 个调用点 665/1909/2660）。

---

## 2. 语义审计

**非粘连 vs `host` 粘连：与「关掉浏览器模式必须停止被推荐」一致。** `host` 缺省时保留旧值（relay-nodes.ts:60，理由是平台的来源 IP 回填路径不能冲掉显式地址，既有用例「再次注册未报 host：保留原地址」钉着），`browserHost` 缺省即清空（:61-62 带 WHY 注释）。两个语义都有单测钉住且互相成对，正是工作令要的对比。清空的唯一前提是「中继还在注册」——进程被整个停掉时无人来清，落入 MAJ-1 的兜底路径。

**`browserEntryUrlFor` 的存活选择：代码零漂移，效果有漂移。**

```ts
const live = relayNodes.healthy(nowMs, relayAliveMs)
const chosen = live.length > 0 ? live : relayNodes.all().slice(-1)
const edge = chosen.find((node) => node.browserHost !== '')
```

- 与 `relayEndpointsFor`（server.ts:633-639）逐字同构（同 `live` → 同 `all().slice(-1)` → 同优先序），复用意图明确，注册序即优先级也一致。
- 「第一个宣告了 browserHost 的存活中继」的多中继正确性成立：平台把**全量**路由表推给每个中继（`/v1/internal/relay-routes` 返回 `[...store.relayRoutes.values()]`，server.ts:2463；relay.ts:266 全量重建），任意浏览器模式中继都能伺服任意 routeKey，不存在「选中的中继没有这条路由」的死链。
- **漂移在故障语义**（MAJ-1）：`relayEndpointsFor` 的 last-known 兜底是给「会探测、会 failover 到直连」的桌面客户端用的（cloud-client.ts `openProject` 有 probes + failoverBudget）；browser 入口没有探测者，兜底产出的 URL 被当作可用入口直接交给浏览器。
- `relayAliveMs` 抖动期的**反向**表现（可用性假阴性）：宣告中继的 control channel 抖 >30s 且平台上另有一个存活但无浏览器边缘的中继时，`live` 非空而 `find` 落空 → 入口变空串，尽管那条边缘本身完全健康。这与 `relayEndpointsFor` 把死中继从端点列表剔除同理，自愈于下次 sync（≤2s），记 N5。

---

## 3. 契约审计

| 挂载点 | 变更 | 旧客户端影响 |
| --- | --- | --- |
| `/v1/relays`（server.ts:1886） | 行对象新增 `browserHost: string` | 管理台/测试按字段取值；新增字段零破坏。管理员门控不变 |
| `/v1/hosts`（server.ts:1909） | spread 后新增 `browserEntryUrl: string` | 同上。`/v1/hosts/available`（开发者）**不带**该字段，符合「仅宿主/项目 payload」的令面 |
| projectView（server.ts:665） | 新增 `browserEntryUrl`，7 个调用点（列表/自助建/管理员建/详情×4）全量生效 | web 端 `loadProjects` 等按字段取值，零破坏 |
| `/connect`（server.ts:2660） | `host` 对象新增 `browserEntryUrl` | 客户端 `ConnectResponse` 为窄类型 + `as` 断言（cloud-client.ts:5-14,89），多余字段运行时被忽略，零破坏 |
| （附带）`/v1/internal/relays`（server.ts:2447-2452） | `...node` spread 自然带出 `browserHost` | 内部视图，新增字段，零破坏 |

- **旧中继方向**：pre-W6b 注册体不含 `browserHost` → `parseRelayRegistration` 返回 `browserHost: undefined` → `register` 视为空串；e2e 的 `bareRelay`（无 browser 选项的真实 `startRelay`）即此形态，`/v1/relays` 断言空串通过（run-w6b.log）。旧平台收新中继：既有 parse 只读 port/host/id，多余键忽略。双向线兼容成立，30 条中继回归全绿（w6b-verify/run-relay-regression.log 30/30）。
- **空串 vs 缺省的契约选择**：`browserEntryUrl` 恒为字符串（缺则 `''`），消费方不需要做 undefined 分支；`browserHost` 同理在注册表内恒为字符串。一致且利于 W7b。
- `BROWSER_ROUTE_KEY_PATTERN` 从 relay-nodes.ts 导出后**仅** server.ts:49,646 使用，无第三方引用；导出本身合理（把形状契约放在注册体解析器旁），但「中继同形」只靠注释声明，无对拍测试（MIN-3）。

---

## 4. 规范审计（AGENTS.md）

- **max-lines**：server.ts 2846 → 2866（+20）。cloud-platform 是独立 workspace、不入根工程 lint/typecheck 流（cloud-platform/PLAN.md §0 原文「不进入 Orca 根工程 lint / typecheck 流程」；`check-changed-code-quality.mjs:11` 的忽略前缀同证）。实测用根 oxlint 配置直喷 server.ts 会报 89 项（max-lines 1、curly 53、no-useless-escape 31、no-unused-vars 4）——正因如此，**加 disable 才是真实风险**：根工程 `check:max-lines-ratchet` 用 `git ls-files` 扫**全仓** tracked `.ts`（含 cloud-platform），`config/max-lines-baseline.txt` 中 cloud-platform 条目为 0，任何一处 `eslint/oxlint-disable max-lines` 都会直接挂 CI。本提交 diff 内**无任何 lint 抑制注释**，server.ts 提交快照内也无 `max-lines` 字样。合规。
- **命名**：`browserHost` / `browserEntryUrl` / `browserEntryUrlFor` / `isBrowserHostForm` / `BROWSER_ROUTE_KEY_PATTERN` 全部是具体域名词，无 helpers/utils 类空名。合规。
- **注释密度**：新增注释全部是 WHY 型短句且各承载一个非显然决策（「Not sticky on purpose: an absent browserHost means the edge is off now.」「Empty rather than broken — …」「a scheme, path, or whitespace would move the entry onto an origin the relay never serves」）。合规。
- **类型断言**：生产代码零断言；e2e 内 `res.json() as X` 沿用该套件既有惯例（harness 系 e2e 一致写法），非本提交引入的模式。合规。
- **diff 归属复核**（清单第 4 项，代理自述「已隔离」）：
  - **W3 的 `sessionPageUrl`：零混入。** `git log -S sessionPageUrl --all -- cloud-platform/apps/api/src/server.ts` 为空——server.ts 历史上从未有过该字段；W3 提交 `9ab4a04a909` 的 --stat 不含 server.ts（纯 web/renderer 侧）。W6b 的 projectView hunk 只新增 `browserEntryUrl` 一行，`hostStatus`/`hostMaintenanceReason` 等行均为上下文。
  - **format 噪声：少量存在（2 处源码 + 4 处测试重排）。** ① relay-nodes.ts:1 删去文件首空行；② relay-nodes.ts:60 `(existing?.host ?? '')` 补括号（Prettier 打印宽度产物，纯格式）；③ relay-nodes.test.ts 中 `moved` 赋值与 3 处 `assert.deepEqual(x.map(...))` 重排换行，共约 14 行非语义 diff。属于「跑了 pnpm format」的顺带产物，不污染语义，但严格按「W6b 仅平台字段」的 diff 卫生标准应属独立 format 提交。
  - **一处看似噪声、实为必需**：既有两条 `assert.deepEqual(parseRelayRegistration(...), {host, port})` 补写 `browserHost: undefined` ——`deepStrictEqual` 区分 own-property 存在性，不补则既有用例必红。这是契约钉而非噪声。
  - 其余三文件（server.ts、relay.ts、e2e 新文件）无格式化夹带；relay.ts 改动确为「注册一行 + 注释」共 6 行，符合令面「relay 侧注册一行」。

---

## 5. 测试质量

### 5.1 「23 例」的真实构成

`node --test test/relay-nodes.test.ts test/e2e/relay-browser-entry.e2e.test.ts` = 23 = **13 条既有单测 + 5 条 W6b 新单测 + 5 条 e2e**。交付摘要写作「W6b 单元 + e2e（5 用例…）tests: 23」容易读成 23 条新用例；**W6b 实际新增 10 条**（约 28 个断言）。

### 5.2 可变红性逐条推理（每条对准一个变异体）

| 用例 | 钉住的变异 | 可变红性 |
| --- | --- | --- |
| U1 合法 `host[:port]` 保留 + trim | 删字段/去 trim/拒端口形 | 强 |
| U2 缺字段/旧注册体/空白/非字符串 → undefined | 改成必填/类型强转 | 强 |
| U3 scheme/路径/空白/`:0`/`:99999` → undefined | **白名单整体移除或放宽**（U1 单独抓不住「全收」） | 强，与 U1 互补 |
| U4 首注册无 browserHost → `''` | 缺省改 `undefined`/`null` | 强 |
| U5 再注册未报 → 清空 | `?? existing?.browserHost` 粘连变异（核心意图） | 强 |
| E1 三中继 `/v1/relays`（宣告/浏览器开但未宣告/无浏览器模式） | relay 侧条件删掉（`options.browser` 门）、server 不回显、旧体兼容破坏 | 强 |
| E2 宿主 payload 合法拼出 + 带点空串 | `BROWSER_ROUTE_KEY_PATTERN` 删除/放宽、拼接格式 | 强 |
| E3 项目 payload 跟随宿主 | projectView 挂载点删除 | 强 |
| E4 `/connect` 同一入口 | connect 挂载点删除 | 强 |
| E5 无宣告平台上宿主/项目全空串 | 「无宣告也拿 host 顶上」类兜底变异 | 强 |

新用例全部对准真实变异体，无「恒真断言」；e2e 的 `waitForRelay` 15s 轮询、`before` 120s 预算、串行 describe 均稳妥。两处结构性弱点：**① 核心意图（关闭浏览器模式停止被推荐）只有单测级 U5，无线级钉**；**② e2e 的 in-process 中继在 announce 时直读 `process.env.RELAY_BROWSER_PUBLIC_HOST`（relay.ts:295）**，测试未对 runner 环境消毒——开发机/CI 若导出该变量，`quietRelay` 会带着它宣告，E5 假红且报错信息不指向根因（MIN-4）。另 `PUT /grants` 未断言 status，失败时会以 connect 403 的面目间接爆出（建议补一行断言）。

### 5.3 缺失的负向用例（建议清单）

1. **注册体带畸形 browserHost 走完整线**（`https://x`、`x:0`、`[::1]`、`x..y`、`-x`、超长串）→ `/v1/relays` 空串。当前白名单负向只在 parse 单测层，wire 层（readJson → parse → register → 回显）未钉。
2. **同一中继先宣告、后停止宣告**（两次 `POST /v1/internal/relay-endpoint`，第二次不带字段）→ `/v1/relays` 清空 + 宿主/项目入口变空串。这是工作令原话「关闭浏览器模式必须停止被推荐」的线级钉，也是「非粘连 vs host 粘连」对比的 e2e 证据。
3. **宿主不报 relayRoute（null）** 与 **无 directAddrs 回退到带点主机名的派生键** → 入口空串（`?? null` 与派生路径两条分支都没被任何用例走到）。
4. **全部中继超过 aliveMs 掉线时入口的行为**——现实现仍拼 URL（MAJ-1）。无论采纳哪种修法，都应有一条用例把该形态钉死，否则 MAJ-1 修复无回归保护。
5. **两个宣告中继时的优先级**（先注册者优先）——`find` 的选择语义无钉。
6. **端口边界 65535 收 / 65536 拒**（现测 `:99999` 覆盖了越界但没钉住上边界）与 **`:00001` 的不归一化行为**（钉住现状或修成归一化）。
7. **IPv6 字面量与下划线标签拒绝**——把部署限制钉进测试，防止将来「顺手放开」时无人察觉语义变化。
8. **`/v1/internal/relays` 带 browserHost**（管理台数据源，当前零覆盖）。
9. **跨组件对拍**：以 relay 的 `parseBrowserPath` 为 oracle，断言 `BROWSER_ROUTE_KEY_PATTERN` 收敛集合与其一致（e2e 工程已同时 import 两侧，成本一行），封 MIN-3 的漂移口。
10. （加固）`grants PUT` 的 status 断言，见 5.2。

---

## 发现清单

### MAJ-1（major）全中继掉线时，last-known 兜底为死边缘持续产出「可用」入口（server.ts:645-652 + relay-nodes.ts:69-73）

`healthy()` 为空（中继停机/重启/control channel 中断 >aliveMs）时 `chosen = all().slice(-1)`，而 `all()` 永不驱逐——宣告过 browserHost 的已死中继会**无限期**为每个宿主/项目拼出 `https://<死边缘>/h/<key>/web-index.html`。与提交自述「Empty string over a dead link」及 e2e 头注释「must stay an empty string, never a dead link」直接相悖；单中继真实链路部署（deployment-real-link 的形态）里这是**常态故障形态**而非边角。与 `relayEndpointsFor` 的差异在于后果：桌面端有探测 + 直连 failover 兜底，浏览器入口没有——用户拿到的是以可用姿态呈现的错误页。判定为 major 而非 blocker：当前无消费方（W6c/W7b 未落地），修复窗口充裕，但**必须赶在 W7b 把它接成可点击按钮之前**。修法二选一：① 入口拼装只认 `healthy()`（抖动期宁空勿死链，自愈 ≤2s）；② 保留 last-known 但加新鲜度上界（如 `now - lastSeenAt <= 2×relayAliveMs`）。若选①，N5 的「抖动期入口消失」即为接受的代价，需在注释里写明。

### MIN-1（minor）畸形 RELAY_BROWSER_PUBLIC_HOST 静默失效，无 warn、无审计、无回执（relay-nodes.ts:130-134；server.ts:2377-2400）

白名单外的值被 parse 置为 `undefined`，注册照常 200（`{ok:true,...}` 不回显 browserHost 是否被收），平台无日志，中继注册也无审计事件。`https://host` 是极自然的运维笔误，结果是浏览器入口全平台静默消失，只能靠「页面上没按钮」反向发现。与 W6a 审计 MIN-4（半配置静默禁用）同型。建议：parse 拒绝非法 browserHost 时 console.warn 一次 +（若补 N4 的审计）在 metadata 里记 `browserHostRejected`。

### MIN-2（minor）browserHost 无长度上限，可被复制进所有宿主/项目 payload（relay-nodes.ts:112-117）

300 字符乃至任意长度的 `[A-Za-z0-9.-]+` 串都收（实测 300 字符收下），随后进入注册表、`/v1/relays`、每条宿主与项目 payload。前提是持 internal-token 的调用方，故非安全边界；叠加 `readJson` 无请求体上限（server.ts:131-140，预存在、全平台一致）读作可靠性卫生问题。建议随 N1 一并加 `length <= 253`（DNS 域名上限）量级的闸。

### MIN-3（minor）routeKey 形状契约两份拷贝，无跨组件对拍（relay-nodes.ts:13 vs relay.ts:87）

api 与 relay 各持一份 `[A-Za-z0-9_-]+`，仅靠两侧注释互相引用。漂移的「平台收、中继拒」方向产 404 死链且无告警，并非全然 fail-closed。两部署件不共享包可以理解，但 e2e 工程已同时 import 两侧，一条对拍用例即可封口（见 5.3-9）。

### MIN-4（minor）e2e 依赖 runner 环境变量缺席，未消毒（test/e2e/relay-browser-entry.e2e.test.ts + relay.ts:295）

`quietRelay` 走 in-process `startRelay`，其 announce 分支直读 `process.env.RELAY_BROWSER_PUBLIC_HOST`；测试未在 `before` 里 `delete process.env.RELAY_BROWSER_PUBLIC_HOST`。环境耦合型假红：CI 干净，本机导出过该变量的开发者会看到 E5 莫名失败。同理建议给 `bareRelay` 注释说明其不读该变量是因为 `options.browser` 缺省短路。

### N1（note）白名单收下的「怪值」是死链面而非注入面

`..`、`a..b`、前导 `-`、尾点 `host.`、300 字符、`:00001`（不归一化，浏览器连 1 端口）。全部无法逃逸 authority/path，只产出解析不了的或指错端口的 URL。可选收紧：拒前导/尾随 `-` 与 `.`、拒连续点、长度上限、端口归一化。收益是把「运营笔误」从浏览器错误页提前到注册期告警（与 MIN-1/MIN-2 同一笔工作）。

### N2（note）IPv6 与下划线标签宣告不了，需写进部署文档

`[2001:db8::1]:443`、`_relay.example.test` 均置空。浏览器模式边缘因此只能是 punycode 域名/IPv4/IPv4:port。属 fail-closed 的能力边界，不是缺陷，但 deployment-real-link.md 应写明，避免 IPv6-only 部署排障半天。

### N3（note）browserEntryUrl 随 projectView 对所有可见项目者暴露，无 open 门控

能看到项目行的用户（无论有无 `open`）都能读到中继浏览器域名 + 该宿主的 routeKey，属轻微拓扑披露。与工作令「平台宿主/项目 payload 增 browserEntryUrl」一致，且 `/connect` 的 relay 端点（含 routeKey + sni）本就只发给有权限者、列表侧早有 hostName/hostStatus——判定与既有信息面同量级，记录即可；W7b 的按钮按 `open` 门控即可收口。

### N4（note）中继注册/宣告无审计事件

`/v1/internal/relay-endpoint` 全程无 `audit.append`，browserHost 的出现与消失不留痕。FR-4.12 修订要求可见性变化「在部署文档与审计语义中如实声明」；建议补一条 `relay_register`（metadata 含 browserHost 有无），同时顺带满足 MIN-1 的可观测性。

### N5（note）清空/消失窗口量化

关闭浏览器模式：≤2s（跟随 announce 节奏）即从新响应消失，已渲染页面持有旧值至刷新（无推送失效）。控制面抖动 >aliveMs：入口会**提前**消失（`live` 非空但无宣告者时 `find` 落空），自愈 ≤2s。两者都与 `relayEndpointsFor` 同语义；当前无消费方，实际影响为零，W7b 接线时按「点击时重取」处理即可。

### N6（note）diff 卫生

W3 `sessionPageUrl` 零混入（见 §4 复核）；format 噪声 = relay-nodes.ts 2 行 + relay-nodes.test.ts 约 14 行重排；`browserHost: undefined` 补写是 `deepStrictEqual` 的契约必需而非噪声；relay.ts 改动确为注册一行 + 注释。

### N7（note）「23 例」口径

实为 13 既有单测 + 5 新单测 + 5 e2e；交付摘要的表述易被读成 23 条新用例（见 5.1）。

### N8（note）max-lines 机制核查

无 disable（本提交与其余 4 文件均无抑制注释）；根 ratchet 全仓扫描 + 基线零 cloud-platform 条目构成硬闸；cloud-platform 豁免有 PLAN.md §0 文档背书。合规。

---

## 建议的后续动作（按优先级）

1. W7b 派发前修 MAJ-1（二选一修法 + 5.3-4 的回归用例）。
2. 一并落 MIN-1 + MIN-2 + N1（同一个白名单收紧 + warn + 长度闸的小提交）与 5.3-1/2/3 的负向用例。
3. 5.3-9 的跨组件对拍用例封 MIN-3；5.3-8 补内部视图断言。
4. 部署文档补 N2 的边缘地址形态限制；审计语义按 N4 补 `relay_register` 事件（可与 W6 伞任务的「如实声明」收口合并）。
