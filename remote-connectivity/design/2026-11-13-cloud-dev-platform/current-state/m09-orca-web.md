# M9 · Orca Web 工作区（现状基线）

> **基线提交**：`664a91e0322`（2026-11-16）。本机工作树另有未提交的 U112/U113 修令改动（`cloud-simple-workspace-end-close.ts`、`host-layout-adoption.ts` 等尚未跟踪），**不计入本基线**，相应条目标注「在途」。
> 代码入口：`src/renderer/src/web/`（页面壳/入口/续会话）、`src/renderer/src/runtime/web-session-tabs-sync/`（宿主标签镜像）、`src/main/cloud-platform/cloud-session-tabs-scope.ts`（宿主 scope）。
> 相关设计：`work-orders/w13-cloud-workspace-view-design.md`、`u96-tab-restore-design.md`、`u103-refresh-login-diagnosis.md`、`u106-routing-design.md`。

---

## 1. 页面/界面布局

Orca Web 复用**完整原生 App 外壳**（`web-root.tsx` 懒加载 `../App`），没有独立的云专属工作区布局；云能力是叠加在原生壳上的一层通道：

| 区域          | 内容                              | 云相关差异                                                                                                   |
| ------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 顶栏/登录入口 | 原生顶栏 + 云登录 chip            | 未登录或会话结束显示平台登录表单（`CloudLoginEntry`）                                                        |
| 左侧栏        | 原生 repo/worktree 列表           | 云项目以额外 repo 行注入（`ensureRepoRow`，路径钉在票据 `project.root`）；工作区激活后出现 worktree 与文件树 |
| 中央标签条    | 原生标签/标签组                   | 宿主镜像恢复后为终端标签组；云客户端自有布局（client-owned）优先于宿主 layout                                |
| 中央面板      | 终端 / 编辑器 / 浏览器等原生 pane | 终端 xterm 走云订阅流；编辑器/文件标签不随重开恢复（U100 裁定）                                              |
| 右侧栏        | Explorer（文件树）等              | **仅当票据含 `file:read` 才挂载**（`mountExplorer`，W13 §4.3），否则不发起注定被拒的文件 RPC                 |
| 状态/横幅     | 原生状态栏                        | 云入口失败/准备中横幅（`cloud-workspace-entry.tsx`）、连接诊断弹框                                           |

`CloudProjectWorkspace`（`src/renderer/src/cloud/cloud-project-workspace.tsx`）是桌面原生云入口的面板，不是 Orca Web 的布局；Orca Web 由 `App` 壳 + `web-cloud-workspace-bootstrap` 驱动。终端 chunk 懒加载失败时渲染 `cloud-terminal-chunk-failed` 降级块并可重试（W5a MIN-3）。

## 2. 菜单与入口

| 入口         | URL/触发                                           | 行为                                                                                                                   | 代码                                                   |
| ------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Handoff 免登 | `<web入口>?api=<平台>#handoff=<code>&project=<id>` | 读 hash → 立即从地址栏抹掉 code → 兑换会话 → 打开项目；入口通常是中继边缘 `https://<edge>/h/<routeKey>/web-index.html` | `web-cloud-handoff-entry.ts`、`web-root.tsx` 启动路由  |
| 直链/刷新    | `?api=<平台>&project=<id>`                         | 无 handoff 时按该地址恢复项目上下文；`?api=` 保留（非秘密）。**U166（`1b087074f5a`）**：表单登录成功后写 `orca.webCloudSession`（与 handoff 同键同结构），刷新静默续会话；失败/登出不写/清除 | `web-cloud-workspace-location.ts`（U106 W1）、`web-cloud-connect.ts` |
| 静默续会话   | 同上 + 本地持久 `orca.webCloudSession`             | access（30 min）/refresh（12 h）有效则自动刷新→重连→adopt，不显示登录页；仅 `SESSION_EXPIRED` 清会话，网络失败保留     | `web-cloud-session-resume.ts`、U103-B1                 |
| 平台登录表单 | 无有效会话/兑换失败                                | 云端登录/配对两种模式；`?api=` 预填、按 apiUrl 记忆 projectId、无权限项目被跳过、`NO_OPENABLE_PROJECTS` 空态           | `WebConnect.tsx`、`WebConnectCloudForm.tsx`（U103-B2） |
| handoff 失效 | code 已用/过期/无权限                              | `HANDOFF_GONE` / `PROJECT_FORBIDDEN` / `network_error` 对应文案，保留登录入口                                          | 同上                                                   |

