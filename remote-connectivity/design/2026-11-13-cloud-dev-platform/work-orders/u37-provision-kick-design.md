# U37 设计 · repo-ful 项目 provisioning 死锁 —— 宿主主动 provision kick（心跳下行指派）

> 状态：设计稿（只设计不改码），待主会话审定后再派修
> 日期：2026-11-14 · 缺陷账：U37🔴（defect-ledger.md:44，P1，U20 门禁 `43c79e1978b` 的连带回归）
> 范围：平台 `cloud-platform/apps/api` × 客户端宿主 `src/main/cloud-platform` + `src/main/startup` × 测试（M57 复活 / U34 套件 2 还原）
> 证据：U34 适配笔记 `cloud-platform/evidence/w120-fix-u34/notes.json`（套件 2 `structuralFinding` 首次点名环形死锁）

---

## 0. 结论摘要

**一句话**：在心跳**响应**（宿主唯一被认证的下行通道）里加一个 wire-additive 可选数组 `provisionAssignments`，平台按「本宿主名下、`status==='provisioning'` 且 `repoUrl` 非空」即时派生；宿主收到后在**票据之外**执行克隆（复用既有 `provisionCloudProject` → `cloneToPath` 全链），并沿**既有**上行 `provisioned[]` 报告通道回报 → 平台 `ready`/`failed`。死锁的三段闭环（connect 只放行 ready → ready 只来自回报 → 克隆只在票据内）被从第三段打开：**克隆不再需要第一张票**。

**契约一句话版**：

- 下行（新增，可选）：`heartbeat 响应 += { provisionAssignments?: [{projectId, path, repoUrl, defaultBranch}] }`，仅非空时携带，≤16 条/拍；旧宿主读不到这个字段（`sendHeartbeat` 白名单式取字段）⇒ 行为逐字节不变。
- 上行（零改动）：宿主继续用既有 `provisioned: [{projectId, ok, error?}]` 报告；平台 `applyProjectProvisionReports`（`server.ts:749`）原样置 `ready`/`failed`。
- 宿主执行（新增一条 kick 执行器，装在 W12b-2 同一安装点 ⇒ U17 时序缺口自动免疫）：串行 + 按 projectId 去重，防御校验（path 规范绝对、`validateCloudCloneUrl`、`validateCloudBranchName`）→ `runtime.provisionCloudProject(...)`（三态计划天然幂等）→ `reportProvisioned({projectId, ok, error})`；**永不抛入心跳循环**。
- U20 门禁**不动**：provisioning 期 connect 仍 409 `PROJECT_PROVISIONING`、failed 仍 409 `PROJECT_NOT_PREPARED`；变的只是「provisioning 期宿主有事可做」。

**置信度：高（~92%）**。死锁四段闭环全部有代码行号实证（§1）；方案每一环都复用已回归的既有机制（`provisioned` 回报链 W12b-2、`cloneToPath` M57、心跳下行先例 U21 `projectsRootRejected` / `policies.projectOverrides`）；唯一的不确定点是 M57-1 复活后「克隆发生在票据外」对套件叙事的改写幅度（§5-C，纯测试语义，非产品风险）。

---

## 1. 现状链路（读码结论）

### 1.1 宿主如何得知项目存在：只有「票据」

宿主没有项目列表概念。票据（`/connect` 返回的 credential）claims `project` / `projectRoot` / `repoUrl` / `defaultBranch`（`server.ts:2857-2876`），经 `admit` → `adoptCloudDevice`（`cloud-runtime-admission.ts:61-84`）落到会话，再由 `runtime-rpc-websocket-dispatch.ts:244-254` 组装成 RPC 的 `cloud` 上下文——`project.provision` 的全部输入（`project-provision.ts:27-31`）。

### 1.2 下行通道：心跳响应（先例齐备）

`POST /v1/hosts/{id}/heartbeat` 响应（`server.ts:2329-2363`）今天携带：

| 字段                         | 内容                                                                                                              | 先例意义                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `hostRevoked`                | 宿主级吊销                                                                                                        | 单向指令，宿主收到即停摆                                                                                          |
| `projectsRootRejected`       | **U21 新增**，可选、仅拒绝时出现                                                                                  | **wire-additive 下行扩展的最近先例**；注释即「Optional so older hosts that ignore it stay on the wire untouched」 |
| `policyVersion` / `policies` | `downloadDefault`、`projectOverrides`（**按 projectId 的 per-project 映射**）、`readRatePerHour`、`rateOverrides` | 下行已携带 per-project 数据，无需新通道                                                                           |
| `revoked`                    | users/projects/devices/jtis 四集合                                                                                | 数组式批量下行                                                                                                    |
| `maintenance` / `serverTime` | 维护态、时钟                                                                                                      | —                                                                                                                 |

