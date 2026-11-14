# W13a 审计报告（宿主 `workspace.info`）

- 审计人：独立审计代理（只读；未修改任何被审文件，本报告为唯一产出文件）
- 日期：2026-11-14
- 审计对象：`f160524e19d`（feat(cloud): workspace info for cloud sessions on the host，12 文件 +969/−6）；现行 HEAD（`13b8ddadb85`）与被审提交之间这 12 个文件**逐字节一致**（`git diff f160524e19d HEAD -- <12 路径>` 为空，工作树亦无这些路径的未提交改动），全部行号引用即提交态
- 对照基准：`work-orders/w13-cloud-workspace-view-design.md` §0–§3/§5/§6/§8（W13a 切分）、design.md §7.3（权限模型/默认拒绝/`workspace.info` 为显式登记自省方法）/§9、W7c 取舍（w7c-change-manifest.json `knownBoundaries[0]` = 本工单关闭的 O2；「云方法表不扩充」裁定的对象是**云权限表**，workspace.info 是设计授权的登记表例外）、AGENTS.md
- 方法：只读 diff 审查 + 现行源码逐行核对（`workspace-info.ts` 全文、`cloud-rpc-permission.ts`/`rpc-caller-scope.ts`/`rpc-request-admission-prologue.ts`/`runtime-rpc-websocket-dispatch.ts` 准入链、`cloud-upgrade-admission.ts` 票据根校验、`orca-runtime-resolve-worktree-selector.ts`/`runtime-managed-worktree-queries.ts` 选择器解析、`git-worktree-porcelain-parser.ts` 分支形态、`device-registry*.ts` cloudSession 写入方）；本机实跑：3 个新单测文件 29/29、真栈套件 5/5（node 池，4.6s）、`src/main/cloud-platform` 全目录 349 passed|4 skipped 0 红、`pnpm tc` exit 0、oxlint（6 个被审源文件 0 告警）；证据交叉印证 `cloud-platform/evidence/w13a-workspace-info/`（w13a-1…5 五份 JSON + gates.txt + 目录套件日志）

## 结论

**通过（安全核心成立：字段即白名单由构造保证并被深等+键集测试钉死；应答的数据来源被约束在票据域 + 一次 workspaceRoot 过滤的检出查询；云权限表与平台契约零改动；非云调用方拒绝不可伪造绕过）**：blocker 0、major 0、minor 4、note 11。

核心判定：`workspace.info` 的 handler（`workspace-info.ts:21-85`）只读 `context.cloud`（宿主在 `runtime-rpc-websocket-dispatch.ts:244-253` 从**设备注册表行**注入的票据副本，客户端零参数通道）外加一次 `runtime.listManagedWorktrees('path:<projectRoot>')`，再把结果用 `isInsideWorkspaceRoot(workspaceRoot, row.git.path)` 过滤到本票据工作区根内的**第一行**，只回该行的 `git.path`/`git.branch`。查询参数、返回键、perms 三者都不存在客户端可影响的自由度。W7c「不扩充表」的对象（`cloud-rpc-permission.ts` 的权限映射）在本提交中一个字符都没动；`SESSION_METHODS` 的 `workspace.info` 行是 `e5ee5a53f53` 的既有行；平台契约 `METHOD_RULES` 的 `{ method: 'workspace.info', permission: null }` 也是既有行——登记表扩展（`CLOUD_HOST_METHODS`）只发生在 `cloudAdmissionOption` 内部，与 `MANAGED_WORKTREE_METHODS`/`PROJECT_PROVISION_METHODS` 同一先例。

---

## 1. 安全（核心）

### 确认的正确面

