# W12 诊断 · U15 自建项目平台 `ready` 但客户端持续 `PROJECT_NOT_PREPARED`

> 状态：诊断稿（只诊断不改码），待主会话审定修复方向后再派修
> 日期：2026-11-14 · 缺陷账：U15🔴（defect-ledger.md:22，用户 3 次复现）
> 范围：平台 `cloud-platform/apps/api` × 客户端宿主 `src/main/cloud-platform` + `src/main/runtime` × 客户端消费面（创建/打开/横幅重试/侧车）
> 证据：本仓库代码静态链路 + `/tmp/u15-probe.ts` 隔离实例最小复现（见 §3，未触碰 18787 在线平台与 demo-app=proj_7d0651e6）

---

## 0. 结论摘要

**一句话脱节点**：FR-3.7 自建项目在「未填仓库地址」时，平台在创建瞬间就把项目置为 `status:'ready'`（`cloud-platform/apps/api/src/server.ts:1554`，判据是"repoUrl 为空 ⇒ 宿主无事可做"），而宿主的唯一准备路径 `planCloudProjectProvision` 只认三种形态——目录已是 git 仓库 / 有 repoUrl 可克隆 / 否则 `not-prepared`——**宿主根本没有实现「无仓库地址时直接使用（或初始化）目录」这条被 UI 文案承诺的路径**，于是每次打开都确定性地返回 `PROJECT_NOT_PREPARED`（`src/main/runtime/orca-runtime.ts:129-135`），环境永远写不进侧车。

**次生脱节点（解释"平台一直显示 ready"）**：宿主对 provision 结果有回报机制（失败应把平台置为 `failed` + `provisioningError`），但 `attachCloudRuntime`（`src/main/startup/cloud-runtime-admission.ts:306-316`）只在 `admission?.client` 非空时安装回报器；**自注册宿主首次启动时 enrollment 是进行中的异步网络调用，`client` 必为 null**（`main-process-runtime-launch.ts:94-96` 在构造 RPC server 时同步触发 enrollment 后立刻 attach），回报器（和云策略门 `installCloudAccessGuard`）从此再未安装 → 宿主的失败回报永远到不了平台 → 平台停在创建时的 `ready`，管理员看不到 `failed`。同一缺口让「填了 repoUrl」的自建项目即使克隆成功也永远停在 `provisioning`。

**置信度：高（~95%）**。主脱节点有可复现的隔离实验矩阵（§3）直接命中"平台 ready + 宿主 PROJECT_NOT_PREPARED"的全部观测特征；唯一不确定的是用户当时在对话框里是否填了 repoUrl——观测到的「平台 ready」排除了"填了且宿主回报过"的分支（填了应显示 `provisioning`/`failed`），与"未填"分支完全吻合。

---

## 1. 全链路时序（用户精确场景逐步）

以「开发者 → Orca 客户端『新建云端项目』→ 打开失败 → 横幅重试」为序：

