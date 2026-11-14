# W5a 审计报告（详情页终端组件 + 订阅桥接）

- 审计人：独立审计代理（只读，未修改任何仓库文件；本报告为唯一产出文件）
- 日期：2026-11-14
- 审计对象：`7058a99dd1c`（feat(cloud): terminal panel in admin workspace，5 文件 +950/-8）与 `b0665d848a7`（feat(cloud): terminal subscription bridge for the admin workspace，5 文件 +79/-1）；两提交均无后续改动，现行工作区即被审代码
- 对照基准：work-orders-2026-11-14.md §W5 / 附录「W5 设计要点」/ §W5a、requirements.md FR-3.9、design.md §7.3（权限表）与终端作用域、AGENTS.md（复用优先 / 注释风格 / 命名 / 禁 max-lines / 类型断言 / 跨端）
- 方法：只读 diff 审查 + 现行源码逐行核对（面板、桥接、宿主 `terminal.*` 方法族、云路径守卫、desktop/web 客户端 replay 对照实现）；复跑 9 例组件测试（2 文件全绿）；oxlint 复跑被审 5 文件零告警；与测试代理证据 `cloud-platform/evidence/w5a-terminal-panel/`、`cloud-platform/evidence/w5a-verify/`（P1–P5 / G1–G4 探针）交叉印证

## 结论

**有条件通过（不阻塞 W5b 派发，MAJ-1 建议在 W5b 真机 e2e 前修复）**：blocker 0、major 2、minor 5、note 8。

安全语义干净：无 `terminal` 授权时前端不发任何 `terminal.*` rpc、不订阅、不加载终端模块，占位为纯前端门禁，而宿主侧本就独立拒绝（`terminal.*` → 项目权限 `terminal`，未分类终端方法 fail-closed，create 的 worktree 与一切 handle 调用都钉在票据工作区根内）；rpc 参数全部来自常量、宿主回执或 fit 实测值，无用户可注入字符串，viewport 受 zod 与宿主 clamp 双重封顶（有效 PTY 尺寸 ≤1024×120），**无越界注入面**。资源生命周期在卸载/组件树卸载/断线重连三条路径上均验证释放（P2/P4/P5 探针补齐了迟到订阅与双回调竞态）。

两条 major：**MAJ-1** 重连快照重绘缺 `RELEASE_SYNCHRONIZED_OUTPUT`（`\x1b[?2026l`），与被明文要求的「断线重连语义对齐 web 客户端」不一致，agent CLI（真实使用 synchronized output）掉线时面板会锁死在 2026 闩锁、清屏与快照都不上屏而状态徽标仍显示「实时」；**MAJ-2** 桥接提交的全部新传输逻辑（`subscribeOverConnection` + `bridge.subscribe` 路由）零测试覆盖——9 例组件测试全部脚本化在 seam 之上，帧→回调映射、`{type:'end'}`→onClose、非 ok 帧→onError、NOT_CONNECTED/STREAM_UNSUPPORTED、child socket 释放均无红测试兜底。

---

## 1. 安全 / 授权

### 确认的正确面

| 项 | 证据 |
| --- | --- |
| 无 `terminal` 授权 → 纯前端占位且**零调用** | `cloud-project-workspace.tsx`：`canUseTerminal=false` 走占位分支，不挂 `CloudTerminalPanel`；W5a-2 断言 `terminal.*` 调用为空、终端模块零求值；验证探针 G1 再加「订阅调用为零」 |
| 占位不报错 | 占位卡是静态 `<section>`，符合工作令「无 terminal 授权占位不报错」 |
| 宿主独立拒绝（前端门禁不是边界） | `cloud-rpc-permission.ts:17` 把 `terminal.` 前缀映射到项目权限 `terminal`（票据签名，宿主执行）；`cloud-terminal-scope.ts` 对未分类 `terminal.*` 方法 fail-closed；`cloud-path-guard.ts` 把 `terminal.create` 的 worktree 与全部 handle 方法钉在票据工作区根 |
| `permissions` 字段缺失时的降级 | 与 `canReadFiles` 同型：缺字段（旧宿主回执）→ 默认放行挂面板，由宿主拒绝后落失败态，不隐藏可用面板。注释已说明理由 |
| pty rpc 参数注入面 | 无用户可输入字符串进入参数：`worktree=path:<宿主回执>`、`title='cloud-admin'` 常量、handle 来自宿主、clientId 本地生成。viewport 为 FitAddon 实测值 |
| viewport/cols 巨值 | 双重封顶：`terminal.subscribe` zod 1..1000×1..500（terminal-unary-params.ts `TerminalViewport`），宿主 floor 再 clamp 到 20..1024×8..120（`clampTerminalViewport`）；`terminal.updateViewport` zod 20..1024×8..120。**无法越界撑大 PTY** |
| 输入面 | `terminal.send` 文本即用户按键——这是 FR-3.9 授权「与开发者终端同权」的预期能力；design.md §风险已声明终端命令外泄不可阻断，本提交未扩大该边界 |

