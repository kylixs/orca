# 云端开发平台一期测试计划（M70 验收映射）

> 日期：2026-11-13
> 需求基线：`requirements.md` §8（AC-01 ~ AC-32）
> 流程基线：`remote-connectivity/design/DEVELOPMENT_PROCESS.md` §4.1、G8
> 证据根目录：`cloud-platform/evidence/`（gitignore）
> 本轮新增证据：`cloud-platform/evidence/m70-acceptance/`、`cloud-platform/evidence/m72-denial-details/`、`cloud-platform/evidence/m73-host-audit/`、`cloud-platform/evidence/m74-offline-host/`、`cloud-platform/evidence/m75-platform-unavailable/`、`cloud-platform/evidence/m76-signing-key-rotation/`、`cloud-platform/evidence/m77-host-key-pinning/`、`cloud-platform/evidence/m78-web-release/`、`cloud-platform/evidence/m79-policy-propagation/`、`cloud-platform/evidence/m80-audit-writer/`、`cloud-platform/evidence/m81-host-key-confirmation/`、`cloud-platform/evidence/m82-web-host-key/`、`cloud-platform/evidence/m83-relay-failover/`、`cloud-platform/evidence/m84-shared-login-lockout/`、`cloud-platform/evidence/m85-platform-data-path/`、`cloud-platform/evidence/m86-relay-data-path/`、`cloud-platform/evidence/m87-audit-writer-standby/`、`cloud-platform/evidence/m88-grant-revocation-live/`、`cloud-platform/evidence/m89-audit-trace-window/`、`cloud-platform/evidence/m90-terminal-over-relay/`、`cloud-platform/evidence/m91-connect-diagnostics/`、`cloud-platform/evidence/m92-managed-no-export/`、`cloud-platform/evidence/m93-web-admin-gating/`、`cloud-platform/evidence/m94-admin-denial-audit/`

## 1. 目的与范围

本计划把 32 条验收标准逐条映射到**真实测试用例**与**证据文件**，并明确哪些条目只能在
独立环境验证。映射只认用例里的断言，不按测试名称推断覆盖。

结论词汇：

| 结论 | 含义 |
|---|---|
| PASS | 该 AC 的全部预期均有测试断言覆盖，且证据可复查 |
| PASS(部分) | 核心路径已由测试+证据覆盖，但仍有明确未覆盖的子项（在“说明”列写清） |
| UNVERIFIED | 本机无法验证，或实现/环境缺失；不伪造证据 |

## 2. 分级策略（引用 DEVELOPMENT_PROCESS §4.1）

| 级别 | 触发 | 本计划用法 |
|---|---|---|
| L1 最小测试 | 每次改动/提交前 | 只跑改动文件与同目录邻居 |
| L2 模块测试 | 模块完成 | 单个模块的全部测试文件 |
| L3 里程碑测试 | 里程碑收口 | 按模块分批，不同时起多个 e2e |
| L4 全量验收 | 发版前 | 单独执行，不在补验证/文档阶段运行 |

强制约束：

- 每次测试命令必须带并发上限：Vitest `--maxWorkers=N`；平台 `node --test --test-concurrency=N`。
- 本轮补验证只按单文件顺序执行；大范围 e2e 不并发拉起。
- 跑 L3/L4 前检查 `uptime`；1 分钟负载超过核数一半时降并发或等待。
- `tsc` 与 `pnpm run check:code-quality:changed` 每轮都跑。

## 3. 测试数据与环境

| 项 | 值 |
|---|---|
| 平台账号 | `admin/Adm1n!`（平台管理员）、`zhangsan/Passw0rd!`（开发者，`team-payment`）、`lisi/Passw0rd!` |
| 种子主机 | `host_dev001`（`dev-001`），默认在线 |
| 种子项目 | `proj_payment`（`payment-service`），授权组 `team-payment` |
| 平台 API | `cloud-platform/apps/api/src/server.ts`，支持 `now` 注入，便于验证 15 分钟锁定与 60 秒心跳 |
| 模拟主机 | `cloud-platform/apps/runtime/src/runtime-sim.ts`，真实 TCP/TLS/WSS |
| 真实主机 | `src/main/runtime` 的 `OrcaRuntimeRpcServer` + Ed25519 票据 + E2EE，经 `cloud-session-e2e-harness.ts` 启动 |
| 证书 | 测试内 `openssl` 生成自签证书；仅测试连接使用 `rejectUnauthorized: false` |
| 临时目录 | `mkdtemp`，测试结束删除；不写用户 home |
| 证据 | 既有模块目录 `m8`…`m69`、`e2e-platform`；本轮 `m70-acceptance` |

