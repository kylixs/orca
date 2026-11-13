# 一期验收映射与补充验证报告（M70）

> 日期：2026-11-13
> 需求基线：`requirements.md` §8（AC-01 ~ AC-32）
> 映射文档：`../test-plan.md`
> 证据目录：`cloud-platform/evidence/m70-acceptance/`（gitignore，不提交）
> 结论：**暂不进入人工验收**（4 项 BLOCKER、6 项 MAJOR）

## 1. 环境

| 项 | 值 |
|---|---|
| 平台 | macOS Darwin 24.6.0，10 核 |
| Node | v24.5.0（直接执行 TypeScript） |
| Vitest | 5.0.3 |
| 并发 | 平台 `--test-concurrency=1`；Vitest `--maxWorkers=1`（单文件） |
| 说明 | 本轮未跑全量/`pnpm test`；负载高峰期只做单文件验证 |

## 2. 本轮实际执行的命令与结果

| 命令 | 结果 | 用例数 |
|---|---|---|
| `cd cloud-platform && node --test --test-concurrency=1 test/e2e/m70-acceptance.e2e.test.ts` | PASS | 6 pass / 0 fail |
| `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts --maxWorkers=1 src/main/cloud-platform/m70-acceptance.test.ts` | PASS | 1 pass / 0 fail |
| `cd cloud-platform && node --test --test-concurrency=1 --test-name-pattern="E3 " test/e2e/platform.e2e.test.ts` | PASS | 1 pass / 0 fail |
| `npx tsc -p config/tsconfig.node.json --noEmit` | PASS | exit 0 |
| `npx tsc -p config/tsconfig.tc.web.json --noEmit` | PASS | exit 0 |
| `pnpm run check:code-quality:changed` | PASS | 0 new findings / 411 changed files |

新增用例明细：

| 用例 | AC | 关键断言 |
|---|---|---|
| `AC-02 连续 5 次失败锁定 15 分钟…` | AC-02 | 前 4 次 401，第 5 次 423 `ACCOUNT_LOCKED`；正确密码仍 423；+15 分钟后 200；审计含 `locked: true` |
| `AC-03 无权限项目统一 404…` | AC-03 | 无权限/不存在均 404 同错误体，响应不含项目名；`project_access` denied 事件可查 |
| `AC-04 管理员登记并授权组…` | AC-04 | 成员项目列表可见，connect 返回 200 且签发凭证 |
| `AC-08 60 秒无心跳…` | AC-08 | connect 409 `HOST_OFFLINE`；`/v1/hosts` 显示离线；**项目列表仍显示 online（缺口）** |
| `AC-01 登录到项目列表 50 次采样…` | AC-01 | 50 次采样，P95=1.3ms ≤ 1500ms（仅 API 段） |
| `AC-25 吊销设备后访问令牌与刷新令牌立即失效` | AC-25 | 访问令牌 401、刷新令牌 401 |
| `M70 AC-09 主机维护模式::新连接被 409…` | AC-09 | 维护中新建票据 409 `HOST_MAINTENANCE`；已建会话 `status.get` 前后均 ok |
| `E3 伪造/过期凭证在升级期被拒`（加强） | AC-21 | 必须 401 且 `x-orca-reject` 非空（实测 `malformed`） |

证据：

- `cloud-platform/evidence/m70-acceptance/ac-01-login-latency.json`
- `.../ac-02-login-lockout.json`
- `.../ac-03-project-non-disclosure.json`
- `.../ac-04-project-grant.json`
- `.../ac-08-heartbeat-offline.json`
- `.../ac-09-maintenance.json`
- `.../ac-21-forged-credential.json`
- `.../ac-25-token-revocation.json`

## 3. 映射结果摘要

| 结论 | 数量 | 编号 |
|---|---|---|
| PASS | 7 | AC-02、AC-03、AC-09、AC-15、AC-16、AC-25、AC-30 |
| PASS(部分) | 17 | AC-01、AC-04、AC-05、AC-06、AC-07、AC-08、AC-10、AC-11、AC-12、AC-13、AC-17、AC-18、AC-20、AC-21、AC-24、AC-27、AC-28 |
| UNVERIFIED | 8 | AC-14、AC-19、AC-22、AC-23、AC-26、AC-29、AC-31、AC-32 |

