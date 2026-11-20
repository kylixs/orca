# U96 B 设计 · 简易工作区对接宿主 Orca 会话状态（方向 2）

- 日期：2026-11-16
- 性质：设计（只设计，未改产品代码）
- 唯一输入：`u96-tab-restore-diagnosis.md`（下称「诊断」）、`u96-tab-restore-design.md`（A 部分设计 + 审定，下称「A 设计」）
- 用户已定案：**方向 2**——简易工作区的标签组/终端对接原来的 Orca 会话状态，与 Orca Web 打开看到同样内容、管理方式一致、两边修改相互影响；尺寸冲突复用既有 `autoRestoreFit` 机制与回收弹框先例。
- 必要处已复核代码；与诊断不一致处标注在 §1.4。
- 依赖：A 批实现进行中（`session.tabs.*` 云子集、`terminal.list/adoptOrphans` scope、A4 持久化、capability）。B 不新造并行状态库、不新增 RPC/opcode。

---

## 0. 结论摘要

| 项         | 结论                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B 的定位   | 简易工作区 = 同一宿主 `workspaceSession` 的**第二个客户端**，全部读写复用 A 打开的通道，而不是本地持久化一套标签。                                                                                             |
| 真源       | 宿主 `workspaceSession.tabsByWorktree` + 内存 `mobileSessionTabsByWorktree`（A 已建立）；浏览器**不存 tab/handle**（沿用 `sanitizeWebRuntimeWorkspaceSession` 的既有原则）。                                   |
| 终端标签   | 宿主清单里的 terminal 行是权威；简易工作区按 `parentTabId` 映射为一枚终端标签，split 只渲染活动 leaf（§2.3）。                                                                                                 |
| 新终端     | 继续走 `terminal.create`，但**必须带 `tabId/leafId`**（A.4 持久化后两端可见）；不开放 `session.tabs.createTerminal`（沿用 A T3）。                                                                             |
| 关闭       | 任一端关 = `session.tabs.close({reason:'user'})` → 宿主 PTY 关闭 + 行退役（§3.2）。                                                                                                                            |
| 尺寸冲突   | 复用 remote-desktop floor + `fit-override-changed` + `terminal.restoreFit` / `terminal.updateViewport({claim:true})`；`terminal.getAutoRestoreFit` 放行读取，`setAutoRestoreFit` 按 scope 放行（§3.3、T-B6）。 |
| overlay    | 收起/离开 = **suspend**（关传输、保 PTY/行）；显式「结束工作区」= **end**（关 PTY、退役行）。旧 `close` 消息按 suspend 处理并仍回 `closed`（§4）。                                                             |
| 兼容       | 旧宿主无 capability → 简易工作区零 `session.tabs.*` 调用，退回今天的本地标签行为；旧控制台发 `close` → 仍可用。                                                                                                |
| 不改的边界 | 简易工作区不做分屏/拖拽/标签组 UI（U46 §4.4 的既定决定），只按宿主顺序展示；文件/预览/Diff 标签保持本地（§3.4）。                                                                                              |

---

## 1. B 面现状与差距（承接诊断，含修正）

### 1.1 实际运行形态（自主发现）

- 简易工作区是**宿主伺服的独立文档**：平台控制台 `app.js` 用一次性 handoff 把 `cloud-admin.html?embed=1&project=<id>` 全屏 iframe 挂起（`cloud-platform/apps/web/app.js:476-704`）。iframe 的 origin 是宿主/中继边缘，不是控制台。
- iframe 内的 React 根是 `src/renderer/src/cloud-admin/cloud-admin-root.tsx` → `CloudApp` → `EmbeddedWorkspace` → `CloudSimpleWorkspaceSession`（`cloud-app.tsx:383-416`）。它**没有**挂载主渲染器的 session store，也没有 `useWebSessionTabsSync`。
- RPC 链路（关键，诊断未展开）：
  `CloudRpc` = `bridge.rpc(method, params, projectId)` → preload `window.api.cloud.rpc` → IPC `cloud:rpc` → `CloudSessionService.rpc`（`cloud-session-service.ts:346-355`）→ `CloudProjectConnections.rpc`（`cloud-project-connections.ts:145-154`）→ **云票 WebSocket** → 宿主 `runtime-rpc-websocket-dispatch`。
  因此简易工作区的每次 `terminal.*` / `session.tabs.*` 都带 `context.cloud`（ticket 的 `projectRoot/workspaceRoot/perms`）、`clientKind = device.scope`（云设备默认 `'runtime'`，`device-registry-cloud-adoption.ts:99`）与 `pairedDeviceId`。**A 的云方法表、路径 scope、inventory 投影对简易工作区原样生效**——这是方向 2 可行的基础。
- 已有 `workspace.info` 调用（`cloud-simple-workspace.tsx:331-349`，目前只读 `branch`）。A 已在该响应加 `capabilities`，所以**能力探测不需要新增请求**。
- iframe localStorage 只有 `orca.webCloudDeviceKey` / `orca.webCloudHostTrust` / `orca.webCloudSession`（诊断 1.3 已实测）；没有 tab/终端状态。

### 1.2 当前标签/终端形态

| 关注点         | 现状                                                                                                                    | 代码                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 标签状态       | `useReducer(cloudSimpleWorkspaceTabsReducer)`，纯内存；`initialTabs` 只有测试传入                                       | `cloud-simple-workspace.tsx:158-162`、`cloud-simple-workspace-tabs.ts` |
| 标签 id        | 本地推导 `terminal-N`、`file:<path>`、`preview:<path>`、`diff:<path>`                                                   | `cloud-simple-workspace-tabs.ts:131-198`                               |
| 终端           | 每个终端标签挂载即 `terminal.create`（只有 worktree+title，无 tabId/leafId），卸载即 `terminal.close`                   | `cloud-terminal-panel.tsx:372-441`                                     |
| 订阅           | `terminal.subscribe`，`client:{id:randomUuid,type:'desktop'}`，只处理 `scrollback`/`data` 事件                          | `cloud-terminal-panel.tsx:251-350`                                     |
| 关闭 overlay   | 控制台发 `{type:'close'}` → iframe `closeProject()` → `CloudProjectConnections.close()` 关 socket → 300ms 后移除 iframe | `cloud-app.tsx:196-213`、`app.js:686-704`                              |
| 分屏/分组/排序 | 不渲染、不支持（U46 §4.4 明确决定）                                                                                     | `u46-three-actions-design.md:243-248`                                  |
| 终端上限       | 6（设备会话 12 socket 预算的口径）                                                                                      | `cloud-simple-workspace-tabs.ts:32-33`                                 |

