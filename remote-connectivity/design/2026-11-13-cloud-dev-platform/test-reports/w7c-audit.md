# W7c 审计报告（web 启动链云会话感知降级）

- 审计人：独立审计代理（只读；未改任何被审文件）
- 日期：2026-11-14
- 审计对象：`679f24c1b6d`（fix(web): cloud session startup skips native-only bootstrap，12 文件 +778/−66）
- 对照基准：work-orders-2026-11-14.md（W7 立项脉络）、requirements.md FR-3.9/§7「云端是附加渠道」、design.md §7.3 权限模型（方法表 manifest）、web-index-adaptation-plan.md §4.1/§4.4/§4.5/§5、business-chain-tests.md §2（B3/B4）、AGENTS.md、PROGRESS.md W7c/W7b/W5b 记录、w7b-audit.md（handoff 链既有结论）
- 方法：只读 diff 审查 + HEAD 交叉验证（启动链全部宿主调用逐一对照 `cloudMethodAccess`、web preload API 各 namespace 的本地/RPC 实现判定、memo 生命周期与 main.tsx 装配流、`restoreSshConnectionsForStartup`/`repo-catalog-fencing`/degraded-recovery 的错误传播）+ 实跑（5 个新套件 + 3 个受影响邻接套件）。行号基于当前 HEAD（`10cdda7787a`，与被审提交之间无这些文件的后续改动）。

## 结论

**通过（带 1 major + 4 minor）**：blocker 0、major 1、minor 4、note 10。

本提交要解决的问题是真实的（W7b 旅程实测：自动进入后链路按原生假设调用 `repo.list` 等注定被拒的 RPC → 降级粘性 toast + 空白壳），解法方向正确：**在客户端做「跳过」，而不是在宿主做「放行」**——云方法表未扩充与 design §7.3「未登记方法默认拒绝」的默认拒绝哲学一致，拒绝路径（宿主侧）零改动。附加渠道语义成立：云会话空态是文档型说明而非遮罩，原生侧栏骨架（容器属性、导览锚点、Header/Toolbar/新建工作台入口）全部保留。原生会话零变化经逐行 diff 复核成立（非云分支执行序列逐字等价）。

唯一 major 是**客户端侧 scope 判定的记忆化陷阱**：模块级 memo 只算一次、页生命周期不重置，而「云会话死亡 → 同页回落 WebConnect → 用配对码连运行时」这条真实可达路径会让 App 重挂载后继续沿用 stale 的 `true`，把四类跳过静默套在一个**已配对**的客户端上；`resetWebCloudSessionScope` 无生产调用方，且 scope 单测把「启动后存储被清仍维持旧答案」钉死为预期行为——测试在为这个陷阱背书。安全性不受影响（宿主方法门才是权威边界，误判两个方向的后果都只是「多做被拒调用」或「少做调用」），故不是 blocker，但应随本令收口（修法一行）。

## 1. 附加渠道语义与原生会话零变化（审计点①）

### 1.1 云会话跳过 ≠ 移除原生入口

- 空态组件（`CloudSessionEmptyState.tsx`）与被替换的原生空态（`listing/EmptyState.tsx`）**逐类名同构**：同一 `relative min-h-0 flex-1` 容器、同一滚动容器、同一 `data-worktree-sidebar-container` 与 `data-contextual-tour-target="workspace-list"` 锚点（组件测试断言了这四个点）。**in-flow、无 fixed/absolute/遮罩层**，不拦截任何点击——与 W11 MAJ-1（登录 chip 遮蔽状态栏）那类违例有本质区别。
- 被替换的原生空态只承载「No workspaces found」+「Clear Filters」，**没有**任何原生 CTA（添加项目入口在 `SidebarHeader`/`SidebarToolbar`/新建工作台 composer，均在本提交未触碰的 `sidebar/index.tsx` 层）——「云端功能不移除或遮蔽原生入口」成立。文案如实说明「桌面项目目录不属于云会话」，是对 B4 边界的诚实呈现而非掩盖。
- 唯一损失：`filtersHideAllRows` 时云会话看不到「Clear Filters」逃生口（过滤器经 localStorage 持久化，理论上可从同源上一个配对会话继承）。纯装饰性（目录为空时过滤器本无意义），note 级。

### 1.2 原生会话零变化的证据强度

逐 hunk 复核非云分支的执行序列：

