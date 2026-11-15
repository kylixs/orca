# U66 技术方案 · 文件下载 / 内容复制审计与审计查询增强

> 状态：技术方案稿，只设计不改码，待独立评审 + 主会话审定后拆实现令
> 日期：2026-11-15 · 缺陷账：`defect-ledger.md:75`（U66🔴）
> 需求源（用户 2026-11-15，唯一需求源）：①所有文件下载、文件内容复制必须记录审计；②审计员可按内容/关键字查询复制相关记录；③常用查询条件=时间/操作类型/用户/下载文件名；④文档族齐全→独立评审→修改→评审通过→才开发与测试验收。
> 需求基线：`work-orders/u66-audit-requirements.md`（FR-9.13~FR-9.16、AC-41~AC-55、OQ-1~OQ-19）· `ui/prototype.html`（U66 修订、审计页 2723–2830 行）· `requirements.md` FR-7.3/FR-7.4/FR-8.2/FR-8.6/FR-9.7/FR-9.12。
> 代码基线（当前分支实测，行号为写稿时基线）：`cloud-platform/apps/api/src/{store,audit,host-audit-ingest,audit-writer-client,server}.ts` · `cloud-platform/apps/audit-writer/src/writer.ts` · `cloud-platform/apps/web/app.js` · `src/main/cloud-platform/{cloud-host-audit,cloud-heartbeat-body,cloud-agent-client,cloud-policies,cloud-access-guard,cloud-rpc-permission,cloud-denial-details,cloud-path-guard}.ts` · `src/main/runtime/runtime-rpc/runtime-rpc-websocket-dispatch.ts` · `src/main/runtime/device-registry.ts` · `src/main/startup/cloud-runtime-admission.ts` · `src/renderer/src/runtime/runtime-file-read-client.ts` · `src/renderer/src/web/preload-api/web-filesystem-api.ts` · `src/renderer/src/components/right-sidebar/file-explorer-row-action-visibility.ts` · `mobile/src/files/*`。
> 范围：平台 API + audit-writer + 管理台 Web + 宿主上报/审计接缝 + 桌面/Web/Mobile 客户端埋点 + 测试设计。
> 非目标：不做内容级 DLP（C1）；不改变复制的允许性（O3）；不改变下载策略的语义（FR-7/FR-9.12 已定）；不把客户端自报事件宣称为完整审计；不重写既有 `host.*` 拒绝事件。

---

## 0. 结论摘要

**一句话 schema**：`file_download` / `file_copy` / `download_blocked` 三种事件，统一骨架 `{eventType, actor=人类用户名, targetType:'project', targetId:projectId, result:'success'|'failure'|'denied', traceId, metadata:{hostId,hostName,projectKey,fileName,path,sizeBytes|copyKind/copiedChars/copiedBytes,sha256?,method,kind,surface,capturePoint,captureConfidence,policy?,reason?,occurredAt,itemCount?,excerpt?,excerptTruncated?}}`；正文默认不入链，摘录为默认关闭的全局开关（≤1KB）。

| 编号 | 技术裁定 | 依据/理由 |
| --- | --- | --- |
| D1 | 事件名用**裸名** `file_download` / `file_copy` / `download_blocked`，不加 `host.` 前缀 | 需求 FR-9.13/FR-9.14 与原型事件下拉都按裸名；`host.*` 前缀保留给“主机拒绝”族（`host.path_denied` 等），语义是“主机的拒绝”而非“用户的行为” |
| D2 | 事件由**执行侧（宿主/客户端）产生**，经心跳 `audit[]` 入平台哈希链；平台永远看不到文件字节（C1/E2EE） | 这是唯一物理通道：平台不承载业务流量（design §3），只有宿主知道自己交付了什么 |
| D3 | 可信度分三级：`host-attested`（宿主在 RPC 处理器内产生）> `client-declared`（客户端自报，`advisory`）> `inferred`（宿主按累计读字节推断） | 需求 AC-47 明确“审计链保证记录不被篡改，不保证记录完整”；三级必须可区分 |
| D4 | 内容摘录**默认关闭**，全局开关（管理员），上限 1KB；一期只检索文件名/路径/用户，二期才检索摘录 | FR-9.16、AC-53；全文入链 = 第二份代码库 + 180 天不可删 + 体积爆炸 |
| D5 | 查询**扩展现有 `GET /v1/audit/events`**，不建第二套存储；新增 `until`/`eventTypes`/`fileName`/`q`/`projectId`/`hostId`，旧参数语义不变 | AC-49/AC-52；旧管理台零改动可用 |
| D6 | 性能走**内存线性扫描 + 仅文件事件缓存检索串**，一期不建索引；给出触发条件与容量包线 | M105 20 万条 P95 6.6–7.3ms；文件事件占比远小于全量；索引收益不足以抵消复杂度 |
| D7 | 查询权限**不变**：`platform:admin` / `platform:auditor`；**不新增**“本人可查自己”的通道 | FR-9.7 与需求文档 §8 明确“审计查询权限不变”；原型 2733 行“普通用户仅可见本人相关记录”与之冲突，按需求文档裁定并登记原型待改（见 §9 O-1） |
| D8 | 一期=事件模型+落链+客户端/宿主捕获+基础筛选+前端拦截；二期=宿主专用下载 RPC 硬拦+读聚合推断+选区捕获+摘录开关/检索 | 与 FR-9.12 两期交付、需求 §6 分期表对齐 |

**现状最关键的三条事实（决定了方案形状）**：

1. **`files.download` / `files.downloadFolder` / `terminal.exportArtifact` / `browser.savePage` 都不是已注册的 RPC 方法**（`src/main/runtime/rpc/methods/*` 实查；权限表 `cloud-rpc-permission.ts:64-70` 列了它们）。因此今天的“E5 导出拦截”拦的是一扇**不存在的门**：真正把文件取走的是桌面 `downloadRuntimeFile` 调用的 `files.readChunk`（`src/renderer/src/runtime/runtime-file-read-client.ts:162-198`），它按 `file:read` 计费，不受 `download` 权限与下载策略约束。
2. **Web 工作区没有下载入口**：paired web 的 `fs.downloadFile/downloadFolder` 直接抛“unavailable”（`web-filesystem-api.ts:62-79`），且 `__ORCA_WEB_CLIENT__` 为 true 时文件树隐藏下载/复制文件对象动作（`file-explorer-row-action-visibility.ts:20-54`）。所以“Web 前端拦截”一期没有可拦截的下载动作，只能拦截**将来**的入口；不得虚构覆盖率。
3. **平台无法按用户查宿主事件**：宿主上报入库时 `actor` 被写成 `host:<hostName>`，人类用户塞在 `metadata.subject`（`host-audit-ingest.ts:87-100`）。U66 必须改新事件的 actor 归属，否则“按用户查下载”不成立。

**置信度：高（约 90%）**。事件模型、捕获点、查询实现都有代码级落点；不确定项集中在 ①容量（180 天 × 复制量）是否超出现有内存链包线，②“前端拦截”在 Web 无入口时的验收口径，③是否保留原型承诺的本人自查（本文裁定不保留，需主会话确认）。

---

## 1. 现状核实（只读，当前基线）

### 1.1 审计事件形态与写入链

- 事件输入 `{eventType, actor, targetType, targetId, result, traceId, metadata}`，落链补 `seq/ts/prevHash/hash`（`store.ts:100-115`）。
- `AuditChain.append`：平台注入时钟生成 `ts`，`hash=H(prevHash|canonicalJson(body))`，body 含 metadata，因此 **metadata 参与哈希**（`audit.ts:73-107`；`audit-integrity.test.ts:81` 已钉）。
- 单写者：API 通过 `ORCA_CLOUD_AUDIT_WRITER_URL(S)` 把 append 投给 `audit-writer` 单实例（`audit.ts:8-15`、`audit-writer-client.ts:53-156`），写入者按序分配 `seq`/`prevHash`，文件按行追加、启动回放校验（`writer.ts:1-20,142-200`）。链断时 503 `AUDIT_CHAIN_BROKEN`，敏感操作 fail-closed。
- 现有事件名（server.ts 实读）：`login/logout/project_connect/project_access/grant_update/host_grant_update/policy_update/web_handoff/audit_query/audit_verify/provision_assign/...`；宿主上报统一 `host.*`（`host-audit-ingest.ts:87-101`）。
- metadata 惯例：小写驼峰、按需出现、不写令牌/密码/正文（`server.ts:1418` 注释）。

