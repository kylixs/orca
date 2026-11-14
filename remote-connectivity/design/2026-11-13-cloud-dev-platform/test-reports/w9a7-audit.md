# W9A-7 审计报告（工作区边界绑定的终端 multiplex 云准入）

- 审计人：独立审计代理（只读；未修改任何被审文件，本报告为唯一产出文件）
- 日期：2026-11-14
- 审计对象：`9f983c595d1`（feat(cloud): workspace-bound terminal multiplex for cloud sessions，15 文件 +739/−37）；现行 HEAD（`e58b2bf9065`）与被审提交之间这 15 个文件**逐字节一致**（`git diff 9f983c595d1 HEAD -- <15 路径>` 为空，工作树亦无这些路径的未提交改动），全部行号引用即提交态
- 对照基准：work-orders 派令（W9A-6 节派发记录 + PROGRESS.md 2652/2656 两节交付声明）、requirements.md FR-3.9（实时终端「受 `terminal` 授权约束，与开发者终端同权」）、design.md §7.3（权限模型/默认拒绝/写边界=workspaceRoot）与 §8.3 第 4 步（符号链接解析后判定）、§9（终端命令=允许并审计）、W5b 先例（`cloudMethodAccess` 生产表默认拒绝完整性、MAJ-1 门禁归属、MAJ-2 安全路径与测试分提交、缺陷 B1 real-PTY 套件须入 node 池）、AGENTS.md
- 方法：只读 diff 审查 + 现行源码逐行核对（全部 8 个 client→host opcode 的 handler、二进制帧路由 `RuntimeBinaryMessageRouter`、`streams.set` 全仓唯一写入点、`resolveLiveLeafForHandle`/`resolveTerminalContext`/`resolveLeafForHandle` 三条 handle→PTY 解析路径、云准入单点 `runtime-rpc-websocket-dispatch`、审计分类链 `cloud-denial-details`→`onCloudDenial`→`cloudAuditSink`）；本机实跑 12 个套件（见 §3）+ 新真栈套件双 runner 对照 + oxlint（15 文件 0 告警）+ max-lines ratchet（"no new bypasses"，exit 0）；证据交叉印证 `cloud-platform/evidence/w9a7-multiplex/`（gates.log、真栈双例 JSON、旅程 timeline A2–A6 全 ok）

## 结论

**有条件通过（安全核心成立：信封/帧分离的边界落点选对了唯一点，越界=流错误+零快照+path_denied 审计，容量后置判定正确；1 条 major 是新真栈套件未入 node 池——默认 `pnpm test` 下该文件红、两条真栈断言不可达，W5b 缺陷 B1 同型复发）**：blocker 0、major 1、minor 5、note 12。

核心判定：**边界落在宿主把句柄解析为活 PTY 的唯一点，且与一元方法共用同一判定函数**。全仓 `streams.set`（PTY 绑定写入）只有 `initializeMultiplexStream` 一处，唯一调用链是 `handleSubscribeFrame`→`resolveMultiplexSubscribePty`→`finalizeResolvedMultiplexPty`（同步 leaf 与 10s 等待两条路径都收口于此）→`state.checkStreamTarget`→`checkCloudTerminalHandleScope`——与 `cloud-path-guard.checkCloudTerminal` 同一函数（该文件只是抽出复用，逐字等价迁移），不是第二套边界。其余 8 个 slot opcode（Unsubscribe/Ack/Input/SetOutputPaused/Resize/ClaimViewport/SnapshotRequest）只寻址已绑定流的 `stream.ptyId`，Resize/ClaimViewport 自身不向客户端回送任何帧——交付声明「无任何帧能改绑 PTY」逐 handler 核实成立。真栈双例（平台+TLS+真 PTY+真二进制帧）与旅程 A4（`remote:` 句柄 + `hasPty` 如实 null + 标记回显 ≥2 次经 multiplex 流，364ms/回显 168ms）实证放行与拒绝两侧都真实可达。

---

## 1. 安全（核心）

### 确认的正确面

