# U163 P3 设计令 v4：桌面渲染窗口的「宿主布局 → renderer」单次补齐

> **状态（v5）：前提已被真栈证伪，钩子默认关闭，待裁定。** 2026-11-17 · V1–V7 已落地；V8a-1/V8a-2 均 INVALID（分歧前置不成立）；V8b/V8c 暂停；详见附录 D。
> 2026-11-17 · 取代同日 v3（v1/v2 关键分析保留为附录 A/B，v3 评审定位保留为附录 C）· P3（U163 v3/v4 残余）
> 前置：U172 已修复并独立复审 **APPROVED**（`22753c8aee4`，`cloud-platform/test-reports/u172-v2-audit.md`）。v3 收口了 v2 评审（`u163-design-review-v2.md`）的 B1–B5 与 P1/P2；**v4 只修 v3 评审（`cloud-platform/test-reports/u163-design-review-v3.md`）的 B1–B4，不扩大范围**。
> 依据：`defect-ledger.md` U163/U164/U167/U168/U169 行、`u138-active-tab-authority-matrix.md` §2-5、`u153-quick-tab-authority-design.md`、主会话 2026-11-17 裁定 T1–T4。
> 本文只做设计与拆分，不改产品代码。

**与 v3 的差异（v4，仅 B1–B4）**：① **B1** `layoutOnly` 同时抑制 `buildMirroredTerminalTabs`（`apply-preparation-base.ts:200`），落点写入 V2a 文件域；② **B2** V8a 拆 V8a-1/V8a-2，场景 B 补第二配对客户端驱动，`ui:moveSessionTab` 改为**入站监听**计数；③ **B3** C7 点名 `localStructuredSessionVersionByWorktree` + `localStructuredSessionEpochHistoryByWorktree`，写明 `authoritative:true` 的 un-retire 副作用，freshness 带 history 入参且纯判定；④ **B4** V2b 补「无映射、id 不同、同成员」用例并定义 apply 前预 seed 规则；首次 catch-up 的 1→3 只作为 seed 负控（产品路径期望 1→2，避免重复形状被发布）。其余章节仅作与上述四项直接相关的措辞同步。

## 0. 裁定与前提交（不可改）

| 编号 | 裁定 | 本设计落实位置 |
| --- | --- | --- |
| T1 | **只做**「渲染窗口获焦 / 可见性恢复 / 重连后」触发**单次** `session.tabs.list` 的布局补齐；**禁止**新增 wire 字段（`layoutRevision`/`hostLayoutEpoch`），**禁止**连续帧应用车道 | §2、§3、§8；暂缓理由 §2.4 |
| T2 | 焦点权威不变（U138 矩阵 §2-5）：补齐**只应用布局形状**（组数/成员/顺序/树），**不采纳宿主焦点**；窗口自身焦点回写保持 | §5、§6 |
| T3 | 必须复用 `buildMirroredHostGroups`（`layout-groups.ts:219-315`）、`updateHostSessionGroupIdMappings`（`:92-177`）、`adoptHostLayout`；禁止第二份 apply 路径 / 第二份 digest | §5、§6 |
| T4 | E1 = 预置「宿主 2 组 vs renderer 1 组」分叉，获焦后补齐为 2 组；三项机检断言（§8.1）+「删补齐调用必须红」变异 + 非法帧 fixture | §8 |
| U172 | 宿主侧已实现 `hostLayoutAuthorityPending` / `rendererRawLayoutDigest`：冷启动/重连时宿主保留自身的 headless 布局，renderer 只有**原始布局 digest 变化**才接管；pending 在 renderer 采纳宿主布局后的下一次发布释放 | §1.2、§3 C7、§5.4 |

**与 v2 的差异**：① C7 的「epoch 不前进」改为 lineage + 版本严格前进 + authoritative 读语义（B2）；② 首开竞态由 U172 在宿主侧解决，E4 重述（B1）；③ C5 删除（B3）；④ E1 ② 改为按 worktree 布局字段比较（B4）；⑤ §6 按 `buildMirroredHostGroups` 实际行为给出去重规则（B5）；⑥ 触发钩子覆盖纯终端与 popout 写清（P1-1）；⑦ V8 拆成 V8a/V8b，证据改用客户端出站计数 + 宿主 list 断言 + 布局字段（P1-5）。

## 1. 现状事实（先查再写）

### 1.1 桌面 renderer 对本地宿主布局的可见性

| # | 事实 | file:line |
| --- | --- | --- |
| F1 | 桌面 renderer 唯一的本地宿主 session-tabs 订阅是 `session.tabs.subscribeAll`，由 `useLocalStructuredSessionTabsSync` 挂载，且**仅在存在结构化会话时启用**（`useLocalStructuredChatsInUse`） | `local-structured-session-tabs-sync/subscription.ts:83-84`；`local-structured-session-tabs-sync.ts:25-47`；`local-structured-chats.ts:81-85` |
| F2 | 该订阅的 apply 只处理 `executionHost === 'local'` | `snapshot-apply.ts:110-114` |
| F3 | 投影只保留 `agent-session` tab，并**清空** `tabGroupLayout` | `snapshot-projection.ts:12-20`、`:32-35` |
| F4 | apply 选项固定 `contentScope:'agent-session'` + `preserveLocalLayout:true`，布局被有意保留为本地权威 | `snapshot-apply.ts:152-162`；`apply-active-state.ts:83-84` |
| F5 | 因此宿主 headless move/split 写出的组布局**不会**进入桌面 `groupsByWorktree` / `layoutByWorktree` | F2–F4 合成结论（U163 v3 分析 §2.1 已实证） |
| F6 | 宿主 headless 写入会广播，但**不向权威桌面 renderer 推送布局写请求**；桌面只有 move/close 请求通道 | `session-tabs-inventory.ts:203,287`；`session-tab-move-request-relay.ts:57-64` |
| F7 | 对本地宿主，renderer 自己的 tab id 就是宿主 tab id（`syncWindowGraph` 以本地 tab id 发布），可做 identity 映射 | `graph-publication.ts:81-87,105-118`；`mobile-session-snapshots.ts` |

> 结论不变：缺口不是「帧没到」，而是「到了也被投影丢弃，且本地宿主没有布局应用入口」。v3 补的是**入口**，不扩内容面。

### 1.2 U172 已落地的宿主语义（v3 的新地基）

| # | 事实 | file:line |
| --- | --- | --- |
| U1 | 首次打开（`accepted === undefined`）且宿主存在持久 split 时，宿主判定 `firstOpenHostLayoutAuthority` 并**保留宿主布局**；renderer 的旧 1 组首帧不再覆盖 | `orca-runtime-sync-mobile-session-tabs.ts:226-244`（`firstOpenHostLayoutAuthority`）、`:247-283`（`preserveHostLayout` → `nextSnapshot.tabGroups = hostLayoutBase.tabGroups`） |
| U2 | pending 期间只认**原始布局 digest 变化**：`rendererLayoutUnchangedSinceHostPreservation = accepted.hostLayoutAuthorityPending && accepted.rendererRawLayoutDigest === rawLayoutDigest`；内容/焦点帧不放权 | `orca-runtime-sync-mobile-session-tabs.ts:200-207,293-326`；digest `mobile-session-tab-group-layout-signature.ts:22-29` |
| U3 | pending 的释放：renderer 发出与宿主一致的新布局（或采纳宿主广播后的新布局）→ raw digest ≠ 基线 → `keepHostLayoutAuthority=false` → 新 accepted 条目不写 `hostLayoutAuthorityPending` | `orca-runtime-sync-mobile-session-tabs.ts:293-326`；审计 `u172-v2-audit.md` §2.1 |
| U4 | pending 期间前台 move 走 headless 兜底，不丢 move 语义；publisher 不误放 stale 布局 | 审计 §3；`orca-runtime-close-headless-mobile-terminal-tab.ts:224-243` |
| U5 | `rendererRawLayoutDigest` / `hostLayoutAuthorityPending` 是**main-only**，不进入 `session.tabs.list` 投影 | `orca-runtime-runtime-id.ts:150-162`；`session-tabs.ts:25-35` |

> **v3 结论**：CR-N-2（首开发布竞态）在宿主侧已闭合，renderer 无需、也不得为它新增握手或新字段。补齐要做的是：**窗口打开期间远端改了布局**时，把宿主形状读回本地；补齐应用后 renderer 的下一次发布自然带新 digest，恰好完成 U172 pending 的释放（§5.4）。

## 2. 触发点与单次补齐

### 2.1 触发点与挂载覆盖（回应 v2 评审 §3 / P1-1）

