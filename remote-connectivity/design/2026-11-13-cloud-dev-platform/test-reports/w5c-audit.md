# W5c 审计报告（浏览器终端订阅票据重签）

- 审计人：独立审计代理（只读；未修改任何仓库文件，本报告为唯一产出文件）
- 日期：2026-11-14
- 审计对象：`a68a755488c`（fix(web): re-sign tickets for terminal subscriptions，8 文件 +762/−2）；无 amend，现行 HEAD（`ebf0162e58b`）中被审 8 文件与提交态一致（工作树唯一改动 `use-remote-browser-page-wheel.ts` 不在审计面）
- 对照基准：work-orders-2026-11-14.md §W5c、design.md §3.3-D6 / §4.3.2 / §6.1-6.2（凭证一次性）/ §8.4（并发上限）、PROGRESS.md「归属注记：a740b953faf」（`621dde0a379`）、AGENTS.md（复用优先 / 注释 / 命名 / 禁 max-lines / 类型断言 / 跨端 / 线兼容）
- 方法：只读 diff 审查 + 现行源码逐行核对（`web-runtime-client.subscribe` 子连接分支、`web-runtime-connection-transport` 拨号/重连、`cloud-session-limits`/`cloud-connection-sessions`/`ws-transport` 宿主会话槽、`cloud-agent-client.admit` jti 台账与 `replayed` 审计、`web-cloud-session`→`web-cloud-auth` 续期链、两条取票接线逐项对照）；本机实跑 6 个单测套件（22+48+16 例全绿）、oxlint（10 文件 0 告警）、max-lines ratchet（"no new bypasses"）、`tc:web` 绿；证据交叉印证 `cloud-platform/evidence/w5c-subscribe-ticket/`（双 runner 4/4、受影响 e2e 7 文件 11/11、流式回显 JSON）与 `w5c-verify/`
- 归属核对：`a740b953faf`（标题 docs，实含 5 个 W5c 传输层文件）逐文件核实——`web-runtime-client.ts`（re-sign 机制本体）、`web-runtime-session-client.ts`（类型搬迁 + 可选 `attachTicketReSigner`）、`preload-api/web-runtime-session.{ts,test.ts}` 与 `web-session-recovery.test.tsx`（仅 import 路径）；本提交补齐其余 8 文件。**衔接与提交消息/PROGRESS 注记声明一致。**

## 结论

**有条件通过（D6 一次性语义未被削弱、无 signer 快速失败彻底；1 条 major 为重签路径绕过 AC-29 主机键钉扎，应在收口前补一行校验）**：blocker 0、major 1、minor 6、note 10。

核心判定：**修法选对了分支**。工作令明确「每条子连接向平台重签一张短票（不动宿主 D6 安全回归）」，实现正是消费端重签：被审 8 文件零宿主/平台改动，宿主 jti 一次性台账、`replayed` 审计、`verifyClient` 拒绝链逐行未动；新增**负向对照测试**（重签器故意退回已花票据 → 真 ws 宿主按一次性语义拒绝、订阅失败）把「D6 未被客户端说服」钉成可回归断言。e2e（真平台 + 真 TLS Runtime + 真 PTY，Bun/node 双 runner）实证：每条订阅恰好一次 `/connect` 取票、子连接各带 `orca-cred.ticket-N`、宿主审计零 `connection_rejected`，scrollback + 实时回显真到达面板。

---

## 1. 安全（重签路径 / 快速失败 / 重放面 / D6）

### 确认的正确面