| 项 | 证据 |
| --- | --- |
| ① 唯一解析点全覆盖 | `resolveMultiplexSubscribePty` 全仓唯一调用点 `terminal-multiplex-subscribe-frame.ts:18`；`finalizeResolvedMultiplexPty` 两处调用（:74 同步 leaf、:115 等待后）都在 `state.checkStreamTarget` 闸门（subscribe-resolution.ts:28-39）之内；`checkStreamTarget` 只在 `terminal-multiplex-method.ts:51` 且仅当 `cloud` 上下文存在时构造。云会话到 PTY 的每条入口（活句柄/挂起句柄/无 client 句柄）都先过边界再产生绑定 |
| ① 云准入单点 | `device.cloudSession` 只在 `runtime-rpc-websocket-dispatch.ts:88` 解析；`cloud:` 上下文只在 :244 注入。桌面 IPC 派发（`src/main/ipc/runtime.ts:110`）不传 cloud → 检查器不安装。无第二派发路径能带云上下文进入 multiplex |
| ② 越界后生命周期 | 拒绝路径：`sendStreamError(streamId,'terminal_workspace_scope')` + `emit({type:'end'})`（subscribe-resolution.ts:33-35）；流未入 `streams`、未注册 slot handler、未 `subscribeToTerminalData`、未 `registerRemoteTerminalViewSubscriber`（这些都在边界之后的 `initializeMultiplexStream`）。挂起路径的 pending handler 在 `finally` 里先于判定注销（subscribe-resolution.ts:107-114）——拒绝后该 streamId 的任何后续帧被路由器静默丢弃（`RuntimeBinaryMessageRouter.dispatch` 只投已注册 streamId）。socket 与信封按设计存活（逐流拒绝，不殃及同连接其它流），无继续收发窗口 |
| ③ 审计分类 | 帧级拒绝全部 `pathDenialDetails(reason)` = `PATH_OUTSIDE_ROOT`（`workspace_scope` 与 `terminal_unknown` 都归此类，reason 字段保留区分）→ dispatch `onCloudDenial`（websocket-dispatch.ts:232-241）按 `PATH_OUTSIDE_ROOT → path_denied`；权限类拒绝只发生在信封（`denyRpcMethodForCaller` → `PERMISSION_MISSING`）→ `method_denied`。真栈例 W9A7-2 断言了 `{eventType:'path_denied', denial:'PATH_OUTSIDE_ROOT'}` 并存证 `w9a7-2-cross-workspace-denied.json`。零快照泄漏：代码序（快照发布在 finalize 返回 ptyId 之后）+ W9A7-2 显式断言无 `SnapshotStart` |
| ④ 容量后置判定 | 边界先于 `admitIfCapacityAllows`（active-stream 128 上限）——越界探测不占流槽，判定顺序正确；非云路径（无检查器）直接进容量判定，保持原同步序 |
| 信封权限未被削弱 | `cloudTerminalScopeOf('terminal.multiplex')={kind:'multiplex'}` 使 path guard 放行**信封**，但信封仍被 `cloudAccess==='terminal'`（`terminal.` 前缀表，cloud-rpc-permission.ts:17，本提交未动该文件）门槛：无 `terminal` 权限的会话 `pathChecked=false` → 落入 `denyRpcMethodForCaller` → `forbidden`+PERMISSION_MISSING+method_denied 审计。W5b `cloudMethodAccess` 生产表先例保持：默认拒绝分支、表内容零改动，生产表由 `cloud-rpc-permission.test.ts` 与 `cloud-terminal-scope.test.ts` 钉住 |
| 写边界语义 | 判定 = `checkCloudTargetScope(roots,'write', worktreePath)`：写根=workspaceRoot、`resolveRealPath` 符号链接解析（cloud-path-boundary.ts），与 design §7.3/§8.3-4 一致；队友 checkout（读可达、写不可驱）被真栈例实证（宿主共享检出区的 shell） |
| 线兼容 | 零新增 opcode、零帧格式变化、`TerminalMultiplex=z.object({})` 未动；变化只在宿主准入与逐订阅判定，配对桌面/真手机路径逐字节未动（mobile 套件复跑绿） |

### 发现

**MAJ-1（major）新真栈套件未注册 node 池：默认 runner 下套件红、两条真栈断言永不可达——W5b 缺陷 B1 同型复发**

