# 开发进度

> 更新时间：2026-11-13 13:55
> 规则：每轮只推进一个模块；失败必须如实记录。

## 模块状态

| 模块 | 状态 | 证据 | 备注 |
|---|---|---|---|
| M0 契约 | ✅ 完成 | `evidence/e2e-platform/` + 单元 10/10 | 凭证 Ed25519、方法映射、路径边界、审计链 |
| M1 平台 API | ✅ 完成 | E1–E8 | 登录锁定、会话纪元、ACL、凭证、策略、审计、内部接口 |
| M2 中继 | ✅ 完成 | E2、E10 | SNI ClientHello 解析、纯 TCP、黑洞、路由同步 |
| M3 运行时 + 策略网关 | ✅ 完成 | E3–E6 | 升级期验签、方法权限、路径边界、导出拦截 |
| M4 客户端 | ✅ 完成 | E1、E2 | 无凭证预检、直连优先、中继回落 |
| M5 Agent | ✅ 完成 | Web 主机页在线 | 注册、心跳、撤销同步 |
| M6 Web 前端 | ✅ 完成 | `evidence/web-ui/*.png` | 6 个页面 + 403 + 角色门禁 |
| M7 端到端 | ✅ 完成 | `evidence/e2e-platform/*.json` | 14 条用例全通过 |
| M8 管控面服务端门禁 | ✅ 完成 | `evidence/m8-admin-gating/` | 13 条用例：8 个管理接口 403、401、denied 审计、存在性不泄露 |
| M9 内部通道 mTLS | ✅ 完成 | `evidence/m9-mtls/` | 8 条用例：有效证书放行、无证书/异 CA 握手失败、CN 白名单、路径范围、令牌双重校验、中继与 Runtime 实际走 mTLS |
| M10 中继 SNI 白名单 | ✅ 完成 | `evidence/m10-relay/` | 8 条用例：后缀白名单、裸主机名/异后缀/多层子域拒绝、未知路由黑洞、非 TLS 拒绝、单 IP 并发上限、元数据不含负载 |
| M11 撤销关闭已建连接 | ✅ 完成 | `evidence/m11-revocation/` | 设备吊销后 4.2 秒内 `close(4403, device_revoked)`；合并入升级期同一撤销快照 |
| M12 控制面挂起韧性 | ✅ 完成 | `evidence/m12-control-plane-resilience/` | 请求可中止（Runtime active≤4，修复前 9）；响应体挂起时轮询继续；中继单飞 + 3 秒超时，首次同步不阻塞监听 |
| M13 真实 Orca Runtime 升级期准入 | ✅ 完成 | `evidence/m13-orca-admission/` | 在真实 `OrcaRuntimeRpcServer` 的 WS 升级前校验云端凭证：8 条真实升级用例；平台/主机验签实现一致性 7 条 |
| M14 开发机侧云端接入 | ✅ 完成 | `evidence/m14-cloud-agent/` | Agent 轮询 JWKS/撤销快照（单飞 + 超时）；`orca serve` 按 env 开启云端模式；4 条真实平台进程 + 真实 Runtime 端到端 |
| M15 云端会话撤销关闭（真实 Runtime） | ✅ 完成 | `evidence/m15-cloud-session-revocation/` | 准入时按凭证登记设备（`adoptCloudDevice`）；平台吊销后 `close(4403)`；3 条真实 E2EE 会话用例 |
| M16 控制面三路隔离与撤销快照 fail-closed | ✅ 完成 | `evidence/m15-cloud-session-revocation/isolation.txt` | 评审 07 F1/F2：三路独立落地（allSettled + 每请求独立 timeout）、非法撤销体保留上一快照；3 条真实进程用例 |
| M17 评审 07 遗留用例 | ✅ 完成 | `evidence/m17-review07-gaps/` | 4 条：公网内部路由 404（N6）、非默认 INTERNAL_TOKEN（M8）、TLS 中止分支、allow 正向放行；每条均做过回退变红对照 |
| M18 开发机自注册与心跳 | ✅ 完成 | `evidence/m18-host-enrollment/` | 一次性令牌注册、凭证持久化复用、心跳下发撤销/策略/维护态、心跳上报真实绑定端口与 E2EE 公钥；7 条真实平台进程 + 真实 Runtime 用例 |
| M19 桌面端云端连接客户端 | ✅ 完成 | `evidence/m19-desktop-connect/` | 登录/项目列表/选路/升级/E2EE/加密 RPC；Runtime 支持 WSS；4 条真实平台 + 真实 TLS Runtime 用例 |
| M20 渲染进程 IPC 会话面 | ✅ 完成 | `evidence/m20-cloud-ipc/` | `cloud:*` 六个通道 + 连接事件推送；会话状态不含任何令牌；5 条真实平台 + 真实 Runtime 用例 |
| M21 客户端界面（登录/工作台） | ✅ 完成 | `evidence/m21-cloud-ui/` | `CloudApp` + 登录面板 + 工作台列表；8 条界面用例（happy-dom），路由接入 `App.tsx` |
| M22 项目链接（凭证 → Orca 配对） | ✅ 完成 | `evidence/m22-project-link/` | 云端票据转成现有 `PairingOffer` + `cloudUpgrade`，现有 `subscribeRemoteRuntimeRequest` 直接建链（请求与订阅两条通道）；5 条真实平台 + 真实 TLS Runtime 用例，含"不带凭证必被拒"对照 |
| M23 质量门禁清理 | ✅ 完成 | `evidence/m23-quality-gate/` | 74 条 `consistent-type-assertions` → 0；JSON 字段读取器 + 票据/项目解析器；门禁 7 项扫描 0 新发现，79 条用例回归全过 |
| M24 项目工作区视图 | ✅ 完成 | `evidence/m24-project-workspace/` | 打开项目进入工作区（线路/根目录/能力/实时 status.get）；返回工作台只关连接可再开；21 条用例 + 78 条回归 + 门禁绿 |
| M25 云端项目 → 运行时环境 | ✅ 完成 | `evidence/m25-cloud-environment/` | 项目注册为环境（侧车 cloudProject），现有 selector/RPC/订阅直达；每次连接重签票据；顺带修复主机侧票据重放缺陷；7 条真实端到端 + 81 条回归 + 门禁绿 |
| M26 撤销时间语义 | ✅ 完成 | `evidence/m26-revocation-precision/` | 凭证新增 `iatMs`，消除同秒"收回→重授权"误拒；旧版无 `iatMs` 保持秒级比较；4 条真实平台 + 真实签名用例（修复前用例 2 为红） |
| M27 主机侧公钥过期 | ✅ 完成 | `evidence/m27-jwks-staleness/` | 真实主机新增 `jwks_stale`：超过 TTL 未成功拉取 JWKS 即拒绝新连接；吊销原因优先；3 条真实平台 + 真实 Ed25519 用例（回退后 2 条变红） |
| M28 设备公钥持有证明 | ✅ 完成 | `evidence/m28-device-pop/` | 主机把票据设备公钥登记并在 E2EE 认证时比对握手公钥，票据不再等于持有证明；拒绝原因透传；3 条真实端到端（关掉检查后负例变红） |
| M29 文件寻址契约对齐 | ✅ 完成 | `evidence/m29-file-contract/` | 模拟器改为真实 Orca 的 `worktree + relativePath`（旧 `path` 明确拒绝）；新增 readDir；分支名 `///` 缺陷修复；6 条新用例 + 整仓 80 条全过 |
| M30 项目根路径规范化 | ✅ 完成 | `evidence/m30-project-root/` | 登记处拒绝 `..`/相对/重复或尾随分隔符/控制字符；主机对旧平台票据做同形状复核（`workspace_root_invalid`）；4 条真实平台 + 真实签名用例（关掉检查后 2 条变红） |
| M31 审计链落盘与校验 | ✅ 完成 | `evidence/m31-audit-verify/` | 审计 JSONL 只追加落盘、重启续链；`GET /v1/audit/verify`（409 + brokenAtSeq）；弃坏行拒绝启动；14 条（含"改写文件后重启"真实进程用例） |
| M32 审计 fail-closed | ✅ 完成 | `evidence/m32-audit-fail-closed/` | 先写审计再改状态；写失败/断链时 6 类敏感写返回 503 且状态未变；读与登录保持可用；`GET /v1/audit/status`；3 条真实进程用例（chmod 只读、篡改后重启、全覆盖） |
| M33 云端会话并发上限 | ✅ 完成 | `evidence/m33-session-limits/` | 每用户每项目 3 路、每主机 32 路，超限 `close(4431)`；按活连接计、关闭即归还；2 条真实端到端（去掉配额检查后全红） |
| M34 云端 RPC 方法级权限 | ✅ 完成 | `evidence/m34-cloud-rpc-scope/` | 票据 `perms` 真正生效：终端/agent/文件读写/浏览器/下载分开判定，未登记方法拒绝；**修复云会话可访问 settings/accounts/pairing 的越权**；4 条真实端到端 + 11 条单测（回退后 4 条全红） |
| M35 下载策略与读取限速 | ✅ 完成 | `evidence/m35-download-policy/` | 主机消费平台策略包：导出 RPC 默认拒绝、项目覆盖优先；文件读取按项目滚动小时记次数与字节，超限 `read_budget_exceeded`；3 条真实端到端 + 8 条单测（关掉检查后 2 条变红） |
| M36 工作区路径边界 | ✅ 完成 | `evidence/m36-workspace-boundary/` | 票据 `projectRoot`/`workspaceRoot` 真正生效：读限项目根、写限本人工作区根，realpath 后校验（符号链接逃逸被拒）；绝对路径与未知 worktree 拒绝；3 条真实端到端 + 10 条单测（关掉检查后 3 条全红） |
| M37 git 操作边界 | ✅ 完成 | `evidence/m37-git-boundary/` | git 读方法限项目根、写方法（stage/commit/push/discard…）限本人工作区根，**共享主仓库对云端只读**；git 文件路径同受边界；4 条真实端到端 + 6 条单测（关掉分类后 3 条变红） |
| M38 worktree 操作边界 | ✅ 完成 | `evidence/m38-worktree-boundary/` | `worktree.create` 对云端拒绝（路径由主机设置推导、无法约束，指向未实现的托管创建）；`worktree.rm`/`forceDeleteBranch` 限本人工作区、`worktree.show` 限项目；无选择器的批量方法与其余 worktree 方法一律拒绝；4 条真实端到端 + 7 条单测（关掉分类后 3 条变红） |
| M39 托管工作区创建 | ✅ 完成 | `evidence/m39-managed-worktree/` | 真实 Runtime 新增 `worktree.createManaged`：调用方显式给根、宿主强制 `nestWorkspaces=false`，路径恰为 `<workspaceRoot>/<name>`；幂等键去重；云端作用域要求仓库属本项目、目标根属本人工作区；仅云构建注册；4 条真实端到端 + 8 条单测（关掉根覆盖后 M39-1 变红，关掉守卫后 4 条全红） |
| M40 打开项目按需建工作区 | ✅ 完成 | `evidence/m40-ensure-workspace/` | `cloud:openWorkspace` 改为「先列本仓库工作区，命中则复用，否则 `createManaged`」；repo 限定的 `worktree.list`/`detectedList` 对云端开放（仓库须属本项目）；打开结果新增 `workspacePath`，工作区视图展示"我的工作区"；3 条真实端到端（含真实 wss + 已注册主机 + 真实客户端类）+ 9 条单测（关掉复用后 M40-2 变红） |

## 最近一次测试结果

```
node --test test/contract.test.ts            11 pass / 0 fail
node --test test/e2e/platform.e2e.test.ts   16 pass / 0 fail
node --test test/e2e/admin-gating.e2e.test.ts 13 pass / 0 fail
node --test test/e2e/mtls-control-channel.e2e.test.ts 8 pass / 0 fail
node --test test/e2e/relay-hardening.e2e.test.ts 8 pass / 0 fail
node --test test/e2e/revocation.e2e.test.ts 1 pass / 0 fail
node --test test/e2e/control-plane-resilience.e2e.test.ts 3 pass / 0 fail
node --test test/cloud-admission-parity.test.ts 7 pass / 0 fail
node --test test/e2e/control-plane-isolation.e2e.test.ts 3 pass / 0 fail
node --test test/e2e/review07-gaps.e2e.test.ts 4 pass / 0 fail
合计 74 pass / 0 fail
```

M13（Orca 主进程侧，vitest）：

```
npx vitest run src/main/runtime/runtime-rpc-cloud-admission.test.ts  8 pass / 0 fail
npx vitest run src/main/cloud-platform                              12 pass / 0 fail
npx tsc --noEmit -p config/tsconfig.node.json                        通过
回归：runtime-rpc-websocket-bind-host / pairing-offer / device-revocation  33 pass
```

M22（本轮）：