### 1.2 查询端点现状

- `GET /v1/audit/events`（`server.ts:2861-2891`）：admin 或 `platform:auditor`；参数 `actor/eventType/result/traceId/since(ISO)/cursor/limit`；`limit` 钳制 1..200、默认 50（U57 U8 兼容）；`since` 存在且窗口 >31 天 → 400 `TIME_WINDOW_TOO_LARGE`。
- `AuditChain.query`（`audit.ts:147-169`）：内存全量 `filter`，条件为等值/时间下界，然后 `slice(-limit).reverse()`；`cursor` 是 seq 上界（`e.seq >= cursor` 排除）。**无 `until`、无多值事件类型、无文件名/关键字、无 project/host 过滤**。
- 远端写入者同参数转发（`audit-writer-client.ts:13-23,164-179`），writer 自身也只支持这组等值过滤（`writer.ts:189-199`）。
- 管理台审计页（`apps/web/app.js:1879-1984`）：事件类型下拉、结果下拉、用户输入、cursor 翻页；结果表无文件名/大小/摘录。

### 1.3 宿主上报通道现状

- 心跳体可选 `audit[]`（`cloud-heartbeat-body.ts:26-43`），每条 `{eventType, result, deviceId?, subject?, projectId?, method?, denial?, reason?}`（`host-audit-ingest.ts:15-24`）；平台每拍最多取 100 条、文本截 512 字符（`host-audit-ingest.ts:12-13,64-76`）。
- 宿主队列 `createCloudHostAuditQueue`：内存、上限 200、超限**保留最新**；`take()` 返回全部 pending；平台接受后 `clearThrough(seq)`（`cloud-host-audit.ts:30-68`）。心跳默认 10s（`cloud-agent-client.ts:86`）。
- **两个会静默丢事件的缺陷**（U66 必须顺手修）：
  1. 平台每拍只解析前 100 条，宿主 `take()` 却把 200 条全发、并按最后一条 seq 全清 → 第 101~200 条永久丢失；
  2. 队列超 200 时丢最旧且无计数，审计员看不到缺口。
- 入库 `appendHostAuditReports`：`eventType` 一律加 `host.` 前缀，`actor=host:<name>`，`subject` 进 metadata（`host-audit-ingest.ts:79-105`）。

### 1.4 下载策略 / E5 拦截链现状（分层）

| 层 | 位置 | 今天做什么 | U66 可挂审计吗 |
| --- | --- | --- | --- |
| L0 客户端 UI | M92 无导出测试、`shouldShowRemoteDownloadAction` | Web 恒隐藏；桌面全量客户端在云会话下**仍显示**下载入口（`runtimeDownloadContext` 存在）；M92 的“无导出”只覆盖管理台内嵌简易工作区，不覆盖全量桌面 | 可挂 `download_blocked`（仅前端拦截，advisory） |
| L1 传输层权限/策略 | `denyRpcMethodForCaller` → `cloudMethodDenial`（`rpc-caller-scope.ts:37-58`） | `download` 权限 + `downloadAllowed` 策略拒绝 `DOWNLOAD_METHODS`；拒绝由 `onCloudDenial` 记 `method_denied`（`runtime-rpc-websocket-dispatch.ts:230-241`） | **是**：把 `DOWNLOAD_DISABLED` 特判成 `file_download result=denied`（不再算 `method_denied`，避免一动作两条） |
| L2 导出方法处理器 | `cloud-rpc-permission.ts:64-70` 列出的 5 个方法 | **4 个未注册**（`files.download`/`files.downloadFolder`/`terminal.exportArtifact`/`browser.savePage`）；只有 `browser.download` 存在（`browser-core.ts:278`） | 已注册的可在处理器内挂 host-attested 成功/失败审计；未注册的二期补实现 |
| L3 真实取数路径 | `files.readChunk`（`files.ts:132`）+ 桌面 `downloadRuntimeFile`（`runtime-file-read-client.ts:136-198`）、移动 `savePreparedFileToPhone` | 无下载语义，只有按项目滚动小时的读预算（`cloud-access-guard.ts:34-83`）；`files.readChunk` 走后**不受下载策略约束** | 只能客户端自报；二期用专用 `files.download` + 读字节累计推断补齐 |
| L4 平台 | 心跳/策略下行 | 平台看不到文件字节，也看不到 L3 的意图 | 只接收 L1/L2 与客户端经宿主上报的事件 |

**结论**：一期必须把“审计”挂在 L1（拒绝）+ L2（已注册方法的成功/失败）+ 客户端声明（真实下载发生点）；二期补 L2 的专用方法并加 L3 的推断，任何一期都不得宣称“所有下载都被拦截/记录”。

### 1.5 文件下载与复制发生点（代码实查，修正需求文档 1.3 的三处表述）

| 动作 | 实际接缝 | 平台今天是否可见 |
| --- | --- | --- |
| 桌面云工作区单文件下载 | 文件树“下载”→ `downloadRemoteFile` → `downloadRuntimeFile` → `files.readChunk` 分块（384KB/块）→ `fs:startDownloadedFile/append/finish` 本地保存（`runtime-file-read-client.ts:162-198`、`filesystem-download-handlers.ts:115-231`） | 否（宿主只看到 readChunk） |
| 桌面 SSH 单文件下载 | `fs:downloadFile`（`filesystem-download-handlers.ts:30-71`）走 SFTP provider | 否（非云会话；不在平台项目范围） |
| 桌面云工作区文件夹下载 | **不存在**：目录动作要求 `connectionId+supportsFolderDownload`，runtime 上下文只支持文件（`file-explorer-row-action-visibility.ts:20-36`） | 无动作 |
| 移动端保存到手机 | 文件动作 `save` → 预取缓存 → SAF/分享面板（`mobile-file-save.ts`；已算 sha256） | 否 |
| 浏览器面板下载 | `browser.download`（click selector）在**宿主**执行；页面自发下载走 `will-download` | 否（未落审计） |
| 终端产物导出 | `terminal.exportArtifact` **未注册**；实际读产物走 `files.readTerminalArtifact` | 否 |
| Web 工作区下载 | `fs.downloadFile` 抛“unavailable”；UI 隐藏 | 无可审计动作 |
| 管理台项目详情 | 无文件下载（只有策略配置） | 无可审计动作 |
| Web/桌面应用内复制内容 | Web：`writeWebClipboardText`（`web-clipboard-api.ts:98-116`）；桌面：`clipboard:writeText` IPC（`clipboard-ipc-handlers.ts:209-220`） | 否（接缝无来源上下文） |
| 编辑器/预览选区复制（Ctrl+C） | Monaco/DOM 原生剪贴板，不经过上述 IPC | 否（一期不可测，二期 DOM 监听 advisory） |
| 复制文件对象 | 桌面 `clipboard:writeFile`（`clipboard-ipc-handlers.ts:180`）；但云 runtime 行 `shouldShowCopyFileAction=false` | 云项目无动作 |
| 移动端复制内容 | `copyContent` → 读文本 → `clipboard.writeText`（`use-mobile-file-actions.ts:137-159`） | 否 |
| OS/Finder/第三方应用/截图/带外 shell | 平台不可见（C1） | 不可捕获 |

### 1.6 性能基线（M105）

