# U153 设计令：cloud 自建 tab 的宿主选中语义（quick 子案）

> 2026-11-17 · P1（U138 残余子案）· 依据：`evidence/u153/`（事件级时间线）、`u138-residual-design.md`、`u138-active-tab-authority-matrix.md`
> 本文为设计+裁定；实现另派（先钉后修，§2-50）。

## 1. 已证事实（诊断，勿重复查）

1. 云端客户端「+ New tab」走**客户端自有创建**分支：本地 `createTab`+`setActiveTab` → `terminal.create`（paired viewer 被强制 `focus:false, presentation:'background', activate:true`）→ 宿主 `subscribeAll` 发布（active 仍是旧 tab）→ 唯一一次 `session.tabs.activate` 带 `materializeOnly:true, notifyClients:false, navigation:'caller'` → 宿主不移动（按设计只投影，不写选择）。
2. 客户端因此停在新 tab（本地乐观焦点），宿主永久落后；关闭时按本地组内 MRU 回退，不读宿主。
3. 应用路径不一致：per-worktree `subscribe` 经 `resolveHostActiveApplyOptions` 带 `hostActiveAuthoritative`；全局 `subscribeAll` 的 apply **不传 options**（`global-session-events.ts`），后者先落地且 per-worktree 帧被去重，故获胜帧永远无宿主权威。
4. H-B/H-D 均未证实；无 pending focus intent（创建前帧仍带权威）。

## 2. 裁定（T）

| 编号 | 内容 | 理由 |
| --- | --- | --- |
| T1 | **D1**：用户发起的云端自建 tab 完成（拿到宿主 tabId/leafId）后，补一次**用户 tap 语义**的 `session.tabs.activate`：`{tabId, leafId, notifyClients:false, navigation:'caller', intent:'user'}`，**不得带 `materializeOnly`**；同时 `recordWebSessionFocusIntent`。仅对**用户手势创建**生效，被动 mount/镜像 attach 保持 `materializeOnly`。 | 用户点「+」是意图；宿主必须持久化该选择。被动挂载仍不得移动全局 active（U138 九期语义）。 |
| T2 | **D2**：全局 `subscribeAll` 的 apply 与 per-worktree 对齐，经 `resolveHostActiveApplyOptions` 解析 `hostActiveAuthoritative`。 | 云端会话以宿主为准；否则权威无法自纠。 |
| T3 | **T1+T2 必须同批落地**（同一提交或紧邻提交+一次验证）。单独 T2 会在创建瞬间把用户打回旧 tab。 | D2 依赖 D1 先建立宿主选择。 |
| T4 | 多设备：T1 的 activate 是**paired** 语义，只写本设备选择；其它设备保持各自投影（权威矩阵 4/5）。 | 不改变多设备语义。 |
| T5 | 关闭回退：T1+T2 后按投影验证；若关闭落点仍与宿主投影不一致，客户端在关闭后按宿主投影补一次本地对齐（不发 activate）。 | 关闭不是第三个根因。 |

## 3. 开放问题（Q）与主会话裁定

| 编号 | 问题 | 裁定 |
| --- | --- | --- |
| Q1 | 用户手势创建「立即激活」是否与 Orca 桌面一致？ | 一致：桌面新建 tab 即激活；云端应对齐。 |
| Q2 | 被动 mount 是否可能复用同一创建函数而误带用户语义？ | 必须在调用点显式区分（`userInitiated` 标志），不得靠 `intent` 重载（§2-35）。 |
| Q3 | T2 后，其它设备的全局帧是否会把本设备视图拉走？ | 不会：per-device 选择优先（矩阵 4）；门禁须分别断言投影与内存。 |
| Q4 | 是否需要宿主侧改动？ | 不需要：`session-tabs.activate` 已有非 materialize 语义；纯客户端修复。 |

## 4. 实施拆分

| 令 | 内容 | 验收 |
| --- | --- | --- |
| P1 | **TDD 钉**（先红）：①用户创建 → 出站队列必须含非 `materializeOnly` 的 `session.tabs.activate` 且带 `recordWebSessionFocusIntent`；②全局 `subscribeAll` apply 的 options 必须含 `hostActiveAuthoritative`（cloud 会话）。 | 两用例当前红（`it.fails`），断言消息明确；相邻套件绿。 |
| P2 | **实现 T1+T2**（同批）。 | P1 钉转正；创建后宿主选择=新 tab（真栈验证）；被动 mount 不产生持久 activate（负控）。 |
| P3 | **关闭回退对齐**（T5）与真栈复验：quick 场景双采样转绿；race 保持 0 红。 | 硬化探针 quick 0 红；reload/reopen 不回归。 |

## 4.1 实施修订（2026-11-17 03:0x，U156 诊断）

- 首个实现（U153 P2/U154/U155）在**镜像换名竞态**下失效：mark 键为裸 uuid，镜像把 tab 改名 `web-terminal-<uuid>` 并销毁持有 `terminal.create` 的 transport；回包晚于换名即走 `destroyed/epoch` 提前返回，只 discard 不 select（实测 1/5）。
- 修法（U156）：提前返回分支中「成功创建且本次 connect 持有手势」先 `selectUserCreatedHostTab` 再 return；不改键/不改 wire。影响面=所有云会话手势自建 tab 路径。
- 手动重连语义（U157）：首败后用户 Reconnect 应**重新武装一次**手势（不是被动恢复）；补 transport 级重放钉与 discard 负控。

## 5. 风险

- T2 会扩大宿主权威面：须确认恢复修复（authority repair）与 reentry 不产生循环写；门禁覆盖 C1（无手势不改写）。
- 被动 mount 误带用户语义会导致镜像挂载抢活动标签（U138 七期回归）——P1 负控必测。

## 6. 主会话审定节

| 项 | 结论 | 审定人 | 日期 |
| --- | --- | --- | --- |
| T1–T5 / Q1–Q4 | 通过（Q2 的 `userInitiated` 显式标志为硬要求） | main | 2026-11-17 |
| 实施拆分 P1→P2→P3 | 通过（P1 先行，禁止合批实现） | main | 2026-11-17 |