权限门槛：页面启动只是登录/兑换；真正的工作区视图由 `workspace.info.perms` 决定——无 `terminal` 时 `terminalNotGranted` 只注册 repo 行不打开工作区；无 `file:read` 不挂 Explorer。

## 3. 启动与操作清单

### 3.1 Bootstrap（`web-cloud-workspace-bootstrap.ts`）

1. `workspace.info` → 解析 `project/workspace/perms/capabilities`；形状失败或宿主无该方法 → `fallback: failed/unavailable`。
2. 记录 capability（键=环境 id + pairing revision）；旧宿主无 `capabilities` 字段 = 不支持恢复，**零 `session.tabs.*` 探测**。
3. 等 `hydrationSettled`（≤30 s，超时继续，不阻断）。
4. `repo.add` 注册 `path:<project.root>` 行（web 首次打开时宿主尚无该行）。
5. 共享 ensure 流程：`project.provision` / `worktree.list` / `worktree.createManaged`（幂等键）。
6. `activateWorkspace({ worktreeId, executionHostId, mountExplorer: file:read })`；失败落 fallback（`unsupported-host` / `unavailable` / `failed`，仅 failed 可重试）。

### 3.2 标签组恢复（U96 A 链，现状）

| 环节            | 现状                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 能力协商        | `workspace.info.capabilities` 可选字段 `cloud.session-tabs-restore.v1`；`shouldMirrorCloudSessionTabs` 三处共用（global 订阅 / active 订阅 / 快照 eager refresh），pairing revision 不符即 fail-closed                                                                                                                                   |
| 宿主放行        | `session.tabs.list/listAll/subscribe/subscribeAll/activate/close/move` 归 `terminal` 权限；`createTerminal/setTabProps` 继续拒绝；`terminal.list/adoptOrphans` 云放行并做 worktree/handle scope                                                                                                                                          |
| 清单应用        | `applyWebSessionTabsSnapshot` 系列；`adoptHostLayout` 每次**进入工作区**收养一次宿主镜像组/active/layout，之后 client-owned（U104，`b50c241e699`）；进入动作触发已由 U113 A-fix1 在途补强                                                                                                                                                |
| 孤儿认领        | `recoverWebSessionTerminalOrphansBeforeApply` → `terminal.list` + `terminal.adoptOrphans`（按 worktree/handle 限界）                                                                                                                                                                                                                     |
| 新建终端        | 客户端生成 `terminal-<uuid>` tabId + 裸 UUID leafId（U107），`terminal.create` 后由宿主发布/持久化；关闭经 `session.tabs.close`（U108 图代数围栏与镜像退役已修）。**U153 P2（`9171a3332f9`）**：用户手势创建在 create 返回宿主持久 id 后补一次**非 `materializeOnly`** 的 `session.tabs.activate`（tap 语义）+ `recordWebSessionFocusIntent`；被动 mount/镜像 attach 仍 `materializeOnly`。其余手势入口（文件树/split/shell）由 U154 补齐。 |
| 多组            | 2 组恢复已真机验证（journey-8 控制台线 13/13 含 3 tabs/2 groups、B7 三次重开零互换；U99 move 超时已修）                                                                                                                                                                                                                                  |
| 活动标签权威    | **U138（残余修复中）**：`3b241e585d3` 修 headless 宿主持久化判据后，快速开合/竞争窗口仍偶发「选中标签差一周期」（内容/分组每次正确）。Race 探针复现 7/50→硬化探针归因 **H-A**（获胜 apply 帧未带 `hostActiveAuthoritative`；延迟 listAll 回滚 active）。v2 `22ce17c5d71` 改 **worktree 级陈旧拒绝**（晚到 listAll 对已收更新流帧的 worktree 整条不应用），race 10-cycle **50/50 绿**、独立审计 PASS。残余拆 **U153**（快速新建/关闭）：D1 用户创建从不让宿主选中（paired `terminal.create` background + 仅 `materializeOnly` mount）、D2 全局 `subscribeAll` apply 无 `hostActiveAuthoritative`；修复前可签字基线 quick **0/10 绿**（`client-ahead-host`×5 / `host-frame-not-won`×5），修法见 `work-orders/u153-quick-tab-authority-design.md`。 |
| 恢复的「初始活动标签」 | **U162（`e501edca0c3`）**：caller paired activation 只写宿主持久、不更新 renderer-owned snapshot；**新配对设备（无持久选择）现回退到宿主持久 active**（leaf→parent→browser，必须命中快照；只读、revision 0、`shouldPersist:false`，不写 snapshot/epoch）。e2e 9/9（`evidence/u162-e2e/v3-…json`）。 |
| 布局变更镜像 | **U163/U169**：`session.tabs.move` 不再假成功（未发布→headless 落盘、ack false→回退、目标校验）；客户端本地 split 组经成员映射解析为宿主组，跨组拖拽/组内 reorder 落盘（U169，真机验证）。P3（2026-11-17 09:2x 复核）：①组 id 未水合瞬态=诚实失败+toast，**U169-L3 仍成立**（宿主持久回显前的窄窗口，设计内行为，不开新号）；②桌面 renderer 无宿主→renderer 布局应用通道——已裁定**收窄为「获焦/可见/重连时单次 `session.tabs.list` 布局补齐」**（v2 设计评审中），连续帧应用车道暂缓（P3） |
| 文件/编辑器标签 | **不恢复**（U100 用户裁定方案 a）：仅终端标签+分组+内容；文档需注明                                                                                                                                                                                                                                                                      |