UNVERIFIED 原因：

| AC | 原因 |
|---|---|
| AC-14 | 主机吊销后“已有连接 60 秒内断开”未验证。代码路径显示已登记主机只能经心跳拿到撤销集合，而吊销同时清空 `credentialHash`，下一次心跳 401，主机拿不到该项目的撤销记录（见 G-01） |
| AC-19 | 无前端/API 版本协商或旧版前端契约测试，需独立部署环境 |
| AC-22 | 300 并发 30 分钟需独立压测环境 |
| AC-23 | 单中继宕机需多中继部署与故障注入 |
| AC-26 | 3 副本 10 万条并发写入未验证；当前审计链是单进程内存 + 单文件 |
| AC-29 | 无云端主机公钥固定与关闭码 4433 的实现 |
| AC-31 | 平台只生成单个 `kid`，JWKS 只含当前公钥，无轮换/60 天旧钥保留 |
| AC-32 | 需 DMZ/WAF 真实外网环境 |

## 4. 产品缺口与文档偏差

严重度：BLOCKER = 阻断验收；MAJOR = 需决策/排期；MINOR = 记录即可。

| 编号 | 级别 | 问题 | 依据 |
|---|---|---|---|
| G-01 | BLOCKER | 主机吊销无法通知已登记主机：`DELETE /v1/hosts/:id` 清空 `credentialHash`，而已登记主机的撤销集合只来自心跳；心跳随后 401，已建直连会话不会收到 4403 | `cloud-platform/apps/api/src/server.ts:1449-1467`；`src/main/cloud-platform/cloud-agent-client.ts:198-236` |
| G-02 | BLOCKER | AC-29 未实现：仓库内无 4433 关闭码与主机公钥固定；`tls-certificate.ts` 的指纹固定只服务移动端配对 | `rg "4433" src cloud-platform` 无结果 |
| G-03 | BLOCKER | AC-31 未实现：启动时只生成一个 `kid`，JWKS 只返回当前公钥，无轮换接口与旧钥保留期 | `cloud-platform/apps/api/src/server.ts:179-182,669-670` |
| G-04 | BLOCKER | AC-26 多副本审计未实现：审计链是单进程内存 + 单文件，无多副本汇聚；3 副本 10 万条并发无法通过 | `cloud-platform/apps/api/src/audit.ts` 注释与实现 |
| G-05 | MAJOR | AC-08 工作台未按心跳超时禁用打开：项目列表 `hostStatus` 取持久化 `status`，60 秒无心跳后仍显示 online；本次实测 connect 才 409 | `cloud-platform/apps/api/src/server.ts:335-353`；`ac-08-heartbeat-offline.json` |
| G-06 | MAJOR | AC-27 文本与实现相反：文档写“读操作允许”，真实主机跨工作区读取返回 `forbidden`（更严格），与验收文本不一致，需产品确认以哪边为准 | `src/main/cloud-platform/cloud-workspace-boundary.test.ts:227-253`；`m36-1-read-scope.json` |
| G-07 | MAJOR | AC-27/AC-28 错误码不一致：真实主机返回 `forbidden` + 英文消息，文档写 RPC 错误 `PATH_OUTSIDE_ROOT` / `PERMISSION_MISSING`（后者仅平台契约与模拟器使用）。客户端若按码分支将无法匹配 | `src/main/runtime/rpc/rpc-caller-scope.ts:47-50`；`m34-1-readonly.json`；`m36-1-read-scope.json`；`cloud-platform/apps/runtime/src/policy-gateway.ts:181` |
| G-08 | MAJOR | 主机侧缺少拒绝审计：AC-11/21/27/28 要求“记录安全事件/鉴权失败审计”，真实 Runtime 与 runtime-sim 对拒绝路径均未写审计事件 | `rg "audit" cloud-platform/apps/runtime/src` 仅命中注释；`cloud-runtime-admission.ts` 无审计 |
| G-09 | MAJOR | AC-20 的 `PLATFORM_UNAVAILABLE` 未实现：平台停机时网络错误原样抛出，仅登录页文案表里有该 key；未验证“不做无凭证重连” | `src/renderer/src/cloud/cloud-login-panel.tsx:20`；`src/main/cloud-platform/cloud-connect-client.ts:140-236` |
| G-10 | MAJOR | AC-19 无前端独立发布兼容策略：API 无版本前缀/契约版本，静态资源与 API 同进程同发，旧前端兼容期无法验证 | `cloud-platform/apps/api/src/server.ts:1812-1829` |
| G-11 | MINOR | AC-02 锁计数在进程内存中，多副本部署时每个副本各算 5 次；单机验证通过不代表多副本 | `cloud-platform/apps/api/src/store.ts:137,173-194` |
| G-12 | MINOR | AC-05/AC-01 只测 API 段时延/线路，未做浏览器渲染 P95 与平台侧“无业务流量”的抓包证明 | 本轮用例范围 |
| G-13 | MINOR | AC-17 用测试内手动 `refresh()` 立即生效，未验证生产 10s 轮询在 30s 内端到端生效 | `src/main/cloud-platform/cloud-download-policy.test.ts:169-183`；`cloud-agent-client.ts:105` |
| G-14 | MINOR | AC-16 文档口径为“刷新令牌有效”，真实实现同时依赖磁盘会话文件；多设备/多用户目录隔离未测 | `src/main/cloud-platform/cloud-session-restart.test.ts:70-140` |

