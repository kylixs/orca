# U96 诊断 · 重开工作区后标签组丢失、终端空白

- 日期：2026-11-16
- 性质：只读诊断（未改任何产品代码、未提交）
- 输入：用户现象（两种工作区形态，重开后标签组丢失 + 终端空白）+ 用户补充「项目原来可以恢复标签，改成云端开发+中继后不能恢复」
- 证据：`evidence/u96-diagnosis/`（不入 git）

---

## 0. 结论摘要

| 形态                                     | 现象定性                                                                                   | 机理                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orca Web 工作区（云端票据）**          | **回归**：原有「宿主会话标签镜像」恢复链在云会话被整体摘除，且未补替代通道                 | ①客户端按云环境谓词跳过 `session.tabs.*` 镜像（O1-a）；②宿主云方法表本就拒绝 `session.tabs.*`；③浏览器本地会话持久化刻意剔除 tabs/handles；④每次进入工作区 bootstrap 只补建 1 个新 tab，落到 `terminal.create` 新 PTY → 空白 |
| **简易工作区（管理台内嵌 cloud-admin）** | **从未实现**：独立 React 应用，标签只在内存 reducer；关闭 overlay 即销毁 iframe 并关闭连接 | 无任何 tabs/终端句柄持久化；`initialTabs` 永远是空；每个终端 tab 挂载即新建 PTY、卸载即关闭句柄                                                                                                                              |

用户口径「原来可以恢复」成立：**非云（配对/中继）Orca Web 一直靠宿主标签清单恢复**，不是浏览器本地恢复。改成云端开发（cloud ticket）后，这条链在客户端与宿主两端同时被关闭。

---

## 1. 功能地图：数据存哪 / 何时写 / 何时读 / 何时恢复

### 1.1 原生 / 配对形态的标签与终端持久化（恢复机制的本体）

**唯一权威模型：`WorkspaceSessionState`**（`src/shared/workspace-session-state-types.ts`）

- 标签与分组：
  - `tabsByWorktree`（终端 tab：id/title/ptyId…）
  - `unifiedTabs`（统一 tab 模型：终端/编辑器/浏览器/markdown/file）
  - `tabGroups` + `tabGroupLayouts` + `activeGroupIdByWorktree`（标签组与分屏布局）
  - `openFilesByWorktree` / `browserTabsByWorktree` / `activeTabIdByWorktree` / `activeTabTypeByWorktree`
- 终端重连与回放：
  - `terminalLayoutsByTabId`：`ptyIdsByLeafId`、`buffersByLeafId`（可随远端投影共享，冷恢复）
  - `localOnlyScrollbackByTabId`：仅本机，普通冷 park 抓取
  - `ptyIdsByTabId`、`remoteSessionIdsByTabId`、`activeWorktreeIdsOnShutdown`
- 落盘：宿主 profile 的 `orca-data.json`（`workspaceSession` / `workspaceSessionsByHostId`），读取时做 schema 校验与 scrollback 裁剪（`src/main/persistence/loading-store/*`）。

**写入路径（两条）**

1. **有窗口宿主**：渲染层 `syncRuntimeGraph()` 构建 `RuntimeRendererSyncWindowGraph`（tabs/leaves/mobileSessionTabs，含 groups 与顺序），经 IPC `runtime:syncWindowGraph` 送宿主：
   - `src/renderer/src/runtime/sync-runtime-graph/graph-publication.ts`
   - `src/main/ipc/runtime.ts:38-52` → `runtime.syncWindowGraph(window.id, graph)`
2. **无窗口/headless 宿主**：`hydrateHeadlessMobileSessionTabsFromWorkspaceSession()` 从已持久化的 `workspaceSession` 重建宿主侧 `mobileSessionTabsByWorktree` 快照（标签 + 分组 + 布局）：
   - `src/main/runtime/orca-runtime-hydrate-headless-mobile-session-tabs-from-workspace-session.ts`
   - 运行时 tab 操作（create/move/close/rename）通过 `setWorkspaceSessionForWorktree` 回写并持久化。

**读取路径（Orca Web / 手机）**

- 渲染层挂载 `useWebSessionTabsSync()`（`src/renderer/src/runtime/web-session-tabs-sync/`）：
  - `session.tabs.listAll` → 全量 inventory
  - `session.tabs.subscribeAll` → 全量变更流
  - `session.tabs.subscribe` → 当前工作区流
  - `applyWebSessionTabsSnapshot` 把宿主快照应用成本地 store 的 tabs/groups/layout