### 1.3 差距矩阵（B 要补什么）

| 能力         | A 通道（Orca Web）                                     | 简易工作区今天                                | B 处理                                                                |
| ------------ | ------------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------- |
| 宿主清单     | `session.tabs.list/subscribe` + inventory/subscribeAll | 无                                            | 复用 `session.tabs.list` + `session.tabs.subscribe`（单 worktree）    |
| 快照应用     | `applyWebSessionTabsSnapshot`                          | 无                                            | 新增**纯投影模块**把宿主行映射到现有 reducer（不搬 web store）        |
| 孤儿认领     | `terminal.list` + `terminal.adoptOrphans`              | 无                                            | 复用 RPC 对（可选兜底，§2.4）                                         |
| 终端回放     | 订阅初始 `scrollback` 快照                             | 已有解析能力，但挂载总是新 PTY                | 复用现有面板的 `scrollback` 分支，改成 attach 既有 handle             |
| 新终端可见性 | `terminal.create(tabId,leafId)` + A.4 持久化           | 无 tabId/leafId，行不进宿主（或只剩内存）     | 传 `tabId/leafId`，让 A.4 记录                                        |
| 关闭一致     | `session.tabs.close`                                   | 卸载即 `terminal.close`（与 socket 关闭竞争） | 标签 × 显式 `session.tabs.close(reason:'user')`；卸载不再无条件关 PTY |
| 激活一致     | `session.tabs.activate`                                | 无                                            | 用户切换时 `activate`（带回环保护，§3.1）                             |
| 尺寸冲突     | `desktopViewportClaims` + floor/claim/restoreFit       | 未声明 claim 能力 → 每次挂载**抢占** floor    | 声明被动观察 + 显式 claim；复用弹框（§3.3）                           |
| 生命周期     | A T10：断开不杀 PTY                                    | close = 关 socket + 卸载关 PTY（不确定）      | suspend/end 拆分（§4）                                                |

### 1.4 对诊断的修正/补充

1. 诊断称「简易工作区无任何恢复机制」成立；补充：它的 RPC 与 Orca Web 是**同一条云票链路**，所以 A 的 scope/投影可直接复用，不需要为简易工作区另开权限面。
2. 诊断称「卸载即关闭句柄」成立（清理函数无条件 `terminal.close`，`cloud-terminal-panel.tsx:433-436`）；但要指出它与 `closeProject` 关 socket 存在**竞争**：PTY 是否真的被关取决于两个异步调用的先后，因此今天的「关闭后 PTY 是否存活」本身不确定。B 必须把它变成确定性语义。
3. 诊断说「关闭 overlay 即销毁 iframe」成立；B 不改「销毁」本身，改的是**销毁前对会话的处置**（suspend vs end）。
4. U46 §4.4 已明确「不做拖拽排序、不做分屏、关闭覆盖层即整体销毁、不跨项目保留」——B 只推翻最后一条的「标签不保留」，不重开分屏/分组 UI 范围。

---

## 2. 架构：简易工作区成为宿主的第二客户端

### 2.1 复用面（结论先行）

| 能力             | 既有实现                                                                                                                                                  | B 用法                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 单 worktree 清单 | `session.tabs.list`（`session-tabs.ts:25-37`）                                                                                                            | bootstrap 拉一次（订阅失败时的兜底） |
| 变更流           | `session.tabs.subscribe`（`session-tabs.ts:98-191`），先 `{type:'snapshot'}` 再 `{type:'updated'}`，结束 `{type:'end'}`                                   | 唯一持续真源                         |
| 关闭             | `session.tabs.close`（`session-tab-close-methods.ts:14-88`）                                                                                              | 标签 × / end                         |
| 激活             | `session.tabs.activate`（`session-tab-mutation-methods.ts:16-46`）                                                                                        | 用户切换标签                         |
| 新终端           | `terminal.create(tabId,leafId)` + A.4 `persistPublishedMobileSessionTerminalTab`                                                                          | + 终端 / 重开已结束会话              |
| 回放             | 订阅初始 fast snapshot（`terminal-multiplex-initial-snapshot.ts`，A7 边界）                                                                               | 现有面板 `scrollback` 分支           |
| 孤儿认领         | `terminal.list` / `terminal.adoptOrphans`（A-令3 放行）                                                                                                   | 可选兜底                             |
| 尺寸             | remote-desktop floor（`remote-desktop-terminal-floor.ts`）、`fit-override-changed` 流事件、`terminal.restoreFit`、`terminal.updateViewport({claim:true})` | overlay + 显式接管                   |
| 偏好             | `terminal.getAutoRestoreFit` / `setAutoRestoreFit`                                                                                                        | 读取已放行；写入按 scope（T-B6）     |
| 能力             | `workspace.info.capabilities = ['cloud.session-tabs-restore.v1']`                                                                                         | 门控整个 B 通道                      |
| 持久化           | 宿主 `workspaceSession`（A T2/T5）                                                                                                                        | 唯一跨刷新/跨设备真源                |

**不新增 RPC、不新增流 opcode、不新增 capability。**

### 2.2 bootstrap 顺序（页面 = 新文档）

1. `openWorkspace` 已返回 `workspacePath/permissions`，并注册了云 runtime environment（宿主侧）。iframed `CloudApp` 自动 open 一次（`cloud-app.tsx:154-163`）。
2. `workspace.info` → 读 `branch` + `capabilities`（已有调用扩展读取，不新增往返）。
3. 门控：`canUseTerminal && capabilities.includes('cloud.session-tabs-restore.v1') && subscribe !== null` 才进入 B 通道；否则**保持今天的行为**（本地标签、挂载建 PTY），零 `session.tabs.*` 调用。
4. `session.tabs.subscribe({worktree: cloudWorktreeSelector(workspacePath)})`：
   - 收到 `snapshot` → 投影（§2.3）→ 初始标签；
   - 收到 `updated` → 增量合并；
   - `onClose/onError` → 有上限退避重连（复用 `cloud-terminal-panel` 的退避形状）；`forbidden/method_not_found` 一次性降级为「无能力」，不重试、不 warn-loop（与 A-令4 同原则）。
5. 订阅建立前若需要立即渲染：并行 `session.tabs.list({worktree})` 作首屏兜底；订阅的 snapshot 到达后以其为准。
6. 每个终端面板按投影拿到的 handle 直接 attach；不再等「创建」。
7. 可选兜底：若某已知 `tabId` 的行缺失但该 worktree 仍有同 paneKey 的活 PTY，走 `terminal.list` + `terminal.adoptOrphans`（与 A.5 同语义；失败静默）。

