# W13b 审计报告（web 云工作区视图）

- 审计人：独立审计代理（只读；未修改任何被审文件，本报告为唯一产出文件；未提交 git）
- 日期：2026-11-14
- 审计对象：`7df1f6738ea`（feat(cloud): cloud workspace view in orca web，16 文件 +1206/−96）。现行 HEAD（`2d479937a3f`）与被审提交之间这 16 个文件**逐字节一致**（`git diff 7df1f6738ea HEAD --name-only` 仅 `cloud-platform/PROGRESS.md`，工作树无这些路径的未提交改动），全部行号引用即提交态。注：任务描述所称「其上的后续提交 51f04a1d092(W13c-1)」实为该提交的**父提交**，W13c-1 未触碰 W13b 的任何文件，按提交本体审计的结论不受影响。
- 对照基准：`work-orders/w13-cloud-workspace-view-design.md` §4/§6/§7（W13b 切分）、§3.4/§5（宿主语义只读核对）、`cloud-platform/PROGRESS.md`「W13b 落地」节、`cloud-platform/evidence/w13b-workspace-view/w13b-summary.json` 交付偏差、AGENTS.md
- 方法：只读 diff 审查 + 现行源码逐行核对（bootstrap 全文、`web-cloud-workspace-store-ports.ts`、`web-cloud-workspace-api.ts`、`CloudSessionEmptyState.tsx`、旅程 spec 全文、宿主侧 `cloud-repo-add-scope.ts`/`cloud-path-guard.ts`/`cloud-rpc-permission.ts`/`cloud-workspace-open.ts`/`orca-runtime.ts` provision 注册链/`runtime-repository-clone-controller.ts`、客户端激活链 `worktree-activation.ts`/`workspace-terminal-host-authority.ts`/`worktree-initial-terminal-seeding.ts`/`web-runtime-terminal-create-operation.ts`、U23 修复 `108bf8bb832`、O1-e `9642bca9750`）；本机实跑：oxlint（7 个被审源/测试文件）exit 0，`run-vitest` 三个 W13b 测试文件 **17/17 绿**（781ms）。未跑旅程与长套件，旅程结论采信落盘证据并逐项与 spec 断言交叉核对。

## 结论

**通过（PASS）**：blocker 0、major 0、minor 3、note 7。

核心判定：三阶段 bootstrap 以 `workspace.info` 为唯一取数源、全程走已准入主连接、失败全部被自身 try/catch 吸收为云卡回落（`web-cloud-workspace-bootstrap.ts:136-250`），启动链只 `void startWebCloudWorkspaceBootstrap()`（`use-app-startup-hydration.ts:99-103`）不 await、不重抛——「失败回落空态、不降级启动」由构造保证。`cloudWorkspace` 命名空间只在 web preload 装配（`web-preload-api.ts:83`；`src/preload` 内仅 `api-types.ts:167` 的可选类型声明），宿主 `repo.add` 的路径钳制（`cloud-repo-add-scope.ts:40` realpath 恰等票据 projectRoot）在宿主侧执行，客户端传什么都不能放大。`github.prForBranch`/`hostedReview.forBranch` 的空应答是纯渲染层短路（宿主 `src/main` 零改动，`cloudMethodAccess` 对两方法仍返回 null=拒），与 O1-e 的按环境短路是互补两层而非重复。旅程翻转三处（B4 重写 / 流式用例启用 / 旗标删除）同提交联动完成且断言全部实质化。交付偏差三条均成立且不削弱边界（详见 §5）。

---

## 1. 设计符合（§4）

