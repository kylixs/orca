# U96 设计 · Orca Web 云票据标签组恢复（A 部分；B 暂缓，尾部留档）

- 日期：2026-11-16
- 性质：设计（只设计，未改产品代码）
- 唯一输入：`u96-tab-restore-diagnosis.md`（下称「诊断」）
- 必要处已复核代码；复核结论与诊断不一致处单独标注（见 Q2/Q3）
- **范围（2026-11-16 用户调整）**：先修 A（Orca Web 云票据：标签组恢复 + 终端内容回放）；B（简易工作区）暂缓，设计要点见文末附录，完整设计后续单派
- 用户最终语义：云工作区重开后必须 ①每个项目保持各自标签组；②能看到终端内容（滚动缓冲回放 / PTY 重连），不是空白终端

---

## 0. 目标与验收（A · Orca Web 云票据）

| 编号 | 验收标准                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | 新宿主 + 新客户端：云工作区开 2 组终端标签（≥3 个终端）→ 关闭页面 → 新 handoff 重开 → 同项目终端标签组、布局、活动标签恢复；宿主 PTY 仍活时终端滚动缓冲 marker 文本可见（U100/D11 收窄：文件/编辑器 tab 恢复移出一期，终端标签+分组+内容恢复保留）     |
| A2   | 宿主进程重启后重开：标签组从持久化恢复；终端显示显式「会话已结束」态（不是空白/静默假活），同标签内一键重开 PTY                                                                  |
| A3   | 新客户端 + 旧宿主（无新 capability）：不发起注定被拒的镜像订阅、不 warn-loop；退化为当前行为（bootstrap 补 1 个新终端），标签组不丢本地布局                                      |
| A4   | 新宿主 + 旧客户端：旧客户端行为不变；新增只读字段/方法不影响旧解析                                                                                                               |
| A5   | 安全：云票据只能读取/订阅/认领 `workspaceRoot` 内的 worktree、tab、terminal handle；越界请求在路径守卫层拒绝且带 reason；不得读取他人 checkout                                   |
| A6   | 同宿主多用户 / 同用户多设备：各自的标签互不可见；同用户另一设备的 inventory 一致（宿主是唯一真源）                                                                               |
| A7   | 回放边界：单终端回放 ≤ `MOBILE_SUBSCRIBE_SCROLLBACK_ROWS`（1000 行）且 ≤ `MOBILE_SNAPSHOT_BYTE_BUDGET`（512 KiB），超限带 `truncated`；`localOnlyScrollbackByTabId` 永不离开宿主 |
| A8   | 关闭语义：云客户端关闭终端标签后宿主 PTY 关闭、inventory 行退役；再次重开不复活已关闭标签                                                                                        |
| A9   | 每个项目独立：项目 A / B 的标签组按 worktree 隔离，打开 B 不覆盖 A                                                                                                               |
| A10  | 订阅生命周期：socket 关闭 / unsubscribe / 连接换代能清理订阅，不泄漏、不互相驱逐（shared-control 多订阅者共存）                                                                  |
| A11  | 旧宿主降级零噪声：capability 缺失时不产生任何 `session.tabs.*` / `terminal.list` / `terminal.adoptOrphans` 拒绝调用（以 RPC 计数断言）                                           |

---

## 第一部分 · A：云安全标签恢复通道（Orca Web）

### A.1 复用面（结论先行：这是「把已有链路对云开放」，不是造轮子）

