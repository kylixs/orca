# U202：M116-QA-031 审计导出设计与工作令

- 状态：草案，待裁定（本文只出设计与拆分，不改 `apps/**`、不写实现代码）
- 缺陷：M116-QA-031（P2）——审计「无导出」不是缺按钮：设计已定义 `POST /v1/audit/export` 与 `GET /v1/audit/exports/{jobId}`，实现完全缺失
- 台账：`defect-ledger.md:212`（U201），处置为「先出工作令」
- 设计依据：`design.md:984`（权限）、`design.md:1034-1035`（端点）、`design.md:1191`（`audit_exports` 表）、`requirements.md:246-249`（FR-8.2/8.3/8.5）
- 范围：平台 API（`cloud-platform/apps/api`）与平台 Web（`cloud-platform/apps/web`）；不含宿主侧
- 约束：纯新增端点；旧 peer 不受影响；所有引用以当前分支代码为准

---

## 1. 现状核查（只列可核验事实）

| 项 | 现状 | 证据 |
|---|---|---|
| 导出端点 | 不存在。审计段只有查询、状态、校验三条路由 | `server.ts:5233`、`server.ts:5327`、`server.ts:5366`；全仓无 `audit/export` 路由 |
| 导出任务存储 | 不存在。`Store` 无 `auditExports` 字段 | `store.ts:156-186` |
| 查询过滤语义 | 全部内联在 `GET /v1/audit/events` 路由体内 | `server.ts:5233-5325` |
| 查询谓词 | `AuditChain.query()` 单遍倒序扫描，按 `cursor`/时间/类型/actor/result/traceId/projectId/hostId/username/fileName/keyword 过滤 | `audit.ts:234-270`；类型定义 `audit.ts:16-40` |
| 权限门禁 | `isAdmin` 或 `platform:auditor`；否则 `denyPrivileged` 写 denied 事件并 403 | `server.ts:1477`、`server.ts:5236-5242`、`server.ts:1964-1998` |
| 状态端点 | 已返回 `eventTypes` 权威目录，可作为能力探测载体 | `server.ts:5327-5361`；`audit-event-catalog.ts:8-49` |
| 审计存储 | `Store` 主体在内存；仅 `ORCA_PLATFORM_STORE_FILE` 显式开启 dev 快照；审计链另有 append-only JSONL 文件 | `store.ts:156-186`、`server.ts:1858-1859`、`store-persistence.ts:48-60`、`audit-log-file.ts:1-16` |
| 多副本审计 | 配置 `auditWriterUrls` 时 API 走远端单写者；查询经 `AuditSink.query`，写者侧每页上限 200 | `audit-writer-client.ts:29-44`、`audit-writer-client.ts:157-178`、`apps/audit-writer/src/writer.ts:210` |
| Web 审计页 | 已有查询、筛选、链健康、手动校验；无导出按钮 | `app.js:3798-3990`、`app.js:3956`、`app.js:3864` |
| Web 请求封装 | `api()` 只处理 JSON，401 自动刷新一次；无二进制下载封装 | `app.js:44-63` |
| 台账处置 | 未实现前 UI 不得显示导出入口 | `defect-ledger.md:212` |

结论：导出应作为**新增的异步任务**实现，过滤参数复用查询路由的解析与谓词，任务元数据与产物落文件，Web 入口在 `/v1/audit/status` 返回能力字段后才显示。

---

## 2. 契约

### 2.1 `POST /v1/audit/export`

请求体字段与现有查询参数同名同义，便于复用同一解析器（见 §2.4）：

| 字段 | 类型 | 必填 | 约束/语义 |
|---|---|---|---|
| `since` | ISO 8601 字符串 | 否 | 与查询一致；无效值按查询规则处理 |
| `until` | ISO 8601 字符串 | 否 | 服务端按请求时刻 clamp（`until = min(until, now)`），保证导出集合稳定 |
| `eventType` | string | 否 | 单类型，精确匹配 |
| `eventTypes` | string[] | 否 | ≤20 个、每个 ≤64 字符；优先于 `eventType` |
| `eventFamily` | `download` \| `copy` | 否 | `download` → `file_download` + `download_blocked`；`copy` → `file_copy` |
| `actor` | string | 否 | 精确匹配 |
| `username` | string | 否 | actor 或 metadata.subject 的大小写不敏感精确匹配 |
| `projectId` | string | 否 | 精确匹配 `targetId` |
| `hostId` | string | 否 | 精确匹配 `metadata.hostId` |
| `fileName` | string | 否 | ≤128 字符；大小写不敏感子串 |
| `q` | string | 否 | 2–128 字符；白名单字段子串 |
| `result` | string | 否 | 与查询一致，不额外收紧 |
| `traceId` | string | 否 | 精确匹配 |
| `format` | `csv` \| `jsonl` | 是 | 产物格式 |
| `confirm` | boolean | 是 | 必须为 `true`；FR-8.5「二次确认」的服务端落点，缺失/假值 400 |
| `deleteAfterDownload` | boolean | 否 | 默认 `false`；为 `true` 时首次成功下载后删除产物 |

响应（`202 Accepted`）：

```json
{
  "jobId": "exp_3f2a...",
  "status": "queued",
  "format": "csv",
  "requestedAt": 1763400000000,
  "expiresAt": 1763403600000
}
```

- `downloadUrl` 在任务未成功或产物未就绪时不出现在 POST 响应中。
- 同步阶段只做参数校验、权限、31 天窗口、并发上限与任务落盘；不扫描/序列化全量事件。

### 2.2 `GET /v1/audit/exports/{jobId}`

`200 OK`（任务存在、未过期）：