宿主侧 `sendHeartbeat`（`cloud-host-enrollment.ts:176-211`）**白名单式**摘取 `policyVersion/policies/revoked/maintenance/hostRevoked` 组装 `HeartbeatResult`——未知字段天然不可见，这是「旧宿主零感知」的结构性保证，也是 U21 选它做下行扩展的原因。

### 1.3 回报链（上行，已闭环且已回归）

```
宿主执行 provision
  → cloudReportProvision（project-provision.ts:42-48，只报 {projectId, ok, error?}，message 恒为通用中文防 URL 凭据回显）
  → cloudProvisionReporter（runtime-rpc-websocket-dispatch.ts:257 → setCloudProvisionReporter）
  → client.reportProvisioned = provisionReports.queue（cloud-agent-client.ts:325；上限 32、同项目去重、seq 截断）
  → 下拍心跳体 provisioned[]（cloud-heartbeat-body.ts:40）
  → 平台 applyProjectProvisionReports（server.ts:749-785）：ok→ready / 否则 failed+provisioningError，拒 archived/他 host/未知 id，写 project_provision 审计
```

W12b-2（U17）已把回报器安装修复到 `installRuntimeCloudSurfaces`（`cloud-runtime-attach.ts:37-44`）单点，首启 enrollment 在途时 `ready.then` 补装——kick 执行器若装在同一函数内即**继承该时序修复**。

### 1.4 宿主四态计划（幂等内核，直接复用）

`planCloudProjectProvision`（`cloud-project-provision.ts:34-42`）×`orca-runtime.ts:119-179`：

| hasRepo | hasRepoUrl | 计划                | 执行                                                                                         | 幂等性         |
| ------- | ---------- | ------------------- | -------------------------------------------------------------------------------------------- | -------------- |
| true    | *          | already-provisioned | `registerExistingCheckout`（只补 store 行/缓存，零触碰内容）                                 | 重入无副作用   |
| false   | true       | clone               | `cloneToPath`（`--` 分隔 argv、per-path `withPathLock` 串行、失败清理半成品、落 store 注册） | 已是仓库即短路 |
| false   | false      | init                | `initToPath`（建目录+`git init`+首提交+注册）                                                | 已是仓库即短路 |

**关键**：kick 执行器只需要「拿着指派调用 `provisionCloudProject`」，重复指派/重启重放/并发去重全部由这层既有语义吸收。

### 1.5 死锁四段（U37 本体）

| 段                     | 位置                                                                                                | 事实                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ① connect 只放行 ready | `server.ts:2790-2814`                                                                               | failed→409 `PROJECT_NOT_PREPARED`；provisioning→409 `PROJECT_PROVISIONING`（U20） |
| ② ready 只来自回报     | `server.ts:749-785` 是唯一把 provisioning 翻成 ready 的路径（其余写入点只置 provisioning/archived） |                                                                                   |
| ③ 克隆只发生在票据内   | `project.provision`（`project-provision.ts`）是宿主唯一调用 `provisionCloudProject` 的入口          |                                                                                   |
| ④ 票据只发 ready       | ① ⇒ provisioning 拿不到票 ⇒ ③ 永不执行 ⇒ ② 永不翻转                                                 | **环**                                                                            |

provisioning 的四个写入点（全部「带 repoUrl ⇒ provisioning」）：admin create `server.ts:1538`、self-service create `:1654`、PUT `:1801`、restore `:1980`。**平台侧没有任何「解锁」写入口**（U34 笔记 `structuralFinding` 已证：平台进程外置无 store 直写通道）。

---

## 2. 候选方案对比

### 方案 a（推荐）：宿主主动 kick —— 心跳下行指派 + 既有回报

机制见 §0/§3。逐项核对设计任务要求的分析维度：

