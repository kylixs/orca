# W6a 审计报告（中继浏览器模式监听）

- 审计人：独立审计代理（只读，未修改任何仓库文件）
- 日期：2026-11-14
- 审计对象：`a9e1fc5e96e`（feat(relay): browser mode listener with path routing；工作区与该提交在 3 个涉及文件上零差异，审计对象即现行代码）
- 对照基准：work-orders-2026-11-14.md §W6a、web-index-adaptation-plan.md §4.2/§5、design.md §4.3.2、AGENTS.md（复用优先/注释风格/命名/禁 max-lines/类型断言）
- 方法：只读 diff 审查 + 现行源码逐行核对；复跑被审套件与既有 16 条 relay e2e；另以 4 个一次性探针脚本（/tmp，已脱离仓库）对解析绕过面、hop-by-hop、半开连接、证书失败做实测，并与测试代理证据 `cloud-platform/evidence/w6a-verify/`（probe-a/a2/b/c/d/e/f、wire-compat-*）交叉印证。

## 结论

**有条件通过（不阻塞 W6b/W6c 派发）**：blocker 0、major 2、minor 6、note 8。

功能与安全语义方向正确：解析面实测全部 fail-closed（%2F/大小写/绝对形式/CRLF/超长 key 均 404），路由查找是精确 `Map.get`（不存在 `ip-a` vs `ip-ab` 前缀歧义），未知路由与 stale 表都拒绝而非黑洞放行；hop-by-hop 剥离、XFF 追加、101 头透传、双向 pipe 背压实测正确；未配置时零监听零日志，SNI 既有 16 条 e2e 全绿。两条 major 是**容量/健壮性**缺口（半开上游 socket 泄漏、浏览器监听无 per-IP 上限），不影响 W6a 功能正确性，但应在浏览器边缘真正面向不可信流量（W7b/W9b 黄金线）之前修复。

---

## 1. 安全审计

### 实测确认的正确面（探针证据，非推理）
| 项 | 结果 |
|---|---|
| `/h/w6a%2Fhost/x`（编码斜杠）、`/h/W6A-HOST`（大小写）、`/h/w6a-host`（无尾斜杠）、`http://evil/x`（绝对形式）、`/h/w6a%0d%0a-host`（CRLF）、`/h/`+4KB key、`/h/%2e%2e`、`/h//x` | 全部 404。`req.url` 不做百分号解码，`BROWSER_ROUTE_KEY=/^[A-Za-z0-9_-]+$/`（relay.ts:83,115）兜底；`separator <= 0`（relay.ts:113）同时挡空 key 与纯 `/h/` |
| `ip-a` vs `ip-ab` | 不存在歧义：`routes.get(parsed.routeKey)`（relay.ts:383,438）精确匹配，无 startsWith/正则前缀 |
| 请求 hop-by-hop | `te`/`proxy-authorization`/`keep-alive` 未达宿主；`x-forwarded-for: 9.9.9.9` → 宿主收到 `9.9.9.9, 127.0.0.1`（追加非替换，与 probe-b-xff-chain.json 一致） |
| 响应 hop-by-hop | 宿主回的 `proxy-authenticate`/`trailer` 未达客户端（`forwardableResponseHeaders`，relay.ts:134-141） |
| TE 走私面 | 无：中继剥 `transfer-encoding` 后由 Node 解码请求体再重帧（chunked 请求 → 宿主收到完整 `chunk-one-chunk-two`）；llhttp 拒绝 CL+TE 并存，入站无歧义帧 |
| 101 透传 | 客户端收到 `Upgrade/Connection/Sec-WebSocket-Accept` 完整（relay.ts:143-150 `keepAll` 分支），101=握手的例外有 WHY 注释（relay.ts:145-146） |
| 凭证/负载入日志 | 无：`record()` 只存 sourceIp/sni/routeKey/target/outcome（relay.ts:188-192），事件与 console 输出均不含头、体、URL、令牌；evidence 文件同样干净 |

### 发现

**MIN-2（minor）`Connection` 命名头未剥离**（relay.ts:120-131）
RFC 7230 §6.1 要求把 `Connection` 列名指向的头一并按 hop-by-hop 处理；实现只剥固定集合。实测 `connection: x-probe-named` + `x-probe-named: leak-me` → 宿主收到 `x-probe-named: leak-me`。本中继不缓存、宿主与客户端同信任域，实际风险低，但属代理语义偏差，建议把 `Connection` 列名并入剥离集合。

