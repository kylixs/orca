# W12b-2 审计报告（U17 修复：首启自注册宿主的回报器/策略门时序）

- 审计人：独立审计代理（只读）
- 日期：2026-11-14
- 审计对象：提交 `a6d8d1fc7fa`（fix(cloud): install cloud provision reporter after enrollment，恰 3 文件 +654/−23）
  - `src/main/startup/cloud-runtime-attach.ts`（新，82 行）
  - `src/main/startup/cloud-runtime-admission.ts`（+15/−23，委托 + re-export + `CloudAccessGuard` 类型引用替换）
  - `src/main/startup/cloud-runtime-admission-attach.test.ts`（新，557 行，8 例）
- 对照基准：`work-orders/w12-provisioning-readiness-diagnosis.md` §2-B / §4 必修节 / §5.3；`cloud-platform/PROGRESS.md`「W12b-2 实现完成」节；`defect-ledger.md` U17
- 方法：只读 diff 逐 hunk 审阅 + 源码交叉验证（admission / attach / dispatch / guard / caller-scope / launch 五处）+ 门禁复跑（oxlint、`check:max-lines-ratchet`、`pnpm tc:node`）+ 隔离 worktree（`/tmp`，固定该提交）内复跑新套件与「还原旧时序」变异复现。主工作树源码零改动；临时 worktree 已删除。

## 结论

**PASS**：blocker 0、major 0、minor 2、note 5。

U17 时序缺口确实被该提交闭合，且三条规格路径（同步路径不回退 / ready 兑现补装 / 失败不装 + fail-closed）机制与测试均成立：

1. **同步路径不回退**：`attachRuntimeToCloudAdmission`（cloud-runtime-attach.ts:55-79）在 `admission.client` 非空时同步调 `installRuntimeCloudSurfaces`（:37-42，装 guard + provision reporter + host audit 三件）。poll 模式 `startPolling` 同步建 client（cloud-runtime-admission.ts:271-273）；stored-credential 重启时 `startEnrolled` 的 async IIFE 同步推进到首个 `await created.refresh()` 之前已完成 `client = created`（:183-238）——两条路 attach 当刻 client 均已在，与旧实现逐句等价。生产唯一调用点 `main-process-runtime-launch.ts:96 attachCloudRuntime(runtimeRpc)` 未动。
2. **ready 兑现后补装且只装一次**：else 分支 `admission.ready.then(() => { if (admission.client) installRuntimeCloudSurfaces(...) })`。`startEnrolled` 只在 `client = created`、admission 升级后才会 resolve `ready`（:229-239），失败路径抛错。单次 attach 恰好一次装机由测试的**精确数组断言**钉住（test:187 `installed` 必须恰为 `['guard','provision-reporter','audit-sink']`，二次安装即变长即红）；test:216-226 额外证明同步分支后续微任务不重复安装。生产 `attachCloudRuntime` 仅一处调用（`OrcaRuntimeRpcServer` 的另一构造点 `orcad-entry.ts:353` 不带 `cloudAdmissionOption`、从不 attach，属非云路径，不受影响）。
3. **失败不装 + fail-closed + 拒绝被吞**：enrollment 失败时 `admission` 停在初始 `notEnrolledAdmission()`（:174，401 `not_enrolled` 拒全部 WS 升级，:86-95），`ready` reject → `() => undefined` 吞掉，无 unhandled rejection（test:205-214），三件不装。
4. **变异验证独立复现成立**：在隔离 worktree 把 else 分支改回「不补装」（即修复前语义）→ **恰 3 红 5 绿**，三条红的失败原因与 run-log.json `regressionProof.expectedFailures` **逐字对应**：
   - `首启（enrollment 在途）`：`[] ≠ ['guard','provision-reporter','audit-sink']`（装机缺口）；
   - `策略门随 enrollment 兑现生效`：`Method 'browser.download' is refused: downloads are disabled for this project by platform policy.`（U17 症状② fail-closed 恒拒）；
   - `失败 provision 经回报器上报`：`expected 'provisioning' to be 'failed'`（U17 症状① 平台永停 provisioning）。
   对照 5 例（同步路径 / poll / 非云构建 / stored-credential 重启 / 桩首启除外）在变异下保持绿。