```json
{
  "jobId": "exp_3f2a...",
  "status": "queued | running | succeeded | failed",
  "format": "csv",
  "requestedAt": 1763400000000,
  "startedAt": 1763400001200,
  "finishedAt": 1763400009000,
  "expiresAt": 1763403600000,
  "totalEvents": 12345,
  "bytes": 987654,
  "error": { "code": "EXPORT_WRITE_FAILED", "message": "..." },
  "downloadUrl": "/v1/audit/exports/exp_3f2a.../download?token=..."
}
```

- `status=succeeded` 且产物仍在时返回新的 `downloadUrl`（每次调用轮换下载 token，见 §4.2）。
- `status=failed` 时 `downloadUrl` 缺失，`error` 说明原因。
- 任务过期返回 `410 EXPORT_EXPIRED`；未知 job 或非本人 job 返回 `404 EXPORT_NOT_FOUND`。
- 响应头 `cache-control: no-store`。

### 2.3 `GET /v1/audit/exports/{jobId}/download`

设计文档只写了 `GET /v1/audit/exports/{jobId}`（状态与下载链接），未定义下载子路径。本方案**新增**该子资源承载实际字节：

- 仅接受 `token` 查询参数；不接受 Bearer 作为替代（保持链接自包含，且 token 一次性）。
- 成功 `200`：
  - `content-type: text/csv; charset=utf-8` 或 `application/x-ndjson; charset=utf-8`
  - `content-disposition: attachment; filename="audit-export-<jobId>.csv|jsonl"`
  - `cache-control: no-store`
  - `x-content-type-options: nosniff`（新增，降低浏览器嗅探风险）
- 失败：`404 EXPORT_NOT_FOUND`（job/产物不存在）、`404 EXPORT_NOT_FOUND`（token 缺失/已使用/被轮换）与 `410 EXPORT_DOWNLOAD_GONE`（token TTL 过期或产物已删除）、`410 EXPORT_EXPIRED`（job 过期）。
- 不支持 `Range`（导出产物是一次性小文件；实现前不宣称可续传）。
- 该路径是纯新增；旧 peer 不会请求它。

### 2.4 与现有查询语义复用（必须复用，不复制）

| 语义 | 现有位置 | 复用方式 |
|---|---|---|
| 权限：admin/auditor，否则 403 + denied 事件 | `server.ts:5236-5242`、`server.ts:1477`、`server.ts:1964-1998` | 原样复用 `requireAuth` / `isAdmin` / `denyPrivileged`；denied 事件类型用 `audit_export` |
| `limit` 钳制（非正整数回落，最大 200） | `server.ts:5244-5246` | 导出忽略分页 `limit`，但解析器保留该行为 |
| `eventTypes` 数量/长度上限 | `server.ts:5247-5257` | 同一错误码 `INVALID_QUERY` |
| `eventFamily` → 类型集合 | `server.ts:5258-5265` | 原样复用 |
| `fileName` ≤128 | `server.ts:5266-5271` | 原样复用 |
| `q` 2–128 字符 | `server.ts:5272-5281` | 原样复用 |
| `since`/`until` 解析、31 天窗口、`since>until` | `server.ts:5282-5305` | 原样复用；`TIME_WINDOW_TOO_LARGE` |
| 仅 `q`/`fileName` 无显式窗口时默认 7 天 | `server.ts:5306-5310` | 原样复用 |
| 查询谓词 | `audit.ts:234-270`、`audit.ts:16-40` | 导出分页循环调用同一 `audit.query()`；不另写过滤 |
| 远端单写者分页上限 200 | `apps/audit-writer/src/writer.ts:210` | 导出 worker 页大小取 200，循环到 `nextCursor === null` |
| 事件类型目录 | `audit-event-catalog.ts:8-49` | 新增类型追加到该目录，状态端点自动下发 |

实现要求：把 `server.ts:5233-5310` 的解析逻辑抽成纯函数（E1），查询路由与导出路由共用；E1 必须做到现有查询行为不变。导出不传 `cursor` 给客户端，内部自行翻页。

### 2.5 错误码

| HTTP | code | 触发 |
|---|---|---|
| 400 | `INVALID_QUERY` | 参数不合法（`format` 非 csv/jsonl、`eventTypes` 超限、`q`/`fileName` 超长等） |
| 400 | `TIME_WINDOW_TOO_LARGE` | 时间窗 >31 天或 `since > until` |
| 400 | `EXPORT_CONFIRM_REQUIRED` | `confirm !== true` |
| 401 | `SESSION_EXPIRED` | 未登录/会话失效 |
| 403 | `PERMISSION_DENIED` | 非 admin 且非 auditor；同时写 `audit_export` denied 事件 |
| 404 | `EXPORT_NOT_FOUND` | 未知 jobId、非本人 job、下载 token 缺失/不匹配/已使用或被轮换 |
| 410 | `EXPORT_EXPIRED` | job 已过 `expiresAt` |
| 410 | `EXPORT_DOWNLOAD_GONE` | 下载 token TTL 过期，或产物缺失/已删除 |
| 429 | `EXPORT_BUSY` | 超过每用户/全局并发上限 |
| 500 | `EXPORT_WRITE_FAILED` | 产物/任务文件写入失败（异步任务状态 `failed`） |
| 500 | `EXPORT_CREATE_FAILED` | 受理后任务落盘失败（已 write-ahead 写受理审计） |
| 500 | `EXPORT_AUDIT_UNAVAILABLE` | 导出审计事件无法落链（创建阶段 fail-closed） |
| 500 | `EXPORT_TOO_LARGE` | 扫描超过行数/字节上限（异步任务状态 `failed`，删除半成品） |
| 500 | `EXPORT_INTERRUPTED` | 进程重启时 `queued`/`running` 任务被标记失败 |

