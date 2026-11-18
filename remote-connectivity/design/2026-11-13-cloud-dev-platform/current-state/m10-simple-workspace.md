# M10 · 简易工作区（嵌入形态 / 标签 / 终端生命周期）

> **基线提交**：`664a91e0322`（2026-11-16）。U112 修复已合入 `fee2402fb3a`（D1/D2）与 `737a3962428`（D3–D8）；U113 A-fix1 已合入 `530807b7a18`，相关项标注已实现。
> 代码入口：`src/renderer/src/cloud/cloud-simple-workspace*.ts(x)`、`cloud-admin-embed*.ts`、`cloud-terminal-panel.tsx`、`cloud-terminal-fit-overlay.tsx`。
> 相关设计：`work-orders/u46-three-actions-design.md`、`u96-bridge-design.md`。

---

## 1. 页面/界面布局

简易工作区是**管理台同页嵌入**的轻量工作区（U46：只读当前浏览器，不是远程 Orca 窗口）。由 `cloud-admin.html?embed=1` 承载、管理台用 iframe/overlay 嵌入。

```
┌ 标签条：终端* | 文件(文本/图片/PDF/二进制占位) | Diff ┐
│ 宿主提示条（关闭被拒/连接不可用时出现，可关闭）        │
├──────────────────────────────┬────────────────────────┤
│ 中央面板（每个标签一个 tabpanel，hidden 保留挂载） │ 右侧栏：文件树 | Git 变更 │
│ 终端 / 文件编辑器 / 预览 / Diff               │ （file:read 才挂载）    │
├──────────────────────────────┴────────────────────────┤
│ 底部状态栏：连接状态 · 直连/中继 · 延迟 · 项目 · 分支 · 路径 · 未保存数 │
└───────────────────────────────────────────────────────┘
```

- 无左侧栏；右侧栏为 `CloudSimpleWorkspaceRightPanel`，文件树/Git 变更两 tab；`canReadFiles=false` 时只读面板隐藏。
- 空态 `CloudSimpleWorkspaceEmptyState`（按 terminal/file:read 权限给不同提示）；`degraded` 时整页权限/失败说明，绝不渲染空框。
- 未保存关闭确认 `CloudSimpleWorkspaceCloseConfirm`（保存/放弃/取消），并把 dirty 数上报给嵌入宿主（`onDirtyCountChange`）。
- 终端权限缺失时终端标签渲染「当前项目未授予终端权限」而非空白。

## 2. 菜单与入口

| 入口                 | URL/触发                                                         | 行为                                                                                 |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 管理台项目行「打开」 | `cloud-admin.html?embed=1&project=<id>#handoff=<code>`           | `readCloudAdminEmbedEntry` 解析；handoff code 立即从 hash 抹掉；兑换后进入简易工作区 |
| 刷新嵌入页           | `?embed=1&project=<id>`（无 hash）                               | 依赖持久会话继续；code 缺失不是错误                                                  |
| 独立页回退           | 嵌入就绪超时 `20_000 ms`（`CLOUD_ADMIN_EMBED_READY_TIMEOUT_MS`） | 回退独立 `cloud-admin.html` 页面                                                     |
| 父页面消息           | `postMessage({source:'orca-cloud-admin', type})`                 | `suspend` / `end` / `logout` / legacy `close`（`cloud-admin-embed-lifecycle.ts`）    |

handoff 失败文案：`HANDOFF_GONE` / `PROJECT_FORBIDDEN` / `network_error` → 登录表单提示（`cloudAdminHandoffFailureNotice`）。

## 3. 操作清单（动作→结果→失败态）

### 3.1 标签