| # | 步骤 | 位置 | 行为 |
| --- | --- | --- | --- |
| 1 | 创建对话框 | `src/renderer/src/cloud/cloud-new-project-dialog.tsx:186-188,306-321` | 文案：「仓库地址可不填，宿主直接使用已有目录」「不填则直接使用目录」；`repoUrl` 空则请求体不含该字段（:154） |
| 2 | 平台自助创建 | `server.ts:1464-1577` | `dir` 单段校验后 `joinProjectPath(host.projectsRoot, dir)` 拼出 `path`（`project-self-service.ts:112-122`）；**`status: repoVerdict.repoUrl ? 'provisioning' : 'ready'`（:1554）** ——repoUrl 为空 ⇒ 创建即 `ready`，全程没有任何宿主确认 |
| 3 | 客户端创建后立即准备 | `src/main/ipc/cloud-platform.ts:174-198` | `session.createProject` 成功后立刻 `prepareProjectEnvironment`（`cloud-project-preparation.ts:73-86`） |
| 4 | 准备第一步：provision | `cloud-project-preparation.ts:34` → `cloud-session-service.ts:293-315` → `src/shared/cloud-workspace-open.ts:72-115` | 对宿主发 `project.provision` RPC（600s 超时） |
| 5 | 宿主判定 | `src/main/runtime/rpc/methods/project-provision.ts:16-50` → `orca-runtime.ts:119-158` → `cloud-project-provision.ts:33-41` | 输入只来自票据：`cloud.projectRoot` / `cloud.repoUrl`（`runtime-rpc-websocket-dispatch.ts:244-254`）。`hasRepo=isGitRepo(projectRoot)`、`hasRepoUrl=repoUrl!==''`；两者皆假 ⇒ `not-prepared` ⇒ **返回 `{ok:false, code:'PROJECT_NOT_PREPARED'}`（orca-runtime.ts:129-135）** |
| 6 | 客户端中止 | `cloud-workspace-open.ts:112-115` → `cloud-project-preparation.ts:35-37` | provision 失败即整体失败：不建检出、**不调 `registerPreparedEnvironment` ⇒ 侧车（cloud-runtime-environment）无该项目条目** |
| 7 | UI 呈现 | `cloud-platform.ts:194-196`（携带 `projectId`+`project` 返回）→ 创建对话框 `cloud-new-project-dialog.tsx:158-166` | 创建"失败但平台已建项目"⇒ 列表项挂重试横幅 |
| 8 | 横幅重试 | `cloud-platform.ts:160-173` → `prepareProjectEnvironment` | 与 #4 完全同一条 RPC ⇒ 同一个确定性失败，**重试无限次结果不变** |
| 9 | 宿主失败回报（本应发生） | `project-provision.ts:42-48` → `cloudReportProvision` → 心跳 `provisioned[]`（`cloud-heartbeat-body.ts:40`）→ `server.ts:746-782` | 平台应把项目置 `status:'failed'` + `provisioningError`；**但因 §2-B 时序缺口未安装回报器，此步从不发生，平台停留在 #2 的 `ready`** |

管理员登记路径（对照）：`server.ts:1428-1461`，`path` 由运维直供（宿主上通常已是检出），`repoUrl` 为空时同样 `ready`——但 `isGitRepo(path)` 成立 ⇒ 宿主走 `already-provisioned` ⇒ 打开成功。**两条路径的票据结构、上报关联键完全一致；差异只在 path 的来源（已存在检出 vs projectsRoot 下可能不存在的拼接目录）。**

---

## 2. 脱节点精确定位

### A. 主脱节点：平台"无 repoUrl ⇒ ready"与宿主"非 git 仓库 ⇒ not-prepared"的语义矛盾

- 平台侧判据：`cloud-platform/apps/api/src/server.ts:1438`（管理员）、`:1554`（自建）、`:1701`（更新）——三处同一句注释「Why: a repo URL means the host must clone it before the first open」⇒ 反向推论"没 URL 就没事可做"。该推论**只在"目录已是 git 仓库"时成立**。
- 宿主侧判据：`src/main/cloud-platform/cloud-project-provision.ts:33-41`：

  ```ts
  export function planCloudProjectProvision(input: { hasRepo: boolean; hasRepoUrl: boolean }) {
    if (input.hasRepo) return { kind: 'already-provisioned' }
    return input.hasRepoUrl ? { kind: 'clone' } : { kind: 'not-prepared' }
  }
  ```

  没有第四态「init / 空项目」。`not-prepared` 在 `orca-runtime.ts:129-135` 直接变 `PROJECT_NOT_PREPARED`，消息为「项目尚未准备：缺少仓库地址，且目标路径不是 git 仓库。」（`cloud-project-provision.ts:140-141`）——这句错误文案本身就是两侧语义矛盾的最好自白。