### 3.3 终端内容回放与 ended 态

- 回放复用宿主订阅初始快照：`MOBILE_SNAPSHOT_BYTE_BUDGET` 512 KiB、`MOBILE_SUBSCRIBE_SCROLLBACK_ROWS` 1000 行；客户端可请求上限 2 MiB；超限带 `truncated`；**不提高任何上限**。
- `localOnlyScrollbackByTabId` 永不离开宿主。
- PTY 已死/宿主重启：显式「会话已结束（宿主已重启或终端已退出）」+ 同标签一键重开 PTY（`cloud-terminal-replay-boundary.tsx`，A2）；不显示空白假活。
- 订阅断流当前有重连状态文案；退避重连缺口见 U112 D5（简易工作区审计连带）。

### 3.4 刷新 / 二次打开行为

1. **刷新**：`web-root` 启动路由先抹 handoff；若存在持久云登录且 URL 带 `?api=` → `resumeWebCloudSession`（B1），否则登录页（`?api=` 预填、projectId 记忆）。
2. **同一项目第 2/N 次打开**：`adoptHostLayout` 一次性收养宿主布局（U104 已修，`b50c241e699`）；客户端已有本地组后宿主 layout 不再覆盖（`apply-preparation-groups.ts`）。
3. **刷新后真栈复跑**：U113 D1/D6 明确指出 release-2 仅 1 标签且 u103 证据为修复前，**待 v2 发布后真机 2 组 3 标签×关页/刷新/二开×3 复验**。

## 4. 数据来源

| 面       | API/事件                                                                                            | 说明                                 |
| -------- | --------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 平台     | `POST /v1/auth/login`、`/v1/auth/refresh`、`POST /v1/web/handoff`、`POST /v1/projects/{id}/connect` | handoff 一次性码；connect 发云票据   |
| 平台     | `GET /v1/projects`、`/v1/hosts/available`                                                           | 项目可见性/主机选择                  |
| 宿主 RPC | `workspace.info`、`repo.add`、`project.provision`、`worktree.list/createManaged`、`status.get`      | bootstrap                            |
| 宿主 RPC | `session.tabs.*`、`terminal.list/adoptOrphans`、`terminal.create/close/subscribe`                   | 标签恢复、孤儿、终端流               |
| 存储     | 浏览器 localStorage `orca.webCloudSession`（access/refresh，按 apiUrl 隔离）、device key            | 静默续会话/设备绑定                  |
| 内存     | `web-cloud-session-capabilities`（键=environmentId+revision）                                       | 页面生命周期内能力缓存，换页重新探测 |