- 孤儿 PTY 重挂：`recoverWebSessionTerminalOrphansBeforeApply`（`src/renderer/src/runtime/web-session-terminal-orphan-recovery.ts`）用 `terminal.list` + `terminal.adoptOrphans` 把宿主上仍活着的 PTY 认领回标签。
- 终端内容回放：订阅建立时宿主发初始快照（`src/main/runtime/rpc/methods/terminal/terminal-multiplex-initial-snapshot.ts`，`serialized` 滚动缓冲 + `lines` 兜底），xterm 保留实例即重绘；PTY 已死时走 `terminalLayoutsByTabId.buffersByLeafId` / `localOnlyScrollbackByTabId` 回放。
- **浏览器本地从不存 tabs**：`sanitizeWebRuntimeWorkspaceSession`（`src/renderer/src/web/web-workspace-session.ts`）只保留 `activeRepoId`/`activeWorktreeId`/`browserUrlHistory`/`lastVisitedAtByWorktreeId`；`web-workspace-session-api.ts` 全部读写都过这个 sanitizer。注释明确：配对 web 的标签来自宿主运行时，本地存远端句柄会重放过期 selector。

### 1.2 云端（cloud ticket）链路上的断点

这是「原来能恢复、改云后不能」的根因层。

1. **客户端主动摘除镜像**（O1-a `b08c5ec3ad3`，2026-11-14，紧随 W13b `7df1f6738ea`）：
   - `global-session-subscription.ts`：云环境直接 return，零 `subscribeAll`
   - `active-session-subscription.ts`：云环境直接 return，零 `subscribe`
   - `web-runtime-session-snapshot.ts:44-50`：`refreshWebRuntimeSessionTabsSnapshot` 对云会话早退
   - 判定谓词：`isCloudSessionRuntimeEnvironment` = `cloudProject !== undefined || cloudLoginRequired === true`（`src/shared/runtime-environments.ts:266`）
2. **宿主云方法表拒绝**：`cloudMethodAccess()` 未登记 `session.tabs.*`（`src/main/cloud-platform/cloud-rpc-permission.ts`），`cloudMethodDenial` 返回 `Method 'session.tabs.list' is not available to cloud sessions`（`src/main/runtime/rpc/rpc-caller-scope.ts`）。注意：`session.tabs.*` 方法本体权限是 `workspace`（`src/main/runtime/rpc/methods/session-tabs.ts`），配对/中继下放行，云票据下被方法表挡掉。
3. **终端清单/孤儿认领也被挡**：`cloud-terminal-scope.ts` 把 `terminal.list`、`terminal.resolveActive`、`terminal.resolvePane`、`terminal.recoverPane`、`terminal.resolveIdentity` 等列入 DENIED；未分类的 `terminal.*` 一律 fail-closed。`terminal.adoptOrphans` 也落到 deny。云会话只允许 `terminal.create` + 句柄类方法 + `terminal.multiplex`。→ 即使想「列出现有 PTY 再挂回去」也没有入口。
4. **云 Web 客户端不回传图**：`src/renderer/src/web/preload-api/web-runtime-api.ts` 的 `syncWindowGraph` 是 no-op（返回远端状态），所以宿主也不会通过「渲染层发布」获得云客户端的本地 tab 图。
5. **bootstrap 每次只补一个新 tab**：`src/renderer/src/web/web-cloud-workspace-store-ports.ts` 的 `activateWorkspace` 在 `tabsByWorktree[worktreeId].length === 0` 时 `createTab`。重开页面本地 tabs 恒为空（sanitizer 已剔除），于是每次都新建 1 个本地 tab；tab 无 ptyId，pane 挂载走 `terminal.create`（云允许）→ 全新 shell。旧 PTY 若还活着，客户端既不知道句柄也无清单。
6. **云里新开的终端是 client-owned 本地 tab**：`use-terminal-create-actions.ts`、`terminal-tab-create.ts` 用同一谓词把云会话排除在 `session.tabs.createTerminal` 之外（注释：云宿主拒绝 session.tabs.*，终端保持 client-owned），走 `createTab` + `terminal.create`。这些 tab 与其 pty 句柄只存在渲染内存，刷新即丢；分组（groupsByWorktree/tabGroups）同理。

### 1.3 简易工作区（管理台内嵌 cloud-admin）——独立实现，无恢复机制