「超大范围」在同步阶段指 **>31 天窗口 → 400**；行数/字节上限在异步阶段判失败（理由与替代方案见 §8 D3）。

### 2.6 权限与导出审计

- 权限：`platform:admin` 或 `platform:auditor`；普通用户 403（`denyPrivileged` 已写 denied 事件）。
- FR-8.5 要求「二次确认」：服务端用 `confirm: true` 强制，Web 用确认对话框设置该字段。前端隐藏不是安全边界。
- 导出动作本身落审计：
  - 新事件类型 `audit_export`：创建受理（`result=success`）、终态（成功/失败，`result=success|failure`）。
  - 新事件类型 `audit_export_download`：每次成功下载。
  - metadata 记录查询条件与条数：`jobId`、`format`、`since`、`until`、`eventType(s)`/`eventFamily`、`actor`、`username`、`projectId`、`hostId`、`fileName`、`q`、`result`、`traceId`、`totalEvents`、`bytes`、`phase`、失败时 `errorCode`。
  - 下载 token、token 哈希、产物绝对路径**不得**进入审计 metadata（记录 jobId 即可）。
  - 创建阶段的 `audit.append` 失败即拒绝创建（不产生未记录的导出）；下载审计可用 `appendBestEffort`，避免已授权数据因审计瞬时故障无法取回。该差异列入待决策 D7。

---

## 3. 存储与生命周期

### 3.1 任务记录

字段对齐设计表 `design.md:1191`（id, requested_by, query, status, object_key, expires_at），并补充运行所需字段：

| 字段 | 说明 |
|---|---|
| `id` | `exp_<24 hex>`，服务端生成（`randomBytes(12).toString('hex')`） |
| `requestedBy` | `user.id`（所有权判定） |
| `requestedByUsername` | 展示/审计用，不参与鉴权 |
| `query` | 规范化后的过滤快照（含 clamp 后的 `since`/`until`） |
| `format` | `csv` \| `jsonl` |
| `status` | `queued` \| `running` \| `succeeded` \| `failed` |
| `createdAt` / `startedAt` / `finishedAt` | 毫秒时间戳 |
| `expiresAt` | `createdAt + TTL`（默认 1h，测试可缩短） |
| `objectKey` | 仅 `events.csv` 或 `events.jsonl`（服务端常量，不接受客户端输入） |
| `totalEvents` / `bytes` | 完成时写入 |
| `error` | `{ code, message }` 或 `null` |
| `deleteAfterDownload` | 请求选项 |
| `downloadedAt` | 首次成功下载时间或 `null` |
| `downloadTokenHash` / `downloadTokenExpiresAt` | 当前唯一活动下载 token（哈希存储） |

任务记录持久化为 `<root>/<jobId>/job.json`，用「临时文件 + rename」原子替换（模式同 `store-persistence.ts:230-236`）。**不放入 `Store` 快照**：导出状态是文件型运行态，放进快照会与产物目录产生两套真相，且 dev 快照默认关闭。

### 3.2 产物位置

建议：

```text
<root>/<jobId>/job.json
<root>/<jobId>/events.csv | events.jsonl
```

- `<root>` 默认 `~/.orca-cloud/audit-exports`，可用 `ORCA_AUDIT_EXPORT_DIR` 覆盖；测试用临时目录。
- 目录 `0700`，文件 `0600`（与审计日志文件 `audit-log-file.ts:65-75` 的权限口径一致）。
- 生产容器内 API 进程的 `$HOME` 可能不是运维预期的用户；落盘前必须确认挂载卷（待决策 D2）。

### 3.3 状态机

```text
POST → queued → running → succeeded
                 └──────→ failed
```

- 「expired」不作为存储状态：由 `expiresAt` 派生，GET 返回 410。
- `deleteAfterDownload=true` 时，下载完成后删除产物文件，保留 `job.json` 到过期，`downloadedAt` 非空；再次请求下载返回 410。
- 失败任务不自动重试；用户重新发起新任务。

### 3.4 过期与清理

- `expiresAt = createdAt + 1h`（默认）。启动时清理 + 每 5 分钟清理 + 每次 GET 惰性判断。
- 清理动作：删除整个 `<root>/<jobId>` 目录；单条残留文件（无 `job.json` 的孤儿目录）一并删除。
- 启动恢复：`queued`/`running` 任务标记 `failed`，`error.code = EXPORT_INTERRUPTED`；不做自动续跑（避免重启风暴）。
- 不引入外部调度器；清理句柄随 `createApp` 生命周期创建、`close()` 时停止（参照 `storePersistence.stop()` 的模式，`server.ts:6046-6060`）。

### 3.5 并发与大小上限

| 限制 | 建议值 | 行为 |
|---|---|---|
| 时间窗 | 31 天 | 同步 400 `TIME_WINDOW_TOO_LARGE` |
| 每用户活动任务 | 2（`queued` + `running`） | 429 `EXPORT_BUSY` |
| 全局活动任务 | 8 | 429 `EXPORT_BUSY` |
| 单任务行数 | 100,000 | 异步失败 `EXPORT_TOO_LARGE`，删除半成品 |
| 单任务字节 | 64 MiB | 异步失败 `EXPORT_TOO_LARGE`，删除半成品 |
| 下载 token TTL | 5 分钟 | 过期 410 |
| 任务 TTL | 1 小时 | 过期 410，清理目录 |

- `until` 在创建时 clamp 到 `now`，导出集合由此确定；之后的追加事件不会进入本次任务。
- worker 串行写文件（单任务单 writer），避免同一 job 的并发写。

### 3.6 失败状态

