# W12b-1 审计报告（U15 修复：宿主初始化空云端项目目录）

- 审计人：独立审计代理（只读）
- 日期：2026-11-14
- 审计对象：提交 `09c5c9a3e19`（fix(cloud): host initializes empty cloud project directories，恰 8 文件 +580/−14，父提交 `300308f25c6`）
  - `src/main/cloud-platform/cloud-project-provision.ts`（+7/−2：`not-prepared` → `init` 第四态 + `INIT_FAILED` 文案）
  - `src/main/runtime/runtime-repository-init.ts`（新，43 行）
  - `src/main/runtime/runtime-repository-clone-controller.ts`（+50/−3：`initToPath` + `finishClone`→`registerCheckout` 共享尾）
  - `src/main/runtime/orca-runtime.ts`（+19/−7：`init` 分支执行体）
  - `config/scripts/vitest-node-runtime-files.mjs`（+4：repo-less 真栈套件入 node 池）
  - 测试 3 处：`runtime-repository-init.test.ts`（新 7 例）、`cloud-repo-less-project.test.ts`（新 4 例，真平台+自注册宿主+TLS）、`cloud-project-provision.test.ts`（改 2 例断言，套件共 46 例）
- 对照基准：`work-orders/w12-provisioning-readiness-diagnosis.md` §4 方向 B + §5.2；`cloud-platform/PROGRESS.md`「W12b-1 实现完成」节；`defect-ledger.md` U15（🟢）/U23/U24
- 方法：只读 diff 逐 hunk 审阅 + 源码交叉验证（claim/cleanup 归属、路径锁、store 登记前提、git runner、locale 钉）+ 四项快速实证（边界门禁复跑、新套件 bun runner 直跑、oxlint、空仓库 `worktree add` 行为探针）。主工作树零改动、零提交、未跑长套件。
- 边界：其上的 `a6d8d1fc7fa`/`41b01a56516`（src/main/startup，W12b-2）与 U23 修复 `108bf8bb832` 不在本次审计对象内，仅作「遗留问题已被后续处理」的对照引用。

## 结论

**PASS**：blocker 0、major 0、minor 2、note 5。

U15 的「平台 ready × 宿主 PROJECT_NOT_PREPARED」恒等错位确实被该提交按方向 B 闭合：计划态四组合全覆盖，宿主对「无 repo、无 URL」的票据目录执行 init+钉分支+空初始提交，并像 clone 一样登记进 store，使 `worktree.*` 能解析 `path:<root>`。五条审计清单逐项核验通过（见下文），唯一机制级缺口是**新 sqlite 套件未入 node/sqlite 运行时池**（M-1，实际影响有界，且该门禁在本提交之前已被同流水的 26 个文件打红）。

1. **四态计划与 UI 承诺语义一致**。`planCloudProjectProvision`（cloud-project-provision.ts:33-42）对 `hasRepo×hasRepoUrl` 四组合给出三态：repo 在 → `already-provisioned`（即使票据带 URL，本提交新增断言钉住该优先级）；无 repo 有 URL → `clone`；无 repo 无 URL → `init`（原 `not-prepared` 的唯一出口）。创建对话框两处文案（cloud-new-project-dialog.tsx:187「仓库地址可不填，宿主直接使用已有目录」、:318「不填则直接使用目录」）从「承诺」变为「兑现」；init 对目录做的唯一额外动作（.git + 一个空提交）正是诊断 §4 方向 B 明确要求的语义。
2. **Git 2.25 基线成立，且「空仓库不可 worktree add」的设计担忧属实并被钉死**。runtime-repository-init.ts 用 `init --quiet` + `symbolic-ref HEAD refs/heads/<branch>` + `commit --allow-empty`，全部为 Git 2.25 前既有命令，无 `-b`。审计实测探针：空仓库 `git worktree add <path> main` → `fatal: invalid reference: main`——证实「必须先落初始提交」不是过度设计；`runtime-repository-init.test.ts:159-172` 服务链用例把「provisionCloudProject 之后 createManagedWorktree 可建出工作区 + `worktree list` 恰 2 行」钉为回归。
3. **身份兜底只对 who-are-you 家族重试**。`MISSING_IDENTITY = /Please tell me who you are|user\.name|user\.email/i`（init.ts:20），不匹配即原样上抛（→ `INIT_FAILED`，不掩盖真实错误）；匹配英文输出的前提由 `promptGuardGitEnv()`（git-process-env.ts:27-36，含 #7808 的 locale 钉）保证，注释如实。`withoutGitIdentity` 测试用 `useConfigOnly=true` 便携复现该失败，并断言初始提交作者恰为 `orca-cloud <orca-cloud@localhost>`——证明兜底真实触发而非恒真。
4. **并发与失败路径机制成立**。`initToPath` 与 clone 共用 `withPathLock(getClonePathComparisonKey(target))`，锁内复检 `isGitRepo`（注释「the caller's verdict predates it」属实：`provisionCloudProject` 的判定在锁外）；二次进入跳过 init，单测以 `rev-list --count = 1` + store 单行钉住。`claimCloneTarget` 先于 init，失败清理 `cleanupClaimedCloneTarget` 受 `canCleanup:false`（EEXIST 分支）+ dev/ino/birthtimeMs 三元身份双重保护——**预先存在的目录（含用户文件）绝不会被删**，仅清理本次新建的目录（单测断言 `existsSync(target) === false`，且另一单测证明已有普通目录的 `notes.txt` 原样保留、`status --porcelain = '?? notes.txt'`）。
5. **子进程全部走既有 git runner**。init 用 `gitExecFileAsync`（runner.ts:33，集中式 WSL 感知 runner），clone 沿用 `gitSpawnAfterWindowsEnvironmentReady`；产品代码零 `child_process` 引用（测试内 `execFileSync` 与同目录既有 fixture 同型）。