### 发现

**MIN-2（minor）面板发送的实测尺寸可以落在宿主 schema 边界外，且失败被静默吞掉**（cloud-terminal-panel.tsx:94-98,230-234）

- `terminal.subscribe` 的 viewport schema 允许 1..1000×1..500，而 `terminal.updateViewport` 要求 ≥20 列 / ≥8 行。当面板被压到 <20 列或 <8 行（收起侧栏、极端窄窗）时，订阅仍成功（floor 注册为极小值），此后每次 `pushViewport` 的 `void rpc(...)` 被宿主 zod 拒绝且无任何提示，floor 停留在订阅时尺寸。
- 反向：窗宽超过 1000 列时（约 >9k px，罕见但 5K+ 多联屏可能）`terminal.subscribe` 整帧校验失败 → 进入重连退避 → 5 次全败 →「连接失败（…）」，重试也无法恢复，直到用户把窗变窄。UI 不会解释原因。
- 非安全问题（宿主 clamp 兜底），属可用性：建议发送前按 `TERMINAL_VIEWPORT_MIN/MAX` 本地 clamp，或对 `updateViewport` 的拒绝 outcome 至少打一条 console 警告。

**N2（note）`frameSizeOf` 只拒非正值，无上界**（cloud-terminal-panel.tsx:60-66）

注释说「absent or absurd means keep ours」，但实现只检查 `>0`：宿主回执 `cols: 1e6` 会被采纳并 `term.resize(1e6, …)`（xterm 分配巨缓冲）。通道是 E2EE 可信对端，风险极低；建议与 `TERMINAL_VIEWPORT_MAX_COLS` 同源设上界，让注释成真。

**N3（note）`lines` 兜底绘制的不是屏幕图像**（cloud-terminal-panel.tsx:68-73）

`serialized` 缺失时回退 `lines.join('\r\n')`——那是 `read.tail`（原始输出流尾部），清屏后写入会产生错位的伪重绘。仅影响不带 `serialized` 的旧宿主（降级路径），记录在案。

## 2. 资源生命周期

### 确认的正确面

| 路径 | 行为 | 证据 |
| --- | --- | --- |
| 组件树卸载 | 会话 effect cleanup：`disposed=true`、清 timer、`subscription.unsubscribe()`、`terminal.close`（不 await，不阻塞树）、清 handle；xterm effect cleanup：observer 断开、rAF 撤销、webgl dispose、`term.dispose()` | M118-5；探针 P2 顺序断言（先退订后 close） |
| 订阅在建时卸载 | 迟到 outcome/throw 均补 `unsubscribe()`（含「被取代的流也要释放 child socket」分支） | 面板 `.then` 三个守卫分支；探针 P4 |
| 断线重连 | 不重建 xterm、不重建 PTY（同 handle 重订阅）；同 clientId 触发宿主同槽替换，不累积流；退避 500ms→8s 共 5 次，用尽落失败态 + 手动重试（重试仅在 create 从未成功时才重走 boot） | M118-3；探针 P3；宿主 `terminal-subscribe-method.ts` 槽位注释 |
| 流释放后的 floor | 宿主在 stream teardown 注销 `json:<streamId>` floor；面板的 `terminal.updateViewport` 走 refresh 语义，**无流时不得创建 floor**（宿主 `refreshRemoteDesktopViewer` 注释明确防「floor 泄漏钉死宽度」）——面板用法与之吻合 | terminal-viewport-update.ts + remote-desktop-terminal-floor.ts:242-274 |
| onError+onClose 双回调 | 退避窗口内不会重复订阅（timer 单槽 + epoch 守卫） | 探针 P5（≤2/≤6 断言） |

