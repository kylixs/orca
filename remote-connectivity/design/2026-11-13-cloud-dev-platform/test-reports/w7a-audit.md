# W7a 审计报告（平台 web handoff 端点）

- 审计人：独立审计代理（只读，未改任何文件、未复跑套件）
- 日期：2026-11-14
- 审计对象：`2f0b9657217`（feat(cloud): web handoff endpoints，4 文件 +692/−29：server.ts +227/−19、store.ts +27/−0、web-handoff.e2e.test.ts +406/−0、self-service-project-dir.e2e.test.ts +32/−10）
- 对照基准：work-orders-2026-11-14.md §W7a / §W7 / 附录「W7 设计要点」、requirements.md FR-3.10、design.md §12.1 handoff 两行、test-plan.md M122 行、AGENTS.md
- 方法：只读 diff 审查 + 现行 HEAD 源码交叉验证（server.ts 路由/守卫/handleConnect/审计链、store.ts、web-contract.ts、audit.ts、种子数据）+ 测试代理证据核对（evidence/w7a-handoff-api/ 7 份 JSON + 2 份运行日志，7/7 与 6/6 全过）。行号基于当前 HEAD（`2f0b9657217` 即本文件所涉提交）。

## 结论

**通过（带 1 项 major 需在 W7b 前裁定）**：blocker 0、major 1、minor 5、note 7。

安全基线成立：code 256-bit `randomBytes`、单次消费先删后校验（同进程原子）、TTL 60s 可注入、审计只落 64-bit sha256 指纹（不可反推）、撤权在换发侧收口（403 permission_lost）。契约无回归：`issueDeviceSession` 为登录路径逐字抽取，URL hash 形态与 FR-3.10 逐字一致，`HANDOFF_TTL_MS` 注入不漏默认值。唯一定向缺陷是**签发侧与换发侧的权限判定不一致**（详见 §5）：admin/审计员可为无 grant 项目签出一个「必然 403」的死 code，既偏离工作令「open 权限」字面，也会在 W7b 激活「Orca Web」按钮后变成管理员可见的死入口。

## 1. 安全（审计点①）

### 1.1 code 熵与指纹

- `randomBytes(32).toString('base64url')`（server.ts:2481）= 256-bit、43 字符 base64url 字母表（无 `=`/`&`/`#`），枚举不可行。
- 指纹 `sha256(code)` 截断 16 hex = 64-bit（server.ts:151-153）。**不可反推**：从 64-bit 前缀恢复 256-bit 原像需 2^256 量级枚举；指纹仅用于审计关联。碰撞按生日界约 4.3×10^9 个 code 才到 50%，现实审计量级下无歧义风险。`deny` 路径对攻击者任意输入同样记指纹（server.ts:980），无副作用。

### 1.2 内存 map 增长边界与 prune 时机

- `webHandoffs` 唯一写入点是 `handleWebHandoff`（server.ts:2482），唯一清理点是**每次签发前**的 `pruneExpiredWebHandoffs(now())`（server.ts:2480）；`consumeWebHandoff` 额外把被取用的条目（含已过期）删掉（store.ts:193、200）。
- 因此 map 稳态规模 ≤ 「最近 60s 内签发的 code 数」：签发者需通过项目守卫（认证 + open/管理门），未认证请求**不能**撑大 map；过期残留最多存活到下一次签发。无认证速率上限意味着持续高频签发仍可线性推高 map 与审计量（同 §1.4 的限流缺口），量级为每请求一条小对象，属低危。
- 无定时器依赖：一台再无签发的实例会保留过期条目（受历史活动上界约束），不构成实际泄漏。

### 1.3 换发是否绑定设备（未注册设备直通？）

`issueDeviceSession`（server.ts:589-601）语义与密码登录**完全一致**：换发方提交的 `deviceId` 只有在「属于该用户且未吊销」时才被复用，否则忽略并**新建**设备行（含 `devicePubKey`）。因此：