---

## 分级发现

### blocker（0）

无。

### major（0）

无。审计任务书要求核对的两条独立测试发现均确认**非本提交缺陷且已被后续提交处理**（见「U23/U24 对照」节）。

### minor（2）

- **M-1 新增 sqlite 套件未注册任何运行时池，node 池边界门禁红——「node 池注册（MAJ-1 教训）」只闭环了 TLS 那一半。** `runtime-repository-init.test.ts` 经 `import { createSqliteTestStore } from '../persistence-test-harness'` 使用真 SQLite，但既不在 `NODE_RUNTIME_INCLUDE` 也不在 `SQLITE_RUNTIME_INCLUDE`（两份清单 grep 零命中），而同目录三个用同一 harness 的既有套件（`automation-change-publication`、`orca-runtime-terminal-surface-close`、`orca-runtime-terminal-close-records`）都已注册。后果实证：`config/scripts/vitest-sqlite-runtime-boundary.test.ts:83-92`（「keeps real SQLite fixtures … in the Node runtime project」门禁）在 HEAD 红，missing 清单 29 项中含本文件。**影响有界**：① 该套件在默认 bun runner 下实跑 7/7 绿（6.2s，本次审计复现），不像 W9a7 MAJ-1 那样「套件红/断言永不可达」；② 该门禁在本提交之前已被同流水早先提交打红（父提交 `300308f25c6` 上 26 个 cloud-platform/web 套件同样缺席，`cloud-workspace-ensure.test.ts` 等 2026-11-13 已存在且未注册）——本提交是往一口已破的钟上再敲一记，而非打破它。但它与提交自身「MAJ-1 教训闭环」的声明直接冲突：教训的本体（W5b 缺陷 B1「真栈套件须入 node 池」+ 边界门禁）被本提交的新 sqlite 套件再次触碰。建议：随后续批量注册修（与本流水其余 28 项一起），一行入 `SQLITE_RUNTIME_INCLUDE`。
- **M-2 `initToPath` 文档注释对「登记失败后的重试」承诺了本提交不具备的自愈。** 注释写「Re-entry (concurrent opens, **or a retry after a registration failure**) skips the init instead of re-pinning HEAD」，暗示登记失败后重试会补登记；实际 `provisionCloudProject` 的重试会重新过 `planCloudProjectProvision`，此时 `isGitRepo=true` 走 `already-provisioned` 提前返回 `{ok:true, provisioned:false}`（orca-runtime.ts:135-137），**不会**再调 `registerCheckout`——即 init 成功、登记失败（如 store 写失败）后，检出留在盘上而 store 无行，此后每次 open 都撞 U23 的 `forbidden "That repository is not available"`。这正是台账 U23 的领域（该提交内确实遗留，非新引入），且 `108bf8bb832` 的 `registerExistingCheckout` 已把 `already-provisioned` 分支接上共享尾补登记——但注释在修复落地前描述的是一个不存在的自愈路径。建议随 U23 修复顺手收敛注释措辞（该提交已改写此函数，注释现状以 `108bf8bb832` 为准复核）。

### note（5）