| 触发 | 现有可挂点 | v3 动作 |
| --- | --- | --- |
| 窗口获焦 | 无 runtime 级 focus 钩子；既有写法 `use-terminal-viewer-color-publication.ts:31-34` | 新 app-shell 钩子 `use-local-host-layout-catchup.ts`：`window.addEventListener('focus', …)` |
| 可见性恢复 | `lib/window-park-visibility.ts:14-30`（stale-latch 安全）；`use-window-visibility-effects.ts:12-23` | 同钩子订阅 `subscribeWindowParkVisibility`，仅 `getWindowParkVisible()` 假→真触发 |
| 重连后 | **app 级**：`online` + `ui.onSystemResumed`（`use-remote-runtime-recovery-triggers.ts:5-23`）；**结构化在用时**另加 `subscription.ts:101-121`（`type:'end'` 重订阅） | 钩子订阅 app 级恢复信号；结构化订阅路径额外向 `local-host-layout-catchup-signal` 发一次信号（两个源都只是「补一次」） |
| 首次进入 | 启动 restore 已 `listAll`（`inventory-refresh.ts:53-63`），只应用 agent-session | 不新增触发；由 U172 保证首开布局，补齐只在后续 focus/可见/恢复时收敛 |

**挂载覆盖矩阵（必须写清，评审 P1-1）**：

| 窗口/场景 | 是否挂 `useLocalHostLayoutCatchup` | 依据 / 结果 |
| --- | --- | --- |
| 主 app-shell（含纯终端 workspace） | **是**，无条件挂在 `use-app-shell-services.ts:44-45`（`useWebSessionTabsSync()` 旁） | `useAppShellServices` 只在 `App.tsx:43` 调用；与 `useLocalStructuredChatsInUse` 无关，纯终端也有 focus/visibility/online/resume 触发 |
| popout 窗口 | **否** | popout 是独立入口 `popout.tsx`→`DashboardPopoutRoot`，不挂 `useAppShellServices`（`dashboard-popout-window.ts:105-107`），且不发布 graph；若将来 popout 需要布局补齐，**单独立令**（本文不覆盖） |
| web client（浏览器） | 否 | `isWebClientLocation()` → C8 skip |

> 纯终端 workspace 的「重连」语义降级声明：它没有 `session.tabs.subscribeAll`，因此拿不到 `type:'end'`。其重连由 **online / system-resume** 覆盖；本地 daemon 重启若未伴随网络/系统事件，则由下一次获焦/可见性恢复覆盖。这是 P3 可接受边界，写入 R9。

### 2.2 单次语义

1. 一次触发 = 对**当前 active worktree** 至多一次 `session.tabs.list({ worktree })`。
2. 有在飞请求时，后续触发合并为「结束后再跑一次」，不排队、不轮询。
3. 同 lineage 且 `snapshotVersion` 落后 → 丢弃（C7）；形状相等 → 不写 store（幂等）。
4. 无论成功失败都不重试；下一次获焦/可见/恢复再试。失败只记一条 `catchup:failed`。
5. 窗口可见但未获焦时**不**自动补齐（除可见性恢复这一次），避免阅读中被静默重排（SR-N-2）。
6. 触发因 C8 被丢弃时，在 `workspaceSessionReady` false→true 且窗口可见/获焦时补跑**一次**。

### 2.3 补齐数据流

```
focus / visibility-resume / online|system-resume / (structured) reconnect
  → decideLocalHostLayoutCatchup(guards)
      skip: host≠local | 手势中 | web client | 未 ready
      defer: 本地 publish 在飞（等尾沿后跑一次）
      fetch: 其余
  → session.tabs.list({ worktree })          // 单次；视为 authoritative 宿主读（C7）
  → catchupFreshnessVerdict(localCursor, reply, epochHistory)  // lineage + version，见 C7；纯判定（不写表）
  → seedHostSessionGroupIdMappingsFromExactMemberSet(...)      // B4；有 unmapped 组则本帧不应用（§6.3）
  → applyWebSessionTabsSnapshot(rawSnapshot, {
        layoutOnly: true, adoptHostLayout: true, preserveLocalFocus: true,
        hostTabIdsAreLocalTabIds: true, contentScope: 'agent-session' })
  → applyWebSessionTabsStorePatch（一次）
  → recordAppliedSessionPublication(worktreeId, reply)  // V4 从 snapshot-apply 抽出：写版本表 + noteRetiredValue
  → consumeHostLayoutAdoption(worktreeId)
```

### 2.4 连续帧应用车道：暂缓（T1 禁止）

理由不变：连续车道需要单调代际/持续 digest 才能区分回声、旧帧与真实变化（老 CR-N-1 的根因）；`subscribeAll` 帧同时承载内容与布局，重写 `preserveLocalLayout` 会冲击 U164/U167/U168/U169。**重开条件**：(a) 真实用户反馈「不获焦不收敛」不可接受；(b) 宿主已有稳定持久布局代际；(c) U169 映射回归套件全绿。满足前不得在 `updated` 帧上应用布局。

## 3. 何时**不**补齐（C1–C8，v3 修订）

| # | 条件 | 判据（可执行） | 位点 |
| --- | --- | --- | --- |
| C1 | 非本地执行宿主 / 远程 / SSH | `getExecutionHostIdForWorktree(state, worktreeId) !== 'local'` | `lib/worktree-runtime-owner.ts:239-247`；与 `snapshot-apply.ts:110-114` 同门 |
| C2 | 本地有 pending publish | `graphState.syncScheduled \|\| syncInFlight \|\| syncPendingAfterFlight` → `defer`（尾沿后一次） | `sync-runtime-graph/graph-state.ts:43-46`；`sync-runtime-graph.ts:126-158` |
| C3 | 用户手势进行中 | 注入谓词 `isGestureActive()`（V1 冻结签名；V6 接线到全局拖拽闩），或该 worktree 有 pending reorder/focus intent | 拖拽：`useTabDragSplit.ts:106,144,205`；intent：`web-session-reorder-intent.ts`、`web-session-focus-intent.ts` |
| C4 | 多窗口：非本窗口权威 | 结构性判据：钩子只挂主 app-shell（§2.1）；popout 不挂且不发布 graph；**不新增 IPC** | `use-app-shell-services.ts:44`；`popout.tsx`；`dashboard-popout-window.ts:105-107` |
| C5 | **删除（v3）** | v2 的「本地无组 → skip」与 E4 矛盾，且 U172 后宿主布局是首开权威；宿主有布局时允许由宿主形状建组 | 见 §11 B3 |
| C6 | 宿主未报告布局（undefined ≠ 空布局） | `!snapshot.tabGroups \|\| snapshot.tabGroups.length === 0` 且 `snapshot.tabGroupLayout === undefined` → `skip` | `layout-groups.ts:100-106` 同语义 |
| C7 | 补漏读取落后于已应用发布 | 见下方冻结语义；**禁止**比较不透明 epoch 字符串的全序 | `publisher-identity-fences.ts:43-59,163-169`；`snapshot-apply.ts:120-200` |
| C8 | web client / 窗口未 ready | `isWebClientLocation()`，或 `!workspaceSessionReady` → `skip` | `local-structured-chats.ts:91-93`；`use-app-shell-services.ts:36` |

### 3.1 C7 冻结语义（B2 收口）

`session.tabs.list` 是**对宿主当前状态的一次权威读**（与 `refreshLocalStructuredSessionTabs(...,{authoritative:true})` 同一语义），不是推送帧。判定只做两件事：

1. **同 lineage**（`sameSessionTabsPublicationLineage(localCursor.publicationEpoch, reply.publicationEpoch)`）：`reply.snapshotVersion <= localCursor.snapshotVersion` → **skip**（更新帧已应用），不退役、不写游标。
2. **跨 lineage**（宿主重启 / headless 接管 / 新进程 epoch）：**admit**。epoch 是不透明字符串，没有全序；跨 lineage 只说明「换了一代」，权威读必须采纳。
3. 若该 epoch 命中退役历史（`localStructuredSessionEpochHistoryByWorktree`，`local-structured-session-tabs-sync/inventory-generation-fence.ts:15-17`），唯一放行依据是 `admitRetiredValueUnderAuthority(history, epoch, /*authoritative*/ true)`（`publisher-identity-fences.ts:43-57`）。**该函数在 `authoritative=true` 时就地改写 history：把该 epoch 从 `retired` 数组移除（un-retire / revive）**。副作用：此后同一 epoch 的非 authoritative 流帧也不再被退役栅栏挡住（lineage + version 仍然继续把关）。这是 census 的既定语义，必须写进实现注释，并由 V1 的 freshness 用例显式断言。
4. 应用成功后：写 `localStructuredSessionVersionByWorktree` 且 `localStructuredSessionEpochHistoryByWorktree.set(worktree, noteRetiredValue(epochHistory, snapshot.publicationEpoch, 8))`——与 `local-structured-session-tabs-sync/snapshot-apply.ts:190-198` 的写入段逐行一致。注意被引用的是**本地结构化订阅共用的两张表**，不是 web 侧 `noteSessionTabsPublicationEpoch` / `sessionTabsPublicationEpochHistoryByWorktree`（`publisher-identity-fences.ts:175-191`）。该写入段在 HEAD 尚无独立函数（`rg "function recordAppliedSessionPublication"` 无命中）：V4 从 `snapshot-apply.ts:190-198` **抽出并导出** `recordAppliedSessionPublication(worktreeId, snapshot)`，不复制第二份；C7 判定不得假设它今天已可调用。

