# U66 需求清单 · 文件下载 / 内容复制审计与审计查询增强

> 状态：需求稿，只写文档不改码，待主会话审定后交技术方案与 UI 原型
> 日期：2026-11-15 · 缺陷账：U66（defect-ledger.md:75）
> 需求源（用户 2026-11-15，唯一需求源）：①所有文件下载、文件内容复制必须记录审计；②审计员可按内容/关键字查询复制相关记录；③常用查询条件：时间、操作类型、用户、下载文件名。
> 素材基线：`requirements.md` FR-7/FR-8/FR-9.12、§5.1/§5.4、O3 · `cloud-platform/apps/api/src/{store,audit,host-audit-ingest,server,audit-writer-client}.ts` · `apps/audit-writer/src/writer.ts` · `test/e2e/audit-trace-window.e2e.test.ts` · `test/e2e/audit-query-latency.e2e.test.ts` · `evidence/m105-audit-query-latency/audit-query-latency.json`
> 范围：需求清单。技术方案（宿主上报通道、查询索引、摘录存储）与 UI 原型由并行文档裁定；本文只锁定语义、可捕获面与验收口径。
> 非目标：不改下载管控策略（FR-7/FR-9.12 已定）、不改复制允许策略（O3 默认允许文本）、不承诺内容级 DLP（C1）。

---

## 0. 结论摘要

| 编号 | 需求 | 优先级 | 分期 |
| --- | --- | --- | --- |
| FR-9.13 | **文件下载审计**：每个 Orca 经手的下载/导出动作落 `file_download` 事件（谁/何时/哪个项目/文件名/路径/大小/结果/方法） | P0 | 一期 |
| FR-9.14 | **文件内容复制审计**：应用可捕获的复制动作落 `file_copy` 事件；如实界定 Web/桌面/OS 层可捕获面，不可捕获面必须显式声明 | P0（应用接缝）/ P1（选区捕获扩展） | 一期 / 二期 |
| FR-9.15 | **审计查询增强**：时间、操作类型、用户、下载文件名四条件组合；按文件名/路径/用户关键字（及可选摘录）查询复制记录 | P0（四条件 + 名称类关键字）/ P1（摘录关键字） | 一期 / 二期 |
| FR-9.16 | **隐私与体积权衡**：默认不存文件内容；metadata 存文件名/路径/长度/sha256 指纹，可选摘录为配置开关且默认关闭 | P0（默认关闭）/ P1（开关与摘录查询） | 一期 / 二期 |

**编号说明**：任务口语称「FR-9.11（编号顺延）」，但 FR-9.11 与 FR-9.12 已被 U65 占用（主机授权语义、下载 server 侧拦截）。本文按全局顺延取 **FR-9.13 ~ FR-9.16**，AC 从 **AC-41** 起。若主会话坚持口语编号，需在正式修订时统一改名，不与既有编号冲突。

**三条不可含糊的边界**（后文 AC 与开放问题均以此为前提）：

1. **下载审计覆盖 Orca 经手的动作**：`files.download` / `files.downloadFolder` / `terminal.exportArtifact` / 宿主执行的 `browser.download` / `browser.savePage` 可审计；用户在开发机上用 `scp`、`git push`、`curl`、宿主内 shell `cp` 等带外方式取走文件，平台不可见（C1、FR-7.3）。
2. **复制审计覆盖应用接缝，不覆盖 OS**：Web 端 `navigator.clipboard` / `execCommand` 接缝、桌面端 `clipboard:writeText` 与 `clipboard:writeFile` 接缝可捕获；Finder/Explorer、第三方应用、拖拽、截图/OCR、浏览器自行「另存为」不可捕获。客户端自报事件是**检测性证据（advisory）**，不是防篡改的完整性证明。
3. **内容关键字查询需要内容表示**：只查文件名/路径/用户不需要存内容；要按文件正文关键字查询，必须存可选摘录（或等价的内容派生索引）。默认关闭，开启后遵守审计只追加与 180 天保留（FR-8.2）。

---

## 1. 现状基线（只读核实）

### 1.1 审计事件形态与 metadata 惯例

- 事件输入：`{ eventType, actor, targetType, targetId, result: 'success' | 'failure' | 'denied', traceId, metadata }`（`cloud-platform/apps/api/src/store.ts:100-108`）；落链时补 `seq/ts/prevHash/hash`（`store.ts:110-115`）。
- 链路：`AuditChain.append` 用平台注入时钟生成 `ts`，`hash = H(prevHash || canonicalJson(body))`（`apps/api/src/audit.ts:73-107`）；`query` 目前只在内存数组上做等值/时间过滤（`audit.ts:147-169`）。
- 既有事件类型（server.ts 实读）：`login`、`logout`、`project_connect`、`project_access`、`grant_update`、`host_grant_update`、`policy_update`、`web_handoff`、`audit_query`、`audit_verify` 等；宿主侧上报统一前缀 `host.*`（`host-audit-ingest.ts:87-101`）。
- metadata 惯例：小写驼峰字段，按需出现；`reason`/`code` 放错误码，`hostId`/`projectId`/`method`/`subject` 等放上下文；不把令牌、密码、文件正文写进 metadata（server.ts:1418 注释明确「审计日志不能成为密钥的第二份副本」）。
- 宿主上报入口：心跳体 `audit` 数组（`cloud-heartbeat-body.ts:29,41`），每条 `{ eventType, result, deviceId?, subject?, projectId?, method?, denial?, reason? }`（`host-audit-ingest.ts:15-24`），平台侧最多 100 条/拍、文本截 512 字符（`host-audit-ingest.ts:12-13`）。
- 宿主队列：内存缓冲 200 条，平台不可达时保留、宿主进程重启即丢（`src/main/cloud-platform/cloud-host-audit.ts:1-10,30-68`）；心跳默认 10 秒（`cloud-agent-client.ts:86`），平台离线判定 60 秒（`server.ts:80`）。
- 宿主侧 `subject` 当前取云凭证的 `sub`（`user:<username>`，见 `startup/cloud-runtime-admission.ts:76-82` 与平台签发 `server.ts:3333`），但平台入库时 `actor` 写成 `host:<name>`、把 `subject` 塞进 metadata（`host-audit-ingest.ts:88-100`）——所以按用户查询宿主事件必须改 actor 归属（见 FR-9.13/FR-9.15 与 OQ-19）。