```
npx vitest run src/main/cloud-platform/cloud-project-link.test.ts     5 pass / 0 fail
npx vitest run --config config/vitest.config.ts \
  cloud-session-service / use-cloud-session / connect-bound 回归        24 pass / 0 fail
npx tsc --noEmit -p config/tsconfig.node.json --composite false       通过（0 错）
npx tsc --noEmit -p config/tsconfig.web.json  --composite false       通过（0 错）
npx oxlint <改动文件>                                                  0 错
```

E2E 覆盖：
- E1 登录 → 项目列表 → 直连打开
- E2 直连不可达 → SNI 中继回落
- E3 伪造凭证升级被拒
- E4 方法级权限（无 file:write 被拒）
- E5 导出类方法拒绝
- E6 路径穿越 / 跨工作区写越界
- E7 撤销后旧凭证失效、新登录不可见
- E8a 畸形策略值：真实会话下 `files.download` 仍为 `EXPORT_DENIED`，Runtime 存活（不再指向已停机的 API）
- E8 平台停机 3.5 秒（跨过 3 次轮询）后 Runtime 存活、会话仍可读写
- E7a 符号链接写逃逸被拒（realpath + 分隔符感知）
- E7b 凭证移植到另一设备被拒（原设备同凭证仍可用）
- E7b2 缺失设备公钥头一律拒绝（不允许省略绕过）
- E7c 客户端版本过低返回 426
- E7d 托管工作区创建幂等且落在 workspaceRoot
- E9 证据汇总
- E10 中继未知 SNI 黑洞

M8 管控面门禁：
- 开发者访问主机/注册令牌/登记项目/授权/策略/归档/审计 8 个接口均 403
- 未登录访问管控面 401
- 被拒操作写入 denied 审计
- 未知项目与无权限项目响应完全一致（除 traceId），不泄露存在性

M9 内部通道：
- 中继与 Runtime 改用专用 HTTPS 监听（客户端证书 + CN 白名单）
- 无证书、异 CA 证书均在 TLS 握手期失败
- 内部监听只暴露 `/v1/internal/*`，其他路径 404
- mTLS 通过后仍需内部令牌（双重校验）
- JWKS 走公开监听，policy/revocations 走内部 mTLS；Runtime 日志 `policy synced v=1` 证明实际使用

## 第 5 轮评审修复

- MAJOR C-01：畸形 200 策略响应导致 Runtime 未处理拒绝退出 → 加响应形状校验（保留上一份策略）+ `authorize` 移入 try，新增 E8a 回归用例（配伪造控制面，实测进程存活）
- 控制面请求加 3 秒超时 + 单飞，平台黑洞时不再堆积悬挂连接
- 设备吊销写入撤销集合并经心跳/内部接口下发，Runtime 消费 `device_revoked`
- JWKS 加 5 分钟 TTL，超期拒绝新连接（`jwks_stale`）
- `createManaged` 幂等键按 project+device 命名空间；分支名含 `..` 直接拒绝而非改写
- 内部令牌同时接受 `INTERNAL_TOKEN` 与 `ORCA_CLOUD_INTERNAL_TOKEN`

M10 中继边界：
- SNI 必须命中 `<routeKey><suffix>` 形状（默认后缀 `relay.local`），裸主机名、异后缀、多层子域全部拒绝
- 白名单内但路由不存在 → 黑洞
- 非 TLS 首字节直接断开；单 IP 并发默认 100（测试用 5）
- 记录连接元数据（源 IP、SNI、routeKey、target、结果、原因），不含任何负载或凭证
- 说明：中继是 TLS 透传，**看不到也固定不了主机证书**；主机身份固定由客户端 TOFU 完成，中继只保证「只转发到已注册目标」

## 第 6 轮评审修复（终审 REJECTED → 3 MAJOR 已闭环）

- N1 策略覆盖值未校验：`{"proj_payment":123}` 被当成「非 deny」放行导出 → `parsePolicy()` 逐项校验，非法整份丢弃
- N2 撤销不关闭已建连接（AC-25）：Runtime 每秒对活动连接复查撤销快照，命中 `close(4403)` + 1 秒后 `terminate()`；实测吊销后 4.2 秒断开
- N3 超时不中止底层请求（M2 残留）：`mtlsFetch` 支持 `AbortSignal`，Runtime/中继改 `AbortSignal.timeout()` 并加单飞；实测 active 9 → ≤4，中继启动不再被首次同步阻塞
- N4 畸形 200 刷新新鲜度：仅接受合法策略时更新 `policyFreshAt`
- N5 E8a 曾指向已停机的 API（修复前也能通过）→ 重写为自包含真实会话用例
- N6/M8：配置 mTLS 后公网监听不再暴露 `/v1/internal/*`；平台同时接受 `INTERNAL_TOKEN`
- N8：撤销集合按目标去重；删除死代码 `usedJtis`
- 修复前/后对照：4 条新老用例在 stash 回退源码后实跑变红，恢复后全绿（详见 `reviews/design-review-06.md` §3）

## 阻塞

无。

## M13 真实 Orca Runtime 升级期准入（本轮）

在 Orca 主进程接入，而不是把替身逻辑搬过去：

- `src/main/cloud-platform/cloud-credential.ts`：Ed25519 验签（仅 `node:crypto`，可被平台测试进程导入）
- `src/main/cloud-platform/cloud-upgrade-admission.ts`：读 `Sec-WebSocket-Protocol` 的 `orca-cred.<token>` 与 `x-orca-device-pubkey`，校验主机绑定、撤销集合、设备公钥；拒绝时返回 `401` + `x-orca-reject`
- `WebSocketTransport` 新增可选 `upgradeAdmission`，经 `verifyClient` 在握手前执行（未传时行为与之前完全一致）
- `OrcaRuntimeRpcServer({ upgradeAdmission })` 透传，`orca serve` 后续接线只差取 JWKS 与撤销快照
- 平台与主机两份验签实现的**一致性测试**（`cloud-platform/test/cloud-admission-parity.test.ts`）覆盖合法/过期/篡改/未知 kid/结构损坏/未来签发

实测：真实服务端 + 真实 WS + 真实 Ed25519，8 条升级用例全过。

## M14 开发机侧云端接入（本轮）

- `src/main/cloud-platform/cloud-agent-client.ts`：10 秒轮询 `/v1/jwks` 与 `/v1/internal/revocations`，单飞 + 3 秒超时；响应结构非法时保留上一份，不清空
- `src/main/startup/cloud-runtime-admission.ts`：`ORCA_CLOUD_API_URL` 存在才启用云模式；缺 `INTERNAL_TOKEN`/`HOST_ID`/`HOST_NAME` 时**抛错拒绝启动**，不静默跳过准入
- `main-process-runtime-launch.ts`：把准入作为 `upgradeAdmission` 注入 `OrcaRuntimeRpcServer`；无 env 时展开为空对象，配对模式行为不变
- 顺带把 E2E WS 端口解析抽到 `e2e-runtime-ws-port.ts`（该文件已到 max-lines 上限，规则禁止禁用）

实测（真实平台子进程 + 真实 `OrcaRuntimeRpcServer` + 真实 Ed25519）：
- 从平台拉到 JWKS/撤销快照
- 平台 `/connect` 签发的凭证在真实 Runtime 升级成功
- 凭证换设备头 → 401 `device_mismatch`
- 吊销设备 → 下一轮轮询拿到 `device_revoked`，旧凭证升级 401

已知与本轮无关的既有失败：`src/main/startup` 有 5 条测试在改动前即失败（Electron 拷贝/资源类用例，环境相关），stash 对照确认非本轮引入。

## M15/M16（本轮）

**M15 真实 Runtime 的云端会话撤销**
- `DeviceRegistry.adoptCloudDevice()`：准入时用凭证里的 `deviceId`/`deviceToken` 登记，E2EE 握手才能通过（此前云端凭证过了升级闸门仍会卡在 `e2ee_auth`）
- `MobileSocketWiring.closeDeviceConnections()` + `WebSocketTransport.closeClientConnections()`：发 4403 关闭帧，1 秒未完成握手则 terminate
- `OrcaRuntimeRpcServer.closeCloudDeviceSessions(tokens)`：云端 Agent 轮询到撤销时调用
- 实测：真实平台进程 + 真实 E2EE 握手，吊销后 4403；未吊销的会话不受影响

**M16 评审 07 的 F1/F2**
- F1：三路控制面请求改 `Promise.allSettled`，每请求独立 `AbortSignal.timeout`（共享 signal 会在单端点挂起时连带中止健康响应）；`closeRevokedSessions()` 移出 try；首轮轮询不再阻塞 listen
- F2：撤销体结构非法（`{}`、字段类型错、单条畸形）一律返回 null 并保留上一份快照——此前会被当作「无撤销」覆盖，等于重新放行已吊销凭证
- 同类问题在主机侧 `cloud-agent-client.ts` 一并修复；JWKS 失败改为记录 `lastError` 而不是抛出，避免跳过撤销处理

## M17 评审 07 遗留用例（本轮）

评审 07 的 F7：四个已修行为缺少能失败的用例。

| 用例 | 断言 | 回退后 |
|---|---|---|
| 公网监听对 `/v1/internal/*` 404（mTLS 已配置） | 三条路由 × 三种令牌全部 404；`relay-endpoint` 仍可用真实令牌 200、错误令牌 401 | 改判定为 `false` → 变红 |
| 非默认 `INTERNAL_TOKEN` | mTLS + 非默认令牌 200；默认测试令牌 401 | — （实现已支持，此前无用例） |
| TLS 控制面挂起中止 | 真实 HTTPS 服务端，3.5 秒后 total≥3 且 active≤4 | 移除 abort 监听 → 变红 |
| allow 策略正向 | 项目策略 allow + 组授权含 `download` → `files.download` 返回 `NOT_IMPLEMENTED`（说明已过授权） | 让 exportClass 无条件拒绝 → 变红 |

F7-d 顺带确认了一条容易漏的语义：**allow 需要策略与授权两半都在**。仅把全局策略改 allow 仍会得到 `PERMISSION_MISSING`，因为种子授权里没有 `download`；显式项目策略又优先于全局默认，所以测试同时改项目策略与组授权。

## M18 开发机自注册与心跳（本轮）

此前开发机的身份（hostId/hostName）由 env 硬塞，平台侧不知道自己有这台机器，`/v1/hosts` 里看不到它。

- `cloud-host-enrollment.ts`：`POST /v1/hosts/register` 用一次性令牌换 `{hostId, credential}`；凭证写入 `orca-cloud-host.json`（`writeSecureJsonFile` + 加固权限）
- `cloud-agent-client.ts`：新增 `heartbeat` 模式，撤销/策略/维护态改由 `POST /v1/hosts/{id}/heartbeat` 下发；未配置时保持 M14 的内部路由轮询
- `cloud-runtime-admission.ts`：`ORCA_CLOUD_HOST_TOKEN` 存在即进入注册模式；注册完成前**拒绝所有升级**（`x-orca-reject: not_enrolled`），不会出现"没注册却照常服务"的窗口
- 两种模式共用同一套设备收养逻辑（`withDeviceAdoption`），否则校验通过后仍会卡在 `e2ee_auth`

实测（真实平台进程 + 真实 Runtime + 真实 E2EE 握手）：
- 注册后平台 `/v1/hosts` 显示该机在线，hostId 由平台分配（测试全程不读 env）
- 重启时复用持久化凭证，即使再给一个已消费的令牌也能起来
- 平台为这台机签发凭证 → 它自己的 Runtime 完成 E2EE 握手
- 吊销设备 → 心跳带回撤销 → 已建会话 4403
- 维护开关 → 心跳 `maintenance.reason` 可见

### 心跳上报真实地址（本轮补充）

注册时还没有监听，所以那一刻上报的地址只能是配置值。心跳改为每次实时解析：

- `advertisedAddrs(endpoint, advertiseHost, extras)`：取 Runtime 实际绑定的端口拼成 `host:port`
- 回环绑定（`127.0.0.1` / `::1` / `localhost`）在未配置 `ORCA_CLOUD_ADVERTISE_HOST` 时**返回空**——报一个别处拨不通的地址，客户端只会在连接时才发现，不如让它走中继
- `ORCA_CLOUD_ADVERTISE_HOST` 用于 NAT / 容器 / 反向代理后声明对客户端可见的主机名

实测：平台侧 `directAddrs` 等于 Runtime 的真实端口（不是 6768，也不是注册时的空值）。

## M19 桌面端云端连接客户端（本轮）

主进程侧的连接栈，是客户端补丁层的地基：

- `cloud-connect-client.ts`：`login` → `listProjects` → `requestTicket` → **无凭证 TCP 预检**（失败不消耗一次性凭证）→ 升级 → E2EE 握手 → 加密 RPC
- `chooseRoute()`：直连按优先级最多试 2 个，全部不通才试中继；直连能通时中继不会被选
- 主机侧新增真实 WSS：`OrcaRuntimeRpcServer({ webSocketTls })` 透传到 `WebSocketTransport`，端点格式随之变成 `wss://`

**过程中发现两个真实缺陷**：