| 设计要求 | 实现 | 判定 |
| --- | --- | --- |
| §4.1 三阶段 + 接线点 | `use-app-startup-hydration.ts:99-103` 云分支内启动、不 await；bootstrap 顺序 info → registering(repo.add) → ensuring(openCloudWorkspaceOverRpc) → activating(fetchWorktrees→selectCloudInitialWorktreeId→activate)（`web-cloud-workspace-bootstrap.ts:138-241`）。**阶段②③与设计 §4.1 的列举顺序互换（repo 行先于 ensure）**=已申报偏差 1，见 §5 | 符合（含 1 条申报偏差） |
| §4.1 启动链不等待 | ensure 首开可达分钟级；`void` 调用，B3 的 8s settle 断言与 B4 的 180s poll 分层等待（spec:572-588） | 符合 |
| §4.1 每页一次 | 模块级 `inFlight` 去重 + settled 记忆（`:67,264-270`）；单测 `dedupes concurrent starts and never repeats a settled run` | 符合 |
| §4.1 重连幂等重跑一次 | `watchTransport` 只在 disconnected→ready 对后置 `transportReconnectedSinceSettle`（`:91-102`）；单测 `reruns once after the transport drops`（含「无断连的 ready 不重跑」反例） | 符合 |
| §4.1 激活等 hydration | `waitForHydrationSettled`（30s 上限 + 100ms 轮询，`:120-133`）在 registering 之前；单测 `registers only after the boot chain settles`。核对 `setHydrationSucceeded(true)` 位于启动链末端（`use-app-startup-hydration.ts:316`），即 reconnectPersistedTerminals/hydrateWorkspaceSession 重写 `activeWorktreeId` 之后——「先写会被持久会话水合清掉」的前提成立 | 符合 |
| §4.4 method_not_found → 旧宿主空态、无重试 | `hasRuntimeRpcErrorCode(error,'method_not_found')` → `unsupported-host` + `retryable:false`（`:244-249`）；空态文案「This Orca server's version does not support…」且断言无 Retry 按钮（`CloudSessionEmptyState.test.tsx:96-105`） | 符合 |
| §4.4 ensure 失败 → 可重试 | `fallback({reason:'failed', retryable:true})`（`:211`）；重试重跑 ensure+seeding（幂等键 `cloud-open:<projectId>:<branch>` 宿主去重）；单测覆盖「失败→Retry→恢复」 | 符合 |
| §4.4 失败不降级启动 | runBootstrap 整体 try/catch、永不 reject（`:136-250`）；启动链不感知。W7c 跳过清单/桥接云分支/空态骨架（`data-worktree-sidebar-container`）零触碰（16 文件清单核实） | 符合 |
| §4.3 仅 `open` 票据 | 行注册后 `phase:'done' + terminalNotGranted`，不 ensure、不激活（`:196-219`）；单测 + 组件测试断言「未授予终端权限」文案 | 符合 |
| §4.3 explorer 仅在 `file:read` 时挂载 | **未实现**：bootstrap 只读 `perms.includes('terminal')`（`:168`），`activateWorkspace` 无条件开 explorer（`web-cloud-workspace-store-ports.ts:88-95`）。见 **MIN-1** | 偏差（未申报） |
| §4.2 文件与命名 | `preload-api/web-cloud-workspace-api.ts`、`web-cloud-workspace-bootstrap.ts` 与设计逐字同名；`web-cloud-workspace-store-ports.ts` 为设计表外新增（store 侧端口注入层，职责清晰，见 §6） | 符合 |
| §6.2 提交切分 | 单提交含 bootstrap+preload 命名空间+空态升级+§7.1 探针门+§7.2 三处翻转，无跨令文件混入（事故 7 恢复后逐文件核对 16 文件全部 W13b 在途内容） | 符合 |

---

## 2. web-only 边界与宿主 pin

- **命名空间只在 web 安装**：`createCloudWorkspaceApi()` 唯一调用点是 `web-preload-api.ts:83`（web 索引专用装配，`web-preload-api-composition.test.ts:37` 钉键集）；桌面 preload（`src/preload/`）全目录 grep 仅 `api-types.ts:167` 的 `cloudWorkspace?` 可选声明，无安装点——类型可选使桌面构造无需该键即通过编译。配对（非云）web 会话同样装上该命名空间，但 bootstrap 只在 `isActiveWebClientCloudSession()` 为真时启动（`use-app-startup-hydration.ts:98`），`workspace.info` 对 runtime-paired 调用方返回 in-band `CLOUD_SESSION_REQUIRED`（W13a 审计已证），无新增暴露面。
- **宿主 pin 不可参数放大**：客户端 ensure 传给 `repo.add` 的 path 唯一来源是 `info.project.root`（=宿主从票据副本直出的 projectRoot），经 `addRepoPath` → `callRuntimeRpc(target,'repo.add',{path,kind:'git',displayName})`（`repo-add-actions.ts:50-56`）。宿主侧 `checkProjectRootTarget`（`cloud-repo-add-scope.ts:21-48`）要求 path 绝对且 **realpath 恰等票据 projectRoot**，`project_scope` 拒绝其余——伪造相邻/父目录 path 一律 `path_denied` 且入审计。ensure 的其余参数同样不放大：`project.provision` 无参数；`worktree.list/createManaged` 的 repo/workspaceRoot 由 `cloud-path-guard.ts` 的 `checkRepoScopedRead`/`checkManagedCreate` 从票据根重新解析比对（`:274-298,240-272`），客户端声称的根零效力（§5.2.3 既有语义）。幂等键虽客户端可选，但 dedupe 以 (repoSelector, key) 为键且 repo 必须先过票据范围护栏，无跨票 join 面。
- **零宿主侧改动**：16 文件中 `src/main` 计数为 0（`git show --name-only` 核实），云权限表、准入扩展表、`ALL_RPC_METHODS` 全部未触碰。