| 操作                   | 结果                                                                                                                                           | 失败/边界                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 点文件树文件           | 打开/激活文件标签；按扩展名进 registry：文本编辑器 / 图片预览 / PDF / 二进制占位                                                               | 未知扩展回落文本宿主；二进制由读取结果细化为占位（FS-1）                                                                                |
| 新建终端               | 本地先加终端标签（`nextTerminalTab`）；若宿主支持则 `terminal.create`（客户端生成 `terminal-<uuid>` + 裸 leaf UUID）后 `session.tabs.activate` | 宿主不支持/失败 → 本地标签保留，降级一次不重试                                                                                          |
| 激活标签               | 本地 activate；宿主型终端额外 `session.tabs.activate`（仅用户手势，应用宿主帧时不回写，T-B2 防回环）                                           | 失败降级但保留本地布局                                                                                                                  |
| 关闭终端               | 宿主型：`session.tabs.close` → 成功才移除标签                                                                                                  | `refused` 保留标签并显示提示（`live-host-pty`/`retirement-owner`/`stale-*`/`unknown-liveness`）；`local` 走本地关闭并提示「连接不可用」 |
| 关闭文件/Diff 本地标签 | 本地 reducer；dirty 时进未保存确认                                                                                                             | —                                                                                                                                       |
| 宿主推送标签变化       | `session.tabs.list`/订阅帧 → `host-snapshot` action 纯投影                                                                                     | capability 缺失时零调用；一次失败负缓存                                                                                                 |

### 3.2 终端 attach / 尺寸

- 订阅声明 `capabilities.desktopViewportClaims: 1` → **被动观察**，不再一开终端就 claim fit floor（U98，B-令6）。
- 宿主回报尺寸冲突时渲染 `CloudTerminalFitOverlay`：
  - 文案分「另一个窗口控制」/「手机控制」；
  - 按钮「保持现状」与「使用本窗口尺寸/恢复为本窗口尺寸」；
  - 支持宿主自动恢复时间文案（`autoRestoreText`）。
- 终端面板状态：`booting` / `live` / `reconnecting` / `failed` / `pending`（等待宿主恢复）/ `ended`（会话已结束 + 重开）。

### 3.3 生命周期 suspend / end

| 意图                                               | 实现                                                                                     | 结果                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| `active`                                           | 正常挂载                                                                                 | —                                 |
| `suspending`（overlay 收起/`close` legacy/logout） | 面板 unmount 策略 `leave-running`：销毁 xterm/流/socket 但**保留宿主 PTY**               | 回复 `suspended` / `closed`       |
| `ending`（显式 end）                               | `intent='ending'` → `runEndCleanup()`（注册的 `closeAll`）→ 关项目 socket → 回复 `ended` | 关闭宿主承接的 PTY 并退役行（U112 D1 `fee2402fb3a`） |
| 普通 unmount                                       | `close-on-unmount`：只关闭本面板自己创建的 PTY                                           | 宿主承接的标签需 end 清理         |

- 状态机与 `cloudTerminalDetachPolicy` 在 `cloud-simple-workspace-lifecycle.tsx`；embed 生命周期在 `cloud-admin-embed-lifecycle.ts`。
- **现状（U112 D1，已实现 `fee2402fb3a`）**：`end` 先 await 注册的 end cleanup，`cloud-simple-workspace-end-close.ts` 按 `session.tabs.list` 逐 tab `session.tabs.close(reason:'user')` 关闭 attached/reopened PTY 并退役 inventory 行，再 closeProject。
- **现状（U112 D2，已实现 `fee2402fb3a`）**：`pending-handle` 达 `PENDING_HANDLE_TIMEOUT_MS`（10s）转 `ended`，复用既有「会话已结束」提示与同 tabId/leafId 重开；阈值内拿到 handle 仍直接 attach。

### 3.4 孤儿恢复

1. 投影后收集 `status === 'pending-handle'` 且带 `ptyId` 的终端行（每 tab 只取第一个 leaf，上限 64）。
2. `terminal.list`（`requireFreshPtyLiveness: true`）按 `ptyId` 匹配宿主幸存 PTY；需要宿主见证 + incarnation 才认领。
3. `terminal.adoptOrphans`（同一 worktree selector）认领；失败/越界静默降级，每 bootstrap 一次。
4. scope 与 A 链一致：worktree 落在票据 `workspaceRoot` 内。

## 4. 数据来源