- **鉴权边界（hostId 绑定）**：心跳本身按宿主凭证校验（`server.ts:2256-2259`，`safeEqual(credentialHash)`）；指派派生时强制 `p.hostId === target.id` ⇒ 只有名主收到自己的活。信任等级与票据 claims 相同（同源于平台 store、同一控制面下发），不引入新信任假设；宿主侧补防御校验（§3.5）。
- **幂等**：平台按 status 即时派生 ⇒ 未翻转前每拍重发；宿主靠 §1.4 三态计划（already-provisioned 短路）+ per-path `withPathLock` + 执行器 per-project 去重 ⇒ 重复指派、宿主重启、回报丢失重放全部无害。
- **失败回报路径**：零新通道——沿用 `provisioned[]` → `applyProjectProvisionReports` ⇒ `failed + provisioningError` + `project_provision` 审计；failed 不再派生指派 ⇒ 无重试风暴；恢复路径 = admin PUT repoUrl / restore（重新置 provisioning ⇒ 指派自动重发）。
- **与 U20 门禁的配合**：provisioning 期 connect 仍 409，但克隆不再依赖 connect/票据；「失败暴露点提前到平台」的 U20 初衷反而被补全——失败在创建后一拍内就出现在控制台，而不是用户打开时的 600s RPC。
- **wire 兼容**：响应加性可选字段；旧宿主结构上读不到（§1.2）；新宿主 × 旧平台=字段缺席 ⇒ 无指派、无行为变化。
- **自动化程度**：开发者自助创建（FR-3.7 带 repoUrl）→ 零人工 → ≤1 拍心跳（10s 刷新周期）+ 克隆时长 → ready。admin create / PUT / restore 同一通路覆盖，无遗漏写入点（§1.5 四点全部落入同一派生条件）。

### 方案 b：平台侧 ready-flip / kick 端点（admin 强制翻转或触发）

- 形态：`POST /v1/projects/:id/provision-skip`（置 ready）或「强制重试」按钮。
- **否决理由**：
  1. **不自动化**——死锁的第一现场是开发者自助创建带 repoUrl 的项目（FR-3.7），此时根本没有 admin 在场；每个项目都要一次人工介入等于把 P1 变成 P2 的持续税。
  2. **语义破坏**——直接置 ready 复活了 W12a §2-D-2 要消灭的「平台 ready 而宿主无事可做/未确认」恒等错位（U15 家族），U20 的「ready=宿主确认过」前提被击穿。
  3. 无法覆盖失败可见性：克隆失败依然无人知晓（没有执行者就没有失败）。
- 结论：只配作为**运维逃生门**挂 P2（「跳过宿主确认」本就该是显式特权动作），不解决本缺陷。

### 方案 c：connect 门禁放行 provisioning（部分回退 U20）

- 形态：`handleConnect` 对 `provisioning` 发票（保留 failed 拒绝）。
- **否决理由**：
  1. **回到失败暴露晚**——克隆失败要等用户打开时在 600s RPC 里爆（`cloud-workspace-open.ts` `PROVISION_TIMEOUT_MS = 600_000`），U20 的动机（`server.ts:2788-2789` 注释「a non-ready project must fail at the platform, not at the host's provision RPC」）被直接撤回。
  2. **状态语义混淆**——「第一次克隆还没轮到」与「克隆失败待修」在 provisioning 态不可区分；放行后二者都发票据，宿主侧表现为或成功或 `CLONE_FAILED`，平台无法提前解释。
  3. 打开体验：首次打开被克隆时长钉住（大仓库分钟级），而 kick 下打开时克隆已完成或正在后台推进。
- 结论：**保留为应急回退开关**（若 kick 落地前线上被 U37 卡死，回退 U20 的 provisioning 分支即可临时解锁，代价已知），不作为终态。

### 方案 d（补充评估）：独立宿主拉取端点 `GET /v1/hosts/{id}/provision-assignments`

新增一条需鉴权的控制面路由 + 每周期多一次请求，信息量与心跳响应完全重合；心跳响应已是被认证、已轮询（10s）、已有 per-project 先例的通道。无优势，不采用。

---

## 3. 推荐方案契约

### 3.1 下行：`provisionAssignments`（wire-additive）

```jsonc
// POST /v1/hosts/{id}/heartbeat 的 200 响应体，新增可选字段；仅待指派非空时出现（与上行 provisioned[] 同风格）
"provisionAssignments": [
  {
    "projectId": "proj_ab12cd34",
    "path": "/srv/orca-projects/payment-service",        // 平台 store 内已过 validateProjectPath 的绝对路径
    "repoUrl": "https://git.example.com/pay/payment-service.git",
    "defaultBranch": "main"
  }
]
```

派生规则（平台，纯函数便于测试，无新 store 字段）：