1. **客户端没有主机公钥就无法建 E2EE**。注册发生在 Runtime 启动前，平台存的 `e2eePublicKey` 是空串；客户端用空 key 派生共享密钥会抛 `bad public key size`，而且是在 ws 的 message 监听里抛——表现为测试超时而不是报错。修法是心跳上报 `e2eePublicKeyB64`（平台接收并更新），客户端对长度非 32 的 key 显式拒绝（`HOST_KEY_INVALID`）。
2. `sessions.whoami` 是模拟器的方法，真实 Runtime 没有；用例改用真实方法 `status.get`，否则"加密通道打通"会被一个 method_not_found 掩盖成通过。

实测（真实平台进程 + 真实 TLS Runtime + 真实 E2EE）：登录/列表/直连打开/加密 RPC 全通；无权项目 404 且不出现在列表；选路纯函数覆盖直连优先、回落、全不可达；吊销后已建加密会话 4403。

## M20 渲染进程 IPC 会话面（本轮）

渲染进程不接触平台：token、设备密钥、WSS 都在主进程。

| 层 | 内容 |
|---|---|
| `shared/cloud-platform-ipc.ts` | 通道名 + 渲染进程可见的类型（无 token 字段） |
| `main/cloud-platform/cloud-session-service.ts` | 登录/登出/列表/打开/RPC，持有 `CloudConnectClient`；连接关闭时清空当前项目 |
| `main/ipc/cloud-platform.ts` | 六个 `ipcMain.handle` + 关闭事件广播；`installCloudPlatformIpc()` 在无 `ORCA_CLOUD_API_URL` 时返回 null |
| `preload/api/cloud-platform-*.ts` | `window.api.cloud.*`，订阅返回取消函数 |

**刻意约束**：`getState()`/`login()` 的返回值里没有 token、devicePubKey、deviceToken、credential——用例直接对序列化结果断言这些字段与 `eyJ` 前缀都不出现，防止以后有人"顺手"把凭证塞进 UI 状态。

实测（真实平台进程 + 真实 TLS Runtime）：
- 登录后状态只含展示名与项目摘要
- 项目列表区分下载受限（同用户下授权含/不含 `download` 各一）
- 打开项目返回选路与 workspaceRoot，加密 RPC 通
- 吊销后推送 `closeCode: 4403` 事件并清空 `connectedProjectId`
- 登出后 RPC 返回 `NOT_SIGNED_IN`

## M21 客户端界面（本轮）

| 文件 | 内容 |
|---|---|
| `renderer/src/cloud/use-cloud-session.ts` | 会话 hook：加载/不可用/未登录/登录中/已登录；宿主关闭连接时清空已打开项目 |
| `renderer/src/cloud/cloud-login-panel.tsx` | 域账号登录；平台错误码 → 中文文案，未知码原样显示 |
| `renderer/src/cloud/cloud-workbench.tsx` | 工作台：项目列表、线路徽标、主机离线禁开、下载受限标注、吊销提示 |
| `renderer/src/cloud/cloud-mode-gate.tsx` | 有 `window.api.cloud` 才切换到云端工作台，否则原样渲染本地 shell |
| `App.tsx` | 用 `CloudModeGate` 包住工作区与根浮层 |

全部使用 `components/ui` 原语与语义 token，无新增颜色；滚动容器按 lint 要求带 `scrollbar-sleek`。

**测试说明（如实记录）**：界面用例使用**脚本化 bridge**，因为 happy-dom 阻止跨源 fetch 到真实平台进程（实测报 `Cross-Origin Request Blocked`）。真实链路（平台进程 + TLS 运行时 + E2EE 套接字）由 M19 `cloud-connect-client.test.ts` 与 M20 `cloud-session-service.test.ts` 覆盖，本模块只保证"用户看到什么"。迁移过程中还修了两处测试自身问题：`import.meta.url` 在 web 变换下是 `/@fs/...`（需剥离），以及 vitest globals 关闭时 RTL 不会自动 cleanup（需显式 `afterEach(cleanup)`）。

实测 8 条：不可用态不显示登录表单；错误码文案与未知码回退；列表标注（离线 1 条、下载受限 2 条）；打开后显示"直连"；打开失败显示错误码且无"已打开"；4403 关闭显示"已被管理员收回"并清除线路；退出登录回到登录页。回归：`app-shell` 89 条全过。

## M22 项目链接：云端票据 → Orca 配对（本轮）

| 文件 | 内容 |
|---|---|
| `src/shared/remote-runtime-subscription-contract.ts` | 新增可选 `cloudUpgrade { credential, devicePubKey, servername?, tlsRejectUnauthorized? }`；缺省即普通配对主机，行为不变 |
| `src/shared/remote-runtime-upgrade-socket.ts` | 从会话传输中抽出开套接字：有 `cloudUpgrade` 时在升级子协议带 `orca-cred.<ticket>`、请求头带 `x-orca-device-pubkey`，并按线路设置 SNI / 证书校验 |
| `src/shared/remote-runtime-subscription-transport.ts` | 改用上面的开套接字函数；其余握手/心跳/清理逻辑不变（回归 62 条） |
| `src/main/cloud-platform/cloud-pairing-offer.ts` | 票据 → `PairingOffer` + `cloudUpgrade`；主机未上报 32 字节 E2EE 公钥时返回 `null`，避免把"握手超时"当失败 |
| `src/main/cloud-platform/cloud-connect-client.ts` / `cloud-session-service.ts` | `prepareProjectLink()`：只探测线路并取票，**不开连接、不消耗一次性票据** |
| `src/shared/cloud-platform-ipc.ts` + preload | `cloud:prepareProjectLink` 通道，返回值不含平台令牌 |
| `src/main/cloud-platform/cloud-route-selection.ts` | 抽出 `probeEndpoint` / `chooseRoute`（满足 300 行上限，未禁用规则） |

**为什么这么做**：工作区的终端、文件、流式通道都走同一套 `subscribeRemoteRuntimeRequest`。把云端票据表达成它已有的 `PairingOffer`（+ 一个可选升级参数），就不用再造一个并行客户端，M19 的 `CloudConnectClient` 只保留"预处理/选路/取票"的职责。

**端到端验证（真实平台进程 + 真实 TLS Runtime + 真实 Ed25519/NaCl）**：5 条全部通过，见 `evidence/m22-project-link/cases.txt`：

1. 预处理返回 `wss://` 链接与 `workspaceRoot`，且 `connectedProjectId` 仍为 null（票据未被消耗）。
2. 现有客户端带 `cloudUpgrade` 完成 E2EE 握手，收到真实 `status.get` 响应（`result`）。
3. 订阅通道（终端/流式所用）同样可建立。
4. **不带** `cloudUpgrade` 时主机拒绝升级——证明通过的第 2、3 条不是空转。
5. 主机缺 E2EE 公钥时立即返回 null，而不是等 30 秒超时。

回归：`cloud-session-service`、`use-cloud-session`、传输连接绑定 共 24 条通过；`tsc` node/web 均 0 错；oxlint 0 错（`evidence/m22-project-link/regressions.txt`、`checks.txt`）。

**质量门禁**：本轮修掉设计系统 1 条（`Badge` 上多余的 `text-muted-foreground`），并把 `cloud-platform/` 加入根门禁排除前缀（与 `PLAN.md` §0 一致）。当时仍有 74 条 `consistent-type-assertions`，已在 M23 全部清掉。

**如实记录**：渲染进程用 node 项目配置直接跑 `use-cloud-session.test.tsx` 会因 `@/` 别名未注册而失败（`Failed to resolve import "@/components/ui/button"`），必须带 `--config config/vitest.config.ts`；这不是代码问题，已按正确配置复跑通过。

## M23 质量门禁清理（本轮）

**问题**：M22 结束时 `check:code-quality:changed` 有 74 条 `typescript/consistent-type-assertions`，全部在 `src/main/cloud-platform/**` 与 `src/renderer/src/cloud/**`。多数是 `(await res.json()) as {...}`：形状错了不会报错，只会让 `undefined` 沿调用链传播。

| 文件 | 内容 |
|---|---|
| `src/shared/json-fields.ts`（新） | `readField/readString/readNumber/readArray/readStringArray/readObjectValue/ownEntries/errorCodeOf/parseJsonText`；形状不符返回 null，由调用方决定失败语义 |
| `src/main/cloud-platform/cloud-connect-response.ts`（新） | 票据/项目/端点/workspace 逐字段解析；缺字段返回 null |
| `src/shared/cloud-project-link-offer.ts`（新） | IPC 载荷 → `PairingOffer` 的结构化转换（`v===2 && scope==='runtime'` 才返回），M24 可直接复用 |
| `src/shared/http-header-text.ts`（新） | `x-orca-reject` 等响应头统一取文本 |
| `cloud-connect-client.ts` | 登录/列表/票据/握手消息全部走解析器；解析失败抛明确错误 |
| `cloud-agent-client.ts` / `cloud-agent-revocations.ts` | JWKS 与撤销快照改字段读取，撤销结构非法仍返回 null（保留 fail-closed） |
| `cloud-host-enrollment.ts` / `cloud-credential.ts` / `cloud-pairing-offer.ts` / `cloud-session-service.ts` | 同上一并替换；`cloud-session-service` 新增只读 `currentDeviceId`（只暴露标识，不含令牌） |
| `src/main/ipc/cloud-platform.ts` | Electron 参数边界保留 1 处 line-specific disable，带 SAFETY 说明 |
| 测试（6 个 cloud-platform 文件 + renderer hook） | 响应改读字段；吊销改用同一用户另行登录的令牌；不再访问私有 `session.client` / `client.accessToken` |

**结果（证据 `evidence/m23-quality-gate/`）**：

- `gate.txt`：`check:code-quality:changed` 7 项扫描全部 **0 new finding**，`Changed-code quality gate passed`（220 个改动文件）；`tsc` node/web 均 exit=0。
- `cases.txt`：10 个文件 **79 条** 全过——6 个 cloud-platform 用例文件仍是真实平台进程 + 真实 TLS Runtime + 真实 Ed25519/NaCl（撤销 4403、令牌不外泄、项目链接 5 条），runtime 准入 8 条，renderer happy-dom 8 条，门禁脚本自身 32 条。
- `regressions.txt`：shared 传输/配对回归 44 条全过。

**行为等价性**：替换都是"先读字段、再判空"；失败路径从 `undefined` 静默传播变为显式错误，正常路径字段与类型不变。

## M24 项目工作区视图（本轮）

**问题**：M21 打开项目后界面停在列表；M22 打通链路但用户看不到"进了工作区"。

| 文件 | 内容 |
|---|---|
| `renderer/src/cloud/cloud-project-workspace.tsx`（新） | 工作区：项目名、线路徽标、下载受限、工作区根目录、开发机能力、实时运行时状态（`status.get`）、刷新、返回工作台 |
| `renderer/src/cloud/cloud-app.tsx` | 有已打开项目 → 工作区；否则 → 工作台 |
| `renderer/src/cloud/use-cloud-session.ts` | 新增 `opened{projectId,workspaceRoot,capabilities,route}` 与 `closeProject()`；4403/登出/返回都会清空 |
| `shared/cloud-platform-ipc.ts` + preload + main ipc | 新增 `cloud:closeProject` |
| `main/cloud-platform/cloud-session-service.ts` | `closeProject()` 只关连接，保留令牌与设备密钥；再次打开同一项目无需重新登录 |

**端到端验证（`evidence/m24-project-workspace/`）**：

- `cases.txt` 21 条：界面 10 条（进入工作区显示根目录/能力/`已连接 · rt-1`、检查失败显示 `NOT_CONNECTED`、返回工作台调用 `closeProject`、吊销后回列表并提示）；真实平台进程 + 真实 TLS Runtime 会话 6 条（新增"返回工作台只关连接：会话仍在，可再次打开且 RPC 仍通"）；M22 项目链接 5 条。
- `regressions.txt` 9 个文件 78 条全过。
- `gate.txt`：7 项扫描 0 新发现、gate passed（221 文件）；tsc node/web exit=0。

**如实说明**：界面用例用脚本化 bridge（happy-dom 跨源限制），真实链路由同批真实进程用例覆盖；运行时 id 仅在主机上报时显示，否则只显示"已连接"；终端/文件面板尚未嵌入，界面文案已明确写出来。

## M25 云端项目 → 运行时环境（本轮）

**问题**：终端、文件、流式通道都按"环境 id"访问开发机，而 M24 到工作台为止，云端项目还没有身份。

| 文件 | 内容 |
|---|---|
| `shared/runtime-environments.ts` / `runtime-environment-sidecar.ts` | `cloudProject` 字段走侧车（`orca-environments.json` 保持旧版本可读） |
| `main/cloud-platform/cloud-runtime-environment.ts`（新） | 注册/移除环境；`callCloudRuntimeProject` / `subscribeCloudRuntimeEnvironment` 每次连接经 `prepareProjectLink` **重签一次性票据** |
| `main/cloud-platform/cloud-runtime-session.ts`（新） | 当前平台会话出口（传输层无 IPC 上下文） |
| `main/ipc/runtime-environment-transport-routing.ts` | `cloudProject` 环境走云端专用路径，**跳过**共享控制/缓存连接（否则会绕过票据） |
| `main/ipc/cloud-platform.ts` | 新通道 `cloud:openWorkspace`（打开 + 注册，返回 `environmentId`）；关闭时移除 |
| `shared/remote-runtime-request-socket.ts` | 一次性请求支持 `cloudUpgrade`，复用 `openRemoteRuntimeSocket` |