### 发现

**MIN-4（minor）`terminal.create` 在途时卸载会泄漏一个宿主 shell**（cloud-terminal-panel.tsx:299-312,343-356）

`boot()` 在 `disposed` 时直接 return：此时 PTY 已在宿主创建，但 handleRef 仍为 null，cleanup 的 `terminal.close` 无从发送。窗口 = 一次 rpc 往返（≤5s 超时），每次发生都在用户 checkout 里遗留一个 `cloud-admin` shell；运行时终端按设计持久（`orca-runtime-adopt-terminal-orphans-from-inventory.ts` 只收养不回收），会出现在桌面端工作区终端列表里直到有人手动关。M118-5 只覆盖 create 之后的卸载。建议：disposed 分支里若 `created.ok` 仍补发 `terminal.close`。

**MIN-3（minor）懒加载 chunk 失败没有失败态，会拖垮整页**（cloud-project-workspace.tsx:16-19,196-208）

`React.lazy` 的 import 被拒绝时 Suspense 不捕获，异常上抛到最近错误边界——而 cloud-admin 入口与 cloud/ 全目录**没有任何 ErrorBoundary**（grep 证实）。触发场景很现实：重新部署后浏览器还持有旧 index.html（chunk hash 失配 404）、或经中继浏览器模式 `/h/<routeKey>/` 前缀下资源偶发失败。后果不是终端区错误态，而是整个工作区（含文件面板）卸载成白屏。工作令附录对 rpc 超时与无授权都有指定处理，唯独 chunk 失败这条第三失败模式未覆盖。建议给终端槽加一个局部 error boundary（失败态+重试，与 `failed` 分支同 UI）。

**N1（note）PTY 生命周期 key 在身份不稳定的 prop 上**（cloud-app.tsx:44-52 → cloud-terminal-panel.tsx:359）

`rpc`/`subscribe` 在 CloudApp 每次 render 都是新函数（内联箭头），而面板的 PTY-owning effect 依赖它们：CloudApp 一旦在项目打开状态下发生任何 state 变化，就会 `terminal.close` + 重新 `terminal.create`（新 shell + 全新缓冲）。当前的 CloudApp 在工作区打开期间几乎不重渲染（notice/错误路径都会先关工作区），故为潜伏问题；但 `rpc` 不稳定身份在面板引入持久资源后从无害变成了载荷。建议 CloudApp 里 `useCallback`（或面板内用 ref 收敛 deps）。

## 3. 一致性（快照重绘 / floor 修正 / 懒加载失败态）

**MAJ-1（major）重连快照重绘缺 `RELEASE_SYNCHRONIZED_OUTPUT`，不符合「断线重连语义对齐 web 客户端」**（cloud-terminal-panel.tsx:200-209）

工作令 W5a 与附录均要求断线重连语义对齐 web 客户端。仓库内所有既有的「清屏+重绘」位置都在 `\x1b[2J\x1b[3J\x1b[H` 之前先发 `\x1b[?2026l`（`terminal-mode-reset-profiles.ts:74` 的常量与 WHY 注释），因为 **`\x1b[2J` 不清 mode 2026**：

- desktop 重放：`apply-reattach-payload.ts:57-59`（`RELEASE_SYNCHRONIZED_OUTPUT + RESET_GRAPHIC_RENDITION + 清屏序`）、`replay-data-drain.ts:143-147`、`ipc-pty-attach.ts:57-60`；
- web 客户端恢复快照：`remote-runtime-terminal-binary-snapshots.ts:130-134`，注释原话「a pane holding an open latch would not paint this recovery snapshot at all」。