- `test/e2e/audit-query-latency.e2e.test.ts`：真实 writer 进程 + 真实 API 进程 + 真实 HTTP；20 万条、30 天窗口、30 采样；P95 6.6–7.3ms、P50 4.2–4.3ms；5 万条 P95 4.0–6.2ms；注入 2.2s 延迟后同一断言转红。预算 2000ms。
- 实现是内存线性扫描；test-plan 已登记“语料再大一个数量级需换索引/分页存储”。

---

## 2. 事件模型

### 2.1 统一骨架

```jsonc
{
  "eventType": "file_download | file_copy | download_blocked",
  "actor": "zhangsan",                 // 人类用户名；不是 host:*
  "targetType": "project",
  "targetId": "proj_xxx",              // 项目是最小审计单位
  "result": "success | failure | denied",
  "traceId": "…",                      // 客户端 RPC/交互关联 id；缺省用平台心跳 traceId
  "metadata": { /* 见 2.5，字段按事件类型出现 */ }
}
```

平台落链后补 `seq/ts/prevHash/hash`（不变）。`metadata` 参与哈希，因此写入后不可改。

**actor 归属规则（OQ-19 裁定）**：平台入库时优先用已认证的 `deviceId` 反查 `store.devices → userId → users.username`（平台已有这两张表，`store.ts:135,170-178`）；反查不到再取上报的 `subject` 去掉 `user:` 前缀；再不行回退 `host:<hostName>`。`metadata.actorSource = 'device' | 'subject' | 'host'` 记录来源；`metadata.subject` 始终保留作交叉校验。旧 `host.*` 事件不回填，查询用 §4.1 的 `username` 参数兼容。

### 2.2 `file_download`

| 字段 | 值 | 必填 | 说明 |
| --- | --- | --- | --- |
| `hostId` / `hostName` | 主机标识 | 是 | 执行宿主 |
| `projectKey` | 项目 key | 否 | 人可读 |
| `fileName` | basename | 是 | 用户要求的查询条件 |
| `path` | 项目内相对路径（正斜杠、无 `..`、无绝对路径） | 是 | 不写开发机绝对路径（OQ-8） |
| `sizeBytes` | 实际交付字节数 | 成功时是 | 文件夹为总字节 |
| `method` | `files.readChunk` / `browser.download` / `files.download` / `mobile.saveToPhone` | 是 | 区分真实取数路径 |
| `kind` | `file` / `folder` / `artifact` / `browser` | 是 | 查询/展示 |
| `surface` | `desktop` / `web` / `mobile` / `admin-embed` | 是 | 客户端形态 |
| `capturePoint` | `download-runtime-client` / `mobile-save` / `host-browser-download` / `host-files-download` / `frontend-block` | 是 | 可审计性 |
| `captureConfidence` | `host-attested` / `client-declared` / `inferred` | 是 | D3 |
| `policy` | `allow` / `deny` | 否 | 动作当时策略 |
| `reason` | `DOWNLOAD_DISABLED` / `PERMISSION_MISSING` / `client_cancelled` / `read_failed` / … | 否 | 失败/拒绝原因 |
| `occurredAt` | 动作发生时间（epoch ms） | 是 | 与链上 `ts` 区分（§2.7） |
| `sha256` | 内容指纹（64 hex） | 否 | 成本见 §2.6/§3.2；`sha256Source:'client'|'host'` |
| `itemCount` / `truncated` | 文件夹/多文件条目数与清单截断 | 否 | 一期不做文件夹清单 |
| `clientVersion` | 客户端版本 | 否 | 排查旧客户端未埋点 |

结果语义（AC-41 的口径）：
- `success` = **宿主已完成交付或客户端确认已写入本地**，由 `captureConfidence` 区分；`client-declared` 的 success 不得展示成“主机确认”。
- `failure` = 用户取消保存、网络/读取失败；客户端取消也记一条（`reason=client_cancelled`），不计入“成功下载”指标。
- `denied` = 宿主按权限/策略拒绝（L1），`reason=DOWNLOAD_DISABLED|PERMISSION_MISSING`。

### 2.3 `file_copy`

| 字段 | 值 | 必填 | 说明 |
| --- | --- | --- | --- |
| `hostId` / `hostName` / `projectKey` | 同上 | 是/否 | |
| `fileName` / `path` | 同上 | 是 | 文件名是查询条件 |
| `copyKind` | `content-whole` / `content-selection` / `file-object` | 是 | 区分复制面 |
| `copiedChars` / `copiedBytes` | 实际复制长度（UTF-8 字节固定一种口径） | 是 | 选区复制时必填 |
| `sizeBytes` | 文件大小（整文件/文件对象） | 否 | |
| `sha256` | 复制文本或整文件的指纹 | 否 | 默认建议算；成本见 OQ-9 |
| `surface` / `capturePoint` / `captureConfidence` | `web-clipboard-api` / `desktop-clipboard-ipc` / `dom-copy-listener` / `mobile-copy-content` | 是 | |
| `excerpt` / `excerptBytes` / `excerptTruncated` | 有界摘录 | 否 | 仅开关开启（§2.6） |
| `occurredAt` | 动作时间 | 是 | |
| `reason` | `clipboard_denied` / `clipboard_write_failed` / … | 否 | 失败也留痕（AC-48） |

不写：正文、格式、剪贴板序列化结果；`copy-path`（复制路径字符串）**不记** `file_copy`（FR-9.14 明确）；终端选区复制不纳入（OQ-11，保持 FR-8.6）。

### 2.4 `download_blocked`

前端拦截专用（客户端声明，advisory）：`eventType=download_blocked`、`result=denied`、`metadata:{hostId,projectKey,fileName,path,method,kind,surface,capturePoint:'frontend-block',policy:'deny',reason:'DOWNLOAD_DISABLED',occurredAt,clientVersion}`。

与 `file_download result=denied` 的分工（裁定 OQ-10）：
- **动作到达宿主、被宿主拒绝** → `file_download` + `result=denied`；
- **动作在前端就被拦下、没有 RPC** → `download_blocked`；
- 一个动作只落一条，不得同时产生两条。

### 2.5 metadata 字段字典与上限

| 字段 | 类型 | 单字段上限 | 校验 |
| --- | --- | --- | --- |
| `hostId`/`hostName`/`projectKey`/`method`/`kind`/`surface`/`capturePoint`/`captureConfidence`/`copyKind`/`policy`/`reason` | string | 128 字符 | 白名单枚举或短文本 |
| `fileName` | string | 255 字符 | 不含路径分隔符 |
| `path` | string | 1024 字符 | 相对路径；拒绝绝对路径/`..`/反斜杠归一 |
| `sizeBytes`/`copiedChars`/`copiedBytes`/`itemCount` | integer | 0..2^53-1 | 非负整数 |
| `sha256` | string | 64 hex | `/^[0-9a-f]{64}$/`，不合法则丢弃 |
| `excerpt` | string | **1024 UTF-8 字节**（全局可配，≤1KB） | 文本、去控制字符（保留换行）、按字符边界截断 |
| `excerptBytes`/`excerptTruncated` | integer/boolean | — | 与 excerpt 一致 |
| `occurredAt` | integer | 平台 `now()±1h` 之外丢弃 | 防伪造时间 |
| `clientVersion` | string | 64 字符 | |
| 整条 metadata 序列化 | — | **≤4KB** | 超限按 `excerpt → sha256 → 可选字段` 顺序丢弃；仍超限则整条上报丢弃并计入 `auditGap` |

平台入库（`host-audit-ingest.ts`）做上述校验与截断；宿主侧也做同样校验，避免把坏数据发上网。

### 2.6 内容摘录的可检索性裁定

**裁定：全文不入审计链；只允许默认关闭的有界摘录（≤1KB）作为可选的内容表示。**