---

## 3. 拒绝面（prForBranch / hostedReview 空应答）

- **语义归属正确**：`pull-request-actions.ts:28-32` 与 `hosted-review.ts:160-162` 都是**渲染层入口短路**——条件 `isActiveWebClientCloudSession()` 仅对「整页即云会话」为真，桌面客户端零影响；返回 `null` 与「该分支无 PR」同形，调用方（checks-panel 刷新族、`refresh-routing-actions.ts:46,61`、`visible-hosted-review-refresh-targets.ts:158` 等）按既有空值路径收敛，无未处理 rejection 上控制台。宿主 L1 语义未动：`cloudMethodAccess('github.prForBranch'/'hostedReview.forBranch')` 仍为 null（`cloud-rpc-permission.ts:102-130` 无前缀命中）→ 云会话调用仍被拒并入审计；本提交不改 `src/main`。零宿主拒绝审计的门（旅程 B4 `denialLogs===[]`）因此由客户端不发起实现，而非宿主放行——方向正确。
- **与 O1-e（`9642bca9750`）的关系：互补，非冲突/重复**。O1-e 的短路在 `startPullRequestLookup` 内层，条件是 `isCloudSessionEnvironmentId(runtimeEnvironments, runtimeRepo.target.environmentId)`——依赖 store 里有该环境的环境行；web 云会话（W7c 跳过目录族）`runtimeEnvironments` 可能为空 → 内层护栏不触发。W13b 的页级短路在 `fetchPRForBranch` 入口，恰好封住该洞（`startPullRequestLookup` 的唯一生产调用方就是 `fetchPRForBranch`，`pull-request-actions.ts:134`）。`hostedReview.forBranch` 此前**没有任何**客户端守卫（O1-e 只在 ChecksPanel 呈现占位卡），W13b 是新覆盖。差异点（行为无冲突，仅记录）：O1-e 命中时回 `cached?.data ?? null`，W13b 恒回 `null`——云会话生命周期内不可能有可用的 PR 缓存，实际等价。

---

## 4. 旅程翻转质量（§7.2）

| 翻转点 | 现状 | 判定 |
| --- | --- | --- |
| `W13_CLOUD_WORKSPACE_VIEW_LANDED` | 常量删除，全仓源码零残留（余下命中均为设计文档、W9b 归档 findings、spec 头部说明文字——合理留档）。tripwire `if (LANDED) throw` 与流式用例 `test.skip(!LANDED)` 一并消失 | 符合（设计 §7.2 明示「删更干净」） |
| B4 重写 | 实质断言齐备：180s poll `repoCount===1 && activeWorktreeId!==null` → 云卡退役、`repoCount===1`（桌面目录被拒不可能是第二行）、`activeWorktreePath` 含 `.orca-worktrees/zhangsan`（宿主管理的本人 checkout）、`repo.list` 仍以精确云层文案被拒、`denialLogs===[]`（sink 从 B2 起挂，覆盖 B3+B4 全窗口）。红线证据改拍工作区形态（`04-cloud-session-with-workspace-view.png`） | 符合 |
| 流式用例启用 | 真启用且全为实质断言：≥2 次 `POST /v1/projects/{id}/connect`（W5c 重签）；回显 marker 经 **SerializeAddon**（`helpers/terminal-pane-identity.ts:80`，`pane.serializeAddon` 是产品代码自有属性，`__paneManagers` 由既有 `e2eConfig.exposeStore` 门暴露）；宿主审计零 `replayed`（spec:749-752）；explorer 打开种子文件 → 编辑器 **valueTail 双断言**（`window.__monacoEditorE2E` 探针 + `.view-lines` DOM，spec:762-777）——探针+DOM 双轨正是 §7.1 方案 a 的正确收口 | 符合 |
| §7.1 探针门 | `monaco-e2e-probe.ts:34` 与 `web-e2e-config.ts:4` 同表达式本地内联（`MODE!=='e2e' && String(VITE_EXPOSE_STORE)!=='true'` → 跳装），零构建脚本改动；桌面 `--mode e2e` 行为不变 | 符合 |
| 宿主播种 profile（偏差 3） | `launchHost` 写 `getE2ECompletedOnboardingProfile()` 到 `orca-data.json`（spec:190-196），与 A 线 `cloud-golden-journey-desktop.spec.ts:178-186` 同 helper 同文件同措辞；流式用例仍防御性点掉可能的首跑 tip（spec:722-725）。边界：seed 只伪造 onboarding/tips-seen 状态，不伪造任何工作区/终端/repo 状态，工作区断言仍走真实产品路径 | 合理（见 MIN-2 的披露缺口） |

