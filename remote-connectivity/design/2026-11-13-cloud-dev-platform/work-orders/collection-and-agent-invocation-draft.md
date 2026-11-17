# `agent_invocation` 仅元数据采集方案（草案 · 待裁定）

> 状态：**草案，未获批准**。本文仅作为 D1/D2 的决策输入，**不得**登记为已批准，**不得**据此派实现；P1 不得开工。
> 上游：`pending-decisions-2026-11-17.md`（D1 采集 A+、D2 P1、D3 审计存储二期）。
> 口径：只描述已存在的数据与代码落点；未落地项标注「新增」。日期 2026-11-17。

## 0. 本文的定位

- 回答两件事：D1 的「仅元数据」隐私边界落到哪些字段；D2 的 `agent_invocation` 若启动，数据模型与采集链路长什么样。
- 不回答：是否启动 P1（D2）、是否做审计存储二期（D3）、是否采集 prompt 正文（D1 隐私选项 B/C）。
- 结论均为**建议默认值**，由用户在文末「待裁定节」确认后另行立项。

## 1. 范围与不做什么

**做（仅元数据）**

- 每次 agent 调用产生**一条**结构化记录：谁、在哪个宿主/项目/工作区、用哪个 agent/模型、何时开始结束、耗时、结果、token 计数、工具调用次数、是否用户手势。
- 记录由**执行宿主产生**，经心跳批量上报，平台写入审计链并提供查询；Orca Web 复用现有审计查询入口展示。

**明确不做（负控清单）**

| 不采集 | 说明 |
| --- | --- |
| prompt / 用户输入正文 | 与 `requirements.md` §5.4「不记录 AI 对话内容」（L425-429）一致 |
| 模型回复 / thinking / 摘要正文 | 同上 |
| 终端输出、命令文本 | §5.4 明文禁止；FR-10.6（L386）默认不含终端内容 |
| 文件内容、文件路径、仓库路径 | 只保留不透明的 `workspaceId` / `projectId`，不保留路径 |
| 工具入参/出参、工具名清单 | 只保留 `toolCallCount` 计数，不保留工具名与参数 |
| 代码片段、diff、错误堆栈正文 | 只保留归一化 `result` 与可选 `exitCode` |
| 正文摘录开关 | 不新增；U66 摘录模型（默认关闭、需合规确认）仅适用于文件事件，不延伸到 agent 调用 |

## 2. 数据模型

### 2.1 事件粒度

- **一次 invocation = 一个 Orca agent 会话的完整生命周期**（启动 → 结束），结束时合并为一条记录上报。
- 不在 turn 级或工具调用级产生事件；turn 数只作为计数字段。
- 逻辑事件名：`agent_invocation`；链上 `eventType` 同为 `agent_invocation`（新增到 `audit-event-catalog.ts:7` 的白名单，否则管理台操作类型下拉不可见，见该文件头注释）。

### 2.2 字段表

类型约定：`string` 均有长度上限；时间一律 epoch ms（宿主时钟）。「来源」列给出现有取数位置；标「新增」表示当前无生产者。