`catchupFreshnessVerdict(localCursor, reply, epochHistory)` 必须带第三个只读入参（`SessionTabsPublicationEpochHistory | undefined`），**只返回判定，不写两张表**。内部用 `sameSessionTabsPublicationLineage` 比较退役项（`publisher-identity-fences.ts:163-169`），避免第二份 lineage 实现；命中退役但 authoritative 放行时返回 `{ admit: true, unretire: true }`，由 V4 在应用前对**活表**调用 `admitRetiredValueUnderAuthority`（或等价地重写 `retired` 数组）完成 un-retire，再 `recordAppliedSessionPublication`。纯判定与副作用分离是 V1 的机检要求。

> 重启后 E3：新 epoch 跨 lineage → admit → 应用最新 2 组，不会永久 fail-closed；旧 epoch 晚到：进入退役历史 → 非 authoritative 的流帧被挡，补齐自身的 authoritative 读只采纳它当时读到的值。
> `session.tabs.list` 不是纯读：它先执行 `restoreStructuredTabsIfSupported`（`src/main/runtime/rpc/methods/session-tabs.ts:28-35`），桌面以 `clientKind:'runtime'` 调用会命中 restore。E1② 因此只用**无 agent 的 worktree**，且只比较布局字段，不宣称 list 无副作用。

### 3.2 补齐是否参与 U172 pending/释放（必须显式）

- 补齐**不读也不写** `hostLayoutAuthorityPending`（U5：main-only，且 T1 禁止新增 wire 字段）。它通过**结果**参与：补齐把宿主形状写进本地 store → 随后的 `syncWindowGraph` 发布携带新布局 → raw digest ≠ `rendererRawLayoutDigest` 基线 → U172 清 pending（U2/U3）。
- pending 为 true 时宿主持续保留自身布局（U1），因此补齐的 `list` 读到的就是宿主形状——两者一致，不冲突。
- 形状相等时补齐是 no-op，renderer 不重新编排，pending 可能长期保留：这是 U172 审计认定的 **fail-safe**（move 走 headless 兜底），不是缺陷，写入 R10。
- 由此，**补齐是 pending 的正常释放路径之一**（「renderer 采纳宿主布局」），不是旁路。

## 4. 应用范围：形状，不含 pane 内布局

| 项 | 是否应用 | 说明 |
| --- | --- | --- |
| 组集合、组 id、组成员、组内顺序 | **是** | `buildMirroredHostGroups` + §6 去重规则 |
| 组树 `tabGroupLayout`（方向/嵌套/叶/组间比例） | **是**（随树一起） | `apply-active-state.ts:85-124` + `pruneTabGroupLayout`；比例已由宿主持久化（`profile-project-session-state.ts:93`） |
| `activeGroupId` / `activeTabId` / `activeTabType` | **否** | T2；§5.2 |
| pane 内 split 比例 / 展开叶（`terminalLayoutsByTabId`） | **否，明确声明** | 不是 session-tabs 的 `tabGroupLayout`；宿主 headless 只写 `orca-runtime-persist-headless-session-tab-props.ts:170-193`，不进入本车道字段 |
| tab 内容 / 终端滚动 / 标题 | **否** | `contentScope:'agent-session'` 保持现状 |
| 远端 create/close 的成员变化 | **是**（随整形状） | 但只在触发时收敛；两次触发之间不收敛（T1/P3 边界，与 SR-N-2 同类声明） |

## 5. 应用通道：单一路径 + 三个窄选项

### 5.1 复用现有 apply（T3）

不写第二份 store patch；调用现有 `applyWebSessionTabsSnapshot`：

- `adoptHostLayout: true` 解锁 `clientOwnedPlacement = null`（`apply-preparation-groups.ts:53-66`），进入 `buildMirroredHostGroups`。
- 单次消费：`requestHostLayoutAdoption(worktreeId)` → 应用 → `consumeHostLayoutAdoption(worktreeId)`（`web-session-tabs-sync/host-layout-adoption.ts:6-19`）。
- 组映射每帧重建：`apply-preparation-groups.ts:227-233` → `updateHostSessionGroupIdMappings`。
- 布局树：`apply-active-state.ts:85-124`（`preserveLocalLayout` 必须为 false 才写）。
- **禁止**另写 `groupsByWorktree`/`layoutByWorktree` patch，**禁止**另写布局 digest/哈希。

### 5.2 三个窄选项（同一路径参数，不是第二实现）

在 `WebSessionTabsSnapshotApplyOptions`（`web-session-tabs-sync/state.ts:71-79`）新增：

| 选项 | 语义 | 改动点 |
| --- | --- | --- |
| `preserveLocalFocus?: boolean` | 不采纳宿主 active；本地 `activeGroupIdByWorktree`/`activeTabIdByWorktree` 仍在则保持，否则回退 `nextGroups[0]` | `apply-preparation-unified.ts:43`：`honorHostActive = (adoptHostLayout && !preserveLocalFocus) \|\| hostActiveAuthoritative`（`:203-230` 的跳过逻辑已由 `:211` 门控，无需再改）；`apply-active-state.ts:45-50` 优先本地值 |
| `hostTabIdsAreLocalTabIds?: boolean` | 本地宿主 tab id 即宿主 id：`buildHostToLocalTabIdMap` 后为出现在 `snapshot.tabGroups` 里的本地 tab id 补 identity 映射 | `apply-preparation-unified.ts:232-241` |
| `layoutOnly?: boolean` | 只应用布局形状：**同时** ① 令 `reconcilesNonAgentTabs=false`（保留全部本地非 agent tab），且 ② **抑制 `buildMirroredTerminalTabs`**（v4 新增的第 4 个改动点）；用完整 `snapshot.tabGroups` 建组，不创建/镜像终端。`contentScope` 的 tab 过滤语义不变 | ① `apply-preparation-base.ts:151`：`const layoutOnly = options?.layoutOnly === true`；`reconcilesNonAgentTabs = !layoutOnly && options?.contentScope !== 'agent-session'`。② `apply-preparation-base.ts:200`：`const mirroredTerminalTabs = layoutOnly ? [] : buildMirroredTerminalTabs(...)`。**不改 builder 签名**，故 §2-56 的全量调用点不变：生产 `apply-preparation-base.ts:200`、测试 `mirrored-terminal-recovery-ledger.test.ts:58`；若将来必须改签名，这两处都要钉 |

> **B1 机制说明（v3 评审 §3）**：`reconcilesNonAgentTabs=false` 时 `retainedTerminalTabs = currentTerminalTabs`（`apply-preparation-base.ts:187-196`），但 `:200` 仍无条件从 raw `snapshot.tabs` 调 builder；raw snapshot 下 `nextTerminalTabs = [...currentTerminalTabs, ...mirrored]`（`:223-227`）会让每个本地终端多一份 `web-terminal-*`（`terminal-build.ts:72-73`）。所以只改 `:151` 不成立，必须同时抑制 `:200`。browser/editor 镜像不受同一问题影响：它们按 host 页面/文件身份复用本地行（`findBrowserWorkspaceForRemotePage`、`createMirroredEditorFileResolver`），只有终端使用派生的 `web-terminal-*` id；本设计只抑制终端 builder，不扩大文件域。

> `adoptHostLayout` 目前被 `resolveHostActiveApplyOptions` 限定给云会话（`host-active-apply-options.ts:17-37`）；本地补齐不走该 helper，直接传参。web 端不传新选项 → 行为不变。

### 5.3 焦点（T2）

补齐**永不**把 `activeGroupIdByWorktree` / `activeTabIdByWorktree` 写成宿主值；窗口自身焦点回写路径不变。不新增焦点回跳，也不为布局形状新增 U138 矩阵条款。

### 5.4 与 U172 pending 的衔接（写死实现顺序）

1. C2 defer 的尾沿发布先发生（内容帧，raw digest 不变，pending 保持）。
2. 补齐 `list` 读到宿主布局。
3. 补齐应用 → store 变宿主形状。
4. 下一次 `syncWindowGraph` 发布携带新布局 → 宿主 `rendererLayoutUnchangedSinceHostPreservation=false`，`keepHostLayoutAuthority=false` → **pending 释放**。
5. 宿主布局与 renderer 已一致，接受后布局字段不变（version 可前进）。