| 项 | 证据 |
| --- | --- |
| 重签走完整认证 | `requestCloudPairingOffer` → `requestCloudTicket` → `sendAuthorized`（web-cloud-session.ts:72-77）→ 有 `auth` 时 `authorizedRequest`：`ensureFresh()`（lead 窗口预刷新）+ 401 强制刷新重试一次（web-cloud-authorized-request.ts:8-23），刷新单飞（`pending` 复用，web-cloud-auth.ts:111-125）。捕获的 `session` 是活对象，`auth` 内部持最新 token，平台轮换后无需重建闭包 |
| 无 signer 快速失败彻底 | `subscribe` 只在 `pairing.cloud` 为真时取签（web-runtime-client.ts:139-141）；`offerForNextConnection` 无 signer 抛错于**拨号之前**——测试断言 `fakeSockets` 数量不变（未开任何 socket、未花任何票据），signer 自身失败原样透传为订阅失败（`'platform session expired'`）。全部云客户端构造点排查：两处接线已挂签；`WebConnect.tsx:73`/`web-runtime-environments-api.ts:80` 的 pairing-code offer 无 device secret 时**构造即抛**（`resolveWebCloudDeviceSecretKey`，web-cloud-device-key.ts:116-118）；preload 会话层对已花票据环境直接 `cloudSessionEndedError`（web-runtime-session.ts:206-212、getClientForEnvironment 同守卫）——**无任何云路径能带着花掉的票据拨号** |
| 子 socket `reconnect:false` 收敛重放面 | 修复前子连接复用已花票据且**默认自动重连** → 每次被拒后再拨同票，是对宿主的无终结重放循环（每次都写一条 `connection_rejected/replayed` 审计）。修复后 `signed ? { reconnect: false } : {}`（web-runtime-client.ts:146）：子 socket 从不自动重拨，恢复只能经调用方重订阅 = 新票。e2e 宿主审计零拒绝即此收敛的实证 |
| D6 未被削弱 | ① 8 文件无宿主/平台文件；② 负向对照：`still refuses a replayed ticket` 用真 ws 宿主（每凭证只准入一次，二次拨号回 401 + `x-orca-reject: replayed`）+ 退回已花票据的重签器 → `refused === ['parent-ticket']` 且订阅失败；③ 协议级断言：两张子票 `['orca-cred.ticket-1','orca-cred.ticket-2']`，父票据不出现在任何子连接；④ e2e `replayedRefusals === []`，且过滤器非虚设——平台 `host-audit-ingest.ts:94-101` 确把 `reason` 写进 `metadata` |
| 旧票不入存储 | 重签结果仅存内存 holder；存储环境仍只含父 offer（`cloudLoginRequired: true`）；e2e 证据只记 URL+时间戳，不落凭证（§6.2「不落日志、不写磁盘」） |
| 线兼容 | 客户端侧改动；`orca-cred.<jwt>` 子协议形状、`/connect` 请求体、opcodes 全部不变。旧客户端（仍复用父票）行为不劣化（依旧被拒，即 U14 原状）；旧宿主 + 新客户端不受影响（D6 语义未变） |

### 发现

**MAJ-1（major）重签票据绕过 AC-29 主机键钉扎：宿主被换键后，存活会话的终端流可静默流向新键持有者**

- `BrowserProjectConnections.open` 在开连接前用 `webHostKeyVerdict` 做 TOFU 钉扎，键变化 → `FINGERPRINT_MISMATCH` 拒绝（cloud-browser-project-connections.ts:125-165）；**全仓唯一调用点就是这一处**（grep 证实）。两条取票接线的重签器（含 bridge 这条）只做 `requestCloudPairingOffer`，对新票的 `host.e2eePublicKeyB64` **不做任何钉扎比对**。
- 攻击面成立链路：宿主 E2EE 公钥由 Agent 心跳自报（design §4.3.3「Runtime E2EE 公钥」），节点登记是自助式——被入侵的宿主可重报新键并让平台为新键出票。下一次 `open` 会被 AC-29 拦下，但**已存活会话**的每条新订阅会带着新票 + 新 host key 建链：E2EE 握手与 `e2ee_auth`（含 `deviceToken`）都对新键完成，终端流、后续设备凭证全部流向换键方，客户端零告警。
- 这是本提交新开启的路径（修复前子流根本建不起来），因此按「新增路径绕过既有安全检查」计 major，而非既有债。
- 建议一行收口：在 `offerForNextConnection`（或重签器闭包内）比对新 offer 的 `publicKeyB64` 与父 offer/钉扎值，不一致即 fail-closed（与 `open` 路径的 `FINGERPRINT_MISMATCH` 同语义）。同时补一条负向测试（重签返回异键 → 订阅失败、零拨号）。

**MIN-1（minor）legacy「reuse and internal reconnect 不变」的断言强度不足以支撑提交消息的声明**