- 不会采纳他人设备（跨用户 deviceId 被忽略）、不会复活已吊销设备（`revokedAt` 检查）——「未注册设备直通」在这里的含义是：**持 code 即可得新设备会话**。这与密码登录一致（登录同样为全新浏览器自动登记设备），不构成相对回归；code 本身就是唯一凭据，风险由 60s TTL + 单次 + 仅经 hash 传输兜住。
- 但换发**不**做设备预绑定：code 在签发时与设备无关。任何拿到 URL hash 的一方（复制链接、浏览器历史、新标签）都能在 60s 内换出完整会话。这是 FR-3.10 明文设计，接受；缓解靠 W7b「hash 用后即清」。
- 遗留接口义务（移交 W7b）：当前 e2e 以 `{code}` 单字段换发（web-handoff.e2e.test.ts:110-118），落库设备为 `name:'unknown'`、`publicKey:''`，且每次换发新开一行设备（`/v1/me/devices` 列表与内存随之增长）。`/connect` 对空存储公钥的设备会把请求值直接嵌入凭证（`devicePubKey: device.publicKey || devicePubKey`，server.ts:2584），E2EE 设备绑定形同虚设。W7b 换发请求应带 `deviceId`+`deviceName`+`devicePubKey`，且 W7a 侧宜补一条「换发携带他人 deviceId 不被采纳」的负向断言（该分支现状零覆盖，密码登录路径同样未覆盖——既有缺口，非本提交引入）。

### 1.4 403 permission_lost 的时机（TOCTOU）

- 换发时序为：**消费（先删）→ 校验 user/project 状态 → 校验当前 grant → 签发会话**（server.ts:962-1026）。grant 校验用换发当下的 `effectivePermissions`（server.ts:1012），签发到换发之间的最长 60s 窗口被关闭；测试「签发后授权被撤：换发 403」钉死了这条路径。
- 消费先于权限校验的次序是**安全方向**：撤权场景下 code 已作废，重试只得 410，不存在「重复尝试直到窗口错过」的重放面。
- 换发后的撤权走既有 `revokeProjectCredentials('grant_changed')`（server.ts:1676）+ 项目守卫逐请求重评 + `/connect` 侧 re-check，会话本身不会保留可见性——与密码登录会话完全同级，无特权残留。
- 维护/吊销/离线只在签发侧检查，换发侧不复查：换发出的平台会话不直接触达主机，触达必经 `/connect` 重检（server.ts:2514-2532），仍为 fail-closed。
- 缺口（minor m-1）：`/v1/web/handoff` 未认证可调，每次失败尝试写一条 `web_handoff denied` 审计事件（server.ts:970-983），无任何限流；`readJson` 无体积上限（server.ts:130-140，全站既有）。`/v1/auth/login` 有同类暴露（每尝试一条事件，锁定按用户名而非按 IP），故这是**既有暴露类的新增实例**而非新类别；但审计哈希链是平台取证底座、该端点设计为外网可达（design.md §12.1「外网=是」），建议后续令加一个全局失败令牌桶。

### 1.5 审计无明文

- 实现层：签发/换发/四类 deny 全部只落 `codeFingerprint`（server.ts:980、1032、2496），URL 只出现在**响应体**（不进任何日志路径；hash 片段不会被浏览器发给服务端）。
- 断言层：e2e 收集全部已签发 code，对双实例审计轨迹整体 `JSON.stringify` 后逐串断言不含明文（web-handoff.e2e.test.ts:388-393）；测试代理另做了 42 个 code 在「审计 API + 磁盘」双载体 100% 指纹命中、明文零泄漏的独立探针。两条证据互证成立。
- 断言弱点的两条 note：查询按 `eventType=web_handoff` 过滤，若明文漏进**其它**事件类型的 metadata 则测不到（n-4）；「URL 不携带任何令牌」只针对本次 access token 实例（含 refresh 更稳，属构造性安全，非缺陷）。

## 2. 契约（审计点②）

