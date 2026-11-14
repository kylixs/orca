# W5b 审计报告（详情页终端 e2e + PTY 回显断言修复）

- 审计人：独立审计代理（只读；未修改任何仓库文件，本报告为唯一产出文件）
- 日期：2026-11-14
- 审计对象：`5a1746b869e`（test(e2e): admin workspace terminal over real pty，4 文件 +279/−18）与 `4ffbc3860dc`（test(e2e): make the pty echo assertion real under the default runner，1 文件 +29/−11）；均无 amend，现行 HEAD（`8aa481eb5ee`）即被审代码
- 对照基准：work-orders-2026-11-14.md §W5b / §W5a / §W5c、design.md §7.3（权限表）、design-adjustment-native-ui.md（project.provision=`open`）、AGENTS.md（复用优先 / 注释 / 命名 / 禁 max-lines / 类型断言 / SSH 与跨端 / 线兼容）
- 方法：只读 diff 审查 + 现行源码逐行核对（dispatch 作用域判定、`cloud-rpc-permission` 映射表、`cloud-path-guard`/`cloud-terminal-scope`/`cloud-worktree-scope`/`cloud-git-scope`/`cloud-agent-scope` 各族守卫、`admitRpcRequest` 拒绝链、`terminal.read` 回包形状、registry adoption 与 validator）；证据交叉印证 `cloud-platform/evidence/w5b-terminal-e2e/`、`w5b-fixes/`、`w5b-verify/`、`m34-cloud-rpc-scope/w5b-1-mobile-scoped-row.json`（各目录内 `12-commit.txt`/`05-commit.txt` 与被审哈希一致）

## 结论

**有条件通过（安全语义成立，两条 major 均为工程归属/门禁问题，不阻塞合入但应在收口前处理）**：blocker 0、major 2、minor 5、note 9。

核心判定：**票据优先于行 scope 的映射语义正确且是净收紧**。生产唯一 adoption 调用点从不传 `scope`（默认 `runtime`），真手机/配对桌面行永远不会携带 `cloudSession`，故判定顺序翻转对它们零影响（probe3 实证：修复后真手机行 `worktree.list`/`files.delete` 仍按 phone 允许清单拒绝）；而被翻转影响的「cloudSession + scope=mobile」陈旧行，旧行为反而更弱——phone 允许清单含 `settings.update`，裸拒绝无详情无审计，RED 日志实证修复前该调用穿透到 handler（`runtime_unavailable`）。修复后走票据映射：缺权限 → `PERMISSION_MISSING`、未登记 → `METHOD_NOT_AVAILABLE`，四种拒绝码全部进 `method_denied` 审计，`code` 保持 `forbidden` 线兼容。映射表本身默认拒绝完整（terminal./worktree./files./git./agent. 各族均 fail-closed），`project.provision→open` 与设计修订文档一致且 handler 只读票据上下文。

两条 major：**MAJ-1** `5a1746b869e` 把 `web-cloud-handoff-entry.e2e.test.ts` 加入 tc:web exclude，但未按 `tsconfig.cloud-e2e.json` 自述的所有权把它加进该项目 include——该 spec 从此不被任何 typecheck 工程覆盖（tc.web 排除、cloud-e2e 缺席、node/cli 均未列出），属门静默收窄，且是 W7b 文件的越令改动；**MAJ-2** 归属链断裂：宿主 dispatch 安全路径行为变更被打进 `test(e2e)` 类型提交、落在「仅测试工程」的 W5b 令内，而 B1（node-runtime 池声明）这一半实际落在被审对之外的 `docs(cloud)` 标题提交 `3d358f207cc`（W9a 读数）里——`4ffbc3860dc` 消息称其 "committed with the parallel W5c sweep" 与事实不符（入树点是 W9a docs 提交），且 PROGRESS.md 已就同型事故（`48939e14c83`）写过归属注记，属复发。

---

## 1. 方法映射语义（核心）

### 确认的正确面