| 项 | 证据 |
| --- | --- |
| ① 返回值白名单（构造级） | 应答是 handler 里的显式对象字面量（`workspace-info.ts:37-53`）：`project.{id,root,repoUrl,defaultBranch}`、`workspace.{root,path,branch}`、`perms`，全部取自 `cloud.*`（票据副本）或那一次过滤后的行。`RuntimeWorktreeRecord` 的其余字段（id/repoId/displayName/lineage/linkedLinearIssue…）不进应答。无 `context.cloud` 展开进回包的路径（全仓 `context.cloud` 读取点只有 workspace-info 与 project-provision 两处，都无 spread） |
| ① 查询参数不可被票据域外的值影响 | 唯一参数是 `` `path:${cloud.projectRoot}` ``（`workspace-info.ts:72`），`cloud` 来自 `device.cloudSession`（`runtime-rpc-websocket-dispatch.ts:88`），其行由**验签后的票据**在云准入写入（`cloud-upgrade-admission.ts:219-227` 先以 `isCanonicalSignedRoot` 拒绝含 `..`/非规范形态的 projectRoot/workspaceRoot，`device-registry-entry-validators.ts:96` 读取时再过滤 permissions）。方法 `params: null`（`core.ts` 的 `RpcParsedParams<void>` 让 handler 拿不到第一个参数；`dispatcher-request-parsing.ts:18` 对 `params: null` 直接丢弃客户端 params）——单测「无参数方法」实证传入 `{projectRoot:'/etc',workspaceRoot:'/'}` 不改变应答 |
| ① 选择器无注入面 | `path:` 前缀在 `selectReposBySelector`（`orca-runtime-resolve-worktree-selector.ts:150`）里是**精确相等**匹配（`runtimePathsEqual`），无二次解析；票据根不是已注册 repo 时抛 `repo_not_found` → handler `catch` → `path/branch=null`（fail-closed 的「未 ensure」语义，设计 §3.2 授权） |
| ① 不扩大已知共享边界 | `worktree.list` 对云会话本就按 repo 粒度放行（`worktree-catalog-methods.ts:40` 调同一 `listManagedWorktrees`，`checkRepoScopedRead` 只验 repo 在 projectRoot 内）；workspace.info 用**同一 runtime 入口、同一可见性/分页语义**，再过滤到 workspaceRoot 内第一行——是 `worktree.list` 可见集的子集，不是第二套更宽的读路径。design.md §7.3 的「`workspace.info` 为显式登记的自省方法」与 W13 §3.3 的共享边界记录一致 |
| ② 云权限表零改动 | `cloud-rpc-permission.ts` 不在 12 文件内；`SESSION_METHODS = new Set(['status.get','workspace.info'])` 是 `e5ee5a53f53` 的既有行（`git log -S` 核实）；平台契约 `cloud-platform/packages/contract/src/permissions.ts:51` 的 `{ method: 'workspace.info', permission: null }` 同为既有行，平台侧零改动。`cloudMethodDenial`（`rpc-caller-scope.ts`）对 `'session'` 直接放行——任何通过准入的云会话（含仅 `open` 权限者）可调，与 W13 §5.1 一致 |
| ③ CLOUD_SESSION_REQUIRED 不可伪造绕过 | 云上下文唯一注入点是 `runtime-rpc-websocket-dispatch.ts:244-253`，来源 `device.cloudSession`——注册表行只由云准入（验签票据 + host/aud 绑定 + 规范根校验 + 吊销四查）写入，配对/mobile/owner 设备行没有该字段。`callerScope` 同样由该行推导（`:90-96`），与请求字段无关；请求必带与 socket 绑定的 deviceToken（`:62-85` mismatch 即 `unauthorized`）。owner（`scope.kind==='owner'` 短路）、runtime-paired（`'workspace'` ∈ `RUNTIME_PAIRED_STANDARD`）、ssh-bridge（`remoteCliControl && permission==='workspace'`）三类非云调用方都会进入 handler 然后拿到 in-band `{ok:false,code:'CLOUD_SESSION_REQUIRED'}` 普通回包；mobile 不在 `MOBILE_RPC_METHOD_ALLOWLIST` → `forbidden`。拒绝细节只在 `callerScope.kind==='cloud'` 时计算（`rpc-request-admission-prologue.ts:51-56`），所以非云拒绝**不产生云拒绝审计**——单测 2 例 + 真栈 W13A-5（全程 `hostDenials: []`）实证 |
| ④ `perms` 泄漏面 | `CloudRpcSession`（`core.ts:33-41`）是 `RpcContext` 上的宿主内部类型，全仓消费方仅 `workspace-info.ts`、`project-provision.ts` 与注入点本身，无任何 wire 序列化路径；应答里的 perms 是 handler 显式 `[...cloud.perms]`（票据已签给该会话的字段回显，无增量）。注入处 `perms: [...cloudSession.permissions]`（`runtime-rpc-websocket-dispatch.ts:252`）是防御性拷贝，注册表数组不与 handler 可见回包别名 |