> 若第 4 步的发布被 C2 再次推迟，pending 只是延后释放，不产生错误状态。

## 6. 组 id 映射与去重（按 `buildMirroredHostGroups` 实际行为，B5 收口）

### 6.1 代码事实

| # | 事实 | file:line |
| --- | --- | --- |
| G1 | 建组时以 `hostGroup.id` 查 `existing`，但 `existing` 只按本地组的**字面 id** 索引 | `layout-groups.ts:236,253-254` |
| G2 | 落组时**恒用宿主组 id** | `layout-groups.ts:289-301` |
| G3 | 未被 `seen` 的本地组会被**原样补回** | `layout-groups.ts:304-312` |
| G4 | `updateHostSessionGroupIdMappings` 在组构建**之后**运行（`apply-preparation-groups.ts:227-233`），无法回写 id | `layout-groups.ts:92-177` |
| G5 | 映射解析函数已存在于同文件 import 中 | `layout-groups.ts:15`；`tracking-mappings.ts:74` |

> 因此 v2 §6 的「已有映射保留本地组 id」**与代码不符**：本地组 id ≠ 宿主组 id 且成员重叠时，结果是「宿主组 + 本地旧组」→ 1→3 而非 1→2。

### 6.2 v3 冻结规则

1. **先声明归属（claimed）**：对每个本地组，用 `resolveHostSessionGroupIdForWebSessionGroup` 取其宿主组 id H；若 H 出现在本帧 `hostGroups` 中，该本地组被 H **claimed**。
2. **claimed 组参与合并**：`buildMirroredHostGroups` 为宿主组 H 选 `existing` 时，除字面 id 命中外，也接受「claimed 到 H」的本地组（复用其 `tabOrder`/`activeTabId`/`recentTabIds`）。
3. **claimed 组不进 leftover**：`layout-groups.ts:304-312` 的补回循环跳过 claimed 组。由此每个宿主组恰好产生一个本地组（1→2，不产生 1→3）。
4. **多组 claim 同一 H**（理论歧义）：保留本地顺序中的第一个，其余跳过并记 `catchup:ambiguous-group-claim` 诊断；不猜测。
5. **新宿主组 id**（本地从未见过，如 headless split 的 `randomUUID()`）：直接以宿主 id 建组（G2），无需预映射。
6. **claimed 但宿主帧中不存在 H**（`hostGroups` 已定义）：视为宿主删除该组 → 丢弃本地组，不从 leftover 复活；`hostGroups === undefined` 是「未报告」，走 C6 skip，不进入本规则。
7. **未知 tab id**（组内成员无法解析到本地 tab）：**跳过该成员**，不整帧拒绝；组变空则丢弃该组。
8. **未知成员不清映射**（P1-6）：`updateHostSessionGroupIdMappings` 校验映射时，若宿主组含未解析成员，则本帧**不判定映射失效**（等成员后续到达）；只有「宿主组成员的全部可解析部分与本地映射成员集确实不等」才清映射。
9. **每帧清理**：本地组消失、映射宿主组消失、成员集确实不等 → 清映射（G4 既有行为）。

> 规则 2/3 需要改 `buildMirroredHostGroups` 一处（claimed 判定 + leftover 跳过），仍在同一 apply 路径内，不新增 digest/第二实现。V2b 独占该文件域。

### 6.3 映射前置与首次 catch-up（B4 收口）

**事实**：claimed 规则依赖「上一帧已建立映射」。纯终端 workspace 的结构化订阅只看到投影后的 agent-only groups（`snapshot-projection.ts:12-20,32-35`），`hostBackedMembers.size===0` → 订阅路径从不建立组映射；映射只能由 `updateHostSessionGroupIdMappings` 的**精确成员集**在一次 apply **之后**建立（`layout-groups.ts:150-176`）。因此「本地 id ≠ 宿主 id、成员相同、无映射」的首个 catch-up 无法 claim。

**为什么不能把 1→3 当产品期望**：补齐的 store patch 会触发一次 graph publish（R1/U172 释放路径）。若首帧产出「宿主组 + 重复的本地组」，这个重复形状会被发布并成为宿主布局，之后再也收敛不回 2 组。1→3 只能存在于**不发布的单测负控**。

**seed 规则（V2b 提供纯解析 + V4 在 apply 前调用）**：
1. 从 `updateHostSessionGroupIdMappings` 抽出纯函数 `resolveUniqueHostGroupIdByMemberSet({localGroup, hostGroups, hostToLocalTabId})`（同文件，无副作用），供 update 与补齐预 seed 共用，避免第二份成员集实现。
2. V4 在 `applyWebSessionTabsSnapshot` **之前**对每个本地组预 seed：仅当「无映射、且恰好一个宿主组与其 host-backed 成员集完全相等」时 `setHostSessionGroupIdMapping(本地组 → 宿主组)`；有歧义（≥2 个同成员集）不 seed。
3. 预 seed 后仍有未解析的本地组（有 host-backed 成员、无映射、无 literal id 命中、无唯一精确匹配）：**本帧不应用组形状**——返回 `catchup:unmapped-group`，不写 store、不发布，下一次触发再试。宁可暂不收敛，也不把重复组发布成宿主布局。
4. 只有无 host-backed 成员的纯本地组（本地独有 tab）才走 leftover 补回。

**冻结期望**：

| 用例 | 前置 | 期望 |
| --- | --- | --- |
| B4-a（已有映射） | `resetHostSessionGroupIdMappingsForTests()` 后 `setHostSessionGroupIdMapping({environmentId, worktreeId, groupId: 本地组id}, 宿主组id)`（`tracking-mappings.ts:160-170`） | 1→2；无重复组；映射保留 |
| B4-b（无映射、id 不同、同成员） | 不 seed；本地 1 组 `{t1,t2}`，宿主 2 组 `H1:{t1,t2}` / `H2:{t3}`；按规则 2 预 seed | **1→2**（H1 + H2）；无重复组；映射 `本地组→H1` |
| B4-b 负控（关掉预 seed） | 同上，不调用规则 2 | **1→3**（H1 + H2 + leftover 本地组）——用于证明 seed 是承重的；**不得**出现在产品路径 |
| B4-c（无唯一精确匹配） | 本地 `{t1,t2}`，宿主 `H1:{t1}` / `H2:{t2}`，无映射且无 literal id 命中 | V4 返回 `catchup:unmapped-group`，**不应用、不发布**；store 组数不变 |

**对 E1/V7 与真栈的影响**：
1. V2b/V7 的每个用例先 `resetHostSessionGroupIdMappingsForTests()`，避免跨用例串味。
2. 断言「1→2」的夹具（含 E1/V7）必须显式 seed `本地组 → 宿主组`，或使用 B4-b 的精确同成员夹具。
3. V8a-1 的场景 A 预置布局必须是「原组保持原成员 + 拆分出的新组由新 tab 组成」，使原组与某个宿主组精确同成员；首次 focus 期望 1→2（不得按 1→3→2 断言）。
4. **V8a-2 独立冷启动**：不得复用 V8a-1 focus 后的状态（pending 已释放，move 会被转发）；场景 B 的 headless split 保留原宿主组 id，本地组按 literal id 命中，focus 期望 1→3（宿主 3 组）。
5. R5/E1④ 的措辞按此收窄：1→2 是产品期望，1→3 只是负控（真栈场景 B 的 1→3 是「宿主 3 组」的收敛，不是重复组）。

## 7. 拆分令 v4（每令 ≤20 分钟，文件域不重叠，验收可机检）