- **N-1 失败清理是 best-effort，`rm` 失败时半成品仓库仍会毒化下一次 open。** `cleanupClaimedCloneTarget`（repo-clone-path.ts:112-114）`rm(...).catch(() => {})` 吞错；Windows EBUSY 等场景下无提交仓库残留 → 下次 open `isGitRepo=true` → 本提交内即 U23 死路。与 clone 路径的既有取舍一致，且 `108bf8bb832` 后残留行会被补登记，实际风险已被后续消化。记录备查，不计缺陷。
- **N-2 身份兜底不覆盖两类宿主配置边角，失败表现为 `INIT_FAILED` 而非误提交**：① 宿主全局 `commit.gpgsign=true` 且 gpg 不可用——签名失败文案不含 who-are-you 关键词，不触发 `-c` 重试；② 全局 `core.hooksPath` 指向的 pre-commit 钩子会拦截初始提交。两者都 fail-closed（清理目录 + 明确错误码），仅影响「自建项目在该类宿主上不可开」。挂 P2 观察。
- **N-3 W12b-4（管理员登记已存在检出）用例由测试自己 `harness.store.addRepo(...)` 造出 store 行**（cloud-repo-less-project.test.ts:216-225，注释明说「`worktree.*` 只解析宿主 store 里的行」）——它钉住了「provision 必须对已登记路径保持手不动」的正确语义，但绕过了真实宿主「对话框选了已是 git 仓库的目录 → 没人造行」的流，后者就是 U23（后续 `108bf8bb832` 以 `runtime-repository-existing-checkout.test.ts` 补上）。本提交内这样写是诚实的范围切割，非恒真掩盖。
- **N-4 平台侧 `status` 断言按约定不在本提交验证。** 新套件头注释「Why no platform status assertions: the provision-report path is owned elsewhere」——工作令 §5.2 第 2 条的「平台项目最终 ready」半边由 W12b-2（`a6d8d1fc7fa`）承担，本提交只证宿主半边（宿主 init/侧车/检出/幂等四件均已被真链用例覆盖）。范围划分与 PROGRESS 记录一致，留此备查以防「§5.2 已全覆盖」的误读。
- **N-5 三条轻微观察，均不构成缺陷**：① `mkdir(dirname(target), {recursive:true})` 在票据路径多级父目录不存在且 init 失败时，会留下空父目录链（标准流 projectsRoot 已存在，不触发）；② 票据路径上若已有 Orca folder 型项目（`kind:'folder'`），init 会把它升级为 git 项目——数据保留（W12b-2 用例钉住），且与「直接使用目录」承诺一致，但属一次静默的 kind 迁移，`registerCheckout` 的 folder→git 升级路径系 clone 既有逻辑复用；③ 失败注入用例用 `bad..branch` 走 git 自身 refname 校验触发 symbolic-ref 失败——分支校验本身在 provision 层（`validateCloudBranchName`），控制器层不做校验属刻意的 fail-closed 分层（非法分支最终仍以清理+报错收场）。

---

## U23/U24 对照（独立测试发现 × 本提交）

| 项 | 本提交（`09c5c9a3e19`）状态 | 后续处置 |
| --- | --- | --- |
| U15 自建项目 PROJECT_NOT_PREPARED | **本提交闭合**：真平台+自注册宿主+TLS 链用例覆盖「新建目录」「已有普通目录」两变体 + 幂等重试（1 提交 / 2 worktree 行 / `created:false`） | 台账 🟢 成立 |
| U23 already-provisioned 不登记 → open forbidden | **确实遗留**：`plan.kind === 'already-provisioned'` 直接返回，无登记路径（orca-runtime.ts:135-137）；W12b-4 用例手工造行佐证前提 | `108bf8bb832` `registerExistingCheckout` 接共享尾补登记 + 新套件；非本提交缺陷 |
| U24 并发 open 双方 `created:true` | **确实遗留**：并发 init 第二方跳过 init 后仍走 `registerCheckout` 返回 `{ok:true, provisioned:true}`（orca-runtime.ts:149），标志语义失真 | `108bf8bb832` 以 `createdByThisCall:false` + 幂等键去重修复；非本提交缺陷 |

本提交自身未发现新的 major 及以上问题。

---

## 审计清单逐项核验

### 1. 规格符合 — 通过

见结论 1-3。补充：`init` 分支对 `defaultBranch` 空值回退 `'main'` 并经 `validateCloudBranchName`（与 clone 分支同一校验器、同一错误码）；校验不通过时返回 `BRANCH_INVALID` 且不触碰磁盘。U25（平台/宿主校验规则不一致）属台账在途项，不在此展开。

### 2. 关键机制 — 通过（附 M-2 注释措辞）