### 发现

**MIN-1（minor）`CLOUD_HOST_METHODS` 提升后留下三处漂移面，且无测试把 `cloudAdmissionOption().methods` 绑定到该常量**

- ① `src/renderer/src/cloud-admin/cloud-admin-session.e2e.test.ts:305-306` 的注释「The table a cloud-admitted host installs (cloudAdmissionOption)」**已失真**：它手写的 `[...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS, ...PROJECT_PROVISION_METHODS]` 不含 workspace.info，而生产装配（`cloudAdmissionOption` → `main-process-runtime-launch.ts:94`）现在含。该套件若未来调用 workspace.info 会得到 `method_not_found`，与生产行为分叉。
- ② `cloud-project-provisioning.test.ts:107`、`cloud-self-service-project-fixture.ts:143`、`cloud-project-archive-fixture.ts:163`、`cloud-provision-recovery-fixture.ts:168` 四处继续手写同一旧组合——作为「W13a 之前的云宿主」形态模拟可以接受（它们不调 workspace.info），但仓里现在同时存在「云宿主表」的两种权威写法，下一个新套件照抄旧组合的概率不低。
- ③ 真栈套件 `cloud-workspace-info-real-host.test.ts:129` 注释「The exact table cloudAdmissionOption installs」成立的方式是**引用同一常量**，而非驱动 `cloudAdmissionOption` 本身；若未来 `cloudAdmissionOption` 改回内联组合或漏掉某张表，真栈套件不会红（`cloud-runtime-admission-env.test.ts:169` 只断言 `upgradeAdmission` 缺席，不断言 `methods`）。
- 收口建议（三选一或组合）：把 `cloud-admin-session.e2e.test.ts` 的表换成 `CLOUD_HOST_METHODS` 并删失真注释；给 `cloudAdmissionOption({ORCA_CLOUD_API_URL}).methods` 加一条 `toBe(CLOUD_HOST_METHODS)` 绑定断言；四处夹具加一行「pre-W13a host table（不含 workspace.info）」注释说明是有意的旧形态。

**MIN-2（minor）`findWorkspaceCheckout` 的 `catch { return null }` 把内部故障与「未 ensure」折叠为同一应答，且无日志**

- `workspace-info.ts:69-74` 吞掉 `listManagedWorktrees` 的一切 rejection：`repo_not_found`（设计授权的「未 ensure」）与 `selector_ambiguous`、存储错误、scan 超时链路异常不可区分，宿主侧零痕迹。设计 §3.4 授权了「扫描失败按未 ensure 应答」的语义，行为本身合规；缺口只在可观测性。`project.provision` 对意外失败有 `console.warn` 先例（`project-provision.ts:37`），且其「不回传细节」的理由（repoUrl 可能进平台审计）在 workspace.info 不成立——这里不产生任何平台报告，本地 warn 无泄漏面。建议 `catch` 里区分预期（repo 未注册）与非预期（其余 warn 一行）。

**MIN-3（minor）`CloudWorkspacePermission` 是权限联合的第三份拷贝，无 parity 钉**

- `src/shared/cloud-workspace-info.ts:10-18` 复制了 `CloudPermission` 联合（contract `credential.ts` / 宿主 `cloud-credential.ts` 各一份）。`src/shared` 不能 import `src/main`，复制有理由；但 `cloud-admission-parity.test.ts` 只对齐凭证验证，不对齐权限联合——平台新增一种权限后，读取器会静默过滤掉它（`PERMISSIONS.has` 过滤，`cloud-workspace-info.ts:96-100`），W13b 渲染层拿到的 perms 比票据少，权限感知降级悄悄变保守且无任何红。建议在 parity 测试里加一条「contract Permission 联合 ⊆ 该 Set」断言（或以类型级 `satisfies` 双向钉住）。

**MIN-4（minor）§5.2.1 的三条非云负向（mobile / 配对桌面 / CLI）均未测试**