### 1.2 现有查询面与性能基线

- 端点：`GET /v1/audit/events`，admin 或 `platform:auditor`；参数 `actor`、`eventType`、`result`、`traceId`、`since`（ISO）、`cursor`、`limit`（钳制 1..200，默认 50）；单次窗口 ≤31 天，超限 400 `TIME_WINDOW_TOO_LARGE`（`server.ts:2861-2891`）。
- 远端审计写入者同参数转发（`audit-writer-client.ts:164-170`）；写入者自身也只支持这组等值过滤（`apps/audit-writer/src/writer.ts:191-197`）。
- 无 `until`（只有起点）、无 `project`/`host` 过滤（FR-8.3 承诺过项目/主机筛选，实现未提供）、无文件名/关键字/内容查询。
- 管理台审计页只有事件类型下拉、结果下拉、用户输入框（`cloud-platform/apps/web/app.js:1890-1930`），结果表不展示文件名。
- 性能：§5.1 审计查询（31 天窗口）P95 ≤ 2s（`requirements.md:400`）；M105 实测 20 万条语料、30 天窗口、30 次采样 P95 6.69ms、P50 4.22ms（`evidence/m105-audit-query-latency/audit-query-latency.json`），当前实现是内存线性扫描，语料再大一个数量级需索引/分页存储（test-plan.md:114）。
- 限流：审计查询 10 次/分钟/用户，时间窗 ≤31 天，必须分页（`design.md:1330`）。

### 1.3 现有下载与复制路径

| 动作 | 实现接缝 | 平台是否已见 |
| --- | --- | --- |
| 单文件下载（桌面） | `fs:downloadFile`（`src/main/ipc/filesystem/filesystem-download-handlers.ts:31`）；云会话经 `files.download` RPC | 宿主可见方法，但未落审计 |
| 文件夹下载（桌面） | `fs:downloadFolder`（`src/main/ipc/filesystem-download-folder.ts:51`）；云会话经 `files.downloadFolder` | 同上 |
| 终端产物导出 | `terminal.exportArtifact`（下载权限表 `src/main/cloud-platform/cloud-rpc-permission.ts:64-70`） | 宿主可见，未落成功审计 |
| 浏览器下载/另存 | `browser.download` / `browser.savePage`（同上） | 取决于宿主是否执行该方法 |
| Web 工作区下载 | paired web 的 `fs.downloadFile/downloadFolder` 直接抛「不支持」（`src/renderer/src/web/preload-api/web-filesystem-api.ts:62-71`）；当前 Web 工作区无 fs 下载入口 | 无可审计动作 |
| Web 剪贴板写入 | `writeWebClipboardText` 统一走 `navigator.clipboard.writeText`，失败回落 `execCommand`（`src/renderer/src/web/preload-api/web-clipboard-api.ts:98-112`） | 未上报 |
| 桌面剪贴板文本 | `clipboard:writeText` / `writeTerminalText` / `writeSelectionText`（`src/main/window/clipboard-ipc-handlers.ts:209-232`） | 未上报 |
| 桌面复制文件对象 | `clipboard:writeFile`（`clipboard-ipc-handlers.ts:180-206`；Web 侧明确不支持 `web-ui-api.ts:200`） | 未上报 |
| 编辑器/终端选区复制 | Monaco / xterm 走 Chromium 原生剪贴板，不经过上述 IPC；文件预览工具栏只有「复制路径」，没有「复制内容」 | 未捕获 |
| OS 层复制、截图、带外传输 | 本机 Finder/Explorer 或开发机 shell | 不可见 |

### 1.4 缺口清单（需求 vs 现状）

| 用户要求 | 现状 | 缺口 |
| --- | --- | --- |
| 所有下载留审计 | 只有拦截动作有 `download_blocked`（FR-9.12 一期）；成功下载没有事件；宿主上报词表只有 denied | 需新增 `file_download` 成功/失败/拒绝事件，并扩展宿主上报 |
| 文件内容复制留审计 | 无任何复制事件 | 需新增 `file_copy`，并在应用接缝埋点 |
| 按内容/关键字查复制记录 | 只能按 actor/eventType/result/traceId/起点时间等值过滤 | 需新增文件名/路径/关键字（含可选摘录）查询 |
| 时间/操作类型/用户/文件名四条件 | 只有起点时间、单值事件类型、精确 actor；无文件名 | 需补 `until`、事件族/多值、文件名、组合语义 |
| 结果可核对 | 审计页不展示文件名，关键字命中无高亮 | UI 原型与查询响应需带命中字段（交 UI/技术方案） |

### 1.5 既有约束（不得在本需求中静默推翻）

- **FR-8.6 / §5.4**：不记录终端内容、文件内容、AI 会话内容（`requirements.md:250,427`）。FR-9.16 的「可选摘录」是对该条的**显式、默认关闭的例外**，必须单列开关并默认不改变原语义。
- **C1**：平台不具备开发机文件内容解密能力，内容级 DLP 不可行（`requirements.md:458`）。
- **FR-7.3**：任意文件读取不阻断，仅限速与审计；剪贴板由客户端限制，服务端无法读取剪贴板（`requirements.md:233`）。
- **O3**：是否允许开发者把代码复制到剪贴板——默认允许文本、禁止超限二进制（`requirements.md:553`）。本需求只增加审计，不改变允许性。
- **FR-8.2**：审计只追加、保留 180 天、到期归档而非删除（`requirements.md:246`）。摘录一旦入链，不能按条删除。
- **FR-9.7**：审计查询仍限 admin / `platform:auditor`（`requirements.md:262`）。