| 令 | 内容 | 文件域（独占） | 依赖 | 机检验收 |
| --- | --- | --- | --- | --- |
| V1 | **决策纯函数 + 单飞闩 + C7 判定**：`decideLocalHostLayoutCatchup`（C1–C8，C3 为注入谓词 `isGestureActive`）、`catchupFreshnessVerdict(localCursor, reply, epochHistory)`、`createLocalHostLayoutCatchupLatch` | 新 `src/renderer/src/runtime/local-host-layout-catchup/decide-local-host-layout-catchup.ts`、`.../catchup-freshness.ts`、`.../local-host-layout-catchup-latch.ts` + 三个测试 | — | 覆盖 C1–C8 每条件一例（C3 用注入谓词 true/false）；freshness：同 lineage 旧 version skip、跨 lineage admit、退役 epoch 仅 authoritative admit 并返回 `unretire:true`；**判定不写 `localStructuredSessionVersionByWorktree` / `localStructuredSessionEpochHistoryByWorktree`**；`pnpm tc` 0 |
| V2a | **apply 选项**：`preserveLocalFocus`、`layoutOnly`（含 B1 的 builder 抑制）、`hostTabIdsAreLocalTabIds` | `web-session-tabs-sync/state.ts`、`apply-preparation-unified.ts`、`apply-preparation-base.ts`（`:151` 选项 + `:200` builder 抑制）+ 新 `local-host-layout-options.test.ts` | V1（类型命名） | `adoptHostLayout+preserveLocalFocus` 不改本地 active；identity 映射使 2 组建；**raw snapshot + layoutOnly + 本地 2 个终端 → `tabsByWorktree` 不出现 `web-terminal-*`，本地终端 id 原样保留（0 重复）**；web 默认参数行为不变 |
| V2b | **组去重**：claimed 组参与合并、不进 leftover、claimed-but-absent 丢弃、未知成员不清映射；**B4 用例与预 seed 纯函数**（`resolveUniqueHostGroupIdByMemberSet`） | `web-session-tabs-sync/layout-groups.ts` + 新 `local-host-layout-group-claim.test.ts` | V2a | 夹具「本地 id ≠ 宿主 id、成员相同、**已 seed 映射**」→ 1→2；**B4-b 预 seed 后 1→2；关掉预 seed 的负控 1→3（仅单测）**；未知 tab → 跳过且映射保留；宿主组删除 → 本地组消失；**raw snapshot + layoutOnly 组合下无重复终端组** |
| V3 | **本地 active 保持**：`preserveLocalFocus` 下优先本地 active，组消失回退首组 | `web-session-tabs-sync/apply-active-state.ts` + 新 `local-host-layout-focus-pin.test.ts` | V2a | 2 例：焦点仍在组内→保持；本地组消失→回退且不报错 |
| V4 | **补齐执行器**：单次 list、freshness 门（带 history）、**apply 前预 seed 组映射**、`catchup:unmapped-group` 守卫、走 `applyWebSessionTabsSnapshot`、`request/consumeHostLayoutAdoption`、`recordAppliedSessionPublication` | 新 `.../run-local-host-layout-catchup.ts` + 测试；`local-structured-session-tabs-sync/snapshot-apply.ts`（仅抽出并导出 `recordAppliedSessionPublication`） | V1/V2a/V2b/V3 | fake rpc：`session.tabs.list` 恰 1 次、`session.tabs.move` 0 次；旧 version 被 C7 丢弃；形状相等时 store 引用不变；**B4-b 预 seed 后 1→2；unmapped 帧不写 store/不发布并记诊断**；既有 snapshot-apply 套件绿 |
| V5 | **触发钩子**：focus + `subscribeWindowParkVisibility` + app 级 online/system-resume + 结构化重连信号；挂主 app-shell；C2/C8；ready 补跑一次 | 新 `app-shell/use-local-host-layout-catchup.ts`、`runtime/local-host-layout-catchup-signal.ts`；`app-shell/use-app-shell-services.ts` + 钩子测试 | V1/V4 | focus/visibility/online 各触发 1 次；ready=false 不触发、变 true 补跑 1 次；web client 不触发；纯终端 workspace（无结构化会话）仍触发 |
| V6 | **手势闩全局化 + 重连信号接线**：拖拽计数抽为可读 registry；结构化订阅 `end`/resubscribe 发信号 | 新 `components/tab-group/tab-drag-gesture-registry.ts`；`components/tab-group/useTabDragSplit.ts`、`tab-drag-gesture-lifecycle.ts`；`local-structured-session-tabs-sync/subscription.ts` + 两个测试 | V5 | 拖拽开始→`defer`；结束保留一次待跑；重连分支恰发 1 次信号 |
| V7 | **E1 隔离栈判别 + 变异 + 非法帧**：宿主 2 组 / renderer 1 组；焦点触发；三项断言 + 组数 1→2；删 apply 调用→红；非法帧 fixture | 新 `.../local-host-layout-catchup-e1.test.ts` | V4/V5/V6 | 正常态 4 断言绿；变异态红且失败指向组数；未知 tab/未知组/重复 claim 不产生重复组 |
| V8a-1 | **真栈 harness + 场景 A（首开基线 + 映射建立）**：`ORCA_BACKGROUND_LAUNCH=1` + `ORCA_E2E_HEADLESS=1` + CDP 隐藏渲染器（复用 `exploratory-r2/desktop-harness.mjs` 的 launch/隔离）；预置持久 2 组后重启（U172 首开宿主保留；原组保持原成员，拆分出的新组由新 tab 组成，保证预 seed 精确匹配） | 新 `cloud-platform/scripts/exploratory-r2/u163-v3-layout-catchup.mjs`（scenario A） | V7 | 退出码 0；① 出站 `session.tabs.move`=0（包裹 `window.api.runtime.call` 按 method 计数）且入站 `ui:moveSessionTab`=0（独立注册 `window.api.ui.onMoveSessionTab` 计数，见 §8.1）② 宿主 `session.tabs.list` 的 `tabGroups`/`tabGroupLayout` 触发前后逐字段相等 ③ 焦点 tab 不变 ④ focus 后 1→2（预 seed 生效，见 §6.3）；terminal tab 不重建 |
| V8a-2 | **真栈场景 B（开窗期 headless 改布局）**：**独立冷启动**（复用 V8a-1 harness 代码，重新预置 2 组）加第二个配对 web 客户端（`chromium` + `login`/`hostCall`，先例 `web-journey-13-gates.mjs:105-170,574-598`）；在 U172 pending 窗口内由该客户端 headless split（宿主 3 组、renderer 仍 1 组），回桌面发 `focus` → 本地 1→3 | 同脚本 scenario B（新增 web context + 独立 launch；**不新增 debug IPC、不做主进程注入**） | V8a-1（仅复用 harness 代码） | 退出码 0；move 后桌面 `ui:moveSessionTab` 计数仍为 0（>0 说明被转发，前置失败 → **INVALID**）；focus 后 ① 出站 move 0、入站 `ui:moveSessionTab` 0 ② 宿主布局字段前后等 ③ 焦点不变 ④ 组数 1→3 且无重复组 |
| V8b | **真栈反向 + 报告**：临时注释补齐调用 → 场景 B 红（组数不收敛）；回滚；写报告 | 同上脚本的变异开关；`cloud-platform/test-reports/u163-v3-e2e.md` | V8a-2 | 变异 RED 记录 + 回滚 diff 为空；报告中 4 项逐项 PASS/RED |

> **V8a-2 的 headless 前置（B2）**：宿主只有在 `acceptedRendererMobileSessionLayoutMatchesHost=false` 时才走 headless（`orca-runtime-close-headless-mobile-terminal-tab.ts:151-174`）；U172 pending 时该判据取 `rendererRawLayoutSignature`（`:228-240`）。首开后桌面仍是旧布局、宿主保留 2 组 → 判据必为 false，第二客户端的 move 必然 headless。若 pending 已释放（桌面已发布宿主形状，例如 V8a-1 的 focus 之后），move 会被转发成 `ui:moveSessionTab`；因此 **V8a-2 不得复用 V8a-1 focus 后的状态，必须独立冷启动**；转发发生时用例以 INVALID 终止。
> 场景 B 的 split 应保留原宿主组 id（headless 只给新组 `randomUUID()`）；本地组按 literal id 命中，无需预 seed。

**串并行（v3 修正）**：
- V1 先行。
- V2a → V2b → V3 串行（V2a 定义类型/选项，V2b 依赖其 apply 参数，V3 依赖 V2a；同属 apply 管线）。
- V4 依赖 V2a/V2b/V3。
- V5 依赖 V1/V4。
- **V6 依赖 V5，不得与 V2a/V2b 并行**（v2 评审 P2-2 的计划矛盾已消除）。
- V7 依赖 V4/V5/V6。
- V8a-1 → V8a-2 → V8b 串行（V8a-2 复用 V8a-1 的 harness 代码但独立冷启动；冷启动 + web 登录成本计入 V8a-2，若超 20 分钟，把预置/登录缓存为前置，断言不变）。
- 任何两令不得同时修改同一文件；V4 对 `snapshot-apply.ts` 只有「抽出并导出」一处，V5 之前不得再改该文件。

## 8. 可测性（T4，v4 可机检版）

### 8.1 E1（判别场景）

预置：`resetHostSessionGroupIdMappingsForTests()` 后 **seed** `local-left → host-left` 的映射（`setHostSessionGroupIdMapping`，`tracking-mappings.ts:160-170`）；本地 store 1 组（`local-left`），宿主快照 2 组（`host-left`/`host-right`，头部 headless 新 id），窗口焦点在某文本 tab。派发 `focus`。不 seed 的版本见 §6.3 B4-b 负控（1→3，仅单测；产品路径由 V4 预 seed，期望 1→2）。