- 单测的非云例只打 `owner` scope；真栈套件只打云会话与一个对 `ALL_RPC_METHODS` 的合成 legacy dispatcher。`mobile → forbidden`、`runtime-paired → in-band 拒绝`、`ssh-bridge → in-band 拒绝` 三条是本提交新行为的拒绝形态，目前靠代码走查成立。设计 §8 把「越权负向补全」划给 W13c，故降为 minor 而非 major；建议 W13c 早期补 mobile（`forbidden`）与 runtime-paired 两例即可覆盖形态差异。

---

## 2. 一致性

### 确认的正确面

| 项 | 证据 |
| --- | --- |
| 与 project.provision 范本同构 | 并排核对：独立 `*_METHODS` 表、`permission: 'workspace'`、`params: null`、`CLOUD_SESSION_REQUIRED` in-band 拒绝（消息文本逐字节相同）、kept-out-of-`ALL_RPC_METHODS` 的平行注释。两处有意差异均合规：workspace.info 不调 `cloudReportProvision`（只读自省无平台报告，注释言明），拒绝不需要错误码脱敏（不回传 repoUrl） |
| `isInsideWorkspaceRoot` 提升行为不变 | `git show f160524e19d -- src/shared/cloud-workspace-open.ts`：函数体逐字节未动，只有改名 + 4 行文档注释；文件内两处调用点（`existingWorkspacePath`）同步改名。旧名 `isInside` 是模块私有，全仓无其它消费方（`appimage-runtime-identity.ts`/`wsl-contained-delete.ts` 的同名函数是无关的独立实现）。打开流程（provision→list→createManaged 的幂等键路径）不经过任何行为分叉。新增 2 例单测覆盖兄弟目录/前缀伪装/尾分隔符根 |
| `cloudAdmissionOption` 逐字节不变（除授权增量） | diff 对照：原局部 `const methods = [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS, ...PROJECT_PROVISION_METHODS]` 提升为 `CLOUD_HOST_METHODS`（`cloud-runtime-admission.ts:337-342`），三个 spread 的**顺序与成员完全一致**，唯一 delta 是追加的 `...WORKSPACE_INFO_METHODS`；返回对象的其余三字段（`webSocketTls`/`upgradeAdmission`/`connectionGate`）与 §8.3 注释未动。W7c 的裁定对象（云权限表）零改动，登记表扩展是 W13 §0.1/§3.1 明文授权的例外，且与既有两张云表同一先例 |
| 混合版本语义 | 云会话在老宿主上：`cloudMethodDenial` 先放行（session 级）→ `registry.get` 落空 → `method_not_found`（`rpc-request-admission-prologue.ts:58-63`），不是 `forbidden`——W13 §3.4 要求的「明确归因宿主早于 W13」成立，真栈 W13A-4 实证（含 `hasWorkspaceInfo(ALL_RPC_METHODS)===false`） |

### 发现（note 级，见 §4）

- NOTE-1：`list` 走 `buildWorktreeListingPage(worktrees, 200, …)` 默认页 + 自定义可见性源过滤，>200 worktree 的仓库或被可见性规则隐藏的检出会让 `workspace.path` 对真实存在的检出返回 null——fail-closed、与 `worktree.list` 同视图，无泄漏，仅语义上「未 ensure」与「被分页/可见性挡住」不可区分。
- NOTE-2：`runtime-managed-worktree-queries` 的扫描缓存（约 30s TTL）会让 path/branch 短暂滞后；与 worktree.list、以及 W13b 客户端 ensure 流程读的是同一份数据，方向一致。

---

## 3. 规范（AGENTS.md / STYLEGATE）

