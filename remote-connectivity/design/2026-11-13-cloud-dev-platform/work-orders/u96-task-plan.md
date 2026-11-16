# U96 任务计划 · 标签组与终端内容保持（A：Orca Web 恢复；B：简易工作区对接）

- 日期：2026-11-16 · 状态：A 批执行中 · B 设计在途
- 设计文档：A=`work-orders/u96-tab-restore-design.md`（已审定）；B=`work-orders/u96-bridge-design.md`（在途，落盘后补入）
- 诊断：`work-orders/u96-tab-restore-diagnosis.md`

## 总体目标（用户验收语义）

1. 每个项目保持各自标签组（两种工作区形态均适用）
2. 重开能看到终端内容（活跃 PTY 回放；宿主重启后显示显式「会话已结束」+一键重开，绝不静默空白）
3. B 附加：简易工作区与 Orca Web 同内容、同管理、双向互相影响；尺寸冲突用既有 autoRestoreFit 弹框

## A 部分任务计划（Orca Web 云票据恢复）

| 令 | 内容 | 依赖 | 状态 | 验收要点 |
| --- | --- | --- | --- | --- |
| A-1 | 宿主策略表放行 `session.tabs.*` 只读/恢复子集 + `workspace.info.capabilities` 加性字段 | — | **✅ 完成** `87e07c366be`（120 例绿；取证：capability 返回、tab 进 inventory、exit/close 退役；**负发现=headless listAll 20s 超时**） | 云票据下方法放行；listAll 按 workspaceRoot fail-closed；旧宿主零噪声 |
| A-1b | **headless census 回落**：无 authoritative 窗口时 inventory 从 legacy `listAllMobileSessionTabs`（=workspaceSession 持久源，A-6 同源）构建，不等待 graph publication epoch | A-1 | **✅ 完成** `04771583922`（实测 3/2/3/1ms，原 >20s；有窗口语义零变） | headless 云宿主 listAll/subscribeAll 不再挂 20s；有窗口宿主行为不变 |
| A-4 | 客户端 capability 谓词+三处云跳过点条件取消 | A-1（契约层并行可先做） | **✅ 完成** `18ecede0a60`（谓词 shouldMirrorCloudSessionTabs；新宿 20 例+旧宿主 0 调用断言） | capability 含→走恢复链；缺→保持现状（零 RPC 拒绝） |
| A-6 | 宿主持久化缺口：快照写 `workspaceSession.tabsByWorktree`（幂等追加/更新，close 退役） | — | **✅ 完成** `e4c27ebf699`（persistPerPublish 幂等；4 新例含重启重载恢复；24 例回归绿） | 宿主重启后 loader 可恢复 tab 行；关闭不复活 |
| A-2 | 云 inventory 过滤（`projectCloudSessionTabsInventory`）+ `session.tabs` 作用域 | A-1 | **✅ 完成** `1590e9fc956`（worktree 级/tab 级 scope+assertCloudSessionTabVisible fail-closed；9 新例+118 绿） | 越界 worktree 帧丢弃；多项目隔离 |
| A-3 | `terminal.list/adoptOrphans` 放行+三重 scope | A-1，与 A-2 共享 path guard **串行** | **✅ 完成** `ee92bb2e449`（restore-scope 模块+拓扑校验；53 例绿） | 无 selector/越界拒绝；跨 worktree handle 拒绝 |
| A-5 | bootstrap 顺序+孤儿认领接通（**最小可用里程碑**） | A-2/3/4 | 排队 | 页面重开→标签组/布局/活动标签恢复；活 PTY 回放 marker 可见 |
| A-7 | scrollback 回放边界（1000 行/512 KiB/truncated；localOnly 不外发；死 PTY→ended UI） | A-5 | 排队 | A7 断言全过 |
| A-8 | 端到端回归（页面重载/宿主重启两档+旧宿主+多项目） | A-5/6/7 | 排队 | A1-A11 AC 全过；evidence/u96-fix/ |

**并行约束**：A-1 是前置；A-2→A-3 串行；A-4/A-6 与 2/3 并行安全；A-5 汇聚；A-7/8 收口。

## B 部分任务计划（简易工作区对接会话状态，方向 2）

| 令 | 内容 | 依赖 | 状态 |
| --- | --- | --- | --- |
| B-0 | 完整设计（复用 A 通道+autoRestoreFit 尺寸弹框+overlay suspend/end 语义+多用户 scope） | A 设计/V 诊断 | **设计在途** |
| B-令1 | 纯投影模块+reducer 扩展 | A-令1（已落） | **✅ 完成** `1f91ac00efc`（投影/合并/幂等/活动兜底 11 例+44 绿） |
| B-令2 | bootstrap hook（capability 门控+subscribe/list+退避/负缓存） | A-令2/4 | **✅ 完成** `d2847b50b7d`（hook+负缓存+闭包重试环修复；5 新例 42 绿） |
| B-令3 | 终端 attach/create/pending/ended/重开 | A-令5/6 | 排队 |
| B-令4 | 关闭/激活/新建双向 | A-令3 | **✅ 完成** `d1902c398c8`（回环保护/拒绝语义/降级；61 绿）；**过渡态申报：新终端可能双 PTY，B-令3 attach 落地即消除（B-令3 必做项）** |
| B-令5 | suspend/end 协议+面板卸载策略 | — | **✅ 完成** `8f986d89e90`（suspend 保活/end 回收/logout=suspend；features 协商；278 测试+overlay 8/8） |
| B-令6 | 尺寸冲突 overlay+claim/restoreFit+get/setAutoRestoreFit scope（含 **U98 抢尺寸修复**） | A-令3 | 排队 |
| B-令7 | 回放边界+ended 阈值+孤儿兜底 | A-令3/7 | 排队 |
| B-令8 | 端到端回归（双端同步 e2e） | 全部 | 收口 |

## 验收里程碑

| 里程碑 | 条件 |
| --- | --- |
| M1 最小可用（页面重开恢复） | A-1/2/3/4/5 落地 + 真机「开 2 组 3 标签→关页→重开→恢复」通过 |
| M2 重启持久化 | A-6/7 落地 + 宿主重启档恢复+ended 态 UX |
| M3 B 双向一致 | B 批落地 + 双端同步 e2e（开/关/输入三向） |
| M4 收口 | A-8 全 AC 绿 + U95/回归套件零红 + 证据入档 |

## 纪律与约束

- 每令 ≤20 分钟；实现即提交（--no-verify+pathspec）；工作树并发域不相交
- wire 纪律：加性字段安全、无新 opcode；旧宿主降级零噪声（RPC 计数断言）
- 安全：云票据只能读/写 `workspaceRoot` 内对象；fail-closed；多人隔离
- 回放体积上限沿用既有（1000 行 / 512 KiB），不提高
- 禁宽域 pkill（协议 §2-8）