---

## 2. FR-9.13 文件下载审计

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-9.13 | 每个经 Orca 执行的下载/导出动作必须落一条 `file_download` 审计事件，包含用户、时间、项目、文件名、项目内相对路径、大小、下载方法、结果、traceId 与主机标识；成功、失败、拒绝三种结果都记录。事件由执行该动作的宿主或客户端产生，平台入库后审计员可按用户/项目/文件名检索。 | P0 |

### 2.1 动作定义（什么算一次下载）

**计入**：

- 单文件下载：`files.download`（云会话 RPC）或桌面 `fs:downloadFile` 的远端/云分支，用户确认保存后宿主把字节交付给客户端。
- 文件夹下载：`files.downloadFolder`（或桌面 `fs:downloadFolder` 的远端分支），一次动作一条事件（`kind: folder`，附 `itemCount`/`totalBytes`，可选有界清单，见 OQ-4）。
- 终端产物导出：`terminal.exportArtifact` / `writeTerminalArtifact` 中会把内容保存到本地的分支（`kind: artifact`）。
- 浏览器下载/另存：宿主执行的 `browser.download` / `browser.savePage`（`kind: browser`）。纯客户端浏览器自行另存不可捕获，见 2.4。
- 被拒绝的下载尝试：策略禁止或权限不足导致 RPC 被拒，记 `result: denied`（与 FR-9.12/AC-39/AC-40 对齐）。
- 传输失败：用户取消保存、网络中断、宿主读取失败，记 `result: failure` 与 `reason`；用户取消是否记事件由技术方案裁定（OQ-5，建议记 failure 但不计入「成功下载」指标）。

**不计入**：

- 通过 `files.readChunk` / `files.readPreview` 逐步读取并在客户端重建文件——默认仍按 FR-7.3 的读取限速与 `file_read` 记账；是否在累计字节超过阈值时升级为下载等价事件，见 OQ-6。
- 开发机上的 `scp`/`git push`/`curl`/shell `cp` 等带外传输——平台不可见（C1）。
- 平台自身向浏览器下发管理台静态资源、日志导出（审计导出走 FR-8.5 的独立事件）。

**成功语义**：宿主能确认的是「已把字节交付给客户端」，不能确认用户最终保存到哪个本地路径、是否在保存对话框取消。因此 `result=success` 的准确含义是「宿主完成传输」，不是「本地文件已落盘」；`savedName`/本地保存失败只能由客户端补充上报（是否要求客户端补报见 OQ-5）。文档与 AC 必须按这个口径表述，避免审计员把宿主 success 误读为本地已保存。

### 2.2 事件字段

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `eventType` | `file_download` | 用户指定的名称 |
| `actor` | 人类用户名（如 `zhangsan`），不是 `host:*` | 宿主从云凭证 `sub` 取得；平台入库时归一化 |
| `targetType` / `targetId` | `project` / 项目 ID | 项目是最小审计单位 |
| `result` | `success` / `failure` / `denied` | 拒绝原因放 metadata |
| `traceId` | RPC 的 `x-trace-id`，没有则由宿主生成 | 与连接日志可关联（FR-8.4） |
| `ts` | 平台入库时间（链上时钟） | 与 `metadata.occurredAt` 区分，见 OQ-7 |
| `metadata.hostId` / `hostName` | 主机标识 | 定位执行宿主 |
| `metadata.projectKey` | 项目 key | 人可读 |
| `metadata.fileName` | 下载文件名（basename） | 用户要求的查询条件 |
| `metadata.path` | 项目内相对路径 | 不写开发机绝对路径（避免泄露主机布局，OQ-8） |
| `metadata.sizeBytes` | 实际传输字节数 | 文件夹为总字节 |
| `metadata.method` | `files.download` / `files.downloadFolder` / `terminal.exportArtifact` / `browser.download` / `browser.savePage` | 与 FR-7.4 对齐 |
| `metadata.kind` | `file` / `folder` / `artifact` / `browser` | 查询与展示用 |
| `metadata.surface` | `desktop` / `web` / `admin-embed` | 客户端形态 |
| `metadata.policy` | `allow` / `deny` | 当时的下载策略 |
| `metadata.reason` | 拒绝/失败码 | 如 `DOWNLOAD_POLICY_DENIED`、`PERMISSION_MISSING` |
| `metadata.occurredAt` | 宿主/客户端动作发生时间（epoch ms） | 补平台入库延迟；时钟偏差受 C8（≤60 秒）约束 |
| `metadata.itemCount` | 文件夹/多文件动作的条目数 | 可选 |
| `metadata.truncated` | 清单是否被截断 | 避免审计员误以为清单完整 |

可选字段（技术方案裁定）：`savedName`（用户另存为后的本地文件名）、`sha256`（下载内容指纹，需宿主额外读取/计算，成本见 OQ-9）、`clientVersion`。

### 2.3 用户故事

- **审计员（auditor）**：我在审计页按「用户 + 最近 7 天 + 操作类型=下载 + 文件名关键字」能查到某人下载过哪个项目里的哪个文件、多大、成功还是被拒绝；不再只能看到「被拦截」而看不到被允许的下载。
- **平台管理员（admin）**：我能向合规解释下载审计覆盖哪些方法、哪些形态；报告里不会把「没有记录」误读成「没有下载」——带外传输与 Web 端浏览器另存明确列为不可捕获面。
- **开发者（zhangsan）**：我正常下载被允许的文件时无需额外操作；审计只记录文件名、路径、大小，不记录文件内容（默认）。