| 项 | 证据 |
| --- | --- |
| 判定顺序翻转的语义 | `runtime-rpc-websocket-dispatch.ts:88-99`：`cloudSession ? cloud : device.scope==='mobile' ? mobile : runtime-paired`。票据（平台签名的 perms+roots）成为云会话唯一权威；行 scope 只为无票据设备保留 |
| 真手机零变化 | 生产唯一 `adoptCloudDevice` 调用点 `cloud-runtime-admission.ts:67` 不传 `scope` → 默认 `'runtime'`；手机配对行（`device-registry.ts` 默认 `'mobile'`）从不携带 `cloudSession`。probe3（w5b-verify）：修复后真手机行 `worktree.list`→"not available to mobile clients"、`files.delete` 同拒、`terminal.create` 放行、`newDenials:[]`——phone 语义逐项不变 |
| 陈旧行按票据判定 | 提交内回归 `cloud-rpc-scope.test.ts` W5b-1（注入 `{scope:'mobile'}` 模拟陈旧行）：`settings.update` 拒绝且消息点名 cloud 规则、审计含 `{method:'settings.update', denial:'METHOD_NOT_AVAILABLE'}`；证据 `m34-cloud-rpc-scope/w5b-1-mobile-scoped-row.json` 实测一致（list/terminal 由路径边界拒绝，消息均为 cloud 语义） |
| 陈旧行来源可信 | `normalizeDeviceEntry`（device-registry-entry-validators.ts:37-39）把一切非 `'runtime'` scope 归一为 `'mobile'`——注册表里任何历史/异体值都会在加载时变成 mobile，与「stale or downgraded registry entry」前提吻合 |
| 权限点映射完整性 | `cloud-rpc-permission.ts` 对照 design §7.3：`terminal.`→terminal、`git.`→terminal（随 terminal 授予）、`agent.*`族→agent、files 读/写两张精确集合、`worktree.*`→terminal、`repo.add`/`project.provision`→open、`browser.*`→browser、下载五方法→download（且 §9.3 策略可越票据关断）。**默认拒绝成立**：未登记方法→null→拒绝 |
| 各族 fail-closed | `cloud-terminal-scope`（未分类 `terminal.*` 一律 deny）、`cloud-worktree-scope`（未分类 `worktree.*` deny；`worktree.create` 显式 deny）、`cloud-path-guard.ts:155-166`（未声明路径参数的 `files.*` 拒绝 path_unverifiable）、`cloud-git-scope`（非读即写）、`cloud-agent-scope`（未分类 deny）。新增 RPC 不可能静默获得云会话可达性 |
| `worktree.list` 语义 | 允许但 repo 钉在票据项目根（`checkRepoScopedRead`），不是越权读目录 |

### 发现

**MAJ-2（major）宿主安全路径变更的提交归属断裂，被审对不自含其声称的修复**

- `5a1746b869e` 类型为 `test(e2e)`，却承载生产 dispatch 行为变更（作用域判定）；W5b 令写明「仅测试工程」，findings.json 自述令名为「测试工程 + 宿主侧缺口」（自扩边界，未回写 work-orders）。
- `4ffbc3860dc` 消息称 runner 声明（B1 的一半）"committed with the parallel W5c sweep"，实际入树点是 `3d358f207cc`——标题 `docs(cloud): W9a first lifeline reading`，内容却含 `config/scripts/vitest-node-runtime-files.mjs`（+4）与本测试文件（+4）的非 docs 改动。审计这对提交时必须引用第三个提交才能拼出完整的 B1+B2 故事。
- 这与 PROGRESS.md 为 `48939e14c83`（docs 实含测试文件）写下的归属注记是同一模式复发。建议：宿主 dispatch 变更与 runner 声明各得独立、类型正确的提交；至少在 work-orders/PROGRESS 补一条指认（该仓先例即如此处置）。
- 不阻塞的理由：变更本身在提交消息中如实披露、证据钉住了确切哈希（`12-commit.txt`/`05-commit.txt`）、代码语义正确。

**MIN-3（minor）`5a1746b869e` 提交消息两处不精确**

- 「the phone allowlist … refuses project.provision and **worktree.*** by name」：allowlist 实际含大多数 `worktree.*`（ps/set/activate/rm/create/sleep 等），缺席的只有 `worktree.list`/`detectedList`/`createManaged`；测试内注释（"has no worktree.list"）是准确的，提交消息以偏概全。
- 「tc:web excludes … **restoring a green tc:web**」：基线红日志（`08-tcweb-baseline-red.log`）唯一错误是 `cloud-login-entry.tsx` TS2305——本提交未触碰的文件（属并行 W7b 通道，后由 `4be77d3ce55` 修复）。07/08 对照不是本次 tsconfig 改动的受控 A/B，绿可能部分归功于并行通道的在途修复。