| 能力                               | 既有实现                                                                                                                                                                                           | 云链路现状                                                         | U96 处理                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| 宿主标签清单（tabs/groups/layout） | `session.tabs.list/listAll/subscribe/subscribeAll`（`src/main/runtime/rpc/methods/session-tabs.ts`、`session-tabs-inventory.ts`）                                                                  | 客户端主动跳过 + 宿主方法表拒绝                                    | 打开只读子集 + 客户端按 capability 取消跳过 |
| 应用宿主快照                       | `applyWebSessionTabsSnapshot` / `web-session-tabs-sync/**`                                                                                                                                         | 云不执行                                                           | 原样复用                                    |
| 孤儿 PTY 认领                      | `recoverWebSessionTerminalOrphansBeforeApply` → `terminal.list` + `terminal.adoptOrphans`                                                                                                          | 两个方法都在 `CLOUD_TERMINAL_DENIED_METHODS`                       | 放行并按 worktree/handle 做 scope           |
| 终端内容回放                       | 订阅建立时初始快照：`publishMultiplexInitialSnapshot` / `serializeBudgetedMobileSnapshot`（`terminal-multiplex-initial-snapshot.ts`、`terminal-snapshot-publication.ts`）                          | 通道本身允许（`terminal.subscribe`/`terminal.multiplex` 在云表内） | 不需要新机制；恢复清单后自然接上            |
| 云客户端创建 PTY                   | 客户端 `terminal.create` 已带 `tabId/leafId`（`remote-runtime-pty-transport.ts:2660+`），宿主 `createTerminal` 在 `orca-runtime-create-terminal.ts:238` 调 `publishPtyBackedMobileSessionTerminal` | 内存 inventory 可能已含该 tab；持久化未闭环                        | 复核 + 只补持久化缺口（A.4）                |
| 宿主持久化                         | `setWorkspaceSessionForWorktree`（`orca-runtime-get-runtime-id.ts:199`）、`adoptRuntimeTerminalOrphansFromInventory` 会写回 session 并 flush                                                       | 云客户端 tab 无 workspaceSession 记录                              | 复用 adopt 写回 + 在首次发布时补 tab 记录   |
| headless 重建                      | `hydrateHeadlessMobileSessionTabsFromWorkspaceSession`                                                                                                                                             | 依赖 tabsByWorktree 持久化                                         | 作为宿主重启恢复入口                        |

**设计原则**：A 的每一步都落在既有实现上；新增代码只做三件事——云方法表放行/scope、宿主持久化补洞、客户端 capability 门控。

### A.2 宿主方法表：放行面与权限归属

`cloudMethodAccess()`（`cloud-rpc-permission.ts`）改为新增一个云只读/恢复显式集合，**不**用 `session.tabs.` 前缀统一放行：

| 方法                                       | 权限归属     | 说明                                                                                 |
| ------------------------------------------ | ------------ | ------------------------------------------------------------------------------------ |
| `session.tabs.list`                        | `terminal`   | 单 worktree 清单；selector 必须过 workspace 边界                                     |
| `session.tabs.listAll`                     | `terminal`   | 宿主全域清单，**必须**在 handler 内按 `context.cloud.workspaceRoot` 过滤（A.3）      |
| `session.tabs.subscribe`                   | `terminal`   | 单 worktree 流；同样要求 selector 在边界内                                           |
| `session.tabs.subscribeAll`                | `terminal`   | 全域流，快照逐条过滤                                                                 |
| `session.tabs.activate`                    | `terminal`   | 恢复活动标签需要；只允许投影后可见的 tabId                                           |
| `session.tabs.close`                       | `terminal`   | 关闭标签需要；scope 同 activate                                                      |
| `session.tabs.move`                        | `terminal`   | 分组/顺序恢复需要；限定同一 worktree 内                                              |
| `session.tabs.createTerminal`              | **继续拒绝** | 云客户端保持 client-owned；由 `terminal.create(tabId,leafId)` + 持久化实现恢复（T3） |
| `session.tabs.setTabProps` / markdown 家族 | **继续拒绝** | 恢复不依赖；保持最小面                                                               |

权限归属说明：会话标签属于工作区/终端操作面，归 `terminal` 权限（与 `terminal.create` 一致）。ticket 未授予 `terminal` 时只允许 `open` 流程，标签恢复自然不可用，符合 W13 §4.3。

**新增 capability（wire 兼容核心）**：