### 2.4 验收标准（Given/When/Then）

- **AC-41 允许策略下的成功下载留痕**
  - Given 项目 P 的下载策略为允许，zhangsan 已打开 P 的桌面工作区
  - When 他从文件树下载 `src/config/app.ts` 并完成保存
  - Then 平台审计中出现且仅出现一条 `file_download` 事件：`actor=zhangsan`、`targetId=P`、`fileName=app.ts`、`path=src/config/app.ts`、`sizeBytes` 与实际一致、`method=files.download`、`result=success`、带 `traceId` 与 `hostId`；审计员在默认 10 秒心跳内（最迟 60 秒）可检索到
- **AC-42 拒绝与失败分别记录**
  - Given 项目 P 的下载策略为禁止
  - When 用户经任意客户端形态或裸 WebSocket 调用 `files.download`
  - Then 宿主拒绝并记一条 `result=denied` 的 `file_download`（`reason` 给出策略/权限原因），不产生 success 事件；既有 `download_blocked` 事件名（FR-9.12）与 `file_download` 的关系见 OQ-10，二者不得让同一动作被误读为两次下载
- **AC-43 平台不可达不静默丢失**
  - Given 宿主已产生下载事件时平台 API 不可达
  - When 平台恢复且宿主下一次心跳成功
  - Then 缓冲事件按发生顺序补投，`occurredAt` 保留原始动作时间；若宿主进程重启导致内存缓冲丢失，`/v1/audit/status` 或主机详情必须给出可见的缺口/告警，而不是让审计员误以为无事件
- **AC-44 不可捕获面如实声明**
  - Given 审计员查看下载审计的覆盖说明（文档或管理台提示）
  - When 他核对「为什么没有某次带外取文件的记录」
  - Then 说明中明确列出：开发机 shell/scp/git push/curl 等带外传输、纯客户端浏览器「另存为」、截图/录屏不在平台可见范围；不得宣称「所有文件外流均已审计」

---

## 3. FR-9.14 文件内容复制审计

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-9.14 | 每次可被应用捕获的文件内容复制动作必须落一条 `file_copy` 审计事件；事件至少包含用户、时间、项目、文件名、路径、复制面（Web/桌面/管理台内嵌）、复制类型（整文件/选区/文件对象）、复制长度或文件大小、结果与 traceId。Web 端以 `navigator.clipboard`/`execCommand` 接缝为准，桌面端以 `clipboard:writeText`/`clipboard:writeFile` 接缝为准；OS 层复制与截图/OCR 明确不可捕获，必须在覆盖说明中声明。 | P0（应用接缝）/ P1（选区捕获扩展） |

### 3.1 动作定义与可捕获面矩阵

「内容外流」在本需求中分三类，**各记各的事件，不重复计数**：

1. **下载/保存导出** → FR-9.13 的 `file_download`（不是 `file_copy`）。
2. **剪贴板复制** → FR-9.14 的 `file_copy`。
3. **带外/OS 层外流** → 不可捕获，只登记边界。

| 复制动作 | 发生面 | 可捕获？ | 捕获接缝（现状） | 审计落点 |
| --- | --- | --- | --- | --- |
| 应用内「复制」按钮复制文件内容 | Web / 桌面 / 管理台内嵌 | 是 | `writeWebClipboardText`（Web）、`clipboard:writeText`（桌面） | `file_copy`（`copyKind=content-whole` 或 `content-selection`） |
| 编辑器/预览选区复制（Monaco、DOM 选区） | 桌面 / Web | **部分**：当前未统一经过应用接缝；需补 `copy` 事件监听才能捕获 | 渲染进程 `document.copy` + `clipboardData`；跨域 iframe 不可见 | `file_copy`（`capturePoint=dom-copy-listener`，P1） |
| 终端选区复制 | 桌面 / Web | 部分：桌面有 `writeTerminalText`/`writeSelectionText`；Web 走 `writeWebClipboardText` | 同上 | 按 FR-8.6 **默认不记内容**；是否记 `file_copy`（只记长度/无内容）见 OQ-11 |
| 复制文件对象到剪贴板 | 桌面 | 是 | `clipboard:writeFile`（本地或远端暂存） | `file_copy`（`copyKind=file-object`） |
| 文件预览工具栏「复制路径」 | 桌面 / Web | 是 | 既有剪贴板接缝 | **不记** `file_copy`（复制的是路径字符串，不是文件内容；如需记可记 `copy_path`，本需求不要求） |
| Web 工作区浏览器面板内页面选区复制 | Web 浏览器 | 否（跨源/浏览器 UI） | — | 无 |
| Finder/Explorer 复制文件、拖拽到桌面 | 本机 OS | 否 | — | 无 |
| 第三方应用、截图、录屏、OCR | 本机 OS | 否 | — | 无 |
| 开发机内 shell `cp`/编辑器复制 | 开发机 | 否 | — | 无（C1） |

**默认语义**：`file_copy` 只记录「哪个文件的多少内容被复制到剪贴板」，**不记录复制出来的正文**；正文摘录是 FR-9.16 的可选开关（默认关闭）。