| 场景 | 任务终态 |
|---|---|
| 产物写入/rename 失败 | `failed` / `EXPORT_WRITE_FAILED` |
| 远端审计写者查询失败 | `failed` / `EXPORT_AUDIT_UNAVAILABLE` |
| 行数或字节超限 | `failed` / `EXPORT_TOO_LARGE`（删除半成品） |
| 进程重启 | `failed` / `EXPORT_INTERRUPTED` |
| 磁盘空间不足 | 归入 `EXPORT_WRITE_FAILED` |

失败任务保留 `job.json` 到 `expiresAt`，便于客户端轮询读取原因；不保留半成品产物。

---

## 4. 安全

### 4.1 导出自身落审计

- 事件类型：`audit_export`、`audit_export_download`，追加到 `audit-event-catalog.ts:8-49`，Web 中文标签追加到 `app.js:3431` 的 `AUDIT_EVENT_LABELS`。
- 创建受理和终态都必须可追溯；metadata 至少包含「查询条件 + 条数」。禁止记录 token、哈希和绝对路径。
- 权限拒绝走现有 `denyPrivileged`，事件类型传 `audit_export`，`permission: 'platform:auditor'`。
- 审计写入失败时创建阶段 fail-closed（返回 500，不生成任务），与现有敏感操作门禁口径一致（`server.ts:1942-1962`）。

### 4.2 下载链接一次性 + 短期 token

- token：`randomBytes(24).toString('base64url')`，仅在 URL 中出现；服务端只存 `hashToken(token)`（`server.ts:233-235`），比较用 `safeEqual`（`server.ts:290-294`）。
- 每次 `GET /v1/audit/exports/{jobId}` 成功态响应签发**新** token，并覆盖旧的 `downloadTokenHash`（同一 job 同时只有一个活动 token）。
- TTL 5 分钟；下载时在写响应体**之前**把 token 标记为已使用（更新 `job.json`），第二次使用（hash 已清空/被轮换）返回 `404 EXPORT_NOT_FOUND`；产物缺失返回 `410 EXPORT_DOWNLOAD_GONE`。
- token 绑定 jobId 与 `requestedBy`：token 只能下载其所属 job，换 jobId 无效。
- token 不写审计、不写普通日志；如需关联，可记录 `sha256:` 前缀指纹（模式同 `server.ts:235-238` 的 `codeFingerprint`），但本方案默认不记。

### 4.3 路径穿越防护

- `jobId` 由服务端生成并校验 `^exp_[0-9a-f]{24}$`；包含 `/`、`\`、`..`、绝对路径的输入一律 404。
- 产物路径只由 `jobId` + `objectKey` 拼接，`objectKey` 只允许 `events.csv` / `events.jsonl` 两个常量；客户端不能指定文件名。
- 拼接后 `resolve(root, jobId, objectKey)`，并断言 `path.relative(root, full)` 不以 `..` 开头、不是绝对路径。
- 目录 `0700`、文件 `0600`；读取前 `lstat` 拒绝符号链接（或 `realpath` 后再做前缀校验）。
- 绝不复用请求里的 `jobId` 作为文件名的一部分而不校验。

### 4.4 传输与缓存

- 所有导出 JSON 响应与下载响应：`cache-control: no-store`（先例：`server.ts:3022`、`server.ts:3440`）。
- 下载额外加 `x-content-type-options: nosniff`；不设置 `content-disposition` 的用户可控文件名。
- 复用 `json()` 携带的静态安全头（`server.ts:183-191`、`static-delivery.ts:15-17`）。
- 直接字节响应需自行设置上述头，不能走 `json()`。

### 4.5 CSV 注入与内容边界

- CSV 按 RFC 4180 转义（字段含 `,`、`"`、换行时加引号，`"` 翻倍）；`metadata` 序列化为 JSON 字符串后同规则转义。
- 公式注入：字段以 `=`、`+`、`-`、`@`、制表符、回车开头时前置 `'`。这会改变原值，需在导出说明/文件头注记（待决策 D9）。
- JSONL 每条一行 `JSON.stringify(event)`，保留 `prevHash`/`hash`，便于离线校验链；不 pretty-print。
- 导出只含审计字段；FR-8.6 已规定审计不记录终端/文件/AI 内容，导出不得扩大该边界。

---

## 5. 兼容性

- **纯新增**：两个新端点 + 一个下载子路径；不改现有查询/状态/校验行为。旧客户端不会调用，旧服务端对新客户端只是 404（新客户端不会在缺能力时调用）。
- **能力探测**：在 `GET /v1/audit/status` 响应中新增 additive 字段（旧客户端忽略未知字段）：

```json
{
  "auditExport": {
    "formats": ["csv", "jsonl"],
    "maxWindowDays": 31,
    "maxRows": 100000,
    "maxBytes": 67108864,
    "jobTtlSeconds": 3600,
    "downloadTokenTtlSeconds": 300
  }
}
```

- Web 仅在 `state.auditStatus?.auditExport?.formats?.length > 0` 时显示导出入口；状态请求失败（现有 `.catch(() => null)`，`app.js:3864`）或字段缺失时保持隐藏。**不采用 404 探测**：POST 探测会产生副作用与额外审计噪音。
- 事件类型目录新增两项：旧 Web 的下拉由状态端点驱动（`app.js:3477`），会自然出现；旧 Web 只缺中文标签时回退显示原始类型名，不影响功能。
- 远端审计写者：不新增写者 RPC；导出复用现有 `GET /v1/events` 分页（`audit-writer-client.ts:157-178`、`writer.ts:210`）。旧写者同样可用。
- 多副本：任务文件是共享文件系统上的唯一真相；若副本不共享 `<root>`，GET 可能落到无该任务的副本返回 404。部署拓扑需确认（待决策 D1）。
- 不新增流操作码、不改现有关卡；远端 wire 兼容风险为零。