- 宿主在 `workspace.info` 响应中增加**可选**字段 `capabilities: string[]`（`src/shared/cloud-workspace-info.ts` 的 `CloudWorkspaceInfo` 增加 `capabilities?: readonly string[]`；读取函数 unknown 容忍缺失/非法项）。
- 取值 `'cloud.session-tabs-restore.v1'`。
- 理由：`workspace.info` 是每个已准入云会话必调的自省方法，旧客户端按字段名读取、忽略未知键（additive 安全）；旧宿主无该字段 → 新客户端判定「不支持」，保持当前跳过行为，**零拒绝探测、零 warn-loop**。
- 新 opcode：无。全部复用既有方法名与既有流帧；因此不需要 opcode 协商。
- 备选（T1）：新增 `session.tabs.listOwn` 窄方法。若主会话认为「扩大 listAll 面」不可接受，则改为 listOwn，capability 名不变；两者都不引入新 opcode。

**旧宿主行为**：新客户端读不到 capability → 不订阅（当前逻辑），bootstrap 仍补 1 个本地新终端。满足 A3。

### A.3 云作用域 inventory（安全 scope 是设计重点）

现状：`listSessionTabsInventory()` 返回宿主**全部** worktree 快照。云票据直接放行会把他人的 tab 标题、文件路径、agent 状态泄漏给一个项目票。

设计：

1. 在 `session-tabs-inventory.ts` 增加云投影包装 `projectCloudSessionTabsInventory(inventory, context)`：
   - `context.cloud` 缺失 → 原样返回（owner / paired 不受影响）；
   - 存在 → 对每个 snapshot 解析 `snapshot.worktree` 的根路径，保留落在 `context.cloud.workspaceRoot` 内的项；解析失败一律丢弃（fail-closed）。
   - 复用 `checkCloudTargetScope` / `resolveWorktreeRootPath`（`cloud-path-boundary.ts`、`cloud-worktree-scope.ts` 已提供同类解析；新增一个批量版本，避免 N 次 RPC 级解析）。
2. `session.tabs.list` / `subscribe` 的 `worktree` selector 走现有 `checkCloudWorktreeScope`（路径守卫已覆盖 `session.tabs.*` 需要登记 `isCloudPathGuardedMethod`，见 A.6）。
3. `subscribeAll` 的增量帧同样过滤：按 worktree 白名单缓存（进入会话时构建一次，worktree 增删时更新）；缓存未命中的 worktree 帧丢弃。
4. `listAll` 的 `authoritative` 标记与 changeSequence 对云保留语义不变（过滤只改变集合，不改变版本单调性）；若过滤后集合为空，返回空 inventory 而不是报错，让客户端走 bootstrap 兜底。
5. 字段裁剪：云投影同时裁剪宿主独有字段（agent 私有状态、非本项目路径）。建议先复用 `projectSessionTabsForClient` 的现有投影，再叠加路径白名单（T1）。

### A.4 宿主真正记录云客户端 tab 的写入点

复核结论（重要，与诊断 1.2 第 6 点的表述有差异，详见 Q2）：

- 云 Web 客户端走 `remote-runtime-pty-transport.ts` 的 `terminal.create`，**已经**传 `tabId`/`leafId`；
- `terminal.create` handler 把两者传入 `runtime.createTerminal`（`terminal-lifecycle-methods.ts:36-89`）；
- `runtime.createTerminal` 在 PTY 注册成功后调用 `publishPtyBackedMobileSessionTerminal`（`orca-runtime-create-terminal.ts:238-248`），后者 `storeMobileSessionSnapshot` 写入**内存** `mobileSessionTabsByWorktree`。

因此同进程内，宿主 inventory 很可能已含云客户端创建/拆分后的标签；缺口在**持久化**：`storeMobileSessionSnapshot`（`orca-runtime-runtime-id.ts:104`）只更新内存，不写 `workspaceSession`。宿主重启后 `hydrateHeadlessMobileSessionTabsFromWorkspaceSession` 只从 `tabsByWorktree` 重建 → 云客户端标签丢失。

设计写入点（最小改动、幂等）：