### 3.2 事件字段

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `eventType` | `file_copy` | |
| `actor` | 人类用户名 | 客户端已登录身份；平台侧校验 |
| `targetType` / `targetId` | `project` / 项目 ID | 复制必须绑定项目；游离文本（非文件）不产生本事件 |
| `result` | `success` / `failure` | 剪贴板写入失败也记录（`reason`） |
| `traceId` | 客户端生成的关联 ID | 与同一交互中的 RPC/连接日志关联 |
| `ts` | 平台入库时间 | 与 `occurredAt` 区分 |
| `metadata.fileName` / `path` | 被复制文件 | 文件名是查询条件 |
| `metadata.sizeBytes` | 文件大小（整文件/文件对象） | 选区复制可为空 |
| `metadata.copiedChars` / `copiedBytes` | 实际复制长度 | 选区复制时必填（按字符或 UTF-8 字节，二选一并固定） |
| `metadata.sha256` | 复制文本或整文件的指纹 | 不存正文也能识别重复复制；成本见 OQ-9 |
| `metadata.copyKind` | `content-whole` / `content-selection` / `file-object` | 区分复制面 |
| `metadata.surface` | `web` / `desktop` / `admin-embed` | |
| `metadata.capturePoint` | `web-clipboard-api` / `desktop-clipboard-ipc` / `dom-copy-listener` | 便于区分可信度 |
| `metadata.captureConfidence` | `instrumented` / `advisory` | 客户端自报事件标记为 advisory |
| `metadata.occurredAt` | 动作发生时间 | |
| `metadata.clientVersion` | 客户端版本 | 排查旧客户端未埋点 |

**不写**：正文、格式、剪贴板序列化结果；除非 FR-9.16 开关开启，此时只写有界 `excerpt`。

### 3.3 用户故事

- **审计员（auditor）**：我能按用户、时间、文件名关键字查出某人复制过哪些文件、复制了多少内容；我知道这是客户端自报的检测性证据，不会把它当作「复制行为百分之百被记录」的保证。
- **平台管理员（admin）**：我能向合规说清楚哪些复制面有审计、哪些没有；开启摘录时我知道这会记录正文片段并受 180 天保留约束。
- **开发者（zhangsan）**：正常复制代码不被阻断（O3 默认允许）；审计默认只记文件名/长度/指纹，不记我复制的代码内容。

### 3.4 验收标准（Given/When/Then）

- **AC-45 Web 应用接缝复制留痕**
  - Given zhangsan 在 orca web 工作区打开项目 P 的文件 `src/a.ts`
  - When 他通过应用内复制动作把文件内容写入剪贴板
  - Then 平台出现 `file_copy` 事件：`actor=zhangsan`、`fileName=a.ts`、`path=src/a.ts`、`copyKind`、`surface=web`、`capturePoint=web-clipboard-api`、`copiedChars>0`、`result=success`，最迟 60 秒内可查
- **AC-46 桌面剪贴板接缝与文件对象复制留痕**
  - Given zhangsan 在桌面客户端打开云项目 P
  - When 他使用应用内复制文本、或在文件树执行「复制文件」把文件对象放入剪贴板
  - Then 分别产生 `file_copy` 事件（`copyKind=content-*` / `file-object`，`surface=desktop`）；Web 端执行文件对象复制返回不支持时不产生事件，也不得伪造成功
- **AC-47 不可捕获面与可信度声明**
  - Given 审计员查看复制审计的覆盖说明
  - When 他核对 Finder/Explorer 复制、跨源 iframe、截图/OCR、开发机 shell 复制
  - Then 说明中逐项列出「不可捕获」；客户端自报事件在响应或 UI 中带 `captureConfidence=advisory` 标识，文档明确「审计链保证记录不被篡改，不保证记录完整」
- **AC-48 复制失败也留痕（防静默）**
  - Given 浏览器拒绝剪贴板权限或桌面 IPC 写入失败
  - When 用户触发复制
  - Then 产生 `result=failure` 的 `file_copy`（或至少客户端日志 + 平台可见的失败计数），不得静默吞掉；具体落点由技术方案裁定（OQ-12）

---

## 4. FR-9.15 审计查询增强

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-9.15 | 审计查询支持时间范围（起止）、操作类型（单值/多值/事件族）、用户、下载文件名四个条件任意组合（AND），并支持按文件名、项目内路径、用户/主体与可选摘录做不区分大小写的关键字查询；结果保持 `cursor` 分页、31 天窗口上限与既有 P95 ≤2s 预算，且对旧客户端保持既有参数兼容。 | P0（四条件 + 名称类关键字）/ P1（摘录关键字） |

### 4.1 查询条件语义

| 条件 | 参数（建议） | 语义 | 现状缺口 |
| --- | --- | --- | --- |
| 时间 | `since`、新增 `until` | 闭开/闭闭区间由技术方案定；最长 31 天；默认最近 7 天（与 AC-13 口径一致） | 只有 `since` |
| 操作类型 | `eventType`（保持）+ 新增 `eventTypes`（逗号分隔）或 `eventFamily` | 单值保持现有行为；多值为 OR；`eventFamily=download` 映射 `file_download`（及遗留 `download_blocked`），`eventFamily=copy` 映射 `file_copy` | 只有单值 |
| 用户 | `actor`（保持）+ 可选 `subject`/`username` | 精确匹配优先；是否支持用户名子串见 OQ-13；宿主事件必须按人类用户可查（见 1.1 缺口） | 宿主事件 actor=`host:*`，按用户查不到 |
| 下载文件名 | 新增 `fileName` | basename，不区分大小写子串匹配；至少 1 字符；作用于 `metadata.fileName` | 无 |
| 关键字 | 新增 `q` | 不区分大小写子串，匹配 `metadata.fileName`、`metadata.path`、`actor`/主体；开关开启时匹配 `metadata.excerpt`；不做正则/通配符；长度 2..128（中文按字符计） | 无 |
| 结果 | `result`（保持） | success/failure/denied | 已有 |
| 项目/主机 | 新增 `projectId`/`hostId`（补 FR-8.3 承诺） | 等值 | 已承诺未实现 |
| traceId | `traceId`（保持） | 精确 | 已有 |
| 分页 | `cursor`、`limit`（1..200） | 保持新→旧顺序；游标不跳页、不重复 | 已有 |