## 4. AC → 测试 → 证据映射

路径均相对仓库根。测试文件简写：

- `P-E2E` = `cloud-platform/test/e2e/platform.e2e.test.ts`
- `P-M70` = `cloud-platform/test/e2e/m70-acceptance.e2e.test.ts`
- `P-E2E-HOST-OFFLINE` = `cloud-platform/test/e2e/host-offline.e2e.test.ts`
- `V-M70` = `src/main/cloud-platform/m70-acceptance.test.ts`

### 4.1 功能验收

| AC | 场景 | 层级 | 测试文件::用例 | 证据 | 结论 | 说明 |
|---|---|---|---|---|---|---|
| AC-01 | 正确账号登录，P95 ≤ 1.5s，显示有权限项目 | 真实 e2e + 采样 | `P-E2E::E1 登录 → 项目列表 → 直连打开项目`；`P-M70::AC-01 登录到项目列表 50 次采样 P95 ≤ 1.5s（API 段）` | `e2e-platform/E1-direct.json`；`m70-acceptance/ac-01-login-latency.json` | PASS(部分) | API 段 50 次采样 P95=1.3ms，项目列表可见；浏览器渲染到工作台可交互未测 |
| AC-02 | 连续 5 次密码错误锁定 15 分钟，提示明确，审计 | 真实 e2e（注入时钟；3 副本共享计数） | `P-M70::AC-02 连续 5 次失败锁定 15 分钟，锁定与恢复都有审计`；`login-lockout-shared.e2e.test.ts::AC-02`（3 个真实 API 副本 + 独立计数服务进程） | `m70-acceptance/ac-02-login-lockout.json`；`m84-shared-login-lockout/shared-lockout.json`、`lockout-unavailable.json` | PASS | 单副本：第 5 次 423、15 分钟恢复、审计含 `locked: true`。多副本：5 次失败轮流打到 3 个副本仍是第 5 次锁定，换副本用正确密码也 423；成功登录清零计数；计数服务不可达时登录 503 `PLATFORM_UNAVAILABLE`（fail-closed） |
| AC-03 | 无权限项目统一 404，不泄露项目名，写审计 | 真实 e2e | `cloud-platform/test/e2e/admin-gating.e2e.test.ts::开发者访问项目详情：有权限 200，无权限统一 404`、`开发者无法通过响应差异探测项目是否存在`；`P-M70::AC-03 无权限项目统一 404、响应不含项目名并写审计` | `m8-admin-gating/project-visibility.json`、`existence-non-disclosure.json`；`m70-acceptance/ac-03-project-non-disclosure.json` | PASS | 未知与无权限状态/错误体一致；`project_access` denied 事件可查 |
| AC-04 | 管理员登记并授权组，成员刷新可见并可打开 | 真实 e2e | `P-M70::AC-04 管理员登记并授权组后，成员刷新即可见并可取到连接票据` | `m70-acceptance/ac-04-project-grant.json` | PASS(部分) | 管理员 POST 项目 + PUT 组授权；成员列表可见并拿到 200 连接票据；未对该新项目执行真实打开 |
| AC-05 | 直连可达：预检选直连、显示线路、终端可交互、平台无业务流量 | 真实 e2e + 全字节记录 | `P-E2E::E1`；`src/main/cloud-platform/cloud-connect-client.test.ts::登录 → 项目列表 → 直连打开 → 加密 RPC`；`src/main/cloud-platform/cloud-terminal-session.test.ts::M43-1 在工作区内创建终端、订阅流并读到 shell 真实输出`；`cloud-platform-data-path.test.ts::M85-1` | `e2e-platform/E1-direct.json`；`m43-cloud-terminal/m43-1-stream.json`；`m85-platform-data-path/platform-not-in-data-path.json` | PASS | 直连路由、加密 RPC、真实 PTY 输出已验证。平台跳全字节记录：55 KB 负载经真实 TLS+E2EE 会话读回一致，期间平台跳新增 **0 字节**、所捕获的 7.9 KB 控制面流量不含负载标记，平台审计也无该标记；同一记录器能捕获故意发往平台的对照标记（证明测量本身有效） |
| AC-06 | 直连不可达自动回落中继，线路可见，终端可交互 | 真实 e2e（真实中继进程 + 真实 TLS Runtime + 真实 PTY） | `P-E2E::E2 直连不可达 → 自动回落中继（SNI 转发）`；`cloud-platform/test/e2e/relay-hardening.e2e.test.ts::白名单内 SNI 正常转发并完成 TLS 握手`；`src/main/cloud-platform/cloud-terminal-relay.test.ts::M90-1` | `e2e-platform/E2-relay.json`；`m10-relay/whitelisted-sni-forwarded.json`；`m90-terminal-over-relay/terminal-over-relay.json` | PASS | M90 补上「中继下的终端交互」：主机不广播任何直连地址，客户端只能选中继（`route=relay`）；经真实中继进程创建终端、订阅流、写入 `echo` 并读到 **shell 自己的输出**（`scrollback`→`data`→`end`，标记命中），同一 socket 上的 `files.write` 也成功。负向对照：会话建立后杀掉中继 → `terminal.create` 返回 `CONNECTION_CLOSED`，用例转红 |
| AC-07 | 直连与中继均不可达：错误码、分步诊断、可重试 | 真实 e2e（真实平台 + 真实 TCP 探测 + 真实中继进程）+ 组件测试 | `src/main/cloud-platform/cloud-connect-diagnostics.test.ts::M91-1`；`src/renderer/src/cloud/cloud-connect-failure-dialog.test.tsx`（3 例）；`cloud-connect-client.test.ts::直连不可达时回落中继；两者都不可达时明确报错` | `m91-connect-diagnostics/connect-diagnostics.json` | PASS | M91 补齐「分步诊断 + 重试」：直连地址是关闭端口、中继进程被杀后打开项目，抛 `ENDPOINT_UNREACHABLE` 且携带逐地址探测记录（`direct 127.0.0.1:64528 不可达 1ms`、`relay 127.0.0.1:64541 不可达 0ms`），该记录经 IPC 原样到达渲染层（`connectDiagnostics.probes`）。失败面板展示错误码、每个地址的结果与耗时，提供「重试」与「复制诊断信息」，复制文本与界面一致。重启中继后**同一客户端不重新登录**即可重试成功（`route=relay`，RPC 可用）。负向对照：去掉 IPC 诊断透传 → `connectDiagnostics` 为空转红；不记录探测步骤 → 步骤数为 0 转红 |
| AC-08 | 主机 60 秒无心跳：标记离线，项目打开禁用并说明原因 | 真实 e2e（真实平台进程 + 真实注册/心跳） | `P-E2E-HOST-OFFLINE::心跳过期后项目行转 offline 并拒绝打开…`（`host-offline.e2e.test.ts`，缩短 400ms 窗口）；`P-M70::AC-08 60 秒无心跳后连接被拒，项目行转为 offline`；`use-cloud-session.test.tsx::登录后列出项目：离线标注…离线项目不可打开` | `m74-offline-host/host-offline.json`；`m70-acceptance/ac-08-heartbeat-offline.json` | PASS | `hostStatus` 改为按心跳窗口推导（维护中单独为 `maintenance`）：过期后项目行 `offline`、`/v1/hosts.online=false`、connect 409 `HOST_OFFLINE`；恢复心跳立即回到 online；工作台按 `hostStatus` 禁用「打开」并显示「主机离线」徽标 |
| AC-09 | 主机维护：新连接拒绝，已有会话不中断 | 真实 e2e（真实 Runtime） | `V-M70::M70 AC-09 主机维护模式::新连接被 409 HOST_MAINTENANCE 拒绝，已建立会话 RPC 继续可用` | `m70-acceptance/ac-09-maintenance.json` | PASS | 维护中新建票据 409 `HOST_MAINTENANCE`；同一已建会话 `status.get` 前后均成功 |
| AC-10 | 托管项目下载：无入口；专用 RPC 拒绝；readChunk 记账限速 | 真实 e2e + 组件行为测试 | `P-E2E::E5 导出类方法一律拒绝（下载策略 deny）`；`src/main/cloud-platform/cloud-download-policy.test.ts::M35-1 默认为拒绝…`、`M35-2 读取按滚动小时记账…`；`src/renderer/src/cloud/cloud-managed-no-export.test.tsx::M92-1/M92-2`；`use-cloud-session.test.tsx::登录后列出项目：离线标注、下载受限单独标注…` | `e2e-platform/E5-export-denied.json`；`m35-download-policy/m35-1-download-policy.json`、`m35-2-read-budget.json`；`m92-managed-no-export/managed-no-export.json` | PASS | 主机侧：默认策略下 `browser.download` 等导出 RPC 一律拒绝、读预算按滚动小时记账。**UI 侧**（M92 补齐）：渲染受管工作区与文件面板，遍历全部可点控件，**没有任何**标签含「下载/导出/另存/download/export」的按钮或链接；完整走一遍「文本预览 → 进目录 → 打开图片」只发出 `status.get`、`files.readDir`、`files.readPreview` 三个读取类 RPC，导出族方法调用数为 0。图片提示文案由「请使用文件下载」改为「托管项目不提供图片预览与下载」。负向对照：加一个「下载」按钮 → 控件断言转红；让预览额外调用 `files.download` → RPC 断言转红 |
| AC-11 | 路径穿越 `../../etc/passwd` 拒绝并记安全事件 | 真实 e2e + 单元 | `P-E2E::E6 路径穿越与跨用户写越界被拒`；`cloud-platform/test/contract.test.ts::路径边界：拒绝穿越与绝对逃逸`；`cloud-platform/test/e2e/file-contract.e2e.test.ts::M29-3/M29-5`；`src/main/cloud-platform/cloud-workspace-boundary.test.ts::M36-1/M36-2`；`cloud-host-audit.test.ts::M73-1` | `e2e-platform/E6-path-boundary.json`；`m29-file-contract/m29-3-boundaries.json`、`m29-5-symlink.json`；`m36-workspace-boundary/m36-1-read-scope.json`；`m73-host-audit/m73-host-refusals.json` | PASS | 穿越/符号链接/跨根均拒绝；M73 起越界路径写入平台审计链（`host.path_denied`，含 `denial`/`reason`/`method`/设备与项目） |
| AC-12 | 权限收回 60 秒内断连；重新打开 404；降级恢复后立即生效 | 真实 e2e（真实平台 + 真实心跳 + 真实 TLS Runtime + E2EE） | `P-E2E::E7 权限收回后：旧凭证在心跳窗口内被拒，新登录看不到项目`；`cloud-platform/test/e2e/control-plane-isolation.e2e.test.ts::F1/F2`；`src/main/cloud-platform/cloud-revocation-precision.test.ts::撤销前签发的票据在撤销后被拒…`；`src/main/cloud-platform/cloud-grant-revocation-live.test.ts::M88-1/M88-2` | `e2e-platform/E7-revocation.json`；`m16-control-plane-isolation/policy-hang-still-revokes.json`；`m26-revocation-precision/cases.txt`；`m88-grant-revocation-live/grant-revocation-live.json`、`grant-restore.json` | PASS | M88 补上「已建立会话被收回」：管理员清空 `team-payment` 授权后，**不手动触发刷新**，主机靠自己的心跳在 **9.9 秒**内以 **4403** 关闭存活会话（预算 60 秒）；重新登录看不到项目、取票 404；恢复授权后 **11ms** 内列表可见、取票 200、重开会话认证成功。负向对照：让主机忽略 project 撤销集合 → 60 秒内不关闭，用例转红 |
| AC-13 | 审计员查近 7 天事件链，traceId 可关联连接日志 | 真实 e2e（真实平台 HTTP + 注入时钟 + 真实签名） | `cloud-platform/test/e2e/audit-verify.e2e.test.ts::M31-1/M31-3/M31-5/M31-6`；`cloud-platform/test/audit-integrity.test.ts`；`admin-gating.e2e.test.ts::被拒的管理操作写入审计`；`audit-trace-window.e2e.test.ts::AC-13` | `m31-audit-verify/m31-1-verify.json`、`m31-3-continuity.json`、`m31-6-tampered.json`；`m8-admin-gating/denied-audit.json`；`m89-audit-trace-window/audit-trace-window.json` | PASS | M89 补上两个缺口：审计 `ts` 改跟随平台注入时钟，因此「近 7 天」窗口可用真实时间跳变验证——第 0 天事件被 `since` 排除、第 6/10 天在窗口内，逐页（limit=1）走完窗口得到的事件集合与一次查询完全一致且无重复，整链 `verify.ok`（12 条）。`traceId` 成为可查询条件：客户端 `x-trace-id` → 响应与 `project_connect` 审计事件携带同一值，`GET /v1/audit/events?traceId=` 精确命中 1 条、未用过的 traceId 返回 0 条。负向对照：去掉 traceId 过滤条件 → 命中 12 条转红；去掉审计时钟注入 → 窗口边界错误转红 |
| AC-14 | 管理员吊销主机：新连接立即失败，已有连接 60 秒内断开 | — | `cloud-platform/test/e2e/host-revocation.e2e.test.ts`（心跳 `hostRevoked` + 409 `HOST_REVOKED`）；`src/main/cloud-platform/cloud-host-revocation.test.ts`（真实 WSS 9.9s 内 4403） | `m71-host-revocation/platform-revocation.json`、`m71-revocation.json` | PASS | M71 修复：`DELETE` 保留心跳凭证只置 `revokedAt`，主机收到 `hostRevoked` 后关闭全部已准入会话并停止轮询 |
| AC-15 | 客户端版本过低：登录成功，打开项目 426 提示升级 | 真实 e2e | `P-E2E::E7c 客户端版本过低被平台拒绝（426）` | `e2e-platform/E7c-version-gate.json` | PASS | 登录后可登录；connect 返回 426 `VERSION_UNSUPPORTED`，带 `min/offered` |
| AC-16 | 重启客户端且刷新令牌有效：免密进入工作台 | 真实 e2e | `src/main/cloud-platform/cloud-session-restart.test.ts::M66-1 三次重启都免登录…`；`cloud-session-persistence.test.ts` | `m66-session-persistence/desktop-restart.json` | PASS | 三次新进程恢复均 signed-in，设备身份不变；登出后恢复为 signed-out 并删文件 |
| AC-17 | 管理员改下载策略：30 秒内生效并审计 | 真实 e2e（真实平台 + 真实 Runtime + 真实 WSS） | `cloud-download-policy.test.ts::M35-1 默认为拒绝…`；`cloud-policy-propagation.test.ts::M79-1`（仅靠 10s 轮询，全程不手动刷新） | `m35-download-policy/m35-1-download-policy.json`；`m79-policy-propagation/m79-policy-propagation.json` | PASS | 放开与收回分别在 **10.09s / 10.11s** 到达同一已建会话（限 30s），期间无手动刷新、无重连（同一 socket 仍可 `status.get`）；策略变更写 `policy_update` 审计 |
| AC-18 | 无管理权限：导航隐藏；页面/接口 403；写审计 | 真实 e2e（真实平台进程 + 真实前端 + 真实签名 + 真实审计链） | `admin-gating.e2e.test.ts::开发者访问「…」返回 403`（8 条）；`web-admin-gating.e2e.test.ts::AC-18`（前端导航/路由）；`admin-denial-audit.e2e.test.ts::AC-18`（12 个管理接口的拒绝审计） | `m8-admin-gating/denied-audit.json`；`m93-web-admin-gating/web-admin-gating.json`；`m94-admin-denial-audit/admin-denial-audit.json` | PASS | M93 补齐前端：开发者登录后管理导航隐藏、强行点击管理路由显示无权限页；管理员则正常可见可用。M94 补齐审计一致性：**12 个**管理/审计接口的开发者访问全部 403，且**每条拒绝都在审计链中**（`result=denied`，带 `targetType`、`targetId` 与 `requiredPermission` = `platform:admin`／`platform:auditor`）；管理员成功读取不产生 denied 事件；新增 12 条后整链 `verify.ok`（14 条）。负向对照：把 `GET /v1/hosts` 的拒绝改回裸 403 → 用例报「no denied event for: host_list」转红 |
| AC-19 | Web 前端独立发布新版本，旧前端兼容期内不白屏/404 | 真实 e2e（两个真实平台进程 + 真实静态资源） | `web-release.e2e.test.ts::AC-19 前端独立发布…` | `m78-web-release/web-release.json` | PASS | 前端按内容哈希发布：`index.html` 为 `no-store` 并引用 `/assets/<build>/…`（`immutable`），上一构建归档后仍可取（旧页面缓存的 URL 不 404）；`/v1/web/release` 提供契约版本；`x-orca-web-contract` 超出兼容窗口返回 426 `WEB_CONTRACT_UNSUPPORTED`（带 min/max），不带该头的旧前端按当前契约处理；`/v1` 路由在兼容期内保持 200/401 而非 404 |
| AC-20 | 平台停机：已有会话继续；新建/重连提示 `PLATFORM_UNAVAILABLE`，不无凭证重连 | 真实 e2e | `P-E2E::E8 平台停机：已建立会话继续，新建连接失败`；`cloud-platform-unavailable.test.ts::M75-1/M75-2`（真实平台 + 可暂停 TCP 代理 + 真实 TLS Runtime + 真实 WSS）；`cloud-platform-unavailable-unit.test.ts` | `e2e-platform/E8-platform-down.json`；`m75-platform-unavailable/m75-outage.json`、`m75-recovered.json` | PASS | M75 起网络中断统一映射 `PLATFORM_UNAVAILABLE`（登录、列表、取票、刷新四处）；已有会话不受影响；断网期间不重连（取票先失败，票据未取到就没有 socket）；恢复后**同一会话不重新登录**即可再次取票打开，证明未被判死 |
| AC-21 | 过期/伪造凭证直连：WSS 401 + `x-orca-reject`，101 前无关闭帧，审计 | 真实 e2e | `P-E2E::E3 伪造/过期凭证在升级期被拒`（本轮加强断言） | `m70-acceptance/ac-21-forged-credential.json`；`m46-browser-upgrade/m46-2/3`；`cloud-host-audit.test.ts::M73-1` | `m73-host-audit/m73-host-refusals.json` | PASS | 实测 401 + `x-orca-reject: malformed`，未升级成功；M73 起伪造凭证在同一心跳内写入 `host.connection_rejected` 审计（`reason: malformed`），并验证整链 `verify.ok` |

