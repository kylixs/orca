# U138 残余设计令：Orca Web 活动标签权威收敛

> 2026-11-17 · P2 · 状态：设计待审
> 依据：`defect-ledger.md` U138 行、`u138-active-tab-authority-matrix.md`、`parent-child-session-protocol.md` §2-28~§2-35。
> 本令只出设计，不改产品代码；修复须经主会话审定 + 独立评审后另派实现令。

## 1. 现象与已证事实（时间线式）

### 1.1 门禁相位

| 证据 run | `a2_reload_dom_store_host_agree` | 备注 |
| --- | --- | --- |
| journey-13 | 绿（`true`） | 3 tab / 2 group 前置门禁亦绿 |
| journey-15 | 绿 | 台账记载 |
| journey-16 | 绿 | 13/13；W9 双线 6/6 |
| journey-14 | 红 | 台账记载 |
| journey-17 | 红（`false`） | 3 tab/2 group 与内容 marker 均绿 |
| journey-final3 | 红（`false`） | 3 tab/2 group、内容 marker 绿；仅三方一致红 |

读法：**恢复内容与拓扑每次都正确**（tab 数、group 数、终端 marker 全绿），唯一失败项是「当前选中标签」三方不一致。这与台账「标签组/标签数/终端内容每次均正确恢复，仅当前选中标签相差一个周期，下次打开或点击即自愈」一致。

### 1.2 十期修复各自否证了什么

| 期 | 假设 | 结论（否证/保留） |
| --- | --- | --- |
| 二期 | 客户端不在配对 activate 时落盘 | 已落盘（`activeTabIdByWorktree` + 每设备选择），未解决 |
| 三/五期 | 客户端恢复链主动回写 active 能收敛 | 否证：客户端回写会与宿主广播打架；裁定移除 |
| 六期 | 以宿主为准即可收敛 | 部分成立，单次 reload 多绿；非充分 |
| 七期 | 隐藏 pane 的 mirror attach 翻转全局 active | 成立并修复：`navigation:'caller'` 的 attach 不再持久化为全局 active（矩阵优先级 3） |
| 八/8b 期 | 用 `intent:'user'` 区分点击与 attach | **否证**：transport 内部同样传 `'user'`，字段非互斥（§2-35），一轮部署浪费 |
| 九期 | `materializeOnly` 显式标记可彻底隔离挂载 | 成立（隐藏 pane 不再移 active），但快速开合仍交替翻转 |
| 十期 | `materializeOnly` 覆盖全部挂载写路径 | 成立但**不充分**：还剩非挂载写入方（见 §2、§4） |

### 1.3 时间线已确立的边界事实（来自 §2-28 首轮时间线 + 矩阵）

- 不是单一写入方：宿主内存 active、宿主持久、每设备选择、客户端 store、DOM 五层各有写者。
- 翻转成对出现、相差一个周期，指向**两个写入方交替**或**异步请求乱序落地**。
- 只在「快速连续开合 + 多周期重开」暴露；单次 reload 常绿（§2-26：一次采样 ≠ 稳定）。
- 持久污染可独立制造红：同一构建 journey-13/15/16 绿而 -14/-17 红，钻取未隔离（§2-27/§2-34）。

## 2. 写入方盘点

引用 `u138-active-tab-authority-matrix.md` 五层，逐层补齐「谁在何时写、优先级、收敛方向」，并标出矩阵**未覆盖**的帧。

### 2.1 宿主内存 active