5. **门禁复验**：新套件 8/8 绿（隔离 worktree 直跑该提交，12.9s）；`pnpm tc:node` 0 错（24s）；oxlint 三文件 0 findings；`check:max-lines-ratchet` OK（无新增抑制，`src/main/startup/` 下无任何 max-lines disable）。

---

## 分级发现

### blocker（0）

无。

### major（0）

无。

### minor（2）

- **M-1 注释断言的「enrollment 失败已让启动可见地失败」在代码里不存在，且本提交把该失败的最后一路持久化信号也消掉了。** cloud-runtime-attach.ts:69-70 写「an enrolment failure already fails the launch visibly」，但生产路径没有任何消费者 await/处理 `admission.ready`（全仓 `.ready` 消费者仅 6 个测试 fixture + 本提交新增的吞异常分支；`cloudAdmissionOption` 不 await）；`enrollCloudHost` 与 `startEnrolled` 均不打日志（cloud-host-enrollment.ts:132-137 只返回 `{ok:false,error}`）。修复前该 rejection 无人处理，会落入 `installUnhandledRejectionLogging()`（main-process-preflight.ts:180 → main-process-error-guards.ts:129-133）被持久化为 `main_unhandled_rejection`——即修复前至少有一条可诊断记录；本提交的 `() => undefined` 把它变成完全静默。fail-closed 安全性不受影响（not_enrolled 拒全部升级，客户端表现为明确的 401 拒绝），但运维可见性从「持久化错误记录」降为「零」。建议：拒绝分支加一行 `console.error('[cloud] host enrolment failed', …)`（或让启动路径 await ready 并走既有 fatal 记录），并修正该注释。→ 建议入台账派修。
- **M-2 「变异验证」证据只有预期、没有观察记录，且证据目录整体 gitignore，无法从提交本身复现。** run-log.json 的 `regressionProof` 只列 `expectedFailures` / `controlsStillGreen`，没有附变异运行的实际输出（无 observed 字段）；`cloud-platform/evidence/` 在 .gitignore:174（既有条目，非本提交引入），三个证据文件（run-log.json、w12b2-failed-provision-report.json、w12b2-policy-guard.json）均不入库。本次审计已独立复现并证实声明为真（见结论 4），但按「声明可独立核验」的标准，run-log 应附变异运行的观察输出（红/绿清单 + 关键断言摘录）。

### note（5）

- **N-1 审计任务书的文件清单与提交不符（非提交缺陷）。** 任务书称第三个文件是「main-process-runtime-launch.ts 接线」，实际该文件不在提交内——接线是既有的 `attachCloudRuntime(runtimeRpc)`（main-process-runtime-launch.ts:96，未改动），本提交第三个文件是测试套件。PROGRESS.md 的「恰 3 文件 src/main/startup/」与实际一致。
- **N-2 理论上的极窄「补装前窗口」不构成实际风险。** `startEnrolled` 在 `await created.refresh()` 之前已赋值 `client`（:229），此后升级门槛已可放行；但 endpoint 只经心跳广播（:221-226）、设备票据需平台先认识 hostId（enrollCloudHost 返回后），故补装微任务先于任何可能的 provision RPC；即便假设有 RPC 插入，最坏也只是 `cloudReportProvision?.` optional-chain 丢一条回报——与修复前行为相同，非回归。
- **N-3 真实平台用例 6 的下载断言是负向（「非平台策略拒绝」）而非正向「放行成功」，这是 fixture 约束下的合理取舍，且已被证明有区分度。** provision 注定失败（repoUrl 指向不存在源）⇒ 无 worktree ⇒ 正向下载不可能成功；实际回包为 `invalid_argument: Missing required --selector and --path`。策略拒绝发生在 `admitRpcRequest` 的参数解析**之前**（rpc-request-admission-prologue.ts:46-56 先于 :84 `parseRpcRequestParams`），故「能走到参数校验」即证明策略门已放行；变异运行中该断言恰以 policy 拒绝文本失败，证明非恒真。
- **N-4 读预算/下载门不可能因重复安装双计。** `setCloudAccessGuard` 等三个 setter 都是单字段覆盖（runtime-rpc-pairing.ts:130-143），dispatcher 每请求读单一 `this.cloudAccessGuard`（runtime-rpc-websocket-dispatch.ts:88-108）；重复安装只会整体替换 guard 实例（重置计量窗口），不存在两个 guard 并行计量。真实平台用例 6 断言 `1/1`（一次读取消耗恰一格，第二次 `read_budget_exceeded`）。
- **N-5 未在审计内复跑的门禁声明。** 「42 依赖套件 113 例」「bun runner 三连稳定」未复跑（超审计预算）；已复验项为：新套件 8/8、`tc:node` 0 错、oxlint 0 findings、max-lines 棘轮 OK。`beatUntil` 6 拍上限（test:374-382）在极端负载下有理论 flake 面，与同族套件一致，不构成发现。