隐私/体积论证：
1. **第二份代码库**：全量正文写入 `audit_events.metadata` 等于把仓库内容复制进一个 180 天保留、只追加、无仓库 ACL 的存储；仓库删除/权限回收后这份副本仍在（FR-8.2 到期归档而非删除）。
2. **越权可见**：平台管理员/审计员可查审计，但按 C1/FR-7.3 平台本不具备文件内容可见性；全文入链会让“审计员”变成“可读所有源码”的角色。
3. **不可删除**：链不可改，正文一旦入链无法按条删除（AC-55）；收到删除请求只能整体归档销毁。
4. **体积**：需求 §5.2 估算 500 人 × 20~100 次/日 = 1~5 万条/日；1KB 摘录 → 50MB/日 → 9GB/180 天；8KB 则 ~72GB。全文（平均 10KB）会到 90GB+，且每次哈希/校验成本同比放大。
5. **可检索性并不需要全文**：审计员的关键字查询目标是“定位到哪次复制/下载”，文件名/路径/用户 + 1KB 前缀已足够；超过上限的内容明确不可查（UI/文档声明）。

摘录规则（开关开启后）：
- 仅文本剪贴板内容；二进制/图片/媒体不摘录；
- 取复制文本的前 1KB（UTF-8 字节，按字符边界截断），保留换行、去 NUL/控制字符，`excerptTruncated=true`；
- `sha256` 对**复制文本全量**计算（与摘录长度无关），因此“同一内容重复复制”仍可识别；
- 开关关闭时宿主任丢弃 `excerpt` 字段（宿主是权威，客户端不能自行塞入）；
- 查询只匹配 `fileName/path/actor/subject/excerpt`，不匹配 `reason/denial` 等其他 metadata（避免误命中/泄露）。

### 2.7 时间与大小语义

- 链上 `ts` = 平台入库时间（单写者时钟），用于 31 天窗口与排序；`metadata.occurredAt` = 动作发生时间，仅展示/辅助。
- 查询默认按 `ts` 过滤；投递延迟 ≤1 个心跳（默认 10s），最迟 60s（需求 AC-41）。
- `sizeBytes` 是“实际交付/复制字节数”，不是 `stat` 的逻辑大小（被截断的预览复制必须记实际复制长度，不能虚报文件大小）。

### 2.8 命名与兼容

- 新事件裸名；旧 `host.*` 不变。
- 平台侧 `appendHostAuditReports` 仅对**非**文件事件加 `host.` 前缀；文件事件原样落链。
- 事件类型白名单在 ingest 中显式枚举；未知类型仍按旧行为丢弃（不 500）。

### 2.9 混合版本与能力协商（OQ-15）

- **旧平台 + 新宿主**：旧 `parseHostAuditReports` 不认文件事件 → 静默丢弃，且宿主会 `clearThrough`。为避免升级窗口漏审，平台在心跳响应里新增可选 `auditCapabilities: { fileEvents: true }`（wire-additive，旧宿主结构上忽略）；宿主只在看到该能力后才把文件事件入队上报，否则计入 `auditGap.suppressed` 并在 `/v1/audit/status`/主机详情可见。
- **新平台 + 旧宿主**：旧宿主不上报新类型，平台行为不变。
- **新宿主 + 新平台**：正常。
- 该能力字段与 `projectsRootRejected`/`provisionAssignments` 采用同一“旧宿主白名单解析→结构不可见”的先例（`server.ts:2579-2603` 注释）。

---

## 3. 捕获点盘点

### 3.1 总矩阵

| # | 捕获点 | 层级/接缝 | 实现方式 | 落点/可信度 | 遗漏面 |
| --- | --- | --- | --- | --- | --- |
| C1 | 宿主拒绝下载/导出 | L1 传输层 `denyRpcMethodForCaller` | 在 `onCloudDenial` 把 `DOWNLOAD_DISABLED` 特判为 `file_download result=denied`（不再记 `method_denied`） | 宿主事件，host-attested | 只覆盖 `DOWNLOAD_METHODS`；未注册的方法只会在 `method_not_found` 前被拦（若策略允许则不产生事件） |
| C2 | `browser.download` 成功/失败 | L2 已注册方法 | 在 `browserDownload` 处理器用 `ctx.cloudAudit` 记 `file_download`（`kind=browser`，`method=browser.download`） | 宿主事件，host-attested | 页面自发的 `will-download` 不经过该 RPC；无项目/文件名上下文，一期不归属 |
| C3 | 桌面云工作区单文件下载 | L3 `downloadRuntimeFile` | 保存完成/失败/取消后，客户端调 `audit.recordFileEvent` 上报（size 由分块累计，sha256 可选） | `client-declared` | 直接调 `files.readChunk` 重建文件不上报；被取消后仍可能已读部分字节（记 failure） |
| C4 | 移动端保存到手机 | L3 `savePreparedFileToPhone` | 保存/分享完成后上报（已有 `prepared.sha256`；`saved` 与 `shared` 区分） | `client-declared` | 分享面板被系统取消时只能记 `shared`，无法确认落盘 |
| C5 | Web/桌面应用内复制内容 | 剪贴板接缝 | 在知道文件上下文的调用点（代码块复制、预览复制按钮等）调 `recordFileCopy`；剪贴板写入本身不变 | `client-declared`（`capturePoint=web-clipboard-api`/`desktop-clipboard-ipc`） | 不知道上下文的复制（通用文本）不记；键盘 Ctrl+C 一期不捕获 |
| C6 | 编辑器/预览选区复制 | DOM `copy` 事件 | 二期在 Monaco/预览容器监听 `copy`，读选区+模型 URI，标记 `content-selection` | `client-declared`（`capturePoint=dom-copy-listener`） | 跨域 iframe（浏览器面板）、浏览器自带“另存为”不可见 |
| C7 | 移动端复制内容 | `copyContent` | 复制成功/失败后上报（`copyKind=content-whole`，内容≤512KB） | `client-declared` | 复制路径不记 |
| C8 | 前端下载拦截 | L0 UI | 策略 deny 时入口置灰/锁定；用户点击时上报 `download_blocked` | `client-declared`，advisory | 入口被隐藏时没有点击；Web 无入口；直接 RPC 绕过 |
| C9 | 专用下载 RPC（二期） | L2 新增 `files.download` | 宿主流式交付并边算 sha256，完成/失败后记 `file_download` | `host-attested` | 读 `readChunk` 重建仍可绕过（FR-7.3 不阻断读） |
| C10 | 读字节累计推断（二期） | L3 `files.readChunk` | 宿主按 `(device, worktree, relativePath)` 累计读字节，达到文件大小阈值记一条 `file_download`（`captureConfidence=inferred`，窗口内去重） | `inferred` | 分段预览/编辑器读可能误报；客户端分批跨窗口可能漏 |

### 3.2 下载捕获详述

1. **桌面云工作区（主路径）**：`downloadRemoteFile` → `downloadRuntimeFile`。在一期新增 `recordDownloadOutcome`：拿到 `canceled:false` 后上报 `success`（`sizeBytes` 用循环累计的 `offset`；`sha256` 仅当本地有完整字节时计算，否则省略并置 `sha256Source:'client'`）；`canceled:true` 上报 `failure`+`client_cancelled`，不产生 success；异常上报 `failure`+`read_failed`。方法名记 `files.readChunk`，`kind=file`，`surface=desktop`。
2. **移动端**：`save()` 成功后上报；`result.kind==='saved'` → `success`（`sha256` 来自 `prepared.sha256`），`shared` → `success` 但 `reason:'share_sheet'`+`captureConfidence:'client-declared'`（不得说“已落盘”）；取消/失败 → `failure`。
3. **宿主浏览器**：`browser.download` 处理器成功后记 `file_download`（`kind=browser`，`fileName` 从 URL/响应头推导；无法推导则 `fileName` 留空并 `method` 标明）。页面自发下载一期不归属（声明）。
4. **前端拦截**：`workspace.info` 新增 `downloadAllowed`（wire-additive）；客户端在云会话且 `downloadAllowed!==true` 时置灰下载入口；点击 → `download_blocked`。桌面 `runtimeDownloadContext` 存在且为云会话的判断复用 `isCloudSessionEnvironmentId`。非云/SSH 不受影响。
5. **Web 工作区 / 管理台**：无下载入口，一期**不新增下载能力**；文档与 UI 说明“Web 工作区当前不提供文件下载”，不得把“无事件”说成“已覆盖”。
6. **终端产物**：`terminal.exportArtifact` 未注册；一期只审计 `browser.download` 与客户端下载；二期若实现 `terminal.exportArtifact` 再加（声明）。