| 写入点 | 条件 | 说明 |
| --- | --- | --- |
| `activateMobileSessionTab` → `activateHeadlessMobileSessionTerminalTab` | `!materializeOnly && targetsHost && !notifier.focusTerminal && !targetTab.isActive` | 无渲染窗口时写内存 snapshot 并持久 leaf |
| `activateMobileSessionTab` → `notifier.focusTerminal()` | `targetsHost && notifier.focusTerminal` | 交给渲染窗口 focus，窗口异步回写；内存 snapshot 由窗口侧事件重建 |
| `applyMobileSessionTabNavigation` | `navigationTargetsClients` 或 caller 投影 | 只改**每设备选择**并 emit 投影帧；`materializeOnly` 纯投影 |
| `refreshMobileSessionPtyRecords` / `hydrateHeadlessMobileSessionTabsFromWorkspaceSession` | 每次 activate 开头 | **从持久值重建内存 snapshot**；若持久值陈旧，会把旧 active 重新灌回内存 |
| `close` / `create` 路径 | 关闭/创建 | 重算 active（拓扑回退/新 tab） |

优先级：宿主持久是入场真源；内存 active 是广播真源。收敛方向：内存 → 广播；持久 → 内存（仅入场/重建）。

**矩阵未覆盖**：
- `hydrateHeadlessMobileSessionTabsFromWorkspaceSession` 的反向灌入（持久 → 内存）没有优先级声明；并发 activate 下它可能与已进行的激活交叉。
- `refreshMobileSessionPtyRecords` 是 **await 前置于 snapshot 读取**：同一 worktree 的两个 activate 可乱序完成，后发起先落地。
- `notifier.focusTerminal` 的窗口回写是**无 RPC 帧的写**，帧记录器看不到它，必须靠宿主侧持久值/时间戳对照。

### 2.2 宿主持久 `activeTabIdByWorktree`

| 写入点 | 条件 |
| --- | --- |
| `persistPublishedMobileSessionTerminalTab`（`activation:true`） | 创建终端时的 focus 写入（create-time，非用户 tap） |
| `activateHeadlessMobileSessionTerminalTab` → `persistHeadlessTerminalActiveLeaf` | 无渲染窗口的显式 activate |
| `persistPairedClientMobileSessionTabActivation` | `persistSelection && clientNavigationId && !(targetsHost && notifier.focusTerminal)` |
| 桌面渲染窗口 focus 回写 | 原生窗口事件（非 RPC） |

**矩阵未覆盖**：`persistPublishedMobileSessionTerminalTab` 的 create-time 写仍是持久写者，快速开合时新 tab 的 create 会把持久 active 改成新 tab，与随后用户 tap 的 activate 竞争（last-write-wins，§5 已知边界只写了多设备，未写 create vs tap）。

### 2.3 每设备选择投影

- 写：`clientSessionTabSelections.activate(...)`（配对 activate，`persistSelection` 为真时）；`selectCreatedMobileSessionTabForClient`（create 选中）。
- 读：`projectMobileSessionTabsForClient` → `session.tabs.list` / 广播 / 探针读取值。
- 优先级（矩阵 4）：有效且指向现存 tab 时参与投影；否则回退快照 active。
- **未覆盖**：投影读路径也是「写」（写客户端 store / 探针观测值）。当每设备选择陈旧但合法时，探针 `hostActive`（经 `session.tabs.list` 投影）与 DOM/store 的差值可能来自**投影差**，而非宿主内存差 —— 这是当前门禁**无法区分**的两个故障类。

### 2.4 客户端 store / DOM

- store 写者：`applyWebSessionTabsSnapshot`（广播帧、listAll 广播、恢复修复帧）、`applyWebSessionTabsStorePatch`。
- 关键分支：`hostActiveAuthoritative` 仅在 `resolveHostActiveApplyOptions` 中、且 `isCloudSession && 无本地 focus intent` 时置位。
- **矩阵未覆盖 / 设计缺口**：`load-initial.ts` 的 `applyWebSessionTabsSnapshots(state, freshSnapshots, environmentId)` **没有传 apply options**。因此：
  1. `listAll` 初始化帧不具备 host-active 权威；
  2. 若它在订阅入场帧之后落地，会把 active 覆盖回本地/旧值 → 恰好一个周期。
- DOM 由 store 派生，无独立写者。

### 2.5 收敛方向小结