| 处 | 改动 | 非云路径等价性 |
| --- | --- | --- |
| use-app-startup-hydration.ts:136-143 | 目录读取包进 `if (!cloudRuntimeSession)` | 步骤、顺序、参数逐字不变 |
| :146-155 | `localCatalogChain` 三元 | 惰性 IIFE 内容逐字不变，cloud 才换成 `Promise.resolve()` |
| :255-259 | `connectionIds` 三元 | 非云分支同一过滤式 |
| :325-330 | 内联延迟刷新 → `startDeferredRemoteStartupRefresh` | 逻辑逐字搬移；`cancelled` 直读改为 `isCancelled: () => cancelled` 闭包，语义相同（同一次 effect 的同一变量） |
| runtime-client-ipc-bridge.ts:176-179,241 | `desiredEnvironmentIds`/`getReachableEnvironmentIds` 包一层 | 非云即原函数透传 |
| direct-ssh-state-ipc-bridge.ts:64 | 水合包进 `if (!isActiveWebClientCloudSession())` | 桌面 `isWebClientLocation()` 短路为 false，水合照跑 |

证据分两层：E2（「native boot chain intact」）断言三个目录 action 以原参数调用；外层是本提交声称的 3560 例受影响回归（本审计实跑了直接邻接的 WorktreeList.group-headers、runtime-client-ipc-bridge-ownership、direct-ssh-hydration-fanout 等，全绿）。注意 App 测试 mock 了 30+ 模块（含 store、AppWorkspaceShell），所以「零变化」的证明粒度是「哪些 action 以什么参数跑了」，不是 RPC 级——对本次改动性质（只增门、不改序列）这个粒度足够。

## 2. 安全面（审计点②）

### 2.1 「云方法表不扩充」的取舍成立

被跳过的五个方法全部核实为**宿主全域目录**读取，且全部不在 `cloudMethodAccess`（`cloud-rpc-permission.ts`）内 → 对云票据默认拒绝：

| 方法 | 宿主定义 | 泄露面 |
| --- | --- | --- |
| `repo.list` | repo.ts:33 | 全宿主项目/仓库清单（含他人项目） |
| `ssh.listTargets` | ssh.ts:51 | 全宿主 SSH 目标（地址/标签/口令需求元数据） |
| `projectGroup.list` | repo.ts:47 | 跨项目分组 |
| `folderWorkspace.list` | —（mobile 允许清单在册） | 全宿主目录工作区 |
| `worktree.lineageList` | worktree.ts:49 | 跨仓库 worktree 谱系 |

对照：票据权限模型是**项目内**的（design §7.3「凭证 perms 只携带该用户在该项目内的子集」+ 路径守卫把 files/repo.add 钉在 projectRoot/workspaceRoot），放行这五个就是把「项目渠道」升格成「主机渠道」，与 FR-3.9 修订后的只读授权面也不相干。设计里预留的正确出口是 `workspace.info`（SESSION_METHODS，票据自省）——而它宿主尚无实现，PROGRESS 已如实入账为后续工单。**取舍成立，理由（防宿主全目录/SSH 目标泄露）与 design §7.3 默认拒绝条款互证。**

### 2.2 memo 化 scope 判定的可绕过面（→ MAJ-1）

`isActiveWebClientCloudSession()`（web-cloud-session-scope.ts:16-24）= `isWebClientLocation() && 存储环境.cloudLoginRequired === true`，模块级 memo，**生产代码零重置点**（`resetWebCloudSessionScope` 仅测试引用）。装配事实：main.tsx:97 `if (!hasEnvironment)` 卸载 App 渲染 WebConnect，:128 `onConnected` 置回 true 重挂载 App → `useAppStartupHydration` 的 effect 重新执行，但 **memo 不会重算**。可达触发链：

1. handoff 自动进入（memo 在首次调用时算出 `true`，此时存储记录确为云票据）；
2. 票据死亡 → `subscribeCloudSessionEnded` → `signOutWebSession()`（清记录、关 socket）→ `setHasEnvironment(false)`（web-session-recovery.ts:34-41）；
3. 用户在 WebConnect 用**运行时配对码**连接（WebConnect.tsx:40-43 配对输入框与 ：164 云登录表单同页共存）→ 存储换成配对环境（无 `cloudLoginRequired`）→ App 重挂载；
4. memo 仍 `true` → 配对客户端被套上四类跳过：目录不加载（侧栏永远显示「Cloud project session」空态）、SSH 水合不开、client-event 镜像关、延迟刷新跳过——**静默功能缺失，无任何报错**。