## 5. 已知缺陷（台账链接）

| U                                | 状态 | 与本模块关系                                                                                   |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| [U96](../defect-ledger.md#L99)   | 🟢   | 标签组/终端恢复已闭环（U99/U104/U107/U108；U113 真机 9/9）                                      |
| [U103](../defect-ledger.md#L105) | 🟢   | 刷新停留旧登录页已修（B1 静默续会话 + B2 预填），真栈 reload 复验通过                           |
| [U104](../defect-ledger.md#L106) | 🟢   | 二次打开不恢复：`adoptHostLayout` 每次进入收养，已修                                           |
| [U106](../defect-ledger.md#L107) | 🟢   | 全站 URL 路由 R1–R6 + W1–W3 已落地；标签级深链按设计不承诺                                     |
| [U113](../defect-ledger.md#L112) | 🟢   | 审计 A 批闭环：A-fix1/时序钉/stale capability 已落；真机矩阵 9/9（`evidence/u113-retest/`）    |
| [U100](../defect-ledger.md#L104) | ⚪   | 文件/编辑器标签不随重开恢复（用户裁定接受，需在验收文案注明）                                  |
| [U109](../defect-ledger.md#L109) | 🟢   | 编译产物遮蔽源文件已清；web 域已删，components 域遗留                                          |

**尚未实现的设计项**（现状 vs 设计）：

- 标签级唯一 URL：按设计不承诺（现状=项目级 `?api=&project=`；U106 W1–W3 已落地）。
- 旧宿主降级 A11「零拒绝探测」已实现，但真机旧版本矩阵未常设。
- 文件/编辑器标签恢复明确不做（U100），验收文档必须声明，避免按 A1 字面误判。

## 6. 测试覆盖

| 类型           | 文件                                                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 黄金旅程       | `tests/e2e/cloud-golden-journey-orca-web.spec.ts`、`tests/e2e/cloud-golden-journey-git-and-restart.spec.ts`（reload 后路径一致/已连接/零 login-handoff/终端重连，U91）、`tests/e2e/cloud-web-workspace-view-negatives.spec.ts`                              |
| 入口/续会话    | `src/renderer/src/web/web-cloud-handoff-entry.e2e.test.ts`、`web-cloud-session-renewal.e2e.test.ts`、`web-cloud-session-resume.test.ts`、`web-session-recovery.test.tsx`、`web-cloud-workspace-location.test.ts`（U106 W1）                                 |
| Bootstrap/能力 | `web-cloud-workspace-bootstrap.test.ts`、`web-cloud-session-capabilities.test.ts`、`web-cloud-workspace-store-ports.test.ts`                                                                                                                                |
| 标签镜像/收养  | `src/renderer/src/runtime/web-session-tabs-sync/*.test.ts`（含 `reentry-adoption-trigger.test.ts` **在途未跟踪**、`load-initial-cloud-orphan-recovery.test.ts`、`cloud-capability-gate.test.ts`）、`web-session-tabs-reentry-host-adoption.test.ts`（U104） |
| 孤儿/终端      | `src/renderer/src/runtime/web-session-terminal-orphan-*.test.ts`、`src/renderer/src/cloud/cloud-terminal-panel.test.tsx`、`cloud-terminal-replay-boundary.test.tsx`                                                                                         |
| 宿主 scope     | `src/main/cloud-platform/cloud-session-tabs-scope.test.ts`、`cloud-terminal-scope.test.ts`、`cloud-session-tabs-inventory` 相关套件                                                                                                                         |
| 验收报告       | `test-reports/u96-a8.md`、`u96-b8.md`、`u111-audit-a.md`、`u111-audit-c.md`                                                                                                                                                                                 |

**未覆盖/薄弱**：真机刷新与二次打开（U113 D1/A-retest）、2 组恢复、旧宿主 capability 降级真机矩阵、标签级 URL。
