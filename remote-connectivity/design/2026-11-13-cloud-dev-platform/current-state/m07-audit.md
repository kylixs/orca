# M7 审计（查询 / 结果表 / 事件详情 / 缺口状态 / 权限）

> 基线提交：`664a91e0322`（2026-11-16 工作区快照；工作树 U106-R3 未提交改动不影响审计页）。
> 前端：`cloud-platform/apps/web/app.js`（`renderAudit` 及审计辅助函数，约 L2077-2537；样式 `cloud-platform/apps/web/styles.css` L914-1040）。后端：`cloud-platform/apps/api/src/server.ts`（`GET /v1/audit/events`、`/v1/audit/status`、`/v1/audit/verify`，约 L3660-3825）。

## 1. 页面/界面布局

路由 `#/audit`，面包屑「审计日志」。

- **页头**：标题「审计日志」；副标题「查询身份、连接、文件下载与复制、下载拦截与管理操作事件。只追加、哈希链校验；保留 180 天，查询时间窗最大 31 天。已显示 N 条。」
- **缺口横幅**（条件渲染，`#auditGapWarning`）：任一宿主有缺口或任一计数非零时显示 `.note.warn`：「审计缺口：H 台主机有缺口；宿主上报 dropped a / suppressed b / rateLimited c；平台入口 dropped d / suppressed e / rateLimited f。缺口可见性为 best-effort，宿主瞬时崩溃无法精确检测。」
- **覆盖范围折叠块**（`details.audit-coverage`）：summary「覆盖范围与限制（审计链保证记录不被篡改，不保证记录完整）」，展开含四段：可捕获、不可捕获、缺口、可信度（host-attested / client-declared=advisory / inferred）。
- **查询栏**（`.audit-filter`）：12 列网格、三行（U86）：
  - 行 1：关键字（span4）、时间范围（span2）、起始时间（span2）、结束时间（span2）、操作类型（span2）= 12；
  - 行 2：用户（span3）、项目（span3）、主机（span3）、文件名（span3）= 12；
  - 行 3：结果（span3）+ 操作区（span9，右对齐「查询」primary /「清除」）。
  - 响应式：≤1100px 6 列（关键字/操作区各跨 6，其余跨 3）；≤700px 2 列（全部跨 2）。
  - 控件占位/选项：
    - 关键字 `#auditKeyword`：「关键字：类型 / 路径 / 文件名 / 账号 / 项目（2–128 字符）」；
    - 时间范围 `#auditRange`：最近 24 小时 / 最近 7 天（默认）/ 最近 31 天；
    - 起始/结束 `#auditSince` / `#auditUntil`：`datetime-local`；
    - 操作类型 `#auditType`：全部操作 + 两个族（「下载族 · 下载 + 拦截」family:download、「复制族 · file_copy」family:copy）+ 服务端 `eventTypes` 目录逐项（无目录的旧平台回退 14 项内置列表）；
    - 用户 `#auditActor`：「用户（域账号，精确）」；
    - 项目 `#auditProject`：全部项目 + `GET /v1/projects` 可见项目；
    - 主机 `#auditHost`：全部主机 + 未吊销主机；
    - 文件名 `#auditFileName`：「文件名（1–128 字符）」；
    - 结果 `#auditResult`：全部结果 / 成功 / 失败 / 拒绝。
- **错误横幅**（`p.inline-error#auditError`，默认 hidden）：两类文案——客户端校验错误（不发请求）与「查询失败：<原因>（下方为上次查询结果）」。
- **结果表**（8 列）：`时间` / `用户` / `操作` / `项目` / `主机` / `文件 · 大小` / `结果` / `详情 / traceId`。
  - 时间：`new Date(ts).toLocaleString('zh-CN')`；
  - 操作：文件类带前置徽标（下载 / 复制 warn / 拦截 danger）+ 事件类型等宽；`captureConfidence` 追加徽标：主机确认（ok）/ 推断 / 客户端自报 · advisory（warn）；
  - 项目列显示 `targetId`；
  - 主机列显示 `metadata.hostName ?? metadata.hostId`；
  - 文件列：文件名（可点击，点击复制路径）+ 小字 meta（大小 / 复制字符数与字节数 / 路径，长路径省略）；
  - 结果：`✓ 成功`（ok）/ `✕ 失败`（danger）/ `⛔ 拒绝`（warn）；
  - 详情列：traceId 文本 + 「复制」按钮；`file_copy` 行额外「展开/收起」。