反向（配对页同页登录云平台 → stale `false` → 云会话重新发起被拒调用）要求配对客户端走到 WebConnect 重入；`cloudSessionEnded` 只对已采纳的云客户端发出（web-runtime-session.ts:64 注释），配对客户端掉线走应用内恢复而非登录页，**当前不可达**，但 memo 不重置同样覆盖不了它未来变得可达的情形。scope.test:59-67（「keeps the boot-time answer even after the stored record is cleared」）把 memo 的页生命周期钉死为预期——测试需要的是「票据被启动路由消费后不反复重读」，这个目标用「按环境记录身份记忆化」同样能达到，不必钉「永不变」。

**安全定性**：判定只是建议性的。误判为云（伪记录/陈旧标志）→ 配对客户端少做事，无泄露；误判为原生（缺标志/坏 JSON）→ 发起被拒调用 → 降级启动，即 W7c 修复前的形态，fail-safe。权威边界是宿主方法门，本提交零触碰。生产写入方一致（只有 `toCloudEnvironment` 写标志，`createStoredWebRuntimeEnvironment` 从不写），伪造记录需同源脚本，不构成新增攻击面。**故 major（正确性陷阱）而非 blocker（安全）。**

### 2.3 拒绝路径审计零改动：确认

`git show --name-only`：12 文件全部在 `src/renderer/src/`，`src/main/cloud-platform/*`（`cloud-rpc-permission.ts`、`cloud-path-guard.ts`、`runtime-rpc-websocket-dispatch.ts`、`cloud-denial-details.ts`）与 `rpc-caller-scope.ts` 零改动；新增测试只 mock 渲染层 scope 模块，不含任何放松宿主拒绝语义的断言。**确认。**

## 3. 启动链跳过清单完备性与副作用（审计点③）

对云会话下仍会执行的启动链调用逐一对照云方法表与 web 适配层实现：

| 链上调用 | web 实现 | 云会话下 |
| --- | --- | --- |
| `settings.get`/`keybindings`/`onboarding.get` | localStorage（web-settings/keybindings/onboarding-api） | 本地，零 RPC |
| `session.get`/`listHostIds` | localStorage 分区（web-workspace-session-api:70-71） | 本地 |
| `runtimeEnvironments.list` | 活动环境内存记录（web-runtime-environments-api:38-41） | 本地 |
| `orcaProfiles.*`/`cache.getGitHub`/`pty.getAuthoritativeBufferSnapshotCapabilities` | 本地 stub | 本地 |
| `app.*`（barrier/prepare/recover/relaunch） | 本地 no-op（web-app-api.ts:37-45） | 本地 |
| `ui.get` | **RPC**，失败 catch → 本地回退（web-ui-api.ts:46-76） | 被拒→吞掉→本地（→ MIN-4） |
| `runtime.getStatus` | 快照或 `status.get`（表内 `session`） | 允许 |
| `browser.profileList` | `browser.` 前缀（表内） | 允许，且双层 try/catch |
| project-catalog 桥的 fetch 路径 | 事件驱动，web `repos.onChanged` 为 noop（web-repositories-api:124） | 不触发 |
| rateLimits 桥注册期 `rateLimits.get()` | web 为本地空态 stub（web-rate-limits-api:9） | 本地 |
| `awaitLocalRepoCatalogSettlement`（未跳过，:206） | 无在途 fetch 时立即返回（repo-catalog-fencing.ts:29-33） | 安全空转 |
| `reconnectPersistedTerminals` | 本循环零 RPC；PTY attach 在 pane 挂载时发生 | 不在链上降级 |

**结论：跳过清单对本启动链完备**——链上唯一残余的「注定被拒调用」是 `ui.get`（有兜底，见 MIN-4）。链外的 App 级后台同步（`aiVault.*` 标题同步、打开会话时的 `nativeChat.readSession`）在云会话仍会被拒，但它们是按需触发、各自有错误处理，且属于「云会话挂文件树/终端」后续工单要整体 revisit 的面（届时 client-event 镜像与 worktree 事件会重新变成 load-bearing——四个跳过门目前都是硬编码谓词，建议在那张工单里显式列入回收清单）。

副作用复核：镜像关闭同时掐断了 project-catalog 桥的事件驱动刷新路径（方向正确，两处不是两套门）；SSH 水合跳过只留空 watermark，云会话无事件流经该桥，`registerDirectSshStateIpcBridge` 的事件订阅保留注册（无害）；`startupWorktreeRefreshCompleted` 在云会话仍经 `finally` 置位（`startup-remote-catalog-refresh.ts:61-65`），无等待方被挂起，E1 有断言。

## 4. 规范（审计点④）