| 项 | 结论 |
| --- | --- |
| max-lines | `cloud-runtime-admission.ts` 有效行数（跳过空行与注释）**292 / 300**（本提交 +13）；`workspace-info.ts` 66、`cloud-workspace-info.ts` 79。全文件 oxlint exit 0，无任何 max-lines disable（AGENTS.md 红线未触）。**余量仅 8 行**——下一笔进该文件的改动大概率需要先拆表（见 NOTE-4） |
| 命名 | `workspace-info.ts` 镜像 `project-provision.ts`；`cloud-workspace-info.ts` 是响应契约（与设计 §4.2 表一致）；无 generic 名。测试文件命名与被测对象对齐 |
| 注释 | 三个新源文件的注释都是 WHY 型且短（方法表为何不入 ALL、ticket 是唯一地址源、porcelain ref → 分支名、path/branch 的 null 语义、防御性拷贝理由）；无行走式解说 |
| 类型断言 | 新源码零断言；测试里唯一一处 `partial as unknown as OrcaRuntimeService` 带 `SAFETY:` 行内说明（`workspace-info.test.ts:70-71`），`as const` 用于方法表（白名单例外） |
| 跨平台 / SSH / folder workspace | `isInsideWorkspaceRoot` 保留 `\\` 与尾分隔符分支（Windows 盘符根）；folder workspace 行 `branch: ''` → `branchOfHeadRef('')` → null（`repo-worktree-row-resolution.ts:85`、`runtime-folder-workspace.ts:42` 核实）；真栈套件用 `realpathSync` 对齐 macOS `/private` 前缀；SSH 场景下 repo 扫描失败按未 ensure 处理，不假设本地执行 |
| diff 归属 | 12 文件逐一核对，全部属于 W13a 域（宿主方法 + 共享契约 + 登记扩展 + 测试 + node 池登记），无 PROGRESS/文档/无关文件卷入（对照 PROGRESS 近期三条「归属注记」事故，本提交干净）。`terminal-multiplex-cloud-boundary-stream-error.test.ts`（3 行）与 `runtime-rpc-websocket-dispatch.ts`（4 行）是 `CloudRpcSession` 加 `perms` 字段的强制连带，归属成立 |
| 提交切分 | W13 §6.2 允许「宿主方法 + 共享契约 + 单测/真栈测试同提交」，本提交遵守；范围与 §8 的 W13a 行（宿主 src/main + 共享契约 + 真栈套件入 node 池）一致，无 renderer 越界 |

---

## 4. 测试质量

### 计数核对（任务前提「34 例」的来源）

- 交付门禁日志（`evidence/w13a-workspace-info/w13a-gates.txt`）的「Tests 34 passed」= **4 个相关文件的全量执行数**：`workspace-info.test.ts` 10 + `cloud-workspace-info.test.ts` 11（3 it + it.each 8 行）+ `cloud-workspace-open.test.ts` 8（**其中 6 例是既有例**）+ 真栈 5。
- **本提交实际新增 28 例**（声明 21 处：10 + 4 + 2 + 5）。PROGRESS 交付注记写的「宿主 10 + 读取器 11 + 真栈 5 = 26」漏数了 `cloud-workspace-open.test.ts` 的 2 例新增。
- 本机复跑：3 个单测文件 29/29（428ms）、真栈 5/5（node 池 4.55s）、`src/main/cloud-platform` 全目录 349 passed|4 skipped 0 红、`pnpm tc` exit 0。真栈 5 例**确已入 node 池**：`NODE_RUNTIME_INCLUDE` 新增条目带 W5b-B1/W9A7-MAJ-1 同型注释；`config/vitest.config.ts` 里 bun 项目 `exclude: [...NODE_RUNTIME_INCLUDE]`、node-runtime 项目以 `nodeRuntimePool` 跑同一清单——bun 池永不执行、node 池必执行，W9A-7 MAJ-1 的教训已闭合。

### 可变红性推理（重点：白名单键集测试是否真能防字段扩张）

- **真防**：`workspace-info.test.ts:130-170` 先对整个应答 `toEqual`（深层全等，多吐**任何一级**字段即红），再对顶层/`project`/`workspace` 三层分别断言键集恰等；真栈 W13A-1 独立再钉一次顶层键集。给 handler 加一个字段 → 单测第一断言即红；改票据→应答的映射（如回宿主根而非票据根）→ `toEqual` 对 CLOUD 常量红。查询形态被 `toHaveBeenCalledWith('path:<projectRoot>')` 钉住。**字段扩张的变异红成立**。
- 读取器层（`cloud-workspace-info.test.ts`）的 it.each 覆盖缺字段/错型 8 种，但**不含「多余未知键」用例**——读取器对未知顶层键宽容（只挑文档字段）。这与白名单是单向分工：白名单由宿主单测钉住，读取器只拒「缺/错」不拒「多」。方向上兼容「旧宿主加字段不炸新 web」的线兼容要求（AGENTS.md Remote Wire Compatibility），维持现状合理，但取舍应记档（NOTE-3）。