| # | 断言 | 采样方式（不依赖 trace） |
| --- | --- | --- |
| ① | **出站 move = 0，且无入站 move**：`session.tabs.move`（出站 `runtime.call`）= 0；`ui:moveSessionTab`（main→renderer 入站 IPC）= 0 | 隔离栈：fake rpc/graph 投递计数器；真栈：CDP 包裹 `window.api.runtime.call` 按 method 计数出站；入站用 `window.api.ui.onMoveSessionTab(cb)` **另注册一个计数监听**（`src/preload/api/ui-bridge-terminal-and-session-tabs.ts:215-220`；多监听器同时收事件，不影响 app handler），**不得**用 `runtime.call` 包裹——它不是出站 RPC |
| ② | **宿主布局字段不变**：该 worktree 的 `tabGroups`（id/activeTabId/tabOrder/recentTabIds）与 `tabGroupLayout` 触发前后**逐字段深等** | 宿主 `session.tabs.list` 前后比较（隔离栈用 fake 宿主快照）；**不再用整库哈希** |
| ③ | **焦点不变**：`activeGroupIdByWorktree`/`activeTabIdByWorktree` 前后值相等 | store 读取 |
| ④ | **组数 1→2**，且成员顺序/树与宿主一致 | store `groupsByWorktree` + `unifiedTabsByWorktree` + `layoutByWorktree` |

**变异**：删除 V4 中「调用 `applyWebSessionTabsSnapshot`」一行 → ④ 红（①–③ 仍绿）。
**非法帧 fixture（V7 必含）**：未知 tab id（宿主组含本地不存在的 tab）、未知组 id（本地映射指向帧中不存在的组）、本地 id ≠ 宿主 id 且成员相同 → 断言：不整帧拒绝、无重复组（仍 1→2）、映射不被误清。

### 8.2 E5（回声/幂等）

- 一次远端布局变化 + 一次获焦：`session.tabs.list` = 1；`session.tabs.move` = 0。
- 再次获焦且形状相等：`list` 再 1 次、store 引用不变、宿主布局字段仍相等。
- **不使用** `__orcaSessionTabsTrace`（默认关闭，U169 已判证据失效）；若用必须显式开启并断言非空。

### 8.3 其余测点

| 编号 | 场景 | 断言 |
| --- | --- | --- |
| E2 | 获焦瞬间正在拖拽 | C3 不应用；松手后无自动补跑；无 tab 丢失/重复组 |
| E3 | 宿主重启后再获焦 | 新 epoch 被 authoritative 读采纳为 2 组，无「重启后永久 fail-closed」；旧 epoch 晚到不回滚；焦点不变 |
| E4 | **U172 生效后的首开与开窗期变化** | 首开即 2 组（U172 前置断言，断言主体是宿主保留而非补齐）；窗口打开期间远端改布局 → 获焦后本地收敛。删除 v2 的「首帧只建基线」表述 |
| E6 | 焦点负控 | 宿主 active 变化后获焦：布局更新、焦点保持本地（T2） |

### 8.4 终端身份断言（SR-P2-4，落入 V7/V8a-1/V8a-2）

应用前后终端 tab 的 `id`/`ptyId`/`terminalLayoutsByTabId` 未重建（只换组/树）；滚动缓冲不在断言内。

## 9. 风险

| # | 风险 | 防护 |
| --- | --- | --- |
| R1 | 补齐 store patch 触发一次 graph publish | 不发 move；发布形状与宿主相同；宿主保留布局、只抬 version（U172）；②只比较布局字段；**有 unmapped 组时 V4 不写 store、不发布**（§6.3） |
| R2 | 可见但未获焦被静默重排 | 只在 focus/可见性恢复/重连；无连续车道 |
| R3 | 拖拽中应用导致目标组消失 | C3 注入谓词 + V6 registry；E2 |
| R4 | 未知 id 永久卡死 | 跳过未知项、每触发重试、映射每帧清理；未知成员不清映射（§6.2-8） |
| R5 | 映射冲突/重复组 | claimed 规则（§6.2）+ apply 前精确成员集预 seed；无唯一匹配则本帧不应用（§6.3）；V2b 夹具；E1 ①/④ |
| R6 | 远程/SSH 误应用 | C1；与 `snapshot-apply.ts:110-114` 同门 |
| R7 | 多窗口互相覆盖 | 钩子仅主 app-shell；popout 不挂且不发布 graph；补齐只读 |
| R8 | list 晚到回滚 | C7 冻结语义（§3.1） |
| R9 | 纯终端 workspace 无重连信号 | 钩子独立挂载；重连降级为 online/system-resume + 下一次 focus/visibility（§2.1） |
| R10 | renderer 从不重新编排 → U172 pending 长期保留 | 审计认定为 fail-safe（move 走 headless 兜底）；补齐若形状相等则 no-op，不强行造变化 |
| R11 | 「list 之后、republish 之前」其他设备又改布局 | 本次整形状重发可能覆盖更新的远端布局；声明为 P3 边界，依赖 U172 接受门与下一次触发收敛 |

## 10. 裁定落实表

| 裁定 | 落实 | 证据位点 |
| --- | --- | --- |
| T1 单次 fetch | §2.2；V4/V5/V8a-1/V8a-2 计数 | `run-local-host-layout-catchup.ts` |
| T1 无新 wire 字段 | 全文无 `layoutRevision`/`hostLayoutEpoch`；U172 字段 main-only 不引入 | §0、§1.2 U5 |
| T1 无连续车道 | §2.4 | §2.4 |
| T2 只应用形状 | §4；`preserveLocalFocus`；E6 | §5.2/§5.3 |
| T2 焦点回写保持 | 未改焦点动作 | §5.3 |
| T3 复用三函数 | §1.2、§5.1、§6；V2b/V4 文件域 | `layout-groups.ts:92-177,219-315` |
| T3 禁止第二 apply/digest | §5.1；V4 只调 `applyWebSessionTabsSnapshot` | §5.1 |
| T4 E1 三断言 + 变异 | §8.1；V7 | V7 |
| T4 E5 不用 trace | §8.2；V8a-1/V8a-2 用出站计数/宿主 list | V8a-1、V8a-2 |

## 11. v2 评审阻断项逐条处理（B1–B5 + P1）

| 编号 | v2 问题 | v3 处理 | 落点 |
| --- | --- | --- | --- |
| **B1 / CR-N-2 / P0-1** | 首开 renderer 首帧覆盖宿主布局，C2 反而读到被覆盖状态 | **由 U172 闭合**（宿主 `firstOpenHostLayoutAuthority` + `preserveHostLayout`）。v3 删除 C2 的「竞态防护」叙事；E4 重述为「首开即 2 组（U172），补齐只处理开窗期远端变化」 | §1.2 U1/U3、§8.3 E4、V8a |
| **B2 / CR-N-1 / P0-2** | C7 用不透明 epoch 的「不前进」不可执行 | C7 冻结为 lineage + version + authoritative 读（§3.1）；`recordAppliedSessionPublication` 复用现有游标/退役逻辑 | §3.1、V1、V4 |
| **B3 / P1-2** | C5 与 E4 矛盾 | **删除 C5**；宿主未报告才 skip（C6）；宿主有布局时允许建组 | §3、§11 |
| **B4 / P1-4** | E1 ② 整库哈希不成立 | 改为按 worktree 的 `tabGroups`/`tabGroupLayout` 逐字段比较；R1 改为「布局字段不改写，version 可前进」 | §8.1 ②、R1 |
| **B5 / P1-3 / SR-N-6** | §6「保留本地组 id」与 `buildMirroredHostGroups` 不符，产生重复组 | claimed 规则（§6.2）：claimed 组参与合并且不进 leftover；claimed-but-absent 丢弃；补 1→2 夹具 | §6、V2b、V7 |
| P1-1 | 纯终端 workspace 无重连信号源 | 钩子无条件挂主 app-shell；重连降级为 online/system-resume；popout 不挂并单独立令 | §2.1 |
| P1-5 | 宿主侧 move RPC 计数器不存在 | V8 证据改为「客户端出站计数（CDP 包裹 `runtime.call`）+ 宿主 `session.tabs.list` 断言 + 布局字段比较」；V8 拆 V8a/V8b | §7、§8.1 ①/② |
| P1-6 | 未知成员静默丢成员并误清映射 | §6.2-8：含未解析成员时本帧不判映射失效 | §6、V2b |
| P2-1 | 位点偏差 | 已修正：`apply-active-state.ts:45-50`；`web-session-tabs-sync/host-layout-adoption.ts`；`workspaceSessionReady` 在 `use-app-shell-services.ts:36`；删除 `:203-230` 冗余改动 | §5.2 |
| P2-2 | V2/V6 并行矛盾、V1 隐藏依赖 V6、V8 超时 | V6 依赖 V5 且不与 V2 并行；C3 改注入谓词；V8 拆 V8a/V8b | §7 |
| P2-3 | `layoutOnly` 与 `contentScope` 重叠 | 冻结优先级：`layoutOnly` 只关内容 reconcile，`contentScope` 仍做 tab 过滤 | §5.2 |
| P2-4 | R7「被拒」措辞 | 改为「宿主 `syncWindowGraph` 对非权威 publisher **抛错**；renderer 侧必须不发起」 | §3 C4、R7 |
| P2-5 | C6 空布局 vs 未报告 | C6 区分：`undefined` = 未报告 → skip；显式空数组 + 无树 → skip（不保留残组） | §3 C6 |