**顺带修复的真实缺陷**：测试"同一张票据只能握手一次"最初**失败**——真实主机只登记 jti 从不拒绝重放，被复制的票据在有效期内可重复建链。已加 jti 重放缓存（到期清理、吊销优先），并把 `401 + x-orca-reject` 透传为 `upgrade rejected (401, replayed)`；此前用户只能看到"连接失败"。

**验证（`evidence/m25-cloud-environment/`）**：7 条新增真实端到端（真实平台进程 + 真实 TLS Runtime + Ed25519/NaCl）：环境落盘带标记、连续两次 RPC 成功、无会话 `NOT_SIGNED_IN`、设备吊销 `SESSION_EXPIRED`、授权收回后 `PROJECT_NOT_FOUND`、票据重放被拒、移除后不可解析。回归 12 个文件 **81 条**全过；门禁 7 项 0 新发现、tsc node/web 0 错。

## M26 撤销时间语义（本轮）

**问题**（此前列为待确认）：凭证 `iat` 是整秒、撤销 `since` 是毫秒，比较为 `iat*1000 <= since`。管理员在同一秒内"收回→重新授权"后，新票与旧票同秒，被当成旧票拒绝，用户被多锁最多 1 秒。

**做法（不放宽 fail-closed）**：凭证载荷新增可选 `iatMs`（毫秒），平台签发时写入；主机准入用 `iatMs ?? iat*1000` 比较。旧版不签 `iatMs` 时行为完全不变；模拟器 runtime 的 policy-gateway 同步。

**验证（`evidence/m26-revocation-precision/`）**：4 条真实平台进程 + 真实 Ed25519 用例：

1. 撤销前签发的票据，撤销后被拒（`project_revoked`）——撤销立即生效不受影响。
2. 同一秒内收回→重新授权，新票据被接受。**该用例先跑红**（`expected {ok:true}` / `received {ok:false}`）才改代码。
3. 旧版无 `iatMs` 的票据仍按秒级比较（同秒内被拒）——向后兼容。
4. 授权收回期间平台拒绝签发新票（`PROJECT_NOT_FOUND`）。

平台自身契约 + M11 撤销 e2e 28 条通过；门禁 7 项 0 新发现、tsc node/web 0 错。

## M27 主机侧签名公钥过期（本轮）

**问题**：设计文档与模拟器都有 `jwks_stale`，**真实 Orca 主机没有**。主机只在启动时拉一次 `/v1/jwks`，平台长期不可达时仍用旧公钥验票，平台轮换掉的密钥在主机上永久有效。

| 改动 | 内容 |
|---|---|
| `cloud-upgrade-admission.ts` | 新增 `keysFetchedAt` / `keysTtlMs`（默认 5 分钟）；超窗返回 `jwks_stale` + `x-orca-reject` |
| `cloud-agent-client.ts` | 只在**成功**拉取 JWKS 时记录时间戳；新增可注入 `now` / `keysTtlMs`（测边界用） |

顺序上吊销优先：被撤销的连接仍报 `project_revoked`，不给用户看"公钥过期"。

**验证（`evidence/m27-jwks-staleness/`）**：3 条真实平台进程 + 真实 Ed25519 票据——TTL 内放行/超窗拒绝/刷新恢复、刷新失败不延长新鲜度、吊销原因优先。**把修复注释掉后用例 1、2 变红**（2 failed / 1 passed），恢复后转绿。回归 11 个文件 61 条全过；门禁 7 项 0 新发现、tsc node/web 0 错。

## M28 设备公钥持有证明（本轮）

**问题**（评审 05/06 的 M1 遗留）：票据带 `devicePubKey`，客户端只需在升级头里复述它；主机只比对「头 == 票据」，任何拿到票据的人都能过升级检查——票据是持票证明，不是设备持有证明。

| 改动 | 内容 |
|---|---|
| `runtime/device-registry.ts` | 云设备登记保存票据公钥 `publicKeyB64` |
| `startup/cloud-runtime-admission.ts` | 准入通过后把 `devicePubKey` 交给 `adoptCloudDevice` |
| `runtime/rpc/e2ee-channel.ts` | 认证成功且设备登记了公钥时，比对握手公钥；不一致 → `e2ee_error(device_proof_failed)` + close 4001 |
| `shared/remote-runtime-*-contract/transport/socket` | 新增 `clientKeyPair`，握手使用设备密钥；一次性请求同样支持 |
| `cloud-session-service` / `cloud-connect-client` | `deviceKeyPair()`（仅主进程，不经 IPC） |
| `shared/remote-runtime-client-handshake.ts` | 解析 `e2ee_error` 的 code 并给出可行动文案 |
| `shared/cloud-platform-ipc.ts` + preload | 删除无效的 `cloud:prepareProjectLink`（renderer 从未调用、无 handler、且会把票据送进渲染进程） |

**验证（`evidence/m28-device-pop/`）**：3 条新增真实端到端（真实平台 + 真实 TLS Runtime）——设备密钥握手成功并拿到真实响应；**换一对密钥被拒且无任何响应**（注释掉检查后该用例变红）；主机确实登记了票据公钥。M22/M25 既有用例现在必须显式携带设备密钥才能通过，即 PoP 已生效。回归 17 个文件 117 条全过；门禁 7 项 0 新发现、tsc node/web 0 错。

**如实记录**：全量 `src/main/runtime` 有 17 条既有失败（`agent-launch-*`、`agent-session-conversation-clear-commit`），把本模块改动 stash 后在 HEAD 上同样失败，确认与本轮无关；另有一次并行运行中 `cloud-revocation-precision` 单条抖动，单独与整目录运行均通过。

## M29 文件寻址契约对齐（本轮）

**问题**（评审 05/06 的 M6 遗留）：真实 Orca 用 `{ worktree, relativePath }` 寻址文件，模拟器却接受项目绝对 `path`。按模拟器写的客户端能通过全部评审，接上真实主机后每个文件操作都会失败。

| 改动 | 内容 |
|---|---|
| `apps/runtime/src/file-request-paths.ts`（新） | 只接受真实契约；缺 `relativePath`/只传 `path` → `MISSING_RELATIVE_PATH`；绝对路径/`..` → `PATH_OUTSIDE_ROOT`；未知 worktree → `WORKTREE_NOT_FOUND`；写只允许本人工作区 |
| `policy-gateway.ts` | 授权同样按 `worktree + relativePath` 判定（不再有"先授权后解析"两套规则）；新增 `executeReadDir` |
| `runtime-sim.ts` | 接入解析器；新增 `files.readDir`（真实 `FileTreePath`） |
| 既有 e2e | 全部改用 `worktree + relativePath`（`projectFile`/`workspaceFile` 助手） |

**顺带修的缺陷**：分支名 `///` 清洗成 `---` 后被接受，会造出与任何分支无关的目录；现在要求清洗后必须含字母或数字。

**验证（`evidence/m29-file-contract/`）**：6 条新用例（真实平台进程 + 真实 TLS Runtime + 真实 Ed25519）——真实形状读写、旧形状明确拒绝、绝对/穿越/未知 worktree 拒绝、写边界、符号链接逃逸、分支名非法与幂等回放。整仓 cloud-platform **80 条全过**（含迁移后的 platform.e2e 16 条）。

**如实记录**：迁移后整仓首次运行 `cloud-admission-parity.test.ts` 失败——M23 给 `cloud-credential.ts` 引入 `shared/json-fields` 导入，违背该模块"零依赖、可被平台测试直接导入"的不变量；已收回 5 行 `ownEntries` 并注明原因。该测试此前一直红而未被发现（M23 只跑了 vitest 侧，未跑整仓 `node --test`）。

## M30 项目根路径规范化（本轮）

**问题**（评审 M5 遗留）：`path` 被原样签进票据。`/srv/work/svc/../../etc` 在平台与主机两侧都按 `..` 规范化，凭证实际覆盖 `/srv/etc` 一类没被授权的目录——"以为的路径"与"生效的路径"不一致。

| 改动 | 内容 |
|---|---|
| `packages/contract/src/project-path.ts`（新） | 拒绝相对路径、`.`/`..` 段、重复/尾随分隔符、控制字符、POSIX 混用反斜杠；返回 `PROJECT_PATH_INVALID` |
| `apps/api/src/server.ts` | 登记处校验，拒绝时写 `result: denied` 审计（含原始路径），不创建项目 |
| `src/main/cloud-platform/cloud-upgrade-admission.ts` | 主机对票据 `projectRoot`/`workspaceRoot` 做同形状复核，不符合 → `workspace_root_invalid`（兼容仍会签发旧路径的旧平台） |

**验证（`evidence/m30-project-root/`）**：4 条真实平台进程 + 真实 Ed25519 用例——非法路径 400 且不留项目；合法路径票据 `projectRoot` 逐字节一致；主机拒绝真实签名但根含 `..` 的票据、同签名者合法根放行；被拒登记无残留。**把两处检查分别注释掉后用例 1、3 变红**。整仓 cloud-platform 80 条全过；门禁通过、tsc node/web 0 错。

**如实记录**：首版把 POSIX 前导 `/` 当成空段，合法路径被误拒（用例 2 先红），已修正；控制字符检查原用字符类正则触发 `no-control-regex`，改为按码点判断（未用 disable）。

## M31 审计链落盘与完整性校验（本轮）

**问题**：设计要求"单写入序列 + 哈希链 + WORM"，但审计链只在内存里——重启即归零，无从篡改也无可校验；同时 `AuditChain.verify()` 没有任何出口，运维只能读事件、无法判断是否被改过。

| 改动 | 内容 |
|---|---|
| `apps/api/src/audit-log-file.ts`（新） | 只追加 JSONL；解析失败报 `AUDIT_LOG_CORRUPT`（跳过坏行等于静默截断链） |
| `apps/api/src/audit.ts` | 可选持久化 sink；`restore()` 在服务前回填历史链（seq/tip），重启后 `prevHash` 续接不分叉；`verify()` 报告 `checked`/`tip`/`brokenAtSeq` |
| `apps/api/src/server.ts` | 新增 `GET /v1/audit/verify`：通过 200、断链 **409**、无权限 403；每次校验尝试本身入链。`AUDIT_LOG_PATH` / `AuditConfig.auditLogPath` 启用落盘，未设置时保持纯内存 |

**验证（`evidence/m31-audit-verify/`）**：14 条。进程内 7 条用真实 SHA-256 证明改正文、删事件、只改 hash、改 metadata 都会被检出并定位；真实进程 7 条证明校验入链、权限与拒绝审计、翻页无重复、无令牌不泄露、**重启续链**、**改写日志文件后重启返回 409 且 brokenAtSeq 命中**、**坏行时拒绝启动**。整仓 87 条全过。

**如实记录**：没有用进程内篡改冒充端到端——先补落盘再做"改文件重启"的真实用例。断链时平台仍启动并服务（运维需要排查入口），是否对敏感操作 fail-closed 留待下一轮决定；既有 `contract.test.ts` 的 `deepEqual(verify(), {ok:true})` 已随返回值扩展更新。

## M32 审计 fail-closed（本轮）

**问题**：设计 §13.2 要求"审计写入失败时拒绝该敏感操作"，但实现是先改状态再写审计，写失败只变成 500——**变更已经生效却没有任何记录**；断链也只影响 verify 接口，敏感操作照常执行。

| 改动 | 内容 |
|---|---|
| `apps/api/src/audit.ts` | 健康状态：`write_failed`（瞬时，成功写入后自动清除）/ `chain_broken`（持续到修复并重启）；`appendBestEffort` 供非变更事件 |
| `apps/api/src/server.ts` | **write-ahead audit**：`recordAudit()` 先写事件，失败即 503 且不执行变更；覆盖项目创建/归档、授权、设备吊销、主机令牌、维护、策略 |
| 同上 | 预检只拦 `chain_broken`；`write_failed` 放行以便磁盘恢复后自愈 |
| 同上 | 登录/读取/`/health`/`/v1/jwks` 保持可用；新增 `GET /v1/audit/status` |

**验证（`evidence/m32-audit-fail-closed/`）**：3 条真实进程用例——日志 chmod 0400 后创建项目 503 且**项目确实没建**、chmod 恢复后自动回到 201；篡改日志重启后 503 `AUDIT_CHAIN_BROKEN`、verify 仍 409、用原始日志重启即恢复；一次覆盖 5 类敏感写全部 503 且逐项复核状态未变。整仓 **97 条**全过。