- `cloud-terminal-multiplex-scope.test.ts` 驱动真平台+自签 TLS runtime+真 PTY 回显，与 W5b 缺陷 A/B 完全同型（bun ws 过不了自签证书握手、bun worker 饿死 node-pty）。W5b 的修法是把 `cloud-entry-session-slots.test.ts` 加进 `config/scripts/vitest-node-runtime-files.mjs` 的 `NODE_RUNTIME_INCLUDE` 并留注释说明原因；本提交新增的同型套件**未**入该清单，文件头也无 runner 声明。
- 本机实证（同一工作树）：`pnpm test` 默认 runner（bun）→ **FAIL**（beforeAll `OPEN_FAILED`，`TLS handshake failed`，2 tests skipped，另抛 unhandled ErrorEvent）；`node node_modules/vitest/vitest.mjs`（node fork 池）→ **2/2 绿**（4.5s）。即默认门禁 `pnpm test`（run-vitest.mjs 固定 bun）下：全量跑永远带一个红文件，且**本提交安全语义的唯一端到端证明（真栈放行+拒绝+审计）在默认 runner 从不执行**。
- 交付注记称「bun 池下云真栈套件的自签 TLS 握手失败为既有环境项（W5b 缺陷 A 同源，与本改动无关）」——对该文件不成立：文件是本提交新增的，红是新引入的。gates.log 只记录了 node 池 117 文件跑，掩盖了这一点。
- 一行收口：把该文件加进 `NODE_RUNTIME_INCLUDE`（照抄 `cloud-entry-session-slots.test.ts` 条目的注释样式）；补验 `pnpm test` 全量无红。MAJ-1 修复后本审计可转无条件通过。

**MIN-1（minor）安全路径变更与测试/旅程 spec 混在同一 `feat(cloud)` 提交，违背 W5b MAJ-2 强化规则**

- PROGRESS 记档规则：「安全路径变更与测试变更必须分提交且提交前 `git show --stat` 核对类型归属」。本提交把宿主准入放行+逐订阅边界（cloud-path-guard/cloud-terminal-scope/websocket-dispatch/multiplex method+resolution）与 4 个测试文件、e2e 旅程 spec、e2e harness 合为单提交。缓解：提交类型诚实（feat 而非 docs/test）、`--stat` 与消息一致、无历史重写需求，故较 W5b MAJ-2 降级为 minor。

**MIN-2（minor）边界 promise 无 rejection 处理：未来一次抛错的 `resolveTerminalContext` 会变成宿主未处理 rejection，客户端零回音**

- `state.checkStreamTarget(request.terminal).then(...)`（subscribe-resolution.ts:31）无 `.catch`，向上经 `handleSubscribeFrame` 的 `await` 传到 `void state.handleSubscribeFrame(...)`（terminal-multiplex-method.ts:79）。当前生产实现不抛（`resolveLeafForHandle` 未知句柄返 null 不抛；`resolveWorktreeRootPath` 异常已在 `cloud-terminal-handle-scope.ts` try/catch 收口），但这是一元路径没有的暴露：一元 guard 的异常由 dispatcher 捕获转 `forbidden` 回包，multiplex 同源异常则是静默挂死（无流错误、无审计、socket 存活）。建议补一个把 rejection 折叠为 `sendStreamError('terminal_handle_stale')`+end 的收口。

**MIN-3（minor）「越界不消耗配额」只对 active-stream 配额成立；挂起路径在边界**前**消耗 PTY-wait 配额并触发宿主渲染端挂载请求**

- 挂起路径先判 `pendingPtyWaitControllers.size >= 32` 并 `runtime.requestRendererTerminalTabMount(request.terminal)`（subscribe-resolution.ts:76-83），之后才到边界。云会话对越界且尚无 PTY 的句柄探测会让宿主渲染端尝试挂载任意句柄的标签页（每连接 ≤32 个在途、各至多 10s）。可利用性趋近于零（句柄为 `term_<uuid>` 不可枚举、`terminal.list` 对云拒绝、挂载不激活 worktree、结果不回流云客户端），纯卫生问题；提交消息与 PROGRESS 的「越界探测不耗配额」宜限定为「不占流槽」。