- 提交消息称 "Legacy ticketless offers keep today's reuse and internal reconnect"。代码层成立（`signed` 为 null 时条件展开等价旧构造、且 legacy 分支不在 `await` 之前引入异步——注释也如实说明了这一点）；但新测试 `keeps the legacy (ticketless) offer behaviour and signs nothing` 只钉了「signs nothing + 子 socket 打开」，**未**断言子连接仍无子协议拨号、仍继承父 offer 对象、仍保留内部重连。既有 `web-runtime-client.test.ts` 亦无「子 socket 掉线后重拨」用例。未来若有人给 legacy 子连接加 `reconnect:false`，无测试会红。

**MIN-2（minor）§8.4 会话槽预算：每条订阅占 1 槽，同项目第二浏览器视图必然撞 4431，且该路径无测试**

- 宿主按**活 socket**计槽（cloud-session-limits.ts 头注释「counts live sockets rather than tickets」，`MAX_SESSIONS_PER_USER_PROJECT = 3`），token 每票唯一 → 父连接 + 每条订阅流各占 1 槽。单项目单视图 = 2/3（余量 1）；同用户同项目开第二个浏览器视图：父连接占满第 3 槽，其终端流第 4 槽被 `rejectNodeWebSocketOverSessionLimit`（4431）关闭，面板按有界重试烧 5 张票（500ms→8s）后进 `failed` 态。PROGRESS 已把「每条流式订阅占一个会话槽」如实记为观察项，故只计 minor；但 4431 → 面板 `failed` 这条降级链端到端无测试（现有 e2e 都是串行订阅、峰值 2 槽）。

**MIN-3（minor）e2e 的宿主拒绝断言只过滤 `replayed`，其余拒绝原因不拦截**

- `replayedRefusalEvents` 按 `metadata.reason === 'replayed'` 过滤（与工作令「宿主侧无 replayed 拒绝」字面一致），`host_revoked`/`credential_missing`/会话超限等任何其它拒绝都不会让用例变红。当次实跑 `hostConnectionRefusals` 为空（证据 JSON），但**提交态断言**弱于「零拒绝」。同成本改成全量 `expect(...).toEqual([])` 更强。

**MIN-4（minor）无「两条订阅并发取签」的用例**

- 全部新用例都是先 `await` 上一条订阅再发起下一条；两条 `subscribe` 并发在途（各自 `offerForNextConnection` 同时取签）未覆盖。并发是该机制的正确性前提（每条连接各需一票、不得串票），FakeWebSocket 套件加一个 `Promise.all` 用例成本很低。

**MIN-5（minor）新测试 2 处 `(error as Error).message` 无 SAFETY 注记**

- web-runtime-client-ticket-resign.test.ts:190、218。AGENTS 要求「不可避免cast 需行级 SAFETY 说明」，且此处可避免：`error` 来自 `then(…, (reason: unknown) => reason)`，可改 `expect(pending).rejects.toThrow('platform session expired')` 或 `String(error)`。oxlint 未拦（`consistent-type-assertions` 只限对象字面量），属成文规则偏离。非测试代码零断言。

**MIN-6（minor）a740b953faf 与 621dde0a379 两个中间提交不可构建**

- `a740` 的 `web-runtime-client.ts` 已 import `./web-runtime-child-ticket-offers`，该模块（与 `web-cloud-connection-offer.ts`）直到 `a68a755488c` 才入树（`git ls-tree` 双向核实）——`tc:web`/web 测试套件在这两个修订上必然 module-not-found，mainline 二分跨 `a740..621d` 即断。与 W5b 审计 MAJ-2 同型，但本次**已在提交消息与 PROGRESS（`621dde0a379`）双重披露、且明示「停止历史手术」的原因**（与在途代理抢索引），处置符合 W5b 审计建议的先例路径，故降计 minor。建议在 PROGRESS 该注记补一句「`a740`–`621d` 区间不可构建，二分请跳过」。

## 2. 一致性（两处接线 / legacy / 类型放宽）

### 确认的正确面