### 11.1 v3 评审阻断项逐条处理（v4，B1–B4）

| 编号 | v3 评审问题 | v4 处理 | 落点 |
| --- | --- | --- | --- |
| **B1** (P0) | `layoutOnly` 只改 `:151` 不抑制 `:200` 的 `buildMirroredTerminalTabs`，raw snapshot 下本地终端重复 | 在 `apply-preparation-base.ts` 同时：`reconcilesNonAgentTabs = !layoutOnly && contentScope !== 'agent-session'`，且 `mirroredTerminalTabs = layoutOnly ? [] : buildMirroredTerminalTabs(...)`；**不改 builder 签名**（§2-56 调用点仍为 `:200` 与 `mirrored-terminal-recovery-ledger.test.ts:58`）。落点归 V2a；V2b 夹具用 raw snapshot + layoutOnly 组合覆盖 | §5.2、V2a、V2b |
| **B2** (P1) | 场景 B 无 headless 驱动；`ui:moveSessionTab` 是入站 IPC，不能用 `runtime.call` 计数 | V8a 拆 V8a-1（harness + 场景 A + 映射建立）/ V8a-2（**独立冷启动** + 第二配对 web 客户端在 pending 窗口内 headless split，先例 `web-journey-13-gates.mjs:105-170,574-598`）；入站计数改为 `window.api.ui.onMoveSessionTab` 独立监听；转发即 INVALID | §7 V8a-1/V8a-2、§8.1① |
| **B3** (P2) | C7 历史表点错（web 的 `noteSessionTabsPublicationEpoch`）、un-retire 副作用未写、freshness 未带 history | C7 点名 `localStructuredSessionVersionByWorktree` + `localStructuredSessionEpochHistoryByWorktree` + `noteRetiredValue`；写明 `admitRetiredValueUnderAuthority(...,true)` 的 un-retire 副作用；`catchupFreshnessVerdict` 带只读 `epochHistory`，纯判定，un-retire 由 V4 落表 | §3.1、V1、V4 |
| **B4** (P2) | claimed 依赖既有映射，缺「无映射、id 不同、同成员」用例与期望 | §6.3：抽出纯 `resolveUniqueHostGroupIdByMemberSet`；V4 在 apply 前预 seed；B4-a/B4-b 均 1→2；关掉 seed 的负控 1→3（仅单测，不发布）；无唯一精确匹配 → `catchup:unmapped-group`，不写 store/不发布；V2b/V7 夹具显式 seed 或精确同成员；真栈场景 A 预置精确同成员布局 | §6.3、V2b、V4、§8.1、V8a-1 |

## 12. 主会话审定

| 项 | 结论 | 日期 |
| --- | --- | --- |
| 触发集 = 获焦 / 可见性恢复 / 重连（含纯终端降级），单次 `session.tabs.list` | 待审定 | — |
| 不新增 wire 字段、不做连续车道 | 待审定 | — |
| 只应用形状，不采纳宿主焦点 | 待审定 | — |
| 复用 `buildMirroredHostGroups` / `updateHostSessionGroupIdMappings` / `adoptHostLayout` | 待审定 | — |
| C7 = lineage + authoritative 读（替代 epoch 全序） | 待审定 | — |
| 删除 C5；claimed 组去重规则 | 待审定 | — |
| V1–V8（V8a-1/V8a-2/V8b）拆分与串并行 | 待审定 | — |
| v4 B1–B4 收口方式 | 待审定 | — |

---

## 附录 A：v1 关键分析（保留）

> 已按代码评审修正：W3 仅 web/desktop 且宿主 headless；笔误文件名已改；行号 152-162。

### A.1 写入方矩阵

| 编号 | 写入方 | 入口 | 宿主落盘 | 桌面 renderer 是否收到 | 布局是否应用 |
| --- | --- | --- | --- | --- | --- |
| W1 | Web 客户端 move/split/reorder | `session-tab-mutation-methods.ts:55-87` | 窗口签名匹配 → 转发 `ui:moveSessionTab`；否则 headless 落盘 | 转发分支收到命令；headless 分支只收内容帧 | 转发分支应用；headless 分支**不应用**（补齐目标） |
| W2 | mobile move/reorder/split | 同一 RPC allowlist | 同 W1 | 同 W1 | 同 W1 |
| W3 | web/desktop 改 pane 内布局 | `updatePaneLayout` | 仅 headless 落盘 | 收内容帧 | **不应用（v2 起移出范围，§4）** |
| W4 | headless 自写布局 | `orca-runtime-move-headless-mobile-session-tab.ts`；水合 | `mobileSessionTabsByWorktree` | 广播 | **不应用（补齐目标）** |
| W5 | 另一桌面窗口 | 不发布 tab graph | — | — | 不适用 |
| W6 | 多窗口权威切换 | `orca-runtime-sync-window-graph.ts:36-40` | 非权威发布**抛错** | 不回放 | 不适用 |
| W7 | 本窗口自己 | `graph-publication.ts:56-61` → `runtime-bridge.ts` | `syncWindowGraph` | 自己即作者 | 无回声车道，形状相等即 no-op |

### A.2 v1 的「三处有意丢弃」

| 丢弃点 | file:line | 说明 |
| --- | --- | --- |
| 订阅存在 | `subscription.ts:83-109` | `snapshots`/`updated` 都会进来 |
| 非本地宿主跳过 | `snapshot-apply.ts:110-114` | 只处理 `executionHost === 'local'` |
| 投影只留 agent-session、清空树 | `snapshot-projection.ts:12-20,32-35` | `tabGroupLayout: undefined` |
| apply 强制本地布局 | `snapshot-apply.ts:152-162` | `contentScope:'agent-session'`、`preserveLocalLayout:true` |

### A.3 v1 通道方案对比（历史）

| 维度 | A：流 + renderer 车道（v1） | B：新命令帧 | C：轮询 |
| --- | --- | --- | --- |
| wire | 新增可选 `layoutRevision` | 新 opcode + capability | 无 |
| 覆盖 headless | 是（需代际/基线） | 是 | 是，延迟 |
| v2/v3 裁定 | **废弃**（T1） | 不采用 | 单次 `list` 取代轮询 |

## 附录 B：v2 关键分析（保留）

### B.1 v2 的两条核心机制（v3 沿用/替换）

| 机制 | v2 写法 | v3 状态 |
| --- | --- | --- |
| 无 revision/base/digest，事件触发单次读 + 形状比较 + 幂等 | §2.2 | **沿用** |
| 「同 epoch/version 不前进 → skip」 | §3 C7 | **替换**为 lineage + authoritative 读（§3.1） |
| 「首帧只建基线」 | 已删 | 保持删除；U172 后由宿主保留布局 |
| 未知 id 跳过、不整帧拒绝 | §6 | **沿用并补映射保留语义**（§6.2-8） |
| 三窄选项（焦点/identity/layoutOnly） | §5.2 | **沿用** |

### B.2 v2 评审给出的修正方向（已落实）

- 首开竞态：U172 在宿主侧解决（v2 评审建议 (a)/(b)/(c) 中的宿主保留路线）。
- C7：改为 `admitRetiredValueUnderAuthority` + `sameSessionTabsPublicationLineage` + 版本严格前进。
- C5/E4：删除 C5。
- E1 ②：按 worktree 布局字段比较。
- 组 id：claimed 重指/排除，避免 1→3。
- 触发挂载：主 app-shell 无条件、纯终端降级、popout 不覆盖。
- V8：出站计数 + 宿主 list；拆 V8a/V8b。

## 附录 C：v3 评审关键定位（保留）

> 来源：`cloud-platform/test-reports/u163-design-review-v3.md`（只读评审，HEAD `aee83f6786`）。v4 只按此四项修订，其余 v3 结论原样保留。

| 编号 | 定位 | 证据 |
| --- | --- | --- |
| B1 | `buildMirroredTerminalTabs` 在 `:200` 无条件调用；`reconcilesNonAgentTabs=false` 时 `retainedTerminalTabs=currentTerminalTabs`，raw snapshot 会导致终端重复 | `apply-preparation-base.ts:151,187-196,200,223-227`；`terminal-build.ts:72-73` |
| B2 | `ui:moveSessionTab` 是 main→renderer 入站 IPC；headless 驱动需第二客户端，先例在 web journey | `ui-bridge-terminal-and-session-tabs.ts:215-220`；`session-tab-move-request-relay.ts:64`；`web-journey-13-gates.mjs:574-598` |
| B3 | 本地结构化表与 web 表是两套；authoritative admit 会 un-retire；`recordAppliedSessionPublication` 在 HEAD 不存在 | `inventory-generation-fence.ts:11-17`；`snapshot-apply.ts:121-137,190-198`；`publisher-identity-fences.ts:43-57,175-191` |
| B4 | claimed 依赖上一帧映射；纯终端投影不建映射；需 apply 前预 seed（1→3 仅作负控，不发布） | `layout-groups.ts:150-176`；`snapshot-projection.ts:12-20,32-35`；`tracking-mappings.ts:160-170` |