`宿主持久 →(入场/重建) 宿主内存 →(广播) 客户端 store → DOM`；每设备选择只应影响该设备投影。任何帧若同时改投影与内存 active，必须声明顺序。

## 3. RPC 帧可观测设计（§2-33）

### 3.1 目标

在 web 客户端一次性记录 `session.tabs.*` 的请求/回帧与流帧，形成 §2-28 时间线的直接证据：谁在何时以何种参数改了什么 active。

### 3.2 开关（默认关、零成本）

- 开关：`localStorage['orca.debug.sessionTabs'] === '1'`，或 URL 参数 `?orcaDebugSessionTabs=1`（URL 命中时写入 localStorage 后清理参数，避免复现链接泄露）。
- 关闭时：入口函数首行 `if (!isEnabled()) return impl(...)`，**不构造任何对象、不分配环形缓冲、不挂 window**；关闭路径仅一次布尔判断。
- 不改变 wire：只观察既有 `window.api.runtimeEnvironments.call` 与订阅回调，不新增 RPC 字段、不改序列化。

### 3.3 记录内容

每条帧：

```
{ seq, ts, dir: 'req'|'res'|'stream', requestId,
  method, environmentId, worktree, tabId, leafId,
  params: { navigation?, intent?, materializeOnly?, notifyClients?, persistSelection?, reason? },
  ok?, errorCode?, result: { activeTabId?, activeGroupId?, snapshotVersion?, publicationEpoch? },
  runtimeId?, applied?: boolean, applyOptions?: { hostActiveAuthoritative?, adoptHostLayout? } }
```

- `requestId` 关联请求与回帧；流帧用 `streamSeq`。
- `applied` / `applyOptions` 由 apply 层回填（可在 `applyWebSessionTabsStorePatch` 决策处打点），用于回答「这一帧有没有真正赢」。
- 覆盖方法：`session.tabs.subscribe`、`session.tabs.list`、`session.tabs.listAll`、`session.tabs.activate`、`session.tabs.close`、`session.tabs.closeLifecycle`、`session.tabs.restore`（若存在）、`session.tabs.listAll` 广播。

### 3.4 环形缓冲与暴露

- 环形缓冲 **300 帧**（固定数组 + 游标，覆盖写）。
- `window.__orcaSessionTabsTrace` 暴露：`{ frames, clear(), dump() }`；`dump()` 返回 JSON 字符串供探针 `evaluate` 取回。
- 只在开关开启时挂载；生产构建默认无此属性（无 `VITE_*` 宏参与，纯运行时判断）。

### 3.5 非目标（明确）

- **不进生产构建默认行为**：不设默认开启、不写入用户可见日志、不上报远端。
- 不记录终端内容、不记录凭据；`environmentId` 可按前缀截断。
- 实验项转正前不进入发布路径（§2-33 原文）。

## 4. 收敛判据（可测）

判据必须能被 `a2` 站点脚本直接断言，不依赖人工目视。

- **C1 无手势不改写**：在无用户点击、无创建/关闭的时间窗内（≥2 个采样周期），宿主内存 active、宿主持久 active、每设备投影 active 三者不得变化。任何变化必须能对应到一条带显式 user 意图的 `session.tabs.activate` 或一条可解释的 create/close 帧；否则判红。
- **C2 快速开合 5 轮**：打开→采样→关闭→采样 ×5，结束后 active 与操作序列预期一致；每个采样点 DOM = 客户端 store = 宿主投影。
- **C3 重开 ×3**：关页→再开 ×3，每次开页后初采样 + N 秒（建议 5s）复采样，二次采样一致；三次重开 active 相同（§2-26/§2-32）。
- **C4 钻取隔离代码化**（§2-34）：门禁脚本必须内建以下之一并在日志中打印选择了哪种：
  1. 每次 drill 用**新建 worktree**；
  2. drill 前清空目标 worktree 的每设备选择与 stale `activeTabIdByWorktree`；
  3. 使用独立 `deviceId` 命名空间。
  隔离未生效时，门禁结果**不得**作为判绿/判红依据（脚本应直接报 `INVALID`）。