### 3.3 复制捕获详述

1. **Web 剪贴板接缝**：`writeWebClipboardText` 是统一出口，但它只拿到文本、不知道来源文件。方案：不改签名，新增 `recordFileCopy(source, copied)`，由**知道文件上下文的调用点**在写剪贴板成功后调用；`web-clipboard-api` 仍保持单一写口。这避免把“复制路径/复制 ID”误记成文件内容。
2. **桌面剪贴板接缝**：`clipboard:writeText`（`clipboard-ipc-handlers.ts:209`）同理由调用点补充来源；`clipboard:writeFile` 在云 runtime 行被隐藏，一期不覆盖；本地/SSH 文件对象复制不属平台项目（声明）。
3. **一期明确埋点的调用点**：代码块复制按钮（`CodeBlockCopyButton.tsx:36-66`，文本来自当前文件）、Markdown/预览“复制内容”按钮、文件预览复制动作。每个调用点必须能给出 `path/fileName/copyKind`；给不出就不记。
4. **二期选区捕获**：Monaco 监听编辑器 DOM 的 `copy`（选区文本 + `model.uri`），预览容器监听 `copy`（选区 + 容器上的 `data-orca-file-path`）；标记 `capturePoint=dom-copy-listener`、`captureConfidence=client-declared`。跨域 iframe 不可见。
5. **移动端**：`copyContent` 在 `clipboard.writeText` 成功后上报；内容超过 512KB 时记 `copiedBytes` 为实际截断长度。
6. **终端选区复制**：不纳入（OQ-11）；只记终端/连接层面已有事件，不记内容。

### 3.4 不可捕获面（必须原样写进 UI/文档，AC-44/AC-47）

- 开发机 shell 的 `scp`/`git push`/`curl`/`cp`、宿主内任意带外传输（C1，平台不可见）。
- OS 层：Finder/Explorer 复制、拖拽到桌面、第三方应用、截图/录屏/OCR。
- 纯客户端浏览器“另存为”、宿主浏览器页面自发的 `will-download`（一期不归属）。
- 跨域 iframe/浏览器面板内的选区复制。
- 客户端绕过应用接缝直接调用 `files.readChunk` 重建文件（一期无事件；二期只有阈值推断，仍不保证完整）。
- 桌面端经由 Chromium 原生剪贴板的键盘 Ctrl+C（一期）；被审计用户关闭客户端、离线、或宿主进程重启导致内存缓冲丢失的窗口（缺口需可见，见 §5.4）。

### 3.5 可信度模型

- `host-attested`：宿主在 RPC 处理器内生成（C1/C2/C9），可作为“主机确认”的证据。
- `client-declared`：客户端自报（C3~C8），是检测性证据（advisory），UI 必须带“客户端自报”标识。
- `inferred`：宿主按读字节推断（C10），误报/漏报都可能，UI 标“推断”。

审计链保证**记录不被篡改**，不保证**记录完整**——这句话必须进入管理台提示与验收文档。

---

## 4. 查询实现

### 4.1 参数与语义（扩展现有端点）

| 条件 | 参数 | 语义 | 与旧行为关系 |
| --- | --- | --- | --- |
| 时间 | `since`（保持，ISO） | 下界（含） | 不变 |
| 时间 | `until`（新增，ISO） | 上界（含）；与 `since` 组成 ≤31 天窗口；只有 `until` 时隐式 `since=until-31d` | 新增 |
| 操作类型 | `eventType`（保持） | 精确等值 | 不变 |
| 操作类型 | `eventTypes`（新增，逗号分隔） | OR；最多 20 个、每个 ≤64 字符；与 `eventType` 同时出现时以 `eventTypes` 为准 | 新增 |
| 操作类型族 | `eventFamily`（新增，可选） | `download` → `file_download,download_blocked`；`copy` → `file_copy`；与 `eventTypes` 同时出现时以显式集合优先 | 新增 |
| 用户 | `actor`（保持） | 精确等值 | 不变 |
| 用户 | `username`（新增） | 不区分大小写，精确匹配 `actor` 或 `metadata.subject`（去 `user:` 前缀）；解决旧 `host.*` 事件按用户查不到 | 新增 |
| 文件名 | `fileName`（新增） | basename，不区分大小写子串；1..128 字符 | 新增 |
| 关键字 | `q`（新增；兼容别名 `keyword`） | 不区分大小写**字面子串**（无正则/通配），匹配 `fileName`、`path`、`actor`/`subject`、（开关开启时）`excerpt`；2..128 字符 | 新增 |
| 结果 | `result`（保持） | 三值等值 | 不变 |
| 项目 | `projectId`（新增） | `targetId` 等值（文件事件 target=project） | 新增 |
| 主机 | `hostId`（新增） | `metadata.hostId` 等值 | 新增 |
| traceId | `traceId`（保持） | 精确 | 不变 |
| 分页 | `cursor` / `limit`（保持） | 新→旧；limit 1..200 默认 50 | 不变 |

组合规则：不同条件 AND；`eventTypes` 内部 OR；`q` 与 `fileName` 同时出现时两者都要满足；空字符串视为未提供。

### 4.2 校验与错误码

- `q`/`fileName`/`eventTypes` 超长或非法 → 400 `INVALID_QUERY`（消息指明字段与上限）；`q` 只有空白 → 视为未提供；`%`/`_`/正则元字符按字面处理（AC-50）。
- `since`/`until` 解析失败：`since` 保持旧行为（`Date.parse` 失败视为未提供，兼容旧客户端）；`until` 解析失败 → 400 `INVALID_QUERY`。
- `until < since` 或窗口 >31 天 → 400 `TIME_WINDOW_TOO_LARGE`。
- `limit`：保持 `Number.isInteger>0` 钳制、封顶 200、默认 50（U57 U8；不因新参数改成 400）。
- 限流：审计查询 10 次/分钟/用户（design §15.3）；超限 429 `RATE_LIMITED` + `Retry-After`。注：design 表把超限写成 400，按 HTTP 语义取 429，登记为文档偏差（§9 O-6）。
- 关键字查询缺省时间窗：`q`/`fileName` 存在而 `since/until` 都缺省时，隐式 `since=now-7d`（与 AC-13 口径一致，避免无界全量关键字扫描）；响应/文档说明。

### 4.3 实现落点

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 链查询 | `apps/api/src/audit.ts` | `AuditQuery` 增加 `until/eventTypes/fileName/keyword/username/projectId/hostId`；`query` 改为**倒序扫描 + 命中即停**（见 §4.4）；新增 `searchable(event)`（WeakMap 缓存） |
| 远端客户端 | `apps/api/src/audit-writer-client.ts` | 转发新参数（数组用逗号拼接）；`AuditQuery` 类型同步 |
| 写入者 | `apps/audit-writer/src/writer.ts` | `GET /v1/events` 解析新参数并透传 `chain.query` |
| API | `apps/api/src/server.ts` | 参数解析/校验/限流/自审计；`since/until` 字符串→epoch；`eventFamily` 映射；查询后写 `audit_query` 摘要 |
| 管理台 | `apps/web/app.js` | 审计页新增关键字/文件名/起止时间/事件类型多选；结果行展示文件名/大小；展开摘录/sha256；命中高亮（前端按关键字匹配已返回的 metadata，无需服务端 `matchedFields`） |
| 响应 | 不变结构 `{events, nextCursor}` | `events` 已含 metadata；不再返回总数（见 §4.4） |

### 4.4 查询算法与性能