**MIN-4（minor）multiplex 边界未做句柄归一化，与一元边界「同一函数、不同输入规整」**

- 一元 guard 先过 `cloudTerminalHandleOf(handle)` 剥 `:clientId` 后缀（cloud-path-guard.ts:342）；multiplex 把 `request.terminal` 原样传给 `checkCloudTerminalHandleScope`。今天 fail-closed（带后缀句柄 `resolveLiveLeafForHandle` 查不到 → 挂起等待 → `no_connected_pty`，不会误放行），但两条路径对同一地址形态行为不同，若订阅 schema 将来接受 `handle:client` 形态，会变成「拒而不查」。建议在边界入口同样过一次 `cloudTerminalHandleOf`。

**MIN-5（minor）W9A7-2 的泄漏断言只盖 `SnapshotStart`，审计断言不钉 `reason` 与「无意外同级事件」**

- 断言集：`end` 事件、Error 帧文本===常量、无 `SnapshotStart`、存在 `path_denied/PATH_OUTSIDE_ROOT`。未断言无 `Output`/`Metadata` 帧（当前结构上不可能——流未订阅，但断言面若加一行更稳）；审计断言用 `.find(method==='terminal.multiplex')`，不校验 `reason:'workspace_scope'` 也不拒绝同窗口内的意外审计行。低成本可收紧。

## 2. 帧面完备性（交付声明复核）

「其余帧只寻址 streamId、无任何帧能改绑 PTY」——**逐 opcode 核实成立**：

- client→host 全集 8 个：Input(7)/Resize(8)/Unsubscribe(10)/SnapshotRequest(11)/Ack(13)/ClaimViewport(14)/SetOutputPaused(16) 走 `handleSlotFrame`（仅对 `streams` 里已注册流触发，terminal-multiplex-slot-frames.ts:56-148），Subscribe(9) 走 stream-0 控制 handler（terminal-multiplex-method.ts:77-81，只认 Subscribe）。其余 opcode（Output/Snapshot*/Resized/Error/Metadata/OutputSpan/WriteUnavailable/InputAck）均为 host→client。
- `streams.set` 全仓唯一写入点 = `initializeMultiplexStream`（stream-initialization.ts:98），其 `ptyId` 参数只来自 `finalizeResolvedMultiplexPty` 的已判定返回值；`stream.terminal` 记录的是已判定句柄。
- slot handler 内零 `resolveLiveLeafForHandle`/`waitForLeafPtyId` 调用：Input 经 `sendTerminalStreamInput(runtime,{terminal: stream.terminal,...})` 用绑定句柄，Resize→`updateViewportForClient(stream.ptyId,…)`，ClaimViewport→`updateRemoteDesktopViewer(stream.ptyId,…)`，SnapshotRequest→`sendRequestedSnapshot(stream.ptyId,…)`。
- **Resize/ClaimViewport 不泄露**：两个 handler 都不向客户端发送任何帧——`updateViewportForClient`/`updateRemoteDesktopViewer` 的返回值只进 `desktopClaimTail` 链用于输入门控；`Resized` 回帧（cols/rows/displayMode/reason）只在流已绑定的自身 PTY 尺寸事件上发出（live-stream 订阅），快照同理只描述调用方自己的 PTY。未发现跨用户状态回读通道。
- 路由兜底：未注册 streamId 的帧与 stream-0 上的非 Subscribe 帧一律静默丢弃（runtime-binary-message-router.ts:57-70）。
- note-7：订阅帧内层 `streamId:0` 会以 map 键 (connectionId,0) 覆盖控制 handler（自我 DoS，边界仍生效）——既有行为，非本提交引入。

## 3. 零回归（非云上下文）