- UI 承诺与实现不符：`cloud-new-project-dialog.tsx:186-188`（「宿主直接使用已有目录」）与 `:316-319`（「不填则直接使用目录」）。实际只有"已有目录**且已是 git 仓库**"才成立。
- 波及面（两种用户输入都命中）：
  1. 「新建目录」：目录在宿主上根本不存在（平台只登记了名字，从不建目录）；
  2. 「选择已有目录」：`listProjectDirs`（`src/main/cloud-platform/cloud-project-dirs.ts:18-34`）列出的是 projectsRoot 下**全部**一级目录，不筛 git 仓库——普通目录选进来同样 `not-prepared`。
- 客户端不是"把窗口当永久失败"：客户端打开流程**从不读平台 `status`**（`ensureProjectPrepared`/`ensureWorkspace` 直接向宿主要 provision），所以不存在"竞态窗口被误判"；这是**确定性失败**，重试横幅的设计（`cloud-platform.ts:192-193` 注释："admin fixes the repo URL" 后可重试）默认失败是暂时的，但本场景没有任何一端会改变事实。
- 平台 connect 不设防：`server.ts:2651-2772` 的 `handleConnect` 只查 host 维护/离线/版本，**不校验 `project.status`**——`provisioning`/`failed` 的项目照样发票据（`self-service-project-dir.e2e.test.ts:179-205` 恰好把这一点断言成了预期行为，而该测试止步于 connect 200，从未让真实宿主打开过 repo-less 项目）。

### B. 次生脱节点：首次自注册宿主的 provision 回报器（与云策略门）从未安装

- 接线：`project-provision.ts:42` `context.cloudReportProvision?.(...)` → `runtime-rpc-websocket-dispatch.ts:257` `this.cloudProvisionReporter?.(report)` → `attachCloudRuntime` 里 `runtime.setCloudProvisionReporter?.((report) => client.reportProvisioned(report))`（`cloud-runtime-admission.ts:312`）。
- 断点：`cloud-runtime-admission.ts:309` `if (admission?.client)`——注册模式（`startEnrolled`，即「应用自注册宿主」）下 `client` 在异步 enrollment 完成后才赋值（`cloud-runtime-admission.ts:176-240`：无 stored credential 时 IIFE 在 `await enrollCloudHost(...)` 挂起，这是网络调用）。而调用序是同步的：
  - `main-process-runtime-launch.ts:94`：`new OrcaRuntimeRpcServer({ ...cloudAdmissionOption(process.env, ...) })` —— `cloudAdmissionOption` 内部调用 `cloudRuntimeAdmission()` **启动 enrollment**（首次启动时无持久化凭证）；
  - `main-process-runtime-launch.ts:96`：紧接 `attachCloudRuntime(runtimeRpc)` —— 此刻 `admission.client === null`。
  - ⇒ `setCloudProvisionReporter` 与 `installCloudAccessGuard` 都被跳过，且**没有任何后续时机补装**（`bindRuntime` 只接 revocation，`cloud-runtime-admission.ts:257-260`）。
- 后果：
  1. provision 失败不上报 ⇒ 平台不会 `failed` + `provisioningError`（`server.ts:768-771`）⇒ 管理员/用户看到的永远是 `ready`，与 §2-A 的"创建即 ready"叠加，形成 U15 观测到的"平台 ready 但客户端永久失败"；
  2. provision 成功同样不上报 ⇒ 「填了 repoUrl」的自建项目克隆成功后平台**永远停在 `provisioning`**（只在宿主重启、有 stored credential 的同步路径下才接上报）；
  3. `installCloudAccessGuard` 未装 ⇒ `runtime-rpc-websocket-dispatch.ts:95` `downloadAllowed: cloudGuard?.downloadAllowed(...) ?? false` **fail-closed**：首启宿主上所有云会话下载被拒；读预算计量（:103-108）不生效（未计量，非拒绝）。重启宿主后自愈——与"第一次不行、重启后莫名变化"的体感吻合。