## 5. 文档与实现偏差汇总（不修改实现）

- AC-27 的“读允许”与真实主机边界相反；实现选择拒绝跨工作区读取。
- AC-27/AC-28 的错误码与真实主机返回不一致（`forbidden` vs `PATH_OUTSIDE_ROOT`/`PERMISSION_MISSING`）。
- AC-20 的 `PLATFORM_UNAVAILABLE` 只有文案，没有产生该码的代码路径。
- AC-29/31 的关闭码、密钥共存期在实现中不存在。

以上均按“文档偏差/产品缺口”记录，未为对齐文档改实现或放宽断言。

## 6. 结论

| 判定 | 说明 |
|---|---|
| 自动化补充验证 | 通过（8 条新/加强用例全绿，tsc 与质量门禁 0 问题） |
| 映射完整性 | 32 条 AC 全部有明确结论；8 条如实标注 UNVERIFIED 与前置条件 |
| 是否可进入人工验收 | **否**。AC-14/26/29/31 为 BLOCKER；另有 6 项 MAJOR 需决策或排期 |

建议下一步（按优先级）：

1. 决策并修复主机吊销的撤销通道（G-01）；补真实已登记主机 + 已建会话的 60 秒断连演练。
2. 决策 AC-27 读语义与 AC-27/28 错误码口径（G-06/G-07），再统一客户端映射。
3. 补主机侧拒绝审计（G-08），覆盖 AC-11/21/27/28。
4. 修复工作台离线禁用（G-05）与 `PLATFORM_UNAVAILABLE` 映射（G-09）。
5. AC-19/22/23/26/29/31/32 按 `test-plan.md` §5 的环境清单安排独立验证。

## 7. 遇到的问题

- 首版 AC-09 用例缺少设备注册与访问守卫，真实握手返回 `e2ee_error unauthorized`；补 `DeviceRegistry.adoptCloudDevice` 与 `installCloudAccessGuard` 后通过。属测试夹具问题，不是产品缺陷。
- 运行期间主机负载一度达到 14（10 核），已按 DEVELOPMENT_PROCESS §4.1 改为单文件、`--test-concurrency=1` / `--maxWorkers=1`，未并行拉起 e2e。
- 现场有一个 `cloud-platform/apps/api/src/server.ts` 进程（PID 81945，PPID=1，已运行 6 小时以上），不是本轮测试启动的；本轮创建的 API 子进程均随用例关闭。