- **不安装检查器**：`checkStreamTarget: cloud ? … : undefined`（terminal-multiplex-method.ts:51）；`cloud` 仅在 websocket dispatch 且 `device.cloudSession` 存在时注入；桌面 IPC 派发不传；mobile/配对桌面 scope 均不产生 cloudSession。
- **同步返回**：无检查器时 `finalizeResolvedMultiplexPty` 直接 `return admitIfCapacityAllows(...)`，`handleSubscribeFrame` 对非 thenable 不加 `await`（subscribe-frame.ts:19-20）——订阅→容量判定零新增微任务，交错语义保持。
- **实跑（本机，全部绿）**：`cloud-terminal-multiplex-boundary`+`cloud-terminal-scope`+`terminal-multiplex-pty-wait-capacity`+`cloud-rpc-permission` 4 文件 39 例；multiplex 家族 6 文件 31 例（slot-recovery/desktop-resize-routing/input-sequence-replay/end-verdict/daemon-attach/exit-waiter-leak）；`rpc-caller-scope`+ack 两套 3 文件 43 例；`runtime-rpc-mobile-terminal-streaming` 5/5、mobile allowlist 2 文件 4/4（bun 与 node 两 runner 各跑一遍均绿）。交付注记的「node 池该套件 2 例红=既有」本次未能复现（单跑 5/5），更可能是 117 文件并行池的资源性抖动；stash 归因当时已由交付方自证，不计发现。
- **新真栈套件双 runner 对照**：node 2/2 绿、bun 红（见 MAJ-1）。

## 4. 规范

- **max-lines**：ratchet 实跑 OK（7 处既有豁免、无新 bypass）；diff 无任何 `eslint/oxlint-disable`，新增最大文件 396 行（测试）。oxlint 15 文件 0 告警（实跑 exit 0）。
- **命名**：`cloud-terminal-handle-scope.ts`（一元+multiplex 共用的句柄→worktree 写边界判定）与 `cloud-terminal-multiplex-boundary.ts`（订阅帧边界+错误码+审计上报）——具体域概念命名，无 helpers/utils；测试同名 `.test.ts`。符合「复用优先」：一元路径改为调用共享函数（逐字等价迁移，消息文案未变），不是第二套边界。
- **注释**：均为 WHY 型且简短（信封不带地址所以逐订阅、审计在帧不在 dispatcher 的原因、边界先于容量的原因、ws isBinary 判别原因），符合仓库惯例；无 max-lines 豁免、无新增类型断言（`as TerminalMultiplexConnection` 为既有 SAFETY 注释行，本提交未触碰）。
- **diff 归属（15 文件逐一，`git show --stat` 与提交消息一致）**：

| 文件 | 角色 |
| --- | --- |
| `src/main/cloud-platform/cloud-path-guard.ts` | 安全路径：multiplex 信封放行分支 + `checkCloudTerminal` 抽取为共享调用 |
| `src/main/cloud-platform/cloud-terminal-scope.ts` | 安全路径：`multiplex` scope 类 + `CLOUD_TERMINAL_MULTIPLEX_METHODS` 表 + `terminal.multiplex` 移出 DENIED |
| `src/main/cloud-platform/cloud-terminal-handle-scope.ts` | 新增：一元/multiplex 共用句柄边界（安全核心） |
| `src/main/cloud-platform/cloud-terminal-multiplex-boundary.ts` | 新增：订阅帧边界 + `terminal_workspace_scope` + 审计上报 |
| `src/main/cloud-platform/cloud-terminal-multiplex-boundary.test.ts` | 新增：边界判定单测（5 例） |
| `src/main/cloud-platform/cloud-terminal-multiplex-scope.test.ts` | 新增：真栈双例（**MAJ-1 所在**） |
| `src/main/cloud-platform/cloud-terminal-scope.test.ts` | 测试：分类互斥 + 信封放行断言 |
| `src/main/cloud-platform/cloud-session-e2e-harness.ts` | 测试设施：加密二进制帧收发（isBinary 判别） |
| `src/main/runtime/rpc/core.ts` | 管道：`RpcContext.onCloudDenial` 类型 |
| `src/main/runtime/rpc/dispatcher-stream-options.ts` | 管道：透传 `onCloudDenial` |
| `src/main/runtime/rpc/methods/terminal/terminal-multiplex-connection.ts` | 管道：`checkStreamTarget` 字段与类型 |
| `src/main/runtime/rpc/methods/terminal/terminal-multiplex-method.ts` | 安全装配：仅云会话构造边界 |
| `src/main/runtime/rpc/methods/terminal/terminal-multiplex-subscribe-resolution.ts` | 安全落点：边界先于容量、拒绝收口 |
| `src/main/runtime/runtime-rpc/runtime-rpc-websocket-dispatch.ts` | 管道：审计分类（path_denied/method_denied）+ onCloudDenial 注入 |
| `tests/e2e/cloud-golden-journey-desktop.spec.ts` | 旅程断言：A4 改远端语义 |

