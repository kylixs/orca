# 云端开发平台一期测试计划（M70 验收映射）

> 日期：2026-11-13
> 需求基线：`requirements.md` §8（AC-01 ~ AC-32）
> 流程基线：`remote-connectivity/design/DEVELOPMENT_PROCESS.md` §4.1、G8
> 证据根目录：`cloud-platform/evidence/`（gitignore）
> 本轮新增证据：`cloud-platform/evidence/m70-acceptance/`

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
- `V-M70` = `src/main/cloud-platform/m70-acceptance.test.ts`

### 4.1 功能验收

| AC | 场景 | 层级 | 测试文件::用例 | 证据 | 结论 | 说明 |
|---|---|---|---|---|---|---|
| AC-01 | 正确账号登录，P95 ≤ 1.5s，显示有权限项目 | 真实 e2e + 采样 | `P-E2E::E1 登录 → 项目列表 → 直连打开项目`；`P-M70::AC-01 登录到项目列表 50 次采样 P95 ≤ 1.5s（API 段）` | `e2e-platform/E1-direct.json`；`m70-acceptance/ac-01-login-latency.json` | PASS(部分) | API 段 50 次采样 P95=1.3ms，项目列表可见；浏览器渲染到工作台可交互未测 |
| AC-02 | 连续 5 次密码错误锁定 15 分钟，提示明确，审计 | 真实 e2e（注入时钟） | `P-M70::AC-02 连续 5 次失败锁定 15 分钟，锁定与恢复都有审计` | `m70-acceptance/ac-02-login-lockout.json` | PASS | 第 5 次 423 `ACCOUNT_LOCKED`；15 分钟后恢复 200；审计含 `locked: true` |
| AC-03 | 无权限项目统一 404，不泄露项目名，写审计 | 真实 e2e | `cloud-platform/test/e2e/admin-gating.e2e.test.ts::开发者访问项目详情：有权限 200，无权限统一 404`、`开发者无法通过响应差异探测项目是否存在`；`P-M70::AC-03 无权限项目统一 404、响应不含项目名并写审计` | `m8-admin-gating/project-visibility.json`、`existence-non-disclosure.json`；`m70-acceptance/ac-03-project-non-disclosure.json` | PASS | 未知与无权限状态/错误体一致；`project_access` denied 事件可查 |
| AC-04 | 管理员登记并授权组，成员刷新可见并可打开 | 真实 e2e | `P-M70::AC-04 管理员登记并授权组后，成员刷新即可见并可取到连接票据` | `m70-acceptance/ac-04-project-grant.json` | PASS(部分) | 管理员 POST 项目 + PUT 组授权；成员列表可见并拿到 200 连接票据；未对该新项目执行真实打开 |
| AC-05 | 直连可达：预检选直连、显示线路、终端可交互、平台无业务流量 | 真实 e2e | `P-E2E::E1`；`src/main/cloud-platform/cloud-connect-client.test.ts::登录 → 项目列表 → 直连打开 → 加密 RPC`；`src/main/cloud-platform/cloud-terminal-session.test.ts::M43-1 在工作区内创建终端、订阅流并读到 shell 真实输出` | `e2e-platform/E1-direct.json`；`m43-cloud-terminal/m43-1-stream.json` | PASS(部分) | 直连路由、加密 RPC、真实 PTY 输出已验证；未抓包证明平台侧无该会话业务流量 |
| AC-06 | 直连不可达自动回落中继，线路可见，终端可交互 | 真实 e2e | `P-E2E::E2 直连不可达 → 自动回落中继（SNI 转发）`；`cloud-platform/test/e2e/relay-hardening.e2e.test.ts::白名单内 SNI 正常转发并完成 TLS 握手` | `e2e-platform/E2-relay.json`；`m10-relay/whitelisted-sni-forwarded.json` | PASS(部分) | 路由 relay + RPC 通过中继已验证；中继下的终端交互未单独复测 |
| AC-07 | 直连与中继均不可达：错误码、分步诊断、可重试 | 单元/组件 | `src/main/cloud-platform/cloud-connect-client.test.ts::直连不可达时回落中继；两者都不可达时明确报错` | `m19-desktop-connect/cases.txt` | PASS(部分) | `chooseRoute` 返回 null，`prepareProjectLink` 抛 `ENDPOINT_UNREACHABLE`；用例未断言该错误码，无分步诊断/重试 UI 测试 |
| AC-08 | 主机 60 秒无心跳：标记离线，项目打开禁用并说明原因 | 真实 e2e（注入时钟） | `P-M70::AC-08 60 秒无心跳后连接被拒；项目行仍显示 online（缺口）` | `m70-acceptance/ac-08-heartbeat-offline.json` | PASS(部分) | `/v1/hosts` 已离线、connect 409 `HOST_OFFLINE`；项目列表仍用持久化 status 显示 online，工作台“打开”未禁用（见 G-04） |
| AC-09 | 主机维护：新连接拒绝，已有会话不中断 | 真实 e2e（真实 Runtime） | `V-M70::M70 AC-09 主机维护模式::新连接被 409 HOST_MAINTENANCE 拒绝，已建立会话 RPC 继续可用` | `m70-acceptance/ac-09-maintenance.json` | PASS | 维护中新建票据 409 `HOST_MAINTENANCE`；同一已建会话 `status.get` 前后均成功 |
| AC-10 | 托管项目下载：无入口；专用 RPC 拒绝；readChunk 记账限速 | 真实 e2e | `P-E2E::E5 导出类方法一律拒绝（下载策略 deny）`；`src/main/cloud-platform/cloud-download-policy.test.ts::M35-1 默认为拒绝…`、`M35-2 读取按滚动小时记账…`；`src/renderer/src/cloud/use-cloud-session.test.tsx::登录后列出项目：离线标注、下载受限单独标注…` | `e2e-platform/E5-export-denied.json`；`m35-download-policy/m35-1-download-policy.json`、`m35-2-read-budget.json`；`m21-cloud-ui/cases.txt` | PASS(部分) | 主机侧 `EXPORT_DENIED`/策略拒绝与读预算已验证；未断言受管 UI 完全无下载/导出入口 |
| AC-11 | 路径穿越 `../../etc/passwd` 拒绝并记安全事件 | 真实 e2e + 单元 | `P-E2E::E6 路径穿越与跨用户写越界被拒`；`cloud-platform/test/contract.test.ts::路径边界：拒绝穿越与绝对逃逸`；`cloud-platform/test/e2e/file-contract.e2e.test.ts::M29-3/M29-5`；`src/main/cloud-platform/cloud-workspace-boundary.test.ts::M36-1/M36-2` | `e2e-platform/E6-path-boundary.json`；`m29-file-contract/m29-3-boundaries.json`、`m29-5-symlink.json`；`m36-workspace-boundary/m36-1-read-scope.json` | PASS(部分) | 穿越/符号链接/跨根均拒绝；主机侧没有安全事件审计（见 G-08） |
| AC-12 | 权限收回 60 秒内断连；重新打开 404；降级恢复后立即生效 | 真实 e2e | `P-E2E::E7 权限收回后：旧凭证在心跳窗口内被拒，新登录看不到项目`；`cloud-platform/test/e2e/control-plane-isolation.e2e.test.ts::F1/F2`；`src/main/cloud-platform/cloud-revocation-precision.test.ts::撤销前签发的票据在撤销后被拒…`；`src/main/cloud-platform/cloud-project-archive.test.ts::归档释放 key…让主机关闭 Live 会话` | `e2e-platform/E7-revocation.json`；`m16-control-plane-isolation/policy-hang-still-revokes.json`；`m26-revocation-precision/cases.txt`；`m65-project-archive/m65-archive.json` | PASS(部分) | 旧票据拒绝、新登录 404、控制面挂起时仍撤销已验证；项目级撤销关闭 Live 会话（归档路径，4403）已验证，授权收回走同一 `revokeProjectCredentials` 机制但**无直接用例断言 60 秒内断开** |
| AC-13 | 审计员查近 7 天事件链，traceId 可关联连接日志 | 真实 e2e + 单元 | `cloud-platform/test/e2e/audit-verify.e2e.test.ts::M31-1/M31-3/M31-5/M31-6`；`cloud-platform/test/audit-integrity.test.ts`；`admin-gating.e2e.test.ts::被拒的管理操作写入审计` | `m31-audit-verify/m31-1-verify.json`、`m31-3-continuity.json`、`m31-6-tampered.json`；`m8-admin-gating/denied-audit.json` | PASS(部分) | 链校验、分页、重启续链、篡改定位已验证；7 天 `since` 过滤与 traceId→连接日志关联无断言 |
| AC-14 | 管理员吊销主机：新连接立即失败，已有连接 60 秒内断开 | — | `cloud-platform/test/e2e/host-revocation.e2e.test.ts`（心跳 `hostRevoked` + 409 `HOST_REVOKED`）；`src/main/cloud-platform/cloud-host-revocation.test.ts`（真实 WSS 9.9s 内 4403） | `m71-host-revocation/platform-revocation.json`、`m71-revocation.json` | PASS | M71 修复：`DELETE` 保留心跳凭证只置 `revokedAt`，主机收到 `hostRevoked` 后关闭全部已准入会话并停止轮询 |
| AC-15 | 客户端版本过低：登录成功，打开项目 426 提示升级 | 真实 e2e | `P-E2E::E7c 客户端版本过低被平台拒绝（426）` | `e2e-platform/E7c-version-gate.json` | PASS | 登录后可登录；connect 返回 426 `VERSION_UNSUPPORTED`，带 `min/offered` |
| AC-16 | 重启客户端且刷新令牌有效：免密进入工作台 | 真实 e2e | `src/main/cloud-platform/cloud-session-restart.test.ts::M66-1 三次重启都免登录…`；`cloud-session-persistence.test.ts` | `m66-session-persistence/desktop-restart.json` | PASS | 三次新进程恢复均 signed-in，设备身份不变；登出后恢复为 signed-out 并删文件 |
| AC-17 | 管理员改下载策略：30 秒内生效并审计 | 真实 e2e | `cloud-download-policy.test.ts::M35-1 默认为拒绝…` | `m35-download-policy/m35-1-download-policy.json` | PASS(部分) | 策略变更 + 审计 + 链校验已验证；用例通过手动 `refresh()` 立即生效，未测 10s 轮询在 30s 内的端到端时延 |
| AC-18 | 无管理权限：导航隐藏；页面/接口 403；写审计 | 真实 e2e + 浏览器人工 | `admin-gating.e2e.test.ts::开发者访问「…」返回 403`（8 条）、`被拒的管理操作写入审计（denied）`；Web UI 手动检查 | `m8-admin-gating/denied-audit.json`；`web-ui/07-forbidden.png`、`web-ui/08-developer-workbench.png` | PASS(部分) | 8 个管理接口 403 + denied 审计已自动化；`#adminNav.hidden` 与直接路由拦截仅截图/人工，无自动化断言 |
| AC-19 | Web 前端独立发布新版本，旧前端兼容期内不白屏/404 | 未覆盖 | 无 | 无 | UNVERIFIED | 平台未提供静态资源/API 版本协商或旧前端契约测试；需独立部署环境（见 §5） |
| AC-20 | 平台停机：已有会话继续；新建/重连提示 `PLATFORM_UNAVAILABLE`，不无凭证重连 | 真实 e2e | `P-E2E::E8 平台停机：已建立会话继续，新建连接失败`；`src/main/cloud-platform/cloud-session-recovery*` 相关用例 | `e2e-platform/E8-platform-down.json` | PASS(部分) | 停机 3.5s 内 Runtime 存活、RPC/文件仍可用、新登录失败；`PLATFORM_UNAVAILABLE` 仅存在于登录文案，未验证重连路径与“无凭证重连”否定断言 |
| AC-21 | 过期/伪造凭证直连：WSS 401 + `x-orca-reject`，101 前无关闭帧，审计 | 真实 e2e | `P-E2E::E3 伪造/过期凭证在升级期被拒`（本轮加强断言） | `m70-acceptance/ac-21-forged-credential.json`；`m46-browser-upgrade/m46-2/3` | PASS(部分) | 实测 401 + `x-orca-reject: malformed`，未升级成功；主机侧鉴权失败审计未实现（见 G-09） |