```ts
// 倒序扫描，命中即停：常见“按用户/类型 + 最近一页”不再扫全量。
const out: AuditEvent[] = []
for (let i = events.length - 1; i >= 0; i--) {
  const e = events[i]
  if (cursor !== undefined && e.seq >= cursor) continue
  if (since !== undefined && e.ts < since) continue
  if (until !== undefined && e.ts > until) continue
  if (eventTypes !== undefined && !eventTypes.has(e.eventType)) continue // eventType/eventTypes/family 合并成集合
  if (actor !== undefined && e.actor !== actor) continue
  if (username !== undefined && !usernameMatches(e, username)) continue
  if (result !== undefined && e.result !== result) continue
  if (traceId !== undefined && e.traceId !== traceId) continue
  if (projectId !== undefined && e.targetId !== projectId) continue
  const m = e.metadata ?? {}
  if (hostId !== undefined && m.hostId !== hostId) continue
  if (fileName !== undefined && !str(m.fileName).toLowerCase().includes(fileNameLower)) continue
  if (keyword !== undefined && !searchable(e).includes(keywordLower)) continue
  out.push(e)
  if (out.length === limit) break
}
```

`searchable(e)` 只对**带 `fileName/path/subject/excerpt` 的事件**构建（WeakMap 缓存），非文件事件不占内存；字段拼接后 `toLowerCase()`，一次 `includes` 完成匹配。拼接顺序固定：`fileName\npath\nsubject\nactor\nexcerpt`。

性能测算（沿用 M105 机器与真实进程）：
- 基础过滤（等值/时间）20 万条实测 P95 6.6–7.3ms；倒序+命中即停后只会更快。
- 关键字最坏情况（20 万条全是文件事件、无其他过滤）：20 万次 `includes` ≈ 20~60ms（V8 子串扫描 + 已缓存小写串），仍远低于 2000ms。
- 需求 AC-51 要求语料 20 万条中 ≥2 万条文件事件：关键字扫描 2 万条 ≈ 5~15ms。
- 两跳 HTTP（API→writer）已在 M105 基线内；无新增网络跳。

**容量与索引裁定**：
- 一期不建索引。触发上索引的条件（写入 `test-plan.md` 并在 M105 回归中检查）：①查询窗口内文件事件 >50 万条；②关键字查询 P95 >500ms；③链内总事件 >100 万条（内存绑定）。
- 若触发：先上“文件事件倒排/前缀索引”（内存，按 token→seq），仍不够再评估 SQLite（better-sqlite3）+ FTS5（writer 单进程、可持久化、可只加载窗口）。本期不做。
- **内存包线**（必须写进运维文档）：事件 metadata 平均 0.3~1KB；现有链把 180 天全量放内存。按 20 万/30 天 ≈ 6.7k/日推算，180 天 ≈ 120 万条 × ~0.4KB ≈ 480MB；若复制事件达到需求估算的 1~5 万/日，180 天为 180 万~900 万条（0.7~3.6GB+），**超出当前内存链可用范围**。因此：
  - 一期上线前必须用真实/仿真量测一次日均文件事件数；
  - 若 >5k/日，登记为“容量超包线”，在二期或独立 M 项切 SQLite/分页存储；
  - 不得以“M105 查询很快”掩盖内存容量问题（查询快 ≠ 装得下）。

### 4.5 查询自审计（OQ-17）

每次成功查询写一条 `audit_query`（best-effort，不入 fail-closed 门禁）：`metadata:{scope:'admin'|'auditor', filters:['q','fileName','eventTypes','actor','username','since','until','projectId','hostId'], keywordHash:sha256(q).slice(0,16), keywordLength, resultCount:events.length, hasMore:nextCursor!==null, limit}`。**不写原始关键字**（避免二次泄露，但仍可关联重复查询模式）。被拒绝的查询沿用既有 `audit_query` denied 路径（`denyPrivileged`）。注意：自审计本身会增加链体积，按 10 次/分钟限流已可控。

---

## 5. 权限与可见性

### 5.1 查询权限（裁定 D7）

- 保持 FR-9.7：`/v1/audit/events` 仅 `platform:admin` / `platform:auditor`；无权限 → 403 + `audit_query` denied（现有 `denyPrivileged`）。
- **不新增**本人自查通道。理由：需求文档 §8 明确“FR-9.7 审计查询权限不变”；用户需求只要求“审计员可按关键字查询”，未要求被审计用户自查；新增自查会引入新的可见性/限流/隐私决策。
- 冲突登记：UI 原型 2733 行“普通用户仅可见本人相关记录、不展示他人的复制内容与 sha256”与本裁定冲突。若主会话坚持原型语义，必须同时回答：普通用户从哪个入口进（现管理台 `audit` 路由是 admin-only，`app.js:85`）、限流与脱敏规则；否则按本裁定修订原型（§9 O-1）。

### 5.2 下载/复制事件对被审计用户的可见性

- 一期：不可见（同上）。用户在自己的工作区只能看到“下载被策略禁用”的提示，看不到审计记录。
- 若未来开放自查，建议独立端点 `GET /v1/audit/my-events`（强制 `actor=本人`、仅 `file_download/file_copy/download_blocked`、limit ≤50、10 次/分钟），不复用管理端点；本文不实现。

### 5.3 复制的允许性

不变（O3：默认允许文本、禁止超限二进制）。U66 只增加审计，不新增阻断；剪贴板权限失败时记 `file_copy result=failure`，不重试、不阻断。

### 5.4 审计写入的失败语义

- 事件上报是 **best-effort**：宿主队列满/平台离线不得阻断下载/复制（与既有 `appendBestEffort` 一致）。
- 但缺口必须可见（AC-43）：
  - 宿主每拍带 `auditGap:{bootId, pending, dropped, suppressed}`（wire-additive，旧平台忽略）；`dropped>0` 或同一主机 `bootId` 变化且上一拍 `pending>0` → 平台写一条 `host.audit_gap`（agent 侧聚合，避免刷屏），管理台主机详情/审计页展示告警。
  - 宿主进程在两次心跳之间崩溃导致的丢失**无法精确检测**（内存缓冲），文档必须如实声明“缺口可见性 best-effort”。
- 平台链写失败沿用既有 fail-closed：只影响敏感变更门禁，不影响文件读取/复制（后者本就是 best-effort）。

---

## 6. 分期与改动清单

### 6.1 一期（P0）

**出口**：AC-41~AC-47、AC-49~AC-52；覆盖声明就位；查询性能在 20 万条/≥2 万文件事件语料上 P95 ≤2s。

| 域 | 端点/文件 | 改动 |
| --- | --- | --- |
| 平台事件模型 | `host-audit-ingest.ts` | 新增文件事件类型白名单、字段校验/上限、裸名落链、deviceId→用户 actor 解析、绝对路径/`..` 拒绝、4KB 上限 |
| 平台链路 | `server.ts` | 心跳 ingest 传入 `resolveActor`；心跳响应加 `auditCapabilities.fileEvents` + `auditGap` 处理；写 `host.audit_gap` |
| 查询 API | `audit.ts`/`audit-writer-client.ts`/`writer.ts`/`server.ts` | §4.1 参数、§4.2 校验、倒序+命中即停、`audit_query` 摘要、限流 |
| 管理台 | `apps/web/app.js` | 审计页筛选（关键字/文件名/起止/多类型）、文件名/大小展示、摘录与 sha256 展开、覆盖声明 |
| 宿主上报 | `cloud-host-audit.ts`/`cloud-agent-client.ts`/`cloud-heartbeat-body.ts`/`cloud-host-enrollment.ts` | 队列支持 success/failure、每拍最多 100 条（余量下拍）、`auditGap`、能力协商 |
| 宿主审计入口 | `runtime/rpc/core.ts`/`runtime-rpc-websocket-dispatch.ts`/新 `methods/cloud-audit.ts`/`cloud-rpc-permission.ts` | `RpcContext.cloudAudit = {deviceId, subject, report}`；新方法 `audit.recordFileEvent`（`SESSION_METHODS` 分类）；路径/字段/限流校验；非云会话 `{queued:false}` |
| 宿主下载拒绝 | `runtime-rpc-websocket-dispatch.ts` | `DOWNLOAD_DISABLED` → `file_download result=denied`（替代 `method_denied`） |
| 宿主浏览器 | `methods/browser-core.ts` | `browserDownload` 成功/失败记 host-attested `file_download` |
| 桌面下载埋点 | `runtime-file-read-client.ts` + 新 `renderer/src/runtime/file-audit-client.ts` | 成功/失败/取消上报（size、可选 sha256、method=files.readChunk） |
| 移动端埋点 | `mobile/src/files/use-mobile-file-actions.ts` | save/copy-content 上报（复用已有 sha256） |
| 复制埋点 | 知道文件上下文的复制调用点（`CodeBlockCopyButton.tsx` 等） | `recordFileCopy`（copyKind/copiedBytes/excerpt 按开关） |
| 前端拦截 | `workspace-info.ts` + `src/shared/cloud-workspace-info.ts` + 桌面/云工作区状态 + `file-explorer-row-action-visibility.ts` | `downloadAllowed` 下发；云会话 deny → 置灰/锁定；点击 → `download_blocked` |
| 覆盖声明 | 管理台提示 + 本文档 | AC-44/AC-47 文案 |