```ts
// cloud-platform/apps/api/src/server.ts（heartbeat 响应处，revoked 宿主除外）
function pendingProvisionAssignments(hostId: string) {
  return [...store.projects.values()]
    .filter((p) => p.hostId === hostId && p.status === 'provisioning' && p.repoUrl !== '')
    .sort((a, b) => a.createdAt - b.createdAt) // 稳定顺序 ⇒ 分拍可预期
    .slice(0, MAX_ASSIGNMENTS_PER_BEAT) // 16；余量下拍续发
    .map((p) => ({
      projectId: p.id,
      path: p.path,
      repoUrl: p.repoUrl,
      defaultBranch: p.defaultBranch
    }))
}
```

- 只对 `target.revokedAt === null` 的宿主派生（吊销宿主不得领新活，与「must not look alive」一致）。
- **maintenance 不拦截**（推荐）：克隆是宿主本地准备，不开用户会话；维护窗内照常推进反而让维护结束即 ready。若主会话倾向拦截，是一行 filter（`target.status !== 'maintenance'`），二选一在 §7 裁定。
- `key` 不需要下发；`repoUrl` 可能为敏感（内网地址），但本通道是宿主凭证保护的 TLS 控制面，与票据内明文 `repoUrl` 同级（`server.ts:2867`）。

指派下发审计（观测面小项， droppable）：宿主待指派集合变化时记一条 `project_provision_assigned`（`actor: null, targetType: 'project', result: 'success', metadata: {hostId, projectIds}`），以 host 级 in-memory 上次集合去重（重启最多重复一条，可接受）。价值：把「宿主拿到指派但永不回报（版本过旧/离线）」与「克隆在途」在审计链上区分开，补 U35 相邻的生产一致性观测面。

### 3.2 上行：零改动

宿主继续发既有 `provisioned: [{projectId, ok, error?}]`（上限 32/拍、同项目去重、seq 确认——`cloud-provision-report-queue.ts`）；平台 `applyProjectProvisionReports` 原样消费。**没有新上行字段、没有平台状态机改动、没有回报解析改动。**

### 3.3 宿主执行器

```
cloud-agent-client.refreshOnce()（beat 成功后，与 revocations/policies 应用同处）
  → parseCloudProvisionAssignments(beat.provisionAssignments)   // 防御解析，坏条目单条丢弃
  → 逐条通知 onProvisionAssignment listener
      listener = installRuntimeCloudSurfaces 里安装的 kick 执行器（cloud-runtime-attach.ts，W12b-2 同一安装点）
        1. 防御校验：path 规范绝对（无 .. / . / 空段 / 控制字符 / 尾分隔符，规则同 packages/contract/src/project-path.ts）
           + validateCloudCloneUrl(repoUrl) + defaultBranch 非空时 validateCloudBranchName
           —— 失败 ⇒ 走失败回报（CLONE_URL_INVALID / BRANCH_INVALID / PROVISION_FAILED），不抛
        2. runtime.provisionCloudProject({ projectRoot: path, repoUrl, defaultBranch })   // §1.4 三态幂等
        3. client.reportProvisioned({ projectId, ok, ...(ok ? {} : { error: `${code}: ${message}` }) })
```

执行器纪律：

- **串行 + 去重**：`inFlightByProjectId` 集合，重复指派在途时直接忽略（`cloneToPath` 的 per-path 锁是第二道防线）。
- **脱离心跳循环**：`void` 后台 promise 链，慢克隆不得阻塞 10s 控制面节拍（`refreshOnce` 自身有 single-flight，绝不能被 600s 克隆占住）。
- **粘性失败规避**：执行器未安装（runtime 未 bind）或 `provisionCloudProject` 抛 `runtime_unavailable` ⇒ **静默跳过**，等下拍重发；只有归因于克隆本身的失败才回报（failed 是粘性的，需要 admin 动作才能退出，不能因宿主暂时没准备好而误判）。
- **与回报器同点安装** ⇒ U17/W12b-2 的首启时序修复自动覆盖 kick；若指派在安装前到达（首启第一拍），丢弃即可——平台按 status 派生 ⇒ 下一拍（≤10s）必然重发，**正确性由平台状态驱动，宿主丢消息只损失一拍时延**。
- poll 模式宿主（`config.heartbeat === undefined`）：无下行通道，不安装执行器，现状不变（票据路径仍是其唯一通路）。

### 3.4 幂等 / 时序矩阵