| # | 字段 | 类型 | 必填 | 来源 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | `invocationId` | string(36) | 是 | **新增**（宿主 `randomUUID`） | 幂等键；重投不产生第二条 |
| 2 | `schemaVersion` | int | 是 | **新增**（首版 `1`） | 旧平台/新宿主兼容判据 |
| 3 | `hostId` | string(128) | 是 | `AgentSessionJournalIdentity.hostId`（`src/shared/agent-session-journal-types.ts:56-67`）；平台侧即 `target.id` | 执行宿主 |
| 4 | `sessionId` | string(128) | 是 | `AgentSessionJournalIdentity.sessionId`（同上） | Orca 会话主键 |
| 5 | `workspaceId` | string(128) | 是 | `AgentSessionJournalIdentity.workspaceId`（同上） | worktree/文件夹/远程工作区键；**不是路径** |
| 6 | `projectId` | string(128) | 否 | 云会话票据身份 `CloudFileEventIdentity.projectId`（`src/main/cloud-platform/cloud-file-event-audit.ts:22-31`） | 非云会话为空 |
| 7 | `subject` | string(128) | 否 | 票据 `sub`，`user:<username>`（同上，宿主自报、平台解析 actor） | 与文件事件主体口径一致 |
| 8 | `agentType` | string(64) | 是 | `AgentType`（`src/shared/agent-status-types.ts:59`） | claude / codex / … |
| 9 | `model` | string(256) | 否 | 供应商帧解析，`src/main/claude/claude-context-usage.ts:50` | 只存模型 id，不存上下文内容 |
| 10 | `startedAt` | number | 是 | 会话首帧 `observedAt` / 启动事件（`claude-structured-session-state.ts:39-96`） | 宿主时钟 |
| 11 | `endedAt` | number | 是 | `ended` 事件 `observedAt`（`claude-structured-session-state.ts:73-95`） | 宿主时钟 |
| 12 | `durationMs` | int | 否 | 由 10/11 计算 | 防止客户端时钟漂移导致误算 |
| 13 | `result` | enum | 是 | `ended.reason` + 失败事实映射为 `success`/`failure`/`cancelled`/`unknown` | 不存 reason 原文 |
| 14 | `exitCode` | int \| null | 否 | 结构化会话首手退出状态 `ExitStatus.code`（`claude-stream-json-connection.ts:105`） | 仅首手子进程可用；远程/旧宿主可为空 |
| 15 | `signal` | string \| null | 否 | 同上 `ExitStatus.signal` | 枚举化，不存文本 |
| 16 | `tokens` | object | 否 | `AgentSessionTokenUsage`（`src/shared/agent-session-context-usage.ts:6-11`，解析入口 `claudeTokenUsage` `claude-context-usage.ts:32`） | 仅供应商上报值：`inputTokens` / `cacheCreationInputTokens` / `cacheReadInputTokens` / `outputTokens`；缺失记 null，**不用本地估算填充** |
| 17 | `turnCount` | int | 否 | **新增**计数器（会话内 turn 边界计数） | 首版可为 0/缺省 |
| 18 | `toolCallCount` | int | 否 | 对 `claudeToolUses`（`claude-structured-item-translation.ts:122`）逐条计数，**丢弃 id/name/input** | 只有次数 |
| 19 | `userGesture` | `true` \| `false` \| `unknown` | 是 | **新增**；当前无「用户手势 vs 自动/恢复」信号 | 首版默认 `unknown`，不推断（见 Q3） |
| 20 | `batchSeq` | int | 是 | 现有心跳批序号 `CloudHostAuditBatch.seq`（`src/main/cloud-platform/cloud-host-audit.ts:62`） | 去重与缺口定位 |
| 21 | `bootId` | string(16) | 是 | `CloudAuditGap.bootId`（`cloud-host-audit.ts:52-60`） | 宿主重启后代次 |
| 22 | `orcaVersion` | string(64) | 否 | 心跳 `source.orcaVersion`（`cloud-heartbeat-body.ts:12,36`） | 宿主版本碎片归因 |

### 2.3 记录级约束

- **整条拒绝，不做部分理解**：任一字段未知/越界即丢弃整条并计入缺口，沿用 `parseFileEventMetadata` 的 all-or-nothing 语义（`cloud-platform/apps/api/src/host-audit-ingest.ts:110-186`）。
- 无自由文本字段；`subject` 来自票据、`model`/`agentType` 走长度+枚举校验。
- `invocationId` 去重窗口：宿主队列内去重 + 平台按 `(hostId, invocationId)` 幂等。

## 3. 采集路径

### 3.1 角色分工