**一期不做**：专用 `files.download` 实现、读字节推断、DOM 选区捕获、摘录（开关与检索）、文件夹清单、本人自查。

### 6.2 二期（P1）

**出口**：AC-40/AC-48、AC-54/AC-55；宿主专用下载 RPC 拒绝率可证；摘录查询仍满足 P95 ≤2s。

| 域 | 改动 |
| --- | --- |
| 宿主专用下载 | 注册 `files.download`（流式、边算 sha256、完成/失败落 host-attested 事件）；桌面 `downloadRuntimeFile` 优先走它，`method_not_found` 回退 `readChunk`；`files.downloadFolder` 云路径延后并声明 |
| 读字节推断 | `files.readChunk` 处理器按 `(device, worktree, relativePath)` 累计字节，达到 `stat.size` 且窗口内首次 → `file_download`（`inferred`）；Map+TTL 有界 |
| 选区复制 | Monaco/preview `document copy` 监听 → `file_copy`（`content-selection`、`dom-copy-listener`、advisory） |
| 摘录开关 | 平台 policy pack 加 `auditExcerptEnabled/auditExcerptMaxBytes`；管理端点（admin-only，写 `policy_update`）；宿主权威裁剪；查询匹配 `excerpt`；容量预算与告警 |
| 存储/索引 | 按 §4.4 触发条件评估 SQLite/FTS5；不自动触发，需主会话立项 |
| 终端产物 | 若实现 `terminal.exportArtifact`，按同一模型落 `kind=artifact` |

---

## 7. 测试计划要点（供 `test-plan.md` 引用）

### 7.1 事件落链断言

- 心跳携带 `file_download`/`file_copy`/`download_blocked` → 链中出现裸名事件；`actor=用户名`（deviceId 可解析时优先，`metadata.subject` 交叉校验）；`targetId=projectId`；metadata 字段/上限正确；`/v1/audit/verify` 通过。
- `metadata` 参与哈希：改写 `fileName`/`sizeBytes`/`sha256` 任一字段 → verify 报断链。
- 未知事件类型仍被丢弃，不 500；绝对路径/`..` 路径的报告被单条丢弃，不影响同拍其他事件。
- 每拍 >100 条：第 101~200 条在下一拍到达，不丢失（修复 §1.3 缺陷）；`auditGap.dropped`/`suppressed` 如实上报并生成 `host.audit_gap`。
- 能力协商：旧平台响应（无 `auditCapabilities`）时新宿主不上报新类型且计数；新平台 + 旧宿主不变；新宿主 + 新平台正常。三向回归。

### 7.2 查询组合矩阵

- 四条件组合：`since/until + eventTypes + actor/username + fileName` → 恰好命中，无多返/漏返（AC-49）。
- 关键字：`q=payment`、`fileName=payment`、`q=PAYMENT` 三者一致（大小写不敏感）；`%`/`_`/`.*` 按字面；长度 1/129 → 400 `INVALID_QUERY`；空 `q` 不改变结果。
- `eventType` 单值与 `eventTypes` 多值 OR；`eventFamily=download/copy` 映射；两者同时出现以 `eventTypes` 为准。
- `username` 命中 `actor` 与 `metadata.subject`（旧 `host.*` 事件可按人查）；`actor` 仍为精确等值。
- 分页：cursor 走完与一次查询集合一致、seq 递减、不重不漏（沿用 `audit-integrity.test.ts:97` 的断言方式）。
- 时间：`until` 只有上界时隐式 31 天；`until<since`、窗口 >31 天 → 400；`q/fileName` 缺时间 → 隐式 7 天。
- 自审计：查询后出现 `audit_query`，含过滤字段名、`keywordHash`、`resultCount`，不含原始关键字。

### 7.3 性能预算

- 扩展现有 `audit-query-latency.e2e.test.ts`：20 万条语料中注入 ≥2 万条 `file_download/file_copy`（含 fileName/path/摘录关闭）；分别采样①四条件等值查询 ②`q` 关键字查询 ③`fileName` 子串查询，各 30 次；断言 P95 ≤2000ms；注入 2.2s 延迟的对照必须转红；撤销后恢复。
- 同一语料记录 P50/P95 与命中条数，存入 `evidence/m105-audit-query-latency/`（或新目录 `u66-audit-query-latency/`）。
- 摘录开启后的二期复测：加入 1KB 摘录，重新采样关键字查询，仍 ≤2s；记录事件体积与内存增长。

### 7.4 负向

- 无权限用户查 `/v1/audit/events` → 403 + `audit_query` denied（管理台导航不出现，沿用 AC-18）。
- `limit=0/-1/abc` → 默认 50 且 ≤200（旧行为不变）；非法 `eventTypes`/`until` → 400；`q` 超长 → 400。
- 查询限流：第 11 次/分钟 → 429 `RATE_LIMITED`，`Retry-After` 存在。
- 审计链损坏时：文件事件上报不阻断下载/复制；敏感管理操作仍 fail-closed；`/v1/audit/status` 反映健康。
- 客户端伪造：`audit.recordFileEvent` 传绝对路径/`..`/超长 excerpt/非法 sha256 → 宿主拒绝并返回错误；策略关闭时传 excerpt → 宿主丢弃字段；非云会话调用 → `{queued:false}`，不写平台。
- 前端拦截：策略 deny 时点击置灰入口 → 一条 `download_blocked`（不重复）；策略 allow 时不产生；Web 无入口时不产生也不报错。

### 7.5 捕获点/客户端

- 桌面下载成功/取消/失败三条路径各一条事件，`sizeBytes` 与实际一致，`method=files.readChunk`（一期）或 `files.download`（二期）。
- 移动端 `saved` vs `shared` 的结果语义：`shared` 不得显示为“已保存到本机”。
- 复制：代码块复制/预览复制成功 → `file_copy`；复制路径 → 无事件；复制失败 → `result=failure`。
- `browser.download` 成功/失败 → host-attested 事件；页面自发下载一期无事件（声明回归）。
- 二期：`files.download` 在 deny 策略/无 `download` 权限下被拒并记 `file_download result=denied`；裸 WebSocket 直调同样被拒（AC-40）。
- 二期：读字节累计达到阈值 → 一条 `inferred` 事件；同一文件窗口内不重复；未达阈值无事件。

### 7.6 证据

- 真实 writer 进程 + 真实 API 进程 + 真实 HTTP；e2e 保存 JSON（AC-49/51/52）；客户端侧保存 UI 截图/事件 JSON（在不提交的 evidence 目录）；覆盖声明文本纳入验收。