- **max-lines**：抽取后 `use-app-startup-hydration.ts` 351 原始行 / 284 有效行（300 上限，`**/*.ts` 档），16 行余量；`check:max-lines-ratchet` 通过（该文件不在豁免名单）；12 文件 `oxlint` 全 0 finding。抽取本身是本次提交的正当部分（改动前该文件在改动后规模下必然越线）。
- **命名**：`web-cloud-session-scope.ts` 加入既有 `web-cloud-session-*` 家族、内容即判定，合规；`App.web-cloud-session-startup.test.tsx` 与 `App.cloud-*-test.tsx` 同构；`CloudSessionEmptyState.tsx` 导出 `SidebarCloudSessionEmptyState`，与同目录 `EmptyState.tsx`（导出 `SidebarWorktreeListEmptyState`）的「文件短名 + 导出长名」模式一致。`startup-remote-catalog-refresh.ts` 名字略窄于内容（还承载全量 worktree 扫描与 lineage），但其职责就是「水合后的那一次延迟刷新」，可接受。
- **注释**：新增注释均为 1-3 行 Why 型（跳过理由、票据不携带桌面态、测试缝说明），无走读式赘述，合规。测试里的类型断言带 `SAFETY:` 行内解释（direct-ssh 测试的 runtime stub），符合「受检类型优先 + 不可避免需解释」规则。
- **diff 归属**：12 文件逐一核对＝7 产品（新 3：scope 模块、延迟刷新模块、空态组件；改 4：启动链、两个桥、WorktreeList）+ 5 测试，与提交说明完全一致；无 docs/format 噪声、无他代理文件混入（比前几令的索引冲突记录干净）。+778/−66 与自述相符。
- **i18n**：`auto.web.cloudSession.sidebarTitle/sidebarBody` 未入 `en-runtime-required.json`/`zh.json`，非英语环境显示英文 fallback——与 W7b 新增键（`cloudSessionEnded` 等）同状态，属既有翻译流水线的滞后而非本提交缺陷。

## 5. 测试质量（审计点⑤）

**12 例属实**：scope 5 + App 2 + direct-ssh 2 + runtime-client 2 + 空态 1。实跑：5 个新套件 + WorktreeList.group-headers / runtime-client-ipc-bridge-ownership / direct-ssh-hydration-fanout 共 8 文件 33 例全绿。

可变红复核（本机 /tmp 仅 206MB 可用，无法做隔离导出的执行式变异；以下为逐例推理结论，建议在途独立测试代理以执行式变异收口）：

| 例 | 守卫的分支 | 变红性 |
| --- | --- | --- |
| scope 1/2/3/4 | 判定式四支（云票据/配对/无记录/非 web） | ✅ 各有专属 mutation |
| scope 5 | memo | ✅ 但它把「永不变」钉为预期（见 MAJ-1） |
| App E1 | 目录三跳 + 延迟刷新跳过 + `setSshConnectionState` | ✅ 前两组删除即红；**SSH 跳过支不敏感**（MIN-2） |
| App E2 | 非云链完整 | ✅ 无条件跳过即红 |
| direct-ssh 1/2 | 水合门 | ✅ 双向 |
| runtime-client 1/2 | desired ids 门 | ✅（`subscribeRuntimeClientEvents not called` 断言是装饰性的——sync 已被 stub 成 no-op，承重的是 ids 断言） |
| 空态 1 | 组件内容/锚点/无原生文案 | ✅ 换回原生空态即红 |
| — | **WorktreeList.tsx:267 的选择门** | ❌ **零覆盖**（MIN-1） |
| — | reachable ids 两处三元（bridge:234/241） | ❌ 零覆盖（MIN-3） |

**B3/B4 评估**：W7c 解锁的是 B3「自动进入该项目工作区」的工作区半边——进入后壳是 hydrated 而非降级（W7b 旅程观测到的降级 toast/空白壳即 B3 的断点，本提交摘除）。B3 的完整判据（免二次登录、线路徽标）仍欠旅程证据落库：PROGRESS 记录的实现方自测（toast=false、壳 36588 字节、零 denial 错误）尚无 evidence 产物在库，应由在途独立测试代理产出。B4（终端/文件树对等）本提交**未推进也未声称推进**：`workspace.info` 宿主无实现、流式订阅在 W5c——空态文案对用户的说明与台账的边界记录一致，符合「红名单步骤未补测绿前工作令不关闭」的纪律。若按 FR-3.9 扩表（brief 里的备选）反而会把宿主全域目录放进项目票据，被正确否决。

## Findings

### MAJ-1 · scope memo 不随页内环境切换重算，配对客户端可被静默套上云会话跳过