| 角色 | 职责 | 落点 |
| --- | --- | --- |
| 执行宿主 | 唯一事实源：观察会话生命周期、聚合记录、离线缓冲、按能力协商上报 | `src/main/claude/*` 会话状态 + `src/main/cloud-platform/*` 队列 |
| 平台 API | 校验、幂等、写审计链、提供查询 | `cloud-platform/apps/api/src/*` |
| Orca Web | 主分析入口：复用完整 App 壳与既有审计查询页，不新建独立采集/分析前端 | `src/renderer/src/web/main.tsx:8`（`web-root` 懒加载 App） |
| 中继 / 平台控制面 | **不采集**，只转发/注册；维持 requirements §2.3 数据面不过平台 | — |

### 3.2 宿主 → 平台：心跳，不走客户端 RPC

- **不**复用 `audit.recordFileEvent`：该 RPC 是「客户端声明」通道（`src/main/runtime/rpc/methods/cloud-audit.ts:146`），agent 调用由宿主 firsthand 观察，走客户端 RPC 会引入伪造面。
- 复用**宿主审计队列**：`createCloudHostAuditQueue`（`cloud-host-audit.ts:82`）已有容量上限（`MAX_PENDING_EVENTS=200`，L47）、`bootId`、缺口计数器；在 `CloudHostAuditEventType` 中新增 `agent_invocation`，记录经同一队列等待下一次心跳。
- 心跳体扩展：`cloudHeartbeatBody`（`src/main/cloud-platform/cloud-heartbeat-body.ts:36`）新增可选 `agentInvocations` 数组；空批不发送（与现有 `provisioned`/`audit` 同策略）。发送点 `cloud-agent-client.ts:163`。
- 能力协商：平台在心跳响应扩展 `auditCapabilities.agentInvocations`（现有 `auditCapabilities` 见 `server.ts:3722`；宿主解析 `cloud-agent-response-parsing.ts:67`）。**未声明即不投递并计入 suppressed**，与 `fileEvents` 的严格门控一致（`cloud-file-event-audit.ts:67-90`），保证旧宿主/旧平台混合版本安全。
- 缺口可见性：复用 `auditGap`（`cloud-host-audit.ts:52`）与 `host.audit_gap` 链事件；新增采集不引入第二套丢失语义。

### 3.3 平台 ingest 与查询

- 心跳入口：`POST /v1/hosts/:id/heartbeat`（`server.ts:3569`）。
- 解析与入链：在 `appendHostAuditReports(...)`（`server.ts:3672`）旁新增 `appendAgentInvocations(...)`，复用 `parseHostAuditReports`/`appendFileEvent` 的白名单与 actor 解析模式（`host-audit-ingest.ts:219, 271, 313`）。
- 写入：扩展现有审计链 `audit.append` / `AuditEventInput`（`store.ts:102`），追加 `eventType: 'agent_invocation'` 到 `AUDIT_EVENT_TYPES`（`audit-event-catalog.ts:7`）。
- 查询：一期直接用 `GET /v1/audit/events`（`server.ts:4068`，支持 `eventType`/`hostId`/`projectId`/`since`/`until`）+ `GET /v1/audit/status`（`server.ts:4162`）做容量与缺口展示；Orca Web 通过既有审计页消费，不新增前端埋点。

```text
Claude/Codex 会话事件 ──聚合──▶ invocation 记录 ──▶ CloudHostAuditQueue
                                                       │ 下次心跳
                                                       ▼
                          POST /v1/hosts/:id/heartbeat (agentInvocations[])
                                                       │
                                    parse + 幂等 + 白名单校验
                                                       ▼
                                    audit.append → JSONL 哈希链
                                                       ▼
                                GET /v1/audit/events → Orca Web / 管理台
```

## 4. 隐私与治理

**字段白名单**：以上表为唯一契约；契约外字段一律不进入序列化（宿主先裁剪，平台再整条拒绝）。新增字段必须同步修改本文档与 `audit-event-catalog.ts`。

**脱敏**：