| 项 | 证据 |
| --- | --- |
| 两处接线语义一致 | 同一 helper `requestCloudPairingOffer(session, projectId, devicePublicKeyB64, {fetchImpl?, endpointUrl?})`；选项形状逐字段相同（web-cloud-connect.ts:238-243 vs cloud-browser-project-connections.ts:96-101）；都在客户端构造后、首个 RPC 之前挂签；都绑定「本连接所属的 session + project + 设备公钥」，与各自父票选项（endpointUrl 透传）完全镜像 |
| 覆盖全部三个入口 | 密码登录（`connectCloudProject`）、handoff 交接码（web-cloud-handoff-entry.ts:214）与 M62 恢复都经 `connectCloudProjectWithSession` → 统一获得重签器；管理台走 bridge 接线。无第四条云入口 |
| legacy 不变的代码事实 | `signed ?? this.pairing`：legacy 子连接构造参数与旧版逐字段等价（`{deviceSecretKeyB64}` 或 `{}`），`reconnect` 不设 → 行为不变；`files.watch` 共享连接分支在云分支之前返回，不取票（正确：共享连接无新升级、无新凭证需求） |
| bridge-replies 类型放宽兼容 | `attachTicketReSigner?` 与 `subscribe?` 同型（脚本替身可省略）；`WebRuntimeSessionClient.attachTicketReSigner?`（a740）链上一致；唯一调用方用 `?.`；`subscribeOverConnection` 对缺 `subscribe` 返回 `STREAM_UNSUPPORTED`、对抛错包成 `STREAM_FAILED`——替身实现零破坏。客户端内存类型新增可选字段，**无任何线上协议变化** |
| 失败语义闭合 | signer 抛错 → 订阅原样失败（测试钉死消息透传）→ bridge 包 `STREAM_FAILED` → 面板进有界重连；平台 `SESSION_EXPIRED` 从取票路径可透传（web-cloud-session.test.ts 新用例）。降级始终 fail-closed，无「静默复用」回路 |

### 发现

**N1（note）两处接线的会话时效语义有一个已存在的非对称**

- web-cloud-connect 的父客户端 `reconnect:false`（"a probe that keeps retrying would hide a dead ticket"，web-cloud-connect.ts:131-133）；bridge 的父客户端默认重连（cloud-browser-bridge.ts:77-78）→ 掉线后**父连接会拿自己的已花票据重拨**，被 `verifyClient` 拒（不占槽、不成功重放），按 500ms→15s 有界退避循环，直到 2s `sweep()` 摘除该 entry 触发上层重开。系既有行为、本提交未触碰；子连接已收敛而父连接未收敛的非对称值得后续工单统一。

**N2（note）重签器绑定的 session 是「开连接那一刻」的引用**

- bridge 侧闭包捕获 `getSession()` 当时的对象；若此后整体重登录产生新 session 对象，旧闭包续期会失败 → `SESSION_EXPIRED` → 订阅快速失败（fail-closed，可用性问题非安全问题）。`authorizedRequest` 的单飞 + 401 强制刷新已覆盖「同一 session 内的常规轮换」。

## 3. 资源（§8.4 上限 3 / 重连风暴 / 降级）

### 确认的正确面

| 项 | 证据 |
| --- | --- |
| 配额语义 | 槽按活 socket 计、每票 token 唯一（cloud-session-limits.ts:12-18 注释与实现一致）；同 token 重开替换不叠占（`tryOpen` 先查 `has`），拒绝路径不注册 release、不占槽（ws-transport.ts:276-284：`accept` 失败直接 return）；4431 关闭不消耗槽，但**该票已被 jti 台账记账**（admit 在 gate 之前）——撞上限的重试每轮烧一张票，无安全影响 |
| 重连风暴有界 | 子 socket `reconnect:false`（不自动重拨）；面板有界重试 `RECONNECT_DELAYS_MS = [500,1_000,2_000,4_000,8_000]` 共 5 次后 `failed`（cloud-terminal-panel.tsx:53、293-301）；epoch 机制保证被取代/已卸载的流仍释放子 socket（"A superseded stream must still release its child socket"）。每轮重试恰一次取签（e2e `=== 1` 断言），无无界取签/无套接字泄漏 |
| 取签失败不占资源 | signer 抛错在拨号前返回 → 零 socket、零槽、零 jti 记账（单测断言 socket 数不变）；票据 60s 自过期，中断的取签最多浪费一张短票 |
| 面板单流 | `cloud-project-workspace.tsx` 每工作区视图仅一个终端面板；`files.watch` 走共享父连接不占槽。单视图稳态 2/3 槽（见 MIN-2 的第二视图边界） |