### 2.3 宿主行 → 简易工作区标签（纯投影）

新增纯模块 `src/renderer/src/cloud/cloud-simple-workspace-session-tabs.ts`（无 React、无 store）：

```ts
export type CloudSimpleHostTerminalTab = {
  tabId: string // parentTabId
  leafId: string // activeLeafId ?? isActive 行 ?? 第一行
  terminal: string | null // status==='ready' 的 handle；pending-handle 为 null
  ptyId: string | null
  title: string
  leafCount: number // >1 表示宿主上是 split
  order: number
}
export function hostTerminalTabsFromSnapshot(
  snapshot: RuntimeMobileSessionTabsResult
): CloudSimpleHostTerminalTab[]
export function mergeHostTabsIntoState(
  state: CloudSimpleWorkspaceTabsState,
  hostTabs: readonly CloudSimpleHostTerminalTab[],
  hostActiveTabId: string | null
): CloudSimpleWorkspaceTabsState
```

映射规则：

| 宿主行                                            | 简易标签                            | 说明                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `type:'terminal'`，同一 `parentTabId` 的多个 leaf | **一枚** `terminal` 标签            | 取 `parentLayout.activeLeafId` 对应的 leaf（缺省取 `isActive`，再缺省第一行）；`leafCount>1` 在标签上显示「分屏」徽标，不在简易版渲染分屏。 |
| `type:'file'` / `type:'markdown'`                 | B-2 可选：`editor` 标签（只读投影） | 见 §3.4；B-1 忽略。                                                                                                                         |
| `type:'browser'` / `type:'agent-session'`         | 忽略                                | U46 §4.7 已声明简易版不含 Agent/浏览器；不渲染、不关闭。                                                                                    |
| 本地 `file/preview/diff`                          | 保持本地                            | 不推宿主（没有 `session.tabs.openFile`；A T3 保持最小面）。                                                                                 |

顺序与活动标签：

- 顺序：`tabGroups` 的组顺序 → 组内 `tabOrder` → 未列出的宿主行按 snapshot 顺序追加；本地文件标签排在宿主标签之后（保持用户打开顺序）。不做组 UI，只按宿主顺序展平。
- 活动标签：首个 snapshot 采用宿主 `activeTabId`（按 tab id 或 `parentTabId` 匹配）；之后保留本地选择，除非该标签消失（右邻优先，再左邻，最后宿主 active）。
- id 策略：宿主终端标签直接用 `parentTabId` 作简易标签 id；新建终端的 `tabId` 也由客户端生成同样形态的 id（如 `terminal:<uuid>`）并在 `terminal.create` 里传给宿主。这样宿主行出现时 id 天然对齐，无需「本地转宿主」迁移。
- 上限：`CLOUD_SIMPLE_WORKSPACE_MAX_TERMINAL_TABS` 只限制**新建**；宿主清单超过 6 个时全部展示，`+ 终端` 置灰。

reducer 扩展（在现有文件上，不新造 store）：

- `terminal` 变体增加可选 `host?: { leafId; terminal: string | null; ptyId: string | null; leafCount: number }`。
- 新 action：`{type:'host-snapshot'; tabs; activeId}`（整组替换宿主终端标签，保留本地 file/preview/diff）。
- 本地新终端仍用 `{type:'open'}`，但打开后立即以 `host` 占位（`terminal:null`），由后续 snapshot 补 handle。
- `nextTerminalTab` 改为「最低未用编号 + 稳定 uuid id」，避免与宿主 id 冲突。

### 2.4 终端 attach / create 状态机

`CloudTerminalPanel` 增可选 prop（默认值保持今天的行为，`cloud-project-workspace.tsx` 的独立页不受影响）：

```ts
hostSession?: {
  tabId: string
  leafId: string
  /** ready 时是宿主 handle；null 表示宿主还没有可用 PTY。 */
  terminal: string | null
}
detachPolicy?: 'close-on-unmount' | 'leave-running' // 默认 close-on-unmount
desktopViewportClaims?: boolean                    // 默认 false（保持旧行为）
onHandle?: (handle: string) => void                // 可选：本地记录，供 UI 状态
```

| 状态            | 触发                                          | 面板行为                                                                                            |
| --------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| attach          | `hostSession.terminal !== null`               | `handleRef = terminal`，直接 `connect()`；**不调用 `terminal.create`**                              |
| pending         | 宿主行存在但 `terminal===null`                | 显示「正在恢复终端…」；等下一次 `updated`；超过阈值（建议 10s）显示 ended 态「会话已结束」+「重开」 |
| ended → respawn | 用户点「重开」                                | `terminal.create({worktree, tabId, leafId, title})`；A.4 用同 tabId 更新 ptyId；成功后 attach       |
| local-create    | 新终端标签，无宿主行                          | `terminal.create({worktree, tabId, leafId, title})`；同时本地先显示 booting                         |
| 创建竞争        | create 返回时面板已卸载                       | 保留今天的清理：对返回的 handle 调 `terminal.close`（这是唯一仍需 `terminal.close` 的场景）         |
| 重挂前验证      | attach 失败 `terminal_handle_stale`/`unknown` | 不反复重试；把标签置为 ended 态，允许同 tabId 重开                                                  |

输入/输出/回放：全部沿用现有 panel —— `terminal.send`、`terminal.subscribe` 的 `data`/`scrollback`、`terminal.updateViewport`。

### 2.5 需要改/新增的文件