证据侧实证：两次真栈全绿（`run-log-w13b-first-green.txt` 29.5s、`run-log-w13b-repeat.txt` 19.0s，各含旅程 + 流式两例）；timeline 的 B4 步 `mode:'w13'`、`repoCount:1`、`activeWorktreePath` 指向 `.orca-worktrees/zhangsan/main`、`denialLogCount:0`、`catalogRefusal` 精确文案，与 spec 断言一一对应。

---

## 5. 交付偏差三条裁定

**偏差 1 · repo 行先于 ensure 注册 —— 裁定：成立，安全，方向与桌面入口一致；但申报理由对 U23 之后的宿主已非必要（NOTE-1）。**
理由核对：`worktree.list`/`worktree.createManaged` 的 repo 级护栏确以宿主 repo 目录解析 `path:<projectRoot>`（`cloud-path-guard.ts:274-298` → `showRepo`），未注册即 `repo_unknown`——前提的机制描述正确。但 U23（`108bf8bb832`）之后 `project.provision` 在**全部三种 plan** 都把 projectRoot 登记进宿主目录（already-provisioned → `registerExistingCheckout`，`orca-runtime.ts:128-143`；init/clone → `cloneToPath`/`initToPath` 的 `registerCheckout` 尾，`runtime-repository-clone-controller.ts:108,141`），而 ensure 的第一步就是 provision——即设计原序（ensure→adopt）下宿主行也会先于 worktree.list 出现，「web 会话是首个打开者、没有别人建行」的缺口已被 U23 封住。尽管如此，register-first 仍更优：与桌面云入口同构（`cloud-entry-workspace-sync.ts:51-63` 确为 `syncCloudProjectRepos` 先于 `openWorkspace`）、登记失败提前表现为独立的可重试回落（「The host refused to register the project」）而非更含混的 `repo_unknown`、且对宿主 pin 零影响（钳制与顺序无关）。不构成回归，不要求改码；建议把 bootstrap 模块头注释（`web-cloud-workspace-bootstrap.ts:26-30`）补一句「provision 自 U23 起亦登记宿主行，先登记是桌面同构 + 失败归因，非护栏必需」。

**偏差 2 · 激活走本地 tab 管道而非 `activateAndRevealWorktree` —— 裁定：成立，且两条理由都被现行代码证实。**
其一，`resolveWorkspaceTerminalHostAuthority` 对任何活跃 web runtime 会话返回 `'live'`（`workspace-terminal-host-authority.ts:110-112`），而 `ensureWorktreeHasInitialTerminal` 见 `'live'` 即跳过本地播种（`worktree-initial-terminal-seeding.ts:105-107`）——`activateAndRevealWorktree` 会把 checkout 激活成**无终端**形态（云宿主不像配对桌面那样推 tab 镜像回来）。其二，该 helper 尾部的 `ensureWebRuntimeWorktreeTerminalAfterWake`（`worktree-activation.ts:320-329`）无云会话门，新检出零已知宿主 tab 时会走到 `session.tabs.createTerminal`（`web-runtime-terminal-create-operation.ts:170`）——正是 W7c 拒绝族，会打掉零拒绝门。（`worktree.activate` 通知一节已被 O1-b `718db425951` 的三条件门先行封住，此半句属历史动机，不影响结论。）本地管道 `setActiveWorktree + createTab` 经终端面板挂载落到 `terminal.create`（`terminal` 权限既有放行），旅程流式用例的回显即实证。