- **展开行**（仅 `file_copy`，`tr.audit-expand-row[hidden]`，colspan 8）：左「复制内容摘录」（有 excerpt 展示，无则「未记录内容摘录（仅保留指纹）」）；右「内容指纹与复制长度」：`sha256:<hash 或 —>`、`复制 X 字符 / Y 字节`、灰字「仅记录指纹，不可反推内容」。
- **加载更早**：存在 `nextCursor` 时显示「仅显示最近 50 条，还有更早记录。」+「加载更早」按钮。
- **空态**：单行 `colspan="8"`「没有符合筛选条件的审计事件」。
- **链健康与容量**（`details#auditHealth`，只读）：`chain.ok/lastSeq`、容量今日/累计与 daily/total envelope、`persisted`；「校验审计链」按钮内联展示 200/409 结果（U136③）。
- **无**：导出、保存查询、列排序、每页条数切换、自动刷新。

## 2. 菜单与入口

- 侧栏「审计日志」按钮：`platform:admin` 与 `platform:auditor` 均可见；developer 隐藏。
- 直达 `#/audit`：`routeAllowed('audit') = canViewAudit()`；developer → 「无权访问」页（保留 URL），不发审计查询。
- auditor 登录：管理分组只显示审计入口（hosts/relays/users/settings 全部 hidden）；crumb「审计日志」；`#roleChip`「审计员」。
- 权限门槛（API）：`/v1/audit/events`、`/v1/audit/status`、`/v1/audit/verify` 均要求 admin 或 `platform:auditor`；拒绝写 `audit_query` / `audit_verify` denied。

## 3. 操作清单

| #    | 触发                           | 结果                                                                                                                                                  | 弹窗/确认 | 失败态                                                                                                          |
| ---- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| 3.1  | 打开 `#/audit`                 | 并行四请求：`GET /v1/audit/events`（默认 range=168，limit=50）、`/v1/audit/status`、`/v1/projects`、`/v1/hosts`；events 必须成功，其余失败降级为 null | 无        | 首屏 events 失败 → 「加载失败」+「重试」                                                                        |
| 3.2  | 修改任一条件 → 点「查询」      | 读取 10 个控件；先客户端校验；通过后写 `state.auditFilter`、清空累积与 cursor、重新查询                                                               | 无        | 校验失败：`#auditError` 显示原因且**不发请求**；服务端拒绝：横幅「查询失败：…（下方为上次查询结果）」，旧行保留 |
| 3.3  | 点「清除」                     | `state.auditFilter={}`、清空事件/cursor、重新查询（回到默认 7 天）                                                                                    | 无        | 同 3.2                                                                                                          |
| 3.4  | 点「加载更早」                 | 以 `nextCursor` 追加下一页（每页 50），不与新查询混表                                                                                                 | 无        | 服务端失败：横幅提示，已显示行保留                                                                              |
| 3.5  | 点文件按钮                     | 复制 `metadata.path`（缺省 fileName）到剪贴板 + toast「已复制」                                                                                       | 无        | 剪贴板不可用静默                                                                                                |
| 3.6  | 点 traceId「复制」             | 复制 traceId + toast「已复制」                                                                                                                        | 无        | 同上                                                                                                            |
| 3.7  | 点 `file_copy` 行「展开/收起」 | 切换隐藏行；不重新查询；摘录/指纹/长度展示                                                                                                            | 无        | 无                                                                                                              |
| 3.8  | 关键字/文件名查询              | 服务端按字面量匹配，命中内容在文件名、路径、摘录中以 `<mark class="audit-hit">` 高亮；大小写不敏感                                                    | 无        | 无                                                                                                              |
| 3.9  | 选择预设「最近 31 天」         | 客户端钳到 31 天 − 5 分钟，并把 `until` 钉在同一客户端时钟，避免服务端钟漂移触发 400                                                                  | 无        | 真被服务端拒绝时走 3.2 的服务端错误横幅                                                                         |
| 3.10 | 手动 since/until               | 显式边界优先于预设；结束早于开始、超 31 天、非法日期均前端拦截                                                                                        | 无        | 横幅错误，不发请求                                                                                              |
| 3.11 | 连续快速查询                   | `auditQueryGeneration` latest-wins：被取代的请求不落 state、不渲染，避免重复累积/条件混表                                                             | 无        | 被取代的失败也静默丢弃                                                                                          |
| 3.12 | 审计链/缺口查看                | 缺口横幅可见；「链健康与容量（只读）」展示 `chain.ok/lastSeq`、容量今日/累计与 envelope、`persisted`；「校验审计链」调用 `/v1/audit/verify` 并内联展示 200/409 结果 | 无        | 校验失败/链断裂：内联「链已断裂：seq X」或错误文本，不阻断页面                                                   |