### 4.2 非功能验收

| AC | 场景 | 层级 | 测试文件::用例 | 证据 | 结论 | 说明 |
|---|---|---|---|---|---|---|
| AC-22 | 300 并发 30 分钟压测 | 压测 | 无 | 无 | UNVERIFIED | 需独立压测环境与指标采集（见 §5） |
| AC-23 | 单中继宕机，5 次退避内重连，新开会话成功率 ≥99% | 故障注入（2 个真实中继进程 + 真实平台 + 真实 TLS/WSS） | `cloud-platform/test/e2e/relay-failover.e2e.test.ts::AC-23`；`relay-hardening.e2e.test.ts::M10` | `m83-relay-failover/relay-failover.json` | PASS | 平台维护活中继列表（中继每次路由同步自注册，窗口外自动剔除）：两台注册后 `/connect` 下发 2 个 relay 端点；杀掉其一并在窗口过期后只下发存活节点；随后 **40 次新会话全部成功（成功率 100%）**，最长尝试 1 次；仍带着死节点的过期列表按优先级回退，**第 2 次尝试**切到存活中继并完成真实 TLS+WSS 握手 |
| AC-24 | 数据面密文；平台/中继日志无明文；平台只持公钥与元数据 | 真实 e2e + 全字节记录（平台跳 + 中继出向） | `relay-hardening.e2e.test.ts::连接元数据被记录，且不含负载内容`；`cloud-platform-data-path.test.ts::M85-1`；`cloud-relay-data-path.test.ts::M86-1`；E2EE 握手由 `cloud-connect-client.test.ts`、`m46-browser-upgrade.test.ts` 覆盖 | `m10-relay/connection-metadata.json`；`m85-platform-data-path/platform-not-in-data-path.json`；`m86-relay-data-path/relay-ciphertext-only.json`；`m46-browser-upgrade/m46-1-subprotocol-upgrade.json` | PASS | **平台侧**：55 KB 会话负载读回一致，期间平台跳新增 0 字节，审计无明文。**中继侧**：强制走中继的会话（真实中继进程 + 真实 TLS + E2EE）令中继出向捕获 101,692 字节、负载明文标记不出现，中继自身日志也无该标记；同一捕获器对直写明文能命中（测量有效）。中继只见到源/SNI/路由/结果等元数据 |
| AC-25 | 令牌泄露：访问令牌 ≤5s 失效、刷新令牌立即失效、已建连接 ≤60s 断开 | 真实 e2e | `P-M70::AC-25 吊销设备后访问令牌与刷新令牌立即失效`；`cloud-platform/test/e2e/revocation.e2e.test.ts::M11 设备吊销后已建立连接在 60 秒内被关闭（4403）` | `m70-acceptance/ac-25-token-revocation.json`；`m11-revocation/device-revoke-closes-session.json` | PASS | 吊销后访问/刷新令牌均 401；真实主机在 4.2s 内 `4403 device_revoked` |
| AC-26 | 审计不可改；3 副本 10 万条并发无分叉；篡改告警 | 真实 e2e（1 真实写入者进程 + 3 真实 API 副本 + 真实 TCP） | `cloud-platform/test/e2e/audit-writer.e2e.test.ts::AC-26`；`cloud-platform/test/audit-integrity.test.ts`；`audit-verify.e2e.test.ts::M31-6`；`audit-fail-closed.e2e.test.ts::M32-2` | `m80-audit-writer/audit-writer.json`；`m31-audit-verify/m31-6-tampered.json`；`m32-audit-fail-closed/m32-2-chain-broken.json` | PASS | 3 个 API 副本经单写入者定序：**10 万条并发**（3 生产者，42k 事件/秒）`seq` 连续无重复、整链 `verify.ok`；改写日志中间一行后重启，写入者报告 `brokenAtSeq`，3 个副本的敏感写操作一律 503 `AUDIT_CHAIN_BROKEN`。M87 起写入者支持主备：两台共享同一日志与租约文件，仅持有租约者可写；主写入者被 SIGKILL 后备用在租约过期（实测 2.4s）后接管并从磁盘续链，链 `seq` 连续、`verify.ok`（见 `m87-audit-writer-standby/standby-takeover.json`）。仍未实现 Redis/PG 持久层与签名锚点（见 G-04 剩余项） |
| AC-27 | A 读 B 的 worktree：读允许、写拒绝（`PATH_OUTSIDE_ROOT`，非 HTTP 403），审计，凭证根受限 | 真实 e2e | `src/main/cloud-platform/cloud-workspace-boundary.test.ts::M36-1 项目内读取放行、项目外拒绝；跨工作区读取被拒`、`M36-2 写只允许本人工作区根…`；`cloud-path-boundary.test.ts::工作区根内的写入放行，项目其它位置只读`；`cloud-denial-details.test.ts::M72-1`；`cloud-rpc-scope.test.ts::M34-1`；`cloud-host-audit.test.ts::M73-1` | `m36-workspace-boundary/m36-1-read-scope.json`、`m36-2-write-scope.json`；`m72-denial-details/m72-path-denial.json`；`m73-host-audit/m73-host-refusals.json` | PASS | 读语义成立：读限 `projectRoot`（项目内跨工作区读放行），他项目读取拒绝；写限 `workspaceRoot`；凭证根受限成立；M72 起顶层 `forbidden` + `data.denial=PATH_OUTSIDE_ROOT`；M73 起拒绝写审计 |
| AC-28 | 仅 `file:read` 调用 `files.write`：按方法映射拒绝（`PERMISSION_MISSING`），审计方法与凭证权限 | 真实 e2e | `cloud-rpc-scope.test.ts::M34-1 只授予 file:read…`；`P-E2E::E4 方法级权限：无 file:write 时写操作被拒`；`rpc-caller-scope.test.ts::names the missing permission…`（M72）；`cloud-host-audit.test.ts::M73-1`（方法级拒绝审计） | `m34-cloud-rpc-scope/m34-1-readonly.json`；`e2e-platform/E4-method-permission.json`；`m72-denial-details/m72-path-denial.json`；`m73-host-audit/m73-host-refusals.json` | PASS | 读放行、写拒绝；M72 起顶层 `forbidden` + `data.denial=PERMISSION_MISSING`、`permission=file:write`；M73 起主机级/缺权限拒绝写 `host.method_denied` 审计（含 `denial`、`method`、设备与项目） |
| AC-29 | 主机公钥被替换：固定指纹不匹配 → 关闭码 4433，强制中断并要求重新核对，写审计 | 真实 e2e（真实平台 + 真实 TLS Runtime + 真实 WSS） | `cloud-host-key-pinning.test.ts::M77-1/M77-2`；`host-key-change-audit.e2e.test.ts`（平台侧密钥变更审计） | `m77-host-key-pinning/m77-pin-mismatch.json`、`m77-pin-persisted.json`、`platform-key-change-audit.json`；`m81-host-key-confirmation/m81-host-key-confirmation.json` | PASS | 客户端首次连接对主机 E2EE 公钥做 TOFU（SHA-256 指纹，持久化到 `orca-cloud-host-trust.json`）；平台换钥后 `openProject` 抛 `FINGERPRINT_MISMATCH`（closeCode 4433）并以 4433 关闭已建 socket，固定值不变；只有显式 `trustHostKey()` 才更新且 pending 只消费一次，跨实例/重启保留。M81 起原生界面在变更时弹出阻塞对话框，同时展示已固定与本次收到的指纹，确认后重新固定并自动重开（取消则不固定）；打开成功的项目在结果里带 `hostFingerprint` 供工作区展示。平台侧对 E2EE 公钥变更写 `host_e2ee_key_changed` 审计（只存指纹）。M82 起浏览器（管理员会话页）同样固定：localStorage 按主机存指纹，换钥时在**建 socket 之前**返回 `FINGERPRINT_MISMATCH`，同一确认对话框生效 |
| AC-30 | 凭证复制到另一设备：设备公钥必须与凭证一致；不一致/缺失均拒绝（401 + `x-orca-reject`） | 真实 e2e | `m46-browser-upgrade.test.ts::M46-2 子协议设备公钥与票据不同：升级被 401 device_mismatch 拒绝`、`M46-3 两种形式都不带：升级被 401 device_pubkey_missing 拒绝`；`P-E2E::E7b/E7b2` | `m46-browser-upgrade/m46-2-wrong-device-key.json`、`m46-3-missing-device-key.json`；`e2e-platform/E7b-device-transplant.json`、`E7b2-missing-device-header.json` | PASS | 真实 Runtime 与模拟 Runtime 均拒绝移植/缺失，401 + 原因头 |
| AC-31 | 签名密钥轮换：新旧 `kid` 并行；轮换后 60 天旧公钥可验旧凭证 | 真实 e2e（真实签名 + 真实 HTTP/WSS） | `signing-key-rotation.e2e.test.ts::AC-31 轮换后新旧 kid 并行验签…`、`非管理员轮换被 403 拒绝并写审计`；`cloud-signing-key-rotation.test.ts::M76-1`（真实平台 + 真实 TLS Runtime + 真实 WSS） | `m76-signing-key-rotation/ac-31-rotation.json`、`ac-31-denied.json`、`m76-host-admission.json` | PASS | 轮换前签发的票据在轮换后仍可验签并被真实主机接纳（主机刷新 JWKS 后同时持有新旧 `kid`）；新票据用新 `kid`；第 59 天旧公钥仍发布，超过 60 天后从 JWKS 移除（旧票据 `unknown_kid`）；轮换/被拒均写审计 |
| AC-32 | 外网无 VPN 访问管控接口被 WAF 拒绝，工作台与打开项目正常 | 未覆盖 | 无 | 无 | UNVERIFIED | 需 DMZ/WAF 真实网络环境 |