- **C5 判别字段互斥**（§2-35）：任何用于分类请求的字段必须附「全部调用点清单 + 取值互斥证明」；优先新增显式标记（如 `materializeOnly`），不得复用 `intent`。

## 5. 实施拆分（每项 ≤20 分钟）

### T1 帧记录器 + 单测

- **文件域**：新增 `src/renderer/src/runtime/web-session-tabs-sync/session-tabs-frame-trace.ts`、`session-tabs-frame-trace.test.ts`；在 `runtime-environments` 的 call 包装与 `active-session-subscription` 的 onResponse 处各加一行 `traceRecord(...)`（或在共享 RPC 客户端单点挂）。
- **验收**：默认关闭时无分配/无 window 属性；开关开启后记录 req/res/stream 并正确关联（单测覆盖 requestId 关联、300 条环形淘汰、关闭不写）；`window.__orcaSessionTabsTrace.dump()` 可序列化；`pnpm tc` 与目标单测绿；wire 无改动。
- **风险**：单点包装可能漏掉 listAll/restore；需列方法白名单并单测。开关若在订阅建立后开启，需支持「开启即开始记录下一次帧」，不需回放。

### T2 探针接入（与并行脚本对齐）

- **文件域**：`cloud-platform/scripts/exploratory-r8/u138-frame-timeline.mjs`（并行开发中，本令只写接口假设，不编辑）。
- **接口假设**（可对齐点）：探针通过 CDP `Runtime.evaluate` 读 `window.__orcaSessionTabsTrace.dump()`，期望字段与 §3.3 一致；记录前注入 `localStorage['orca.debug.sessionTabs']='1'` 并重载页面；每个操作步骤后同时采 `session.tabs.list` 的 `activeTabId`、store、DOM，按 `ts` 合并成时间线。
- **验收**：探针输出按时间排序、每行可归因到「请求方法 + 参数 + 回帧 active + 是否 applied」；能直接回答「最后一帧是否带 `hostActiveAuthoritative`」。
- **风险**：脚本并行开发可能命名漂移；以 §3.3 字段为准，若不一致则在 T2 适配层归一化，勿改探针语义。

### T3 依时间线定位并修复根因

- **前置**：T1+T2 产出至少 1 条红 run 时间线；**未拿到时间线不得开修**（§2-28）。
- **候选根因（按优先级，见 §7）**：
  - H-A `load-initial` 的 listAll 应用缺 `hostActiveAuthoritative`，与订阅入场帧竞争；
  - H-B 无渲染窗口/有窗口两条激活路径交替写内存 active；
  - H-C 每设备选择陈旧导致投影差被误判为宿主差；
  - H-D 并发 activate 因 `await refreshMobileSessionPtyRecords` 乱序落地。
- **文件域**（按时间线落点）：`src/renderer/src/runtime/web-session-tabs-sync/load-initial.ts`；`src/main/runtime/orca-runtime-perform-mobile-session-pty-records-refresh.ts`；`orca-runtime-apply-mobile-session-tab-navigation.ts`；必要时 `client-session-tab-selection.ts`。
- **验收**：C1/C2/C3 全绿；修复帧的判别字段通过 §2-35 互斥性检查；补一条能红复现的回归测试（客户端应用顺序或宿主写序）。
- **风险**：把 H-C 当 H-B 修会再次白跑（矩阵 4 的投影回退容易被误读）；修复必须写明「写后宿主内存与持久值如何变化」（矩阵 3）。

### T4 门禁固化（a2 多周期站点）

- **文件域**：journey 脚本的 a2 段（`evidence/journey-final3/round7-web-journey.mjs` 同类路径）+ 钻取隔离辅助。
- **验收**：a2 站点变为「打开→采样→关页→再开 ×3 + 等待复采样」，内置 §4-C4 隔离步骤并在输出打印隔离方式；红/绿均含三方值；连续两次独立 run 结论一致。
- **风险**：多周期会拉长 journey 时间；用窄探针先行（§2-30），全 journey 只做最终确认。