查询参数（`auditQueryParams`）：`limit=50`、`q`、`eventFamily`（族）或 `eventType`（单类型）、`username`、`fileName`、`result`、`projectId`、`hostId`、`since`/`until`（ISO）、`cursor`。
客户端校验（`auditFilterError`，与 API 门限对齐）：`q` 长度 2–128；`fileName` ≤128；起始/结束必须可解析；结束不得早于开始；窗口 >31 天拒绝；只给 since 且距今 >31 天拒绝。

## 4. 数据来源

- `GET /v1/audit/events?<conditions>` → `{ events: AuditEvent[], nextCursor }`；事件字段：`seq/ts/actor/eventType/targetType/targetId/result/traceId/metadata`。
- `GET /v1/audit/status` → `{ ok?, lastSeq?, chain:{ok,lastSeq}, gaps:{hostsWithGap,droppedTotal,suppressedTotal,rateLimitedTotal,lastGapAt}, capacity:{fileEventsToday,fileEventsTotal,dailyEnvelope,totalEnvelope,overDailyEnvelope,...}, ingressGaps:{droppedTotal,suppressedTotal,rateLimitedTotal,lastGapAt}, persisted, eventTypes:[...] }`。
  - 页面实际消费：`eventTypes`（操作类型下拉）、`gaps` + `ingressGaps`（缺口横幅）、`chain`/`capacity`/`persisted`（链健康与容量只读区块，U136③）。
- `GET /v1/audit/verify` → 200 `{ok:true, checked, tip}` / 409 `{ok:false, checked, brokenAtSeq}`，并把 `audit_verify` 写入链；控制台「校验审计链」按钮消费两种结果（U136③）。
- `GET /v1/projects`、`GET /v1/hosts`：仅用于项目/主机筛选下拉；`/v1/hosts` 对 auditor 403、`/v1/projects` 对 auditor 只返回其有 `open` 授权的项目（通常为空），空列表时下拉显示解释选项（U136③）。
- 审计链来源：平台 audit writer（单写者哈希链）；`host.audit_gap` 由宿主心跳 delta 落链（U71）。
- **持久化（2026-11-16）**：dev 平台启用 `AUDIT_LOG_PATH` 追加式审计文件，重启后 `prevHash` 续接（实测 `verify ok:true` 跨 `--platform-only` 重启）；事件字段 `actor/targetType/targetId/traceId` 合法可为 null（U133 修校验器，此前该类事件会被误判 corrupt）。

## 5. 已知缺陷与观察

已登记：

- **U66**（🟢）审计增强族：file_download/file_copy/download_blocked 事件语义、查询条件、UI 原型与验收；残余切片缺口见 U70。
- **U71**（🟢）宿主 auditGap 心跳 delta：同值不刷屏、变化落增量、重启 pending 只记一次。
- **U72**（🟢）审计员 Web 门禁：routeAllowed 角色感知，auditor 仅审计入口；目录 API 仍 admin-only。
- **U73**（🟢）查询并发竞态：generation latest-wins，双击/清除后立刻查询不再混表。
- **U78**（🟢）操作类型静态枚举缺接入类事件：改为 `/v1/audit/status.eventTypes` 派生 + 旧平台 fallback；q 白名单扩展。
- **U86**（🟢）查询条件排版：12 列三行网格 + 1100/700 断点；删除底部提示文字，31 天文案移入页头。
- **U97**（🟢）「最近 31 天」边界越界 + 错误不展示：预设钳 31 天 − 5 分钟并钉 until；错误横幅恢复并标注「下方为上次结果」。
- **U74**（⚪）`file_copy` 摘录分支经真实入口不可达（二期开关契约）；`download_blocked` 恒标 advisory（契约如此）。
- **U114-D4**（⚪，覆盖缺口）U86 几何断点仅一次性截图，无自动化回归。