### 发现

**N3（note）撞 4431 的客户端体验是「有界重试 → failed」，未映射为可读的「会话数超限」**

- 4431 关闭对客户端表现为裸 socket close（无 text frame），面板按普通掉线重试 5 轮（每轮烧一票）才报 `failed`。功能成立、成本有界；若后续把 close code 映射进 `code`，可省掉这 5 轮。与 MIN-2/MIN-3 一并处置即可。

## 4. 规范与归属

**N4（note）8 文件归属逐一核实，a740 衔接如声明**

| 文件 | 归属 |
| --- | --- |
| `cloud-admin/cloud-admin-session.e2e.test.ts`（+231） | 工作令「测试」交付：W5c-1 订阅建立 / 恰一次取票 / 零 replayed / 真 PTY 流式回显 / 二次订阅重签 |
| `cloud/cloud-browser-bridge-replies.ts`（+2） | bridge 客户端类型面：可选 `attachTicketReSigner` |
| `cloud/cloud-browser-project-connections.ts`（+9） | 管理台入口接线（session/project/fetchImpl/endpointUrl 绑定） |
| `web/web-cloud-connect.ts`（+12/−2） | 登录/handoff/恢复入口接线 + `WebRuntimeSessionClient` import 随 a740 搬迁 |
| `web/web-cloud-connection-offer.ts`（新 26） | 取票+组 offer 共享 helper（两入口复用，避免重复实现）——**复用优先符合** |
| `web/web-cloud-session.test.ts`（+43） | `requestCloudPairingOffer` 单测（两调用两票、失败透传） |
| `web/web-runtime-child-ticket-offers.ts`（新 46） | 客户端重签持有器（attach-once / 快速失败 / signal 感知） |
| `web/web-runtime-client-ticket-resign.test.ts`（新 395） | 传输层行为测试（FakeWebSocket + 真 ws 一次性宿主 + 负向重放对照） |
| （a740 侧）`web-runtime-client.ts`、`web-runtime-session-client.ts`、`preload-api/web-runtime-session.{ts,test.ts}`、`web-session-recovery.test.tsx` | 提交消息归属注记与 `621dde0a379` PROGRESS 裁定一致；内容确为 W5c 传输层半成品 |

**N5（note）max-lines 合规**

- 被审 8 文件零 `max-lines` disable；`check:max-lines-ratchet`："OK — 7 grandfathered suppression(s), no new bypasses"。新测试 395 行、e2e 744 行（预算 800 计数行，skipComments/skipBlankLines 后更低）；两个新模块 26/46 行（预算 300）；`web-runtime-client.ts` 342 原始行（a740 改动，计数行在 300 内，oxlint 通过）。

**N6（note）命名与注释**

- 新名全部具体域名词：`WebRuntimeTicketReSigner`/`WebRuntimeChildTicketOffers`/`requestCloudPairingOffer`/`web-cloud-connection-offer`——无 helpers/utils 类。注释全部 why-向且一行级（如「Why no reconnect on a ticketed child: its ticket burned at this upgrade…」「Why branch before awaiting: a legacy offer signs nothing…」）。唯一小瑕：`web-runtime-child-ticket-offers.ts` 类型 doc 与类 doc 重复陈述同一条「单票已花」理由（可并入一处）。

**N7（note）其余 AGENTS 项干净**

- 复用优先：signal 感知等待复用 `waitForPromiseWithSignal`/`throwIfSignalAborted`，取票复用 `requestCloudTicket`+`cloudPairingOfferFromTicket`，未造平行实现。
- 跨端/SSH/文件夹工作区：纯 renderer web 传输层，无平台分支、无路径假设、无 SSH 面；mobile 栈不用该客户端（grep 证实）。
- 线兼容：无新 opcode、无 RPC 参数变化、平台 `/connect` 请求体不变——「新可选字段」级以下（纯客户端内部）。

**N8（note）本机复跑实证**