---

## 6. 工作令拆分（每令 ≤20 分钟）

> 每令都要求：改动前先跑相关测试；完成后 `pnpm tc`（或 `tc:node`）与目标测试文件通过。测试文件路径按现有布局：单元 `cloud-platform/apps/api/test/`，端到端 `cloud-platform/test/e2e/`。

### E1：抽取审计查询参数解析器（纯重构）

- 文件域：`cloud-platform/apps/api/src/server.ts`（`5233-5310` 抽离）、新增 `cloud-platform/apps/api/src/audit-query-params.ts`、新增 `cloud-platform/apps/api/test/audit-query-params.test.ts`
- 内容：导出 `parseAuditQueryParams(url, now)`，返回规范化 filter 或 `{ error: { status, code, message } }`；`GET /v1/audit/events` 改为调用它。
- 验收：现有查询行为逐字节不变（同样的 400 文案/错误码/默认 7 天窗口/limit 钳制）；新模块不依赖 `ServerResponse`。
- 测试点：合法/非法 since/until、>31 天、`since>until`、`eventTypes` 超 20 个/超 64 字符、`eventFamily` 非法、`q` 1 字符/129 字符、`fileName` 129 字符、无窗口时 q/fileName 默认 7 天、limit 0/-1/NaN/999。
- 估时：15–20 分钟。

### E2：新增导出事件类型与 Web 标签

- 文件域：`cloud-platform/apps/api/src/audit-event-catalog.ts:8-49`、`cloud-platform/apps/web/app.js:3431`
- 内容：追加 `audit_export`、`audit_export_download`；补中文标签「审计导出」「审计导出下载」。
- 验收：`/v1/audit/status` 的 `eventTypes` 含两项；审计页下拉可见。
- 测试点：状态端点包含新类型（e2e 或现有目录断言）；标签键存在；不改变现有类型顺序以外的语义。
- 估时：5–10 分钟。

### E3：任务存储与生命周期原语

- 文件域：新增 `cloud-platform/apps/api/src/audit-export-jobs.ts`（或同等具体命名）、新增 `cloud-platform/apps/api/test/audit-export-jobs.test.ts`
- 内容：任务类型、jobId 生成/校验、`<root>/<jobId>/job.json` 原子读写、状态迁移、过期判定、目录清理、并发计数；不接 HTTP。
- 验收：创建/读取/更新/删除往返正确；`0700`/`0600`；`jobId` 正则拒绝 `../x`、绝对路径、`exp_` + 非 hex；清理只删过期目录；无 `job.json` 的孤儿目录也被清。
- 测试点：路径穿越输入；符号链接拒绝；过期与未过期混合目录；并发计数只算 `queued`/`running`；原子替换失败不留下半截 `job.json`。
- 估时：15–20 分钟。

### E4：CSV / JSONL 序列化

- 文件域：新增 `cloud-platform/apps/api/src/audit-export-format.ts`、新增 `cloud-platform/apps/api/test/audit-export-format.test.ts`
- 内容：固定表头、RFC 4180 转义、公式注入前缀、metadata JSON 列、JSONL 单行输出。
- 验收：含逗号/引号/换行的字段可被标准 CSV 解析器还原；`=cmd`、`+x`、`-x`、`@x` 前置 `'`；JSONL 每行可 `JSON.parse`，事件顺序稳定。
- 测试点：空 metadata；`null` actor/targetType/targetId/traceId；中文/emoji；CRLF 与裸 `\r`；字段以公式字符开头；事件含 `hash`/`prevHash`。
- 估时：15 分钟。

### E5：`POST /v1/audit/export` 路由

- 文件域：`cloud-platform/apps/api/src/server.ts`（审计段新增路由）、`cloud-platform/apps/api/src/index` 无、测试 `cloud-platform/test/e2e/audit-export.e2e.test.ts`
- 内容：鉴权/角色、`confirm`、复用 E1 解析器、clamp `until`、并发上限、创建 job（`queued`）、写 `audit_export` 受理事件、返回 202。
- 验收：admin/auditor 得到 jobId；普通用户 403 且链上出现 denied；参数错误不创建目录；审计写失败不创建任务。
- 测试点：正向 CSV/JSONL；403；`confirm` 缺失/`false` 400；`format` 非法 400；>31 天 400；`eventTypes` 21 个 400；并发超限 429；受理事件含查询条件且不含 token。
- 估时：20 分钟。

### E6：异步导出 worker 与测试钩子

- 文件域：新增 `cloud-platform/apps/api/src/audit-export-runner.ts`、`server.ts`（createApp 接线 + `ApiHandle` 测试钩子）、`cloud-platform/apps/api/test/` 或 e2e
- 内容：`queued → running`，按 200 条/页循环 `audit.query`，流式写产物，更新 `job.json`，终态写 `audit_export`；行数/字节超限或审计查询失败时删除半成品并 `failed`。
- 验收：成功后产物行数 = 查询匹配数；失败终态可轮询到原因；产物绝不留在失败任务目录；导出完成后 `audit.verify()` 仍通过。
- 测试点：0 条结果也生成合法空产物（仅表头/空文件）；分页边界（199/200/201 条）；`EXPORT_TOO_LARGE`（测试把上限调小）；写盘失败（只读目录）；远端写者不可用模拟；任务完成事件 metadata 含 `totalEvents`/`bytes`。
- 估时：20 分钟。

### E7：`GET /v1/audit/exports/{jobId}` 状态与 token 签发