未登记观察（建议登记）：

1. ~~审计链健康与容量水位无 UI、verify 无入口~~ **已由 U136③ 实现**：只读链健康/容量区块 +「校验审计链」按钮（T32 U72-5）。
2. ~~auditor 的「项目」「主机」下拉为空且不说明原因~~ **已由 U136③ 实现**：空列表显示「无可见项目（需 open 授权）」「无可见主机（需主机权限）」（T32 U72-4）。
3. 缺口横幅只统计宿主上报与平台入口计数，不区分「本次查询窗口」与「全量历史」。
4. 时间范围「最近 7 天（默认）」在显式 since/until 存在时被忽略，界面无提示。

## 6. 测试覆盖

已覆盖（绝对路径）：

- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/u66-5-audit-ui.e2e.test.ts`：四条件组合、摘录关闭时 q 不命中正文、file_copy 展开摘录/指纹/长度、无摘录占位、download_blocked 拦截/拒绝徽标、31 天预设与超限前端拦截不发请求、31 天预设留缓冲、服务端拒绝可见且旧行保留、后续成功清横幅、非 admin events/status 均 403。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/u66-2-audit-query.e2e.test.ts`：四条件矩阵、fileName/q 大小写与白名单/长度、eventTypes 多值 OR / family / 显式优先、边界与 31 天窗、旧客户端零回归、status 权限与缺口/容量、U78 接入类事件检索、P95 性能抽测。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/u66-audit-file-events.e2e.test.ts`：三类事件落链、120 条/分钟限速与缺口、同 traceId 合并、畸形字段拒绝、内部/非云会话不写链、excerpt 丢弃与移动端字段。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/u71-audit-gap-heartbeat.e2e.test.ts`：同值不刷屏、变化落增量、重启 pending 记一次。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/u72-u73-audit-role-race.e2e.test.ts`：审计员入口/页面渲染、管理员不回退、开发者 403、双击查询与清除后查询的 latest-wins、auditor 空下拉解释（U72-4）、链健康/容量区块与校验按钮成功/409（U72-5，U136③）。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/audit-verify.e2e.test.ts`：链校验 200/409、校验动作入链、非授权 403（API 层）。
- `/Users/gongdewei/work/projects/orca/cloud-platform/test/e2e/audit-fail-closed.e2e.test.ts`、`audit-writer.e2e.test.ts`、`audit-writer-standby.e2e.test.ts`、`audit-anchor.e2e.test.ts`、`audit-query-latency.e2e.test.ts`、`audit-trace-window.e2e.test.ts`：写失败 fail-closed、单写者/备用、锚点、延迟、trace 窗口。
- 证据：`/Users/gongdewei/work/projects/orca/cloud-platform/evidence/u66-5-audit-ui/`、`.../u66-2-query/`、`.../u71-audit-gap/`、`.../u72u73-fix/`、`.../m31-audit-verify/`、`.../u66-final-reverify/`；U86 前后截图与文字提取在 `/Users/gongdewei/work/projects/orca/evidence/u86-fix/`（audit-before/after-layout.json 含控件坐标、hintPresent=false）。

未覆盖：

- 缺口横幅的 UI 断言（u71 只测链事件，u66-2 测 status 载荷，未断言横幅文案/条件）。
- 移动端审计页与 ≤1100/≤700 断点的自动化几何断言（U114-D4）。
- 加载更早的 UI 追加行为（u66-5 未覆盖 nextCursor 按钮）。

## 7. 基线提交

`664a91e0322d90e4d32ce9d092526159c3052854`。本模块无工作树在途改动。