## 主会话审定（2026-11-17 10:2x）

| 项 | 结论 | 审定人 | 备注 |
| --- | --- | --- | --- |
| 范围（收窄：获焦/可见/重连单次 list 补齐，无新 wire 字段） | 通过 | main | 连续车道暂缓，重开条件见 §2.4 |
| B1 `layoutOnly` 抑制两处（`:151` + `:200`） | 通过 | main | 只抑制终端镜像，不抑制 browser/editor 身份复用 |
| B2 V8a 拆 a-1/a-2 + 入站/出站分别计数 | 通过 | main | `ui:moveSessionTab` 用 `onMoveSessionTab` 入站监听 |
| B3 C7 表名/un-retire 副作用/纯判定 | 通过 | main | 与已落地 V1 `catchupFreshnessVerdict(history 入参、克隆不写表)` 一致 |
| B4 产品路径必须 1→2（预 seed；1→3 仅负控） | 通过（收紧采纳） | main | 防重复组被写成宿主布局后不可收敛 |
| 拆分 V1→V2a→V2b→V3→V4→V5→V6→V7→V8 | 通过 | main | **V1 已落地**（`b4b34687de3`），实际路径 `src/renderer/src/runtime/local-structured-session-tabs-sync/host-layout-catchup-decision.ts`；后续令从该模块 import，不再新建 `local-host-layout-catchup/` 目录 |
| 残余 R9–R11 披露 | 接受 | main | R10（pending 长期保留走 headless 兜底）由 U172 审计确认 fail-safe |
| v5 状态（附录 D：真栈证伪 + 钩子默认关闭 + V8b/V8c 暂停） | 待用户裁定 | — | 三选一：彻底移除 / 仅非本地宿主启用 / 保留开关待需求 |

---

## 附录 D：真栈证伪与前提失效（v5，2026-11-17）

> 来源：`cloud-platform/evidence/u163-v8a1-1794887000/u163-v8a1.json`、`u163-v8a2-1780000500/u163-v8a2.json`、`u163-v8a2-1780000600/u163-v8a2.json`；台账 U176。§1–§12 的 v4 设计文本保留原样，本附录只记录前提失效与当前处置。

### D.1 两轮真栈方法与采样

**V8a-1（单窗口）**：`ORCA_BACKGROUND_LAUNCH=1` + CDP 隐藏渲染器；宿主状态在 renderer 内经 `session.tabs.list` 读取，split 由同一 renderer 发出，焦点边沿在渲染器内派发并包裹 `window.api.runtime.call` 计出站方法。RPC、结构化同步与 store 同进程。

**V8a-2（独立第二客户端）**：在同一桌面 renderer 之外启动独立 Chromium web client（`login`/`hostCall`，独立 store），由该客户端对同一本地 worktree 发起 split；桌面 renderer 的 host/store/DOM 分别采样。两次独立运行（stamp `1780000500`、`1780000600`）结果一致。

采样表（host = `session.tabs.list` 组数；store = `groupsByWorktree` 组数；DOM = 可见 tab strip 数）：

| 轮次 | 采样 | 相对动作 | host | store | DOM | 出站 `runtime.call` |
| --- | --- | --- | --- | --- | --- | --- |
| V8a-1 | `C.cold-baseline` | 冷启动静止 | 1 | 1 | 1 | — |
| V8a-1 | `C.host-split` | 本 renderer split 后 +1.2s | 2 | 2 | 2 | （move 由本 renderer 发出） |
| V8a-1 | `C.immediate` | focus 边沿后 | 2 | 2 | 2 | `[]` |
| V8a-1 | `C.plus3s` | +3s | 2 | 2 | 2 | — |
| V8a-2 | `B1.baseline` | 冷启动静止 | 1 | 1 | 1 | — |
| V8a-2 | `B2.web-split` | 第二客户端 split 后 +1.5s | 2 | 2 | 2 | — |
| V8a-2 | `B3.immediate` | 桌面 focus 边沿后 | 2 | 2 | 2 | `[]`（`wrapped.call=false`） |
| V8a-2 | `B3.plus3s` | +3s | 2 | 2 | 2 | — |

关键事实：

1. Split 之后、focus 之前，桌面 store 与 DOM 已等于宿主组数（约 1.5s 内），**不存在「宿主已变、桌面未变」的稳定分歧窗口**。
2. focus 边沿没有任何 `session.tabs.list` 出站（钩子默认关闭；即使打开也无可补的差异）。V8a-2 的 `focus-edge` 记录 `methods: []`。
3. 桌面自动采纳不止形状：`B2.web-split` 时本地 `activeGroupId` 已切到宿主新组 `995f6cb9-...`（V8a-1 为 `774e873f-...`）。这说明现有流通道**连 active 一起采纳**；§5.3「只应用形状」只约束新增补齐车道，不能反推现有通道行为。
4. 两轮 harness 均判 `INVALID`（V8a-2 的断言 0b「第二客户端与桌面分歧」不成立），是**前提不成立**，不是补齐实现产品红。

### D.2 证伪结论

在当前 HEAD（含 U164/U171 之后的同步语义）的**本地宿主**上：

- 桌面 renderer 经既有 `session.tabs.subscribeAll` / 广播路径自动采纳宿主布局（含 active），设计所假设的稳定分歧窗口无法复现。
- v1 §1.3/§2.4 的「桌面没有宿主→renderer 的布局 apply 通道」判断**已不成立**（至少对本地宿主）；§1.1 F2–F5 描述的是结构化订阅投影只保留 agent-session，但布局仍经其他同步路径到达 store。
- 若缺口仍存在，只可能在**非本地执行宿主**（SSH/远端/WSL 远端）或特殊时序，需要新的真实证据才能定位。

### D.3 C1 闸门矛盾（当前车道无收益）

- 补齐决策 C1：`executionHostIsLocal === false` → `skip`（`host-layout-catchup-decision.ts:79`；执行器经 `getExecutionHostIdForWorktree(...) === 'local'` 求值，`run-local-host-layout-catchup.ts:178-179`）。
- 本地宿主恰是「已自动采纳、无需补齐」的场景；非本地宿主（唯一可能残留缺口）被 C1 排他性跳过。
- 结论：现设计只覆盖「本地」子集，而该子集没有可补差异；每次 focus 的净成本是一次 `session.tabs.list`，净收益为零。要让车道重新有意义，必须先有「非本地宿主下桌面布局确实不跟随」的证据，并重新裁定 C1。

### D.4 状态更新

| 项 | 状态 | 证据/落点 |
| --- | --- | --- |
| V1–V7 | 已落地，代码与测试保留 | V1 `b4b34687de3`、V2a `00b7d7ae6de`、V2b `abf495b30a6`、V3 `1c6aca72e9a`、V4 `2a612cf147b`、V5 `9835364e469`、V6 `4a1a6808cb4`、V7 `d5429c64eb3` |
| V5 钩子 | **默认关闭**，显式 opt-in（开关） | `HOST_LAYOUT_CATCHUP_STORAGE_KEY = 'orca.debug.hostLayoutCatchup'`，`localStorage` 值为 `'1'` 才挂监听（`src/renderer/src/app-shell/use-local-host-layout-catchup.ts`）；关闭时无监听、无可见性/恢复订阅、无 store 订阅、无执行器调用 |
| V8a-1 / V8a-2 | INVALID（前提不成立） | D.1 |
| V8b | 暂停（不再做变异红） | 依赖一个可复现的分歧窗口 |
| V8c（后续真栈复验，未在 §7 定义） | 暂停 | 同上 |
| 重评估条件 | 出现**真实用户证据**：SSH/远端宿主下桌面布局不跟随（或 U164/U171 语义回退使本地重新出现稳定分歧） | 由主会话/用户裁定 |

### D.5 本轮不做的事

1. 不删除 V1–V7 已落地模块与测试；它们是未来「非本地宿主」车道的现成件，删除会丢失已验证的 C7 / 组去重 / 预 seed 语义。
2. 不扩展车道范围：不新增 wire 字段、不做连续帧车道、不覆盖 popout、不改焦点权威。
3. 在用户裁定前不做产品代码改动（本附录只改文档）；三选一（彻底移除 / 仅非本地启用 / 保留开关待需求）留给主会话裁定。