**组合规则**：不同条件之间 AND；同一条件多值之间 OR；关键字与文件名同时出现时两者都需满足（AND）。空字符串视为未提供。非法/超长参数不返回全量（沿用 U57 U8 的钳制/400 策略，具体见 OQ-14）。

### 4.2 关键字查询的字段与规模

- **默认（FR-9.16 摘录关闭）**：只查 `fileName`、`path`、`actor`/主体、`projectKey`。这是「按文件名/路径/用户」的关键字查询，不涉及文件正文。
- **开启摘录后**：额外查 `metadata.excerpt`。只能命中已存的有界前缀，不能承诺全文检索；超过摘录上限的内容不可查（必须在 UI/文档声明）。
- **不查**：任意其他 metadata（如 `reason`、`denial`），避免把错误描述中的路径/关键字误命中或泄露。
- **规模**：M105 的 20 万条语料是性能基线；关键字查询若引入全表扫描 + 子串匹配，需在同语料上重新测量（AC-50）。建议技术方案评估 PostgreSQL `pg_trgm`/GIN 或内存倒排；不得以「语料小」为由跳过预算验证。

### 4.3 用户故事

- **审计员（auditor）**：我在一个表单里填「时间范围=近 7 天、操作类型=下载+复制、用户=zhangsan、文件名=a.ts」，一次得到完整结果；也可以只填关键字 `payment`，查文件名/路径里含它的复制与下载记录。
- **审计员（auditor）**：我查 30 天窗口时结果仍在 2 秒内返回；翻页不会重复或漏事件。
- **平台管理员（admin）**：旧版 Web 前端仍能用 `actor/eventType/result/traceId/since/limit/cursor` 正常查询，不会因新增参数白屏或 400。

### 4.4 验收标准（Given/When/Then）

- **AC-49 四条件组合精确命中**
  - Given 审计库中存在多个用户、多个项目、多种事件类型、多个时间段的记录
  - When 审计员以 `since=近 7 天&until=now&eventTypes=file_download,file_copy&actor=zhangsan&fileName=a.ts` 查询
  - Then 返回集合恰好是同时满足四项条件的记录，无多返、无漏返；分页走完与单次查询的集合一致（对齐 AC-13 的翻页完整性）
- **AC-50 关键字与文件名语义**
  - Given 存在 `fileName=PaymentService.java`、`path=src/pay/PaymentService.java`、用户 `zhangsan` 的复制与下载事件
  - When 审计员分别以 `q=payment`、`fileName=payment`、`q=PAYMENT` 查询
  - Then 均命中且结果一致（不区分大小写）；`q` 长度为 1 或超过 128 时按约定拒绝/提示；`q` 中的 `%`/`_`/正则元字符按字面处理；空 `q` 不改变结果集
- **AC-51 查询性能预算**
  - Given 审计语料 ≥20 万条、覆盖 30 天，其中复制/下载事件 ≥2 万条，走真实 API 进程与真实 HTTP
  - When 以 31 天窗口执行四条件查询与关键字查询各 30 次采样
  - Then P95 ≤ 2s（对齐 §5.1 与 M105；M105 基线为 20 万条等值查询 P95 6.69ms）；注入固定延迟的对照必须让断言转红；查询限流仍为 10 次/分钟/用户
- **AC-52 兼容与上限**
  - Given 旧版 Web 前端只发送既有参数
  - When 查询 31 天内数据
  - Then 行为不变；发送超过 31 天的 `since` 仍返回 400 `TIME_WINDOW_TOO_LARGE`；`limit=0/-1/abc` 仍回落默认 50 且不超过 200；新增参数对旧审计写入者/旧平台不产生破坏（混合版本见 OQ-15）

---

## 5. FR-9.16 隐私与体积权衡

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-9.16 | 下载与复制审计默认**不记录文件正文**：metadata 只保存文件名、项目内路径、大小/复制长度、sha256 指纹与必要的动作字段。可选「内容摘录」是全局配置开关，**默认关闭**；开启后只对文本文件保存有界前缀（建议 ≤1KB，具体由技术方案裁定），二进制/图片不摘录，摘录随事件入链并受 FR-8.2 的 180 天保留约束；关键字查询仅在开关开启时作用于摘录。 | P0（默认关闭）/ P1（开关与摘录查询） |

### 5.1 建议的 metadata 最小集

| 字段 | 是否默认 | 用途 |
| --- | --- | --- |
| `fileName` | 是 | 文件名查询、审计展示 |
| `path` | 是 | 路径关键字查询、定位 |
| `sizeBytes` / `copiedChars` / `copiedBytes` | 是 | 体量判断、异常复制识别 |
| `sha256` | 建议默认（成本允许时） | 重复复制/同文件识别，不暴露正文 |
| `mime` / `isBinary` | 建议 | 决定是否允许摘录 |
| `excerpt` | **否（开关）** | 仅文本、有界前缀、带 `truncated` 标记 |
| `excerptBytes` / `excerptSha256` | 随摘录 | 体积与完整性 |

### 5.2 体积估算（给技术方案做容量判断，非承诺值）

- 复制事件频率高于下载：500 开发者 × 每人每日 20~100 次复制 ≈ 1 万~5 万条/日；单事件 metadata（不含摘录）约 0.3~1KB，180 天约 0.5~9GB 量级。
- 开启摘录（≤1KB）后，最坏情况每日增加 5 万 × 1KB ≈ 50MB，180 天 ≈ 9GB；若摘录上限放大到 8KB 则接近 72GB。索引成本另计。
- 结论：**默认关闭摘录时体积可控；摘录开关必须带容量预算与上限，不能按「全文」设计**。