**MIN-4（minor）陈旧 scope 行本身无修复路径，残留 client-side 语义**

- 修复改的是判定，不改行：`clientKind: device.scope`（payload diet）、`updateClientCapabilities` 门（`scope==='mobile'`）、`status.get` 回执的 `deviceScope` 仍读行 scope。携带陈旧 mobile 行的云 web/管理台会话会继续被按手机裁剪载荷。功能性问题非安全问题；可考虑 adoption/加载时按「有 cloudSession ⇒ scope 归一 runtime」收口。

**MIN-5（minor）`PROJECT_METHODS` 注释与实现不符**

- `cloud-rpc-permission.ts:72-76` 称 "the path guard pins the argument"，但 `project.provision` 不在 `PROJECT_ROOT_METHODS`（只有 `repo.add`），也不属任何守卫族——它**不过**路径守卫；约束实际来自 handler 只读票据上下文（`project-provision.ts`：无 `context.cloud` 即 `CLOUD_SESSION_REQUIRED`，路径/URL/分支全部取自票据）。安全上成立（见 N1），但安全注释名错机制，应改写。

## 2. 安全（拒绝路径与越权）

### 确认的正确面

| 项 | 证据 |
| --- | --- |
| 拒绝带详情与审计 | `admitRpcRequest`（rpc-request-admission-prologue.ts:41-53）：cloud 作用域拒绝一律经 `methodDenialDetails` → `onCloudDenial` → `cloudAuditSink`。四码齐全：PERMISSION_MISSING / METHOD_NOT_AVAILABLE / DOWNLOAD_DISABLED / PATH_OUTSIDE_ROOT（路径分支在 dispatch 内独立审计）。生产接线存在：`attachCloudRuntime` → `setCloudHostAudit(reportAudit)`；两个被审测试分别以 sink 捕获与平台 `/v1/audit/events` 端到端断言 |
| 旧路径确实是弱面 | 03 号 RED 日志：修复前 `settings.update` 自 mobile-scoped 云行**穿透到 handler**（`runtime_unavailable`）；修复后同调用 `forbidden` + METHOD_NOT_AVAILABLE + 审计。即本变更是净收紧，不是放行 |
| 无越权放行 | 翻转只影响「同时携带平台签名票据」的行；票据 perms 由平台准入签发，宿主仍逐方法执行（§1 表）。phone/配对桌面路径逐字节未动（probe3） |
| `code` 线兼容 | 拒绝顶层码保持 `forbidden`，详情走 `error.data`（cloud-denial-details.ts 注释即为此设计）；旧客户端语义不变 |

### 发现

**N1（note）`project.provision → open` 是设计规定的门槛，实现吻合且不可参数注入**

design-adjustment-native-ui.md 明文：「新增云端专用 RPC `project.provision`（**`open` 权限**）。路径/URL/分支全部取自签名票据，不接受客户端参数；已是 git 仓库 → 直接返回」。实现：handler 拒绝非云调用者、只用 `cloud.projectRoot/repoUrl/defaultBranch`、失败消息脱敏（不回显可能含凭证的 URL）、结果经 `cloudReportProvision` 上报。审计清单问「provision 是写操作，open 是否正确门槛」：按设计文档，正确——open 是准入会话必持权限，provision 幂等且写入被钉在票据自身 projectRoot；副作用是有 open 无任何其他权限的观察者可触发一次 clone/校验，属设计接受且资源有界的动作。唯一保留意见即 MIN-5 的注释失准。

**N2（note）W5b-2 的拒绝-审计断言是端到端的**

viewer（open+file:read）`terminal.create` → `forbidden`+"'terminal'"、非 mobile 措辞；平台 `/v1/audit/events?eventType=host.method_denied` 实查到 `PERMISSION_MISSING` 记录。占位态数据断言（permissions 含 open/file:read、无 terminal、无 workspacePath）与「无授权占位」令条对齐。

## 3. 回显断言真实性（RED 复核）

### 修复前断言确实不可能红（代码级证实）