| 面       | API/事件                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 平台     | `/v1/web/handoff`、`/v1/projects/{id}/connect`、嵌入页登录/刷新                                                                                                          |
| 宿主 RPC | `workspace.info`（branch/capabilities/perms）、`session.tabs.list/subscribe/activate/close`、`terminal.list/adoptOrphans/create/close/subscribe`、`file.*`、git 相关 RPC |
| 宿主流   | 终端快照/增量、fit override 事件（尺寸冲突）                                                                                                                             |
| 浏览器   | `postMessage` 父页面协议；无本地持久标签（B 面宿主为真源）                                                                                                               |

## 5. 已知缺陷（台账链接）

| U                                | 状态 | 说明                                                                                                                                                                                                |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [U98](../defect-ledger.md#L100)  | 🟡   | 简易工作区订阅即抢尺寸：被动 attach + 显式 claim + overlay 已实现（`4b3e9365482`），无 owner 首开接管行为已 characterization（U112 D6，`737a3962428`）                                                 |
| [U112](../defect-ledger.md#L111) | 🟢   | 已实现：D1 end 关闭宿主 PTY/退役行、D2 pending→ended（`fee2402fb3a`）；D3–D8（`737a3962428`）                                                                                                                                                                       |
| [U113](../defect-ledger.md#L112) | 🟢   | D2 二次打开采纳触发已由 A-fix1（`530807b7a18`）修复；与本模块「重进不重装订阅」同源                                                                                                                  |
| [U104](../defect-ledger.md#L106) | 🟢   | 二次打开布局收养（Orca Web 面），嵌入面依赖同一宿主真源                                                                                                                                             |
| [U107](../defect-ledger.md#L108) | 🟢   | tabId/leafId 合同已对齐，双份风险已修                                                                                                                                                               |
| [U108](../defect-ledger.md#L114) | 🟢   | 新建 tab 镜像持久化 + close 语义（图代数围栏/镜像退役）已修                                                                                                                                         |
| [U96](../defect-ledger.md#L99)   | 🔴   | B 链总项；B-令1~8 多数落地，端到端验收未闭合                                                                                                                                                        |

**实现边界与残余项**：

- 显式 end 的宿主行退役（D1）与 pending→ended（D2）已实现（`fee2402fb3a`），由 E11 真栈（`cloud-simple-workspace-dual-client.e2e.test.ts`）与 `cloud-terminal-panel.test.tsx` 覆盖。
- D5 退避重连（`737a3962428`）与 D4 失败分类（按动作类型负缓存）已实现。
- U96 B 存储建议（宿主按 sub+project 持久化）未全面落地；当前以宿主 workspaceSession 真源为准。

## 6. 测试覆盖

| 类型      | 文件                                                                                                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 组件/状态 | `src/renderer/src/cloud/cloud-simple-workspace.test.tsx`、`cloud-simple-workspace-tabs.test.ts`、`cloud-simple-workspace-session-tabs.test.ts`、`cloud-simple-workspace-session-tabs-hook.test.tsx`、`cloud-simple-workspace-orphan-recovery.test.ts`、`cloud-simple-workspace-close-guard` 相关 |
| 终端      | `cloud-terminal-panel.test.tsx`（U98 被动 attach + overlay 四态）、`cloud-workspace-terminal-tab.test.tsx`                                                                                                                                                                                       |
| 嵌入协议  | `cloud-admin-embed.test.tsx`、`cloud-admin-embed-lifecycle.ts` 对应套件、`cloud-admin-entry.test.ts`                                                                                                                                                                                             |
| e2e       | `src/renderer/src/cloud-admin/cloud-simple-workspace.e2e.test.ts`、`cloud-simple-workspace-dual-client.e2e.test.ts`（U98 dual-client 尺寸）、`cloud-admin-session.e2e.test.ts`                                                                                                                   |
| 验收      | `test-reports/u96-b8.md`、`u111-audit-c.md`（D1/D2 首次 REJECT）                                                                                                                                                                                                                                 |

**未覆盖/薄弱**：D1/D2 由 `cloud-simple-workspace-dual-client.e2e.test.ts` E11 与 `cloud-terminal-panel.test.tsx` 覆盖；D4/D5 由 session-tabs hook/workspace 套件覆盖（`737a3962428`）。残余为旧宿主真机矩阵。