1. 新增 `persistPublishedMobileSessionTerminalTab(worktreeId, tabId, leafId, pty)`（放在 `mobile-session-terminal-persistence-retirement.ts` 同域或新文件 `orca-runtime-persist-published-client-tab.ts`）：
   - 若 `session.tabsByWorktree[worktreeId]` 已有该 `tabId` → 只更新必要字段（title/leaf/pty incarnation），不重排；
   - 否则追加一条最小 `TerminalTab`（`id=tabId`、`title`、`ptyId`/`activeLeafId`、`leafId`），并确保 `tabGroups[worktreeId]` 至少有一个组包含它；
   - 调 `setWorkspaceSessionForWorktree`，依赖既有 store 持久化路径。
2. 调用点：`publishPtyBackedMobileSessionTerminal` 成功 `storeMobileSessionSnapshot` 后，若 `!hasHostAuthoritativeTerminalMembership(session, worktree)` 或无持久化记录，则调用 1（幂等）。这样 desktop paired 路径不受影响（它们由 renderer graph 发布持久化）。
3. 关闭侧：`terminal.close` 走既有 surface retirement（`retireTerminalSurfacesFromSnapshot` / `mobile-session-terminal-persistence-retirement.ts`）→ 删除 `tabsByWorktree` 中的对应 tab；补一条测试确认云客户端关闭后宿主重启不复活（A8）。
4. 孤儿认领：`terminal.adoptOrphans` 既有实现已 `setSession` + `flushSession`（`orca-runtime-adopt-terminal-orphans-from-inventory.ts:52-83`），客户端恢复流程复用 `recoverWebSessionTerminalOrphansBeforeApply` 即可。
5. 宿主没有 workspaceSession 的空项目（Q3）：`project.provision` / 首开时确保创建空 session（`tabsByWorktree[worktreeId]=[]`、`tabGroups` 默认组），否则 `adoptOrphans` 直接 `workspace_session_unavailable`。

### A.5 客户端改动（按 capability 恢复，不恢复 warn-loop）

1. **能力探测**：`web-cloud-workspace-bootstrap.ts` 在 `workspace.info` 后读取 `capabilities`；结果写入 runtime environment 的会话内推导状态（新增 `web-cloud-session-capabilities.ts`，内存缓存，键=`environmentId + pairingRevision`）。
2. **取消云跳过（有条件）**：
   - `global-session-subscription.ts:71-79`：云环境只在 capability 缺失时排除；有 capability 时进入 `session.tabs.subscribeAll`。
   - `active-session-subscription.ts:87-92`：同上，进入 `session.tabs.subscribe`。
   - `web-runtime-session-snapshot.ts:44-50`：同上，允许 `session.tabs.list` 的 eager refresh。
   - 三处共用谓词 `shouldMirrorCloudSessionTabs(environmentId)`，避免三份判断漂移。
3. **bootstrap 顺序**（`web-cloud-workspace-store-ports.ts`）：
   - 先等 `hydrationSettled`（已有）；
   - 应用 inventory 后，仅当 `tabsByWorktree[worktreeId]` 仍为空才 `createTab`（当前逻辑保留为兜底）；
   - `mountExplorer` 逻辑不变。
4. **终端回放**：不新增机制。订阅建立/重连时宿主发初始快照（`serializeBudgetedMobileSnapshot`），xterm 保留实例重绘；PTY 已死时客户端按 `terminalLayoutsByTabId.buffersByLeafId` 回放（宿主侧持久化由 A.4 保证）。
5. **孤儿认领**：`applyActiveSnapshot` 内已有 `recoverWebSessionTerminalOrphansBeforeApply`；云方法放行后原样生效，不需要改调用点。
6. **失败降级**：任何 `forbidden`/`method_not_found` 都按「该环境不支持恢复」一次性降级（写入 capability 缓存的 negative），不重试、不 warn-loop；`changed` 环境（换宿主/换代）重新探测。

### A.6 安全 scope 与拒绝面