---

## 审计清单逐项核验

### 1. 机制正确 — 通过

见结论 1-3。补充三点：① 幂等性由精确数组断言 + 单调用点保证，「同一 runtime 被二次 attach」无测试覆盖但生产无该路径（`attachCloudRuntime` 全仓唯一调用 main-process-runtime-launch.ts:96）；② fail-closed 不变：`downloadAllowed: cloudGuard?.downloadAllowed(...) ?? false`（dispatch:95）与 `DEFAULT_DOWNLOAD_POLICY.downloadDefault='deny'`（cloud-policies.ts:28-33）均未被触碰，poll 对照 test:247 断言缺策略时 `downloadAllowed === false`；③ `cloudRuntimeAdmission` 的模块级 `pending` 记忆（admission:312-322）保证 `cloudAdmissionOption` 与 `attachCloudRuntime` 拿到同一 admission，是「ready 兑现补装」能对上同一条 enrollment 的前提，本提交未触碰该机制。

### 2. 不越界 — 通过

- `git show --numstat`：恰 3 文件，全部在 `src/main/startup/`；`src/main/runtime/` 与 provision 语义（`cloud-project-provision.ts`、`orca-runtime.ts`）零触碰。
- re-export 兼容：admission:308 `export { attachRuntimeToCloudAdmission, installCloudAccessGuard } from './cloud-runtime-attach'`；既有 3 个导入方（cloud-download-policy.test.ts:17、m70-acceptance.test.ts:17、cloud-policy-propagation.test.ts:17）路径与符号均不动，文件本身未改动，`tc:node` 通过证明解析无误。`import type` 反向引用（attach:4）不构成运行时环（`src/main/ipc/cloud-platform.ts` 不 import `startup/*`，已核）。
- max-lines 棘轮：admission 现 277 行有效代码 / 300 上限（拆分前约 295，与 PROGRESS「仅剩 ~8 行」的说法量级吻合）；attach 50 行；测试文件 474/800。`check:max-lines-ratchet` OK，7 个 grandfathered 均不在本域，提交未新增任何 max-lines 抑制。

### 3. 测试质量 — 通过

8 例逐条有区分度断言，无恒真：
- 桩·首启（:175-203）：空数组 → 三件齐装，且**补装的回报器/审计槽真实转发**（:190-202 打桩 client 收到 report/audit）。
- 桩·失败（:205-214）：`installed` 恒空 + 显式 await rejection（vitest 默认对 unhandled rejection 判红，吞异常路径被真实覆盖）。
- 桩·同步（:216-226）：即时三件 + 双微任务后仍恰三件（防同步分支重复装）。
- 桩·非云（:228-232）：admission null ⇒ 只装渲染端 IPC。
- 桩·poll 对照（:234-249）：真 `startCloudRuntimeAdmission` + 不可达地址，client 即刻在 + `downloadAllowed=false`（deny-by-default 钉住）。
- 真实平台·策略门/预算（:450-494）：全局 allow 后 browser.download 越过策略门（见 N-3），项目级 `readRatePerHour{calls:1}` 下第二读 `read_budget_exceeded (1/1)`——guard 装机 + 计量双证。
- 真实平台·失败回报（:496-536）：`project.provision` → `CLONE_FAILED`（刻意选 clone 失败路径，**不绑定** W12b-1 在途演进的 not-prepared/init 语义，test:308-312 注释明示）→ 平台 `status:'failed'` + `provisioningError` 含 CLONE_FAILED + 审计 `project_provision result=failure`——恰是 U17 症状①的行为级断言。
- 真实平台·对照重启（:538-556）：同一 userDataPath 的 stored credential ⇒ client 即刻在 ⇒ 同步三件（不回退）。
- 与规格 §5.3 对照：三条要求（首启失败 provision ⇒ 平台 failed；access guard 按策略生效；stored-credential 对照）全部落地且断言强度不低于规格。
- 变异验证与证据自洽性：见结论 4 与 M-2。