| 场景                                        | 行为                                                                                                                                          | 依据                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 同拍/跨拍重复指派                           | 第二次进 `already-provisioned` → `registerExistingCheckout` → ok（provisioned:false）→ 重复报告被平台幂等吸收                                 | §1.4                                        |
| 克隆在途又来指派                            | `inFlightByProjectId` 忽略；即使漏防也有 per-path `withPathLock` 串行化                                                                       | clone 控制器 :164                           |
| 宿主重启                                    | 重启后首拍重发 ⇒ 继续未竟克隆；已克隆则短路                                                                                                   | 平台按 status 派生                          |
| 回报丢失（平台宕机）                        | 队列保留（32 上限、同项目覆盖）→ 恢复补报；期间重发指派幂等                                                                                   | report-queue 语义                           |
| 平台刚翻转 ready 但宿主还在跑第二个重复指派 | 短路无副作用；多余 ok 报告不改变 ready                                                                                                        | `applyProjectProvisionReports` 幂等置 ready |
| 克隆成功但项目已被 archive                  | 平台跳过 archived 的报告（`server.ts:764`）；指派派生也排除 archived                                                                          | 既有护栏                                    |
| 他宿主伪造/串线                             | 派生强制 `hostId` 绑定；平台回报处理拒他 host 项目（`:764`）                                                                                  | 双向隔离                                    |
| PUT 改 repoUrl 但路径已是检出               | `already-provisioned` 短路 ⇒ 不强制重克隆（**与票据路径现状一致**，非本设计引入）；如需强制，后续指派加 generation 字段（wire-additive 可加） | §7 开放问题                                 |

### 3.5 安全

- **通道**：宿主凭证 + TLS 控制面；指派只发给名主（`p.hostId === target.id`）。
- **信任等级**：`path`/`repoUrl`/`defaultBranch` 与票据 claims 同源同通道（平台 store → 平台下发），不引入新信任面。
- **path 边界**：宿主拒绝非规范绝对路径（`..`/`.`/空段/控制字符/相对路径/尾分隔符）——这正是平台 `validateProjectPath` 在创建时已强制的规则，宿主复核为纵深防御；`cloneToPath` 的 `requireAbsoluteCheckoutPath` 是第三道。**不做 projectsRoot 包含性判断**：admin 登记项目合法地可在 root 外（平台 admin create 只做 `validateProjectPath`，`server.ts:1486`），包含性判断会误杀既有合法项目。
- **命令面**：克隆走既有 `git clone --branch <b> -- --url <path>`（`--` 分隔，URL/branch 已过 `validateCloudCloneUrl`/`validateCloudBranchName`，`ext::` 传输被显式拒绝）。
- **爆炸半径**：`claimCloneTarget` 对已存在非空目录 EEXIST ⇒ `git clone` 拒绝 ⇒ 最坏情形是「在某个空目录/新目录里落一个检出」，与票据路径现状一致。
- **凭据**：指派只含 URL，无 token；克隆凭据沿用宿主本机 git 配置（与票据内 clone 完全一致）。
- **日志**：失败回报沿用「通用 message、不回显 URL」纪律（`project-provision.ts:33-47` 既有注释）；`console.warn` 同样不打印 URL。

---

## 4. 改动清单（文件级）

### 平台（`cloud-platform/apps/api/src/`）

| #   | 文件        | 改动                                                                                                                                                                                                                                                                                                                       |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `server.ts` | 新增纯函数 `pendingProvisionAssignments(hostId)`（过滤/排序/切片 16）；heartbeat 响应体在 `revokedAt === null` 分支加 `...(assignments.length ? { provisionAssignments: assignments } : {})`（置于 `projectsRootRejected` 旁，沿用其注释风格）；指派集合变化时 `project_provision_assigned` 审计（host 级 in-memory 去重） |
| P2  | —           | store.ts / 契约包 / 请求 wire：**零改动**（status 派生，无新字段；上行 `provisioned` 原样）                                                                                                                                                                                                                                |

### 宿主（`src/main/`）