**如实记录**：两版实现都是被测试推翻的——首版只做预检 + 后置审计，实测首次失败是 500 且项目已创建；次版把状态锁死导致永远无法恢复。最终为"先写审计再变更 + write_failed 可自愈"。副作用：崩溃在两步之间会多记一条未生效事件（over-report），已在注释与 summary 中说明。

## M33 云端会话并发上限（本轮）

**问题**（设计 §8.4）：要求"每用户每项目最多 3 个会话、每主机最多 32 个连接，超出返回 4431"，但代码里只有与云无关的 128 连接上限；`grep 4431` 在整个 `cloud-platform/` 与 `src/main/` 中零命中。平台不在数据通路上，看不到这些连接，只能在主机侧计数。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-session-limits.ts`（新） | 按 `(user, project)` 与全主机计数；键为票据的 deviceToken（每票唯一），**按活连接计而不是按票据计**——票一次性，会话比票活得久 |
| `cloud-agent-client.ts` | 准入成功时记下票据文本 → `(sub, project, deviceToken)`；`connectionGate.accept()` 在 socket 建立时占用配额，`release()` 在关闭时归还；吊销时同步释放 |
| `runtime/rpc/ws-transport.ts` | 新增可选 `connectionGate`：升级已成功后按 `req.headers` 计数，超限 `ws.close(4431, 'Too many sessions')` 并 1s 后 `terminate()`；`close` 事件归还配额（含握手未完成就断开的连接） |
| `node-websocket-lifecycle.ts` | 抽出通用 `closeNodeWebSocket()`，新增 `rejectNodeWebSocketOverSessionLimit()`（4431） |
| `runtime-rpc-{state,pairing-types,lifecycle}.ts` / `startup/cloud-runtime-admission.ts` | 把 `connectionGate` 像 `upgradeAdmission` 一样贯穿到 transport；enrolled 模式下用委托对象，因为 transport 先于异步注册完成构造 |
| `renderer/cloud/cloud-close-notice.ts`（新） | 4403/4431 给用户可行动的文案（"先关闭其他会话"），两处云视图共用 |

**为什么不在升级前拒绝**：`verifyClient` 的拒绝是 HTTP 401 + `x-orca-reject`，没有 WebSocket close 帧，带不出 4431；而"会话"本来就要等 socket 存在才算数，所以计数点放在 `connection` 事件，超限发 4431 关闭帧——同时解决了"票据被签发但握手没完成"的泄漏问题。

**验证（`evidence/m33-session-limits/`）**：2 条真实端到端（真实平台进程 + 真实 Runtime + 真实 Ed25519 票据 + 真 NaCl 握手）：
- M33-1 用生产接线（默认上限 3）：3 路握手成功 → 第 4 路被 **4431** 关闭 → 关闭 1 路后新会话重新可用；
- M33-2 主机上限（测试把阈值降到 4 以便快速验证，代码路径与生产一致，两个用户各 2 路）：第 5 路 4431，释放一路后恢复。

把 `accept` 改成恒真后两条用例立即变红（计数 0），确认测的是新逻辑。cloud-platform 主机侧 12 个文件 52 条在 Node 下全过；`tsc` node/web 0 错；changed-code 门禁 7 项 0 新发现。

**如实记录**：本仓库 `pnpm test` 固定用 Bun 跑，Bun 的 `ws` 客户端对自签名 TLS 握手失败，导致 6 个**既有**的云测试文件（`cloud-device-pop`、`cloud-session-service` 等）在 Bun 下红；`git stash` 后在 HEAD 上复现同样失败，且在 Node 下全部通过，与本轮无关（本轮新用例走 ws:// 明文，两种运行方式都通过）。另外发现 Bun 的 `ws` 会把正在派发的消息重投给派发中新加的 `once` 监听器，握手助手已改为单一持久监听 + 幂等状态机。

## M34 云端 RPC 方法级权限（本轮）

**问题**（设计 §7.3，原 T302）：票据里签了 `perms`，但主机侧从未看过它——`runtime-rpc-websocket-dispatch` 把所有非 mobile 设备一律当 `runtime-paired`，而该作用域自带 `workspace`/`settings-write`/`accounts-admin`/`skills-admin`/`host-admin`。**结果：任何云会话（哪怕只被授予 `open`）都能读写主机设置、列账号、读取配对信息**，这是越权提升，不只是"缺功能"。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-rpc-permission.ts`（新） | 方法 → 项目权限：`terminal.*`/`git.*`/`worktree.{create,createManaged,rm}` → `terminal`；`agent*` → `agent`；`files.read*` 等 → `file:read`；`files.write|create|rename|copy|delete|commitUpload` → `file:write`；`browser.*` → `browser`，但导出类（`browser.download|savePage`、`files.download*`、`terminal.exportArtifact`）优先判 `download`；`status.get` 任何已准入会话可用；**未登记 → 拒绝** |
| `runtime/rpc/rpc-caller-scope.ts` | 新增 `RpcCallerScope = { kind: 'cloud'; permissions }`，拒绝文案指明缺哪个项目权限 |
| `runtime/runtime-rpc/runtime-rpc-websocket-dispatch.ts` | 有 `cloudSession` 的设备走 `cloud` 作用域，不再落到 `runtime-paired` |
| `runtime/device-registry*.ts` | `DeviceEntry.cloudSession = { projectId, permissions }`；采纳时从票据写入；**落盘读取时逐字段校验，解析失败即丢弃（失去权限）而非保留** |
| `startup/cloud-runtime-admission.ts` | 采纳设备时带上票据的 `project` 与 `perms` |

**验证（`evidence/m34-cloud-rpc-scope/`）**：4 条真实端到端（真实平台进程签发的真实 Ed25519 票据 + 真实 Runtime + 真 NaCl 加密 RPC）：
- M34-1 只授 `file:read` 的项目：`files.read` 通过网关（失败原因是 handler 的未知 worktree，不是 `forbidden`），`files.write`/`terminal.create` 被 `forbidden` 且文案指明缺 `file:write`/`terminal`；
- M34-2 只授 `terminal` 的项目：`terminal.list` 成功，`files.read` 被拒；
- M34-3 `settings.get`、`accounts.list`、`pairing.getEndpoints`、`host.platform` 全部 `forbidden`，`status.get` 仍可用；
- M34-4 同一用户同一主机两张票据各自生效。

另有 11 条映射单测。**把 dispatch 的 cloud 分支去掉后 4 条端到端全部变红**（报 `runtime_unavailable`，因为回落到配对作用域后又被 `files.read` 的 handler 拒绝，正好说明权限来自票据而非别处）。cloud-platform 主机侧 14 文件 67 条、模拟器 97 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 已知取舍**：
1. `files.open`、`files.openDiff` 等面板会用到的方法目前**未登记 → 默认拒绝**。这是设计要求的 deny-by-default 直接后果，接入文件面板时必须逐条登记（届时一并补用例），不能靠"先加上"绕过。
2. 主机现有 `files.*` 方法仍只声明粗粒度 `workspace` 权限；本轮在云端作用域上先做项目级细分，仓库全局的方法权限模型未改动（避免影响非云配对设备）。
3. 本轮顺带发现：`settings.get` 的声明权限是 `workspace`，所以此前云会话确实能读主机设置；现在被云端映射拒绝。

## M35 下载策略与读取限速（本轮）

**问题**（设计 §9 / AC-10、AC-17，原 T304）：平台每次心跳都下发策略包（`policies.downloadDefault`、`projectOverrides`），**主机侧解析心跳时直接把它扔了**；`/v1/internal/policy` 接口存在，但轮询模式的客户端从不调用。结果 §9 的"专用导出 RPC 由主机拒绝"只有 ACL 一层：被授予 `download` 的用户在策略禁止的项目上照样能调 `browser.download`；`files.read` 也完全没有记账限速。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-policies.ts`（新） | 解析策略包：缺 `downloadDefault` 即整包不可用（**不能把"没读懂"当成 allow**）；非法限速回落默认有界值 |
| `cloud-platform/cloud-access-guard.ts`（新） | 项目级滚动小时预算（次数 + 字节）；无策略包时下载关闭、读取仍有界；字节在回复后记账，因此拦住的是**下一次**读取 |
| `cloud-agent-client.ts` | 心跳与 `/v1/internal/policy` 两条通道都解析策略并保留上一份有效包；快照暴露 `policies`/`policyVersion` |
| `rpc-caller-scope.ts` | 云端作用域新增 `downloadAllowed`：**策略优先于票据**——已准入的会话也会立刻受管理员改动约束 |
| `runtime-rpc-websocket-dispatch.ts` | 读方法先扣配额，超限回 `read_budget_exceeded`（含用量），并把回复字节记入预算 |
| `runtime-rpc-{state,pairing}.ts` / `startup/cloud-runtime-admission.ts` | `setCloudAccessGuard` + `installCloudAccessGuard`（生产与测试同一条接线） |
| 平台 `store.ts` / `server.ts` / `policy-rate.ts`（新） | 策略新增 `readRatePerHour` 与项目覆盖；全局 `PUT /v1/policies/download`、项目 `PUT /v1/projects/{id}/policy` 均可设置，非法值 400 `POLICY_INVALID` |

**顺带修的两个真实缺陷**：
1. **全局开关此前是死的**：平台把每个项目的 `downloadPolicy` 都当作覆盖下发，而项目默认 `deny`，所以"全局 allow"对任何项目都不生效。改为只有管理员显式写过策略的项目才作为覆盖下发（`downloadPolicyExplicit`），未动过的项目继承全局默认。
2. **项目策略写入绕过了 M32 的 fail-closed**：项目级 `/policy` 用的是 `audit.append` 而非 write-ahead，审计不可写时仍会改策略。已改为 `auditAllowsMutations` + `recordAudit`。

**验证（`evidence/m35-download-policy/`）**：3 条真实端到端（真实平台进程 + 真实 Ed25519 票据 + 真实 Runtime + 真 NaCl 加密 RPC）：
- M35-1 票据有 `download` 权限但策略默认 deny → `browser.download` 被 `forbidden` 且文案指出是策略；管理员放开全局 → 同一会话立即可通过网关（失败点变成 handler）；再写项目级 deny → 又立刻被策略拒绝；`policy_update` 事件已入审计且链仍通过 verify。
- M35-2 项目限速 3 次/小时：前 3 次 `files.read` 通过网关（失败原因是 handler），第 4 次 `read_budget_exceeded`（`3/3`）；放宽到 50 次后**无需重连**即可继续读。
- M35-3 `calls: 0` 被平台 400 拒绝；`readRatePerHour: null` 清除覆盖并回落到全局预算。

另有 8 条单测（策略解析、deny-by-default、覆盖优先级、滚动窗口、字节记账、项目隔离）。**分别关掉策略判定与配额检查后 M35-1、M35-2 立即变红**。cloud-platform 主机侧 16 文件 78 条、模拟器 97 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：设计 §9.1 的三层里，本轮做实了"主机拒绝专用导出 RPC + 读取记账限速"；**受管客户端隐藏下载入口（UI）与主机 `will-download` 拦截尚未接入**——前者属于后续面板接入，后者需要 host-hosted 浏览器面板落地后才有效；`files.download`/`files.downloadFolder` 在当前 Mainline RPC 中并不存在，映射表先按设计登记，将来新增即自动受约束。

## M36 工作区路径边界（本轮）

**问题**（设计 §8.3 第 4 步 / AC-11 / AC-27，原 T301b、T303）：票据里签了 `projectRoot` 与 `workspaceRoot`，但真实 Runtime 的文件 RPC **完全按客户端给的 `worktree` 选择器解析**——`files.read`/`files.write` 只校验相对路径形状，不校验解析出来的目录在不在项目里。也就是说：任何云会话都能读**主机上任意 worktree**（别的团队的项目、别人未提交的分支），有 `file:write` 的还能往里写。M34 只解决了"能不能调这个方法"，没有解决"能碰哪些文件"。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-path-boundary.ts`（新） | 分隔符感知的根包含（`/srv/svc` 不含 `/srv/svc-evil`）+ `realpath` 解析（不存在的新文件按最近已存在祖先解析）；读限 `projectRoot`，写限 `workspaceRoot` |
| `cloud-platform/cloud-path-guard.ts`（新） | 在 handler 之前把 `worktree` 选择器解析成真实目录并校验；`rename`/`copy` 的两条路径都查；绝对路径单独拒绝（`path.join` 会把 `/etc/passwd` 当成相对段） |
| `runtime-rpc-websocket-dispatch.ts` | 云端会话的文件 RPC 先过边界；**仅在票据本身带该权限时**才做路径判定，缺权限的调用仍由权限层给出"needs 'file:write'"的文案 |
| `runtime/orca-runtime-persist-headless-terminal-title.ts` | 新增公开的 `resolveWorktreeRootPath()`，复用既有的选择器/执行主机解析，不另起一套 |
| `runtime/device-registry*.ts` | `cloudSession` 记录 `projectRoot`/`workspaceRoot`；落盘读取时缺根即丢弃整条云会话（无法执行边界的记录不能默认成"哪都能去"） |
| `startup/cloud-runtime-admission.ts` | 采纳设备时带上票据的两个根 |