- **共用路径锁 + 锁内复检**：`initToPath` 与 `clone`/`cloneToPath` 同键 `getClonePathComparisonKey` → 同一把 `inFlightByPath` 锁（runtime-repository-clone-controller.ts:160-179），并发 open 串行化；`isGitRepo` 在锁内重查，HEAD 不会被二次钉。单测「重试幂等」直接钉该行为（二次调用后 `rev-list --count` 仍 1、store 单行）。
- **目录归属与失败清理**：见结论 4。`claimCloneTarget` 的 EEXIST→`canCleanup:false` 语义使「半成品误判 already-provisioned」的窗口只剩 init/commit 自身失败且清理成功的情形，而那正是清理的目标态。残留风险见 N-1。
- **共享尾 registerCheckout**：`finishClone`→`registerCheckout` 纯改名 + 注释，clone 三处调用点行为逐字节不变（`git show -w` 核对）。`resolveRepoSelector` 只认 store 行的前提（orca-runtime-resolve-worktree-selector.ts:157-176 `selectReposBySelector` 只读 `store.getRepos()`）对 clone/init 两路由登记满足；already-provisioned 路不满足 = U23（见上表）。登记尾部完整复用既有 `prepareLocalWorktreeRootForRepo` + `invalidateAuthorizedRootsCache` + 双 invalidate + `notifyReposChanged`，与 clone 无差异。
- **空初始提交序列**：设计担忧实测为真（`fatal: invalid reference: main`），序列后 `createManagedWorktree` 完全可用，已被服务链用例（真 git + 真 store + 真 createManagedWorktree，60s 预算）钉住。

### 3. 独立测试已知结论对照 — 通过

见上表。另核对：独立测试证据 `cloud-platform/evidence/w12b1-verify/verify-summary.json` 的 46+7+4=57 与 PROGRESS「新 3 文件 57 例」一致（46 例来自 `cloud-project-provision.test.ts` 的 `it.each` 表驱动，静态 grep `it(` 只见 3 处属正常）。

### 4. 安全/风格 — 通过

- 客户端只见 `INIT_FAILED` →「项目目录初始化失败，请查看主机日志。」（cloud-project-provision.ts:143-144），无路径、无 git stderr；完整错误只进宿主 console（`[cloud]` 既有前缀约定）。与 clone 路径（`getGitCloneFailureMessage` 可含 checkoutPath）同级，未扩大信息面。
- init 只写票据 `projectRoot`（与 clone 同信任级：路径来自验签票据副本）；失败清理有目录身份护栏，无越界删除面。
- 命名 `runtime-repository-init.ts` 为具体域名词 ✓；注释全部单行 WHY 型（含两处「Why env/Why useConfigOnly」的坑位说明）✓；无 max-lines/disable 抑制、无类型断言、无 `as const` 之外的 cast ✓；oxlint 三文件 0 findings（exit 0）✓；本提交无 UI/Tailwind 面，design-system 门禁不适用。

### 5. 测试质量 — 通过

- **无恒真断言**。逐用例核对： symbolic-ref 钉分支（`rev-parse --abbrev-ref HEAD`）、身份兜底（作者串精确匹配，且宿主身份被 `useConfigOnly` 真实禁用）、幂等（提交计数 + store 行数，重 init 即红）、失败清理（`existsSync === false`，注入点在 `git init` 之后 symbolic-ref，正是「半成品」态）、目录保留（文件内容 + porcelain）、服务链（worktree list 行数 + toplevel realpath）、真链四例（侧车 entry id、`worktree.list` 含 zhangsan、重试后 1 提交/2 worktree、重开 `created:false`）+ 两个零回归对照（repo-ful 克隆 README、管理员登记 `provisioned:false`）。全部读取真实 git/文件系统/RPC 回包。
- **node 池注册**：TLS 真栈套件已注册且注释引证家族（W5b 缺陷 B / W9A-7 MAJ-1）✓；sqlite 套件缺席 = M-1。

---

## 审计内实证记录（可复现）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 边界门禁 | `bun --bun node_modules/vitest/vitest.mjs run config/scripts/vitest-sqlite-runtime-boundary.test.ts` | 1 failed / 10 passed，missing 29 项含 `runtime-repository-init.test.ts`（3.3s） |
| 新套件 bun 直跑 | `bun --bun node_modules/vitest/vitest.mjs run src/main/runtime/runtime-repository-init.test.ts` | 7/7 绿（6.2s） |
| 空仓库 worktree add | `git init -q empty && git -C empty worktree add …/wt main` | `fatal: invalid reference: main`（证实初始提交必要） |
| Lint | `npx oxlint src/main/runtime/runtime-repository-init.ts src/main/runtime/runtime-repository-init.test.ts src/main/cloud-platform/cloud-project-provision.ts` | 0 findings |
| 父提交门禁基线 | `git cat-file -e 300308f25c6:src/main/cloud-platform/cloud-workspace-ensure.test.ts` + 清单 grep | 该套件在父提交已存在且未注册（门禁先红证实） |

未复跑（超只读/短时预算，采信独立测试 `w12b1-verify` 证据）：真平台 TLS 全链 4 例、`pnpm tc:node`、受影响 21 文件 107 例。