- 入口：管理台 `cloud-platform/apps/web/app.js` 把宿主伺服的 `cloud-admin.html` 以全屏 iframe 覆盖层挂载；关闭时 `postMessage({type:'close'})` 并移除 iframe。
- 标签状态：`CloudSimpleWorkspace` 内 `useReducer(cloudSimpleWorkspaceTabsReducer)`，纯内存（`src/renderer/src/cloud/cloud-simple-workspace.tsx`、`cloud-simple-workspace-tabs.ts`）。`initialTabs` 只有测试传入，正式装配 `CloudSimpleWorkspaceSession` 不传 → 永远空。
- 终端：`CloudTerminalPanel` 每个终端 tab 挂载时 `terminal.create`（`cloud-terminal-panel.tsx:374`），卸载时 `terminal.close`；没有“重挂已有句柄”的分支。
- 关闭语义：`cloud-app.tsx:201-205` 收到 `close` 后 `closeProject()` → `projectConnections.close()` 关闭客户端连接；iframe 文档销毁，组件树与 xterm 全丢。
- 存储：iframe 内 localStorage 只有 `orca.webCloudDeviceKey` / `orca.webCloudHostTrust` / `orca.webCloudSession`（探针实测），无 tab/终端状态。

---

## 2. 现象矩阵与复现

| 场景                                                        | 期望                      | 实测                                                                                                                   | 证据                                                               |
| ----------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 简易工作区：开 Terminal 1 + README.md → 关闭 overlay → 重开 | 同项目同标签组 + 终端内容 | 工作区标签全为 0（只剩右栏“文件/Git 变更”）；终端面板 0                                                                | `u96-1..3`、`u96-probe-result.json`（before 2 个 tab → reopen 0）  |
| 简易工作区：整页刷新管理台 → 重开项目                       | 同上                      | 同样 0 个工作区标签                                                                                                    | `u96-4-reopen-overlay.png`、result `reopen-after-reload`           |
| Orca Web（云票据）首次进入                                  | 项目标签组                | 恒为 1 个新 `Terminal 1`                                                                                               | `u96-web-1-fresh.png`、`u96-orca-web-result.json` `web-open-fresh` |
| Orca Web（云票据）浏览器持久化                              | 至少能留下布局            | `orca.web.workspaceSession.v1.runtime:web-...` 中 `tabsByWorktree:{}`、`terminalLayoutsByTabId:{}`、`activeTabId:null` | 同上 localStorage dump                                             |
| 非云配对/中继 Orca Web                                      | 宿主镜像恢复              | 代码链完整（镜像未门控；`session.tabs.*` 权限 `workspace` 对 runtime-paired 放行）                                     | 静态链路                                                           |
| 宿主重启 vs 仅重开页面                                      | 均应恢复                  | 云票据两处都丢：页面重开丢本地内存；宿主重启后旧 PTY 也不可达（无清单/无本地句柄）                                     | 代码路径                                                           |

> 说明：Orca Web 的“关闭→重开”运行探针在用户指示“先分析代码/停止编写探针”后中止；该面结论由**本地存储快照 + 代码链路**给出，证据文件 `u96-orca-web-result.json` 只含首屏与存储快照。

---

## 3. 定性：回归还是缺口？嫌疑改动核查

### 3.1 Orca Web = 云适配引入的回归

- 时间线：W13b「cloud workspace view in orca web」`7df1f6738ea`（11-14 19:48）首次让 Orca Web 云票据点亮完整工作区；**同一天** O1-a `b08c5ec3ad3`（11-14 18:50）把云环境从镜像订阅中剔除。
- 设计意图（O1 设计 §F7）：云宿主拒绝 `session.tabs.*`，「客户端跳过 6 族」是既定的降噪修复；但**没有为云会话补上任何标签/终端恢复通道**，只在 bootstrap 里补一个本地新终端。
- 因此相对“原来（配对/中继）可恢复”的行为，这是回归；相对云功能本身，这是设计缺口。两句话不矛盾：**旧行为被云链路替换时丢了恢复能力**。

### 3.2 简易工作区 = 从未实现的缺口

- 该工作区 11-15 才落地（U46-5a/8），从一开始就是内存 reducer，从未接入 `WorkspaceSessionState` 或任何存储；`initialTabs` 未在生产装配使用。
- 关闭即 `closeProject` + 销毁 iframe，连“重挂活 PTY”都不可能。

### 3.3 对台账嫌疑提交的 diff 审读（均无罪）