### 5.3 验收标准（Given/When/Then）

- **AC-53 默认不存正文**
  - Given 摘录开关为默认关闭
  - When 用户复制或下载任意文本/二进制文件
  - Then 审计事件的 metadata 中不出现文件正文或可还原正文的字段；只出现文件名、路径、长度、指纹等；对 metadata 做字符串检查不得命中测试文件中的敏感标记串
- **AC-54 摘录开关的边界**
  - Given 管理员开启摘录且上限为 N 字节
  - When 用户复制一个大于 N 的文本文件、以及一个二进制文件
  - Then 文本事件带不超过 N 字节的 `excerpt` 与 `truncated=true`；二进制事件不带 `excerpt`；关键字查询能命中摘录中的词，但不能命中摘录之外的词（文档明确此限制）
- **AC-55 只追加与保留**
  - Given 某条事件已带摘录入链
  - When 到达 180 天保留期或收到删除请求
  - Then 按 FR-8.2 归档/保留策略处理，不能对单条事件做选择性改写或删除；如合规要求删除正文，只能按整体归档/销毁策略执行（与 OQ-16 一并裁定）

---

## 6. 优先级与分期建议

| 期 | 范围 | 优先级 | 出口条件 |
| --- | --- | --- | --- |
| 一期（P0） | FR-9.13 全量可捕获下载面；FR-9.14 应用接缝（Web `writeWebClipboardText`、桌面 `clipboard:writeText`/`writeFile`）；FR-9.15 四条件 + `until` + `fileName` + 名称/路径/用户关键字；FR-9.16 默认不存正文 | P0 | AC-41 ~ AC-47、AC-49 ~ AC-53 通过；不可捕获面文档/提示就位（AC-44/AC-47） |
| 二期（P1） | FR-9.14 选区复制捕获（DOM `copy` 监听，标记 advisory）；文件夹下载有界清单；FR-9.15 摘录关键字；FR-9.16 摘录开关、上限、容量预算、查询自审计 | P1 | AC-48、AC-54 ~ AC-55 通过；性能在开启摘录后重新测量仍满足 P95 ≤2s |
| 三期（P2，另立项） | 内容级 DLP、终端复制审计、跨归档检索、异常复制行为分析 | P2 | 不在 U66 范围；C1 未解除前不做内容级阻断 |

**依赖**：一期依赖宿主上报通道扩展（成功事件与 `file_download`/`file_copy` 词表）与平台入库 actor 归属改造；二期依赖查询索引/存储选型。两项均在技术方案中裁定。

**建议的落地顺序**：先做「平台查询面 + 事件模型」（可用合成事件验证 AC-49/50/51），再接入宿主下载事件（AC-41/42），最后接入客户端复制事件（AC-45/46）。这样查询与性能预算先被锁死，后续埋点只做数据生产，不反复改查询契约。

---

## 7. 开放问题（交技术方案裁定）