### 4.2 非功能验收

| AC | 场景 | 层级 | 测试文件::用例 | 证据 | 结论 | 说明 |
|---|---|---|---|---|---|---|
| AC-22 | 300 并发 30 分钟压测 | 压测 | 无 | 无 | UNVERIFIED | 需独立压测环境与指标采集（见 §5） |
| AC-23 | 单中继宕机，5 次退避内重连，新开会话成功率 ≥99% | 故障注入 | 无 | 无 | UNVERIFIED | 需多中继部署与节点杀进程演练 |
| AC-24 | 数据面密文；平台/中继日志无明文；平台只持公钥与元数据 | 真实 e2e + 日志审查 | `relay-hardening.e2e.test.ts::连接元数据被记录，且不含负载内容`；E2EE 握手由 `cloud-connect-client.test.ts`、`m46-browser-upgrade.test.ts` 覆盖 | `m10-relay/connection-metadata.json`；`m46-browser-upgrade/m46-1-subprotocol-upgrade.json` | PASS(部分) | 中继元数据只含源/SNI/路由/结果；E2EE RPC 可用。未做实际抓包与平台/中继日志全文扫描 |
| AC-25 | 令牌泄露：访问令牌 ≤5s 失效、刷新令牌立即失效、已建连接 ≤60s 断开 | 真实 e2e | `P-M70::AC-25 吊销设备后访问令牌与刷新令牌立即失效`；`cloud-platform/test/e2e/revocation.e2e.test.ts::M11 设备吊销后已建立连接在 60 秒内被关闭（4403）` | `m70-acceptance/ac-25-token-revocation.json`；`m11-revocation/device-revoke-closes-session.json` | PASS | 吊销后访问/刷新令牌均 401；真实主机在 4.2s 内 `4403 device_revoked` |
| AC-26 | 审计不可改；3 副本 10 万条并发无分叉；篡改告警 | 单元 + 未覆盖的并发 | `cloud-platform/test/audit-integrity.test.ts`；`audit-verify.e2e.test.ts::M31-6`；`audit-fail-closed.e2e.test.ts::M32-2` | `m31-audit-verify/m31-6-tampered.json`；`m32-audit-fail-closed/m32-2-chain-broken.json` | UNVERIFIED | 篡改检测与 fail-closed 子项 PASS；3 个 API 副本 + 10 万条并发写入未验证，当前实现是单进程内存/单文件链（见 G-07） |
| AC-27 | A 读 B 的 worktree：读允许、写拒绝（`PATH_OUTSIDE_ROOT`，非 HTTP 403），审计，凭证根受限 | 真实 e2e | `src/main/cloud-platform/cloud-workspace-boundary.test.ts::M36-1 项目内读取放行、项目外拒绝；跨工作区读取被拒`、`M36-2 写只允许本人工作区根…`；`cloud-rpc-scope.test.ts::M34-1` | `m36-workspace-boundary/m36-1-read-scope.json`、`m36-2-write-scope.json` | PASS(部分) | 写入拒绝、凭证根受限成立；**跨工作区读取实际被拒（与 AC“读允许”相反）**；错误码是 `forbidden` 而非 `PATH_OUTSIDE_ROOT`；无审计（见 G-01/G-02） |
| AC-28 | 仅 `file:read` 调用 `files.write`：按方法映射拒绝（`PERMISSION_MISSING`），审计方法与凭证权限 | 真实 e2e | `cloud-rpc-scope.test.ts::M34-1 只授予 file:read…`；`P-E2E::E4 方法级权限：无 file:write 时写操作被拒` | `m34-cloud-rpc-scope/m34-1-readonly.json`；`e2e-platform/E4-method-permission.json` | PASS(部分) | 读放行、写拒绝且消息指明缺 `file:write`；真实主机错误码为 `forbidden`，非文档的 `PERMISSION_MISSING`；无审计（见 G-03/G-02） |
| AC-29 | 主机公钥被替换：固定指纹不匹配 → 关闭码 4433，强制中断并要求重新核对，写审计 | 未覆盖 | 无 | 无 | UNVERIFIED | 仓库内无 4433/云端公钥固定实现；`tls-certificate.ts` 的指纹固定服务于移动端配对，不覆盖云端票据路径（见 G-06） |
| AC-30 | 凭证复制到另一设备：设备公钥必须与凭证一致；不一致/缺失均拒绝（401 + `x-orca-reject`） | 真实 e2e | `m46-browser-upgrade.test.ts::M46-2 子协议设备公钥与票据不同：升级被 401 device_mismatch 拒绝`、`M46-3 两种形式都不带：升级被 401 device_pubkey_missing 拒绝`；`P-E2E::E7b/E7b2` | `m46-browser-upgrade/m46-2-wrong-device-key.json`、`m46-3-missing-device-key.json`；`e2e-platform/E7b-device-transplant.json`、`E7b2-missing-device-header.json` | PASS | 真实 Runtime 与模拟 Runtime 均拒绝移植/缺失，401 + 原因头 |
| AC-31 | 签名密钥轮换：新旧 `kid` 并行；轮换后 60 天旧公钥可验旧凭证 | 未覆盖 | 无 | 无 | UNVERIFIED | 平台启动时生成单个 `kid`，JWKS 只含当前公钥，无轮换接口/旧钥保留期（见 G-07） |
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