**验证（`evidence/m36-workspace-boundary/`）**：3 条真实端到端——真实平台进程签发的真实 Ed25519 票据、真实 Runtime、真实 `OrcaRuntimeService` + 真实 SQLite store，store 里**真的注册了两个 git 仓库**（本项目与另一团队的项目），并且用 `git worktree add` 造出真实的工作区：
- M36-1 项目内 `files.read` 成功并拿到真实内容；另一团队的 worktree 被 `forbidden`（`This worktree is outside the project...`）；`../..` 穿越与项目内 `escape` 符号链接（指向另一团队目录）都被拒；
- M36-2 `files.write` 在工作区根内成功；写项目共享目录被 `forbidden`（`Writes are limited to your own workspace root`），**并且重新读取确认共享文件未被改动**；
- M36-3 绝对路径被拒、未知 worktree 选择器被拒（`not available to the cloud session`）。

另有 10 条单测（分隔符感知、真实符号链接、不存在文件的祖先解析、rename 双路径、绝对路径）。**关掉路径判定后 3 条端到端全部变红。** cloud-platform 主机侧 18 文件 91 条、模拟器 97 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录**：
1. 首次跑整仓模拟器测试时出现一次 `unknown_kid`（期望 `device_revoked`），与质量门禁并行运行；单独重跑 97/97 通过，判定为并行负载下的既有抖动，本轮未改动模拟器任何代码。
2. 本轮只覆盖**文件类 RPC**（`files.*`）。`terminal.*`/`git.*` 的 `worktree` 选择器仍只受"M34 权限层"约束，尚未做根包含校验——终端一旦打开就能 `cat` 任意文件，设计 §9.4 已把它列为**不可阻断**、靠出网白名单与命令审计缓解；git 的根包含留待下一轮（需同时确认 `git` 命令本身的工作目录边界）。

## M37 git 操作边界（本轮）

**问题**（设计 §8.3「主仓库目录默认只读」、§7.3 git 随 terminal 授予，原 T303 的 git 部分）：M36 只给 `files.*` 加了路径边界，`git.*` 仍只受 M34 的"方法级"权限约束——票据带 `terminal` 就能对**任意 worktree** 执行 `git.stage`/`git.commit`/`git.discard`。也就是说：任何云用户都能直接在**共享主仓库**上提交或丢弃别人的改动。M36 的备注里已如实写明这块留待本轮。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-git-scope.ts`（新） | git 方法读写分类：19 个只读方法（status/diff/history/branchCompare/commitDiff/generateCommitMessage…）→ `read`；其余（stage/unstage/commit/checkout/discard/fetch/pull/push/rebase/forkSync…）→ `write`；**未登记方法按 write 处理**，新增的写方法不会因漏登记而落到主仓库 |
| `cloud-platform/cloud-path-guard.ts` | 把 git 接入同一套边界；写操作**同时校验目录本身**——`git.commit` 不带任何路径参数，只看相对路径会漏掉"在共享 checkout 上提交"；git 的 `filePath`/`filePaths`/`paths`/`oldPath`/`submodulePath` 同样逐条查越界 |
| `runtime-rpc-websocket-dispatch.ts` | 路径判定覆盖 git（按票据的 `terminal` 权限放行后才判定，缺权限仍由权限层给出文案） |

**验证（`evidence/m37-git-boundary/`）**：4 条真实端到端（真实平台票据 + 真实 Runtime + 真实 store + 真实 git 仓库与 `git worktree`）：
- M37-1 `git.status` 在本人 worktree 成功、在另一团队仓库被 `forbidden`；
- M37-2 `git.stage`/`git.commit` 指向共享主仓库被拒，且用主机侧 `git rev-parse HEAD` 确认**主仓库 HEAD 未变**；
- M37-3 本人工作区里 `git.stage` + `git.commit` 成功，主机侧 `git log -1` 读到真实提交主题；主仓库仍是 `init`；
- M37-4 `filePath: '../../other-team/README.md'` 被拒，另一团队仓库的 `git status --porcelain` 为空（路径从未到达 git）。

另有 6 条分类单测。**把 git 分类关掉后 M37-1/2/4 变红**（M37-3 仍绿属预期：它只断言"本工作区允许写"，禁用分类后依然允许）。主机侧 20 文件 101 条、模拟器 97 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. `git.remoteCommitUrl`/`git.remoteFileUrl` 归为只读，但它们会拼远端 URL，需 `terminal` 权限——本轮不涉及网络出站管控（设计 §9.4 的出网白名单属部署项）。
2. `worktree.create`/`worktree.createManaged`/`worktree.rm` 仍未纳入路径边界（平台票据的 `workspaceRoot` 应约束 createManaged 的目标）。留着下一轮，因为需要同时确认托管创建所用的路径推导。
3. 终端本身仍是"打开后可 `cat` 任意文件"，设计 §9.4 已把它列为不可阻断、靠出网白名单与命令审计缓解，非本轮范围。

## M38 worktree 操作边界（本轮）

**问题**（设计 §8.3 / T301a，M37 备注里留的下一项）：`worktree.*` 仍未纳入 M36/M37 的边界。其中两处是真实逃逸：
- **`worktree.create` 的目标路径不由调用方给出**，而是主机按自己的 `workspaceDir` 推导——云会话可以指定**任意 repo 选择器**（包括别的团队的仓库）让主机在机器上建出 checkout；
- **`worktree.rm` 可以删除主机上任意 worktree**，包括别人正在用的分支和共享主仓库。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-worktree-scope.ts`（新） | `worktree.create` → **明确拒绝**（设计：托管模式必须用 `worktree.createManaged`，而真实 Runtime 尚未实现，因此宁缺勿滥）；`worktree.rm`/`worktree.forceDeleteBranch` → 写（限本人 `workspaceRoot`）；`worktree.show` → 读（限 `projectRoot`）；**其余一律拒绝**（`list`/`detectedList`/`ps` 会枚举全机工作区，`activate`/`sleep`/`set`/`teardownMissingTerminals` 等属主机 UI 面） |
| `cloud-path-guard.ts` | worktree 分类接入同一路径检查；新增 `isCloudPathGuardedMethod()` 供分发层判断"这个方法是否需要过边界" |
| `cloud-rpc-permission.ts` | `worktree.show`/`worktree.forceDeleteBranch` 登记到 `terminal` 权限（仅表示"可被该方法族触达"，具体放行仍由 worktree 分类决定） |
| `runtime-rpc-websocket-dispatch.ts` | 边界判定改用 `isCloudPathGuardedMethod`，让被拒绝的 worktree 方法也能拿到明确文案，而不是落到 `method_not_found` |

**验证（`evidence/m38-worktree-boundary/`）**：4 条真实端到端（真实平台票据 + 真实 Runtime + 真实 store + 两个真实 git 仓库与 `git worktree`）：
- M38-1 `worktree.create` 被 `forbidden` 且文案指向托管创建；**主机的 `workspaceDir` 下确实为空**（普通创建本会在此落盘）；
- M38-2 `worktree.rm` 目标为另一团队的 worktree 被拒且目录仍在；目标为共享主仓库被拒（`workspace root`）且 `README.md` 仍在；
- M38-3 `worktree.show` 在本人工作区成功、跨项目被拒；
- M38-4 `worktree.list`/`detectedList`/`ps` 全部 `forbidden`。

另有 7 条分类单测。**关掉 worktree 分类后 M38-1/2/3 变红**（M38-4 仍绿属预期：这三个方法根本没登记在云权限映射里，由权限层先拒）。主机侧 22 文件 112 条、模拟器 97 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 本轮是**收紧**而非补齐：真实 Runtime 仍然没有 `worktree.createManaged`，云端用户目前只能打开已存在的工作区。这是设计 §8.3 明确要求的正向路径，**下一轮实现**（需把显式 `workspaceRoot` + `nestWorkspaces=false` 贯穿 `createManagedWorktree` 的路径推导，非托管构建不注册）。
2. `worktree.prefetchCreateBase` 一并被拒：它服务于创建流程，托管创建落地后应随 `createManaged` 一起开放。
3. 终端仍可 `cat` 任意文件（设计 §9.4 已列为不可阻断）。

## M39 托管工作区创建（本轮）

**问题**（设计 §8.3 / T301a）：M38 把 `worktree.create` 对云端关掉了（它按主机自身的 `workspaceDir` 推导路径，无法约束），但设计要求的正向路径 `worktree.createManaged` **在真实 Runtime 里根本不存在**——于是云端用户能连上项目，却无法创建自己的工作区，只能打开已存在的。

| 改动 | 内容 |
|---|---|
| `shared/rpc-contract/worktree-managed-create-params.ts`（新） | `{ repo, workspaceRoot, name, baseBranch, compareBaseRef, branchNameOverride, displayName, idempotencyKey }`；`workspaceRoot` 必须在协议层就是绝对路径 |
| `runtime/rpc/methods/worktree-create-managed.ts`（新） | 新方法 `worktree.createManaged`（`workspace` 权限）：以 `idempotencyKey` 复用既有 `dedupeWorktreeCreate`；**拒绝远程仓库**（票据的工作区根是本地路径，在 SSH checkout 上照做会静默落在别处） |
| `startup/cloud-managed-worktree-methods.ts`（新） | 仅当 `ORCA_CLOUD_API_URL` 存在时把该方法并入方法表——落实设计"非托管构建不注册该方法" |
| `runtime/runtime-managed-worktree-create-types.ts` + `runtime-local-worktree-create.ts` | `workspaceRoot` 显式根：覆盖路径设置的 `workspaceDir` 并强制 `nestWorkspaces=false`，因此 `computeWorktreePath` 与 `ensurePathWithinWorkspace` 都按 `<root>/<name>` 计算 |
| `cloud-worktree-scope.ts` / `cloud-path-guard.ts` | 云端作用域把 `createManaged` 归为写；新增 `checkManagedCreate()`：**仓库必须在本项目内**（否则可把别的团队仓库 checkout 进自己工作区再读），**目标根必须在本人工作区根内**。为此给运行时加了公开的 `resolveRepoRootPath()`（复用既有 `showRepo`，不另起解析） |

**验证（`evidence/m39-managed-worktree/`）**：4 条真实端到端（真实平台票据 + 真实 Runtime + 真实 store + 真实 git 仓库，主机 `nestWorkspaces` 故意设为 `true`）：
- M39-1 在票据工作区根下创建成功：路径恰为 `<workspaceRoot>/cloud-feature`，**没有多出一层 `<repoName>`**，`git rev-parse --show-toplevel` 指向该路径（是真 worktree 而非拷贝），主机自己的 `workspaceDir` 仍为空；
- M39-2 同一 `idempotencyKey` 重试返回同一 worktree；
- M39-3 目标根写在工作区之外被 `forbidden`，磁盘上没有建出目录；
- M39-4 用另一团队的仓库创建被 `forbidden`（`outside the project`），本人工作区内没有出现该目录。

另有 8 条单测（分类、库/根双重校验、缺字段）。**把显式根覆盖去掉后 M39-1 变红；把 `checkManagedCreate` 关掉后 4 条全部变红**。主机侧 23 文件 117 条、模拟器 97 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 本轮只开放了"创建"；`worktree.prefetchCreateBase`（服务于创建预取）仍对云端拒绝，`worktree.create` 也仍拒绝——托管模式只走 `createManaged` 一条路，避免出现两条语义不同的创建通道。
2. 客户端侧尚未调用它：`cloud-runtime-environment` 打开项目时仍是"打开已有工作区"，把 `createManaged` 接到 `openProject`（按需创建 + 失败码映射）留给面板接入那一轮。
3. 远程（SSH）仓库的托管创建返回 `managed_workspace_remote_unsupported`，未做跨主机路径翻译——一期云主机都是本地/容器路径。

## M40 打开项目时按需创建工作区（本轮）

**问题**（设计 §8.3 第 3 步）：M39 让主机能够创建托管工作区，但**没有任何一端去调用它**——`cloud:openWorkspace` 仍然是"拿到票据就注册环境"，首次打开项目时用户的工作区目录里空无一物，面板拿到的是一个没有 checkout 的路径。设计写的是"连接后先查现有 worktree，存在则直接打开，否则创建"。

| 改动 | 内容 |
|---|---|
| `cloud-platform/cloud-workspace-ensure.ts`（新） | `ensureCloudWorkspace()`：`openProject` 建链 → `worktree.list`（repo 限定）→ **只挑落在票据 workspaceRoot 下的那条**（同仓库还有队友的 checkout）→ 没有才 `worktree.createManaged`；创建失败时再列一次（并发打开同一项目的竞态） |
| `cloud-worktree-scope.ts` / `cloud-rpc-permission.ts` | 对云端开放 `worktree.list`/`worktree.detectedList`，但**必须带 repo**；`cloud-path-guard` 新增 `checkRepoScopedRead()`——仓库须在本项目内，否则拒绝（这是 M38"一律拒绝"的精确化，不是放开） |
| `cloud-session-service.ts` | 新增 `ensureWorkspace(projectId)`；成功后设置当前项目 |
| `ipc/cloud-platform.ts` | `cloud:openWorkspace` 改走 ensure；结果返回 `workspacePath` 与真实能力集 |
| `shared/cloud-platform-ipc.ts` / `use-cloud-session.ts` / `cloud-project-workspace.tsx` | `CloudOpenResult.workspacePath` 透传到视图，工作区页新增"我的工作区"一行（首次打开显示"首次打开时创建"） |