- note-10：`tests/` 至今不在 typecheck 链（`config/tsconfig.e2e.json` 头注释自述 NOT ENFORCED），旅程 spec 的 TS 不被门禁覆盖——既有状态，非本提交引入。

## 5. 测试质量（可变红性）

- **越界负向（W9A7-2）真可红**：目标是宿主共享检出区真实 shell（`service.createTerminal('path:<projectRoot>')` 产出的真实句柄，非字符串拼造）。若删边界（变异：`checkStreamTarget=undefined`）→ 订阅会成功发布快照，`无 SnapshotStart` 断言红、Error 文本断言红、`end` 等待超时红——三重独立失败；若边界拒绝一切 → W9A7-1 的快照/回显等待超时红。两侧互为杀伤。
- **旅程断言实质**：A4 读真实 pane DOM（`helpers/terminal.ts:73` 起 `dataset.ptyId`），`toMatch(/^remote:/)` + `pty.hasPty` 如实 null（`probePtyLiveness` 契约「false 仅当宿主确认不存在」，不可验证=null）+ RUN_MARKER 在回显与输出中出现 ≥2 次且 `ls` 列出种子文件——回显只能经 multiplex 流到达，旧 `hasPty===true` 断言对任何远端工作区结构性不可满足的归因与契约一致；并更正了 W9A-5 的错误归因（PROGRESS 2664/2666 补注）。
- **生产方法表保留断言可红**：`cloud-terminal-scope.test.ts` 断言的是生产 `cloudTerminalScopeOf`/`checkCloudRpcPath`（非测试本地表）：把 `terminal.multiplex` 从 multiplex 表移除会落入 fail-closed `terminal.*` 拒绝分支 → 信封放行测试与分类互斥测试双红；`cloud-rpc-permission.test.ts` 钉生产 `cloudMethodAccess` 默认拒绝族。交付所称「production 方法表断言原样保留全绿」核实成立。
- note-8：无显式测试钉「非云解析路径同步返回」（现靠交错敏感套件间接覆盖）；note-9：W9A7-2 无 RED/stash 复验记录（交付亦未声称），可红性由本审计代码级推演确认。

## 附：其余 note

1. 信封无条件放行仅指 path guard 层；`terminal` 权限门槛与默认拒绝表完全不变（§1 表内已证）。
2. TOCTOU：ptyId 在解析时（T0）捕获，判定查句柄归属在 T1（一次 await 之隔）；期间宿主本地 handle→pane 重绑可造成「按 T1 判定、绑 T0 PTY」。与一元路径（guard T1、handler 再解析 T2）同型，非攻击者可控，记档不改。
3. 时序侧信道：活越界句柄立即 `terminal_workspace_scope`，未知/挂起句柄 10s 后 `no_connected_pty`——可区分「句柄是否有活 PTY」。句柄为随机 UUID 不可枚举，且一元方法本就同型（拒绝理由不同），非本提交新增。
4. 审计记录带 deviceId/subject/projectId（dispatch onCloudDenial 闭包），与信封级拒绝同构，平台可在下次心跳聚合。
5. 内层 streamId 0 覆盖控制 handler：既有自伤面，边界不受影响（见 §2 末）。
6. `e2e harness` 的二进制帧路径复刻 e2ee 通道字节路径并按 `isBinary` 判别（非 Buffer 探嗅），与生产 ws 语义一致。
7. 旅程证据链完整：timeline 六步全 ok（A4 ptyId=`remote:cloud-…@@term_…`、outputMs=168）、双例 JSON、gates.log（tc:node/tc:web/oxlint/ratchet exit 0 + 提交后复跑 4 文件 29 例绿）。