| 提交                                   | 改动面                                                                             | 与恢复的关系                  |
| -------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------- |
| U52 `284795fb8b8`                      | `cloud-simple-workspace.tsx` 仅给 EmptyState 传 `canReadFiles`；右栏/标签图标/copy | 不触 tabs reducer、不触持久化 |
| U83 `2fc13910ded`                      | `cloud-simple-workspace.tsx` 一个 className `[&>*]:h-full` + 注释                  | 纯布局                        |
| U81b `70847f4f4a1` / U86 `8f50d9e96fd` | `cloud-platform/apps/web/app.js` 用户页/审计页                                     | 不触工作区                    |
| U84b `6b67ea041ba`                     | `terminal-output-batcher.ts` 单写刷新                                              | 输出延迟，不涉恢复            |
| 当前工作树                             | 仅 `.gitignore`、验收索引 md 与未跟踪 evidence/分析文档                            | 无产品码改动                  |

结论：恢复能力缺失不是这些近期修复造成的，而是 W13b/O1-a 的云链路设计选择（见 1.2）。

---

## 4. 修复方向（分面）

### A. Orca Web 云票据：恢复「宿主标签清单」链（首选，回到原语义）

1. 宿主：把只读清单族加入云方法表并做票据边界：
   - `session.tabs.list/listAll/subscribe/subscribeAll`（必要时 `session.tabs.activate/close/move`）加入 `cloudMethodAccess`，按 ticket 的 workspaceRoot 校验；或新增 `session.tabs.listOwn` 之类窄方法，避免把“宿主窗口”语义暴露给云。
   - 终端的 `terminal.list` / `terminal.read`（含运行态判定）/ `terminal.adoptOrphans` 在云 scope 内按 workspaceRoot 放行，支撑孤儿认领与回放；`terminal.split/closeAll/focus` 继续拒绝。
2. 客户端：删除/参数化 O1-a 的云跳过；保留“失败 fail-soft”，避免旧宿主 warn-loop。注意混合版本：新客户端连旧宿主时，旧宿主仍拒绝 → 需要 capability 协商（新 optional capability），否则回到 warn-loop。
3. 宿主清单必须真的含云客户端创建的 tab：
   - 方案 i：允许 Web 客户端发布 tab 图（`syncWindowGraph` 走 runtime RPC，标注 renderer-session-owned），宿主合并进 inventory；
   - 方案 ii：宿主在 `terminal.create` 时把 client 传入的 `tabId/leafId` 记入 workspace session（当前不写），使 headless inventory 可重建。
4. 恢复时机：页面启动 → `hydrateWorkspaceSession`（本地只给 active ids）→ 镜像订阅/首拉 inventory → 应用 tabs/groups/layout → 孤儿认领/重挂 → 订阅快照回放 scrollback。

- 工作量：L（宿主方法表 + scope 守卫 + 客户端取消门 + 协议兼容 + 测试矩阵）
- 风险：中高（云权限面扩大、旧宿主兼容、跨端 wire；必须 capability 协商与负向安全测试）

### B. Orca Web 云票据：客户端自持“布局 + 可验证句柄”（无宿主改动）

1. 浏览器 localStorage 按 `环境 + project/worktree` 存：
   - 非终端 tab（editor/preview/browser/diff）与 groups/layout/active id；
   - 终端 tab：只存 `tabId/leafId + host handle + pty incarnation/上次验证时间`，**不存“看起来可重放”的旧 selector**。
2. bootstrap 时先回填布局；对每个终端句柄用云允许的 `terminal.read`（或新增的轻量 liveness 方法）验证：
   - 有效 → `terminal.subscribe/multiplex` 直接回放快照（内容回来）；
   - 失效 → 保留 tab 结构，重建 PTY（至少不丢标签组）。
3. 清理策略：句柄失配/过期即删；host 重启探测失败把条目降级为“待重建”，避免 sanitizer 当初担心的 stale handle 重放。

- 工作量：M（纯渲染层 + 存储 schema + 过期策略），但**终端内容**只有在宿主 PTY 仍活着时才可回放；宿主重启后只能恢复到“空终端 + 原标签/分组”。
- 风险：中低（数据在本地、可清除；需防多设备互相覆盖）

### C. 简易工作区：持久化标签 + 保留 PTY