- 文件域：`cloud-platform/apps/api/src/server.ts`、e2e 测试
- 内容：鉴权、所有权、过期 410、未知/他人 job 404、成功态签发并轮换下载 token、`no-store`。
- 验收：`queued/running` 无 `downloadUrl`；`succeeded` 有；每次调用后旧 token 失效；过期任务 410；他人 job 404（不泄露存在性）。
- 测试点：未知 job 404；他人 job 404；expired 410；failed 返回 error 且无链接；轮换后旧 token 下载 404（不泄露存在性）；响应头 `cache-control: no-store`。
- 估时：15–20 分钟。

### E8：`GET /v1/audit/exports/{jobId}/download`

- 文件域：`cloud-platform/apps/api/src/server.ts`、e2e 测试
- 内容：token 校验（哈希 + 常量时间比较 + TTL + 一次性）、job 归属/过期、路径安全、正确 content-type/disposition、`no-store`/`nosniff`、下载审计、可选下载后删除。
- 验收：首次下载成功且字节与产物一致；旧 token 二次使用 404；token TTL 过期 410；错误 jobId/token 组合 404/410；响应头齐全；审计事件写入且不含 token。
- 测试点：token 缺失 401/404（按契约定为 404，不泄露）；token 换 jobId；`..`/绝对路径 jobId；job 过期；`deleteAfterDownload=true` 后产物删除、状态不再签发、带旧 token 下载 410；CSV/JSONL 两种头部；审计链含 `audit_export_download`。
- 估时：20 分钟。

### E9：启动恢复、定时清理与配置

- 文件域：`server.ts`（`ApiConfig` `server.ts:121-155`、createApp、`ApiHandle` `server.ts:170-178`、`close`）、`audit-export-jobs.ts`
- 内容：`auditExportDir`、`auditExportTtlMs`、`auditExportTokenTtlMs`、行数/字节/并发上限的测试可注入配置；启动时恢复/清理；定时清理；环境变量读取（进程入口 `server.ts:6094+` 模式）。
- 验收：重启后 `queued/running` 变 `failed/EXPORT_INTERRUPTED`；过期目录被清；`close()` 停止定时器；测试用短 TTL 可稳定触发 410。
- 测试点：重启恢复；启动清理；`close()` 后无定时器泄漏；env 非法值回落默认；测试注入短 TTL 后过期行为。
- 估时：15–20 分钟。

### E10：状态端点能力字段

- 文件域：`cloud-platform/apps/api/src/server.ts:5327-5361`、e2e 测试
- 内容：在 `/v1/audit/status` 响应追加 `auditExport`（§5 结构）。
- 验收：admin/auditor 可见；字段为 additive；旧字段不变；普通用户仍 403（状态端点现有门禁）。
- 测试点：字段结构/值；旧客户端未知字段不受影响（断言旧键仍在）；403。
- 估时：10 分钟。

### E11：Web 导出入口 + 确认 + 发起/轮询

- 文件域：`cloud-platform/apps/web/app.js`（`renderAudit` 工具栏 `app.js:3956`、`dialog` `app.js:4374`）
- 内容：仅在能力字段存在时渲染「导出」按钮；点击打开确认对话框（格式 radio + 当前筛选摘要 + 敏感数据提示）；确认后 POST；显示排队/生成中并轮询状态；失败/过期/403 显示可读原因；路由切换或重新查询时清理轮询定时器。
- 验收：旧服务端不显示按钮；新服务端显示；无 `confirm` 不发请求；轮询有上限（如 60 秒）并可被下一次操作取消；普通用户看不到入口且直接调用仍 403。
- 测试点：能力字段缺失（状态为 null/旧结构）→ 无按钮；POST body 的筛选与当前 URL/筛选一致；400/403/404/410/429 文案；移动端对话框可用（`sheet`）；重复点击不产生两个定时器。
- 估时：20 分钟。

### E12：Web 下载与产物交互

- 文件域：`cloud-platform/apps/web/app.js`
- 内容：成功态展示「下载」按钮，用同源 `<a download>` 触发，不新开可聚焦窗口；下载后若 `deleteAfterDownload` 提示已删除；410 提示重新导出。
- 验收：下载走 `downloadUrl` 且不携带 Bearer（token 自包含）；不自动弹窗/抢焦点；错误可见。
- 测试点：成功下载触发；token 过期 410 文案；二次下载 410 文案；`deleteAfterDownload` 提示；无 `window.open` 遗留。
- 估时：15 分钟。

### E13：设计回填与台账

- 文件域：`design.md:1034-1035`、`design.md:1191`、`defect-ledger.md:212`
- 内容：把 §2.3 下载子路径、§5 能力字段、最终上限/事件类型回填设计文档；U201 状态按实现结果更新。
- 验收：设计文档与实现契约一致；台账不再写「未实现」。
- 测试点：文档引用行号可核验；无未决「待确认」被静默忽略。
- 估时：10–15 分钟。

---

## 7. 负向测试总表（跨令验收）