**MIN-3（minor）升级路径整组跳过 hop-by-hop，而非只保 Connection/Upgrade**（relay.ts:123,451）
`keepUpgrade:true` 时 `proxy-authorization`/`te`/`trailer`/`keep-alive` 原样转发到宿主 hop——与普通 HTTP 路径行为不一致；`proxy-authorization` 是凭证头，客户端本意是给代理的。建议白名单式：升级路径只保留 `connection`/`upgrade`/`sec-websocket-*`，其余照剥。

**MIN-4（minor）半配置静默禁用 + 失败时序**（relay.ts:160-169,368-369,484）
只设 `RELAY_BROWSER_TLS_CERT` 不设 KEY → 浏览器模式静默关闭，无任何 warn，运维无从发现；证书文件不可读 → `readFileSync` 在 SNI `listen()` 之前抛出（实测 `startRelay` 以 ENOENT reject，无半启动监听——这点是好的），但配错浏览器证书会拖垮本可健康的 SNI 模式，且 relay.ts:261 的 2s 同步 timer 已创建，进程内调用方会泄漏 timer。`browserServer.listen` 无 `error` 监听（EADDRINUSE → uncaught exception），与既有 SNI listen 同型，属沿用惯例。

**N2（note）`..` 点段原样透传**（relay.ts:116；probe-a2-path-after-key-raw.json 同证）
`/h/w6a-host/../../../etc/passwd` → 宿主收到原样路径并 200。仅限同一 routeKey 内，不构成跨宿主越权；浏览器发送前已归一化。中继定位是哑转发器，记录在案即可。

**N3（note）design.md §4.3.2 声明与实现的一致性**
「可见传输层头部与路径、E2EE 载荷不可读」与实现一致：中继终结 TLS 后技术上可见**全部明文请求头**——含 `Cookie`/`Authorization` 等凭证头——但代码不读不记（record 只元数据），载荷机密性由 web 客户端应用层 E2EE 保证（AC-24，属 W6c/W7 范围）。两点需在收口时落实：① 部署/审计文档把「凭证级请求头对中继明文可见」写明，不要只写「传输层头部」；② W6 工作令要求的「中继可见传输层头部、E2EE 载荷不可读」确认点未出现在本提交信息中，属 W6 伞任务交付说明的收口项，勿遗漏。

**N4（note）`rejectUnauthorized: false`**（relay.ts:404-406,453）
宿主 hop 不验证证书，与 SNI 模式既定边界一致（design.md §4.3.2「主机身份固定由客户端 TOFU；中继只保证只转发到已注册目标」），且有 WHY 注释，判定合规。

## 2. 可靠性

**MAJ-1（major）半开请求/半开升级的上游 socket 泄漏**（relay.ts:396-420,423-478）
- 升级路径：`teardown`（双向销毁）只在 `upstream.on('upgrade')` 内注册（relay.ts:460-467）；101 到达之前客户端消失时，没有任何东西销毁已发出的 `upstream`（relay.ts:477 `upstream.end(head)` 无条件发出请求）。
- 普通 HTTP 路径：`req.pipe(upstream)`（relay.ts:420）不传播 abort，`req`/`upstream` 之间无中断联动。
- 实测：客户端在 101 前断开 ×5 → 宿主侧 5/5 上游连接滞留（1.5s 后仍在）；POST 半体断开 ×5 → 再滞留 5/5。合计 10 条悬空。远程侧 headersTimeout（60s）/requestTimeout（300s）最终兜底，故非 blocker；但浏览器刷新/关页/WS 重连风暴期间（尤其宿主变慢时）会稳定堆积，且 `stats.active` 只统计 SNI 监听（见 MAJ-2），中继自身指标完全看不见。对照：SNI 透传模式靠 raw-TCP pipe 的 end 语义天然传播 FIN，无此问题。
- 修法方向（回派实现代理）：升级路径在创建 `upstream` 的同时挂 `clientSocket.once('close'/'error', () => upstream.destroy())`；HTTP 路径 `req.on('aborted'/'error', () => upstream.destroy())`，或改用 `pipeline`。

**MAJ-2（major）浏览器监听无 per-IP 并发上限、不进 active 统计**（relay.ts:479-483 vs 270-286）
`maxConnectionsPerIp` 只在 SNI 监听的 connection 处理器里生效；浏览器监听的 connection 处理器只做 `inbound.add`，既不限流也不计数。design.md §4.3.2 把「单 IP 并发默认 100」列为中继边界属性，而浏览器边缘恰是唯一面向不可信浏览器的监听。与 MAJ-1 叠加后，单 IP 即可低成本制造宿主侧 socket 堆积。修法：复用同一 `perIp` 计数与 `drop()` 语义（超限 503/429 而非 destroy），并把浏览器连接计入 `stats.active`。