**偏差 3 · 旅程宿主播种 completed-onboarding profile —— 裁定：成立，测试边界干净。**
不播种则首跑向导/tip 覆盖新断言的工作区面（W13b 新增的恰是「工作区可见」类断言，风险真实）；与 A 线既有模式逐字一致（同 helper `tests/e2e/helpers/e2e-completed-onboarding-profile.ts`，`orca-data.json` 是宿主持久化文件的真实读取名）。seed 内容仅 onboarding 完成态 + tips/tour 已读 + 若干 notice dismissed，不含任何 workspace/repo/terminal 状态，工作区点亮断言仍驱动真实 bootstrap。缺口仅在披露位置：spec 头部「Disclosure — the journey's shortcuts, **none silent**」清单未列此 seed（只有写入点行内注释），见 **MIN-2**。

---

## 6. AGENTS / 风格

- **命名**：`web-cloud-workspace-bootstrap.ts`（=设计 §4.2 逐字）、`web-cloud-workspace-api.ts`（=§4.2 逐字）、`web-cloud-workspace-store-ports.ts`（设计表外新增；「store-ports」准确描述「bootstrap 的 store/namespace 注入端口」这一职责，非 `helpers/utils` 类垃圾抽屉，与模块头声明一致）。`CloudSessionEmptyState` 原名保留。
- **max-lines**：零抑制（diff 与 5 个相关文件 grep 均无 `max-lines`/`eslint-disable`）；`use-app-startup-hydration.ts` 增 6 行后 357 物理行（skipBlank/Comments 计数 <300 档），e2e spec 781 行 <800 档，bootstrap 314 行 <300 档（skipComments 后）。oxlint 7 文件 exit 0 实证。
- **类型断言**：三个新文件零 `as` 断言；应答读取全部走 `readCloudWorkspaceInfo`/`readString`/`readObjectValue` 形状检查读取器，符合「Prefer Checked Types」。
- **零宿主侧改动**：核实无 `src/main` 文件（§2）。
- **并发提交纪律**：事故 7 恢复后本提交 16 文件全部为 W13b 在途内容，无平行令文件混入；PROGRESS 由 `e50af527d70`/`2d479937a3f` 单独入档。

---

## 7. 证据

| 项 | 位置 | 判定 |
| --- | --- | --- |
| W13b 工单位 | `cloud-platform/evidence/w13b-workspace-view/`：`journey-golden-b/`（timeline + 6 截图 + run-log）、`regression-renderer-sweep.log`、`w13b-summary.json` | 齐备 |
| 规范位 | `cloud-platform/evidence/journey-golden-b/`：timeline 已更新为 B4-cloud-workspace-view（9 步全 ok，与工单位同 runMarker `orca-web-journey-1794656668701` 逐字节一致）、6 截图（含新 `06-b4-terminal-stream-and-file.png`）、`run-log-w13b-first-green.txt`/`run-log-w13b-repeat.txt` 两次全绿、`w9b-pre-w13-archive/` 保留被退休的 B4 红线证据 | 齐备 |
| 门禁 | `regression-renderer-sweep.log`：1123 文件/9507 例全绿（3 例自身 skip）；summary 记录 tc:web 0 错、oxlint changed 清洁、mobile 3 文件 5 例红但均不在 W13b 触碰的 import 图内 | 齐备（计数与 PROGRESS 有出入，见 MIN-3） |
| 本机复核 | oxlint 7 文件 exit 0；`web-cloud-workspace-bootstrap.test.ts` + `CloudSessionEmptyState.test.tsx` + `web-preload-api-composition.test.ts` 17/17 绿 | 复现 |

---

## 发现清单

**blocker**：无。

**major**：无。

**minor**