- 不存任何正文、路径、工具名、参数；`workspaceId`/`projectId` 是不可反查路径的键。
- `subject` 与文件事件同口径（票据 `user:<username>`）；如 Q4 选择最小化，可只保留 `deviceId` 由平台解析，宿主不持有用户名。
- token / 计数均为数值；`exitCode` 仅首手退出可用，缺失写 null，不推断。

**保留期**：与 §5.4 一致，**180 天**；归档加密。删除路径只有「到期 + 归档生命周期」，哈希链本身**不支持按用户删除**（删除会破链）。因此本方案不以正文/主体明细为前提；若合规要求单主体删除，只能把主体索引放在链外（见 Q4）。

**开关**：

| 开关 | 位置 | 建议默认 |
| --- | --- | --- |
| 平台全局采集开关 | 心跳响应 `auditCapabilities.agentInvocations` | **开**（仅元数据，与 §5.4 不冲突）；管理员可全局关闭 |
| 旧版本兼容 | 未声明能力的平台/宿主 | **关**（严格门控，不投递，计入 suppressed） |
| 本地/SSH 会话 | 非云会话 | **不产生事件**（与文件事件一致） |
| 用户级逐条 opt-out | — | 一期**不提供**；仅提供可见说明与全局开关（Q4 待裁定） |

**用户可见说明**：设置页「数据与隐私」增加一行：采集每次 agent 调用的元数据（时间、宿主、项目、agent/模型、耗时、token 数、工具调用次数、结果），**不采集对话、终端、代码或文件内容**；指向保留期与管理员开关。发布说明同步。

**删除路径**：宿主本地缓冲仅在内存，进程重启即丢（`cloud-host-audit.ts:7-12`）；平台侧 180 天到期删除；不提供逐条删除 API。

## 5. 容量与成本

**单条体量**：约 0.5–1.2 KB（无正文，最多几十个标量字段）。

**频次**：每次会话 1 条（启动+结束合并）；异常/中断仍为 1 条（`result=failure`），不补发第二条。

| 场景 | 估算 |
| --- | --- |
| 500 开发者 × 5–15 会话/日 | **2.5k–7.5k 条/日** |
| 峰值（×2 缓冲） | ~15k 条/日 |
| 日增体量 | ~1.5–12 MB/日 |
| 180 天累积 | 0.3–2.2 GB（未计索引） |

**与审计存储二期（D3）的关系**：

- 该量级**可能超过** U66 一期文件事件包线（`≤5k 文件事件/日`、总量 `≤100 万条`，`audit.ts:41-42`），因此：
  - 建议为 `agent_invocation` 设**独立包线**（建议初始 `≤10k/日`、总量 `≤180 万条`），不占用文件事件额度；
  - `GET /v1/audit/status` 分事件族计数，容量告警同时反映两族；
  - 触发 D3 的条件维持「文件事件 >5k/日」原文，并新增一条观测项：agent_invocation 连续 7 天 >10k/日 或链内总量 >180 万条 → 启动存储二期评估。**D3 仍不作为 P1 前置**。
- 若最终选择不入链、改独立表（Q5），则一期不触碰哈希链，D3 触发只看该表容量；代价是失去链上可验证性。

## 6. 开放问题与建议默认值