| 场景 | 期望 | 覆盖令 |
|---|---|---|
| 普通开发者 POST export | 403 `PERMISSION_DENIED` + `audit_export` denied 事件 | E5 |
| 普通开发者 GET status/download | 403/404，不泄露 job 存在性 | E7/E8 |
| `format` 非 csv/jsonl | 400 `INVALID_QUERY` | E5 |
| 时间窗 >31 天 / `since>until` | 400 `TIME_WINDOW_TOO_LARGE` | E1/E5 |
| `confirm` 缺失/false | 400 `EXPORT_CONFIRM_REQUIRED` | E5 |
| 未知 jobId | 404 `EXPORT_NOT_FOUND` | E7 |
| 他人 jobId | 404（不区分存在性） | E7/E8 |
| job 过期 | 410 `EXPORT_EXPIRED` | E7/E8/E9 |
| token TTL 过期 / 产物已删除 | 410 `EXPORT_DOWNLOAD_GONE` | E8 |
| token 二次使用 / 被轮换 | 404 `EXPORT_NOT_FOUND` | E8 |
| 超过每用户/全局活动任务 | 429 `EXPORT_BUSY` | E5 |
| 行数/字节超限 | 任务 `failed` `EXPORT_TOO_LARGE`，无半成品 | E6 |
| 写盘失败 | 任务 `failed` `EXPORT_WRITE_FAILED` | E6 |
| 进程重启时任务未完成 | 任务 `failed` `EXPORT_INTERRUPTED` | E9 |
| 导出受理/完成/下载 | 链上存在对应事件，metadata 含条件与条数，不含 token | E5/E6/E8 |
| 路径穿越 jobId | 404，绝不读出 `<root>` 外文件 | E3/E8 |
| 下载/状态响应缓存 | `cache-control: no-store`；下载另有 `nosniff` | E7/E8 |
| CSV 公式注入 | 危险前缀被中性化 | E4 |
| 旧服务端 + 新 Web | 无导出按钮，不产生请求 | E11 |
| 新服务端 + 旧 Web | 旧功能不变，未知状态字段被忽略 | E10 |

---

## 8. 待决策（集中）

| 编号 | 决策问题 | 建议 | 不决策的影响 |
|---|---|---|---|
| D1 | 任务存储放内存还是文件？多副本如何共享？ | 文件型 `<root>/<jobId>/job.json`；要求 API 副本共享 `<root>`（或单副本部署） | 多副本下 GET 可能 404；内存方案重启即丢 |
| D2 | `<root>` 默认路径与生产挂载 | 默认 `~/.orca-cloud/audit-exports`，env `ORCA_AUDIT_EXPORT_DIR`；生产显式挂载可写卷 | 容器内 `$HOME` 不可写或重启丢产物 |
| D3 | 行数/字节上限是否在同步阶段 400？ | 同步只拦 >31 天；行数/字节在异步任务失败（远端写者每页 200，预扫描代价翻倍） | 用户拿到 202 后才发现失败；若要求同步 400，需新增写者 `count` RPC |
| D4 | 上限具体值 | 100,000 行 / 64 MiB / 每用户 2 / 全局 8 / 任务 1h / token 5m | 实现者自行取值，容量与体验不可预期 |
| D5 | 任务可见性 | 仅 `requestedBy` 可见；未知与他人 job 均 404 | 管理员无法排障；或泄露任务存在性 |
| D6 | 下载 token 轮换策略 | 每次状态查询签发新 token、旧 token 失效；一次性、5 分钟 | 多标签/重试可能互相踢掉；或留下长期有效链接 |
| D7 | 创建与下载的审计失败处理 | 创建 fail-closed（不可有未记录导出）；下载 best-effort | 审计故障时导出被无限阻断，或下载无法追溯 |
| D8 | `deleteAfterDownload` 默认值 | 默认 `false`（保留到 1h 过期） | 默认删除会阻碍失败重试/多次下载；默认保留增加短期落盘面 |
| D9 | CSV 公式注入处理与 BOM | 危险前缀加 `'`；CSV 加 UTF-8 BOM 以便 Excel 正确显示中文 | 不处理有注入风险；处理会改变原值 |
| D10 | 能力字段名与结构 | `auditExport` 顶层对象（§5） | Web 探测口径分裂 |
| D11 | 下载子路径是否回填设计文档 | 新增 `GET /v1/audit/exports/{jobId}/download` 并回填 `design.md:1034-1035` | 实现与设计文档不一致 |
| D12 | 事件类型粒度 | `audit_export`（受理+终态，phase 区分）+ `audit_export_download` | 只记一条会丢失终态/下载维度；记太多会放大链容量 |
| D13 | FR-8.5「二次确认」 vs 角色表「需审批」 | 本期只做 `confirm: true` + UI 对话框，不做审批流 | 「审批」若为硬要求，本期不满足合规；需产品/安全裁定 |
| D14 | 导出是否包含 `until` 之后的新事件 | 创建时 clamp `until=now`，任务集合固定 | 结果随扫描时刻漂移，条数与审计记录不一致 |
| D15 | 导出请求限流 | 每用户 6 次/小时 + 全局活动上限；沿用 429 | 恶意/误操作可打满磁盘与 CPU |
| D16 | 产物是否需要加密/对象存储/WORM | 本期落本地文件、0600；归档留待二期 | 与 §13 的 WORM 归档目标存在差距，需在文档如实声明 |

---

## 9. 不在本令范围

- 审批流/工单系统（D13 若裁定需要，另立设计）。
- 对象存储、WORM、跨地域归档（`design.md:385`、`design.md:1200`）。
- 导出调度、邮件投递、定时报表。
- 多副本共享任务存储的分布式实现（D1 的部署前提）。
- 宿主侧导出拦截与 `terminal.exportArtifact` 等 RPC（属 FR-7/FR-9，不是本缺陷）。

---

## 10. 引用索引