1. 标签/分组：
   - 在 console（`app.js`）按 `user + project` 存 overlay 的 tab set；或在 iframe 内 localStorage 以 project 为 key 存 `CloudSimpleWorkspaceTab[] + activeId`；
   - 打开时通过 `initialTabs` 注入（现有 prop 就是为此预留）。
2. 终端内容，三选一（按成本）：
   - **最小**：关闭 overlay 不销毁 iframe，只 `hidden`；PTY/xterm 原样保留（项目/权限切换时再销毁），并在宿主侧遵守 ≤12 socket 预算；
   - **中**：关闭时保留 `CloudTerminalPanel` 的 handle + worktree，重开时用 `terminal.subscribe` 重挂并由宿主回放滚动缓冲（需把 handle 存在 console/iframe 存储，且宿主 PTY 未死）；
   - **大**：打通简易工作区到 `session.tabs`/workspace session（与 A 合流），让内嵌工作区也吃宿主 inventory。
3. 关闭语义拆分：`关闭工作区` ≠ `结束会话`。当前 `close` 直接 `closeProject`，建议区分“收起 UI（可恢复）”与“结束会话（释放 PTY）”。

- 工作量：标签持久化 S/M；若只做“隐藏不销毁”S；若做重挂 M。
- 风险：隐藏方案会占用 socket/PTY 槽位；需要项目切换/登出/超时的兜底清理。

### D. 验收与回归建议

- 把 U91 A-RESTART 的断言从“新终端能到达实时”升级为：**重开前 tab 数/分组/活动 tab + 终端 marker 文本在重开后仍存在**（区分「仅页面重载」与「宿主重启」两档）。
- 增加回归用例：
  - 云 Orca Web：开 3 tab（2 终端 + 1 文件）→ 关页 → 新 handoff → 断言行数/分组/marker；
  - 简易工作区：开 Terminal + 文件 → 关 overlay → 重开 → 同一断言；
  - 负向：旧宿主（不支持新 capability）不得 warn-loop，退化为“仅恢复标签结构/新建终端”。
- 设计系统/安全：新增 RPC 必须过 `cloud-rpc-permission` 表与 `cloud-terminal-scope` 审计，附越权负例（他人 checkout 句柄/路径）。

---

## 5. 关键文件索引

| 关注点                  | 文件                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 会话状态模型            | `src/shared/workspace-session-state-types.ts`                                                                                      |
| 宿主持久化读写          | `src/main/persistence/loading-store/*`、`src/main/persistence-*.test.ts`                                                           |
| 渲染层发布图            | `src/renderer/src/runtime/sync-runtime-graph/graph-publication.ts`、`src/main/ipc/runtime.ts`                                      |
| headless 清单重建       | `src/main/runtime/orca-runtime-hydrate-headless-mobile-session-tabs-from-workspace-session.ts`                                     |
| Web 镜像链              | `src/renderer/src/runtime/web-session-tabs-sync/**`、`web-runtime-session-snapshot.ts`                                             |
| 云环境谓词/跳过         | `src/shared/runtime-environments.ts`、`global-session-subscription.ts`、`active-session-subscription.ts`                           |
| 云方法表                | `src/main/cloud-platform/cloud-rpc-permission.ts`、`src/main/runtime/rpc/rpc-caller-scope.ts`                                      |
| 云终端 scope            | `src/main/cloud-platform/cloud-terminal-scope.ts`                                                                                  |
| Web 本地会话 sanitize   | `src/renderer/src/web/web-workspace-session.ts`、`web/preload-api/web-workspace-session-api.ts`                                    |
| 云 Web bootstrap/建 tab | `src/renderer/src/web/web-cloud-workspace-bootstrap.ts`、`web-cloud-workspace-store-ports.ts`                                      |
| 云 Web 新终端分流       | `src/renderer/src/components/use-terminal-create-actions.ts`、`components/terminal/terminal-tab-create.ts`                         |
| 简易工作区              | `src/renderer/src/cloud/cloud-simple-workspace.tsx`、`cloud-simple-workspace-tabs.ts`、`cloud-terminal-panel.tsx`、`cloud-app.tsx` |
| 管理台覆盖层            | `cloud-platform/apps/web/app.js`（openProjectWorkspace / requestWorkspaceClose）                                                   |
| 终端快照回放            | `src/main/runtime/rpc/methods/terminal/terminal-multiplex-initial-snapshot.ts`                                                     |
| 孤儿 PTY 认领           | `src/renderer/src/runtime/web-session-terminal-orphan-recovery.ts`                                                                 |