**MIN-1（minor）stale 表时升级路径答 404 而非 503**（relay.ts:431 vs 379）
HTTP 路径 `stale ? 503 : 404` 是对的；升级路径 `refuse()` 硬编码 `HTTP/1.1 404 Not Found`，把「路由表过期、稍后重试」谎报成「无此主机」。测试代理 probe-d-stale-route-table.json 已独立记录同一偏差（`staleUpgradeStatus: 404`）。fail-closed 方向没错，仅口径不一致，建议 refuse 接受状态码参数。

**MIN-5（minor）宿主拒绝升级（非 101）只转发头不转发体**（relay.ts:471-475）
`upstream.on('response')` 写完 raw head 即 `end()`，宿主随 4xx 附带的说明体丢失；且该 raw head 经 hop-by-hop 过滤后不含任何 `connection` 头，却随即关连接——建议显式补 `connection: close`。对比：未知路由的 `refuse()`（relay.ts:431）是带 `connection: close` 的。

**其余确认**：双向 pipe 错误传播（101 之后）正确——任一端 error/close 双向销毁（relay.ts:460-467）；全链路 `.pipe()` 背压合规；abort 风暴 15 连发无崩溃、无 uncaught/unhandled（Node 24 服务端 abort 不上抛 req error，relay.ts 未挂的 req error 监听实测未成雷）；`handle.close()` 双向 resolve（SNI+browser 各调一次）无害，`inbound` 先销毁保证 close 能返回。

## 3. 线兼容（不启用时零行为差异）

- 提交对 SNI 透传路径**纯增量**：新增 browser 块、头部辅助函数、`RelayOptions.browser`、`RelayHandle.browserPort`、`browserOptionsFromEnv`；对既有代码仅触碰 `close()` 一行（`browserServer?.close(...)`，未配置时为 no-op）与 return 的 handle 字段。
- `browserOptionsFromEnv()`（relay.ts:161-169）三者缺一即 `undefined` → 不建监听、不打日志、不进 announce；announce 体（id/host/port）与既有一字不差（测试代理 wire-compat-diff.txt 印证：`browserListenerLinePresent: false`、announce body 一致）。
- 本审计复跑既有 relay 套件：relay-hardening / relay-failover / relay-endpoint-address / host-route-key-follow 共 **16/16 绿**，含「白名单内转发」「裸主机名拒」「异后缀拒」「多层子域拒」「未知路由黑洞」「非 TLS 拒」「单 IP 超限拒」「元数据不含负载」全部边界。
- `RelayHandle` 增字段为 additive：全仓无对 handle 整体的 `deepEqual` 断言（仅 events/ports 的深比较，均未触及），既有消费者只读 `port/routes/stats/events/close`。`RelayConnectionEvent`/`RelayStats` 形状零改动（relay-hardening:206 的事件键断言仍绿）。符合 AGENTS「新可选字段安全」的线兼容口径。

## 4. 规范符合性（AGENTS.md）

- 无任何 `max-lines` 禁用、无新增 lint 抑制（grep 证实）。
- 注释密度与风格合规：全部为简短 WHY——RFC 2616 依据（relay.ts:84）、101 例外原因（145-146）、`rejectUnauthorized` 的信任模型（404-405）、close() 收割语义（480）、env 三选一理由（160）。无过程复述。
- 命名具体：`parseBrowserPath`/`forwardedHeaders`/`forwardableResponseHeaders`/`allResponseHeaders`/`browserOptionsFromEnv` 皆以实际职责命名；测试替身 `relay-target-host.ts` 命名准确、职责单一（HTTP 回显 path/method/body/代理头 + WSS 回显帧，无多余杂务），符合「按内容命名、拒绝 helpers/utils」的要求。
- 测试文件 `JSON.parse(...) as HostView` 等裸断言沿用 e2e 套件既有惯例（platform.e2e.test.ts:106 同型），未新增 `as any`；仓库根 oxlint 的 `curly` 规则在新增行同样触发，但与该文件及 cloud-platform 既有大量行一致（提交前版本同样不合规），非本提交引入的回归，仅备注。

## 5. 测试质量

**6 条用例的防回归力（还原坏代码是否变红）**