- 位置：`src/renderer/src/web/web-cloud-session-scope.ts:16-24`（模块级 memo，无生产重置）；触发链 `web/main.tsx:86/97/128` + `web/web-session-recovery.ts:23-41` + `WebConnect.tsx:40-43/159-191`。
- 场景：handoff 云会话 → 票据死亡回落 WebConnect → 同页用配对码连运行时 → App 重挂载后 memo 仍 `true` → 目录/SSH 水合/镜像/延迟刷新四类跳过全部作用于已配对客户端（侧栏永远「Cloud project session」、事件镜像停摆），无报错。反向（配对→云）同样无保护，当前不可达而已。
- 佐证：`resetWebCloudSessionScope` 生产零调用；scope.test:59-67 把 stale 答案钉为预期行为。
- 建议修复（一行级）：memo 键入环境记录身份（id/updatedAt），或在 `signOutWebSession()`/`setHasEnvironment(false)` 处重置；scope.test 第 5 例改为「换环境记录后重算」。

### MIN-1 · WorktreeList 的云会话选择门零测试

- `WorktreeList.tsx:267-269` 是本特性对用户可见的最终开关，但删除它不会变红任何一例（App 测试把 AppWorkspaceShell stub 成空 div；空态测试直渲组件）。
- 建议：一例 WorktreeList 渲染测试（mock scope 两种取值，断言两种空态二选一）。

### MIN-2 · App E1 的 SSH 跳过断言不可变红

- 删除 `connectionIds` 的云三元（use-app-startup-hydration.ts:255-259）后，`window.api.ssh` 在该测试中未 stub → `restoreSshConnectionsForStartup` 首行 `ssh.listTargets` 取 undefined 抛 TypeError → 被内层 catch 吞掉 → 任何被断言的可观测（`setSshConnectionState`/`setDeferredSshReconnectTargets`）都未到达 → 测试保持绿，而生产会真发一次被拒的 `ssh.listTargets`。
- 建议：stub `window.api.ssh` 为 spy 并断言云会话下 `listTargets` 零调用。

### MIN-3 · client-event 镜像的 reachable-ids 门零断言

- `runtime-client-ipc-bridge.ts:234/241` 两处 `cloudRuntimeSession ? [] : …` 删除后无可观测变红（ids 断言只看 desired；sync 被 stub）。当前是纵深防御，但未测的纵深等于没有。

### MIN-4 · 云会话启动链仍发一次注定被拒的 `ui.get`

- `web-ui-api.ts:46`：不在云方法表 → 被拒 → catch → 本地回退（行为正确、噪声为零），但与本提交「不再发起注定被拒的 RPC」的自述不完全一致。接受现状则建议在空态/提交说明里记一句「ui.get 为已知豁免（有本地兜底）」，或在 web 适配层同样按 scope 短路。

### Notes

1. 非云分支逐 hunk 等价（§1.2 表），E2 + 邻接套件全绿背书；证明粒度为 action 级，非 RPC 级。
2. 云空态为 in-flow 文档型说明，保留全部侧栏锚点，不遮蔽 Header/Toolbar/composer 的原生入口；损失仅「Clear Filters」逃生口（filtersHideAllRows 时），装饰性。
3. 方法表不扩充与 design §7.3 默认拒绝条款互证；`workspace.info`（已登记、宿主未实现）是将来挂工作区的正确出口，台账已记。
4. scope 判定是建议性而非安全边界：两个误判方向分别退化为「少做事」（配对被当云）与「多做被拒调用」（云被当原生→降级启动），均无泄露；生产写入方对标志一致，无伪环境放大面。
5. 跳过清单对本链完备（§3 表）；链外 `aiVault.*`/`nativeChat.readSession` 等按需同步仍会被拒但各自有错误处理，归属「云会话挂文件树/终端」后续工单整体回收。
6. `startupWorktreeRefreshCompleted` 在云会话经 `finally` 置位，无挂起等待方（E1 有断言）。
7. `awaitLocalRepoCatalogSettlement` 未跳过但无 fetch 在途时立即返回（repo-catalog-fencing.ts:29-33），云会话安全空转。
8. 规范全过：284/300 有效行、ratchet 通过、12 文件 oxlint 0、diff 归属干净、注释合规。
9. scope.test 用字面量 `'orca.web.runtimeEnvironment.v1'` 复制存储键而非 import（键未导出）——键改名时测试会静默脱钩，建议导出常量。
10. 实现方旅程自测（降级 toast=false、壳 36588 字节、零 denial 错误）尚无 evidence 产物在库；本审计受磁盘所限未做执行式变异（推理复核替代，见 §5），均应在独立测试环节补齐。