- 无测试覆盖：`cloud-workspace-info-real-host.test.ts:132`、`cloud-project-provisioning.test.ts:110`、`cloud-rpc-scope.test.ts:121` 等注释均写明"Production wires this in attachCloudRuntime; the harness owns the pieces separately"——attach 的**时序**没有任何测试。

### C. 任务假设逐条核验

| 假设 | 结论 |
| --- | --- |
| 自建 vs 管理员项目的 provisioned **上报关联键**有差异？ | **无**。宿主上报 `projectId: cloud.projectId`（票据 `project: project.id`，`server.ts:2722`），平台按 `store.projects.get(projectId)` + `project.hostId === hostId` 校验（`server.ts:754-762`），两条路径同构。 |
| 票据 **projectRoot/workspaceRoot 映射**有差异（path 直供 vs dir 拼接）？ | **票据结构无差异**（`server.ts:2716-2735`：`projectRoot: project.path`、`workspaceRoot: ${path}/.orca-worktrees/<user>`、`repoUrl: project.repoUrl`）；差异在 **path 指向的宿主现实**：管理员登记的 path 通常是已存在检出（⇒ `already-provisioned`），自建拼接出的 path 可能不存在/非仓库（⇒ `not-prepared`）。拼接本身正确（`joinProjectPath`，`project-self-service.ts:112-122`，探针验证无错位）。 |
| 平台 ready ≠ 宿主已 provision 的**窗口**被客户端当成永久失败？ | **不成立（措辞需修正）**。客户端不读平台 status，无窗口判定；真实情况是：repo-less 项目该"窗口"是**结构性恒等**（平台永远 ready、宿主永远 not-prepared），是确定性失败而非竞态。 |
| 平台 ready 与宿主真实状态之间的一次心跳延迟 | 存在（repo-ful 项目：客户端克隆成功 → 下一拍心跳才翻转平台状态），但被 §2-B 的缺口在首启宿主上放大为"永不翻转"。 |

### D. 其他相关发现（非本缺陷直接成因，建议一并评估）

1. `applyProjectsRoot`（`server.ts:810-832`）心跳可改宿主根目录，但**不迁移已建项目的 `project.path`**——`ORCA_CLOUD_PROJECTS_ROOT` 变更后，旧项目票据 `projectRoot` 指向旧根，宿主侧同样以 `not-prepared`/克隆落空呈现。
2. `POST /v1/projects/:id/connect` 不校验 `project.status`（见 §2-A 末条）：`failed` 项目照常发票据，客户端只有在 provision RPC 上才撞墙，错误暴露点比必要更晚。
3. 侧车条目只在准备全链路成功后写入（`cloud-project-preparation.ts:52-70,107-123`）——这是"环境不落侧车"的直接机制，本身是合理的 fail-closed 设计，问题在上游。

---

## 3. 证据

### 3.1 代码引用（关键行已在 §1/§2 标注，此处汇总）

- `cloud-platform/apps/api/src/server.ts:1554` — 自建项目 `status: repoVerdict.repoUrl ? 'provisioning' : 'ready'`
- `cloud-platform/apps/api/src/server.ts:746-782` — `applyProjectProvisionReports`：宿主回报 ok ⇒ `ready`，失败 ⇒ `failed`+`provisioningError`
- `cloud-platform/apps/api/src/server.ts:2651-2772` — `handleConnect` 无 `project.status` 门禁；票据含 `repoUrl: project.repoUrl`
- `src/main/cloud-platform/cloud-project-provision.ts:33-41,138-149` — 三态计划与 `PROJECT_NOT_PREPARED` 文案
- `src/main/runtime/orca-runtime.ts:119-158` — `provisionCloudProject`：`not-prepared` ⇒ `PROJECT_NOT_PREPARED`
- `src/main/runtime/rpc/methods/project-provision.ts:16-50` — 云会话内执行 + 失败回报
- `src/shared/cloud-workspace-open.ts:101-163` — 客户端打开序：provision（失败即中止）→ worktree.list → `worktree.createManaged`（幂等键 `cloud-open:<projectId>:<branch>`）
- `src/main/cloud-platform/cloud-project-preparation.ts:28-86` — provision → link → register 三段；任何一段失败 ⇒ 侧车不写
- `src/main/ipc/cloud-platform.ts:160-198` — 重试横幅与创建后即准备的 IPC 侧
- `src/main/startup/cloud-runtime-admission.ts:176-240,306-316` — 首启 enrollment 异步 vs attach 同步；`if (admission?.client)` 守卫
- `src/main/startup/main-process-runtime-launch.ts:94-96` — 触发序
- `src/main/runtime/runtime-rpc/runtime-rpc-websocket-dispatch.ts:88-108,244-257` — 票据字段进云会话、guard 缺省 fail-closed、回报器透传