- **MIN-1** 设计 §4.3 的「explorer 仅在也有 `file:read` 时挂载」未实现且未申报：bootstrap 只消费 `perms.includes('terminal')`（`web-cloud-workspace-bootstrap.ts:168`），`activateWorkspace` 无条件 `setRightSidebarTab('explorer')+setRightSidebarOpen(true)`（`web-cloud-workspace-store-ports.ts:88-95`）。平台 `PUT /grants` 接受任意 permissions 数组（`server.ts:1837-1839`），`terminal` 无 `file:read` 的票据可被签出：该形态下 explorer 挂载并发出 `files.readDir` 等被拒调用 → 控制台拒绝噪声，正撞 §7.3「零 cloud-denial 控制台错」硬约束（该票据形态下 B3/B4 门会红），面本身降级为空树、不崩不卡故为 minor。建议：`activateWorkspace` 以 `info.perms.includes('file:read')` 门 explorer 揭示（或 W13c-2 负向批内补一条该票据形态的断言）。
- **MIN-2** 旅程头部披露清单自述「none silent」但未列宿主 onboarding profile 播种（只有 `launchHost` 行内注释）；A 线同 seed 亦只在行内注释。建议把「宿主以 completed-onboarding profile 播种（同 A 线）」补进 `cloud-golden-journey-orca-web.spec.ts` 头部 Disclosure 段。
- **MIN-3** 证据/入档计数漂移：PROGRESS「1121 文件 9498 例」与留档日志「1123 文件/9507 例」（`regression-renderer-sweep.log`）不一致；PROGRESS「两次全绿 16.9s/29.5s」与留档两次运行日志（29.5s 与 19.0s，另有工单位 18.8s 一份）对不上；`journey-golden-b/` 内三份 `regression-*.log` 是 W9b 期（16:34-16:35，`/tmp/w9b-journey-20261114`）产物，易被误读为 W13b 零回归证据（W13b 的渲染层回归实际在 `w13b-workspace-view/regression-renderer-sweep.log`；平台 web/cloud-admin e2e 未随 W13b 重跑，属 W13c-2 范围）。建议勘误 PROGRESS 数字并在 evidence 索引标注三份旧日志的归属批次。

**note**

- NOTE-1 偏差 1 的申报理由在 U23 之后过强：`project.provision` 三种 plan 都登记宿主行（`orca-runtime.ts:128-143`、`runtime-repository-clone-controller.ts:108,141`），ensure 本身已保证 worktree.list 可解析；register-first 的真实价值是桌面同构 + 失败归因提前（见 §5）。
- NOTE-2 `activateWorkspace` 在 `setActiveWorktree` 之后仍读激活前捕获的 `state.tabsByWorktree`（`web-cloud-workspace-store-ports.ts:83-87`）——陈旧快照；本流程中目标检出必为新行、两侧皆空，无害，但属脆弱写法。
- NOTE-3 `fetchWorktrees` 返回值被忽略（`web-cloud-workspace-bootstrap.ts:223`）：失败时经「checkout 不在工作区目录」可重试回落兜住，但 detail 文案与真实原因（目录拉取失败）不符。
- NOTE-4 生产 `info()` 对拒绝回包是 throw（`callRuntimeResult` → `!response.ok` 抛错，`web-runtime-calls.ts:76-83`），bootstrap 的 `{ok:false}` 形状分支实际只有测试端口能走到；生产中 info 拒绝会落 catch 计为可重试 `failed`，与单测钉住的「拒绝不可重试」分类有出入（云会话对 session 级方法不会被拒，实际不可达）。
- NOTE-5 流式用例的 tab 未挂 console-denial sink，点亮面（explorer/editor/terminal）驱动期的拒绝不可观测——§4.6 点亮面清单属 W13c-2，记录边界以免误读为零拒绝已全量覆盖。
- NOTE-6 设计 §6.1 的 web bootstrap 单测两行——「失败不降级启动（hydrationSucceeded 仍 true）」「W7c 跳过清单不被触碰」——未被字面断言；由构造保证（fire-and-forget 模块 + 文件清单零触碰）且 W7c 套件在 1123 文件清扫中全绿，接受。
- NOTE-7 B4/流式用例的 180s poll 预算未真正被压测：journey 的 projectRoot 在 beforeAll 预建为 git 仓库 → provision 走 already-provisioned（无冷克隆），ensure 只建 managed worktree；「首开克隆分钟级」路径靠 B4 步内注释与 `PROVISION_TIMEOUT_MS=600s` 设计约束背书，旅程未实证。

**偏差裁定汇总**：偏差 1 成立（NOTE-1 限定其论证强度）；偏差 2 成立（双理由均被现行代码证实）；偏差 3 成立（MIN-2 限披露缺口）。