## 5. 不可验证项与前置条件

| AC | 缺什么 | 建议验证环境 |
|---|---|---|
| AC-14 | ~~已修复~~ | M71 已用真实 WSS 验证（9.9s 内 4403），无需独立环境 |
| AC-19 | 旧前端 bundle 与新 API 的兼容部署 | 静态资源与 API 分开部署；保留 N-1 前端产物，在 API 升级后回归登录/工作台/打开项目 |
| AC-22 | 300 并发、30 分钟、P95 指标 | 独立压测环境；k6/artillery 驱动真实 Runtime + relay；采集连接成功率、直连/中继 P95 |
| AC-23 | 多中继节点故障切换 | 至少 2 个中继节点；杀其中一个，验证客户端 5 次退避内重连且新开会话成功率 ≥99% |
| AC-26 | 3 个 API 副本并发写 10 万条 | 共享的单写入审计汇聚点（当前实现需先补多副本审计汇聚）；并发写入后链校验无分叉 |
| AC-29 | 主机公钥固定与 4433 关闭码 | 实现固定指纹校验后，用 MITM 代理替换公钥；验证 4433、强制中断、审计 |
| AC-31 | 密钥轮换与 60 天旧钥保留 | 实现 `kid` 并存与保留策略；分别用新/旧 `kid` 签发的凭证验签，并跨越轮换窗口 |
| AC-32 | WAF/DMZ 策略 | 非 VPN 外网客户端；验证管控接口 403/404 且工作台与项目连接不受影响 |