| #   | 文件                                                                 | 改动                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `cloud-platform/cloud-host-enrollment.ts`                            | `HeartbeatResult` 增加 `provisionAssignments: unknown`（原始透传，与 `policies`/`revoked` 同风格；`readField` 摘取）                                                                                                                                                                                                                                                      |
| H2  | 新文件 `cloud-platform/cloud-provision-assignment.ts`                | `CloudProvisionAssignment` 类型；`parseCloudProvisionAssignments(value): CloudProvisionAssignment[]`（`readArrayValue`/`readString` 防御解析，条目数 ≤16、字段长度截断、类型不符单条丢弃）；`isProvisionableCheckoutPath(path)`（规范绝对判定，宿主侧 twin，规则对齐 `packages/contract/src/project-path.ts`——按 `cloud-credential.ts` 先例宿主不直接 import 平台契约包） |
| H3  | `cloud-platform/cloud-agent-client.ts`                               | `refreshOnce` 成功拍解析并派发；`CloudAgentClient` 接口 + 返回对象新增 `onProvisionAssignment(listener): () => void`                                                                                                                                                                                                                                                      |
| H4  | `startup/cloud-runtime-admission.ts`                                 | `CloudRuntimeTarget` 新增 `provisionCloudProject?: (input: CloudProjectProvisionInput) => Promise<CloudProjectProvisionResult>`（`OrcaRuntimeService` 已实现同名方法 ⇒ 结构化满足，`orca-runtime.ts:119` 零改动）                                                                                                                                                         |
| H5  | `startup/cloud-runtime-attach.ts`                                    | `installRuntimeCloudSurfaces`（Pick 增加 `onProvisionAssignment`）安装 kick 执行器：模块级串行队列 + `inFlightByProjectId` 去重 + 防御校验 + 失败回报 + `runtime_unavailable` 静默跳过 + 永不抛                                                                                                                                                                           |
| H6  | `runtime/orca-runtime.ts` / `runtime-repository-clone-controller.ts` | **零改动**（克隆/初始化/注册全复用）                                                                                                                                                                                                                                                                                                                                      |

### 测试

| #   | 文件                                                                   | 改动                                                                                                                    |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| T1  | 新 `src/main/cloud-platform/cloud-provision-assignment.test.ts`        | 纯单测：正常解析、缺字段/错型单条丢弃、条数截断、path 非法形态矩阵（`..`/相对/尾分隔符/控制字符）、URL/branch 校验对接  |
| T2  | 新 `src/main/cloud-platform/cloud-provision-kick.test.ts`              | 真平台 + 真注册宿主 + 真 TLS runtime + 真 bare git（仿 `cloud-project-provisioning.test.ts` 骨架），用例见 §5-A         |
| T3  | `src/main/cloud-platform/cloud-project-provisioning.test.ts`（M57）    | 复活 + 语义改写，见 §5-C                                                                                                |
| T4  | `src/main/cloud-platform/cloud-repo-less-project.test.ts`              | W12b-3 还原「宿主亲手克隆」（回退 `c6fc42880ce` 对该用例的 hunk + 补 wait-ready 循环），见 §5-B                         |
| T5  | 新 `cloud-platform/test/e2e/provision-assignment-delivery.e2e.test.ts` | 真平台进程 + 伪造心跳宿主（仿 `project-connect-readiness.e2e.test.ts` 的 `registerHost`+`beat`），平台半边闭环，见 §5-D |
| T6  | 既有回归批                                                             | §5-E 清单，全部零改动跑绿                                                                                               |

---

## 5. 回归测试方案

### A. 用户精确场景（U37 验收主用例，T2 内）

「开发者建带 repoUrl 的自建项目 → **无任何人工介入** → 宿主自动克隆 → 平台 ready → connect 200 → 打开工作区」：

1. `startSelfServiceHarness`（真平台+真注册宿主+`ORCA_CLOUD_PROJECTS_ROOT`+真 git，`cloud-self-service-project-fixture.ts`）；
2. `session.createProject({ name, dir, repoUrl: harness.repoUrl, defaultBranch: 'main' })` ⇒ `ok:true`，平台 `status === 'provisioning'`；
3. **全程不调用 `ensureWorkspace`/`connect`**：`beatUntil(status === 'ready')`（宿主 `refresh()` ×2 模式）；
4. 断言宿主事实（克隆是宿主亲手做的，不是测试预置）：`existsSync(projectRoot)`、`git rev-parse --show-toplevel === projectRoot`、`abbrev-ref HEAD === 'main'`、`README.md === PROVISIONING_README`；
5. `session.ensureWorkspace(projectId)` ⇒ `ok:true, created:true`（= **connect 200** + 托管 worktree 创建），`workspacePath` 位于 `.orca-worktrees/zhangsan/` 下且 toplevel 自洽；
6. `worktree.list` 以 `path:<projectRoot>` 解析成功（store 登记尾生效，U23 家族语义）；
7. 审计：`project_provision` success（targetId=projectId）；若保留 P1 审计项，加 `project_provision_assigned` 断言。