- 旧 helper 读 `readField(last.result, 'tail')`，而 `terminal.read` handler 回包是 `{ terminal: await runtime.readTerminal(...) }`（terminal-query-methods.ts:74-81），`tail: string[]` 嵌在 `result.terminal` 下——`result.tail` 恒 undefined，循环永不命中；
- 超时分支 `return last ?? {...}`：静默 PTY 下 `last` 是最后一条 **ok** 回复，外层 `expect(read.ok).toBe(true)` 照样通过——空缓冲跑绿，双重不可失败。

### 修复后 RED/GREEN 证据复核

| 断言 | 证据 | 判定 |
| --- | --- | --- |
| 可红（fail-closed） | `w5b-fixes/01-pty-echo-RED-bun-silent-pty.log`：修复后代码在静默 PTY 池（bun）下跑，初始+3 次重发共 32.4s 后 `ECHO_TIMEOUT`、`last tail=[]`，`expect(read.ok)` 与 marker 包含断言双红 | 成立 |
| 默认跑法绿且回显真实 | `02`（bun 启动器 → node-runtime 池）4/4 绿；`03` node 直跑绿；`04-echo-evidence-tail.json` 存有 shell 自身回显 `tail:["echo ORCA_W5B_PTY_ECHO_OK"]`、`source:"stream"` | 成立 |
| B1 机制成立 | `terminal.read` 嵌套形状与 `tail: string[]`（terminal-tail-read.ts）逐行核对；真 PTY 由 `cloud-terminal-e2e-fixture.ts`（node-pty 真壳）提供；runner 声明见 `vitest-node-runtime-files.mjs:15-18`（含 Why 注释） | 成立 |
| 提交状态绿 | `06-committed-state-green-default-runner.log`（staged 态 3/3）、`10-committed-suites-green.log`（2 文件 8/8：本套件 3 + cloud-rpc-scope 5）；测试数与 HEAD 逐一致（12:45 RED 日志的 4 tests = 工作树含在途 W5c-1，06 的 3 = stash 后提交态，账目闭合） | 成立 |

**MIN-1（minor）首个提交的「without-fix RED」日志与提交版断言集不对应**

`03-cloud-rpc-scope-without-fix-RED.log`（11:22）失败点在 settings 行（306-308），而提交版 W5b-1 若回退修复会先死在 `worktree.list` 的 `not.toContain('not available to mobile clients')`（291 行，mobile 拒绝消息必然含该短语）——两者行号还差 2 行。即该 RED 针对的是更早迭代（findings.json 也只引 settings 翻转为红）。提交版里真正区分修复前后的 `worktree.list`/`terminal.create` 措辞断言没有留下实跑红记录，区分力目前是分析性的。建议补跑一次 revert-then-run 留档（2 分钟成本）。

**MIN-2（minor）提交内回归只钉「拒绝措辞」，不钉「放行」**

W5b-1 三个 RPC 断言全部预期 `ok:false`（harness 无真实 checkout，路径边界拒绝），故它验证的是「拒绝来自宿主自身边界而非按名」，无法发现「陈旧行被错误整体拒绝」类回归；放行面（票据 perms 下 `worktree.list`/`terminal.create` 成功、`files.readDir` 缺权限拒绝）目前只有未提交的 probe4 探针证据。建议后续把正例并回可提交测试。

### 重发循环（至多 3 次）稳定性评估

**N6（note）有界、不弱化、无掩蔽**

- 预算：初始 8s + 3×8s = ≤32s，远小于该用例 120s 超时；红的速度变慢（最多多 24s）但不会假绿。
- 通过条件未变：仍要求 marker 出现在**宿主真实回包**里，末尾再补一条 `JSON.stringify(read)` 含 marker 的独立断言（双保险）。
- 重发内容 `\necho MARKER\n`：前导换行保证落在新鲜提示符行；多次发送只产生重复回显，不影响判定。
- 01 号日志即「预算打满仍红」的实证（32.4s），闭环。

## 4. 规范与归属

**MAJ-1（major）tc:web 排除造成 spec 脱离全部 typecheck 工程覆盖**