- **`issueDeviceSession` 零回归**：与抽取前登录内联代码逐字等价（读 `body.devicePubKey/deviceName/deviceId` → 复用或新建 → `issueSession`），两处调用点（登录 server.ts:901、换发 server.ts:1023）共用同一实现；登录审计事件字段、响应形状（`tokens/expiresIn/user/permissions/device`）不变。测试代理「换发响应与密码登录字段集合完全一致」探针佐证。✓
- **URL 拼接**：`https://${directAddr}/web-index.html#handoff=${code}&project=${project.id}`（server.ts:2500-2502）。hash 形态与 FR-3.10 / design.md §12.1 逐字一致；`code` base64url、`project.id` 为服务端生成的 `proj_`+8 hex（server.ts:1314、1431），二者都无需转义，e2e 用 `^#handoff=([^&]+)&project=([\w-]+)$` 反解成功。hash 段不发给服务端，无 referer/日志泄漏面。风险残留在 `directAddr`（见 m-2）与「hash 里的 project 与 code 绑定的 project 可以不一致」——后者是客户端提示值，权限以换发响应为准，移交 W7b 时不得信任 hash。
- **`HANDOFF_TTL_MS` 注入**：`config.handoffTtlMs ?? HANDOFF_TTL_MS`（server.ts:288）+ CLI 侧 `ORCA_CLOUD_HANDOFF_TTL_MS` 经 `ttlFromEnv`（>0 有限数才生效，server.ts:2768-2773），非法/0/负值安全回落默认 60s；测试双实例隔离（默认实例断言 `expiresIn===60`、注入实例 150ms 断言 `expiresIn===1`），默认值没有泄漏进测试。✓ 无上限约束（运营者可注入 24h 违背 FR-3.10「≤60s」），属配置自由度，n-6。

## 3. 路由正则改动影响面（审计点③）

`/^\/v1\/projects\/([\w-]+)(\/[a-z]+)?$/` → `(\/[a-z-]+)?`（server.ts:1474）。逐项核验：

- 既有动作（`''`/`/connect`/`/archive`/`/restore`/`/grants`/`/policy`/`/workspaces`）纯字母，匹配结果不变；项目 id 段 `[\w-]+` 未动；`/v1/projects/self`（POST 自助）在 projectPath 块之前命中自身字面量（server.ts:1349），不受影响；除三个 `/v1/projects` 字面量外无其它多段路由被前移遮蔽。
- 行为变化仅两类：匿名请求 `/v1/projects/<id>/<含连字符未知动作>` 由 404 `NOT_FOUND` 变 401 `SESSION_EXPIRED`；已认证调用者对未知/无权项目的连字符动作路径现在会写一条 `project_access denied` 审计事件再 404（与不带动作的路径既有行为一致）。无信息泄漏（两者都不区分「项目存在但无权」），与测试代理观察一致。✓
- 未知动作对可见项目最终仍落到块外 404 `NOT_FOUND`（server.ts:1839 出块→末尾兜底），无错误状态漂移。

## 4. 规范（审计点④）

- **max-lines**：server.ts 2608 → 2816 行（+208）。根仓 oxlint 预算（300 行）**不适用**：cloud-platform 是独立 workspace，不入根 lint/changed-code-quality 门禁（PLAN.md §0；check-changed-code-quality.mjs:11 `ROOT_CODE_QUALITY_IGNORED_PREFIXES` 含 `cloud-platform/`），且本次未加任何 `max-lines` disable、未动 ratchet baseline——AGENTS.md 红线未触。但方向性问题成立：本提交把约 250 行 handoff 逻辑继续堆进 2816 行单文件，而同目录已有 `project-self-service.ts`、`relay-nodes.ts`、`web-release.ts` 的抽模块先例（m-4）。
- **命名**：`handleWebHandoff`/`consumeWebHandoff`/`pruneExpiredWebHandoffs`/`codeFingerprint`/`WebHandoff`/`issueDeviceSession` 全部是具体域名词，无 helpers/utils 类命名。✓
- **注释**：新增 why 注释 8 处，全部 1–4 行且解释「为什么」（如「The code is bound to a user, not a permission」「Deliberately before token resolution」「Same shape as a login event」），无过程复述，密度与文件既有风格一致。✓
- **diff 归属**：self-service-project-dir.e2e.test.ts 的 +32/−10 中，W8_EVIDENCE 常量与文件头 docstring 是 **W8 审计 m-1/m-2 的整改落地**（w8-audit.md §5），其余为纯 prettier 重排；主会话派发时已明示「平台 handoff 端点 + W8 两个 minor 顺手项」（PROGRESS.md），属授权内并入，但严格按「一令一提交」纪律应独立成提交（n-5）。server.ts 内另有 4 处与 handoff 无关的纯格式 hunk（webReleases 资产映射、426 错误调用、GET 静态条件、轮换审计 metadata，约 20 行）混入（n-5）。测试文件本身有 2 行超宽未过 oxfmt（m-5）。