### B. U34 套件 2「宿主亲手克隆」实证能力恢复（T4）

`W12b-3 对照` 还原为真语义：删去测试侧 `git clone` 预置，恢复 `createProject({..., repoUrl: harness.repoUrl, ...})`（回退 `c6fc42880ce` 的 hunk），其后插入 `beatUntil(ready)`；其余断言**逐字保留**（create ok + `environment.projectRoot`、`README === PROVISIONING_README`、`ensureWorkspace created:true` 于 `.orca-worktrees`）。用例注释从「U20 后结构性不可达，改由测试预置」改为「宿主经心跳指派亲手克隆」。文件头「Why no platform status assertions」同步解除（该套件现在也钉平台 ready）。

### C. M57 套件复活评估（T3）

- **M57-1（成功）**：kick 落地后，克隆发生在票据外；`session.ensureWorkspace` 前需 `beatUntil(ready)`（否则首拍前 connect 撞 409 `PROJECT_PROVISIONING`——这正是 U34 套件 1 已适配的同型竞态）。票据内的 `project.provision` 退化为 `already-provisioned` 短路（`registerExistingCheckout`），返回 `ok:true, provisioned:false`。断言全部保持成立：检出 README/toplevel、workspacePath 于 `.orca-worktrees`、心跳后平台 `ready` + `provisioningError` 为空、`project_provision` 审计 success。**套件头注释改写**：机制从「票据内首克隆」变为「kick 首克隆 + 票据内幂等重备」，用户结局不变——横幅重试（`ensureProjectPrepared`）仍走同一条 RPC，其幂等性正是本用例新钉住的事实。
- **M57-2（失败）**：失败项目改由 kick 打败（票据根本拿不到）：`beatUntil` 收敛到 `failed`；断言 `provisioningError` 含 `CLONE_FAILED`、`existsSync(failedCheckoutPath) === false`（`cleanupClaimedCloneTarget` 清理语义不变）、`project_provision` 审计 failure；`session.ensureWorkspace(failedProjectId)` 的期望码从 `CLONE_FAILED` 改为 **`PROJECT_NOT_PREPARED`**（U20 门禁在 failed 上的 409，与 U34 适配后的 repo-less 套件同型）。
- 结论：M57 两例都可复活，改动限定在「前置 wait-ready + 失败码 + 头注释」，断言强度不降（宿主克隆事实、清理事实、回报闭环、审计四类断言全保留）。

### D. 平台半边闭环（T5，真平台进程 + 伪造心跳宿主）

1. **派生与绑定**：admin create 带 repoUrl ⇒ `beat()` 响应含 `provisionAssignments`（projectId/path/repoUrl/defaultBranch 全对）；第二个宿主的 `beat()` 响应**不含**（hostId 绑定）；repoUrl 为空 / `ready` / `failed` / `archived` 项目均不派生。
2. **闭环**：`beat({ provisioned: [{projectId, ok: true}] })` ⇒ 项目 `ready` ⇒ 下拍指派消失 ⇒ 开发者 `connect` **200**（U37 关环的平台半边直证）。
3. **失败闭环**：`ok:false, error:'CLONE_FAILED: …'` ⇒ `failed + provisioningError` + `project_provision` 审计 failure ⇒ 指派消失（无重试风暴）；admin PUT 换好 URL ⇒ 重回 provisioning ⇒ 指派重现。
4. **上限**：>16 个 pending 项目 ⇒ 单拍 ≤16、稳定按 `createdAt` 序，余量下拍续发。
5. **wire 加性**：无 pending 时响应**不含**该键；含 pending 时既有字段（`policyVersion/policies/revoked/maintenance/serverTime`、U21 `projectsRootRejected`）逐字段不变。
6. **指派审计**（若保留）：集合变化恰一条 `project_provision_assigned`，同集合重拍不重复。
7. **吊销宿主**：`DELETE /v1/hosts/:id` 后 `beat`（凭证仍有效）响应不含指派。

### E. 零改动回归批（防 U37 修复引入新回归）