### 3.2 最小复现实验（隔离实例，未污染在线平台）

探针 `/tmp/u15-probe.ts`（临时文件，不入库）：直接 `import { createApp }`（`server.ts:306`，导入无副作用，CLI 由 `import.meta.url` 守卫）在**临时目录 + 随机端口**起一个内存版平台，注册带 `projectsRoot` 的宿主，以 `zhangsan` 走真实 HTTP 流程 `POST /v1/projects/self` → `POST /v1/projects/:id/connect`，解出票据 claims 喂给仓库自身的 `planCloudProjectProvision`。运行：`node --experimental-strip-types /tmp/u15-probe.ts`。

结果矩阵（2026-11-14 实测）：

| 场景 | 平台返回 | 票据 `repoUrl` | 宿主判定（planCloudProjectProvision） | 客户端结局 |
| --- | --- | --- | --- | --- |
| A 对话框「新建目录」（目录不存在）+ 无 repoUrl | `201, status:'ready'` | `""` | `not-prepared` | **PROJECT_NOT_PREPARED，重试同败** |
| B 对话框「选择已有目录」（普通目录，非 git）+ 无 repoUrl | `201, status:'ready'` | `""` | `not-prepared` | **PROJECT_NOT_PREPARED，重试同败** |
| C 已有目录且是 git 仓库 + 无 repoUrl | `201, status:'ready'` | `""` | `already-provisioned` | 成功（现有唯一可用分支） |
| D 任意 + 填 repoUrl | `201, status:'provisioning'` | 完整 URL | `clone` | 克隆成功；但平台状态依赖心跳回报（首启宿主因 §2-B 永停 `provisioning`） |

场景 A 的关键输出（原文）：

```
A project: {"id":"proj_440b386e","status":"ready","repoUrl":"","path":"…/projects/u15-probe-new"}
A ticket claims: {"projectRoot":"…/projects/u15-probe-new","repoUrl":"","workspaceRoot":"…/.orca-worktrees/zhangsan"}
A host provision plan: {"exists":false,"hasRepo":false,"plan":{"kind":"not-prepared"}}
```

即：平台说 ready、票据只给一个不存在的路径和一个空 repoUrl、宿主唯一能给的判定就是 not-prepared——与 U15 观测（平台 ready + 客户端 PROJECT_NOT_PREPARED + 侧车无环境）逐项吻合。

### 3.3 现有测试为何没拦住

`cloud-platform/test/e2e/self-service-project-dir.e2e.test.ts:179-205` 把「repoUrl 省略 ⇒ 201 且 ready、connect 200」断言为**预期**，但该用例的宿主是 `registerHost` 伪造的心跳（`projectDirs:['dir-demo']` 只是名字，磁盘上并无目录），全用例从不让真实 Orca 宿主对 repo-less 项目执行 `project.provision`。客户端侧 `cloud-self-service-project-fixture.ts` 的自建 fixture 一律带 `repoUrl`（`cloud-self-service-project-fixture.ts:177` `makeBareRepository(base)`）——**"无 repoUrl"分支在两层测试里都只验了平台半边，从未端到端走通过**。