| 编号 | 问题 | 建议默认 | 理由 |
| --- | --- | --- | --- |
| Q1 | invocation 粒度：会话生命周期 vs 每个用户提交（turn） vs 每次工具调用 | **会话生命周期一条**，turn 只计数 | 频次可控、token 可按会话汇总；turn/工具级会把量放大 10–100 倍且更接近内容面 |
| Q2 | token 计数来源：供应商上报 vs 本地估算 | **仅供应商上报**，缺失为 null | 估算值不可复现，混入后无法区分口径；现有 `claudeTokenUsage` 已是供应商字段解析 |
| Q3 | `userGesture` 是否必须：当前无信号 | **首版三态默认 `unknown`**，不推断；若产品不需要，可从 schema 移除 | 无来源的布尔值会制造假事实；确定来源（composer 提交/恢复/自动）后再升级为 true/false |
| Q4 | 主体标识与用户可见性：`user:<username>` vs 仅 `deviceId`；是否提供用户级 opt-out | **沿用 `user:<username>`** + 设置页说明，**不提供**逐条 opt-out | 与文件事件审计主体一致，管理员查询可用；链不可删风险由「仅元数据」缓解。若合规要求单主体删除，改仅 `deviceId` + 链外索引 |
| Q5 | 存储位置：审计哈希链 vs 独立表 | **一期入现有审计链**，不新建表 | 复用 ingest/查询/缺口/保留期；量级仍可由独立包线承接。独立表留到 D3 |
| Q6 | 旧宿主/缺失语义与 schema 版本化 | **能力未声明即不采集**；`schemaVersion=1`；未知字段整条拒绝 | 混合版本是常态；严格门控保证旧宿主行为字节不变，避免半懂记录入链 |

## 7. 待裁定节（空表，等待用户填写）

| 编号 | 议题 | 候选 | 裁定结果 | 裁定人 | 日期 |
| --- | --- | --- | --- | --- | --- |
| D1 | 采集架构 A/B/C | A 宿主为中心 / B 平台中继 / C 双轨 |  |  |  |
| D1-隐私 | prompt 正文边界 | A 仅元数据 / B 默认关闭摘录 / C 默认采集 |  |  |  |
| D2 | 是否启动 P1（仅元数据） | 启动 / 等待 / 仅保留自助建项目 |  |  |  |
| Q1 | invocation 粒度 | 会话 / turn / 工具调用 |  |  |  |
| Q2 | token 来源 | 供应商 / 估算 |  |  |  |
| Q3 | `userGesture` | 三态 unknown / true-false / 移除 |  |  |  |
| Q4 | 主体与 opt-out | username / deviceId；有无 opt-out |  |  |  |
| Q5 | 存储位置 | 审计链 / 独立表 |  |  |  |
| Q6 | 兼容与版本 | 能力门控 + schemaVersion |  |  |  |

> **裁定前约束**：本表为空即表示未批准。P1 不得据此开工；不得新增任何采集字段、事件类型、心跳字段或表结构。

## 附：证据索引（均为当前工作树路径）

- 决策输入：`remote-connectivity/design/2026-11-13-cloud-dev-platform/work-orders/pending-decisions-2026-11-17.md`
- 隐私边界：`remote-connectivity/design/2026-11-13-cloud-dev-platform/requirements.md` §5.4（L425-429）、FR-10.6（L386）
- 宿主队列/缺口：`src/main/cloud-platform/cloud-host-audit.ts:47,52,62,82`
- 心跳体/发送：`src/main/cloud-platform/cloud-heartbeat-body.ts:36`、`cloud-agent-client.ts:163`
- 文件事件 intake（复用模板）：`src/main/cloud-platform/cloud-file-event-audit.ts:22,67`、`src/main/runtime/rpc/methods/cloud-audit.ts:146`
- 平台 ingest：`cloud-platform/apps/api/src/host-audit-ingest.ts:219,271,313`、`server.ts:3569,3672,3722,4068,4162`
- 审计链/目录：`cloud-platform/apps/api/src/store.ts:102`、`audit.ts:41`、`audit-event-catalog.ts:7`
- 会话身份/事件：`src/shared/agent-session-journal-types.ts:56`、`src/shared/agent-status-types.ts:59`、`src/main/claude/claude-structured-session-state.ts:39,73`
- token/工具计数：`src/shared/agent-session-context-usage.ts:6`、`src/main/claude/claude-context-usage.ts:32,50`、`claude-structured-item-translation.ts:122`
- 退出状态：`src/main/claude/claude-stream-json-connection.ts:105`
- Orca Web 入口：`src/renderer/src/web/main.tsx:8`、`current-state/m09-orca-web.md` §1