**保持拒绝（不变）**：`terminal.split`、`terminal.closeAll`、`terminal.closeTab`、`terminal.sleep`、`terminal.focus`、`terminal.show`、`terminal.resolveActive`、`terminal.resolvePane`、`terminal.recoverPane`、`terminal.resolveIdentity`、`terminal.getAutoRestoreFit`、`terminal.setAutoRestoreFit`。

**本次放行（带 scope）**：

| 方法                                | scope 校验                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal.list`                     | 必须带 `worktree` selector 且落在 `workspaceRoot`；无 selector 或越界 → `workspace_scope`                                                                                                                   |
| `terminal.adoptOrphans`             | ①`worktree` 在边界内；②每个 `claims[].terminal` 经 `checkCloudTerminalHandleScope` 解析到同一 worktree；③`topology` 的 tabId/leafId 必须与 claims 一致；任一不满足 → `terminal_unknown` / `workspace_scope` |
| `session.tabs.list/subscribe`       | worktree selector 在边界内                                                                                                                                                                                  |
| `session.tabs.listAll/subscribeAll` | 快照逐 worktree 过滤（A.3）                                                                                                                                                                                 |
| `session.tabs.activate/close/move`  | 目标 worktree 在边界内；tabId 必须出现在该 worktree 的投影清单里（云无 clientKind，新增 `assertCloudSessionTabVisible`）                                                                                    |
| `workspace.info`                    | 新增 `capabilities` 只列能力名，不带主机事实                                                                                                                                                                |

**接入点**：`isCloudPathGuardedMethod()` 已覆盖 `cloudTerminalScopeOf`；新增 `session.tabs.*` 的 scope 判断（新模块 `cloud-session-tabs-scope.ts`，或扩展 `cloud-path-guard.ts` 的 dispatch）。`cloud-path-guard.ts` 对 `terminal.list` 仍走 `cloudTerminalScopeOf`，需把 DENIED 改为新的 `{kind:'list'}` 并调用 worktree scope。

**测试对齐**：`cloud-terminal-scope.test.ts` 里「`terminal.list` 整体拒绝」的用例需改为「无 selector 拒绝、越界拒绝、正常放行」；`cloud-rpc-permission.test.ts` 已断言 `cloudMethodAccess('terminal.list') === 'terminal'`（保持）；新增 `session.tabs.*` 映射断言。

### A.7 隐私 / 体积边界（回放）

- 传输沿用现状：`MOBILE_SNAPSHOT_BYTE_BUDGET = 512 KiB`、`MOBILE_SUBSCRIBE_SCROLLBACK_ROWS = 1000`；客户端可请求更大行数时仍走 `REQUESTED_SNAPSHOT_BYTE_BUDGET = 2 MiB` 上限（`terminal-snapshot-publication.ts`）。**U96 不提高任何上限**。
- `localOnlyScrollbackByTabId` 按注释契约「never leaves this client」，云链路不读取、不上传。
- 云宿主持久化只存标签结构 + PTY 句柄；不主动把滚动缓冲写入共享 `workspaceSession.buffersByLeafId`（跨用户泄漏风险，T4）。冷恢复内容回放仅限既有、按用户隔离的持久化路径；否则明确降级为 ended 态。
- 日志/审计：`workspace.info` 新字段、`session.tabs.*` 云拒绝沿用 `methodDenialDetails` 审计；不放宽 `cloud-host-audit`。

---

## 第二部分 · B 部分留档（暂缓，完整设计后续单派）

- 存储建议：宿主侧按 `sub + project` 持久化（跨设备一致、与 A 语义统一；浏览器本地仅作 UI 态缓存）。
- schema 要点：tabs（含 terminal handle/ptyId）、activeId、groups/layout；未保存缓冲不入库。
- 写入时机：open/close/activate/move debounce；终端拿到/关闭 handle 立即写；pagehide flush。
- 生命周期解耦：收起 overlay ≠ closeProject；suspend 释放流/连接但保留 PTY，end 才关 PTY 并保留 ended 标签；logout 清记录。
- 重挂：live handle 用 `terminal.subscribe` 回放；ended 显示「会话已结束，重开」，同 tabId 重建 PTY。
- embed 协议：additive `features` / `suspend` / `end`；旧 `close` 解释为 suspend 并仍回 `closed`；项目切换先 suspend。
- 宿主侧需新增窄 RPC（get/put/clear，session 权限，键由票据推导）与空闲 TTL/体积上限；AC 与测试待 B 设计展开。

## 第三部分 · AC → 测试用例映射表（协议 §2-5 必备）

| AC  | 测试文件（新增标 *）                                                                                                                                      | 用例要点                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A1  | `src/renderer/src/runtime/web-session-tabs-sync/apply-snapshot.test.ts`（扩）、`src/renderer/src/web/web-cloud-workspace-bootstrap.test.ts`*              | 应用 2 组/3 标签快照后本地 store 的 tabs/groups/active 一致；终端 marker 出现在回放 payload          |
| A2  | `src/main/runtime/orca-runtime-hydrate-headless-mobile-session-tabs-from-workspace-session.test.ts`（扩）、`cloud-workspace-session-restore.e2e.test.ts`* | 宿主重启后 tabs 重建；dead handle → ended 判定；重开 PTY 使用同 tabId                                |
| A3  | `src/renderer/src/runtime/web-session-tabs-sync/cloud-capability-gate.test.ts`*                                                                           | 无 capability 时不调用 subscribeAll/subscribe；warn 计数 = 0；bootstrap 兜底 1 tab                   |
| A4  | `src/shared/cloud-workspace-info.test.ts`（扩）、`src/main/runtime/rpc/methods/workspace-info.test.ts`（扩）                                              | 旧客户端忽略 `capabilities`；响应形状校验不误判                                                      |
| A5  | `src/main/cloud-platform/cloud-terminal-scope.test.ts`（改）、`cloud-session-tabs-scope.test.ts`*、`cloud-rpc-scope.test.ts`（扩）                        | list 无 selector/越界拒绝；adoptOrphans 跨 worktree handle 拒绝；session.tabs 越界拒绝；正常项目放行 |
| A6  | `cloud-multi-project.test.ts`（扩）、`cloud-session-user-isolation.test.ts`（扩）                                                                         | 两 user 不同 workspaceRoot 的 listAll 过滤；同 user 两设备快照一致                                   |
| A7  | `terminal-snapshot-publication.test.ts`（扩）                                                                                                             | 1000 行 / 512 KiB 截断；`truncated` 标记；localOnly 不回放                                           |
| A8  | `session-tabs-close.test.ts`*、`mobile-session-terminal-persistence-retirement.test.ts`（扩）                                                             | 关闭后 inventory 行退役 + workspaceSession 删除；重开不复活                                          |
| A9  | `cloud-multi-project.test.ts`（扩）                                                                                                                       | A/B worktree 标签互不覆盖                                                                            |
| A10 | `session-tabs-inventory.test.ts`（扩，若存在）、`session-tabs.test.ts`（扩）                                                                              | unsubscribe/socket close 清理；多订阅者不互相驱逐                                                    |
| A11 | `cloud-capability-gate.test.ts`*                                                                                                                          | 无 capability 时 `session.tabs.*` / `terminal.list` / `terminal.adoptOrphans` 的调用计数为 0         |

B 部分的 AC 与测试映射随 B 设计单独展开（见文末附录）。

E2E 回归（追加到 U91 A-RESTART 断言）：云 Orca Web 一组「开 3 个终端 tab → 重开 → 断言 tab 数/分组/活动 tab + marker 文本」；区分「仅页面重载」与「宿主重启」两档。

---

## 第四部分 · 终审项（T）

| 编号 | 事项                                                                         | 建议                                                                                             |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| T1   | 复用 `session.tabs.listAll` + 云过滤，还是新增 `session.tabs.listOwn` 窄方法 | 推荐先复用并过滤（少一套 wire 面）；若审计认为 listAll 暴露面过大，再改窄方法，capability 名不变 |
| T2   | A 的持久化位置                                                               | 复用 `workspaceSession.tabsByWorktree`（单一真源，adopt/close 已有写回路径），不另建 store       |
| T3   | `session.tabs.createTerminal/setTabProps/markdown` 是否对云开放              | 暂不开放；保持 client-owned + `terminal.create(tabId,leafId)`                                    |
| T4   | 云滚动缓冲是否入宿主持久化                                                   | 不入共享 `buffersByLeafId`；仅 live 回放 + 按用户隔离的既有可能路径，否则 ended 态               |
| T8   | `workspace.info.capabilities` 字段是否违反「information boundary」           | 仅列能力名、无主机事实；建议放行并在文档注明为显式扩展                                           |
| T9   | 多用户共享同一 workspaceRoot 的平台假设                                      | 需平台确认 workspaceRoot 按用户隔离；否则 A6 必须再加路径级会话隔离                              |
| T10  | 云客户端断开后 PTY 保活策略（A2/A8 边界）                                    | 建议：页面断开不主动杀 PTY（宿主只有显式 close/重启才回收）；需运行时探针确认现状                |

> T5-T7 属 B 部分（存储位置 / 挂起 TTL / 结束语义），随 B 设计单派。

## 第五部分 · 开放问题（Q）

| 编号 | 问题                                                                                                 | 影响 / 处理                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Q2   | `publishPtyBackedMobileSessionTerminal` 在 cloud terminal.create 上是否真的触发（membership 条件）？ | 诊断称「不写」，代码显示会写内存；需一条 characterization 测试确认，再决定 A.4 只补持久化还是补发布 |
| Q3   | 云项目当前是否已有 workspaceSession 条目？                                                           | adoptOrphans 与 hydrate 的前置；无则在 project.provision 首开时创建空 session                       |
| Q4   | `listAll` 投影里哪些 tab 类型/字段可给云                                                             | 建议只给 terminal/editor/browser 的展示字段，裁剪 agent 私有状态；需产品确认                        |
| Q6   | 页面重载后 PTY 已死但宿主有 scrollback 缓存时能否回放？                                              | 取决于 T4；不能则 UI 必须显式 ended，不允许静默空白                                                 |
| Q10  | 宿主对「云客户端断开」是否已有回收定时器                                                             | 决定 A2 的 ended 判定与 A8 的退役时点；与 T10 同一探针                                              |
| Q11  | 旧宿主对 `workspace.info` 额外字段的兼容是否有历史反例                                               | 已按「读取函数忽略未知键」设计，但仍需一条旧宿主 fixture 回归                                       |

> Q1/Q5/Q7/Q8/Q9 属 B 部分或已随范围收窄移出，保留在 B 设计草案。

## 第六部分 · 实现令切分建议（A-only，每令 ≤20 分钟）

**优先级**：令 1-5 = 最小可用的「标签组恢复」（页面重载 + 活 PTY 内容）；令 6 = 宿主重启持久化；令 7 = scrollback 回放边界（第二优先）；令 8 = 回归收口。

| 令    | 内容                                                                                                                                                                                                            | 依赖      | 文件域                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-令1 | 宿主策略表 + capability：`cloudMethodAccess` 加 `session.tabs` 只读/恢复子集（归 `terminal`）；`workspace.info` 增加可选 `capabilities`；`cloud-terminal-scope` 增加 `list` 受控 kind（不直接放行）；表驱动测试 | 无        | `cloud-rpc-permission.ts`、`cloud-terminal-scope.ts`、`workspace-info.ts`、`shared/cloud-workspace-info.ts`、两测试                                                               |
| A-令2 | 云 inventory 过滤 + `session.tabs` scope：新增 `projectCloudSessionTabsInventory`（按 `context.cloud.workspaceRoot` 过滤，fail-closed）、`assertCloudSessionTabVisible`、path guard 登记                        | A-令1     | `session-tabs-inventory.ts`、`session-tabs.ts`、`cloud-path-guard.ts`、新 `cloud-session-tabs-scope.ts`、测试                                                                     |
| A-令3 | `terminal.list` / `terminal.adoptOrphans` 放行与 scope：worktree selector 边界 + claims handle 归属校验；改旧「整体拒绝」断言                                                                                   | A-令1     | `cloud-terminal-scope.ts`、`cloud-path-guard.ts`、新 `cloud-terminal-list-scope.ts`、`cloud-terminal-scope.test.ts`、`cloud-rpc-scope.test.ts`（与令2 共享 path guard，必须串行） |
| A-令4 | 客户端 capability 探测 + 条件取消云跳过：`shouldMirrorCloudSessionTabs` 一处谓词，接入 global/active 订阅与 eager refresh；无 capability 零调用                                                                 | A-令1     | 新 `web-cloud-session-capabilities.ts`、`global-session-subscription.ts`、`active-session-subscription.ts`、`web-runtime-session-snapshot.ts`、新测试                             |
| A-令5 | bootstrap/孤儿认领接通：先应用 inventory 再兜底建 tab；确认 `recoverWebSessionTerminalOrphansBeforeApply` 云路径与孤儿认领顺序                                                                                  | A-令2/3/4 | `web-cloud-workspace-store-ports.ts`、`web-cloud-workspace-bootstrap.ts`、orphan recovery 测试                                                                                    |
| A-令6 | 宿主持久化云客户端 tab：`persistPublishedMobileSessionTerminalTab`（幂等追加/更新 tabsByWorktree + 默认组）、close 退役；解决 Q2/Q3 的前置探针                                                                  | A-令3     | `orca-runtime-publish-pty-backed-mobile-session-terminal.ts`、新 persist 模块、`orca-runtime-create-terminal.ts`、retirement 测试                                                 |
| A-令7 | scrollback 回放接入与边界（第二优先）：验证订阅初始快照在云链路生效；1000 行/512 KiB/truncated 断言；确保 `localOnlyScrollback` 不外发；PTY 已死 → ended UI                                                     | A-令5     | `terminal-multiplex-initial-snapshot.ts`（读取/测试为主）、`terminal-snapshot-publication.test.ts`、客户端回放测试                                                                |
| A-令8 | A 端到端回归：页面重载 / 宿主重启两档；旧宿主（无 capability）零拒绝噪声；多项目隔离                                                                                                                            | A-令5/6/7 | e2e/characterization 测试、`evidence/u96-fix/`                                                                                                                                    |

**并行约束**：令1 是前置；令2/令3 都改 `cloud-path-guard.ts`，必须串行；令4 只依赖令1，可与令2/3 并行；令6 与令2/3/4 文件域不相交，可并行；令7/8 最后跑。

## 主会话审定节

> 待主会话填写：A 的 T1-T4 / T8-T10 决策、Q2/Q3/Q4/Q6/Q10/Q11 结论、A-令1..8 放行顺序；T5-T7 与 B 的 Q 项随 B 设计另审。

## 主会话审定（2026-11-16，A 部分）

- **T1**：先复用 `listAll`+handler 内 `workspaceRoot` 过滤（fail-closed），**不新增 listOwn**。
- **T2**：持久化复用宿主 `workspaceSession.tabsByWorktree`（不造新存储）。
- **T3**：`terminal.create` 不从云方法表新开放（现有用户在建终端走既有面）。
- **T4**：云滚动缓冲不入共享持久化（`localOnlyScrollback` 边界保持）。
- **T8**：`capabilities: ['cloud.session-tabs-restore.v1']` 放行（wire-additive，旧宿主无字段→客户端保持跳过，零新 opcode）。
- **T9**：默认成立（云票据 workspaceRoot 按用户隔离由既有票据语义保证）；A-2 实现时以既有 scope 测试为证。
- **T10**：PTY 保活/死后回放边界在 A-1/A-2 实测取证后再定，不预先实现。
- **流程**：A-1（宿主策略表+capability）与 A-4（客户端谓词）并行开；A-2→A-3 串行（同文件 path guard）；A-5 最小可用；A-6 持久化缺口；A-7 scrollback；A-8 端到端回归（真机：开标签组→关页→重开→恢复）。