## 5. 审计观察：admin 可为无 grant 项目签发 code，但换发必 403（major j-1）

**事实链**：项目守卫 `adminAccess = isAdmin || platform:auditor`（server.ts:1482-1487）放行 admin/审计员 → `handleWebHandoff` 不再复查 grant，签出 201 + code + 成功审计事件（server.ts:2482-2501）→ 换发侧 `effectivePermissions(...).includes('open')` 对无 grant 的 admin/审计员恒为 false → 410 之外的 **403 permission_lost**（server.ts:1012-1019），并留下「签发成功 + 换发被拒」的成对审计记录。

**裁定建议：应在签发侧就拒，不建议按「与 /connect 同语义」接受。**

1. **无委托用例**：code 绑定签发者本人（`userId`），admin 签出的 code 只能换出 admin 自己的会话——不存在「替别人签 code」的合法场景，签出即死代码。
2. **/connect 的行为不是值得复刻的语义**：`handleConnect` 同样靠 adminAccess 放行且不再复查（server.ts:2509-2584），admin 无 grant 时拿到 200 + `perms: []` 的凭证——同样是「死票据」，只是死得更安静（宿主侧拒绝每个操作）。两入口对同一 admin 呈现相反结果（桌面 200、Web 403），这种不一致比任何单一行为都更难向用户解释。
3. **偏离工作令字面**：W7a 明写「`POST /v1/projects/{id}/web-handoff`（open 权限……）」；审计员（只读角色）也能签发 code 显然超出意图。
4. **成本与审计观感**：修法是在 `handleWebHandoff` 内补一行与换发同谓词的检查（403 `PROJECT_FORBIDDEN`/`reason: 'permission_lost'`，本地改动、不影响共享守卫的其它动作），并把现有「无 open 权限的开发者 404」用例扩展出 admin/审计员变体。否则 W7b 激活按钮后，管理台项目列表（admin 可见全部项目）每行都可能出现一个点了就 403 的「Orca Web」，且审计上留下先 success 后 denied 的可疑成对事件。

安全上两种选择都 fail-closed，故不定为 blocker；但它是本提交引入的定向缺陷且 W7b 在即，定为 major。

## 6. 分级发现清单

### Blocker（0）

无。

### Major（1）

- **j-1** server.ts:2446-2501 / 1012：签发侧权限判定（adminAccess 放行）与换发侧（`open` 必需）不一致——admin/审计员可为无 grant 项目签出必 403 的死 code，偏离工作令「open 权限」，且 W7b 激活按钮后成管理员可见死入口 + 成对矛盾审计事件。按 §5 建议签发侧同谓词拒绝（403）并补 admin/审计员负向 e2e。

### Minor（5）

- **m-1** server.ts:958-985：`POST /v1/web/handoff` 未认证可调、无限流，每次失败尝试写一条审计事件，构成审计哈希链的灌水面（`/v1/auth/login` 有同类既有暴露，故非新类别）。建议加全局失败令牌桶；顺带 `readJson` 无体积上限为全站既有，可在同一令中收口。
- **m-2** server.ts:2467-2502：`directAddrs[0]` 未经格式校验即拼进 `https://<addr>/web-index.html#handoff=<code>`。注册体里的 `directAddrs` 是宿主侧字符串，含 path/scheme/非括号 IPv6 的值会产出错位 URL；被诱导的宿主若把入口指向第三方页面，该页面 JS 可读 `location.hash` 窃取 code 换会话（需先持有 admin 注册令牌，属内部威胁）。建议在注册/心跳入库处校验 `host[:port]`（IPv6 加括号、禁 scheme/path），同时保护 `/connect` 的 `wss://${url}` 既有同类问题。
- **m-3** server.ts:958-1050：签发与换发都走 `appendBestEffort` 且不检查 `auditAllowsMutations`——审计盘故障期间平台持续签出 60s 会话 code 而不留痕（标记 unhealthy 后敏感写全部 fail-closed，handoff 不在其列）。按「handoff 即登录」定性可辩护，但建议至少让**签发**受 audit 健康门约束。
- **m-4** server.ts：+208 行进 2816 行单文件。cloud-platform 不入根 max-lines 门禁（PLAN.md §0），无规则违反；但按仓内抽模块先例（project-self-service.ts / relay-nodes.ts），签发+换发+store 三段宜抽 `apps/api/src/web-handoff.ts`，为后续 W6b/W7b 改动留出空间。
- **m-5** test/e2e/web-handoff.e2e.test.ts:374-375：两行超宽未过 `oxfmt`（仓内 formatter；同提交其余 3 个文件均干净）。`pnpm format` 一次即可。