| 用例 | 还原场景 | 是否变红 |
|---|---|---|
| 1 HTTP 剥前缀+XFF | 还原前缀剥离或 XFF 追加 | 红（断言 `path==='/web-index.html'`、`forwarded.proto/for/host`） |
| 2 WSS 双向 | 还原升级转发或破坏双向 pipe | 红（问候+回显双断言） |
| 3 未知路由 404（HTTP+升级） | 黑洞化/放行/改 503 | 红（断言双 404 且「不得 502」） |
| 4 非 /h/ 路径 | 前缀判断放宽 | 红 |
| 5 SNI 共存回归 | 破坏既有监听 | 红 |
| 6 未配置不启用（进程内 handle + 派生进程日志双证据） | 无条件启用 | 红 |

整体是真实三进程（平台+中继+宿主）、断言先固化前置（`registered.status===201`），质量合格。与工作令 §W6a 的四项测试要求（三进程转发伺服/未知 404/SNI 全绿/未配置不启用）一一对应；证据落 `cloud-platform/evidence/w6a-relay-browser/`（gitignored，6 json + 2 运行日志 + 汇总）。

**缺口（建议补的负向用例，本审计不实现）**

1. **hop-by-hop 剥离回归（最高价值）**：宿主回显断言 `connection`/`te`/`proxy-authorization`/`keep-alive` 不达 + XFF 追加而非替换。现状：整体删掉 `HOP_BY_HOP` 过滤，6 条用例全绿——MIN-2/MIN-3 及未来回归都无网。
2. **`parseBrowserPath` 单测矩阵**（函数已 export 却无任何单测）：`/h/<key>`（无尾斜杠）、`/h/KEY`（大小写）、`/h/a%2Fb`、`/h/../x`、`/h//x`、`/h/<4KB-key>/x`、绝对形式目标。防「顺手加 `decodeURIComponent` 或改 startsWith」式重构，这类改动今天不会红。
3. **stale 表双路径状态码**：HTTP 503 + 升级路径期望值（先定 MIN-1 的口径再断言，顺带锁住该不一致的修复）。
4. **上游失败**：宿主拒连/不可达 → HTTP 502（覆盖 `headersSent` 分支）+ 升级路径客户端 socket 销毁。
5. **带体请求**：POST body 与 chunked 请求经边缘转发（宿主已回显 body，无用例真正发体；测试代理 probe-c 已证 1MB 完整，宜收编为常驻断言）。
6. **半配置禁用**：只有 CERT 无 KEY、只有 PORT 无 CERT → `browserOptionsFromEnv` 返回 undefined，防三选一规则被放宽成「有啥用啥」。
7. **客户端中断的 socket 回收**：101 前断开 + 半体断开后宿主侧连接归零（防 MAJ-1 回归的唯一网）。
8. （若按 MAJ-2 补实现）浏览器监听 per-IP 超限拒绝。

另：用例 6 的派生进程负向断言靠固定 2.5s sleep（relay-browser-mode.e2e.test.ts:243-244），慢机上有漏检可能，可接受、不阻塞。

## 分级汇总

| 级别 | 数量 | 条目 |
|---|---|---|
| blocker | 0 | — |
| major | 2 | MAJ-1 半开上游 socket 泄漏（relay.ts:396-420,423-478）；MAJ-2 浏览器监听无 per-IP 上限且不进 active 统计（relay.ts:479-483） |
| minor | 6 | MIN-1 升级路径 stale 答 404 非 503（:431）；MIN-2 Connection 命名头未剥（:120-131）；MIN-3 升级路径整组跳过 hop-by-hop（:123,451）；MIN-4 半配置静默禁用+证书失败时序（:160-169,368,484）；MIN-5 宿主拒绝升级无体无 connection:close（:471-475）；MIN-6 drop 事件 routeKey 恒 null，丢排障信息（:378,389,430） |
| note | 8 | N1 解析面实测全 fail-closed；N2 `..` 段原样透传（同路由内）；N3 §4.3.2 声明一致但需写明凭证头可见性+补交付确认点；N4 rejectUnauthorized 合规；N5 hop-by-hop/背压/TE 重帧实测正确；N6 101 头透传正确；N7 线兼容证据齐（16 套件绿+additive handle+announce 不变）；N8 规范面合规（无 max-lines 禁用、WHY 注释、命名具体、替身单一职责） |

**回派建议**：MAJ-1/MAJ-2 与 MIN-1/MIN-3 可合为一次 `fix(relay): browser edge socket hygiene and per-ip cap` 回派实现代理；MIN-2/MIN-4/MIN-5/MIN-6 与上述测试缺口 1/2/3/7 可随同批或拆一后续小令。不阻塞 W6b/W6c 派发。