| 套件                                                                                                                       | 防的是什么                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `cloud-platform/test/e2e/project-connect-readiness.e2e.test.ts`                                                            | U20 门禁逐字不变（provisioning/failed 仍 409；ready 快路径照旧）           |
| `cloud-platform/test/e2e/projects-root-change-guard.e2e.test.ts`                                                           | U21 下行字段先例不受新字段影响                                             |
| `src/main/startup/cloud-runtime-admission-attach.test.ts`（U34 套 1）                                                      | 回报器/kick 执行器同点安装的首启时序（W12b-2/U17）不回退                   |
| `src/main/cloud-platform/cloud-repo-less-project.test.ts` 其余用例、`self-service-projects`/`self-service-project-dir` e2e | repo-less 三态（init/已有目录/已登记检出）零回归                           |
| `cloud-platform/test/e2e/m70-acceptance.e2e.test.ts` + 平台 e2e 全批 + `project-update`/`project-archive`                  | PUT/restore 置 provisioning 的既有断言（翻转语义不变，只是现在有宿主接活） |
| `src/main/cloud-platform/cloud-project-provision.test.ts`（纯单元）                                                        | 四态计划/URL/branch 校验不动                                               |
| 全量：`pnpm tc:node` + `node config/scripts/run-vitest.mjs`（U28 入口）+ `oxlint` + `cloud-platform` e2e 批                | 常规门禁                                                                   |

验收探针（首批验收模式，留档 `cloud-platform/evidence/u37-provision-kick/`）：对 T2-A 的用户精确场景出 observation JSON（含观察输出原文，遵 U27 整改），并在 kick 落地前先录一条「死锁复现」对照（create 带 repoUrl → 3 拍心跳后仍 provisioning → connect 409）。

---

## 6. 实现令（三段，域不相交）

> 每令独立可合入：令 A 单独上线=字段无人读（行为不变）；令 B 单独上线=旧平台无字段（无指派、无行为变化）。依赖关系仅 C 需要前两者。

| 令               | 域                                                              | 内容                                                                    | 文件  | 估时                                                                                                                    |
| ---------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| **A 平台下行**   | `cloud-platform/apps/api`                                       | `pendingProvisionAssignments` + 响应字段 + 指派审计（§3.1，审计项可裁） | P1    | ~15 min                                                                                                                 |
| **B 宿主执行**   | `src/main/cloud-platform` + `src/main/startup`                  | 解析/校验模块 + 事件派发 + 目标类型 + kick 执行器（§3.3 全部纪律）      | H1–H5 | ~20 min                                                                                                                 |
| **C 测试与回归** | `src/main/cloud-platform/*.test.ts` + `cloud-platform/test/e2e` | T1–T5 + §5-E 回归批                                                     | T1–T6 | ~2×20 min，**建议拆两遍跑**：C1=平台 e2e（T5，随令 A 审定）+ 单测 T1；C2=宿主端到端 T2 + M57/套件 2 复活 T3/T4 + 回归批 |

---

## 7. 开放问题（主会话裁定）

1. **maintenance 宿主是否拦截指派**：推荐不拦截（克隆是本地准备，维护结束即 ready）；拦截则一行 filter + 一条用例。
2. **`project_provision_assigned` 审计**：推荐保留（区分「宿主版本过旧/离线」与「克隆在途」，补 U35 相邻观测面）；若求最小可在令 A 中裁掉，后续 wire/additive 补。
3. **PUT 改 repoUrl 到「已是检出」的路径**：kick 与票据路径一样 `already-provisioned` 短路，不强制重克隆（现状语义，非本缺陷范围）。若产品要求强制，需指派加 generation/expectedRemote 字段 + 宿主强制重克隆语义（会清用户本地状态），建议另立台账评估。
4. **U20 的 provisioning 409 分支保留为应急回退开关**：方案 c（放行 provisioning）不实施，但若 kick 上线前线上被死锁卡住，回退 `43c79e1978b` 的 provisioning 分支可临时解锁（代价=失败暴露点回退），此回退是否预置成 feature flag 由主会话定。

## 8. 主会话审定（2026-11-14）

§7 四项裁定：① maintenance 宿主**拦截**新指派（恢复后续派）；② 指派审计**保留轻量版**（仅非空拍一条批量 `provision_assign` 事件）；③ PUT 改 repoUrl 到已有检出**不强制重克隆**（already-provisioned 幂等优先）；④ U20 回退开关**不预置**（YAGNI，kick 使门禁安全）。实现切 A（平台下行 ~15min）/ B（宿主执行 ~20min）以本文档契约为界可并行；C 测试回归（含用户精确场景端到端+U34 套件 2 还原+M57 复活）待 A+B 落地。