面板收到的是宿主透传的**原始 PTY 字节**（`runTerminalJsonSubscription` 直接转发 `subscribeToTerminalData`），agent CLI 恰恰是 synchronized output 的重度用户：掉线前最后一个 chunk 若停在 `?2026h`（配对的 `?2026l` 随丢包丢失），面板 xterm 即被闩锁。此后重连写入的清屏+快照**不上屏**，且 2026 闩锁同样抑制后续 live 数据的渲染——用户看到冻结画面而状态徽标是「实时」。宿主侧序列化「never re-asserts 2026」，不会顺带解锁。本提交是仓库里第一处重写该序列而省略前缀的实现，且 M118-3 把这个偏差序列钉进了断言（修复时需同步改测试）。修法一行：`term.write(`${RELEASE_SYNCHRONIZED_OUTPUT}\x1b[2J\x1b[3J\x1b[H`)`（常量从 `shared/terminal-mode-reset-profiles` 复用，勿再手抄）。

**MIN-1（minor）快照重绘后 `pushViewport()` 把「宿主网格」当自己的 viewport 推回去，且从不恢复面板自身 fit**（cloud-terminal-panel.tsx:201-209 vs 桌面对照实现）

`paint()` 先 `resize` 到宿主序列化网格（这点与 desktop 一致，理由也对：wrap/光标相对源网格），但 desktop 随后会把面板 fit 回自身网格再推送自己的 floor（`apply-reattach-payload.ts:50-59` + `fitReattachedPaneToGrid`）；面板在 `paint()` 之后立即 `pushViewport()`，此时 `term.cols/rows` 已是**宿主网格**——自身 fit 从不恢复，且该网格被推为 floor，形成自锁回路：host 网格 → 面板采纳 → 作为 floor 推回 → 宿主保持。触发条件是「重连时宿主网格 ≠ 面板网格」（floor 曾被别的订阅者改写、floor 丢失回落 80×24 等）；平时 subscribe 先以面板 fit 注册 floor、首个快照即同网格，无感。用户可感知的症状是重连后终端内容与面板宽度不符，直到下一次拖拽触发 ResizeObserver 自愈。建议 `paint()` 后 `refit()` 再 `pushViewport()`。

### 确认的正确面

- **floor 修正本身是对的**：宿主 `terminal.updateViewport` 是 refresh-only 语义（注释：「must never *create* a width floor … only refreshes the floor(s) this client already owns via its stream subscription，keyed by clientId」）；面板在 subscribe 参数里带 `client:{id}+viewport`，宿主 `runTerminalJsonSubscription` 据此注册 floor（无 `desktopViewportClaims` 能力位时以 claim=true 注册，对本面板这种唯一视图是正确取向），此后 `updateViewport` 才有 floor 可刷。面板 connect() 里三行 WHY 注释与宿主语义逐字吻合。订阅方缺 `desktopViewportClaims=1` 属可选项，不破坏线兼容。
- **保缓冲 + 快照重绘模型**与 web 客户端一致：xterm 跨掉线保留，重连后以宿主权威图像清屏重绘而非追加第二份历史（M118-3 断言双写）；`scrollback` 事件清屏序仅缺 2026 前缀（MAJ-1）。
- **scrollback 容量**：宿主 JSON 路径序列化阶梯 1000→0 行（512KiB 预算），面板 xterm scrollback 5000 行，历史装得下。
- **事件面**：`fit-override-changed`、`{type:'end'}`、`{streaming:true}` 等未知/无害帧被 `onEvent` 的类型白名单自然忽略，frame router 的 end 帧处理（web-runtime-connection-frame-router.ts:129-134）与 `subscribeOverConnection` 的映射吻合。
- **懒加载成功路径**：类型-only import 不把 xterm 拉进首屏 chunk；W5a-1 用模块求值计数证明 chunk 真的懒。失败路径见 MIN-3。

## 4. 规范符合性（AGENTS.md）

- **max-lines**：无任何 max-lines 禁用、无新增 lint 抑制面（`react-doctor/effect-needs-cleanup` 是另一条 warn 级规则，见 N5）。有效行数（skipBlankLines+skipComments，tsx 上限 400）：`cloud-terminal-panel.tsx` 342、`cloud-project-workspace.tsx` 227、测试 249/142（上限 800）。**无需任何 bump**。
- **命名**：`cloud-terminal-panel`、`cloud-browser-bridge-subscription` 均为具体领域名，无 helpers/utils 类命名。合规。
- **类型断言**：两提交零 `as` 断言，宿主回执全部走 `readString/readNumber/readObjectValue` 受检解析；`frameSizeOf/framePayloadOf/terminalHandleOf` 对畸形回执 fail-safe。优于基线。
- **注释密度**：见 N6。
- **设计系统**：仅用 token 类（border/bg-card/text-foreground/muted 等），无裸色值、无拼接 className；布局（中部终端 + 右侧 w-72/lg:w-80 文件列）对齐原型 P3。
- **复用优先**：复用了 `buildDefaultTerminalOptions`、`getTerminalWebglAddonConstructor`、`cloudWorktreeSelector`、json-fields 解析族；但清屏序列未复用 `RELEASE_SYNCHRONIZED_OUTPUT` 常量（MAJ-1 的根因之一——仓库里现成且有 WHY 注释的常量被手抄序列替代）。
- **跨端**：本提交 renderer-only、纯 web 语境（cloud-admin），无平台分支需求；键盘不涉及。

**N5（note）`react-doctor/effect-needs-cleanup` 禁用是 renderer 首例**（cloud-terminal-panel.tsx:115）

带 Why 的行内禁用格式合规、理由真实（timer 从流回调武装），但仓库 renderer 内此前零先例，且该效果完全可以用 ref 持有 timer 让 cleanup 自然覆盖，从而免掉抑制。warn 级规则，不阻塞。

**N6（note）注释密度偏厚但内容合格**

多处 3-4 行 WHY 注释（scrollback 分支 4 行、viewport floor 3 行、resize 3 行）。AGENTS.md 要求「1 LINE if possible」；内容均为非显然的 WHY 而非 HOW 复述，判为风格摩擦而非违规。若收敛，优先压缩 scrollback 分支。

## 5. 测试质量（9 例可变红性推理）

复跑：`cloud-terminal-panel.test.tsx`（6）+ `cloud-project-workspace-terminal.test.tsx`（3）＝ **9/9 绿**（vitest, config/vitest.config.ts）。oxlint 5 个被审文件零告警。

| 例 | 变红条件（若实现回归） | 判定 |
| --- | --- | --- |
| M118-1 | 不建 PTY / 不订阅 / 回显不写 / 快照不 resize / 按键不带 handle | 可红；但 **resize→write 顺序未钉**（仅 `toHaveBeenCalledWith`，无 invocationCallOrder），「先按源网格 resize」可静默回归 |
| M118-2 | create 被拒仍假装在线 / 照样订阅 | 可红（retry + code + `stream.calls` 为空三重断言） |
| M118-3 | 重连新建 Terminal/PTY / 退避步进变化 / 清屏序消失 | 可红（实例数=1、create 数=1、6 次订阅算术、清屏与 payload 双写）；清屏→payload 顺序同样未钉；且把 MAJ-1 的偏差序列钉死 |
| M118-4 | 重试不重走 create | 可红 |
| M118-5 | 卸载漏 unsubscribe / 漏 terminal.close / 漏 dispose | 可红（恰好兜住 MIN-4 之外的正常路径） |
| M118-6 | 订阅层抛错冲进渲染树 | 可红 |
| W5a-1 | 有授权不懒加载 / 文件面板回归 | 可红（模块求值计数=1 是硬断言） |
| W5a-2 | 无授权发 terminal.* / 加载终端模块 | 可红（安全门禁的直接红测试） |
| W5a-3 | 无 subscribe 能力仍渲染终端区 / 页面回归 | 可红 |

**MAJ-2（major）桥接提交 79 行新传输逻辑零测试**：`subscribeOverConnection`（帧→onEvent、`{type:'end'}`→onClose、非 ok 帧→onError、`NOT_CONNECTED`/`STREAM_UNSUPPORTED`/`failure()` 三种 outcome、`unsubscribe` 透传到 child socket 释放）与 `bridge.subscribe` 的 `projectConnections.get` 路由 / NOT_SIGNED_IN 分支，无任何测试触及（全仓 grep：仅实现文件与类型再出口引用）。9 例组件测试把 seam 整体 mock 掉，正好把这一层留白；seam.json 自己也只声明「typecheck + 既有 68 例回归」。W5b e2e 会在真链路上经过它，但单元级红测试今天不存在——这正是「 decoder 静默丢帧/漏释放」最该有测试的一层。建议补一个对 `subscribeOverConnection` 的直接单测文件（脚本化 client.subscribe 即可，无需真 socket）。

**N7（note）提交套件的两个小盲区**：「工作区尚未创建」占位分支无提交用例（仅验证探针 G4 覆盖，证据在 evidence 不在仓库测试里）；快照 `truncated` 语义无任何用例（见 MIN-5）。

**MIN-5（minor）`truncated`（及 `oscLinks`/`cwd`）被忽略**（cloud-terminal-panel.tsx:200-209）

scrollback 事件带 `truncated: isTerminalReadPayloadIncomplete(read)`，且 `serializeBudgetedMobileSnapshot` 的 512KiB 预算裁剪根本不进该事件的任何字段。面板清空 scrollback（`\x1b[3J`）后把可能被裁剪的缓冲当权威图像绘制，无任何「历史被截断」提示；desktop/web 客户端正是用等价标志做 snapshot availability 分级。低频（2MiB 请求预算 / 512KiB 移动预算都很大），但属于「清了历史又装作完整」的静默数据丢失，建议至少在 `truncated` 时给出可见标记。

## 6. diff 归属

- **`7058a99dd1c`**（5 文件）：面板 + 工作区接线 + cloud-admin WebGL prime + 两组件测试，全部落在 W5a 规格（「懒加载、cloud-browser-bridge rpc→宿主 pty、cloud-admin/main.tsx WebGL prime、无授权占位」）内；`cloud-project-workspace.tsx` 把文件面板挪进右列属原型 P3 布局对齐，同为 W5 伞内。工作区与文件面板逻辑零改动（`cloud-file-panel.tsx` 未触碰，FR-3.9「文件面板不回归」由 W5a-1/3 钉住）。**无混入**。
- **`b0665d848a7`**（5 文件）：seam 纯增量（类型 + 一个 bridge 方法 + cloud-app 接线），无 rpc/IPC/opcode 变化，`BrowserCloudClient` 加可选成员对既有 scripted double 无破坏。**无混入**。`use-cloud-session.ts` 的 `export type *` 再出口是为避免 CloudBridge 直接依赖桥实现，属可接受的间接层。
- 工作令只给 W5a 指定了一条提交消息，实际拆成两个提交且第二条消息不在令内——拆分动机（面板先落、seam 随后）已在 `evidence/w5a-terminal-panel/seam.json` 如实记录，判 note 级（N8）。
- 证据齐备：`evidence/w5a-terminal-panel/`（7 件）+ `evidence/w5a-verify/`（2 探针套件 + browser-probe）。注意 `seam.json` caveat 已如实记录：工作区里其他通道的在途改动（web-path-prefix 等）会让 `cloud-admin-session.e2e` 失败，与两被审提交无关（本次审计同样确认该文件不在两 diff 内）。

## 分级汇总

| 级别 | 编号 | 一句话 |
| --- | --- | --- |
| blocker | — | 无 |
| major | MAJ-1 | 重连清屏缺 `\x1b[?2026l`，2026 闩锁下清屏+快照+live 全部不上屏，偏离 web 客户端 replay 语义 |
| major | MAJ-2 | `subscribeOverConnection` + bridge 路由零测试（帧映射/错误分支/socket 释放无红测试） |
| minor | MIN-1 | 快照重绘后把宿主网格推回 floor 且不恢复自身 fit（自锁回路，重连后网格失配） |
| minor | MIN-2 | 实测 viewport 可落在宿主 schema 边界外：窄窗静默拒、超宽窗订阅整帧失败且 UI 不解释 |
| minor | MIN-3 | 懒加载 chunk 失败无错误边界，整页白屏（含文件面板） |
| minor | MIN-4 | `terminal.create` 在途卸载泄漏宿主 shell（handle 未及登记，close 无从发送） |
| minor | MIN-5 | `truncated`/`oscLinks`/`cwd` 被忽略，裁剪快照清屏后伪装完整 |
| note | N1 | PTY effect 依赖身份不稳定的 `rpc`/`subscribe` prop（当前低频，潜伏重建） |
| note | N2 | `frameSizeOf` 无上界（「absurd」注释与实现不符） |
| note | N3 | `lines` 兜底绘制原始流尾而非屏幕图像（旧宿主降级路径） |
| note | N4 | WebGL 未等 prime 完成即定终身，早挂载面板永久 DOM 渲染（软降级，符合注释声明） |
| note | N5 | `react-doctor/effect-needs-cleanup` 行内禁用为 renderer 首例（可用 ref 重构避免） |
| note | N6 | 3-4 行 WHY 注释偏厚（内容合格） |
| note | N7 | 顺序断言缺失（resize→write、清屏→payload）；「工作区尚未创建」分支仅证据覆盖 |
| note | N8 | 两提交拆分与第二条提交消息不在工作令文本内（seam.json 已记录） |