**验证（`evidence/m40-ensure-workspace/`）**：3 条真实端到端，且**用的是桌面端真实客户端类 `CloudConnectClient`**——主机以注册模式运行（心跳上报真实端口与 E2EE 公钥），Runtime 用真实自签 TLS 提供 `wss://`，客户端按票据里的地址连接：
- M40-1 首次打开 → 创建工作区，路径恰为 `<workspaceRoot>/main`，`README.md` 存在，`git rev-parse --show-toplevel` 指向该目录；
- M40-2 再次打开 → `created: false`，路径相同，`git worktree list` 仍只有 2 条（主仓库 + 本人），没有就地再造一份；
- M40-3 `worktree.list` 指向他人仓库被 `forbidden`（`outside the project`），不带 repo 的调用也被拒。

另有 9 条单测（含目录读取的 repo 要求与越界）。**把"复用已有工作区"关掉后 M40-2 变红。** 主机侧与渲染侧 25 文件 131 条、模拟器 97 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. `files.open`/`files.openDiff` 仍**未登记**（M34 的 deny-by-default），文件面板打开文件前必须先登记它们——这是下一轮面板接入的前置项。
2. 首次打开的创建发生在 `cloud:openWorkspace` 内，**耗时已计入打开时延**（同步等待 worktree 创建）；设计允许后台创建 + 先显示进度，本轮选择了简单实现，压测（T507）时再评估。
3. 客户端拿到的 `workspacePath` 目前只用于展示与后续面板寻址；`cloud-runtime-environment` 注册的侧车仍只带 projectId，尚未把 worktree 路径写进环境元数据。

## M41 文件面板接入：方法登记与路径参数收口（本轮）

**问题**：M36 的路径守卫用 `key.endsWith('relativePath')` 猜哪些参数是路径。这个猜测有真实缺口，而 M40 记录的前置项（`files.open`/`files.openDiff` 未登记）正好会让面板打不开文件。排查后发现两类问题：

1. **漏检**：`files.pathsExist` 的 `relativePaths`（复数批量）、`files.readDocPreview` 的 `entryRelativePath`/`implicitRootRelativePath`/`authorizedRootRelativePaths` 都不是 `…relativePath` 后缀，**整类调用完全没做路径检查**；一个 `file:read` 会话可以借批量存在性检查探测项目外文件是否存在。
2. **无界**：`files.browseServerDir`、`files.readTerminalArtifact`、`files.readTerminalArtifactPreview`、`files.writeTerminalArtifact`、`files.resolveTerminalPath` 只认绝对路径，项目根无法约束它们，却因为"没找到 relativePath"被当作无路径放行。

| 改动 | 内容 |
|---|---|
| `cloud-file-path-params.ts`（新） | 显式方法→参数表 `CLOUD_FILE_PATH_PARAMS`（singular/plural 分开）；`CLOUD_FILE_UNBOUNDED_METHODS`（绝对路径方法，整体拒绝）；`CLOUD_FILE_WORKTREE_ONLY_METHODS`（只寻址 worktree，无文件路径） |
| `cloud-path-guard.ts` | 以 `collectPaths()` 取代后缀猜测；无界方法返回 `path_unbounded`；**任何未在表中声明的 `files.*` 方法返回 `path_unverifiable`**——判断只看方法名，不看它是否已登记权限，所以将来新增的文件 RPC 在登记前也拿不到放行 |
| `cloud-rpc-permission.ts` | `files.open`/`files.openDiff` 登记为 `file:read`（它们只把调用方本来就能读的文件展示出来）；补注释说明终端产物/目录浏览为何仍列出但由路径守卫拒绝 |
| `cloud-rpc-permission.test.ts` | 断言这两个面板动作归 `file:read`；deny-by-default 的示例改用真实未登记的 `agentSessionAttachment.read` |

**验证（`evidence/m41-file-panel/`）**：3 条真实端到端，复用 M36 的真实平台票据 + 真实 Runtime + 真实 git 仓库（含另一个团队的仓库与指向它的符号链接），另给主机装了记录型 `RuntimeNotifier`：
- M41-1 `files.open`/`files.openDiff` 返回 `opened: true`，且主机的窗口确实收到解析后的绝对路径 `<projectRoot>/README.md`——证明守卫放行后真实 `stat` 与开标签动作都执行了；
- M41-2 `files.pathsExist(['README.md','../../other-team/secret.txt'])` 整批被 `forbidden`（`outside the project`），全在项目内的批次正常返回；
- M41-3 `files.browseServerDir` / `files.readTerminalArtifact` 被 `forbidden`，消息指明绝对路径方法不开放。

另有 7 条单测（表的三类互斥、复数批量、doc preview 入口路径、改名目标落点、无界方法、未声明方法、面板动作放行）。**三组负向对照**：删掉 `relativePaths` 字段 → 单测与 M41-2 变红；取消 `files.open` 登记 → M41-1 变红且报 `not available to cloud sessions`；把 `browseServerDir` 移出无界集合 → M41-3 变红。主机侧 25 文件 131 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. `files.open` 在主机的**无渲染窗口**模式下返回 `runtime_error: renderer_unavailable`——它要求宿主窗口开标签。云主机（无桌面的容器/服务器）上因此不可用，这是宿主能力限制而非边界漏洞；远端面板应走 `files.read`/`files.readPreview` 由客户端自己渲染，`files.open` 只对 CLI/agent 与带窗口的宿主有意义。
2. 表是人工维护的：新增文件 RPC 时必须同步登记，否则会被 `path_unverifiable` 拒绝。这是有意的 fail-closed，但需要加一条"新增 `files.*` 方法必须进表"的评审清单项。
3. `files.searchPaths` 的 `excludePaths` 已纳入检查，但 `query`/`followSymlinks` 等语义未变——搜索仍可能沿工作区内的符号链接读到项目外内容（取决于 `files.search` 实现是否跟随），列为后续核查项。

## M42 云端文件面板（本轮，T206 第一片）

**问题**：M25/M40 之后云端项目有了 `environmentId` 与真实 checkout，但工作区页只显示连接信息，用户看不到自己工作区里的任何文件。T206「项目视图接入」要挂终端与文件面板；终端需要云端链路上的流式通道（当前 `CloudConnectClient` 只有请求/响应，见剩余项），文件面板则只依赖已就绪的 `files.readDir`/`files.readPreview`（M41 已登记并收口路径），因此本轮先交付文件面板。

| 改动 | 内容 |
|---|---|
| `shared/cloud-file-browser.ts`（新） | 面板的数据层：`browseCloudDirectory` / `previewCloudFile` 走 `files.readDir`/`files.readPreview`，worker 选择器固定为 `path:<workspacePath>`；路径拼接拒绝 `..`、分隔符与空名；目录在前、名称不区分大小写排序；未知/残缺回复报 `malformed_reply`，**不当作空目录**；隐藏 `.git`（worktree 里它是 gitfile 指针） |
| `renderer/cloud/cloud-file-panel.tsx`（新） | 面包屑 + 目录列表 + 文本预览；失败显示主机原因（`forbidden` → 越界/无权限），二进制/图片不按文本渲染；用请求序号丢弃过期目录回复 |
| `shared/cloud-platform-ipc.ts` / `cloud-connect-response.ts` | 票据 `perms` 解析为 `CloudProjectPermission[]`（未知值丢弃）；`CloudOpenResult.permissions` 由**将要被主机校验的那张票据**读出，供 UI 判断能否显示面板 |
| `ipc/cloud-platform.ts` / `use-cloud-session.ts` / `cloud-project-workspace.tsx` / `cloud-app.tsx` | 透传权限；工作区页在 `workspacePath` 存在且票据含 `file:read` 时挂载面板，否则说明原因；`CloudApp` 改为把完整 `rpc(method, params)` 传下去（此前固定只调 `status.get`） |

**验证（`evidence/m42-file-panel/`）**：3 条真实端到端——真实平台进程签票、真实 TLS Runtime、真实 git 仓库与托管 worktree、真实 `CloudConnectClient`，且**直接调用面板自己的数据层函数**：
- M42-1 根目录列出 `src/`（目录在前）与 `logo.bin`、`README.md`；进入 `src/` 列出 `app.ts`；预览内容为主机真实读到的 `# payment service`；
- M42-2 `../../../../other-team` 被拒 `forbidden`（`outside the project`），预览他人仓库文件同样被拒；
- M42-3 管理员收回 `file:read` 后，平台新签票据的 `perms` 不再含它，同一工作区读取被 `forbidden` 且提示缺少 `'file:read'`；结束后恢复授权。

另有 9 条数据层单测（路径拼接/排序/过滤/残缺回复/错误透传）与 3 条面板组件测试（导航、越界提示、二进制不按文本显示）。**负向对照**：把 `files.readDir` 临时放进 `SESSION_METHODS`（绕过 `file:read`）后 M42-2、M42-3 变红——同时暴露了权限表与路径守卫的耦合：`cloudPathAccessOf` 依据 `cloudMethodAccess` 判断读/写，归为 `session` 的方法会连路径检查一起跳过，因此文件方法**不能**登记为 `session`。主机侧 + 渲染侧 + 共享 29 文件 156 条、模拟器 97 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 面板是只读的（列表 + 预览）。写/新建/删除虽已登记为 `file:write`，但 UI 未接；等 M41 的写路径在面板上做完整错误呈现后再开放。
2. 图片预览只显示 MIME，不解码 base64；`files.readPreview` 返回 base64 内容，渲染成 `<img>` 需要内容类型协商（设计 §9 的下载管控也应在此处生效），列入下载策略接入轮次。
3. 终端面板需要云端链路的流式 RPC（PTY 输出推送），`CloudConnectClient` 目前只做请求/响应；这是 T206 剩余的最大一块，也是下一轮候选。

## M43 云端终端：流式订阅传输 + 终端工作区边界（本轮）

**问题**：两件事，缺一不可。

1. **传输**：`CloudConnectClient` 只有请求/响应——每个调用各自 `on('message')` 过滤自己的 id，超时后监听器不摘除（泄漏），且无法接收流式方法的多帧回复。没有它，`terminal.subscribe` 一个事件也到不了客户端。
2. **边界（真实漏洞）**：M34 只按 `terminal` 前缀授权，主机对终端方法**不做任何地址检查**。`terminal.create` 的 `worktree` 由客户端指定，`terminal.send`/`subscribe` 的句柄也是——一个有 terminal 权限的云端用户可以在**共享检出区**或**其他团队仓库**里开 shell 并任意执行命令、读标题/cwd、驱动他人终端。

| 改动 | 内容 |
|---|---|
| `cloud-rpc-multiplexer.ts`（新） | 一个路由器拥有整条已准入 socket：`id → 调用` 的 pending 表、`call()` 一次性回复、`subscribe()` 多帧事件 + `{type:'end'}` 收尾、超时即摘除、socket 关闭时统一以 `CONNECTION_CLOSED` 结束所有在途调用 |
| `cloud-connect-client.ts` | `rpc()` 改走多路复用器（修复超时监听器泄漏）；新增 `subscribe()` / `forgetSubscription()`；`close()` 先结束在途调用再关 socket |
| `cloud-terminal-scope.ts`（新） | 终端方法三类：**create**（worktree 必须落在本人 `workspaceRoot`）、**handle**（按句柄所属 worktree 判定，含 `terminal.unsubscribe` 的 `subscriptionId` 及 `${terminal}:${clientId}` 复合 id）、**deny**（主机窗口/全局方法：`terminal.list`/`closeAll`/`split`/`focus`/`show`/`closeTab`/`sleep`/`resolve*`/`multiplex`/fit 偏好）。未分类的 `terminal.*` 一律拒绝 |
| `cloud-path-guard.ts` | 接入终端三类；主机无法回答句柄归属（无 `resolveTerminalContext`）→ 拒绝；句柄已退出 → 拒绝 |

**验证（`evidence/m43-cloud-terminal/`）**：3 条真实端到端——真实平台票据、真实 TLS Runtime、真实 git 仓库与托管 worktree，主机 PTY **由 node-pty 起真实 shell 进程**（`/bin/sh`，真实 pid），输出经 `onPtyData` 进入 Runtime 自己的数据通道：
- M43-1 在本人工作区 `terminal.create` → 订阅收到 `scrollback` → `terminal.send("echo ORCA_CLOUD_TERMINAL_OK")` → 收到含该标记的 `data` 帧 → `terminal.unsubscribe{requestId}` 后流正常结束；
- M43-2 在共享检出区、其他团队仓库、以及不带 worktree 的创建全部 `forbidden`；`terminal.list`/`closeAll`/`focus` 被拒；
- M43-3 不存在的句柄 `forbidden`，不会落到 handler。