### 4. 线兼容/安全 — 通过

diff 只改「何时调 `setCloudAccessGuard/setCloudProvisionReporter/setCloudHostAudit`」，无任何 RPC 参数、stream opcode 或宿主发布内容变化——不触发 AGENTS「Remote Wire Compatibility」的任一敏感面；`CloudRuntimeTarget.setCloudAccessGuard` 的类型从 `ReturnType<typeof createCloudAccessGuard>` 换成 `CloudAccessGuard`，两者恒等（cloud-access-guard.ts:34-37 直接返回该类型），纯引用收紧。fail-closed 与计量见结论 3/N-4。

### 5. 风格/AGENTS — 通过

- 命名：`cloud-runtime-attach.ts` 表达「runtime 接到 cloud admission」这一具体域概念，非 helpers/utils 类空名；`attachRuntimeToCloudAdmission`/`installRuntimeCloudSurfaces`/`AttachableCloudAdmission` 均自述用途。
- 注释：全部为单行「Why」型（如 attach:16-17 为何 per-call 解析、:64-67 为何吞 rejection），无 walkthrough。
- 无 `as` 类型断言、无 max-lines 抑制、无越域改动；测试注释（:38-43、:308-312）交代了与 W12b-1 的解耦理由，信息密度合适。

---

## 证据索引

- 提交：`git show a6d8d1fc7fa`（3 文件 +654/−23；numstat 无 `main-process-runtime-launch.ts`）
- 修复后机制：`src/main/startup/cloud-runtime-attach.ts:14-42,55-82`；`src/main/startup/cloud-runtime-admission.ts:171-263,295-322`
- 缺口与守卫：`src/main/runtime/runtime-rpc/runtime-rpc-websocket-dispatch.ts:88-108`；`src/main/runtime/rpc/rpc-request-admission-prologue.ts:37-90`；`src/main/runtime/rpc/rpc-caller-scope.ts:37-56`；`src/main/cloud-platform/cloud-policies.ts:25-33`；`src/main/runtime/runtime-rpc/runtime-rpc-pairing.ts:130-143`
- 吞异常可见性（M-1）：`src/main/startup/cloud-runtime-attach.ts:68-78`；`src/main/startup/cloud-runtime-admission.ts:195-199`；`src/main/cloud-platform/cloud-host-enrollment.ts:126-137`；`src/main/startup/main-process-preflight.ts:180`；`src/main/startup/main-process-error-guards.ts:65-90,129-133`
- 证据文件（gitignored，工作区本地）：`cloud-platform/evidence/w12b2-reporter-timing/run-log.json`、`w12b2-failed-provision-report.json`（status:'failed'、provisioningError 'CLONE_FAILED: …'、审计 result=failure）、`w12b2-policy-guard.json`（exported=invalid_argument 非 policy、second=read_budget_exceeded '1/1 reads'）
- 审计实测（隔离 worktree `/tmp/orca-w12b2-audit` @ `a6d8d1fc7fa`，已删除）：未变异 8/8 绿（12.9s）；变异（else 分支改回不补装）后 3 红 5 绿，三条红原因见结论 4；主树 `pnpm tc:node` 0 错、`npx oxlint`（3 文件）0 findings、`pnpm run check:max-lines-ratchet` OK