| 编号 | 问题 | 影响 | 建议/倾向 |
| --- | --- | --- | --- |
| OQ-1 | 摘录开关的粒度与权限：全局 / 项目级 / 用户级？谁能开？ | 隐私、合规、实现复杂度 | 全局 + 项目级 opt-in，仅平台管理员可开；默认关闭；不做用户级 |
| OQ-2 | 摘录上限、编码与格式：多少字节？按行还是按字符截断？是否保留换行？ | 体积、关键字命中率 | UTF-8 字节上限（建议 1KB），按字符边界截断，保留换行并标 `truncated`；二进制/图片不摘录 |
| OQ-3 | 关键字查询的索引方案：内存线性扫描 / PostgreSQL `pg_trgm` / 倒排；180 天归档是否可查 | 性能预算、存储成本 | 一期沿用线性扫描并在 20 万条语料验证；二期上索引；归档检索另立项 |
| OQ-4 | 文件夹下载粒度：一次动作一条事件，还是每个文件一条？文件名查询如何覆盖文件夹内文件？ | 事件体积、文件名查询完整性 | 一次动作一条 + `itemCount`/`totalBytes` + 有界清单（如首 100 个文件名）；超出部分在 UI 标「清单截断」 |
| OQ-5 | 宿主只知传输完成、不知本地保存结果：是否需要客户端补报 `savedName`/保存失败？用户取消保存、传输失败如何记？ | 审计语义、指标口径、跨进程可靠性 | 宿主记「传输完成」；客户端可选补报本地保存结果（同 `traceId` 关联，不新增第二条下载事件）；取消/失败记 `failure` + `reason`；不得把宿主 success 展示为「已保存」 |
| OQ-6 | `files.readChunk` 累计读取重建整文件，是否升级为「下载等价」事件？ | 漏审风险、读取限速语义 | 达到「文件大小」或阈值时记一条 `file_download`（`method=files.readChunk`，`result=success`），与 FR-7.3 的限速并行；避免与单次读取重复计数 |
| OQ-7 | 时间语义：`ts` 用平台入库时间，动作时间放 `occurredAt`；查询条件按哪个过滤？ | 窗口边界、时钟偏差（C8） | `ts` 保持链上平台时钟；`occurredAt` 仅展示与辅助过滤；查询默认按 `ts`，文档说明投递延迟 |
| OQ-8 | 路径是否写开发机绝对路径？ | 主机布局泄露、定位精度 | 只写项目内相对路径 + `projectId`；绝对路径仅管理员按需展开（如需） |
| OQ-9 | `sha256` 的计算成本与时机：下载/复制时是否值得计算？选区复制如何算？ | 宿主/客户端 CPU、事件延迟 | 下载产物与整文件复制建议算；选区复制对复制文本算；成本高时先只记长度，指纹列为可选 |
| OQ-10 | 事件命名：`file_download` 与既有 `download_blocked` 的关系；`file_copy` 是否用 `content_copy` | 查询兼容、既有 AC-39/40 | `file_download` 为规范事件（success/failure/denied 三态）；`download_blocked` 保留为遗留别名或映射到 `file_download result=denied`，一个动作只落一条；`file_copy` 固定 |
| OQ-11 | 终端内容复制是否纳入 `file_copy`？ | FR-8.6 冲突、审计完整性 | 本需求不纳入；如纳入只记长度/时间/会话，不记内容，另立 FR 并显式修订 FR-8.6 |
| OQ-12 | 复制失败（剪贴板权限拒绝）是否必须落平台事件？ | 噪声、隐私、实现成本 | 一期可只记客户端本地失败 + 平台失败计数；二期再决定是否入链 |
| OQ-13 | 用户条件是否支持显示名/用户名子串？ | 查询易用性、索引 | 一期保持 `actor` 精确 + `q` 可匹配用户名子串；显示名需平台用户目录 join，二期再定 |
| OQ-14 | 非法/超长查询参数的策略：钳制（U57 U8 兼容）还是 400？ | 旧客户端兼容、查询成本 | `limit` 沿用钳制；`q`/`fileName` 超长或非法返回 400 + 明确错误码；空值视为未提供 |
| OQ-15 | 混合版本：新宿主向旧平台上报 `file_download`/`file_copy` 会被静默丢弃（旧 `parseReport` 只认三种 denied 类型） | 远程 wire 兼容、升级窗口漏审 | 宿主按平台版本/能力决定是否上报新类型；或新类型只在新平台上线后启用；不得让旧平台 500；需在技术方案给出能力协商与回归 |
| OQ-16 | 摘录与删除权/合规保留的冲突：入链不可改，如何处理正文删除请求？ | 合规、法律风险 | 默认不存；开启前需合规确认「摘录 180 天不可删」；必要时按整体归档销毁，不做单条改写 |
| OQ-17 | 审计查询本身是否留痕（尤其带 `q`/摘录查询）？ | 审计问责、内容二次泄露 | 建议记录 `audit_query`（含过滤条件摘要、结果数、不含原始关键字或关键字哈希），与 FR-8.5 导出审计同族；具体待裁定 |
| OQ-18 | FR-8.3 承诺的项目/主机筛选当前未实现，是否纳入本需求一期？ | 查询完整性、范围蔓延 | 建议纳入 FR-9.15（成本低、审计员刚需）；若不纳入需在文档登记为已知缺口 |
| OQ-19 | 宿主事件的 actor 归属：平台按 `deviceId` 反查用户，还是采用宿主上报的 `subject`（`user:<username>`）并去掉前缀？既有 `host.*` 事件是否回填？ | 按用户查询、历史数据一致性、身份可信度 | 平台以已认证的 `deviceId` 反查 `users` 更可信；`subject` 作为交叉校验；新事件 `actor=用户`、`metadata.hostId/hostName` 保留宿主；历史事件不回填，查询时对 `host.*` 做 actor 映射或明确只查新事件 |


---

## 8. 与既有 FR/AC 的交叉引用（增量修订，不改原正文）

| 既有条目 | 关系 |
| --- | --- |
| FR-8.1 | 事件清单扩展 `file_download`、`file_copy`；下载拦截事件与成功下载同族 |
| FR-8.2 | 摘录入链后同样只追加、180 天保留；不支持单条删除（FR-9.16） |
| FR-8.3 | 查询条件从「时间/用户/项目/主机/事件类型/结果」扩展文件名与关键字；项目/主机筛选的实现缺口在 OQ-18 登记 |
| FR-8.4 | `traceId` 继续作为下载/复制事件与连接日志的关联键 |
| FR-8.5 | 审计导出仍单独审计；关键字查询本身是否留痕见 OQ-17 |
| FR-8.6 | 默认不记录文件内容不变；FR-9.16 是可选的、默认关闭的显式例外 |
| FR-7.3 / FR-7.4 | 下载拒绝字段（user/project/path/size/method/result/traceId）与 `file_download` 对齐；读取仍不阻断，仅限速与审计 |
| FR-9.12 | 一期 `download_blocked` 纳入 `file_download` 口径；二期宿主硬拦的拒绝事件沿用同一事件模型（OQ-10） |
| §5.1 | 审计查询 P95 ≤2s 的 31 天窗口预算同样适用于新增条件与关键字查询（AC-51） |
| §5.4 / C1 | 不做内容级 DLP；带外传输不可见，必须在覆盖说明中声明 |
| O3 | 复制默认允许文本；本需求只增加审计，不改变允许性 |
| FR-9.7 | 审计查询权限不变：admin / `platform:auditor` |

---

## 9. 需求自查清单（交付评审用）

- [ ] 每个 FR 都有用户故事与 Given/When/Then AC，且 AC 可被真实 e2e 验证（含真实 API/宿主/客户端形态）。
- [ ] 明确回答「谁/何时/哪个项目/文件名/路径/大小/结果」，并给出字段级定义。
- [ ] 明确区分「下载 / 保存导出 / 剪贴板复制」三类内容外流，不重复计数。
- [ ] 可捕获面与不可捕获面逐项列出；未把客户端自报事件宣称为完整审计。
- [ ] 查询四条件组合语义、关键字匹配字段、长度/大小写/特殊字符规则明确。
- [ ] 性能预算对齐 §5.1 与 M105（20 万条、31 天、P95 ≤2s），并有负向对照。
- [ ] 隐私默认值明确（不存正文），摘录开关默认关闭、上限、保留与删除冲突已列为开放问题。
- [ ] 混合版本与旧客户端兼容有交代（宿主上报、查询参数）。
- [ ] 所有未决技术选择进入第 7 节，未在需求层偷做实现决定。