- `config/tsconfig.tc.web.json:58` 排除 `web-cloud-handoff-entry.e2e.test.ts`（`@vitest-environment node`，import 主进程夹具——正是 cloud-e2e 工程注释里自述拥有的那类文件），但 `config/tsconfig.cloud-e2e.json` include 的「The eight specs」没有它（工作树亦未补，已核实 `git diff HEAD -- config/` 为空）；`tsconfig.node.json`/`tc.cli` 均未列出。`pnpm tc` 链（run-typecheck-projects-in-parallel 含 cloud-e2e）从此不查该文件。
- 该文件属 W7b（`3d9a22b5f5f` 创建），改动本身越 W5b 令；findings.json 自称「ENV-1 顺手项」。修复是一行：把它加进 cloud-e2e include（与提交消息「config/tsconfig.cloud-e2e.json owns them」的既有约定一致）。

**N7（note）其余 AGENTS.md 项干净**

- max-lines：被审文件无任何 disable；测试文件预算 800（skipComments/skipBlankLines），HEAD 744 行在内（工作树 +230 行的 W5c 在途部分是 W5c 通道的预算问题，不属本审对象）。
- 命名：新增标识符（`W5B_EVIDENCE_DIR`/`saveW5bEvidence`/`hostMethodDenials`/`mobileRowProjectId`/`waitForTerminalLine`）均为具体域名词，无 helpers/utils 类。
- 类型断言：仅 `({ scope: 'mobile' } as const)`，属允许的 `as const`。
- 注释风格：dispatch 新增注释讲「为什么票据先于行」（含 W5a 证据指认），非 walk-through。
- 跨端/SSH：变更面在云会话判定，SSH bridge / ssh-bridge 作用域分支未触碰；WSL/Windows 路径不涉。
- 线兼容：`code` 不变、`error.data` 为新增可选字段，符合「新可选字段安全」。

**N8（note）runner 声明方式本身不构成先例风险**

向 `NODE_RUNTIME_INCLUDE` 加条目 + 文件头注明 runner 约束是清单既有惯例（该条目还写明了 W5b 缺陷 B 的 Why）。风险集中在提交位置（MAJ-2），不在机制。隐含注意点：node-runtime 池条目使该 e2e 只在 node 下跑、bun 池显式排除——这是能力需求（node-pty 在 bun worker 静默）而非规避。

**N9（note）对令条交付项的覆盖核对**

| 令条要求 | 交付 |
| --- | --- |
| 输入回显 | W5b-1（真 PTY send→echo→视口→close）✔ |
| 文件树打开只读预览 | W5b-1 `previewCloudFile(README.md)` ✔ |
| 无授权占位 | W5b-2（占位数据态 + 拒绝审计）✔ |
| 文件面板零回归 | 既有 A/B 隔离两例保持绿（10 号日志 8/8）✔ |
| 扩展 cloud-admin-session e2e | ✔（3 it） |
| 证据 `evidence/w5b-terminal-e2e/` | ✔（含两提交哈希、正反 RED/GREEN、基线对照、findings.json） |
| 提交名 `test(e2e): admin workspace terminal and file preview` | 实际 `…over real pty`（措辞偏差，内容覆盖）△ |

## 证据索引

- `cloud-platform/evidence/w5b-terminal-e2e/`：03（cloud-rpc-scope 无修复红）、09/11（mobile scope 探针前后）、07/08（tc:web 绿/基线红）、10（提交态套件绿）、findings.json、12-commit.txt
- `cloud-platform/evidence/w5b-fixes/`：01（bun 静默 PTY 红）、02/03（默认跑法与 node 直跑绿）、04（回显证据 tail）、05-commit.txt、findings.json（含 B1/B2 根因与 stash 验证说明）
- `cloud-platform/evidence/w5b-verify/`：probe3（真手机行允许清单不变）、probe4（陈旧行按票据判定+审计）
- `cloud-platform/evidence/m34-cloud-rpc-scope/w5b-1-mobile-scoped-row.json`：提交内回归的实测回执

## 处置建议（按优先级）

1. MAJ-1：`web-cloud-handoff-entry.e2e.test.ts` 加入 `config/tsconfig.cloud-e2e.json` include（一行）。
2. MAJ-2：为宿主 dispatch 变更与 runner 声明补归属注记（work-orders 或 PROGRESS.md，按 `48939e14c83` 先例），后续同类变更独立成 `fix(cloud)` 提交。
3. MIN-1：补跑 revert-then-run 留下与提交版断言集对应的红记录。
4. MIN-2：把陈旧行的放行正例并入可提交测试。
5. MIN-4/MIN-5：adoption/加载时按 cloudSession 归一 scope（或至少修 `PROJECT_METHODS` 注释）。