- 单测：`web-runtime-client-ticket-resign` + `web-cloud-session` 22/22；legacy 与桥回归 6 文件 48/48；`web-cloud-connect` + `cloud-terminal-panel` 16/16。
- 静态：oxlint（8 个被审文件 + client + session-client）0 告警；`tc:web` 绿。
- 证据目录 `cloud-platform/evidence/w5c-subscribe-ticket/`（按仓惯例 gitignore 未入库，与全部 evidence 一致）：`01` Bun 4/4、`02` node 4/4、`03` 受影响 e2e 7 文件 11/11、`w5c-subscribe-ticket-stream.json`（2 次取票、零拒绝、真回显 marker、`runnerPtyProducedOutput: true`）；`w5c-verify/02` 15 文件 111/111。

**N9（note）PROGRESS 计数与证据小出入（ Cosmetic）**

- 「新增 6 例单测」实为 8（transport 6 + session 2）；「受影响 115/115」与 `w5c-verify` 日志 111 不符（可能并入 e2e 4 例的口径差）。不影响结论，建议下次记录时对齐。
- `03-affected-e2e-suites.log` 只留 vitest 汇总，未列出具体 7 个套件名，弱化「既有一次性票据回归全绿」的可追溯性。

**N10（note）工作令交付项核对**

| 令条要求 | 交付 |
| --- | --- |
| 每条子连接重签一张短票（选重签、不动宿主） | ✔ 宿主零改动；`requestCloudPairingOffer` 每订阅一票 |
| 测试：订阅建立成功 | ✔ e2e W5c-1 `outcome.ok` + 单测（FakeWebSocket 与真 ws 双层） |
| 宿主侧无 replayed 拒绝 | ✔ 审计断言 + 证据 JSON 零拒绝（过滤器范围见 MIN-3） |
| 流式输出到达面板 | ✔ scrollback + `data` 回显经新签子连接，双 runner 真 PTY |
| 既有一次性票据回归全绿 | ✔ 受影响 111 单测 + 7 e2e 套件 11/11（套件名未留痕，见 N9） |
| 证据 `evidence/w5c-subscribe-ticket/` | ✔（4 件） |
| 提交名 `fix(web): re-sign tickets for terminal subscriptions` | ✔ 逐字一致 |

## 证据索引

- `cloud-platform/evidence/w5c-subscribe-ticket/`：01/02（Bun、node 双 runner 4/4）、03（受影响 e2e 7 文件 11/11）、`w5c-subscribe-ticket-stream.json`（恰 2 次取票、`replayedRefusals: []`、`hostConnectionRefusals: []`、真回显）
- `cloud-platform/evidence/w5c-verify/02-affected-vitest-unit.log`：15 文件 111/111
- 代码锚点：`src/renderer/src/web/web-runtime-client.ts:137-153`（子连接分支）、`src/renderer/src/web/web-runtime-child-ticket-offers.ts`（重签持有器）、`src/renderer/src/web/web-cloud-connection-offer.ts`、`src/renderer/src/web/web-cloud-connect.ts:236-243` 与 `src/renderer/src/cloud/cloud-browser-project-connections.ts:94-101`（两处接线）、`src/main/cloud-platform/cloud-session-limits.ts` + `cloud-connection-sessions.ts` + `src/main/runtime/rpc/ws-transport.ts:270-286`（§8.4 槽）、`src/main/cloud-platform/cloud-agent-client.ts:286-320`（jti 台账 + `replayed` 审计）、`cloud-platform/apps/api/src/host-audit-ingest.ts:84-101`（`metadata.reason`）
- 归属：`a740b953faf`（5 传输文件）、`621dde0a379`（PROGRESS 归属裁定）

## 处置建议（按优先级）

1. MAJ-1：重签 offer 的 host key 与父 offer/钉扎值比对，不一致 fail-closed（一行 + 一条负向测试）。
2. MIN-2/MIN-3：e2e 拒绝断言改全量零拒绝；补一条同项目第二视图撞 4431 → 面板 `failed` 的降级用例。
3. MIN-4：补两条订阅并发取签用例（`Promise.all`）。
4. MIN-1：为 legacy 子连接补「无子协议拨号 + 内部重连保留」断言（或至少钉 `reconnect` 未设）。
5. MIN-5：测试内两处 `as Error` 改 `rejects.toThrow(...)`。
6. MIN-6/N1/N9：PROGRESS 注记补「a740–621d 不可构建」一句；父连接重连非对称与 4431 映射挂后续工单；下次记录对齐计数。