| 文件                                                                      | 改动                                                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/renderer/src/cloud/cloud-simple-workspace-session-tabs.ts`（新）     | 纯投影/合并函数 + 测试（§2.3）                                                                |
| `src/renderer/src/cloud/use-cloud-simple-workspace-session-tabs.ts`（新） | 能力门控 + list/subscribe + 退避/降级；输出 `hostTabs`、`syncing`、`unsupported`              |
| `src/renderer/src/cloud/cloud-simple-workspace-tabs.ts`                   | 扩展 terminal 变体、`host-snapshot` action、新 id 策略                                        |
| `src/renderer/src/cloud/cloud-simple-workspace.tsx`                       | 接 hook；终端标签渲染改为传 `hostSession`；dirty 调度不变                                     |
| `src/renderer/src/cloud/cloud-workspace-terminal-tab.tsx`                 | 把 host 元数据传给 panel                                                                      |
| `src/renderer/src/cloud/cloud-terminal-panel.tsx`                         | attach 模式、`detachPolicy`、`desktopViewportClaims`、`fit-override-changed` 处理、claim 调用 |
| `src/renderer/src/cloud/cloud-app.tsx`                                    | 生命周期 intent、`suspend/end` 消息、`ready.features`、project switch 前 suspend              |
| `cloud-platform/apps/web/app.js`                                          | 顶栏「结束工作区」、`suspend/end` 发送与超时、旧 `close` 兼容                                 |
| `src/main/cloud-platform/cloud-terminal-scope.ts`                         | `getAutoRestoreFit` 移出 DENIED；`setAutoRestoreFit` 按 T-B6 的 scope 放行                    |
| `src/main/runtime/rpc/methods/terminal/terminal-viewport-methods.ts`      | 仅当 T-B6 选择「set 放行」时改 handler（否则不改）                                            |
| A 的云 scope 文件（`cloud-session-tabs-scope.ts` 等）                     | B 只消费，不改；B-令2 依赖 A-令2                                                              |

---

## 3. 双向影响语义

### 3.1 新建 / 关闭 / 切换 / 输入

| 操作              | 发起端行为                                                                                                               | 另一端看到                                                  | 备注                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------- |
| 新建终端          | dispatch 本地 tab（id=`terminal:<uuid>`）→ `terminal.create(tabId,leafId)` → `session.tabs.activate(notifyClients:true)` | `session.tabs.subscribe` 的 `updated` 出现新行 → 自动加标签 | A.4 未持久化时，同进程仍可见；宿主重启后依赖 A.4                |
| 关闭终端          | 先 `session.tabs.close({worktree,tabId,reason:'user'})`，成功后 dispatch close                                           | 行退役 → 双方标签消失、PTY 关闭                             | 被拒（如 `live-host-pty`）时保留标签并提示原因                  |
| 切换标签          | `session.tabs.activate({worktree,tabId,notifyClients:true})`                                                             | 宿主 activeTabId 变 → 另一端切换                            | 回环保护：**应用 snapshot 时不回写 activate**；只有用户手势才写 |
| 输入              | `terminal.send(handle)`                                                                                                  | 共享同一 PTY；另一端由输出流看到回显                        | 多订阅者/flow control 沿用宿主                                  |
| 关闭 split 父标签 | `session.tabs.close(tabId)` 关闭整个 parent（所有 leaf）                                                                 | 另一端整组消失                                              | leafCount>1 时本地先确认「将结束 N 个分屏终端」                 |

### 3.2 关闭语义裁定（T5/T7）

**推荐：任一端关闭 = PTY 关闭 + 行退役。**

理由：

1. 宿主 `session.tabs.close(reason:'user')` 在 headless 路径已明确 `killPtys:true`（`orca-runtime-close-mobile-session-tab.ts:176-200` 一带）；在 renderer 拥有该 tab 时委托 renderer 关闭。这是既有语义，B 不需要新行为。
2. A8 已把「关闭后行退役、重开不复活」列为验收；两端语义必须与 A 一致，否则简易工作区关闭后 Orca Web 还显示一个已死标签。
3. 避免僵尸 shell：方向 2 下标签不再由单一客户端持有，若关闭只做本端隐藏，行会永远留在宿主清单里。

备选与取舍：

- **备选 A：本端 detach（只取消订阅，标签仍在宿主）**。优点是不会误杀另一端正在用的 shell；缺点是「关闭」变成假动作，下次 snapshot 立刻复活，且积累僵尸 PTY。只要需要「关闭」语义就不采用。
- **备选 B：仅在无其他订阅者时关闭 PTY**。需要宿主新增「意图 + 订阅者计数」裁决，且两端都关闭时仍留僵尸；不采用。
- **保留的拒绝语义**：当宿主桌面 renderer 正在拥有该 PTY 时，`session.tabs.close` 可能返回 `live-host-pty`/`retirement-owner`（`session-tab-close-methods.ts` → `closeMobileSessionTab`）。UI 必须展示「桌面端正在使用该终端，无法从云端关闭」并刷新清单，**不得**假装成功（负向用例 B4b）。

### 3.3 尺寸冲突：复用既有 fit/floor 机制（不新造）

现状（发现的真实差距）：简易工作区的 `terminal.subscribe` 没带 `capabilities.desktopViewportClaims`，宿主按旧行为在订阅时**直接 claim** floor（`terminal-legacy-subscribe-live.ts:143-153`）；而 Orca Web 的 desktop 客户端带 `desktopViewportClaims:1`（`remote-runtime-terminal-multiplexer-implementation.ts:151`）。所以今天简易工作区一打开终端就会抢走 Orca Web 的尺寸。

B 的语义：

1. **被动观察**：`terminal.subscribe` 增加 `capabilities: { desktopViewportClaims: 1 }`；订阅只登记 viewer，不抢 owner。
2. **谁拥有 floor**：宿主 `RemoteDesktopTerminalFloor` 只允许一个 viewer owner 驱动 PTY 尺寸；owner 断开时，存活 viewer 中最近活动者自动接任（`remote-desktop-terminal-floor.ts:198-240`），**这就是「两边切换不打架」的既有机制**。
3. **流事件**：订阅流已发送 `{type:'fit-override-changed', mode, cols, rows}`（`terminal-legacy-subscribe-live.ts:155-165`）。模式含义：
   - `desktop-fit`：本 viewer 是 owner；
   - `remote-desktop-fit`：另一个远程窗口是 owner；
   - `mobile-fit`：手机在驱动（与既有桌面 overlay 同一语义）。
4. **弹框（复用先例）**：在终端面板内绘制与 `MobileDriverOverlay` 同族的轻量 overlay（同一套 `Button`/`Badge`/`shadow-floating` 设计语言，不复制其内部逻辑）：
   - `remote-desktop-fit` → 文案「另一个窗口正在控制此终端尺寸」+ 主按钮「使用本窗口尺寸」→ `terminal.updateViewport({terminal, client, viewport, claim:true})`；次按钮「保持现状」。
   - `mobile-fit` → 文案「手机正在控制此终端」+「在桌面接管」→ `terminal.restoreFit`（既有、已在云 handle 白名单）。
   - 手机已离开但仍按手机尺寸（held）→ 「恢复为本窗口尺寸」→ `terminal.restoreFit`。
   - 何时询问：仅在收到 `fit-override-changed` 且本端可见/聚焦时提示；不打断后台标签；同一模式只提示一次（可折叠）。
5. **autoRestoreFit 的 scope 放行**：
   - `terminal.getAutoRestoreFit`：从 `CLOUD_TERMINAL_DENIED_METHODS` 移出，归 `terminal` 权限；只返回宿主全局偏好 `{ms}`，无用户数据。用于弹框显示「N 秒后自动恢复 / 保持直到手动恢复」。旧宿主拒绝时负缓存一次，不再调用。
   - `terminal.setAutoRestoreFit`：**不能直接放行全局写**。`mobileAutoRestoreFitMs` 是宿主全局设置（`shared/global-settings-types.ts:462`），而同一宿主可服务多个用户的 worktree（设计 §8.4/AC-27），一个项目票据改它会越权影响他人。推荐 scope（T-B6）：
     - 请求必须带**可选 `terminal` handle**，且 handle 解析在 `workspaceRoot` 内；
     - 宿主只把它写成**该 PTY 的临时 override**（与既有 `terminalFitOverrides` 同域的内存状态），不改 `mobileAutoRestoreFitMs`；
     - 无 handle / 越界 → 拒绝（`workspace_scope` / `terminal_unknown`）。
     - 若主会话不接受这点宿主改动，则回落为**只读放行**：弹框不提供「自动恢复」设置，仅提供 claim/restoreFit。
6. **overlay 状态与数据来源不新增**：全部来自既有的 `fit-override-changed`、`displayMode`、`getAutoRestoreFit`；不新增流 opcode。

### 3.4 非终端标签与分组/分屏的下限

- 本地 `editor/preview/diff`：继续只属于当前简易工作区；不写宿主、不出现在 Orca Web。关闭覆盖层即丢（沿用 U46 §4.4，dirty 有确认）。这是 B-1 的显式缺口，不假装一致。
- B-2（可选，后置）：把宿主 `file/markdown` 行投影为只读 `editor` 标签，使「Orca Web 打开的文件标签」在简易工作区可见；但**不能创建/关闭**这类宿主标签（没有云允许的创建 RPC），所以是单向可见，需产品确认是否值得。默认不做。
- 分组/分屏：只按宿主顺序展平；split 只渲染活动 leaf，标签带「分屏」徽标。不做组切换/拖拽（U46 §4.4）。
- 权限：A 把 `session.tabs.*` 归 `terminal` 权限；因此没有 `terminal` 权限的 viewer 会话**不会**同步标签（连文件标签也没有）。这是 A 的权限归属带来的限制；若产品要求 viewer 也能看到文件标签，需要另议 `session.tabs.list/subscribe` 的权限归属（Q-B6），B 不擅自放宽。

---

## 4. overlay 生命周期：suspend vs end

### 4.1 状态

| 动作                 | 语义                               | 传输                                                                         | 宿主 PTY / 行                      | iframe 文档            |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- | ---------------------- |
| 收起/返回/关闭覆盖层 | **suspend**                        | 取消 `terminal.subscribe`/`session.tabs.subscribe`，`closeProject` 关 socket | **保留**（行仍在，PTY 仍活）       | 销毁（控制台既有权衡） |
| 切换项目             | 先对旧项目 suspend，再 open 新项目 | 同上                                                                         | 保留旧项目                         | 旧 iframe 销毁         |
| 显式「结束工作区」   | **end**                            | 逐终端 `session.tabs.close({reason:'user'})` → `closeProject`                | PTY 关闭、行退役                   | 销毁                   |
| 控制台登出           | **suspend**（推荐）                | 现有 `logout` → iframe `signOut`；**不**隐式 end                             | 保留（与 Orca Web 断开即保活一致） | 销毁                   |
| 浏览器标签页关闭     | 传输自然断开                       | —                                                                            | 保留                               | 浏览器销毁             |

> 为什么 suspend 要关 socket：12 socket/设备会话预算（`cloud-session-limits.ts:40`）与后台流量；PTY 保活不依赖 socket（A T10）。为什么 end 要显式：用户表达的是「结束这些 shell」，不能由关窗口隐式推断。

### 4.2 embed 协议（additive）

iframe `ready` 消息增加可选 `features: ['session-tabs.v1','suspend','end']`（只列能力名）。控制台只在新 feature 存在时启用新按钮；旧 iframe 无 `features` → 行为不变。

| 方向               | 消息                             | 新行为                                                                          |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------- |
| 控制台 → iframe    | `{type:'close'}`（旧）           | iframe 按 **suspend** 处理，回 `{type:'closed'}`（旧控制台仍移除覆盖层）        |
| 控制台 → iframe    | `{type:'suspend'}`（新）         | suspend，回 `{type:'suspended'}`                                                |
| 控制台 → iframe    | `{type:'end'}`（新）             | end，回 `{type:'ended'}`                                                        |
| iframe → 控制台    | `{type:'ready', features:[...]}` | 控制台记录能力，显示「结束工作区」                                              |
| 控制台移除 overlay | 旧逻辑 300ms                     | suspend 仍 300ms；**end 用 5s 超时**（多 PTY 串行关闭），超时后强制移除并 toast |

兼容矩阵：

- 新控制台 + 旧 iframe：无 `features` → 不显示 end；`suspend` 不被识别，但控制台仍按 300ms 移除（相当于今天行为）。可降级为直接发 `close`。
- 旧控制台 + 新 iframe：只发 `close` → suspend + `closed`，行为与旧版一致（不再杀 PTY，这正是 B 的目标）。
- 两侧都新：完整 suspend/end。

### 4.3 面板卸载策略（确定性关键）

`CloudTerminalPanel` 的卸载清理今天无条件 `terminal.close`。B 增加 `detachPolicy`：

- `'close-on-unmount'`（默认，独立 cloud 页/独立终端面板保持现状）。
- `'leave-running'`（简易工作区）：卸载只取消订阅/xterm 销毁，**不**发 `terminal.close`。
  - 标签 × 先 `session.tabs.close`，再 dispatch 移除；panel 卸载不会二次关闭。
  - suspend：设置会话级 intent 后卸载；即使 React 清理先跑，也不杀 PTY。
  - end：逐标签 `session.tabs.close`，**不依赖**卸载清理。
  - create 竞争（创建返回前已卸载）仍关闭刚建的 handle——这是唯一例外。

实现建议：用 `CloudSimpleWorkspaceLifecycleContext`（`active | suspending | ending`）+ panel 的 `detachPolicy`；不要用全局变量。

---

## 5. 多用户 / 多设备隔离

- **scope 依据**：云票据的 `workspaceRoot` 按用户隔离（设计 §8.3/AC-27）。A 的 `projectCloudSessionTabsInventory` 对 `listAll/subscribeAll` 按根过滤；A-令2 对 `list/subscribe` 的 worktree selector 做 `checkCloudWorktreeScope`；`terminal.list/adoptOrphans` 的 handle 也按根校验。B 不新增 scope，只消费这些方法。
- **owner = 平台用户**：简易工作区是管理台 embed，其票据由平台按当前登录用户签发；iframe 没有额外身份来源（不读控制台 localStorage、不接受父窗口的 token）。因此不会出现「A 的浏览器替 B 读清单」。
- **同用户多设备**：两台设备各自拿自己的票据（同一 `workspaceRoot`），宿主清单是同一份；一端新建/关闭/输入，另一端通过 `subscribe` 看到/共享同一 PTY。这是方向 2 的目标状态。
- **同 user 多浏览器标签**：与多设备相同；设备 key 不同但票据根相同。
- **不同 user**：不同 `workspaceRoot`；`session.tabs.*` 跨根请求在 A 的 scope 层被拒（B 依赖 A5/A6 的负向测试）。
- **host 多项目**：简易工作区一次只 open 一个项目（控制台单 overlay），每次 open 的 ticket 只指向该项目根；不会看到同宿主其他项目。
- **iframe 隔离**：父窗口消息校验 `event.source === window.parent` + origin（现有 `isCloudAdminParentMessage`）；新增 `suspend/end` 不改变该边界。

---

## 6. scrollback 回放边界（复用 A7）

- attach 既有 PTY 时，`terminal.subscribe` 的初始 `scrollback` 帧由宿主按 `MOBILE_SUBSCRIBE_SCROLLBACK_ROWS = 1000`、`MOBILE_SNAPSHOT_BYTE_BUDGET = 512 KiB` 截断（`scrollback-limits.ts`），并在同一帧给出 `truncated` / `truncatedByByteBudget`（`terminal-multiplex-initial-snapshot.ts:79,104-105`）。B 不请求更大预算、不提高上限。
- 现有面板已按「先清屏与 scrollback，再重绘」处理（`cloud-terminal-panel.tsx:253-262`）；B 只增加：截断时在终端角落显示「仅回放最近 1000 行」的轻提示（不阻塞）。
- `localOnlyScrollbackByTabId` 永不离开宿主（A T4），云链路不读取；因此「宿主重启后终端内容」仍由 A 的 ended 语义决定（Q-B3）。
- attach 与 create 走同一个 `scrollback` 分支，保证两种路径一致；测试断言同一 marker 在 attach 后可见。

---

## 7. AC → 测试用例映射

| AC  | 内容                                                                                                                     | 测试文件（新增标 *）                                                                                                          | 用例要点                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| B1  | 简易工作区开 Terminal 1 + 文件 → 刷新管理台/重开 overlay → 终端标签与 marker 内容恢复                                    | `src/renderer/src/cloud-admin/cloud-simple-workspace.e2e.test.ts`（扩）、`cloud-simple-workspace-session-tabs.test.ts`*       | 真实宿主栈：写入 marker → 重新 handoff → `session.tabs.list` 返回同 tabId → 订阅回放含 marker |
| B2  | 宿主重启后：标签结构恢复，终端显示「会话已结束」，同 tabId 一键重开                                                      | `cloud-simple-workspace.e2e.test.ts`（扩）、`cloud-terminal-panel.test.tsx`（扩）                                             | pending-handle 超时 → ended UI；点重开携带原 tabId/leafId；宿主行 ptyId 更新                  |
| B3  | 简易工作区新建终端 → Orca Web 出现；Orca Web 新建 → 简易工作区出现                                                       | `cloud-simple-workspace.e2e.test.ts`（扩，双客户端 RPC）、`session-tabs-inventory-rpc.test.ts`（扩）                          | `terminal.create(tabId,leafId)` 后 list 含新行；反向 attach 同一 handle                       |
| B4  | 任一端关闭 → PTY 关闭 + 行退役；两端标签消失                                                                             | `session-tabs.test.ts`（扩）、`cloud-simple-workspace.e2e.test.ts`（扩）                                                      | close reason user → snapshot 无该行；PTY 不可再 subscribe                                     |
| B4b | 宿主桌面拥有 PTY 时云端关闭被拒，UI 保留标签并提示                                                                       | `session-tab-close-methods.test.ts`（扩）、`cloud-simple-workspace.test.tsx`（扩）                                            | 返回 `live-host-pty` → 不出队、提示可见                                                       |
| B5  | 两端输入/输出一致                                                                                                        | `cloud-simple-workspace.e2e.test.ts`（扩）                                                                                    | 两个订阅者；一端 send，另一端收到同 chunk；回显 marker 仅一次                                 |
| B6  | 尺寸冲突：非 owner 收到 `remote-desktop-fit` → 弹框 → 「使用本窗口尺寸」→ PTY 尺寸切换；手机驱动 → `terminal.restoreFit` | `cloud-terminal-panel.test.tsx`（扩）、`remote-desktop-driver.test.ts`（扩）、`cloud-simple-workspace-fit-conflict.test.tsx`* | claim 参数、restoreFit 调用、`getAutoRestoreFit` 读取；另一 viewer 收到 fit 变化              |
| B6b | 旧宿主拒绝 getAutoRestoreFit → 只提示一次、不重试                                                                        | `cloud-terminal-panel.test.tsx`（扩）                                                                                         | RPC 计数 1，负缓存生效                                                                        |
| B7  | 收起/suspend：不杀 PTY、不退役行；重开立即恢复且回放 marker                                                              | `cloud-simple-workspace.e2e.test.ts`（扩）、`cloud-admin-embed.test.tsx`（扩）                                                | RPC 断言无 `terminal.close`/`session.tabs.close`；重启 iframe 后同 row                        |
| B8  | 显式 end：关闭全部终端 PTY 并退役行；重开只剩其他端新建的标签                                                            | `cloud-simple-workspace.e2e.test.ts`（扩）、`u46-3-overlay.e2e.test.ts`（扩）                                                 | end 消息 → close 调用序列 → list 为空；控制台 5s 超时                                         |
| B9  | 用户隔离与同用户多设备                                                                                                   | `cloud-session-user-isolation.test.ts`（扩）、`cloud-multi-project.test.ts`（扩）                                             | 不同 workspaceRoot 的 list/subscribe 互不可见；同根两设备 snapshot 一致                       |
| B10 | 旧宿主无 capability：零 `session.tabs.*`/`terminal.list` 调用；退回本地标签行为                                          | `cloud-capability-gate.test.ts`（扩）、`cloud-simple-workspace.test.tsx`（扩）                                                | 计数 0；`+ 终端` 仍可建本地 PTY；无 warn-loop                                                 |
| B11 | 回放边界：1000 行/512 KiB/truncated；localOnly 不外发                                                                    | `terminal-snapshot-publication.test.ts`（扩）、`cloud-terminal-panel.test.tsx`（扩）                                          | 截断标记；localOnly 不出现在任何帧                                                            |
| B12 | 旧控制台/旧 iframe 兼容                                                                                                  | `cloud-admin-embed.test.tsx`（扩）、`cloud-platform/test/e2e/u46-3-overlay.e2e.test.ts`（扩）                                 | 旧 `close` → suspended 语义 + `closed` 回复；新控制台遇旧 iframe 回退                         |
| B13 | 本地文件标签不被推入宿主，关闭覆盖层前 dirty 确认仍生效；切换项目不覆盖另一项目的宿主标签                                | `cloud-simple-workspace.test.tsx`（扩）、`cloud-simple-workspace-tabs.test.ts`（扩）                                          | 宿主快照合并保留本地 tab；项目切换先 suspend；宿主行按 worktree 隔离                          |

E2E 断言升级（沿用 A 的 D 项）：把 U91 A-RESTART 的「新终端能到达实时」升级为「重开前后 tab 数/顺序/活动标签 + marker 文本仍在」，并区分「仅页面重载」与「宿主重启」两档。

---

## 8. T / Q 清单

### 8.1 终审项（T）

| 编号 | 事项                                                                                | 建议                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T5   | B 的存储位置（A 预留）                                                              | 复用宿主 `workspaceSession`（A T2）；浏览器零句柄、零 tab。                                                                                                           |
| T6   | 挂起 TTL（A 预留）                                                                  | B-1 不加新 reaper：suspend 保留 PTY，由宿主重启/显式 end 回收。风险是无订阅者 PTY 长期驻留；若产品要求，再加「无订阅者 N 小时回收」的宿主策略（独立令，不属于 B-1）。 |
| T7   | 结束语义（A 预留）                                                                  | 见 §3.2：任一端关=PTY 关+行退役；overlay 显式 end 才批量关闭。                                                                                                        |
| T-B1 | 新终端创建走 `terminal.create(tabId,leafId)` 还是开放 `session.tabs.createTerminal` | 先走前者（A T3、最小面）；若实测宿主有桌面窗口时新标签不进 inventory（Q-B1），再评估开放 createTerminal。                                                             |
| T-B2 | 活动标签是否跨端同步                                                                | 默认同步（`activate` + snapshot 回环保护）。若实测抢焦点明显，改为 `notifyClients:false`（仅宿主状态一致，不驱动另一端 UI）。                                         |
| T-B3 | split 标签在简易版的表现                                                            | 只渲染活动 leaf + 「分屏」徽标；不做分屏 UI（U46 §4.4）。关闭按整个 parent 处理并二次确认。                                                                           |
| T-B4 | 文件标签是否做 B-2 单向投影                                                         | 默认不做；单向可见但不可建/关，容易造成「看起来该能操作」的误解。                                                                                                     |
| T-B5 | suspend 是「销毁 iframe + 关 socket」还是「隐藏 iframe 保连接」                     | 推荐销毁 + 关 socket（释放 12 socket 预算，PTY 仍活）；隐藏方案留给需要保留未保存本地缓冲的产品需求（可后续加「最小化」）。                                           |
| T-B6 | `setAutoRestoreFit` 的 scope                                                        | 推荐「必须带体内 `terminal` handle + 只写该 PTY 的临时 override」；不接受则只放行 `get`，弹框不给自动恢复设置。                                                       |
| T-B7 | 登出时是否隐式 end                                                                  | 推荐 suspend（与 Orca Web 一致，避免误杀用户进程）；显式 end 由用户操作。                                                                                             |

### 8.2 开放问题（Q）

| 编号 | 问题                                                                                                                                                                                               | 影响 / 处理                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Q-B1 | 宿主有权威桌面窗口时，云客户端 `terminal.create` 的 tab 是否进 inventory？A.4 的持久化 guard 在此时跳过（`orca-runtime-publish-pty-backed-mobile-session-terminal.ts:178`），membership 也可能拒绝 | 决定 B3 是否在「桌面也开着」场景成立；需一条 characterization 测试，必要时 A 补 renderer 合并路径           |
| Q-B2 | 云项目是否已有 `workspaceSession` 条目（A Q3）                                                                                                                                                     | 没有则 `session.tabs.list` 返回空/报错，`terminal.create` 的持久化也缺容器；B 依赖 A 的「首开建空 session」 |
| Q-B3 | 宿主重启后 `pending-handle` 是否会一直 pending                                                                                                                                                     | 决定 B2 的 ended 判定阈值；依赖 A Q6/T10 的实测                                                             |
| Q-B4 | `terminal.subscribe` 的云 handle scope 是否接受 Orca Web 创建的 handle                                                                                                                             | 预期接受（同 worktree），需 A-令3 的负向/正向用例覆盖                                                       |
| Q-B5 | `session.tabs.subscribe` 的云增量帧是否按 `workspaceRoot` 过滤（A.3）                                                                                                                              | 是则 B 可直接信 snapshot；否则 B 需二次过滤（不推荐）                                                       |
| Q-B6 | 无 `terminal` 权限的 viewer 是否需要看到文件标签                                                                                                                                                   | A 把 `session.tabs.*` 归 `terminal`；若要 viewer 可见，需重新分配权限，B 不擅自改                           |
| Q-B7 | 12 socket 预算在「隐藏旧 project iframe」方案下是否够                                                                                                                                              | 推荐销毁 iframe，故不构成问题；若选隐藏方案需按项目数核算                                                   |
| Q-B8 | `session.tabs.close` 的 intent 能力：云 socket 是否声明 `session-tabs.close-intent.v1`                                                                                                             | 声明了则必须带 `reason`（B 默认带）；未声明则无需，行为一致                                                 |

---

## 9. 实现令切分（每令 ≤20 分钟，标依赖）

> 大部分排 A 批 5 之后；B-令1 只需 A-令1，B-令6 只需 A-令3。

| 令    | 内容                                                                                                                                                    | 依赖                     | 文件域                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| B-令1 | 纯投影模块 + reducer 扩展：`hostTerminalTabsFromSnapshot`、`mergeHostTabsIntoState`、terminal 变体 `host` 元数据、`host-snapshot` action、id 策略；单测 | A-令1（capability 常量） | 新 `cloud-simple-workspace-session-tabs.ts`、`cloud-simple-workspace-tabs.ts`、两测试                                            |
| B-令2 | bootstrap hook：`workspace.info.capabilities` → `session.tabs.subscribe`/`list`、退避重连、无能力负缓存；接入 `CloudSimpleWorkspaceSession`             | A-令2/A-令4；B-令1       | 新 `use-cloud-simple-workspace-session-tabs.ts`、`cloud-simple-workspace.tsx`、`cloud-terminal-panel.test.tsx`（计数）           |
| B-令3 | 终端 attach/create：`hostSession` prop、pending/ended/重开、create 带 tabId/leafId、`detachPolicy`                                                      | A-令3/A-令5/A-令6；B-令2 | `cloud-terminal-panel.tsx`、`cloud-workspace-terminal-tab.tsx`、`cloud-simple-workspace.tsx`、`cloud-terminal-panel.test.tsx`    |
| B-令4 | 关闭/激活/新建双向：× → `session.tabs.close(reason:'user')`、activate（回环保护）、新建后 activate；拒绝原因 UI                                         | B-令2/B-令3              | `cloud-simple-workspace.tsx`、`cloud-simple-workspace-tabs.ts`、`cloud-simple-workspace.test.tsx`                                |
| B-令5 | 生命周期：`suspend/end` 消息、`ready.features`、project switch 先 suspend、end 超时；面板卸载策略                                                       | B-令3                    | `cloud-app.tsx`、`cloud-platform/apps/web/app.js`、`cloud-admin-embed.test.tsx`、`u46-3-overlay.e2e.test.ts`                     |
| B-令6 | 尺寸冲突：`desktopViewportClaims`、`fit-override-changed`、claim/restoreFit、overlay 组件、`getAutoRestoreFit` 放行（+T-B6 的 set scope）               | A-令3；B-令3             | `cloud-terminal-panel.tsx`、新 `cloud-terminal-fit-overlay.tsx`、`cloud-terminal-scope.ts`、`remote-desktop-driver.test.ts`      |
| B-令7 | 回放/结束边界与孤儿兜底：truncated 提示、ended 阈值、`terminal.list/adoptOrphans` 适配（可选）                                                          | A-令3/A-令7；B-令3       | `cloud-terminal-panel.tsx`、新 `cloud-simple-workspace-orphan-recovery.ts`（如需要）、`terminal-snapshot-publication.test.ts`    |
| B-令8 | 端到端回归：重载/宿主重启/双客户端/旧宿主/隔离                                                                                                          | B-令2..7                 | `cloud-simple-workspace.e2e.test.ts`、`cloud-session-user-isolation.test.ts`、`cloud-capability-gate.test.ts`、`evidence/u96-b/` |

并行约束：

- B-令1 与 A-令2/3/4 文件域不相交，可在 A-令1 后先做。
- B-令2 依赖 A-令2（scope）与 A-令4（能力门控的共享常量/谓词）；A-令2/3 串行（同 path guard）。
- B-令3 依赖 A-令5（bootstrap 顺序）与 A-令6（持久化）；A-令6 未完成时 B3（两端可见）无法验收。
- B-令4 与 B-令6 都改 `CloudSimpleWorkspaceSession`/panel 的 props，串行合并。
- B-令5 只改控制台与 `cloud-app`，可与 B-令4/6 并行，但需在 B-令3 之后跑。
- B-令7/8 最后。

---

## 10. 风险与依赖（执行前必读）

1. **A 未完成则 B 不可验收**：B 的核心 AC（B1/B3/B4/B7）全部依赖 A-令2/3/5/6。不要把 B 排到 A-令5 之前。
2. **宿主桌面窗口场景**（Q-B1）：A 的持久化与 membership 都假定 headless。若宿主同时开着 Orca 桌面窗口，云客户端新建的标签可能不进入宿主清单，B3 退化为「本端可见」。需要在 A-令6 后做一条 characterization，再决定是否补 renderer 合并路径。
3. **云 host 多租户**：`setAutoRestoreFit` 的全局写会跨用户；T-B6 的 scope 是安全底线，不得为了省事直接放行。
4. **socket/PTY 资源**：suspend 保 PTY 会累积进程；T6 的 TTL 是后续项，B-1 至少提供显式 end。不要在 suspend 里隐式 `terminal.close`（那会回到今天的症状）。
5. **旧宿主/旧控制台**：任何新消息都要 additive（`features` + 可选字段）；旧侧忽略未知消息，新侧遇到旧侧要回退到今天的路径，不得 warn-loop。
6. **设计系统**：overlay 复用 `components/ui/` 原语与既有 `shadow-floating` 层级，不新增颜色/字号；`pnpm run check:code-quality:changed` 必须过。

---

## 11. 留给主会话审定

- T5/T6/T7（A 预留）按本文 §8.1 的答案确认。
- T-B1（创建路径）、T-B2（活动同步）、T-B5（suspend 实现）、T-B6（setAutoRestoreFit scope）需要明确放行/否决。
- Q-B1/Q-B3 建议在 A-令6/A-令7 完成后各补一条 characterization，再冻结 B-令3 的 ended 阈值与 B-令8 的宿主重启断言。
- B-令1 可在 A-令1 后立即开；B-令2 必须等 A-令2/A-令4 合入。

## 主会话审定（2026-11-16，B 部分）

- **T5** 定：存储=宿主 `workspaceSession`（浏览器零句柄），与 A/T2 单一真源。
- **T6** 定：B-1 不加 PTY 空闲 reaper；suspend 保活、显式 end 回收。
- **T7** 定：任一端关闭=PTY 关+行退役（与 A8 语义一致；备选已否决）。
- **T-B1** 定：新终端继续 `terminal.create(tabId,leafId)`；`createTerminal` 不开放。
- **T-B2** 定：活动标签跨端同步（带 snapshot 回环保护；实测异常可退 notifyClients:false）。
- **T-B3** 定：split 仅渲染活动 leaf+徽标，简易工作区不做分屏 UI。
- **T-B4** 定：文件标签默认不做 B-2 单向投影。
- **T-B5** 定：suspend=销毁 iframe+关 socket，PTY 保活。
- **T-B6** 定：`setAutoRestoreFit` 放行必须带体内 terminal handle、仅写该 PTY 临时 override；不满足即只读（宿主全局设置不得裸放行——跨用户风险）。
- **T-B7** 定：登出=suspend，不隐式 end。
- **Q-B1..B8**：随 B-令实施逐项探针落实（不预先实现）。
- **新增发现转台账**：订阅即抢尺寸 → U98（随 B-令6 修复）。
- **流程**：B-令1 可即开（仅依赖 A-令1 已落）；B-令2 等 A-令2/4；B-令3 等 A-令5/6；B-令4+6 串行；B-令5 并行；B-令7/8 收口。