---

## 4. 修复方案建议（供主会话裁定，未实施）

### 方向 B（推荐，宿主侧）：补上被承诺的「init/直接使用目录」语义

- 改 `planCloudProjectProvision` 增加第四态，并在 `orca-runtime.ts:119-158` 落地：`repoUrl` 为空且目录存在但非 git 仓库 ⇒ `git init`（初始分支取票据 `defaultBranch`）；目录不存在 ⇒ 建目录后 `git init`。
- 为什么改这端：UI 文案（对话框两处）与 FR-3.7 的产品意图都是"无仓库也能开项目"；平台状态机（ready=无需克隆）在"空项目"语义下并无错误，缺的是宿主执行体。
- **实现前必须验证的坑**：空仓库（无任何提交）上 `worktree.createManaged`/`git worktree add` 的行为——空仓库没有 HEAD，`worktree add` 会失败，需要先落一个初始提交（或空提交），否则修完 provision 还会卡在 createManaged。这是本方案最大的未知数，建议实现工单第一步先做该验证，不行则退回方向 C。
- 备选 B'：宿主不做 init，改为对"目录存在但非仓库且无 URL"的项目把 `project.provision` 的失败码细化为 `PROJECT_DIR_NOT_A_REPO`，让 UI 能给出准确指引——不解决可用性，只改善可诊断性。

### 方向 A（平台侧，配合 B）：ready 判据收敛为"宿主确认过"

- repo-less 自建项目创建后置 `provisioning`（或新增 `pending_host`），只有收到心跳 `provisioned ok` 才 `ready`（`server.ts:1554`/`1438`/`1701` 三处同改）；`handleConnect` 对 `provisioning`/`failed` 返回 409 `PROJECT_NOT_PREPARED` 类错误码（把失败暴露点从宿主 RPC 提前到平台，且让重试横幅语义成立）。
- 为什么：让"ready"重新成为可信任信号，杜绝"平台 ready 而宿主无事可做"的恒等错位；同时覆盖 §2-D-1（projectsRoot 变更）这类宿主侧事实变化。
- 代价：管理员登记"已有检出"项目必须等下一拍心跳才 ready（现有测试 `:274-295` 的 `ready` 断言需要同步调整），或者保留"管理员登记 path 直供 ⇒ 信任 ready"的快路径、只收紧自建路径（推荐，二者语义本就不同）。

### 方向 C（客户端 UI，防御性，成本低可先行）

- 创建对话框在「新建目录 且 repoUrl 为空」组合上给出阻断或显著警告（当前文案明示可行）；打开/重试横幅对 `PROJECT_NOT_PREPARED` 展示针对性解释与自助动作（改项目补 repoUrl / 联系管理员），而不是无限次重试同一 RPC。
- 为什么先做：即使 B+A 落地，历史已创建的 U15 项目（平台 ready、目录非仓库）仍需要一条可解释的出路（重试时宿主按 B 的 init 语义即可自愈，或平台按 A 置 failed 后由用户改 repoUrl）。

### 必修（独立于 A/B/C）：§2-B 回报器/策略门时序缺口

- `attachCloudRuntime` 改为不依赖当刻 `admission.client`：在 `startEnrolled` 的 `ready` 兑现后补装（例如暴露 `whenClientReady(cb)`，或在 `bindRuntime` 内用 `ready.then(() => …)` 安装 `setCloudProvisionReporter`/access guard），保持 poll 模式现状不变。
- 为什么必修：它让平台的 `failed`/`provisioningError`（§2-A 修复后的关键反馈通道）在首启宿主上失明，也让"填了 repoUrl"的项目克隆成功后永停 `provisioning`；同时它有 fail-closed 的下载管控副作用（首启宿主云会话全部下载被拒）——用户下一次撞到的很可能就是这个。

---