## 6. 开放问题（Q）

| 编号 | 问题 | 建议裁定 |
| --- | --- | --- |
| Q1 | 「无手势时宿主自翻转」是否允许（最终一致 vs 立即一致）？ | **不允许**。无 user 意图帧的 active 变化一律视为缺陷，不能以「下次点击自愈」结案。 |
| Q2 | 门禁读「宿主 active」应读宿主内存还是该设备投影？ | 门禁应能同时读两者（新增只读调试字段或特权探针）。当前只读投影，无法区分「宿主内存错」与「每设备选择错」。 |
| Q3 | 每设备选择与宿主内存 active 冲突时，设备视图以谁为准？ | 以该设备投影为准（矩阵 4）；但门禁必须分别断言投影与内存，不得混为一个值。 |
| Q4 | 陈旧每设备选择是否主动清理？ | 不主动清理（矩阵 5）；由 drill 隔离代码化兜底（§4-C4）。 |
| Q5 | 镜像 attach 的身份字段最终形态？ | 只用显式 `materializeOnly`；禁止复用 `intent`（§2-35 判例）。若仍有挂载未带该标记，先补标记再谈修复。 |
| Q6 | 快速开合期间宿主是否需要串行化 activate 队列？ | 若时间线证实 H-D，建议宿主侧对同一 worktree 的 activate 串行化（按到达序），而不是靠 last-write-wins。属工程决策，可先修帧序再加队列。 |

## 7. 主会话审定节

> 待主会话填写；审定 + 独立评审双通过前不派实现令（协议 §9）。

| 项 | 结论（通过/退回/附条件） | 审定人 | 日期 | 备注 |
| --- | --- | --- | --- | --- |
| §1 现象与已证事实 | 通过 | main | 2026-11-17 | 与台账、journey-13/14/15/16/17/final3 证据一致 |
| §2 写入方盘点（含矩阵缺口） | 通过 | main | 2026-11-17 | 四处矩阵未覆盖帧（持久→内存回灌、await 前置、listAll 无 applyOptions、create vs tap 竞争）是本设计最有价值产出 |
| §3 RPC 帧可观测设计 | 附条件通过 | main | 2026-11-17 | 条件：默认关、关闭路径零分配、不记录终端内容/凭据；开关形态仅 localStorage/URL，不新增构建宏 |
| §4 收敛判据 | 通过 | main | 2026-11-17 | C4 隔离必须打印所选方式，未生效判 INVALID |
| T1 帧记录器 | **暂缓（降级为备选）** | main | 2026-11-17 | 先由外部 WS 录制探针（并行通道 `exploratory-r8/u138-frame-timeline.mjs`）产时间线；若无法归因 `applied/applyOptions`，再上 T1 产品内记录器——避免为一诊断改动产品主链 |
| T2 探针接入 | 通过 | main | 2026-11-17 | 接口按 §3.3 归一化，不改探针语义 |
| T3 根因修复 | 附条件通过 | main | 2026-11-17 | 条件：必须先有 ≥1 条红 run 时间线（§2-28）；优先验 H-A（listAll 缺 hostActiveAuthoritative），H-C 用清理选择对照排除 |
| T4 门禁固化 | 通过 | main | 2026-11-17 | a2 多周期 + 隔离打印；窄探针先行，全 journey 只做最终确认 |
| Q1–Q6 产品语义 | 附条件通过 | main | 2026-11-17 | Q1/Q3/Q4/Q5 按建议；Q2 改为「先探针读内存，必要时再加只读调试字段（加性、旧客户端忽略）」；Q6 先修帧序，队列留待时间线证实 |
| 根因假设 H-A~H-D 采信 | 采信但排序调整 | main | 2026-11-17 | 验序：H-A → H-C（对照）→ H-B → H-D；H-C 必须用「清空每设备选择」对照 run 先排除投影差 |