- `remote-connectivity/design/2026-11-13-cloud-dev-platform/design.md:984`（权限表）
- `design.md:1034-1035`（导出端点）、`design.md:1191`（`audit_exports` 表）、`design.md:1333`（审计查询限流）
- `remote-connectivity/design/2026-11-13-cloud-dev-platform/requirements.md:47`（审计员职责）、`:246-249`（FR-8.2/8.3/8.5）
- `remote-connectivity/design/2026-11-13-cloud-dev-platform/defect-ledger.md:212`（U201）
- `cloud-platform/apps/api/src/server.ts:5233-5325`（查询路由）、`:5327-5361`（状态）、`:5366+`（校验）
- `cloud-platform/apps/api/src/audit.ts:16-40`、`:234-270`（查询类型与谓词）
- `cloud-platform/apps/api/src/audit-event-catalog.ts:8-49`（事件目录）
- `cloud-platform/apps/api/src/store.ts:143-153`、`:156-186`（一次性 token 先例与 Store 字段）
- `cloud-platform/apps/api/src/store-persistence.ts:48-60`、`:230-236`（快照与原子写）
- `cloud-platform/apps/api/src/audit-log-file.ts:1-16`、`:65-75`（append-only 与 0600）
- `cloud-platform/apps/api/src/audit-writer-client.ts:29-44`、`:157-178`；`cloud-platform/apps/audit-writer/src/writer.ts:210`（远端分页）
- `cloud-platform/apps/api/src/server.ts:233-235`、`:290-294`（hashToken/safeEqual）、`:1901-1938`（一次性下载 token 先例）、`:3022`、`:3440`（no-store 先例）
- `cloud-platform/apps/web/app.js:44-63`（api）、`:3431`（标签）、`:3798-3990`（审计页）、`:3956`（工具栏）、`:4374`（dialog）
- `cloud-platform/test/e2e/audit-trace-window.e2e.test.ts:1-35`（e2e 夹具与注入时钟先例）

---

## 9. 实施记录（2026-11-17）

| 令 | 状态 | 提交 |
| --- | --- | --- |
| E1 查询解析抽取 | 完成 | `90813b943fe`（24 单测 + 审计 e2e 17/17） |
| E2 导出事件类型/标签 | 完成 | `4516b807c73`（目录 2 例 + 状态 e2e 3 例） |
| E3 任务存储/生命周期 | 完成 | `30ddca4d064`（12 例；命名按设计 `succeeded`/`createdAt`） |
| E4 CSV/JSONL 序列化 | 完成 | `1be0ffab984`（12 例；BOM 留 E8 按 D9） |
| E5 受理路由 | 完成 | `e211ed0dfa2`（9 e2e；D3/D4/D7 按建议默认） |
| E6 worker | 完成 | `9a119fbf50d`（7 例） |
| E6b worker 触发接线（U204） | 进行中 | — |
| E7a 下载 token 原语 | 完成 | `9e5300e5914`（18 例） |
| E7 状态端点 | 完成 | `720cb9a96d3`（10 e2e；每次读取轮换 token） |
| E8 下载端点 | 待派 | — |
| E9 清理/恢复/env/隔离 | 完成 | `a43bbde1fe0` + `492bf54b076`（35+2 例） |
| E10 能力字段 | 完成 | `a3b9395a5ac`（3 e2e） |
| E11 Web 入口/轮询 | 进行中 | — |
| E12 Web 下载 | 待派 | — |
| E13 设计回填/台账 | 待派 | — |

已采纳的默认（待正式裁定可回退）：D3 超限异步失败；D4 100k 行 / 64 MiB / 1h / 每用户 2 / 全局 8；D7 创建审计 fail-closed；D1 单写者文件存储（多副本见 U201 风险）。环境变量按本文件 §3.2 使用 `ORCA_AUDIT_EXPORT_DIR`，兼容旧别名 `ORCA_AUDIT_EXPORT_ROOT`。

**独立审计（2026-11-17 20:41，`cloud-platform/test-reports/u201-export-audit.md`，本地不提交）**：CHANGES-REQUIRED。P1=F1 过滤字段丢弃、F2 终态不落链、F3 远端写者下必失败、F4 token 一次性语义；P2=F6–F18；测试/文档缺口=F20/F21。修复顺序：F1/F7 → F2/F11/F12 → F3 → F4 → 全链路 e2e；台账 U205/U206/U207。

### 9.1 复审 P2 修复（2026-11-17 21:xx）

| 项 | 处理 | 提交 |
| --- | --- | --- |
| 跨 pass 并发 | 进程级单槽 drain（在飞时排队补跑），异常只记录 | `b73ba4a2399` |
| 集合未冻结 | 受理时 `until=min(until??now,now)`、默认 `since=until-(q\|fileName?7d:31d)` | `b73ba4a2399` |
| F10 内存 | 分页流式：每页升序写分块，逆序 pipeline 拼接，峰值 O(页) | `bd43eabd1f3` |
| F17 周期清扫 | `listQueuedIds` + 15s unref sweep（`ORCA_AUDIT_EXPORT_SWEEP_MS`） | `61063525447` |
| F14 校验/写路径 | job.json 字段/`objectKey`/hash 严格校验；写前 lstat 拒绝符号链接 | `94d1ec46367` |
| F18 BOM | CSV 加 UTF-8 BOM（流式产物亦写入并计 bytes），JSONL 不加 | `94d1ec46367` |
| F15 配置注入 | `ApiConfig` 导出目录/TTL/配额/token TTL/sweep/`now` 全量注入 | `af799e7d0a1` |
| F13 | 注释改为事实：带 token 可区分状态，依赖 96-bit jobId 与所有者签发 | `af799e7d0a1` |
| F9 下载审计顺序 | **保留 fail-closed**：先消费 token、再审计、后发送；审计失败返回 500 且 token 已用（用户需重建任务）。理由：未落链的下载不得发生；替代（审计先于消费）会产生「已审计未交付」 | `71934e99f24` + 本记录 |
| F16 错误脱敏 | 失败 message 固定短句，异常详情仅服务端日志 | 本批 |

多副本/共享目录（D1）仍未决；单写者文件存储假设仅在本文档声明（§5/D1），`GET /v1/audit/status` 的 `auditExport` 能力字段仅设计 §5 的六项（`formats`、`maxWindowDays`、`maxRows`、`maxBytes`、`jobTtlSeconds`、`downloadTokenTtlSeconds`），不含部署拓扑。
