# U138 活动标签权威矩阵（Orca Web 云会话）

> 2026-11-16 · 用户裁定：**刷新/重开后活动标签以宿主为准（宿主单一权威）**
> 背景：五轮修复返工判例（协议 §2-28/§2-29），本文用于固定各层职责与优先级，后续同类改动以此矩阵为准。

## 1. 层与字段

| 层                    | 字段/来源                                                                                             | 谁写                                     | 生命周期           |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------ |
| 宿主内存快照          | `session.tabs.list` 的 `activeTabId` / group `activeTabId`                                            | activate/close/create 后由宿主运行时维护 | 进程内             |
| 宿主持久              | `WorkspaceSessionState.activeTabIdByWorktree`、group active、split `activeLeafId`                     | 配对客户端 activate（二期 `fa6143d4fa7`）；桌面窗口 focus 回写 | 重启保留           |
| 宿主每设备选择        | `mobileClientTabSelectionsByDeviceId[dev]`                                                            | activate 时按 pairedDeviceId 写          | 重启保留（可陈旧） |
| 客户端本地恢复        | 浏览器本地 `activeTabIdByWorktree` / per-worktree 选择                                                | 用户手势与本地恢复                       | 页面级             |
| DOM                   | 渲染出的 `data-active`                                                                                | 由 store 派生                            | 页面级             |

## 2. 优先级（裁定后）

1. **入场/重载**：宿主持久 active（经 `session.tabs.list` 投影）为唯一初始活动标签；客户端本地恢复值不得覆盖。
2. **宿主广播**：无本地 pending 手势时，客户端跟随宿主 active 变化（其他设备激活、恢复回放）。
3. **用户手势**：本地立即切换 → `session.tabs.activate`（配对路径）→ 宿主落盘 → 广播回显；客户端等待回显收敛，不做独立回写。
   - **镜像 attach 不是手势**（七期诊断 H4）：页面挂载时隐藏 pane 的 `attachHostSessionMirror → activateHostSessionSurface` 固定携带 `navigation:'caller', notifyClients:false`；宿主**不得**将其持久化为 active（只做 caller 投影），否则隐藏 pane 会翻转全局活动标签。判定依据：`session.tabs.activate` 参数含 `navigation` 即非显式导航。
4. **每设备选择**：仅当有效且指向现存 tab 时参与投影；缺失/失效回退快照 active（`client-session-tab-selection.ts`）。
5. **桌面原生窗口**：渲染器 focus 回写为权威路径，不因配对客户端写入而双写/回跳。

## 3. 收敛方向

- 单一收敛目标：`host snapshot active`。客户端与 DOM 均向其收敛；任何新写入路径必须能说明「写后宿主 snapshot 与持久值如何变化」。
- 禁止：客户端在恢复链中主动 activate 回写（三期/五期方案已按裁定移除）。

## 4. 验证要求（对应 §2-26/§2-30）

- 场景变体必须包含「活动标签 ≠ 最后创建标签」与「3 tab / 2 group」。
- 快速环：`evidence/journey-9/verify-u138-activation.mjs` 类窄探针先行；探针绿后再走全 journey。
- 门禁：a2 三方一致 + B7 三次重开 active 一致（多次采样，非单次）。

## 5. 已知边界

- 多设备同时操作时以最后落盘的 activate 为准（last-write-wins）；每设备投影只影响该设备视图。
- DB 中历史陈旧设备条目不做主动清理，仅靠有效性回退兜底（卫生项）。