## 6. 本轮补充的测试

| 文件 | 覆盖 AC | 说明 |
|---|---|---|
| `cloud-platform/test/e2e/m70-acceptance.e2e.test.ts` | AC-01、AC-02、AC-03、AC-04、AC-08、AC-25 | 进程内真实 API + 注入时钟；不等待 15 分钟/60 秒 |
| `src/main/cloud-platform/m70-acceptance.test.ts` | AC-09 | 真实平台进程 + 真实 Orca Runtime + 真实加密 RPC |
| `cloud-platform/test/e2e/platform.e2e.test.ts::E3` | AC-21 | 加强断言：必须 401 且带 `x-orca-reject`，并输出到 `m70-acceptance` |

## 7. 执行命令

```bash
# 平台侧 M70（单文件、顺序）
cd cloud-platform && node --test --test-concurrency=1 test/e2e/m70-acceptance.e2e.test.ts

# 真实 Runtime M70（单文件）
node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts \
  --maxWorkers=1 src/main/cloud-platform/m70-acceptance.test.ts

# AC-21 单用例
cd cloud-platform && node --test --test-concurrency=1 \
  --test-name-pattern="E3 " test/e2e/platform.e2e.test.ts

# 类型与质量门禁
npx tsc -p config/tsconfig.node.json --noEmit
npx tsc -p config/tsconfig.tc.web.json --noEmit
pnpm run check:code-quality:changed
```

禁止：`pnpm test`、全量测试、并行拉起多个 e2e。

## 8. 维护约定

- 新增/修改 AC 时先补测试断言，再写映射；不得用“测试名听起来覆盖”代替断言检查。
- 证据文件必须由本轮命令实际生成；不手工编造。
- 本轮新证据放 `cloud-platform/evidence/m70-acceptance/`，不修改既有模块证据。
- 文档与实现不一致时，以“文档偏差/产品缺口”记录，不为了对齐文档改实现或放宽断言。