另有 12 条单测（三类互斥、未分类默认拒绝、create/handle 的越界、复合 subscriptionId、句柄未知、主机无法回答）。**两组负向对照**：把 create/handle 交给"不检查"分支 → 10 条用例变红（含 M43-2/M43-3）；把流事件改成投递 `undefined` → M43-1 在 15 秒后超时变红（`saw [null,null]`），证明用例真的在看主机输出。主机侧 28 文件 147 条全过；模拟器 97 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 终端面板 UI 尚未挂载：本轮交付的是**可用的传输 + 边界**（客户端已能创建、订阅、写入、退订）。渲染层还需要 xterm 组件与工作区布局接线。
2. `terminal.multiplex`（手机用的二进制流通道）与 `agentSession`/`session.tabs.*` 仍对云端关闭——它们有各自的帧协议与窗口语义，需要单独一轮做帧级边界，不能靠本表覆盖。
3. 云端客户端以"桌面客户端"身份订阅（不带 `client.type=mobile`），走 JSON 订阅；手机端若直连云主机需要二进制流能力协商，属后续项。
4. `terminal.create` 在无桌面窗口的云主机上返回 `warning`（"could not make it discoverable"），PTY 本身可用——与 M41 的 `files.open` 同类：无窗口宿主只能后台运行。

## M44 agent 家族工作区边界（本轮，由开发子代理执行）

**问题**：`agent` 权限通过前缀一次性放行了 `agent.` / `agentSession.` / `agentProvider.`，而路径守卫对这些方法**没有任何规则**（与 M36 之前的 files、M43 之前的 terminal 相同）。agent CLI 会执行命令，结构化会话会驱动一个正在运行的 agent；两者的目标工作区与会话 id 都由客户端指定。因此一个有 `agent` 权限的云端用户可以在**共享检出区或队友仓库**里启动 agent、读取他人的会话历史、并向他人的会话发送消息。

| 改动 | 内容 |
|---|---|
| `cloud-agent-scope.ts`（新，328 物理行/211 有效行） | 三类：**create**（`agent.launch`/`launchReplay`/`agentSession.create`/`createSupport`/`ensure`）——目标 worktree 必须解析进本人 `workspaceRoot`；`agent.launch` 还检查 `cwd` 与 `reuseTerminal.handle`，且 `target.kind` 必须是 `existing`（新建工作区由主机自己推导路径，与 `worktree.create` 同样拒绝）；**session**（26 个方法）——从 `sessionId` 或 `envelope.sessionId` 解析会话所属 worktree；**deny**——附件（主机文件存储、`read` 传绝对路径、上传流无法定界）、`agentTeams`/`agentHooks`（主机窗口/全局状态）、provider 目录、跨会话流与 restart 列表。未分类的 `agent*` 一律拒绝 |
| `cloud-path-guard.ts` | 接入 agent 三类；`isCloudPathGuardedMethod` 覆盖 |
| `orca-runtime.ts` | 新增 `resolveAgentSessionContext`：先查会话持久记录（`location.workspaceId`），再回退到终端上下文（终端承载的会话仍在 PTY 上）。两者都答不出 → 拒绝 |

**验证（`evidence/m44-agent-boundary/`）**：4 条真实端到端——真实平台票据、真实 TLS Runtime、真实 git 仓库与托管 worktree、真实 `CloudConnectClient`：
- M44-1 本人工作区的会话调用**到达 handler**（返回 `structured_agent_session_unsupported`，不是 `forbidden`）——证明边界放行后真的执行；
- M44-2 共享检出区与队友仓库的 `history`/`send` 被 `forbidden`；
- M44-3 向共享检出区、队友仓库、以及不指定工作区的 `agent.launch` 全部 `forbidden`；
- M44-4 全车级与主机侧方法（`subscribeStatus`、附件、`agentTeams`）被拒。

另有 13 条单测。**主会话独立负向对照**（不只看子代理报告）：把 `cloudAgentScopeOf` 改为恒返回 `null` → 3 条 e2e 变红（`expected 'runtime_error' to be 'forbidden'`），恢复后 4/4 绿。主机侧 + 渲染侧 + 共享 33 文件 186 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 会话归属的**记录存储路径未端到端验证**：真实结构化会话需要启动真实 provider CLI。e2e 走的是终端回退路径，记录查询只有单测覆盖。
2. `agentProvider.list` 现在被守卫拒绝（provider 目录是主机全局的）。若后续让云端复用 Orca 原有 agent 面板，需要重新评估：面板启动前要读 provider 目录，届时应改为"只按本人工作区过滤"而不是整体拒绝，并给出目录内容不跨租户的依据。
3. `agentSessionAttachment.*`、`agentTeams.*`、`agentHooks.*` 在当前分支本就未登记权限（`cloudMethodAccess` 返回 null，权限层已拒）；本表仍显式分类，是为将来放宽前缀时守卫依然正确。

## M45 云端运行时环境携带工作区路径（本轮，由开发子代理执行）

**问题**：M40 在打开项目时创建了用户的 checkout 并把 `workspacePath` 返回给渲染层，但**运行时环境本身不携带它**。任何按 `environmentId` 寻址的面板（包括我们准备复用的 Orca 原有界面）只能看到主机的整个 worktree 目录——包含队友的检出区——无法知道哪一份是当前用户的。这正是「复用 Orca 原有界面」的前置条件。

| 改动 | 内容 |
|---|---|
| `shared/runtime-environments.ts` | `CloudProjectLinkSchema` 新增**可选** `workspacePath`；新增 `cloudWorkspacePathOf(environment)`，旧侧车返回 `null` |
| `cloud-runtime-environment.ts` | `RegistrationInput.workspacePath?`，写入时条件展开（未知则不写键，旧侧车形状保持逐字节一致）；同一项目重开时**刷新路径并保持环境 id** |
| `ipc/cloud-platform.ts` | 把 `ensured.workspacePath` 传给注册 |
| `shared/runtime-environment-sidecar.test.ts` / `cloud-runtime-environment-registration.test.ts` | 旧条目读作 `null`、写读往返、写入时省略、重开保持 id |

**验证（`evidence/m45-workspace-path-sidecar/`）**：3 条真实端到端（真实平台票据 + 真实 TLS Runtime + 真实 git 仓库与托管 worktree + 真实客户端）：
- M45-1 侧车落盘的 `workspacePath` 等于主机创建的 `.orca-worktrees/zhangsan/main`，且 `realpath` 与 `git rev-parse --show-toplevel` 一致——证明写进去的是真实 worktree 而不是回显；
- M45-2 重开保持环境 id 不变、路径被新检出的真实 worktree 刷新；
- M45-3 去掉该字段的旧条目读作 `null`，不抛错。

**主会话独立负向对照**：把 `cloudWorkspacePathOf` 改为恒返回 `null` → M45-1/M45-2 变红（`expected null to be '/private/var/…'`），恢复后 3/3 绿。主机侧 + 共享 + 渲染侧 35 文件 190 条全过；`tsc` node/web 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. 字段只是数据管道：还没有任何面板**读取**它来决定打开哪个工作区（那属于界面改造那一轮）。
2. 向后兼容是双向的：旧构建忽略未知键（zod strip）；但旧构建若重写侧车，新字段会丢失，新构建退化为 `null`——不会抛错，也不会误判。
3. 本模块不涉及传输路由、路径守卫与面板 UI，均未改动。

## M46 无自定义头客户端的设备绑定（本轮，开发子代理 + 主会话补模拟器对齐）

**问题**（浏览器接入的硬阻塞）：云端准入在**升级期**要求设备公钥走 HTTP 头 `x-orca-device-pubkey`，并与票据里的 `devicePubKey` 精确比对。**浏览器无法为 `new WebSocket()` 设置自定义头**，因此任何浏览器都永远连不上云主机——`src/renderer/src/web/web-runtime-connection-transport.ts` 连子协议都不传。而「复用 Orca 原有浏览器界面」正是产品方向，所以这是必须先拆掉的阻塞。

**做法（不放宽安全性）**：浏览器可以控制子协议列表，因此设备公钥也可作为 `orca-device.<base64url>` 与凭证 `orca-cred.<ticket>` 并列传递；主机**对存在的每一种声明都比对**，任一与票据不符即 `device_mismatch`（头与子协议冲突时不会"择优放行"），两者都缺席仍是 `device_pubkey_missing`。E2EE 握手依旧用票据绑定的密钥完成，持有证明不变。

| 改动 | 内容 |
|---|---|
| `cloud-upgrade-admission.ts` | 新增 `readDevicePubKeyFromProtocols()`：仅接受无填充 base64url、32 字节、可规范化重编码的 key（拒绝短 key 与非规范尾比特）；格式无效或出现两个互相冲突的 token → `device_mismatch`；头与 token 并存时逐一比对 |
| `cloud-session-e2e-harness.ts` | `connectCloudSession` 支持 `deviceKeyIn: 'subprotocol'`（模拟浏览器：不带设备头） |
| `cloud-platform/apps/runtime/src/runtime-sim.ts`（主会话补） | 模拟器网关同步接受子协议形态，冲突时同样拒绝；键长不设 32 字节限制（模拟器设备键是 SPKI DER，真实主机才是 NaCl 32 字节）——**否则整机与替身的行为会分叉** |
| `cloud-platform/test/e2e/platform.e2e.test.ts`（主会话补） | 新增 E7b3：无头浏览器形态被接受；头与子协议冲突被拒 |

**验证（`evidence/m46-browser-upgrade/`）**：3 条真实端到端——真实平台进程签票、真实 TLS Runtime、**手工构造与浏览器能力一致的手连接**（只有子协议、无设备头），完成真实 E2EE 握手后 `status.get` 有真实响应；错误设备键 401 `device_mismatch`；两者都不带 401 `device_pubkey_missing`。另有 6 条准入单测（头/子协议/两者相等/冲突/缺失/格式错误）。模拟器 E7b3 通过（17/17）。

**主会话独立负向对照**：让准入忽略子协议形态 → M46-1/M46-2 变红（`Unexpected server response: 401` 与 `expected 'device_pubkey_missing' to be 'device_mismatch'`），恢复后 3/3 绿。主机侧 34 文件 186 条、模拟器 e2e 17 条全过；`tsc` node 0 错；门禁 7 项 0 新发现。

**如实记录 / 剩余**：
1. **线兼容**：使用子协议形态的客户端需要理解该 token 的主机；旧主机会返回 `device_pubkey_missing`（可映射的明确错误，不是静默关闭）。本模块不做能力协商。
2. 浏览器渲染层**还没有**真的使用它：`web-runtime-connection-transport.ts` 仍未传子协议、未接入云票据，这是下一模块（M47）的内容。
3. 平台与票据格式未改；E2EE 握手未改。

## 下一步

**M47 浏览器客户端接入云票据**：`web-runtime-connection-transport` 传入 `['orca-runtime','orca-cred.<ticket>','orca-device.<pubkey>']`、浏览器内生成并持久化设备密钥（IndexedDB）、登录平台取票后渲染同一个 `App`；随后删除自造的 `cloud-file-panel.tsx` 与云端壳子工作区页。

**界面方向修正（用户决定）**：不再自造云端面板。Orca 自带浏览器客户端（`src/renderer/src/web/`，约 1.1 万行，入口 `web-index.html`，在浏览器内重建 `window.api` 并挂载同一个 `App`）才是"统一工作界面"；它目前只接受**配对码**，没有云票据支持。改造顺序：

1. 给 `web-runtime-connection-transport` 接入 cloud ticket（`shared/remote-runtime-request-socket.ts` 的 `cloudUpgrade` 已铺好一半）；浏览器内生成设备密钥并完成设备绑定证明。
2. 浏览器 → 平台登录 → 票据选路（直连/中继）→ 连上远端 Runtime → 渲染同一个 `App`。
3. 删除 `renderer/cloud/cloud-file-panel.tsx` 与云端壳子的工作区页；`shared/cloud-file-browser.ts` 仅保留给既有 e2e，或随面板一并移除。
4. `cloud-runtime-environment` 侧车补 `workspacePath`，让复用后的面板直接寻址用户 checkout。
5. 管理台（`cloud-platform/apps/web/`）保持独立，仅管理员可见主机/成员/审计/设置。

遗留风险：`agent.launch` 在本人工作区**未被实际执行**（会真的拉起 agent 进程），目前只断言了拒绝路径。
2. 遗留：M4 `isInsideRoot` 对 Windows 段大小写敏感（fail-closed，误拒而非误放；按需放宽）。
3. 并发上限目前只统计云会话；本地配对连接不占这 32 个名额（设计表只约束云端会话），如运营需要主机总量配额再扩展。