## 5. 回归测试方案（= 用户精确场景：自建项目从创建到侧栏可用全程）

1. **平台级 e2e**（扩展 `cloud-platform/test/e2e/self-service-project-dir.e2e.test.ts`）：
   - repo-less 自建项目在修复后：创建响应状态符合新语义（A 方案：非 ready；B 方案：仍 ready 但 connect 前宿主可 init）；`handleConnect` 对未就绪项目的拒绝码可断言；
   - 心跳 `provisioned ok:true` ⇒ 平台 `ready`；`ok:false` ⇒ `failed` + `provisioningError` 非空（已有逻辑，补断言防回归）。
2. **宿主端到端**（复用 `src/main/cloud-platform/cloud-self-service-project-fixture.ts` 真平台+真宿主 fixture，**新增 repo-less 变体**）：
   - 「新建目录 + 无 repoUrl」：客户端 `createProject` → `prepareProjectEnvironment` 成功 → `registerCloudRuntimeEnvironment` 后侧车文件含该 `projectId` 的环境条目 → `worktree.list` 能看到 `.orca-worktrees/<user>` 下检出 → 平台项目最终 `ready`；
   - 「已有普通目录（非 git）+ 无 repoUrl」：同上；
   - 幂等：同项目重复 open/重试不产生第二个检出（幂等键 `cloud-open:<projectId>:<branch>` 语义不变）、不重复 init。
3. **回报器时序回归**（防 §2-B 复发）：
   - enrolled 宿主**首启**（无 stored credential，enrollment 在途）即 attach runtime → 触发一次失败 provision → 平台侧断言 `status:'failed'` 且 `provisioningError` 非空；同时断言 access guard 已安装（云会话 `downloadAllowed` 按策略生效）；
   - 对照：有 stored credential 的重启路径行为不回退。
4. **对照组（防既有路径回归）**：
   - 填 repoUrl 的自建项目：provision=clone → 心跳后 `ready` → 侧栏可用；
   - 管理员登记已存在检出：`already-provisioned` 直接打开成功；
   - 管理员登记 + 补 repoUrl（project update）：`provisioning` → 克隆 → `ready`（`server.ts:1701` 路径）。
5. **手工验收脚本**（对应"用户 3 次复现"的原样操作）：登录平台 → 新建云端项目（不填仓库地址，选新建目录）→ 观察：不再出现 PROJECT_NOT_PREPARED；侧栏出现项目；侧车目录出现该环境；平台工作台该项目最终 ready；再点一次横幅重试（若可见）结果幂等。

---

## 6. 附：探针脚本要点（可复现）

```ts
// /tmp/u15-probe.ts（节选）——隔离实例上完整重放"自建→票据→宿主判定"
const app = createApp({ port: 0, internalToken: 'probe-token' })
const port = await app.listen()
// 注册带 projectsRoot 的宿主（模拟应用自注册）→ zhangsan 登录
const a = await post('/v1/projects/self', devToken, { name: 'U15 A', dir: 'u15-probe-new', hostId })
// → 201 {"status":"ready","repoUrl":"","path":"<projectsRoot>/u15-probe-new"}（目录不存在）
const connect = await post(`/v1/projects/${a.body.id}/connect`, devToken, { deviceId, clientVersion: '1.5.0' })
const claims = JSON.parse(Buffer.from(connect.body.credential.split('.')[1], 'base64url'))
// → { projectRoot: '<…>/u15-probe-new', repoUrl: '', workspaceRoot: '<…>/.orca-worktrees/zhangsan' }
planCloudProjectProvision({ hasRepo: existsSync(claims.projectRoot), hasRepoUrl: claims.repoUrl !== '' })
// → { kind: 'not-prepared' }  ⇒ 宿主 orca-runtime.ts:129 返回 PROJECT_NOT_PREPARED
```

（探针为临时诊断文件，未写入仓库、未提交；在线平台 18787 与 demo-app=proj_7d0651e6 全程未被读写。）