---

## 8. 实施切分（每令 ≤20 分钟，域不相交）

> 依赖顺序：O1→O2→O3→(O4/O5/O6 并行)→O7→O8→O9；二期 P1→P2/P3/P4 可并行。

| 令 | 内容 | 主要文件 | 验收 |
| --- | --- | --- | --- |
| **O1** | 平台事件模型与 ingest | `host-audit-ingest.ts`、`server.ts`（resolveActor 调用点） | 文件事件裸名落链、actor=用户、字段上限、坏路径单条丢弃、verify 通过 |
| **O2** | 宿主上报队列扩展 | `cloud-host-audit.ts`、`cloud-agent-client.ts`、`cloud-heartbeat-body.ts`、`cloud-host-enrollment.ts` | success/failure 可上报；>100 条分拍不丢；`auditGap`；能力协商三向 |
| **O3** | 宿主审计接收 RPC | `runtime/rpc/core.ts`、`runtime-rpc-websocket-dispatch.ts`、新 `methods/cloud-audit.ts`、`cloud-rpc-permission.ts`、`runtime-rpc-mobile-method-allowlist.ts` | 云会话可上报；非云 no-op；路径/字段/限流校验；移动端（带 cloudSession）在 allowlist 内可上报；enqueue 到心跳 |
| **O4** | 桌面/移动下载埋点 | `runtime-file-read-client.ts`、新 `renderer/src/runtime/file-audit-client.ts`、`mobile/src/files/use-mobile-file-actions.ts` | success/failure/cancel 三条路径事件，size/sha256 语义正确 |
| **O5** | 复制接缝埋点（一期） | `CodeBlockCopyButton.tsx`、预览复制按钮、`recordFileCopy` | 文件内容复制有事件；复制路径无事件；失败留痕 |
| **O6** | 前端下载拦截 | `workspace-info.ts`、`src/shared/cloud-workspace-info.ts`、云工作区状态、`file-explorer-row-action-visibility.ts` | deny → 置灰 + 点击 `download_blocked`；allow 不产生；Web/管理台无入口说明 |
| **O7** | 查询 API 扩展 | `audit.ts`、`audit-writer-client.ts`、`writer.ts`、`server.ts` | §7.2 组合矩阵、§7.4 负向、限流、自审计 |
| **O8** | 管理台审计页 | `apps/web/app.js` | 四条件 + 关键字、文件名/大小、摘录/sha256 展开、覆盖声明、旧参数兼容 |
| **O9** | 性能与证据 | `test/e2e/audit-query-latency.e2e.test.ts`（扩展） | 20 万条/≥2 万文件事件 P95≤2s；延迟对照转红 |
| **O10** | 兼容性回归 | 旧宿主/旧平台矩阵测试 | 三向兼容、旧管理台零改动 |
| **P1** | 宿主专用 `files.download` | `methods/files*.ts`、`runtime-file-read-client.ts` | 流式交付 + host-attested 事件；deny/无权限拒绝；旧宿主回退 |
| **P2** | 读字节推断 | `methods/files.ts`（readChunk 处理器） | 阈值/去重/窗口；`inferred` 标识 |
| **P3** | 选区复制捕获 | Monaco/预览 DOM 监听 | `content-selection` 事件；跨域 iframe 无事件且不报错 |
| **P4** | 摘录开关与检索 | policy pack、管理端点、宿主裁剪、查询匹配 | 默认关闭；开启后 ≤1KB、二进制不摘录、可检索；关闭时字段被丢弃 |
| **P5** | 容量/索引评估 | 量测报告 + 触发条件 | 日均文件事件数与内存占用；是否立项 SQLite/FTS5 的建议 |

---

## 9. 风险与开放问题

| 编号 | 问题 | 影响 | 本文裁定/建议 |
| --- | --- | --- | --- |
| O-1 | 原型“普通用户仅可见本人记录”与 FR-9.7/需求 §8 冲突 | 权限模型、限流、隐私 | 按需求文档：**不开放本人自查**；原型待修订（或主会话明确另立用户端入口） |
| O-2 | 180 天 × 复制量的内存链容量 | 可用性、OOM、查询 | 一期先量测；>5k 文件事件/日即登记容量超包线，二期/独立项切 SQLite 分页存储（§4.4） |
| O-3 | 客户端自报事件可伪造/可省略 | 审计完整性 | 用 `captureConfidence` 分级并在 UI 标注；宿主侧只做路径/字段校验，不宣称完整性；二期用 host-attested + 推断提高覆盖率 |
| O-4 | 真实下载路径是 `readChunk`，专用下载方法未注册 | FR-9.12 的“100% 拒绝”不成立 | 明确登记已知缺口：一期前端拦截不是安全边界；二期实现 `files.download` 并保留“读重建”缺口说明（FR-7.3 不阻断读） |
| O-5 | 摘录的隐私/合规 | 180 天不可删、密钥片段入链 | 默认关闭；开启前需合规确认（OQ-16）；UI 明示“开启后 1KB 正文入链 180 天” |
| O-6 | 审计查询限流状态码：design 表写 400 | 文档一致性 | 取 429；登记文档偏差，建议后续修订 design §15.3 |
| O-7 | 页面自发 `will-download`、跨域 iframe、OS 复制不可归属 | 覆盖声明 | 逐项列入覆盖说明，不得宣称“所有外流已审计” |
| O-8 | `eventTypes`/`eventFamily` 新参数的旧客户端兼容 | 白屏/400 | 只增不改；旧 UI 继续用 `eventType/actor/result/traceId/since/limit/cursor`；混合版本回归（O10） |
| O-9 | `audit_query` 自审计的体积与关键字泄露 | 链体积、隐私 | 只存 `keywordHash` 与长度，不存原词；限流 10/分钟 |
| O-10 | 文件夹下载/终端产物导出在云会话无实现 | 需求范围 | 一期声明“不提供/不审计该动作”；二期按需实现，不伪造事件 |

---

## 10. 不做清单（明确范围外）

- 不做内容级 DLP/阻断（C1）；不拦截任何文件读取（FR-7.3）。
- 不记录终端内容、AI 会话内容、文件正文（除默认关闭的 1KB 摘录）。
- 不审计 OS/Finder/第三方应用/截图/带外 shell。
- 不改变复制允许性（O3）与下载策略语义（FR-7/FR-9.12）。
- 不新增本人自查入口（本裁定；见 O-1）。
- 不实现审计导出（FR-8.5 另项）、不实现 180 天归档检索。
- 不改 `host.*` 既有拒绝事件的 actor/命名（历史不回填）。

---

## 11. 主会话审定项（3 项）

1. **O-1 可见性**：确认“不开放本人自查、按 FR-9.7 仅 admin/auditor”，并安排原型修订（否则需定义用户端入口、限流与脱敏）。
2. **O-2 容量**：确认一期内存链的容量包线（建议 ≤5k 文件事件/日、总量 ≤100 万条），以及超线后的存储立项路径。
3. **O-4 下载硬拦口径**：确认二期以“专用 `files.download` host-attested + 读重建缺口声明”作为 FR-9.12 的交付边界，不承诺“读重建 100% 拒绝”。


## 主会话审定（2026-11-16）

三项待审定项裁定：①**不开放本人自查**（采纳；原型 2733 行说明改「审计员/管理员可见全部；本人自查不在本期」——随评审修改批处理）；②**一期容量包线采纳**（≤5k 文件事件/日、≤100 万条；超线触发二期存储升级立项）；③**二期硬拦按 host-attested+读重建缺口声明交付**（采纳；不承诺 100% 拒绝）。**重大现状发现确认**：files.download/downloadFolder/terminal.exportArtifact/browser.savePage 非已注册 RPC、Web 工作区无下载入口——一期审计覆盖=应用接缝实际发生面（桌面 clipboard/files.readChunk advisory），不得虚构 Web 下载覆盖率。三族文档（需求/技术/原型）齐 → 派独立评审。