### Note（7）

- **n-1** 多副本部署缺口（设计自带）：design.md §5.3 平台 API 3 副本「无状态」，而 code map 与既有 sessions/refreshTokens 同为进程内存——副本 A 签的 code 在副本 B 换发得 410 `code_invalid`（与重放不可区分）。附录「W7 设计要点」明示内存 map，实现忠于设计；M114c 部署前需明确会话粘滞或单活语义。
- **n-2** 入口 URL 暂用 `directAddrs[0]`，未接 W6b 的 `browserEntryUrl`：中继-only 宿主（有 relayRoute 无直连）现在只能拿到 400 `HOST_UNAVAILABLE`。W6a→W6b 排在 W7a 之后属计划内时序，但 W6b/W7b 必须回头改 `handleWebHandoff` 的入口选择（工作令 W7 行「`<browserEntryUrl 或直连 web-index>`」），测试代理已同样挂账。
- **n-3** 换发请求体 `{code}` 单字段会每次新建 `unknown`/空公钥设备行（1.3 节）：W7b 契约应带 `deviceId`+`deviceName`+`devicePubKey`，并补「他人 deviceId 不被采纳」负向断言。
- **n-4** 审计断言按 `eventType=web_handoff` 过滤（web-handoff.e2e.test.ts:335、353），若明文漏进其它事件类型测不到；实现层核验为仅指纹，属断言加固项。`issued.length >= 3` 零余量、`limit=200` 均可顺带放宽。
- **n-5** diff 归属：self-service 套件的 W8 整改（docstring + `W8_EVIDENCE`）与 4 处 server.ts 纯格式 hunk 混入本提交。整改内容正确且经主会话授权（PROGRESS.md「W8 两个 minor 顺手项」），但按「一令一提交」宜独立；格式 hunk 属噪声。
- **n-6** `handoffTtlMs` 无上限：运营者注入 >60s 即违背 FR-3.10「≤60s」。可在 `ttlFromEnv` 侧加 60s 封顶或启动告警。
- **n-7** 小项：deny 的 `project_archived` reason 同时覆盖「项目不存在」（server.ts:998-1009，语义略宽）；响应 `expiresIn` 用 `Math.ceil` 可高估剩余寿命 <1s；换发侧不复查宿主维护/离线状态（由 `/connect` 兜底，fail-closed）。

## 7. 与工作令逐条对照

| 工作令 W7a 要求 | 落实 |
| --- | --- |
| `POST /v1/projects/{id}/web-handoff`（open 权限） | 实现为 `open` 或 adminAccess → **major j-1** |
| 60s 单次 code | `HANDOFF_TTL_MS=60_000`、`consumeWebHandoff` 先删后校验（store.ts:187-196）✓ |
| 审计 `web_handoff` 记指纹（不含明文） | 四向事件 + 64-bit 指纹，测试与测试代理双证 ✓ |
| `POST /v1/web/handoff` 复用设备会话签发 | `issueDeviceSession` 与密码登录同路径 ✓ |
| 重放/过期 410、无权限 403 | 410 `HANDOFF_GONE`（reason 区分 expired/invalid）、403 `permission_lost` ✓ |
| e2e 五步负向链 | 7 用例覆盖五步 + 宿主门 + 无权签发 + 审计，7/7（evidence/w7a-handoff-api/run-web-handoff.log）✓ |
| 证据 `evidence/w7a-handoff-api/`、提交信息 | 证据 7 JSON + 2 日志齐；提交信息逐字一致 ✓ |
| design.md §12.1 两行 | 签发行（hash 携带 code、令牌不经 URL）与换发行（410/403）均吻合 ✓ |
| 附录「W7 设计要点」平台半部 | 内存 map 绑 userId+projectId、单次消费、防重放、审计指纹——全部命中；「错误处理 410/403 分别提示」的 web 侧半部归 W7b ✓ |