### 缺哪些负向（建议清单，按优先级）

1. mobile 调用 → `forbidden`（allowlist）；runtime-paired 调用 → in-band `CLOUD_SESSION_REQUIRED`（MIN-4）。
2. `cloudAdmissionOption().methods` 与 `CLOUD_HOST_METHODS` 的绑定断言（MIN-1③）。
3. 权限联合 parity 断言（MIN-3）。
4. 「无参数方法」例补一行 `expect(listManagedWorktrees).toHaveBeenCalledWith('path:<projectRoot>')`——目前只断言应答不变，未断言该场景下查询仍取票据根（NOTE-5）。
5. perms 防御性拷贝无测试：handler 变异 `context.cloud.perms` 时注册表行不被污染（现在是注释声明，非断言；NOTE-6）。
6. 真栈老宿主证明目前是对 `ALL_RPC_METHODS` 的合成 dispatcher 近似，未起真老宿主 socket（NOTE-8；设计 §6.1 的「真宿主方法表」层以此近似可接受）。

### NOTE 清单

- **NOTE-1** 截断/可见性过滤下 `workspace.path` 可能对真实存在的检出返回 null（默认页 200 + 自定义可见性源）；fail-closed、与 worktree.list 同视图，无泄漏，仅语义不可区分。
- **NOTE-2** 扫描缓存使 path/branch 短暂滞后（与客户端 ensure 读同一数据源，方向一致）。
- **NOTE-3** `readCloudWorkspaceInfo` 对多余未知键宽容——单向白名单的取舍宜记档。
- **NOTE-4** `readCloudWorkspaceInfo` 在本提交内无生产消费方（W13b 才接线），属分阶段交付的预期空档；若 W13b 弃用应删除。
- **NOTE-5** `cloud-runtime-admission.ts` 有效行数余量 8 行（292/300）。
- **NOTE-6** design §3.2 的 branch「`git rev-parse` 级读取（加超时）」被实现为读取 `listManagedWorktrees` 扫描行（扫描自身有 `withTimeout` + 落库回退）：功能等价——真栈证据 `w13a-2-after-ensure.json` 的 branch `e2e/main` 与 `git rev-parse --abbrev-ref HEAD` 一致（含斜杠分支这一 prefix 处理最难例），且少一次子进程。与设计字面的偏差宜在 PROGRESS 记一行。
- **NOTE-7** `workspaceRoot` 若被平台铸成与 projectRoot 相等，`workspace.path` 可见集退化为整个 repo 的检出——复现的是 W13 §3.3 已记录并接受的共享边界，不是本提交扩面。
- **NOTE-8** W13A-4 的「老宿主」为合成 dispatcher 近似（见缺负向 6）。
- **NOTE-9** 邻居套件 `cloud-workspace-ensure.test.ts`(3 例)/`cloud-project-provisioning.test.ts`(2 例) 在 bun 池因自签 TLS 红（W5b-B1 家族，**预存在**，开发已用 stash 复现归因；本机目录复跑 node 池 0 红佐证），且未入 `NODE_RUNTIME_INCLUDE`。W13b 的 web 流程要调 ensure，届时建议随 W13b/W13c 一并入池。
- **NOTE-10** 本机独立复跑目录套件 349 passed|4 skipped，开发证据 351 passed|2 skipped——两端 0 失败，skipped 差 2 例为环境条件跳过，无红。
- **NOTE-11** `branchOfHeadRef` 对非 `refs/heads/` 的引用（如 detached 的空串以外的裸 ref）原样返回；托管检出的 porcelain 分支恒为 `refs/heads/*` 或空（`git-worktree-porcelain-parser.ts:34`），folder workspace 恒空串——当前无形态能产生误导性输出，留档备查。

---

## 收口顺序建议

1. MIN-1①（cloud-admin e2e 失真注释 + 换用 `CLOUD_HOST_METHODS`）——一行级改动，随 W13b 或 W13c。
2. MIN-2（`catch` 内区分预期/非预期 + 一行 warn）。
3. MIN-3（parity 断言）与 MIN-4（mobile/runtime-paired 两例）随 W13c 越权负向批次。
4. NOTE-5/6（max-lines 余量、branch 取法偏差记档）在 W13b 动工前知会即可。
